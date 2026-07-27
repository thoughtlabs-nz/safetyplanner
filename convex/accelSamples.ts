import { action, mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { api } from "./_generated/api";
import { type Id } from "./_generated/dataModel";

interface AccelPage {
  page: { _id: Id<"accelSamples">; timestamp: number; magnitudeG: number }[];
  isDone: boolean;
  continueCursor: string;
}

// A single gps file can hold 7000-8000+ 15Hz samples, and a trip's time
// range can span tens of thousands more — a plain .collect() over either
// hits Convex's per-query read/operation limit ("too many system
// operations", observed directly during a migration script run). These
// paginated queries let callers walk the data in bounded pages instead.
export const pageForGpsFile = query({
  args: { gpsFileId: v.id("gpsFiles"), paginationOpts: paginationOptsValidator },
  handler: async (ctx, { gpsFileId, paginationOpts }) => {
    return await ctx.db
      .query("accelSamples")
      .withIndex("by_gpsFileId", (q) => q.eq("gpsFileId", gpsFileId))
      .paginate(paginationOpts);
  },
});

export const pageForTimeRange = query({
  args: { startTime: v.number(), endTime: v.number(), paginationOpts: paginationOptsValidator },
  handler: async (ctx, { startTime, endTime, paginationOpts }) => {
    return await ctx.db
      .query("accelSamples")
      .withIndex("by_timestamp", (q) => q.gte("timestamp", startTime).lte("timestamp", endTime))
      .paginate(paginationOpts);
  },
});

// Actions can safely make many small, bounded query calls in a loop — each
// pageForTimeRange call stays under the read limit even though the full
// range might span tens of thousands of samples.
export const maxInRange = action({
  args: { startTime: v.number(), endTime: v.number() },
  handler: async (ctx, { startTime, endTime }): Promise<number | null> => {
    let max: number | null = null;
    let cursor: string | null = null;
    for (;;) {
      const result: AccelPage = await ctx.runQuery(api.accelSamples.pageForTimeRange, {
        startTime,
        endTime,
        paginationOpts: { numItems: 1000, cursor },
      });
      for (const sample of result.page) {
        if (max === null || sample.magnitudeG > max) max = sample.magnitudeG;
      }
      if (result.isDone) break;
      cursor = result.continueCursor;
    }
    return max;
  },
});

const BUCKET_MS = 1000; // matches the ~1Hz cadence of gpsFixes

// Buckets 15Hz accel samples into 1-second max-G values across a trip's time
// range, for coloring the route by G-force the same way it's colored by
// speed. Bucketing (rather than returning every raw sample) keeps the
// response small enough for a trip that can have tens of thousands of
// samples, while still preserving peak spikes (impacts) per second.
export const bucketedForRange = action({
  args: { startTime: v.number(), endTime: v.number() },
  handler: async (ctx, { startTime, endTime }): Promise<{ timestamp: number; maxG: number }[]> => {
    const buckets = new Map<number, number>();
    let cursor: string | null = null;
    for (;;) {
      const result: AccelPage = await ctx.runQuery(api.accelSamples.pageForTimeRange, {
        startTime,
        endTime,
        paginationOpts: { numItems: 1000, cursor },
      });
      for (const sample of result.page) {
        const bucket = Math.floor(sample.timestamp / BUCKET_MS) * BUCKET_MS;
        const current = buckets.get(bucket);
        if (current === undefined || sample.magnitudeG > current) {
          buckets.set(bucket, sample.magnitudeG);
        }
      }
      if (result.isDone) break;
      cursor = result.continueCursor;
    }

    return [...buckets.entries()]
      .map(([timestamp, maxG]) => ({ timestamp, maxG }))
      .sort((a, b) => a.timestamp - b.timestamp);
  },
});

// Paginated so a gps file's ~7-8k 15Hz samples don't blow the per-mutation
// operation limit — same reasoning as pageForGpsFile above.
export const deletePageForGpsFile = mutation({
  args: { gpsFileId: v.id("gpsFiles"), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { gpsFileId, cursor }) => {
    const result = await ctx.db
      .query("accelSamples")
      .withIndex("by_gpsFileId", (q) => q.eq("gpsFileId", gpsFileId))
      .paginate({ numItems: 500, cursor });
    for (const doc of result.page) {
      await ctx.db.delete(doc._id);
    }
    return { deleted: result.page.length, isDone: result.isDone, continueCursor: result.continueCursor };
  },
});

export const insertBatch = mutation({
  args: {
    gpsFileId: v.id("gpsFiles"),
    recordingId: v.optional(v.id("recordings")),
    samples: v.array(
      v.object({
        timestamp: v.number(),
        x: v.number(),
        y: v.number(),
        z: v.number(),
        magnitudeG: v.number(),
      }),
    ),
  },
  handler: async (ctx, { gpsFileId, recordingId, samples }) => {
    for (const sample of samples) {
      await ctx.db.insert("accelSamples", { gpsFileId, recordingId, ...sample });
    }

    const batchPeak = samples.reduce((max, s) => Math.max(max, s.magnitudeG), 0);
    const gpsFile = await ctx.db.get(gpsFileId);
    if (gpsFile && batchPeak > (gpsFile.peakG ?? 0)) {
      await ctx.db.patch(gpsFileId, { peakG: batchPeak });
    }
  },
});
