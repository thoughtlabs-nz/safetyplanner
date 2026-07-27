import { action, mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { requireAdmin, requireIdentity } from "./lib/authz";
import type { Doc } from "./_generated/dataModel";

function toDeviceConfig(camera: Doc<"cameras">) {
  return {
    cameraId: camera._id,
    name: camera.name,
    ssid: camera.ssid,
    camUrl: camera.camUrl,
    wifiPassword: camera.wifiPassword ?? "",
    mqttHost: camera.mqttHost ?? "",
    mqttPort: camera.mqttPort ?? 8883,
    mqttUseTLS: camera.mqttUseTLS ?? true,
    mqttUsername: camera.mqttUsername ?? "",
    mqttPassword: camera.mqttPassword ?? "",
    topicPrefix: camera.topicPrefix ?? "ddpai",
  };
}

// The set of devices the signed-in user has been granted access to — what
// both the web "my devices" view and the iOS /api/device-config endpoint
// return.
export const myDevices = query({
  args: {},
  handler: async (ctx) => {
    const identity = await requireIdentity(ctx);
    const grants = await ctx.db
      .query("userDeviceAccess")
      .withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", identity.subject))
      .collect();
    const cameras = await Promise.all(grants.map((g) => ctx.db.get(g.cameraId)));
    return cameras.filter((c): c is Doc<"cameras"> => c !== null).map(toDeviceConfig);
  },
});

// Admin view: every camera plus who currently has access to it.
export const listAllDevices = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const cameras = await ctx.db.query("cameras").collect();
    const allGrants = await ctx.db.query("userDeviceAccess").collect();
    return cameras.map((camera) => ({
      ...toDeviceConfig(camera),
      grantedTo: allGrants
        .filter((g) => g.cameraId === camera._id)
        .map((g) => ({ grantId: g._id, clerkUserId: g.clerkUserId })),
    }));
  },
});

export const updateDeviceConfig = mutation({
  args: {
    cameraId: v.id("cameras"),
    wifiPassword: v.optional(v.string()),
    mqttHost: v.optional(v.string()),
    mqttPort: v.optional(v.number()),
    mqttUseTLS: v.optional(v.boolean()),
    mqttUsername: v.optional(v.string()),
    mqttPassword: v.optional(v.string()),
    topicPrefix: v.optional(v.string()),
  },
  handler: async (ctx, { cameraId, ...fields }) => {
    await requireAdmin(ctx);
    await ctx.db.patch(cameraId, fields);
  },
});

export const grantDeviceAccess = mutation({
  args: { cameraId: v.id("cameras"), clerkUserId: v.string() },
  handler: async (ctx, { cameraId, clerkUserId }) => {
    await requireAdmin(ctx);
    const existing = await ctx.db
      .query("userDeviceAccess")
      .withIndex("by_cameraId", (q) => q.eq("cameraId", cameraId))
      .filter((q) => q.eq(q.field("clerkUserId"), clerkUserId))
      .unique();
    if (existing) return existing._id;
    return await ctx.db.insert("userDeviceAccess", { cameraId, clerkUserId });
  },
});

export const revokeDeviceAccess = mutation({
  args: { grantId: v.id("userDeviceAccess") },
  handler: async (ctx, { grantId }) => {
    await requireAdmin(ctx);
    await ctx.db.delete(grantId);
  },
});

// Resolves an email to a Clerk user id via Clerk's Backend API so the admin
// UI can grant access without needing to know raw Clerk user ids. Runs
// server-side only — CLERK_SECRET_KEY must never reach the client.
export const lookupClerkUserByEmail = action({
  args: { email: v.string() },
  handler: async (ctx, { email }): Promise<{ clerkUserId: string; email: string } | null> => {
    await requireAdmin(ctx);
    // Cast via globalThis rather than referencing the ambient `process`
    // global directly — apps/web's tsconfig type-checks this file
    // transitively (through convex/_generated/api) and doesn't include
    // Node's ambient types, so a bare `process` reference fails there even
    // though it resolves fine in Convex's own (Node-based) action runtime.
    const secretKey = (globalThis as { process?: { env: Record<string, string | undefined> } })
      .process?.env.CLERK_SECRET_KEY;
    if (!secretKey) {
      throw new Error("CLERK_SECRET_KEY is not configured on this Convex deployment");
    }
    const res = await fetch(
      `https://api.clerk.com/v1/users?email_address=${encodeURIComponent(email)}`,
      { headers: { Authorization: `Bearer ${secretKey}` } },
    );
    if (!res.ok) {
      throw new Error(`Clerk API error: ${res.status} ${await res.text()}`);
    }
    const users = (await res.json()) as Array<{ id: string }>;
    if (users.length === 0) return null;
    return { clerkUserId: users[0].id, email };
  },
});
