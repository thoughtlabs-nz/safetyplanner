import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { api } from "./_generated/api";
import { requireIdentity } from "./lib/authz";

const http = httpRouter();

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Unauthorized";
}

// Called by the iOS app on login (Authorization: Bearer <Clerk session
// token>) to fetch its granted devices' Wi-Fi/MQTT config, replacing the
// manual entry that used to live in AppSettings.swift. Convex has no native
// Swift client, so this is a plain HTTP endpoint rather than a query call.
http.route({
  path: "/api/device-config",
  method: "GET",
  handler: httpAction(async (ctx) => {
    try {
      const devices = await ctx.runQuery(api.devices.myDevices, {});
      return json({ devices }, 200);
    } catch (err) {
      return json({ error: errorMessage(err) }, 401);
    }
  }),
});

// Called by the iOS app's Reporting tab (Authorization: Bearer <Clerk
// session token>) — same reasoning as /api/device-config above: Convex has
// no native Swift client, so this is a plain HTTP endpoint wrapping a
// single combined query (reports.mobileSummary) instead of five separate
// live subscriptions like the web Reporting page uses.
http.route({
  path: "/api/reporting-summary",
  method: "GET",
  handler: httpAction(async (ctx) => {
    try {
      const summary = await ctx.runQuery(api.reports.mobileSummary, {});
      return json(summary, 200);
    } catch (err) {
      return json({ error: errorMessage(err) }, 401);
    }
  }),
});

// Called by the iOS app's Journeys tab — trip list for the picker. Requires
// auth explicitly (journeys.list itself has no auth check, same as the
// web-only report queries — it's only gated client-side there by the route
// wrapper) since this is a plain HTTP endpoint reachable by anyone with the
// URL, not a websocket query call.
http.route({
  path: "/api/journeys",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    try {
      await requireIdentity(ctx);
      const url = new URL(request.url);
      const limitParam = url.searchParams.get("limit");
      const trips = await ctx.runQuery(api.journeys.list, {
        limit: limitParam ? Number(limitParam) : undefined,
      });
      return json(trips, 200);
    } catch (err) {
      return json({ error: errorMessage(err) }, 401);
    }
  }),
});

// Called by the iOS app's Journeys tab once a trip is selected — GPS fixes,
// events (with thumbnails), and peak G-force for that trip's time range.
// Mirrors exactly what apps/web/src/pages/Journeys.tsx fetches for its
// selected trip (gpsFixes.forTimeRange + events.forTimeRangeWithThumbnails +
// accelSamples.maxInRange), including that gpsFixes.forTimeRange isn't
// filtered by camera — same behavior as the web page, not a new limitation.
http.route({
  path: "/api/journey-detail",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    try {
      await requireIdentity(ctx);
      const url = new URL(request.url);
      const startTime = Number(url.searchParams.get("startTime"));
      const endTime = Number(url.searchParams.get("endTime"));
      if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) {
        return json({ error: "startTime and endTime query params are required" }, 400);
      }
      const [fixes, events, maxG] = await Promise.all([
        ctx.runQuery(api.gpsFixes.forTimeRange, { startTime, endTime }),
        ctx.runQuery(api.events.forTimeRangeWithThumbnails, { startTime, endTime }),
        ctx.runAction(api.accelSamples.maxInRange, { startTime, endTime }),
      ]);
      return json({ fixes, events, maxG }, 200);
    } catch (err) {
      return json({ error: errorMessage(err) }, 401);
    }
  }),
});

export default http;
