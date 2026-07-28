import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { obdSampleValidator } from "./lib/obdTelemetry";

// Recorded OBD readings from the phone's BLE dongle. Volume is modest
// compared to accelSamples — one sample every few seconds rather than 15Hz —
// so these queries don't need the same paginate-everything discipline, but
// they follow it anyway for the range query, which spans a whole trip.

// One trip's worth of readings, for the battery-over-time chart on the
// Journeys page. Scoped to the camera because a journey belongs to one
// vehicle (see the by_camera_timestamp index).
//
// A single .collect() is safe at this volume where it wouldn't be for
// accelSamples: OBD is recorded once every few seconds, so an hour of
// driving is ~720 rows against Convex's 4096-document read limit. The take()
// cap is what keeps that true for an implausibly long trip rather than
// failing the whole query — LIMIT is ~7 hours of continuous driving.
const TRIP_SAMPLE_LIMIT = 4000;

export const forTimeRange = query({
  args: { cameraId: v.id("cameras"), startTime: v.number(), endTime: v.number() },
  handler: async (ctx, { cameraId, startTime, endTime }) => {
    return await ctx.db
      .query("obdSamples")
      .withIndex("by_camera_timestamp", (q) =>
        q.eq("cameraId", cameraId).gte("timestamp", startTime).lte("timestamp", endTime),
      )
      .take(TRIP_SAMPLE_LIMIT);
  },
});

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
