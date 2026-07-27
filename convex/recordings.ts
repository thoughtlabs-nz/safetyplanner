import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

export const list = query({
  args: {
    kind: v.optional(
      v.union(v.literal("continuous"), v.literal("timelapse"), v.literal("event")),
    ),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { kind, limit }) => {
    const q = kind
      ? ctx.db.query("recordings").withIndex("by_kind", (i) => i.eq("kind", kind))
      : ctx.db.query("recordings").withIndex("by_startTime");
    const rows = await q.order("desc").take(limit ?? 100);
    return await Promise.all(
      rows.map(async (r) => ({
        ...r,
        thumbnailUrl: r.thumbnailStorageId
          ? ((await ctx.storage.getUrl(r.thumbnailStorageId)) ?? undefined)
          : undefined,
      })),
    );
  },
});

export const getByFilename = query({
  args: { cameraId: v.id("cameras"), filename: v.string() },
  handler: async (ctx, { cameraId, filename }) => {
    return await ctx.db
      .query("recordings")
      .withIndex("by_camera_filename", (q) => q.eq("cameraId", cameraId).eq("filename", filename))
      .unique();
  },
});

// Recordings have no direct link to a journey (see journeys.ts) — this finds
// the ones that overlap a journey's time range for a given camera by
// scanning a padded startTime window and filtering for actual overlap in
// code, since there's no durationSeconds index to query by end time.
const MAX_RECORDING_DURATION_SECONDS = 60 * 60; // generous upper bound for one clip

export const forCameraTimeRange = query({
  args: { cameraId: v.id("cameras"), startTime: v.number(), endTime: v.number() },
  handler: async (ctx, { cameraId, startTime, endTime }) => {
    const padMs = MAX_RECORDING_DURATION_SECONDS * 1000;
    const candidates = await ctx.db
      .query("recordings")
      .withIndex("by_startTime", (q) =>
        q.gte("startTime", startTime - padMs).lte("startTime", endTime),
      )
      .collect();
    return candidates.filter((r) => {
      if (r.cameraId !== cameraId) return false;
      const recordingEnd = r.startTime + (r.durationSeconds ?? 0) * 1000;
      return recordingEnd >= startTime && r.startTime <= endTime;
    });
  },
});

// Deletes a recording row and tombstones its filename so the poller's next
// listing (the camera has no delete API) doesn't reimport it. Called from
// journeys.deleteRange once the recording's events/gpsFiles are already gone.
export const _removeAndTombstone = mutation({
  args: { id: v.id("recordings"), cameraId: v.id("cameras"), filename: v.string() },
  handler: async (ctx, { id, cameraId, filename }) => {
    await ctx.db.delete(id);
    const existing = await ctx.db
      .query("deletedFiles")
      .withIndex("by_camera_filename", (q) => q.eq("cameraId", cameraId).eq("filename", filename))
      .unique();
    if (!existing) await ctx.db.insert("deletedFiles", { cameraId, filename });
  },
});

export const listQueued = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db
      .query("recordings")
      .withIndex("by_status", (q) => q.eq("status", "queued"))
      .collect();
  },
});

// Called by the poller when it lists recordings from the camera. Only
// records metadata — no file is downloaded yet. Returns the id whether
// newly inserted or already present.
export const upsertMetadata = mutation({
  args: {
    cameraId: v.id("cameras"),
    kind: v.union(v.literal("continuous"), v.literal("timelapse"), v.literal("event")),
    filename: v.string(),
    startTime: v.number(),
    durationSeconds: v.optional(v.number()),
    sizeBytes: v.optional(v.number()),
    channel: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("recordings")
      .withIndex("by_camera_filename", (q) =>
        q.eq("cameraId", args.cameraId).eq("filename", args.filename),
      )
      .unique();
    if (existing) return existing._id;

    return await ctx.db.insert("recordings", { ...args, status: "listed" });
  },
});

// User-triggered from the Recordings screen. Only queues if the recording
// isn't already downloaded/in flight.
export const requestDownload = mutation({
  args: { id: v.id("recordings") },
  handler: async (ctx, { id }) => {
    const recording = await ctx.db.get(id);
    if (!recording) throw new Error("recording not found");
    if (recording.status === "listed" || recording.status === "failed") {
      await ctx.db.patch(id, { status: "queued", error: undefined });
    }
  },
});

export const markDownloading = mutation({
  args: { id: v.id("recordings") },
  handler: async (ctx, { id }) => {
    await ctx.db.patch(id, { status: "downloading" });
  },
});

export const markDownloaded = mutation({
  args: { id: v.id("recordings"), filePath: v.string() },
  handler: async (ctx, { id, filePath }) => {
    await ctx.db.patch(id, {
      status: "downloaded",
      filePath,
      downloadedAt: Date.now(),
    });
  },
});

// Events get their (small) thumbnail auto-downloaded at listing time,
// independent of the main video's on-demand download lifecycle.
export const setThumbnail = mutation({
  args: { id: v.id("recordings"), thumbnailPath: v.string() },
  handler: async (ctx, { id, thumbnailPath }) => {
    await ctx.db.patch(id, { thumbnailPath });
  },
});

// Convex-file-storage flow: mqtt-ingest asks for an upload URL, POSTs the
// JPEG bytes to it, then records the returned storage id here. Replaces the
// local-disk + poller-served thumbnailPath model (kept above for legacy
// rows) so thumbnails are served from Convex's CDN with no poller process
// or tunnel in the path.
export const generateThumbnailUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    return await ctx.storage.generateUploadUrl();
  },
});

export const setThumbnailStorage = mutation({
  args: { id: v.id("recordings"), storageId: v.id("_storage") },
  handler: async (ctx, { id, storageId }) => {
    await ctx.db.patch(id, { thumbnailStorageId: storageId });
  },
});

export const markFailed = mutation({
  args: { id: v.id("recordings"), error: v.string() },
  handler: async (ctx, { id, error }) => {
    await ctx.db.patch(id, { status: "failed", error });
  },
});
