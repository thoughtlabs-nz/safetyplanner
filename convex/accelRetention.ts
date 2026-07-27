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

// Retention policy for accelSamples (15Hz raw data adds up fast — a single
// day of continuous recording is ~1.3M rows), configurable from Settings
// (see settings.RETENTION_DEFAULTS for the out-of-the-box values):
//   0-N days old:      kept at full 15Hz fidelity
//   N-expire days old: downsampled to 1 sample per `accelGranularitySeconds`
//                      (the peak/max-magnitude reading in each bucket is
//                      kept, since that's what matters for spotting harsh
//                      events/impacts — everything else in the bucket is
//                      discarded)
//   expire+ days old:  deleted entirely

// Bounds how much work a single invocation does, so a large backlog gets
// worked down gradually across repeated runs instead of hitting Convex's
// per-call operation limit (the same "too many system operations" error
// seen earlier with unbounded loops).
const PAGE_SIZE = 500;
const MAX_PAGES_PER_PHASE = 20;

export const deleteExpiredPage = mutation({
  args: { expireCutoff: v.number(), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { expireCutoff, cursor }) => {
    const result = await ctx.db
      .query("accelSamples")
      .withIndex("by_timestamp", (q) => q.lt("timestamp", expireCutoff))
      .paginate({ numItems: PAGE_SIZE, cursor });
    for (const doc of result.page) {
      await ctx.db.delete(doc._id);
    }
    return { deleted: result.page.length, isDone: result.isDone, continueCursor: result.continueCursor };
  },
});

// Walks one page of raw (not yet downsampled) samples in the
// [expireCutoff, downsampleCutoff) window, groups them by (gpsFileId,
// granularity-second bucket), and replaces each group with a single row
// holding the peak magnitude for that bucket.
export const downsamplePage = mutation({
  args: {
    startTime: v.number(),
    endTime: v.number(),
    granularitySeconds: v.number(),
    cursor: v.union(v.string(), v.null()),
  },
  handler: async (ctx, { startTime, endTime, granularitySeconds, cursor }) => {
    const result = await ctx.db
      .query("accelSamples")
      .withIndex("by_timestamp", (q) => q.gte("timestamp", startTime).lt("timestamp", endTime))
      .paginate({ numItems: PAGE_SIZE, cursor });

    const bucketMs = Math.max(1, granularitySeconds) * 1000;
    const buckets = new Map<string, (typeof result.page)[number][]>();
    for (const doc of result.page) {
      if (doc.downsampled) continue; // already consolidated on a prior run
      const bucketKey = `${doc.gpsFileId}:${Math.floor(doc.timestamp / bucketMs)}`;
      const existing = buckets.get(bucketKey);
      if (existing) existing.push(doc);
      else buckets.set(bucketKey, [doc]);
    }

    let downsampled = 0;
    let deleted = 0;
    for (const docs of buckets.values()) {
      if (docs.length <= 1) {
        // Nothing to consolidate, but still mark it so future pages skip it.
        if (docs.length === 1) await ctx.db.patch(docs[0]._id, { downsampled: true });
        continue;
      }
      const peak = docs.reduce((max, d) => (d.magnitudeG > max.magnitudeG ? d : max));
      for (const doc of docs) {
        if (doc._id === peak._id) {
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
    const downsampleAfterDays =
      settings.accelDownsampleAfterDays ?? RETENTION_DEFAULTS.accelDownsampleAfterDays;
    const granularitySeconds =
      settings.accelGranularitySeconds ?? RETENTION_DEFAULTS.accelGranularitySeconds;
    const expireDays = settings.accelExpireDays ?? RETENTION_DEFAULTS.accelExpireDays;

    const now = Date.now();
    const expireCutoff = now - expireDays * 24 * 60 * 60 * 1000;
    // Forcing only pulls the downsample threshold forward to "now" — the
    // expire (full delete) threshold is left alone even when forced, since
    // that's a much more destructive action than thinning and wasn't asked for.
    const downsampleCutoff = force ? now : now - downsampleAfterDays * 24 * 60 * 60 * 1000;

    let deletedExpired = 0;
    {
      let cursor: string | null = null;
      for (let page = 0; page < MAX_PAGES_PER_PHASE; page++) {
        const result: DeletePageResult = await ctx.runMutation(api.accelRetention.deleteExpiredPage, {
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
        const result: DownsamplePageResult = await ctx.runMutation(
          api.accelRetention.downsamplePage,
          { startTime: expireCutoff, endTime: downsampleCutoff, granularitySeconds, cursor },
        );
        downsampledBuckets += result.downsampled;
        deletedRaw += result.deleted;
        if (result.isDone) break;
        cursor = result.continueCursor;
      }
    }

    return { deletedExpired, downsampledBuckets, deletedRaw };
  },
});
