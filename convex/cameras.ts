import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { requireAdmin } from "./lib/authz";
import type { Doc } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";

// Resolves a camera's uploaded avatar photo to a fetchable URL — absent
// one, every UI surface (web + iOS) falls back to a colored car icon whose
// color is derived deterministically from the camera's _id (see
// apps/web/src/cameraAvatar.ts and the iOS CameraAvatar.swift), so there's
// no separate color field to keep in sync here.
async function withAvatarUrl(ctx: QueryCtx, camera: Doc<"cameras">) {
  return {
    ...camera,
    avatarUrl: camera.avatarStorageId
      ? ((await ctx.storage.getUrl(camera.avatarStorageId)) ?? undefined)
      : undefined,
  };
}

export const list = query({
  args: {},
  handler: async (ctx) => {
    const cameras = await ctx.db.query("cameras").collect();
    return await Promise.all(cameras.map((c) => withAvatarUrl(ctx, c)));
  },
});

export const get = query({
  args: { id: v.id("cameras") },
  handler: async (ctx, { id }) => {
    const camera = await ctx.db.get(id);
    return camera ? await withAvatarUrl(ctx, camera) : null;
  },
});

// Looked up by the poller's /session/start handler — the Wi-Fi watcher
// script only knows the SSID it just joined, not any Convex-internal ID.
export const getBySsid = query({
  args: { ssid: v.string() },
  handler: async (ctx, { ssid }) => {
    return await ctx.db
      .query("cameras")
      .withIndex("by_ssid", (q) => q.eq("ssid", ssid))
      .unique();
  },
});

// Identity fields only (ssid/name/camUrl) — Wi-Fi/MQTT connection config is
// set separately via devices.updateDeviceConfig (called right after this on
// the Settings page's Add-camera flow, using the id this returns) so both
// mutations keep validating exactly the fields they own rather than
// duplicating devices.ts's optional-field list here.
export const create = mutation({
  args: {
    ssid: v.string(),
    name: v.string(),
    camUrl: v.string(),
  },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    return await ctx.db.insert("cameras", args);
  },
});

export const update = mutation({
  args: {
    id: v.id("cameras"),
    ssid: v.string(),
    name: v.string(),
    camUrl: v.string(),
  },
  handler: async (ctx, { id, ...args }) => {
    await requireAdmin(ctx);
    await ctx.db.patch(id, args);
  },
});

export const remove = mutation({
  args: { id: v.id("cameras") },
  handler: async (ctx, { id }) => {
    await requireAdmin(ctx);
    await ctx.db.delete(id);
  },
});

// Convex-file-storage flow, same shape as recordings.ts's thumbnail upload:
// the Settings page asks for an upload URL, POSTs the image bytes to it,
// then hands the returned storage id to setAvatar.
export const generateAvatarUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    return await ctx.storage.generateUploadUrl();
  },
});

export const setAvatar = mutation({
  args: { id: v.id("cameras"), storageId: v.id("_storage") },
  handler: async (ctx, { id, storageId }) => {
    await requireAdmin(ctx);
    const camera = await ctx.db.get(id);
    // Replacing an existing photo — drop the old blob rather than orphaning
    // it in storage.
    if (camera?.avatarStorageId) await ctx.storage.delete(camera.avatarStorageId);
    await ctx.db.patch(id, { avatarStorageId: storageId });
  },
});

export const removeAvatar = mutation({
  args: { id: v.id("cameras") },
  handler: async (ctx, { id }) => {
    await requireAdmin(ctx);
    const camera = await ctx.db.get(id);
    if (camera?.avatarStorageId) await ctx.storage.delete(camera.avatarStorageId);
    await ctx.db.patch(id, { avatarStorageId: undefined });
  },
});
