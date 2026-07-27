import { action, mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { api } from "./_generated/api";
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

// Clusters one camera's chronologically-sorted fixes into trips (a gap over
// SEGMENT_GAP_MS starts a new trip). Split out from `rebuild` so each camera
// is clustered independently — mixing two cameras' fixes by time alone would
// braid unrelated vehicles' data into the same "trip".
function clusterTrips(
  sorted: Array<{ timestamp: number; lat: number; lng: number; speedKmh?: number }>,
  cameraId: Id<"cameras"> | undefined,
): (Trip & TripEndpoints)[] {
  const trips: (Trip & TripEndpoints)[] = [];
  let current: typeof sorted = [];

  const flush = () => {
    if (current.length < 2) {
      current = [];
      return;
    }
    let distanceKm = 0;
    let maxSpeedKmh = 0;
    let speedSum = 0;
    let speedCount = 0;
    for (let i = 0; i < current.length; i++) {
      const fix = current[i];
      if (fix.speedKmh !== undefined) {
        maxSpeedKmh = Math.max(maxSpeedKmh, fix.speedKmh);
        speedSum += fix.speedKmh;
        speedCount += 1;
      }
      if (i > 0) {
        const prev = current[i - 1];
        distanceKm += haversineKm(prev.lat, prev.lng, fix.lat, fix.lng);
      }
    }
    const startTime = current[0].timestamp;
    const endTime = current[current.length - 1].timestamp;
    trips.push({
      cameraId,
      startTime,
      endTime,
      durationSeconds: Math.round((endTime - startTime) / 1000),
      distanceKm,
      maxSpeedKmh,
      avgSpeedKmh: speedCount > 0 ? speedSum / speedCount : 0,
      fixCount: current.length,
      startLat: current[0].lat,
      startLng: current[0].lng,
      endLat: current[current.length - 1].lat,
      endLng: current[current.length - 1].lng,
    });
    current = [];
  };

  for (const fix of sorted) {
    const last = current[current.length - 1];
    if (last && fix.timestamp - last.timestamp > SEGMENT_GAP_MS) {
      flush();
    }
    current.push(fix);
  }
  flush();

  return trips;
}

// Rebuild the persisted journeys table from the most recent gpsFixes.
// Schedulable from a cron job so new GPS files automatically update the list.
export const rebuild = action({
  args: {},
  handler: async (ctx): Promise<{ count: number }> => {
    const existingJourneys = await ctx.runQuery(api.journeys._listAll, {});
    // Reused so trips that haven't changed since the last rebuild don't
    // re-hit the Overpass API — reverse geocoding is the slow, rate-limited
    // part of this job. Keyed by camera + startTime since two cameras could
    // otherwise coincidentally share a startTime.
    const existingByKey = new Map(
      existingJourneys.map((j) => [`${j.cameraId ?? "none"}|${j.startTime}`, j]),
    );

    const fixes = await ctx.runQuery(api.gpsFixes.recent, { limit: 5000 });
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

    const locationCache = new Map<string, string | undefined>();
    const lookupLocation = async (lat: number, lng: number): Promise<string | undefined> => {
      const key = coordKey(lat, lng);
      if (locationCache.has(key)) return locationCache.get(key);
      let label: string | undefined;
      try {
        label = (await ctx.runAction(api.overpass.nearestPlaceName, { lat, lng })) ?? undefined;
      } catch {
        label = undefined;
      }
      locationCache.set(key, label);
      return label;
    };

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

    for (const id of existingJourneys.map((j) => j._id)) {
      await ctx.runMutation(api.journeys._delete, { id });
    }
    for (const { startLat, startLng, endLat, endLng, ...trip } of trips) {
      await ctx.runMutation(api.journeys._insert, trip);
    }

    return { count: trips.length };
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
