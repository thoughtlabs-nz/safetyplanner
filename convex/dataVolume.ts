import { action, query } from "./_generated/server";
import { v } from "convex/values";
import { api } from "./_generated/api";
import type { ActionCtx } from "./_generated/server";

// A single query's .collect() is capped by Convex's per-execution read
// limit (4096) — fine for the small tables, but gpsFixes/accelSamples can
// run into the millions. This paginates across many small query calls
// instead, capped at COUNT_CAP so "how much data do I have" stays a cheap,
// fast estimate rather than a full table scan.
const COUNT_CAP = 250_000;
const PAGE_SIZE = 1000;

export const countPage = query({
  args: {
    table: v.union(v.literal("gpsFixes"), v.literal("accelSamples")),
    cursor: v.union(v.string(), v.null()),
  },
  handler: async (
    ctx,
    { table, cursor },
  ): Promise<{ count: number; isDone: boolean; continueCursor: string }> => {
    const result = await ctx.db.query(table).paginate({ numItems: PAGE_SIZE, cursor });
    return { count: result.page.length, isDone: result.isDone, continueCursor: result.continueCursor };
  },
});

async function boundedCount(
  ctx: ActionCtx,
  table: "gpsFixes" | "accelSamples",
): Promise<{ count: number; approximate: boolean }> {
  let total = 0;
  let cursor: string | null = null;
  for (;;) {
    const page: { count: number; isDone: boolean; continueCursor: string } = await ctx.runQuery(
      api.dataVolume.countPage,
      { table, cursor },
    );
    total += page.count;
    if (page.isDone) return { count: total, approximate: false };
    if (total >= COUNT_CAP) return { count: total, approximate: true };
    cursor = page.continueCursor;
  }
}

// Row-count estimate per table — the closest thing to "database size" this
// app surfaces, since Convex doesn't expose byte-level table sizes. Small
// tables are exact; gpsFixes/accelSamples are capped estimates (see above).
export const estimate = action({
  args: {},
  handler: async (ctx): Promise<Record<string, { count: number; approximate: boolean }>> => {
    const [gpsFixes, accelSamples, recordings, gpsFiles, journeys, events] = await Promise.all([
      boundedCount(ctx, "gpsFixes"),
      boundedCount(ctx, "accelSamples"),
      ctx.runQuery(api.recordings.list, { limit: COUNT_CAP }).then((r) => ({
        count: r.length,
        approximate: r.length >= COUNT_CAP,
      })),
      ctx.runQuery(api.gpsFiles.listAll, { limit: COUNT_CAP }).then((r) => ({
        count: r.length,
        approximate: r.length >= COUNT_CAP,
      })),
      ctx.runQuery(api.journeys.list, { limit: COUNT_CAP }).then((r) => ({
        count: r.length,
        approximate: r.length >= COUNT_CAP,
      })),
      ctx.runQuery(api.events.list, { limit: COUNT_CAP }).then((r) => ({
        count: r.length,
        approximate: r.length >= COUNT_CAP,
      })),
    ]);

    return { gpsFixes, accelSamples, recordings, gpsFiles, journeys, events };
  },
});
