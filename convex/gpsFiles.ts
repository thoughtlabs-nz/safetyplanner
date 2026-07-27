import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

// Most recently downloaded GPS files that were successfully parsed into
// gpsFixes, used by the Journeys screen to pick a recording to display.
export const recentParsed = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    const all = await ctx.db
      .query("gpsFiles")
      .filter((q) => q.eq(q.field("parsed"), true))
      .collect();
    return all.sort((a, b) => b.downloadedAt - a.downloadedAt).slice(0, limit ?? 20);
  },
});

// All downloaded GPS files, regardless of whether a matching recording was
// found — the camera's parentfile linkage isn't reliable, so most GPS files
// end up unlinked. This is the primary listing for browsing raw downloads.
export const listAll = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    const all = await ctx.db.query("gpsFiles").collect();
    return all.sort((a, b) => b.downloadedAt - a.downloadedAt).slice(0, limit ?? 100);
  },
});

export const listForRecording = query({
  args: { recordingId: v.id("recordings") },
  handler: async (ctx, { recordingId }) => {
    return await ctx.db
      .query("gpsFiles")
      .withIndex("by_recordingId", (q) => q.eq("recordingId", recordingId))
      .collect();
  },
});

export const getByFilename = query({
  args: { cameraId: v.id("cameras"), filename: v.string() },
  handler: async (ctx, { cameraId, filename }) => {
    return await ctx.db
      .query("gpsFiles")
      .withIndex("by_camera_filename", (q) => q.eq("cameraId", cameraId).eq("filename", filename))
      .unique();
  },
});

export const get = query({
  args: { id: v.id("gpsFiles") },
  handler: async (ctx, { id }) => {
    return await ctx.db.get(id);
  },
});

// Deletes a gpsFile row and tombstones its filename so the poller's next
// listing (the camera has no delete API) doesn't reimport it. Called from
// journeys.deleteRange once the file's fixes/accelSamples are already gone.
export const _removeAndTombstone = mutation({
  args: { id: v.id("gpsFiles"), cameraId: v.optional(v.id("cameras")), filename: v.string() },
  handler: async (ctx, { id, cameraId, filename }) => {
    await ctx.db.delete(id);
    if (cameraId) {
      const existing = await ctx.db
        .query("deletedFiles")
        .withIndex("by_camera_filename", (q) => q.eq("cameraId", cameraId).eq("filename", filename))
        .unique();
      if (!existing) await ctx.db.insert("deletedFiles", { cameraId, filename });
    }
  },
});

export const upsert = mutation({
  args: {
    cameraId: v.id("cameras"),
    recordingId: v.optional(v.id("recordings")),
    filename: v.string(),
    // Optional — messages carrying already-parsed fixes/accel samples
    // (see mqtt-ingest's handleGpsData) never download or store a raw
    // file, so there's nothing to point filePath at.
    filePath: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("gpsFiles")
      .withIndex("by_camera_filename", (q) =>
        q.eq("cameraId", args.cameraId).eq("filename", args.filename),
      )
      .unique();
    if (existing) return existing._id;

    return await ctx.db.insert("gpsFiles", {
      ...args,
      parsed: false,
      downloadedAt: Date.now(),
    });
  },
});

export const markParsed = mutation({
  args: { id: v.id("gpsFiles") },
  handler: async (ctx, { id }) => {
    await ctx.db.patch(id, { parsed: true });
  },
});

// Called once the poller has deleted the raw file from disk (after
// successfully extracting fixes/accelSamples) — clears the now-dangling
// filePath so the UI stops offering a download link for a file that no
// longer exists.
export const clearFilePath = mutation({
  args: { id: v.id("gpsFiles") },
  handler: async (ctx, { id }) => {
    await ctx.db.patch(id, { filePath: undefined });
  },
});

// One-off migration helper: rolls up peakG from already-inserted
// accelSamples for files whose samples were written before peakG existed.
export const setPeakG = mutation({
  args: { id: v.id("gpsFiles"), peakG: v.number() },
  handler: async (ctx, { id, peakG }) => {
    await ctx.db.patch(id, { peakG });
  },
});
