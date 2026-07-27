import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

export const get = query({
  args: { cameraId: v.id("cameras") },
  handler: async (ctx, { cameraId }) => {
    return await ctx.db
      .query("cameraStatus")
      .withIndex("by_cameraId", (q) => q.eq("cameraId", cameraId))
      .unique();
  },
});

// All cameras' current status, for the Dashboard's per-camera connection list.
export const listAll = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("cameraStatus").collect();
  },
});

export const report = mutation({
  args: {
    cameraId: v.id("cameras"),
    connected: v.boolean(),
    lastError: v.optional(v.string()),
  },
  handler: async (ctx, { cameraId, connected, lastError }) => {
    const existing = await ctx.db
      .query("cameraStatus")
      .withIndex("by_cameraId", (q) => q.eq("cameraId", cameraId))
      .unique();

    const now = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, {
        connected,
        lastPollAt: now,
        lastSeenAt: connected ? now : existing.lastSeenAt,
        lastError,
      });
    } else {
      await ctx.db.insert("cameraStatus", {
        cameraId,
        connected,
        lastPollAt: now,
        lastSeenAt: connected ? now : undefined,
        lastError,
      });
    }
  },
});
