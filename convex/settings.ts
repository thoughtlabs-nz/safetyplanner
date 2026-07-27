import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { requireAdmin } from "./lib/authz";

// Defaults mirror the values accelRetention.ts used to hardcode (3 days raw,
// 30 days total, 1-second buckets) — exported so the retention jobs and the
// Settings UI agree on what "unset" means without duplicating the numbers.
export const RETENTION_DEFAULTS = {
  gpsDownsampleAfterDays: 3,
  gpsGranularitySeconds: 5,
  gpsExpireDays: 90,
  accelDownsampleAfterDays: 3,
  accelGranularitySeconds: 1,
  accelExpireDays: 30,
  retentionIntervalMinutes: 360, // 6 hours
  speedTolerancePercent: 10,
};

// Settings are a single row — read it (or defaults if none exists yet).
export const get = query({
  args: {},
  handler: async (ctx) => {
    const row = await ctx.db.query("settings").first();
    return {
      overpassUrl: row?.overpassUrl ?? "",
      overpassApiKey: row?.overpassApiKey ?? "",
      gpsDownsampleAfterDays: row?.gpsDownsampleAfterDays ?? RETENTION_DEFAULTS.gpsDownsampleAfterDays,
      gpsGranularitySeconds: row?.gpsGranularitySeconds ?? RETENTION_DEFAULTS.gpsGranularitySeconds,
      gpsExpireDays: row?.gpsExpireDays ?? RETENTION_DEFAULTS.gpsExpireDays,
      accelDownsampleAfterDays:
        row?.accelDownsampleAfterDays ?? RETENTION_DEFAULTS.accelDownsampleAfterDays,
      accelGranularitySeconds:
        row?.accelGranularitySeconds ?? RETENTION_DEFAULTS.accelGranularitySeconds,
      accelExpireDays: row?.accelExpireDays ?? RETENTION_DEFAULTS.accelExpireDays,
      retentionIntervalMinutes:
        row?.retentionIntervalMinutes ?? RETENTION_DEFAULTS.retentionIntervalMinutes,
      lastRetentionRunAt: row?.lastRetentionRunAt,
      speedTolerancePercent:
        row?.speedTolerancePercent ?? RETENTION_DEFAULTS.speedTolerancePercent,
    };
  },
});

export const update = mutation({
  args: {
    overpassUrl: v.optional(v.string()),
    overpassApiKey: v.optional(v.string()),
    gpsDownsampleAfterDays: v.optional(v.number()),
    gpsGranularitySeconds: v.optional(v.number()),
    gpsExpireDays: v.optional(v.number()),
    accelDownsampleAfterDays: v.optional(v.number()),
    accelGranularitySeconds: v.optional(v.number()),
    accelExpireDays: v.optional(v.number()),
    retentionIntervalMinutes: v.optional(v.number()),
    speedTolerancePercent: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const existing = await ctx.db.query("settings").first();
    if (existing) {
      await ctx.db.patch(existing._id, args);
    } else {
      await ctx.db.insert("settings", args);
    }
  },
});

// Bookkeeping for the tick-and-check scheduler (see retentionScheduler.ts) —
// separate from `update` so the UI's save action never accidentally
// overwrites this.
export const markRetentionRan = mutation({
  args: {},
  handler: async (ctx) => {
    const existing = await ctx.db.query("settings").first();
    if (existing) {
      await ctx.db.patch(existing._id, { lastRetentionRunAt: Date.now() });
    } else {
      await ctx.db.insert("settings", { lastRetentionRunAt: Date.now() });
    }
  },
});
