import { query } from "./_generated/server";
import { v } from "convex/values";

export const isDeleted = query({
  args: { cameraId: v.id("cameras"), filename: v.string() },
  handler: async (ctx, { cameraId, filename }) => {
    const tombstone = await ctx.db
      .query("deletedFiles")
      .withIndex("by_camera_filename", (q) => q.eq("cameraId", cameraId).eq("filename", filename))
      .unique();
    return tombstone !== null;
  },
});
