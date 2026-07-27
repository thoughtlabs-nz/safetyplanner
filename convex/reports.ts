import { query } from "./_generated/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { requireIdentity } from "./lib/authz";

const UNASSIGNED_KEY = "unassigned";

function keyFor(cameraId: Id<"cameras"> | undefined): string {
  return cameraId ?? UNASSIGNED_KEY;
}

// Shared computation behind both the web Reporting page's per-widget
// queries below and mobileSummary's single combined call — factored out so
// the iOS app gets identical numbers from identical logic, not a
// hand-copied re-implementation that can drift.

async function computeOverview(ctx: QueryCtx) {
  const journeys = await ctx.db.query("journeys").collect();
  const events = await ctx.db.query("events").collect();
  const gpsFiles = await ctx.db.query("gpsFiles").collect();

  const totalDistanceKm = journeys.reduce((sum, j) => sum + j.distanceKm, 0);
  const totalDrivingSeconds = journeys.reduce((sum, j) => sum + j.durationSeconds, 0);
  const maxSpeedKmh = journeys.reduce((max, j) => Math.max(max, j.maxSpeedKmh), 0);
  const peakG = gpsFiles.reduce((max, f) => Math.max(max, f.peakG ?? 0), 0);

  const eventsByType: Record<string, number> = {};
  for (const e of events) {
    eventsByType[e.type] = (eventsByType[e.type] ?? 0) + 1;
  }

  return {
    totalTrips: journeys.length,
    totalDistanceKm,
    totalDrivingSeconds,
    maxSpeedKmh,
    peakG,
    totalEvents: events.length,
    eventsByType,
  };
}

async function computePerCamera(ctx: QueryCtx) {
  const cameras = await ctx.db.query("cameras").collect();
  const statuses = await ctx.db.query("cameraStatus").collect();
  const journeys = await ctx.db.query("journeys").collect();
  const recordings = await ctx.db.query("recordings").collect();
  const gpsFiles = await ctx.db.query("gpsFiles").collect();
  const events = await ctx.db.query("events").collect();

  const recordingCameraById = new Map<Id<"recordings">, Id<"cameras"> | undefined>(
    recordings.map((r) => [r._id, r.cameraId]),
  );

  const journeysByKey = new Map<string, Doc<"journeys">[]>();
  for (const j of journeys) {
    const key = keyFor(j.cameraId);
    const group = journeysByKey.get(key);
    if (group) group.push(j);
    else journeysByKey.set(key, [j]);
  }

  const recordingCountByKey = new Map<string, number>();
  for (const r of recordings) {
    const key = keyFor(r.cameraId);
    recordingCountByKey.set(key, (recordingCountByKey.get(key) ?? 0) + 1);
  }

  const peakGByKey = new Map<string, number>();
  for (const f of gpsFiles) {
    const key = keyFor(f.cameraId);
    peakGByKey.set(key, Math.max(peakGByKey.get(key) ?? 0, f.peakG ?? 0));
  }

  const eventCountByKey = new Map<string, number>();
  for (const e of events) {
    const cameraId = recordingCameraById.get(e.recordingId);
    const key = keyFor(cameraId);
    eventCountByKey.set(key, (eventCountByKey.get(key) ?? 0) + 1);
  }

  const statusByCameraId = new Map(statuses.map((s) => [s.cameraId, s]));

  function summarize(key: string, name: string, cameraId: Id<"cameras"> | undefined) {
    const cameraJourneys = journeysByKey.get(key) ?? [];
    const totalDistanceKm = cameraJourneys.reduce((sum, j) => sum + j.distanceKm, 0);
    const totalDrivingSeconds = cameraJourneys.reduce((sum, j) => sum + j.durationSeconds, 0);
    const maxSpeedKmh = cameraJourneys.reduce((max, j) => Math.max(max, j.maxSpeedKmh), 0);
    const avgSpeedKmh =
      cameraJourneys.length > 0
        ? cameraJourneys.reduce((sum, j) => sum + j.avgSpeedKmh, 0) / cameraJourneys.length
        : 0;
    const status = cameraId ? statusByCameraId.get(cameraId) : undefined;

    return {
      cameraId,
      name,
      connected: status?.connected ?? false,
      lastSeenAt: status?.lastSeenAt,
      tripCount: cameraJourneys.length,
      totalDistanceKm,
      totalDrivingSeconds,
      maxSpeedKmh,
      avgSpeedKmh,
      peakG: peakGByKey.get(key) ?? 0,
      recordingCount: recordingCountByKey.get(key) ?? 0,
      eventCount: eventCountByKey.get(key) ?? 0,
    };
  }

  const rows = cameras.map((c) => summarize(keyFor(c._id), c.name, c._id));

  const unassignedKey = UNASSIGNED_KEY;
  const hasUnassignedData =
    (journeysByKey.get(unassignedKey)?.length ?? 0) > 0 ||
    (recordingCountByKey.get(unassignedKey) ?? 0) > 0;
  if (hasUnassignedData) {
    rows.push(summarize(unassignedKey, "Unassigned (before multi-camera support)", undefined));
  }

  return rows;
}

async function computeDailyDistance(ctx: QueryCtx, days: number | undefined) {
  const numDays = days ?? 14;
  const cutoff = Date.now() - numDays * 24 * 60 * 60 * 1000;
  const journeys = await ctx.db
    .query("journeys")
    .withIndex("by_startTime", (q) => q.gte("startTime", cutoff))
    .collect();

  const byDay = new Map<string, { distanceKm: number; tripCount: number }>();
  for (const j of journeys) {
    const dayKey = new Date(j.startTime).toISOString().slice(0, 10);
    const existing = byDay.get(dayKey) ?? { distanceKm: 0, tripCount: 0 };
    existing.distanceKm += j.distanceKm;
    existing.tripCount += 1;
    byDay.set(dayKey, existing);
  }

  const days_: { day: string; distanceKm: number; tripCount: number }[] = [];
  for (let i = numDays - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
    const dayKey = d.toISOString().slice(0, 10);
    const existing = byDay.get(dayKey) ?? { distanceKm: 0, tripCount: 0 };
    days_.push({ day: dayKey, ...existing });
  }
  return days_;
}

async function computeHourOfDayDistribution(ctx: QueryCtx) {
  const journeys = await ctx.db.query("journeys").collect();
  const counts = new Array(24).fill(0) as number[];
  for (const j of journeys) {
    const hour = new Date(j.startTime).getHours();
    counts[hour] += 1;
  }
  return counts.map((count, hour) => ({ hour, count }));
}

async function computeTopLocations(ctx: QueryCtx, limit: number | undefined) {
  const journeys = await ctx.db.query("journeys").collect();
  const counts = new Map<string, number>();
  for (const j of journeys) {
    if (j.startLocation) counts.set(j.startLocation, (counts.get(j.startLocation) ?? 0) + 1);
    if (j.endLocation) counts.set(j.endLocation, (counts.get(j.endLocation) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([location, count]) => ({ location, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit ?? 6);
}

// Top-level numbers for the Reporting page's hero stat tiles — distance,
// trip count, driving time, top speed, peak G, and event totals across every
// camera combined.
export const overview = query({
  args: {},
  handler: async (ctx) => computeOverview(ctx),
});

// Per-camera (per-vehicle) breakdown — trip count, distance, drive time,
// speeds, peak G, event count, and current connection status. Journeys /
// recordings / gpsFiles created before multi-camera support don't carry a
// cameraId, so they're folded into a single "Unassigned" bucket rather than
// silently dropped or attributed to a guessed camera.
export const perCamera = query({
  args: {},
  handler: async (ctx) => computePerCamera(ctx),
});

// Trip count + distance per day, most recent `days` days — for the daily
// distance trend chart.
export const dailyDistance = query({
  args: { days: v.optional(v.number()) },
  handler: async (ctx, { days }) => computeDailyDistance(ctx, days),
});

// Trip counts bucketed by hour-of-day the trip started — "when do you
// drive" distribution.
export const hourOfDayDistribution = query({
  args: {},
  handler: async (ctx) => computeHourOfDayDistribution(ctx),
});

// The most frequent start/end locations (from Overpass reverse geocoding),
// combined — "where you actually go".
export const topLocations = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => computeTopLocations(ctx, limit),
});

// Everything the Reporting page needs, in one call — used by the iOS app's
// GET /api/reporting-summary (convex/http.ts) instead of five separate
// query subscriptions, since Convex has no native Swift client (see
// http.ts's device-config route for the same reasoning). Requires auth
// (unlike the per-widget queries above, which are only gated client-side by
// the web app's RequireAuth route wrapper) since this is a plain HTTP
// endpoint reachable by anyone with the URL, not a websocket query call.
export const mobileSummary = query({
  args: {},
  handler: async (ctx) => {
    await requireIdentity(ctx);
    const [overviewData, perCameraData, dailyDistanceData, hourOfDayData, topLocationsData] = await Promise.all([
      computeOverview(ctx),
      computePerCamera(ctx),
      computeDailyDistance(ctx, 14),
      computeHourOfDayDistribution(ctx),
      computeTopLocations(ctx, 6),
    ]);
    return {
      overview: overviewData,
      perCamera: perCameraData,
      dailyDistance: dailyDistanceData,
      hourOfDay: hourOfDayData,
      topLocations: topLocationsData,
    };
  },
});
