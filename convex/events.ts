import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

export const list = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    return await ctx.db
      .query("events")
      .withIndex("by_timestamp")
      .order("desc")
      .take(limit ?? 100);
  },
});

// For the Dashboard's Recent Events / timeline views — joins each event with
// its recording's thumbnail so the UI doesn't need filename/download details.
export const recentWithThumbnails = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    const events = await ctx.db
      .query("events")
      .withIndex("by_timestamp")
      .order("desc")
      .take(limit ?? 10);

    return await Promise.all(
      events.map(async (e) => {
        const recording = await ctx.db.get(e.recordingId);
        return {
          _id: e._id,
          type: e.type,
          severity: e.severity,
          timestamp: e.timestamp,
          thumbnailPath: recording?.thumbnailPath,
          thumbnailUrl: recording?.thumbnailStorageId
            ? ((await ctx.storage.getUrl(recording.thumbnailStorageId)) ?? undefined)
            : undefined,
        };
      }),
    );
  },
});

// Events within a trip's time range, joined with thumbnail — used by the
// Journeys page's per-trip timeline.
export const forTimeRangeWithThumbnails = query({
  args: { startTime: v.number(), endTime: v.number() },
  handler: async (ctx, { startTime, endTime }) => {
    const events = await ctx.db
      .query("events")
      .withIndex("by_timestamp", (q) => q.gte("timestamp", startTime).lte("timestamp", endTime))
      .collect();

    return await Promise.all(
      events.map(async (e) => {
        const recording = await ctx.db.get(e.recordingId);
        return {
          _id: e._id,
          type: e.type,
          severity: e.severity,
          timestamp: e.timestamp,
          lat: e.lat,
          lng: e.lng,
          thumbnailPath: recording?.thumbnailPath,
          thumbnailUrl: recording?.thumbnailStorageId
            ? ((await ctx.storage.getUrl(recording.thumbnailStorageId)) ?? undefined)
            : undefined,
        };
      }),
    );
  },
});

export const forRecording = query({
  args: { recordingId: v.id("recordings") },
  handler: async (ctx, { recordingId }) => {
    return await ctx.db
      .query("events")
      .withIndex("by_recordingId", (q) => q.eq("recordingId", recordingId))
      .collect();
  },
});

export const remove = mutation({
  args: { id: v.id("events") },
  handler: async (ctx, { id }) => {
    await ctx.db.delete(id);
  },
});

export const create = mutation({
  args: {
    recordingId: v.id("recordings"),
    type: v.union(
      v.literal("impact"),
      v.literal("parking"),
      v.literal("manual"),
      v.literal("other"),
    ),
    severity: v.optional(v.string()),
    timestamp: v.number(),
    lat: v.optional(v.number()),
    lng: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("events", args);
  },
});
