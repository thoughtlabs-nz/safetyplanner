import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

const MAX_EVENTS = 500;

export const recent = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    return await ctx.db
      .query("pollEvents")
      .withIndex("by_timestamp")
      .order("desc")
      .take(limit ?? 50);
  },
});

export const log = mutation({
  args: {
    level: v.union(v.literal("info"), v.literal("warn"), v.literal("error")),
    message: v.string(),
    meta: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("pollEvents", { ...args, timestamp: Date.now() });

    // Trim oldest entries so this table doesn't grow unbounded.
    const all = await ctx.db.query("pollEvents").withIndex("by_timestamp").order("asc").collect();
    if (all.length > MAX_EVENTS) {
      for (const row of all.slice(0, all.length - MAX_EVENTS)) {
        await ctx.db.delete(row._id);
      }
    }
  },
});
