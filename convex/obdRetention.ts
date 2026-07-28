import { action, mutation } from "./_generated/server";
import { v } from "convex/values";
import { api } from "./_generated/api";
import { RETENTION_DEFAULTS } from "./settings";

interface DeletePageResult {
  deleted: number;
  isDone: boolean;
  continueCursor: string;
}

// Retention policy for obdSamples: expiry only, no downsampling — which is
// the deliberate difference from gpsRetention/accelRetention.
//
// Two reasons. Volume: OBD is recorded every few seconds rather than at
// 15Hz, so a day of continuous driving is thousands of rows against
// accelSamples' ~1.3M — the pressure that makes downsampling worth its
// complexity there simply isn't present here. And semantics: downsampling
// works for accel because "the peak magnitude in this bucket" is both
// well-defined and the thing you actually care about. An OBD sample is
// twenty heterogeneous readings, and there is no non-arbitrary way to pick
// a representative across state of charge, gear position and tyre pressure
// at once. Better to keep every sample for a shorter window than to invent
// a summarisation rule nobody asked for.
//
// The expiry threshold is shared with accelSamples (accelExpireDays) rather
// than adding a control of its own: both are recorded on the same drives by
// the same phone, and there's no reason to want one after the other is gone.
const PAGE_SIZE = 500;
const MAX_PAGES_PER_PHASE = 20;

export const deleteExpiredPage = mutation({
  args: { expireCutoff: v.number(), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { expireCutoff, cursor }) => {
    const result = await ctx.db
      .query("obdSamples")
      .withIndex("by_timestamp", (q) => q.lt("timestamp", expireCutoff))
      .paginate({ numItems: PAGE_SIZE, cursor });
    for (const doc of result.page) {
      await ctx.db.delete(doc._id);
    }
    return { deleted: result.page.length, isDone: result.isDone, continueCursor: result.continueCursor };
  },
});

export const runRetention = action({
  args: {},
  handler: async (ctx): Promise<{ deletedExpired: number }> => {
    const settings = await ctx.runQuery(api.settings.get, {});
    const expireDays = settings.accelExpireDays ?? RETENTION_DEFAULTS.accelExpireDays;
    const expireCutoff = Date.now() - expireDays * 24 * 60 * 60 * 1000;

    let deletedExpired = 0;
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES_PER_PHASE; page++) {
      const result: DeletePageResult = await ctx.runMutation(api.obdRetention.deleteExpiredPage, {
        expireCutoff,
        cursor,
      });
      deletedExpired += result.deleted;
      if (result.isDone) break;
      cursor = result.continueCursor;
    }

    return { deletedExpired };
  },
});
