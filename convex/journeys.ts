import { action, mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { api } from "./_generated/api";
import type { ActionCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";

// Fixes more than this far apart in time are treated as separate trips
// (car parked/off in between) rather than one continuous journey. Keep in
// sync with SEGMENT_GAP_MS in apps/web/src/pages/Journeys.tsx.
const SEGMENT_GAP_MS = 5 * 60 * 1000;

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export interface Trip {
  cameraId?: Id<"cameras">;
  startTime: number;
  endTime: number;
  durationSeconds: number;
  distanceKm: number;
  maxSpeedKmh: number;
  avgSpeedKmh: number;
  fixCount: number;
  startLocation?: string;
  endLocation?: string;
}

// List persisted journeys for the Journeys screen. The table is rebuilt from
// gpsFixes by a cron job, so this is a fast index lookup instead of grouping
// raw fixes on every page load.
export const list = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }): Promise<Trip[]> => {
    const journeys = await ctx.db
      .query("journeys")
      .withIndex("by_startTime")
      .order("desc")
      .take(limit ?? 5000);
    return journeys.map((j) => ({
      cameraId: j.cameraId,
      startTime: j.startTime,
      endTime: j.endTime,
      durationSeconds: j.durationSeconds,
      distanceKm: j.distanceKm,
      maxSpeedKmh: j.maxSpeedKmh,
      avgSpeedKmh: j.avgSpeedKmh,
      fixCount: j.fixCount,
      startLocation: j.startLocation,
      endLocation: j.endLocation,
    }));
  },
});

interface TripEndpoints {
  startLat: number;
  startLng: number;
  endLat: number;
  endLng: number;
}

// Rounds a coordinate to ~11m precision so nearby start/end points (e.g. the
// same driveway across multiple trips) share one Overpass lookup instead of
// each triggering a fresh network call.
function coordKey(lat: number, lng: number): string {
  return `${lat.toFixed(4)},${lng.toFixed(4)}`;
}

interface FixLike {
  timestamp: number;
  lat: number;
  lng: number;
  speedKmh?: number;
}

// Splits one camera's chronologically-sorted fixes at every gap over
// SEGMENT_GAP_MS, returning each trip's raw fixes rather than a summary.
// backfill needs the raw fixes back: it scans forward a page at a time and
// the last segment of a page is usually mid-trip, so those fixes have to be
// carried into the next page instead of summarised early. Short segments
// are kept here and dropped by summarizeSegment, so a trailing one-fix
// segment still has a chance to grow on the next page.
function splitIntoSegments(sorted: FixLike[]): FixLike[][] {
  const segments: FixLike[][] = [];
  let current: FixLike[] = [];
  for (const fix of sorted) {
    const last = current[current.length - 1];
    if (last && fix.timestamp - last.timestamp > SEGMENT_GAP_MS) {
      segments.push(current);
      current = [];
    }
    current.push(fix);
  }
  if (current.length > 0) segments.push(current);
  return segments;
}

// Rolls one segment's fixes up into the stored trip shape. Returns null for
// a segment of fewer than two fixes — a single point has no distance and no
// duration, so there is no trip to record.
function summarizeSegment(
  segment: FixLike[],
  cameraId: Id<"cameras"> | undefined,
): (Trip & TripEndpoints) | null {
  if (segment.length < 2) return null;
  let distanceKm = 0;
  let maxSpeedKmh = 0;
  let speedSum = 0;
  let speedCount = 0;
  for (let i = 0; i < segment.length; i++) {
    const fix = segment[i];
    if (fix.speedKmh !== undefined) {
      maxSpeedKmh = Math.max(maxSpeedKmh, fix.speedKmh);
      speedSum += fix.speedKmh;
      speedCount += 1;
    }
    if (i > 0) {
      const prev = segment[i - 1];
      distanceKm += haversineKm(prev.lat, prev.lng, fix.lat, fix.lng);
    }
  }
  const startTime = segment[0].timestamp;
  const endTime = segment[segment.length - 1].timestamp;
  return {
    cameraId,
    startTime,
    endTime,
    durationSeconds: Math.round((endTime - startTime) / 1000),
    distanceKm,
    maxSpeedKmh,
    avgSpeedKmh: speedCount > 0 ? speedSum / speedCount : 0,
    fixCount: segment.length,
    startLat: segment[0].lat,
    startLng: segment[0].lng,
    endLat: segment[segment.length - 1].lat,
    endLng: segment[segment.length - 1].lng,
  };
}

// Clusters one camera's chronologically-sorted fixes into finished trips.
// Kept per-camera because mixing two cameras' fixes by time alone would
// braid unrelated vehicles' data into the same "trip".
function clusterTrips(
  sorted: FixLike[],
  cameraId: Id<"cameras"> | undefined,
): (Trip & TripEndpoints)[] {
  return splitIntoSegments(sorted)
    .map((segment) => summarizeSegment(segment, cameraId))
    .filter((trip): trip is Trip & TripEndpoints => trip !== null);
}

// How far back rebuild may walk past its fixed-size window looking for a
// real trip boundary. A downsampled trip runs to a few hundred fixes, so
// this is several trips' worth of slack; if no gap turns up inside it we
// fall back to the raw window edge rather than scanning the whole table.
const BOUNDARY_LOOKBACK_LIMIT = 500;
const BOUNDARY_LOOKBACK_BATCHES = 3;

// Reverse-geocodes trip endpoints, memoised per ~11m coordinate bucket so a
// driveway visited on twenty trips costs one Overpass call, not forty.
// Shared by rebuild and backfill — Overpass is the slow, rate-limited part
// of both, and backfill would otherwise hammer it re-resolving the same
// home and work addresses over and over.
function makeLocationLookup(ctx: ActionCtx) {
  const cache = new Map<string, string | undefined>();
  return async (lat: number, lng: number): Promise<string | undefined> => {
    const key = coordKey(lat, lng);
    if (cache.has(key)) return cache.get(key);
    let label: string | undefined;
    try {
      label = (await ctx.runAction(api.overpass.nearestPlaceName, { lat, lng })) ?? undefined;
    } catch {
      label = undefined;
    }
    cache.set(key, label);
    return label;
  };
}

// Walks backwards from the oldest fix rebuild fetched until it reaches a gap
// over SEGMENT_GAP_MS, returning that boundary along with the extra fixes
// picked up on the way.
//
// This is what lets rebuild delete safely. Its window is a fixed count of
// the newest fixes, and that cutoff usually lands in the middle of a drive
// — so the window's oldest "trip" is a fragment, and a fragment starting at
// an arbitrary instant can't be reconciled with the full journey backfill
// derived for the same drive. Extending to a gap gives rebuild a timestamp
// no trip spans: everything at or after it is rebuild's to own, everything
// before it belongs to backfill, and neither can clip the other.
//
// A gap in the all-cameras stream is necessarily a gap for every camera
// individually, so checking globally here is sound even though trips are
// clustered per camera.
async function extendToBoundary(
  ctx: ActionCtx,
  fixes: Doc<"gpsFixes">[],
): Promise<{ windowStart: number; fixes: Doc<"gpsFixes">[] }> {
  if (fixes.length === 0) return { windowStart: 0, fixes };
  let extended = fixes;
  for (let batch = 0; batch < BOUNDARY_LOOKBACK_BATCHES; batch++) {
    const boundary = extended[0].timestamp;
    const older: Doc<"gpsFixes">[] = await ctx.runQuery(api.gpsFixes.before, {
      timestamp: boundary,
      limit: BOUNDARY_LOOKBACK_LIMIT,
    });
    // Nothing older exists, so the window already reaches the start of
    // recorded history — rebuild owns every journey there is.
    if (older.length === 0) return { windowStart: 0, fixes: extended };

    if (boundary - older[older.length - 1].timestamp > SEGMENT_GAP_MS) {
      return { windowStart: boundary, fixes: extended };
    }
    let cut = -1;
    for (let i = older.length - 1; i > 0; i--) {
      if (older[i].timestamp - older[i - 1].timestamp > SEGMENT_GAP_MS) {
        cut = i;
        break;
      }
    }
    if (cut >= 0) {
      return { windowStart: older[cut].timestamp, fixes: [...older.slice(cut), ...extended] };
    }
    extended = [...older, ...extended];
    if (older.length < BOUNDARY_LOOKBACK_LIMIT) return { windowStart: 0, fixes: extended };
  }
  // No boundary within the lookback budget (one improbably long unbroken
  // drive). Take the window edge as-is: the oldest trip may be clipped, but
  // that is the pre-existing behaviour rather than a new failure.
  return { windowStart: extended[0].timestamp, fixes: extended };
}

// Rebuild the persisted journeys table from the most recent gpsFixes.
// Schedulable from a cron job so new GPS files automatically update the list.
//
// Only journeys at or after the window boundary are touched. This used to
// clear the whole table before re-inserting, which silently capped journey
// history at whatever the newest 5000 fixes covered: as new drives arrived
// the window slid forward and every journey that fell off the back was
// deleted on the next tick, even though its gpsFixes were still there and
// nowhere near the 90-day retention cutoff. Older journeys now persist, and
// journeys.backfill fills in the range that predates the window.
export const rebuild = action({
  args: {},
  handler: async (ctx): Promise<{ count: number; windowStart: number }> => {
    const existingJourneys = await ctx.runQuery(api.journeys._listAll, {});
    // Reused so trips that haven't changed since the last rebuild don't
    // re-hit the Overpass API — reverse geocoding is the slow, rate-limited
    // part of this job. Keyed by camera + startTime since two cameras could
    // otherwise coincidentally share a startTime.
    const existingByKey = new Map(
      existingJourneys.map((j) => [`${j.cameraId ?? "none"}|${j.startTime}`, j]),
    );

    const recentFixes = await ctx.runQuery(api.gpsFixes.recent, { limit: 5000 });
    const { windowStart, fixes } = await extendToBoundary(ctx, recentFixes);

    const byCamera = new Map<string, typeof fixes>();
    for (const fix of fixes) {
      const key = fix.cameraId ?? "none";
      const group = byCamera.get(key);
      if (group) group.push(fix);
      else byCamera.set(key, [fix]);
    }

    const trips: (Trip & TripEndpoints)[] = [];
    for (const [key, group] of byCamera) {
      const sorted = group.slice().sort((a, b) => a.timestamp - b.timestamp);
      const cameraId = key === "none" ? undefined : (key as Id<"cameras">);
      trips.push(...clusterTrips(sorted, cameraId));
    }

    const lookupLocation = makeLocationLookup(ctx);

    for (const trip of trips) {
      const existing = existingByKey.get(`${trip.cameraId ?? "none"}|${trip.startTime}`);
      if (
        existing &&
        existing.endTime === trip.endTime &&
        (existing.startLocation !== undefined || existing.endLocation !== undefined)
      ) {
        trip.startLocation = existing.startLocation;
        trip.endLocation = existing.endLocation;
      } else {
        trip.startLocation = await lookupLocation(trip.startLat, trip.startLng);
        trip.endLocation = await lookupLocation(trip.endLat, trip.endLng);
      }
    }

    for (const journey of existingJourneys) {
      if (journey.startTime < windowStart) continue; // backfill's, not ours
      await ctx.runMutation(api.journeys._delete, { id: journey._id });
    }
    for (const { startLat, startLng, endLat, endLng, ...trip } of trips) {
      await ctx.runMutation(api.journeys._insert, trip);
    }

    return { count: trips.length, windowStart };
  },
});

// Bounds how much one backfill invocation scans, so a large history is
// worked down across repeated calls instead of hitting Convex's per-call
// limits — same shape as the retention jobs (see gpsRetention.ts).
const BACKFILL_PAGE_SIZE = 500;
const BACKFILL_MAX_PAGES = 20;

interface FixPage {
  page: Doc<"gpsFixes">[];
  isDone: boolean;
  continueCursor: string;
}

// Derives journeys for gpsFixes that predate rebuild's window — the history
// stranded by the old wipe-and-replace rebuild, which deleted journeys it
// could no longer see while leaving their fixes untouched.
//
// Scans forward from `fromTime` in pages, clustering per camera and carrying
// each camera's trailing (still open) segment into the next page so a trip
// straddling a page boundary isn't split in two. `untilTime` defaults to the
// oldest journey rebuild currently owns, so the two meet exactly at the
// boundary rebuild aligned itself to and neither derives the other's trips.
//
// Trips are inserted as they are geocoded rather than in one batch at the
// end: Overpass is slow enough that a long run can be cut short, and
// incremental inserts mean a cut-short run still made progress. Re-running
// is safe — an existing (camera, startTime) is skipped, not duplicated.
export const backfill = action({
  args: { fromTime: v.optional(v.number()), untilTime: v.optional(v.number()) },
  handler: async (
    ctx,
    { fromTime, untilTime },
  ): Promise<{ inserted: number; skipped: number; isDone: boolean; nextFromTime: number }> => {
    const existingJourneys = await ctx.runQuery(api.journeys._listAll, {});
    const existingKeys = new Set(
      existingJourneys.map((j) => `${j.cameraId ?? "none"}|${j.startTime}`),
    );
    const ceiling =
      untilTime ??
      existingJourneys.reduce((min, j) => Math.min(min, j.startTime), Number.POSITIVE_INFINITY);
    const endTime = Number.isFinite(ceiling) ? ceiling : undefined;
    const from = fromTime ?? 0;

    const lookupLocation = makeLocationLookup(ctx);
    let inserted = 0;
    let skipped = 0;

    const insertTrip = async (trip: Trip & TripEndpoints) => {
      const key = `${trip.cameraId ?? "none"}|${trip.startTime}`;
      if (existingKeys.has(key)) {
        skipped += 1;
        return;
      }
      existingKeys.add(key);
      const { startLat, startLng, endLat, endLng, ...rest } = trip;
      await ctx.runMutation(api.journeys._insert, {
        ...rest,
        startLocation: await lookupLocation(startLat, startLng),
        endLocation: await lookupLocation(endLat, endLng),
      });
      inserted += 1;
    };

    // Each camera's last segment stays open until a later page proves a gap
    // follows it, so it is held here rather than summarised immediately.
    const pending = new Map<string, FixLike[]>();
    let cursor: string | null = null;
    let isDone = false;
    let lastSeen = from;

    for (let page = 0; page < BACKFILL_MAX_PAGES; page++) {
      const result: FixPage = await ctx.runQuery(api.gpsFixes.pageFrom, {
        startTime: from,
        endTime,
        cursor,
        numItems: BACKFILL_PAGE_SIZE,
      });

      const byCamera = new Map<string, FixLike[]>();
      for (const fix of result.page) {
        const key = fix.cameraId ?? "none";
        const group = byCamera.get(key);
        if (group) group.push(fix);
        else byCamera.set(key, [fix]);
        if (fix.timestamp > lastSeen) lastSeen = fix.timestamp;
      }

      for (const [key, pageFixes] of byCamera) {
        const carried = pending.get(key) ?? [];
        const sorted = [...carried, ...pageFixes].sort((a, b) => a.timestamp - b.timestamp);
        const segments = splitIntoSegments(sorted);
        const cameraId = key === "none" ? undefined : (key as Id<"cameras">);
        for (const segment of segments.slice(0, -1)) {
          const trip = summarizeSegment(segment, cameraId);
          if (trip) await insertTrip(trip);
        }
        pending.set(key, segments[segments.length - 1] ?? []);
      }

      if (result.isDone) {
        isDone = true;
        break;
      }
      cursor = result.continueCursor;
    }

    const flushPending = async () => {
      for (const [key, segment] of pending) {
        const cameraId = key === "none" ? undefined : (key as Id<"cameras">);
        const trip = summarizeSegment(segment, cameraId);
        if (trip) await insertTrip(trip);
      }
    };

    if (isDone) {
      await flushPending();
      return { inserted, skipped, isDone: true, nextFromTime: lastSeen };
    }

    // Resume from the oldest still-open segment so its fixes are re-read and
    // re-clustered next run rather than lost at the seam. The carried state
    // is just a timestamp, which is why backfill takes no cursor argument.
    let nextFromTime = Number.POSITIVE_INFINITY;
    for (const segment of pending.values()) {
      if (segment.length > 0) nextFromTime = Math.min(nextFromTime, segment[0].timestamp);
    }
    if (!Number.isFinite(nextFromTime) || nextFromTime <= from) {
      // Either nothing is open, or one segment filled the whole page budget
      // and resuming at its start would loop forever. Close it out here and
      // move past it instead.
      await flushPending();
      nextFromTime = lastSeen + 1;
    }

    return { inserted, skipped, isDone: false, nextFromTime };
  },
});

export const _listAll = query({
  args: {},
  handler: async (ctx): Promise<Doc<"journeys">[]> => {
    return await ctx.db.query("journeys").collect();
  },
});

export const _delete = mutation({
  args: { id: v.id("journeys") },
  handler: async (ctx, { id }) => {
    await ctx.db.delete(id);
  },
});

interface DeletedFile {
  category: "videos" | "thumbnails" | "gps";
  filename: string;
}

interface DeleteAccelPageResult {
  deleted: number;
  isDone: boolean;
  continueCursor: string;
}

// Disk filenames are cameraId-prefixed by storage.ts and only recoverable
// from the stored path (the `filename` field holds the camera's own,
// unprefixed name) — matches how the web app derives download URLs.
function basename(filePath: string): string {
  return filePath.split(/[/\\]/).pop() ?? filePath;
}

// Deletes everything backing one derived trip: its gpsFixes/accelSamples,
// the recordings that overlap its time range (plus their events and linked
// gpsFiles), and any gpsFiles/fixes/samples in range that never matched a
// recording. Journeys have no real foreign keys pointing at them (see
// schema.ts), so "deleting a journey" means deleting its underlying camera
// data for that time range, not a single row with cascading children.
//
// Every recording/gpsFile filename removed here is also tombstoned in
// deletedFiles — the camera itself has no delete API, so without a
// tombstone the poller's next listing would just reimport the same files
// (see deletedFiles.ts and the poller's tombstone checks).
export const deleteRange = action({
  args: { cameraId: v.optional(v.id("cameras")), startTime: v.number(), endTime: v.number() },
  handler: async (ctx, { cameraId, startTime, endTime }): Promise<{ filesToDelete: DeletedFile[] }> => {
    const filesToDelete: DeletedFile[] = [];
    const handledGpsFileIds = new Set<Id<"gpsFiles">>();

    const deleteGpsFile = async (gpsFile: Doc<"gpsFiles">) => {
      if (handledGpsFileIds.has(gpsFile._id)) return;
      handledGpsFileIds.add(gpsFile._id);

      await ctx.runMutation(api.gpsFixes.deleteForGpsFile, { gpsFileId: gpsFile._id });

      let cursor: string | null = null;
      for (;;) {
        const result: DeleteAccelPageResult = await ctx.runMutation(
          api.accelSamples.deletePageForGpsFile,
          { gpsFileId: gpsFile._id, cursor },
        );
        if (result.isDone) break;
        cursor = result.continueCursor;
      }

      if (gpsFile.filePath) filesToDelete.push({ category: "gps", filename: basename(gpsFile.filePath) });
      await ctx.runMutation(api.gpsFiles._removeAndTombstone, {
        id: gpsFile._id,
        cameraId: gpsFile.cameraId,
        filename: gpsFile.filename,
      });
    };

    if (cameraId) {
      const recordings = await ctx.runQuery(api.recordings.forCameraTimeRange, {
        cameraId,
        startTime,
        endTime,
      });

      for (const recording of recordings) {
        const [events, gpsFiles] = await Promise.all([
          ctx.runQuery(api.events.forRecording, { recordingId: recording._id }),
          ctx.runQuery(api.gpsFiles.listForRecording, { recordingId: recording._id }),
        ]);

        for (const event of events) {
          await ctx.runMutation(api.events.remove, { id: event._id });
        }
        for (const gpsFile of gpsFiles) {
          await deleteGpsFile(gpsFile);
        }

        if (recording.filePath) {
          filesToDelete.push({ category: "videos", filename: basename(recording.filePath) });
        }
        if (recording.thumbnailPath) {
          filesToDelete.push({ category: "thumbnails", filename: basename(recording.thumbnailPath) });
        }
        await ctx.runMutation(api.recordings._removeAndTombstone, {
          id: recording._id,
          cameraId,
          filename: recording.filename,
        });
      }
    }

    // gpsFixes/accelSamples in range that never matched a recording (the
    // camera's parentfile linkage is unreliable — see syncGpsFiles) still
    // need to go, along with their parent gpsFiles.
    const fixesInRange = await ctx.runQuery(api.gpsFixes.forTimeRange, { startTime, endTime });
    const remainingGpsFileIds = new Set(
      fixesInRange
        .filter((f) => !cameraId || f.cameraId === cameraId)
        .map((f) => f.gpsFileId)
        .filter((id) => !handledGpsFileIds.has(id)),
    );
    for (const gpsFileId of remainingGpsFileIds) {
      const gpsFile = await ctx.runQuery(api.gpsFiles.get, { id: gpsFileId });
      if (gpsFile) await deleteGpsFile(gpsFile);
    }

    const journeys = await ctx.runQuery(api.journeys._listAll, {});
    const match = journeys.find(
      (j) => j.cameraId === cameraId && j.startTime === startTime && j.endTime === endTime,
    );
    if (match) await ctx.runMutation(api.journeys._delete, { id: match._id });

    return { filesToDelete };
  },
});

export const _insert = mutation({
  args: {
    cameraId: v.optional(v.id("cameras")),
    startTime: v.number(),
    endTime: v.number(),
    durationSeconds: v.number(),
    distanceKm: v.number(),
    maxSpeedKmh: v.number(),
    avgSpeedKmh: v.number(),
    fixCount: v.number(),
    startLocation: v.optional(v.string()),
    endLocation: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("journeys", args);
  },
});
