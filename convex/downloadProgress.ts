import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

export const active = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db
      .query("downloadProgress")
      .filter((q) => q.eq(q.field("status"), "downloading"))
      .collect();
  },
});

export const recent = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    const all = await ctx.db.query("downloadProgress").collect();
    return all.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit ?? 20);
  },
});

// Called once when the poller starts up. Any row still marked "downloading"
// belongs to a process that was killed/crashed mid-transfer — nothing will
// ever mark it done, so it would otherwise show as a permanent ghost entry
// on the Recordings screen.
export const resetStale = mutation({
  args: {},
  handler: async (ctx) => {
    const stale = await ctx.db
      .query("downloadProgress")
      .filter((q) => q.eq(q.field("status"), "downloading"))
      .collect();
    for (const row of stale) {
      await ctx.db.patch(row._id, {
        status: "failed",
        error: "interrupted by poller restart",
        updatedAt: Date.now(),
      });
    }
    return stale.length;
  },
});

export const report = mutation({
  args: {
    filename: v.string(),
    bytesReceived: v.number(),
    totalBytes: v.optional(v.number()),
    bytesPerSecond: v.optional(v.number()),
    status: v.union(
      v.literal("downloading"),
      v.literal("completed"),
      v.literal("failed"),
    ),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("downloadProgress")
      .withIndex("by_filename", (q) => q.eq("filename", args.filename))
      .unique();

    const patch = { ...args, updatedAt: Date.now() };
    if (existing) {
      await ctx.db.patch(existing._id, patch);
    } else {
      await ctx.db.insert("downloadProgress", patch);
    }
  },
});
