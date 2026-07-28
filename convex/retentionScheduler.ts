import { action } from "./_generated/server";
import { api } from "./_generated/api";
import { RETENTION_DEFAULTS } from "./settings";

// Convex crons are fixed at deploy time — they can't be rescheduled from the
// UI. So instead of a cron whose interval is user-controlled, this ticks on
// a short fixed cadence (see crons.ts) and only does real work once the
// user's configured interval (settings.retentionIntervalMinutes) has
// elapsed since the last run. This is what makes the Settings page's "run
// every N hours" control actually mean something without a redeploy.
export const runIfDue = action({
  args: {},
  handler: async (ctx): Promise<{ ran: boolean }> => {
    const settings = await ctx.runQuery(api.settings.get, {});
    const intervalMs =
      (settings.retentionIntervalMinutes ?? RETENTION_DEFAULTS.retentionIntervalMinutes) * 60 * 1000;
    const dueAt = (settings.lastRetentionRunAt ?? 0) + intervalMs;

    if (Date.now() < dueAt) {
      return { ran: false };
    }

    await ctx.runAction(api.gpsRetention.runRetention, {});
    await ctx.runAction(api.accelRetention.runRetention, {});
    await ctx.runAction(api.obdRetention.runRetention, {});
    await ctx.runMutation(api.settings.markRetentionRan, {});

    return { ran: true };
  },
});

// "Run now" button on the Settings page — bypasses the interval check.
export const runNow = action({
  args: {},
  handler: async (
    ctx,
  ): Promise<{
    gps: { deletedExpired: number; downsampledBuckets: number; deletedRaw: number };
    accel: { deletedExpired: number; downsampledBuckets: number; deletedRaw: number };
    // Expiry only — obdSamples are never downsampled, see obdRetention.ts.
    obd: { deletedExpired: number };
  }> => {
    const gps = await ctx.runAction(api.gpsRetention.runRetention, {});
    const accel = await ctx.runAction(api.accelRetention.runRetention, {});
    const obd = await ctx.runAction(api.obdRetention.runRetention, {});
    await ctx.runMutation(api.settings.markRetentionRan, {});
    return { gps, accel, obd };
  },
});

// "Force run" buttons — same as runNow, but also ignore the "downsample
// after" age threshold so points get thinned to the configured granularity
// immediately, regardless of how recent they are. The "delete after" expiry
// threshold is NOT overridden (see gpsRetention/accelRetention.runRetention)
// — this only makes downsampling immediate, never full deletion. Split into
// separate GPS/accel actions since accelSamples backlogs can need several
// repeated presses to fully clear (each run is bounded), and running that
// repeatedly shouldn't force-touch GPS fixes every time too.
export const forceGpsNow = action({
  args: {},
  handler: async (
    ctx,
  ): Promise<{ deletedExpired: number; downsampledBuckets: number; deletedRaw: number }> => {
    const gps = await ctx.runAction(api.gpsRetention.runRetention, { force: true });
    await ctx.runMutation(api.settings.markRetentionRan, {});
    return gps;
  },
});

export const forceAccelNow = action({
  args: {},
  handler: async (
    ctx,
  ): Promise<{ deletedExpired: number; downsampledBuckets: number; deletedRaw: number }> => {
    const accel = await ctx.runAction(api.accelRetention.runRetention, { force: true });
    await ctx.runMutation(api.settings.markRetentionRan, {});
    return accel;
  },
});
