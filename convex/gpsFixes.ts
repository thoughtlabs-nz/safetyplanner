import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

// Combined recent fixes across all GPS files, for the Journeys map — the
// camera's GPS files each only cover ~1 minute, so a single-file view is too
// fragmented to be useful; this stitches them into one continuous route.
export const recent = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    const fixes = await ctx.db
      .query("gpsFixes")
      .withIndex("by_timestamp")
      .order("desc")
      .take(limit ?? 3000);
    return fixes.sort((a, b) => a.timestamp - b.timestamp);
  },
});

export const forGpsFile = query({
  args: { gpsFileId: v.id("gpsFiles") },
  handler: async (ctx, { gpsFileId }) => {
    return await ctx.db
      .query("gpsFixes")
      .withIndex("by_gpsFileId", (q) => q.eq("gpsFileId", gpsFileId))
      .collect();
  },
});

export const forRecording = query({
  args: { recordingId: v.id("recordings") },
  handler: async (ctx, { recordingId }) => {
    return await ctx.db
      .query("gpsFixes")
      .withIndex("by_recordingId", (q) => q.eq("recordingId", recordingId))
      .collect();
  },
});

// Fetches fixes for a single derived trip (see convex/journeys.ts) by its
// start/end timestamp range, for rendering that trip's route on the map.
export const forTimeRange = query({
  args: { startTime: v.number(), endTime: v.number() },
  handler: async (ctx, { startTime, endTime }) => {
    return await ctx.db
      .query("gpsFixes")
      .withIndex("by_timestamp", (q) => q.gte("timestamp", startTime).lte("timestamp", endTime))
      .collect();
  },
});

export const deleteForGpsFile = mutation({
  args: { gpsFileId: v.id("gpsFiles") },
  handler: async (ctx, { gpsFileId }) => {
    const fixes = await ctx.db
      .query("gpsFixes")
      .withIndex("by_gpsFileId", (q) => q.eq("gpsFileId", gpsFileId))
      .collect();
    for (const fix of fixes) {
      await ctx.db.delete(fix._id);
    }
  },
});

export const insertBatch = mutation({
  args: {
    gpsFileId: v.id("gpsFiles"),
    recordingId: v.optional(v.id("recordings")),
    cameraId: v.optional(v.id("cameras")),
    fixes: v.array(
      v.object({
        timestamp: v.number(),
        lat: v.number(),
        lng: v.number(),
        speedKmh: v.optional(v.number()),
        headingDeg: v.optional(v.number()),
      }),
    ),
  },
  handler: async (ctx, { gpsFileId, recordingId, cameraId, fixes }) => {
    for (const fix of fixes) {
      await ctx.db.insert("gpsFixes", { gpsFileId, recordingId, cameraId, ...fix });
    }
  },
});
