import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { obdSampleValidator } from "./lib/obdTelemetry";

// Recorded OBD readings from the phone's BLE dongle. Volume is modest
// compared to accelSamples — one sample every few seconds rather than 15Hz —
// so these queries don't need the same paginate-everything discipline, but
// they follow it anyway for the range query, which spans a whole trip.

export const pageForTimeRange = query({
  args: { startTime: v.number(), endTime: v.number(), paginationOpts: paginationOptsValidator },
  handler: async (ctx, { startTime, endTime, paginationOpts }) => {
    return await ctx.db
      .query("obdSamples")
      .withIndex("by_timestamp", (q) => q.gte("timestamp", startTime).lte("timestamp", endTime))
      .paginate(paginationOpts);
  },
});

/// Has this phone-side chunk already been ingested? MQTT is at-least-once
/// and the Outbox republishes anything the broker didn't ack, so the same
/// batch can legitimately arrive more than once — checked before inserting
/// rather than deduping per sample, since a batch is all-or-nothing.
export const hasBatch = query({
  args: { cameraId: v.id("cameras"), batchId: v.string() },
  handler: async (ctx, { cameraId, batchId }) => {
    const existing = await ctx.db
      .query("obdSamples")
      .withIndex("by_camera_batch", (q) => q.eq("cameraId", cameraId).eq("batchId", batchId))
      .first();
    return existing !== null;
  },
});

export const insertBatch = mutation({
  args: {
    cameraId: v.id("cameras"),
    // Set only when this batch rode along with a camera GPS file sync; an
    // OBD-only batch (the normal case) has neither, since a live-tracking
    // session isn't tied to any particular recording.
    gpsFileId: v.optional(v.id("gpsFiles")),
    recordingId: v.optional(v.id("recordings")),
    batchId: v.string(),
    samples: v.array(obdSampleValidator),
  },
  handler: async (ctx, { cameraId, gpsFileId, recordingId, batchId, samples }) => {
    for (const sample of samples) {
      await ctx.db.insert("obdSamples", { cameraId, gpsFileId, recordingId, batchId, ...sample });
    }
    return samples.length;
  },
});
