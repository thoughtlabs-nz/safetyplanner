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
//
// Pass cameraId whenever the trip has one: a journey belongs to one vehicle,
// and a bare time range would splice another camera's fixes into this trip's
// polyline the moment two vehicles are driven at once. Optional because
// journeys built before multi-camera support have no camera to scope by, and
// because journeys.deleteRange filters the results itself.
export const forTimeRange = query({
  args: {
    cameraId: v.optional(v.id("cameras")),
    startTime: v.number(),
    endTime: v.number(),
  },
  handler: async (ctx, { cameraId, startTime, endTime }) => {
    if (cameraId) {
      return await ctx.db
        .query("gpsFixes")
        .withIndex("by_camera_timestamp", (q) =>
          q.eq("cameraId", cameraId).gte("timestamp", startTime).lte("timestamp", endTime),
        )
        .collect();
    }
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

// Fixes strictly older than `timestamp`, newest-first. Used by
// journeys.rebuild to walk backwards from its fixed-size window until it
// finds a gap big enough to be a trip boundary — without this the window's
// oldest trip is whatever fragment the 5000-fix cutoff happened to slice
// through, and that fragment would collide with the full journey backfill
// already built for the same drive.
export const before = query({
  args: { timestamp: v.number(), limit: v.number() },
  handler: async (ctx, { timestamp, limit }) => {
    const fixes = await ctx.db
      .query("gpsFixes")
      .withIndex("by_timestamp", (q) => q.lt("timestamp", timestamp))
      .order("desc")
      .take(limit);
    return fixes.sort((a, b) => a.timestamp - b.timestamp);
  },
});

// One page of fixes at/after `startTime` (optionally stopping before
// `endTime`), oldest-first — the forward scan journeys.backfill walks to
// rebuild trips that fell off the back of rebuild's recent-fix window.
export const pageFrom = query({
  args: {
    startTime: v.number(),
    endTime: v.optional(v.number()),
    cursor: v.union(v.string(), v.null()),
    numItems: v.number(),
  },
  handler: async (ctx, { startTime, endTime, cursor, numItems }) => {
    return await ctx.db
      .query("gpsFixes")
      .withIndex("by_timestamp", (q) =>
        endTime === undefined
          ? q.gte("timestamp", startTime)
          : q.gte("timestamp", startTime).lt("timestamp", endTime),
      )
      .paginate({ numItems, cursor });
  },
});
