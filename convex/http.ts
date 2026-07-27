import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { api } from "./_generated/api";

const http = httpRouter();

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
      return new Response(JSON.stringify({ devices }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unauthorized";
      return new Response(JSON.stringify({ error: message }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
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
      return new Response(JSON.stringify(summary), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unauthorized";
      return new Response(JSON.stringify({ error: message }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
  }),
});

export default http;
