import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

// Breadcrumb trail bookkeeping: append a point at most every 5s of sample
// time, keep ~1 hour of driving. At 720 points × ~4 numbers the row stays a
// few tens of KB — well inside Convex's document limit, and small enough
// that the web page's reactive subscription isn't shipping megabytes at 1Hz.
const TRAIL_INTERVAL_MS = 5_000;
const TRAIL_MAX_POINTS = 720;

export const report = mutation({
  args: {
    cameraId: v.id("cameras"),
    timestamp: v.number(),
    lat: v.number(),
    lng: v.number(),
    speedKmh: v.optional(v.number()),
    headingDeg: v.optional(v.number()),
    accelX: v.optional(v.number()),
    accelY: v.optional(v.number()),
    accelZ: v.optional(v.number()),
    gForce: v.optional(v.number()),
    peakG: v.optional(v.number()),
  },
  handler: async (ctx, { cameraId, ...sample }) => {
    const existing = await ctx.db
      .query("liveTelemetry")
      .withIndex("by_cameraId", (q) => q.eq("cameraId", cameraId))
      .unique();

    const now = Date.now();

    if (!existing) {
      await ctx.db.insert("liveTelemetry", {
        cameraId,
        ...sample,
        updatedAt: now,
        trail: [{ timestamp: sample.timestamp, lat: sample.lat, lng: sample.lng, speedKmh: sample.speedKmh }],
      });
      return;
    }

    // MQTT is at-least-once and the ingest coalesces latest-wins, but a
    // reconnect can still replay an older sample after a newer one — never
    // let the marker jump backwards.
    if (sample.timestamp < existing.timestamp) return;

    let trail = existing.trail;
    const lastTrail = trail[trail.length - 1];
    // A gap much larger than the trail interval means a new drive (or the
    // phone was off) — start the breadcrumb fresh rather than drawing a
    // straight line across town from where the last session ended.
    const NEW_SESSION_GAP_MS = 10 * 60_000;
    if (!lastTrail || sample.timestamp - lastTrail.timestamp >= NEW_SESSION_GAP_MS) {
      trail = [{ timestamp: sample.timestamp, lat: sample.lat, lng: sample.lng, speedKmh: sample.speedKmh }];
    } else if (sample.timestamp - lastTrail.timestamp >= TRAIL_INTERVAL_MS) {
      trail = [...trail, { timestamp: sample.timestamp, lat: sample.lat, lng: sample.lng, speedKmh: sample.speedKmh }];
      if (trail.length > TRAIL_MAX_POINTS) trail = trail.slice(trail.length - TRAIL_MAX_POINTS);
    }

    await ctx.db.patch(existing._id, {
      ...sample,
      updatedAt: now,
      trail,
    });
  },
});

// Every camera's latest live row, for the web Live page (it joins camera
// names client-side from cameras.list, same pattern as cameraStatus.listAll).
export const listAll = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("liveTelemetry").collect();
  },
});

export const forCamera = query({
  args: { cameraId: v.id("cameras") },
  handler: async (ctx, { cameraId }) => {
    return await ctx.db
      .query("liveTelemetry")
      .withIndex("by_cameraId", (q) => q.eq("cameraId", cameraId))
      .unique();
  },
});
