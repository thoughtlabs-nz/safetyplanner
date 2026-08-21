import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";

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
// its recording's thumbnail, filtered to a rolling time window (day/week/
// month, chosen in the UI) rather than a flat "last N" so the timeline
// doesn't get skewed by whatever old event happens to fall in an unbounded
// "most recent" page. `limit` is a safety cap, not the primary control — a
// busy month-long window could otherwise blow past Convex's per-query read
// limit.
export const recentInRangeWithThumbnails = query({
  args: { startTime: v.number(), limit: v.optional(v.number()) },
  handler: async (ctx, { startTime, limit }) => {
    const events = await ctx.db
      .query("events")
      .withIndex("by_timestamp", (q) => q.gte("timestamp", startTime))
      .order("desc")
      .take(limit ?? 200);

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

// How far outside a trip's own time range an event may sit and still be
// counted as belonging to that trip.
//
// Two real cases need this. The camera records an event the instant it
// powers up, but its GPS needs a few minutes to lock — so the event lands
// before the first fix, and therefore before the journey those fixes
// produced (seen on 2026-07-25: event at 06:13:14, first fix at 06:17:16).
// And an impact recorded just after you park belongs to the drive that
// finished, not to nothing at all.
const TRIP_EVENT_TOLERANCE_MS = 15 * 60 * 1000;

// Upper bound assumed for how long a single trip can run, used only to keep
// the rival-journey lookup below to a bounded index range.
const MAX_JOURNEY_SPAN_MS = 24 * 60 * 60 * 1000;

// Events within a trip's time range, joined with thumbnail — used by the
// Journeys page's per-trip timeline.
//
// Pass cameraId whenever the trip has one. A journey belongs to one vehicle,
// so matching on time alone shows another camera's events on this trip the
// moment two vehicles are driven at once. It stays optional because journeys
// built before multi-camera support have no camera to scope by, and a
// time-only match is still better than showing nothing for those.
//
// Events just outside the range are included too, but only when this trip is
// genuinely their closest — otherwise every event in a gap between two drives
// would be claimed by both of them.
export const forTimeRangeWithThumbnails = query({
  args: {
    cameraId: v.optional(v.id("cameras")),
    startTime: v.number(),
    endTime: v.number(),
    toleranceMs: v.optional(v.number()),
  },
  handler: async (ctx, { cameraId, startTime, endTime, toleranceMs }) => {
    const tolerance = toleranceMs ?? TRIP_EVENT_TOLERANCE_MS;
    const from = startTime - tolerance;
    const to = endTime + tolerance;

    const candidates = cameraId
      ? await ctx.db
          .query("events")
          .withIndex("by_camera_timestamp", (q) =>
            q.eq("cameraId", cameraId).gte("timestamp", from).lte("timestamp", to),
          )
          .collect()
      : await ctx.db
          .query("events")
          .withIndex("by_timestamp", (q) => q.gte("timestamp", from).lte("timestamp", to))
          .collect();

    // Only needed to adjudicate the events that fall outside this trip's own
    // range, so it is skipped entirely when there are none.
    const outside = candidates.filter((e) => e.timestamp < startTime || e.timestamp > endTime);
    let rivals: Doc<"journeys">[] = [];
    if (outside.length > 0) {
      // Bounded on both sides rather than "every journey after `from`",
      // which would grow with the whole history. A rival has to overlap the
      // padded window to be nearer to one of these events, and a journey
      // starting more than a day before it would have to run longer than a
      // day to reach it. Should one somehow exist, missing it only leaves the
      // event with this trip — a soft loss, not a wrong answer.
      rivals = (
        await ctx.db
          .query("journeys")
          .withIndex("by_startTime", (q) =>
            q.gte("startTime", from - MAX_JOURNEY_SPAN_MS).lte("startTime", to),
          )
          .collect()
      ).filter((j) => j.endTime >= from && j.cameraId === cameraId && j.startTime !== startTime);
    }

    const gapTo = (j: { startTime: number; endTime: number }, t: number) =>
      t < j.startTime ? j.startTime - t : t > j.endTime ? t - j.endTime : 0;

    const events = candidates.filter((e) => {
      if (e.timestamp >= startTime && e.timestamp <= endTime) return true;
      const mine = gapTo({ startTime, endTime }, e.timestamp);
      // A rival that is strictly closer wins it; ties stay here, since an
      // equidistant event is as much this trip's as the other's and dropping
      // it from both would lose it entirely.
      return !rivals.some((j) => gapTo(j, e.timestamp) < mine);
    });

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
          // True when the event sits outside the trip's own time range and
          // was attached by tolerance — the UI can mark it as adjacent to
          // the drive rather than during it.
          adjacent: e.timestamp < startTime || e.timestamp > endTime,
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
    cameraId: v.optional(v.id("cameras")),
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

// One-off: fills cameraId on events created before the field existed, by
// reading it off each event's recording. Idempotent — rows that already have
// a camera are left alone, so it is safe to re-run.
export const backfillCameraId = mutation({
  args: {},
  handler: async (ctx): Promise<{ patched: number; alreadySet: number; noRecording: number }> => {
    const events = await ctx.db.query("events").collect();
    let patched = 0;
    let alreadySet = 0;
    let noRecording = 0;
    for (const event of events) {
      if (event.cameraId !== undefined) {
        alreadySet += 1;
        continue;
      }
      const recording = await ctx.db.get(event.recordingId);
      // Leaving it unset is the honest outcome: without a recording there is
      // nothing to infer the camera from, and guessing would be worse than
      // the time-only fallback the trip query already has.
      if (!recording?.cameraId) {
        noRecording += 1;
        continue;
      }
      await ctx.db.patch(event._id, { cameraId: recording.cameraId });
      patched += 1;
    }
    return { patched, alreadySet, noRecording };
  },
});
