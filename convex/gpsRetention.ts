import { action, mutation } from "./_generated/server";
import { v } from "convex/values";
import { api } from "./_generated/api";
import { RETENTION_DEFAULTS } from "./settings";

interface DeletePageResult {
  deleted: number;
  isDone: boolean;
  continueCursor: string;
}

interface DownsamplePageResult {
  downsampled: number;
  deleted: number;
  isDone: boolean;
  continueCursor: string;
}

// Bounds how much work a single invocation does, so a large backlog gets
// worked down gradually across repeated runs instead of hitting Convex's
// per-call operation limit.
const PAGE_SIZE = 500;
const MAX_PAGES_PER_PHASE = 20;

export const deleteExpiredPage = mutation({
  args: { expireCutoff: v.number(), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { expireCutoff, cursor }) => {
    const result = await ctx.db
      .query("gpsFixes")
      .withIndex("by_timestamp", (q) => q.lt("timestamp", expireCutoff))
      .paginate({ numItems: PAGE_SIZE, cursor });
    for (const doc of result.page) {
      await ctx.db.delete(doc._id);
    }
    return { deleted: result.page.length, isDone: result.isDone, continueCursor: result.continueCursor };
  },
});

// Walks one page of raw (not yet downsampled) fixes in the
// [expireCutoff, downsampleCutoff) window, groups them by (camera,
// granularity-second bucket), and keeps only the highest-speed fix in each
// bucket — this is what makes the granularity slider work: a larger bucket
// (more seconds) keeps fewer, more widely spaced points. Keeping the
// fastest fix (rather than just the earliest) mirrors accelRetention's
// peak-preserving downsample, so a trip's recorded max speed doesn't
// silently drop just because the actual peak-speed sample wasn't first in
// its bucket. Heading is left as-is on the kept fix (no averaging), trading
// a little precision for a lot less storage, per the user's "not too much
// precision" ask.
export const downsamplePage = mutation({
  args: {
    startTime: v.number(),
    endTime: v.number(),
    granularitySeconds: v.number(),
    cursor: v.union(v.string(), v.null()),
  },
  handler: async (ctx, { startTime, endTime, granularitySeconds, cursor }) => {
    const result = await ctx.db
      .query("gpsFixes")
      .withIndex("by_timestamp", (q) => q.gte("timestamp", startTime).lt("timestamp", endTime))
      .paginate({ numItems: PAGE_SIZE, cursor });

    const bucketMs = Math.max(1, granularitySeconds) * 1000;
    const buckets = new Map<string, (typeof result.page)[number][]>();
    for (const doc of result.page) {
      if (doc.downsampled) continue; // already consolidated on a prior run
      const bucketKey = `${doc.cameraId ?? "none"}:${Math.floor(doc.timestamp / bucketMs)}`;
      const existing = buckets.get(bucketKey);
      if (existing) existing.push(doc);
      else buckets.set(bucketKey, [doc]);
    }

    let downsampled = 0;
    let deleted = 0;
    for (const docs of buckets.values()) {
      if (docs.length <= 1) {
        if (docs.length === 1) await ctx.db.patch(docs[0]._id, { downsampled: true });
        continue;
      }
      const kept = docs.reduce((fastest, d) =>
        (d.speedKmh ?? -1) > (fastest.speedKmh ?? -1) ? d : fastest,
      );
      for (const doc of docs) {
        if (doc._id === kept._id) {
          await ctx.db.patch(doc._id, { downsampled: true });
        } else {
          await ctx.db.delete(doc._id);
          deleted += 1;
        }
      }
      downsampled += 1;
    }

    return { downsampled, deleted, isDone: result.isDone, continueCursor: result.continueCursor };
  },
});

export const runRetention = action({
  args: { force: v.optional(v.boolean()) },
  handler: async (
    ctx,
    { force },
  ): Promise<{ deletedExpired: number; downsampledBuckets: number; deletedRaw: number }> => {
    const settings = await ctx.runQuery(api.settings.get, {});
    const downsampleAfterDays = settings.gpsDownsampleAfterDays ?? RETENTION_DEFAULTS.gpsDownsampleAfterDays;
    const granularitySeconds = settings.gpsGranularitySeconds ?? RETENTION_DEFAULTS.gpsGranularitySeconds;
    const expireDays = settings.gpsExpireDays ?? RETENTION_DEFAULTS.gpsExpireDays;

    const now = Date.now();
    // Forcing only pulls the downsample threshold forward to "now" — the
    // expire (full delete) threshold is left alone even when forced, since
    // that's a much more destructive action than thinning and wasn't asked for.
    const downsampleCutoff = force ? now : now - downsampleAfterDays * 24 * 60 * 60 * 1000;
    const expireCutoff = now - expireDays * 24 * 60 * 60 * 1000;

    let deletedExpired = 0;
    {
      let cursor: string | null = null;
      for (let page = 0; page < MAX_PAGES_PER_PHASE; page++) {
        const result: DeletePageResult = await ctx.runMutation(api.gpsRetention.deleteExpiredPage, {
          expireCutoff,
          cursor,
        });
        deletedExpired += result.deleted;
        if (result.isDone) break;
        cursor = result.continueCursor;
      }
    }

    let downsampledBuckets = 0;
    let deletedRaw = 0;
    {
      let cursor: string | null = null;
      for (let page = 0; page < MAX_PAGES_PER_PHASE; page++) {
        const result: DownsamplePageResult = await ctx.runMutation(api.gpsRetention.downsamplePage, {
          startTime: expireCutoff,
          endTime: downsampleCutoff,
          granularitySeconds,
          cursor,
        });
        downsampledBuckets += result.downsampled;
        deletedRaw += result.deleted;
        if (result.isDone) break;
        cursor = result.continueCursor;
      }
    }

    return { deletedExpired, downsampledBuckets, deletedRaw };
  },
});
