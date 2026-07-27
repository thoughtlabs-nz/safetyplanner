import { internalAction, internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";

// One-off maintenance for the duplicate-import incident: the phone bridge's
// message filenames depended on parse results (bare "X" vs chunked
// "X__chunkN"), so parser fixes re-sent the same pieces under new names and
// filename-dedupe missed them (see mqtt-ingest's handleGpsData, which now
// guards against this). This removes what already got in:
//  - gpsFixes/accelSamples whose gpsFiles row no longer exists (orphans)
//  - exact-duplicate rows among live ones (same timestamp + values), keeping
//    the first
// Run with: npx convex run dedupeCleanup:run
// Then rebuild journeys: npx convex run journeys:rebuild

const BATCH = 500;

export const dedupeFixesBatch = internalMutation({
  args: { afterTs: v.number() },
  handler: async (ctx, { afterTs }) => {
    const gpsFileIds = new Set(
      (await ctx.db.query("gpsFiles").collect()).map((f) => f._id as string),
    );
    const rows = await ctx.db
      .query("gpsFixes")
      .withIndex("by_timestamp", (q) => q.gt("timestamp", afterTs))
      .order("asc")
      .take(BATCH);
    if (rows.length === 0) return { done: true, nextCursor: afterTs, deleted: 0 };

    // Duplicates share an exact timestamp, so they're adjacent in this
    // index scan — but a same-timestamp group could straddle the batch
    // boundary. Drop the trailing timestamp group from this pass (unless
    // it's the only group / the final page) so it's processed whole next
    // time.
    const lastTs = rows[rows.length - 1].timestamp;
    const isFinalPage = rows.length < BATCH;
    const toProcess =
      isFinalPage || rows[0].timestamp === lastTs
        ? rows
        : rows.filter((r) => r.timestamp !== lastTs);

    let deleted = 0;
    const seen = new Set<string>();
    for (const row of toProcess) {
      if (!gpsFileIds.has(row.gpsFileId as string)) {
        await ctx.db.delete(row._id);
        deleted++;
        continue;
      }
      const key = `${row.cameraId ?? ""}|${row.timestamp}|${row.lat}|${row.lng}`;
      if (seen.has(key)) {
        await ctx.db.delete(row._id);
        deleted++;
      } else {
        seen.add(key);
      }
    }
    return {
      done: isFinalPage,
      nextCursor: toProcess[toProcess.length - 1].timestamp,
      deleted,
    };
  },
});

export const dedupeAccelBatch = internalMutation({
  args: { afterTs: v.number() },
  handler: async (ctx, { afterTs }) => {
    const gpsFileIds = new Set(
      (await ctx.db.query("gpsFiles").collect()).map((f) => f._id as string),
    );
    const rows = await ctx.db
      .query("accelSamples")
      .withIndex("by_timestamp", (q) => q.gt("timestamp", afterTs))
      .order("asc")
      .take(BATCH);
    if (rows.length === 0) return { done: true, nextCursor: afterTs, deleted: 0 };

    const lastTs = rows[rows.length - 1].timestamp;
    const isFinalPage = rows.length < BATCH;
    const toProcess =
      isFinalPage || rows[0].timestamp === lastTs
        ? rows
        : rows.filter((r) => r.timestamp !== lastTs);

    let deleted = 0;
    const seen = new Set<string>();
    for (const row of toProcess) {
      if (!gpsFileIds.has(row.gpsFileId as string)) {
        await ctx.db.delete(row._id);
        deleted++;
        continue;
      }
      const key = `${row.timestamp}|${row.x}|${row.y}|${row.z}`;
      if (seen.has(key)) {
        await ctx.db.delete(row._id);
        deleted++;
      } else {
        seen.add(key);
      }
    }
    return {
      done: isFinalPage,
      nextCursor: toProcess[toProcess.length - 1].timestamp,
      deleted,
    };
  },
});

export const run = internalAction({
  args: {},
  handler: async (ctx): Promise<{ fixesDeleted: number; accelDeleted: number }> => {
    let fixesDeleted = 0;
    let cursor = 0;
    for (;;) {
      const r = await ctx.runMutation(internal.dedupeCleanup.dedupeFixesBatch, { afterTs: cursor });
      fixesDeleted += r.deleted;
      if (r.done) break;
      cursor = r.nextCursor;
    }
    let accelDeleted = 0;
    cursor = 0;
    for (;;) {
      const r = await ctx.runMutation(internal.dedupeCleanup.dedupeAccelBatch, { afterTs: cursor });
      accelDeleted += r.deleted;
      if (r.done) break;
      cursor = r.nextCursor;
    }
    return { fixesDeleted, accelDeleted };
  },
});
