import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { requireAdmin } from "./lib/authz";

export const list = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("cameras").collect();
  },
});

export const get = query({
  args: { id: v.id("cameras") },
  handler: async (ctx, { id }) => {
    return await ctx.db.get(id);
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
