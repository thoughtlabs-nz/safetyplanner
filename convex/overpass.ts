import { action } from "./_generated/server";
import { v } from "convex/values";
import { api } from "./_generated/api";

function parseMaxspeed(tag: string): number | undefined {
  const t = tag.trim().toLowerCase();
  if (!t || t === "none" || t === "unlimited" || t === "signals") return undefined;
  if (t === "walk") return 5;
  const mphMatch = t.match(/^([\d.]+)\s*mph$/);
  if (mphMatch) return parseFloat(mphMatch[1]) * 1.609344;
  const num = parseFloat(t);
  if (!Number.isNaN(num)) return num;
  const zoneDefaults: Record<string, number | undefined> = {
    "nz:urban": 50,
    "nz:rural": 100,
    "nz:motorway": 110,
    "au:urban": 50,
    "gb:nsl_single": 96.56,
    "gb:nsl_dual": 112.65,
    "de:urban": 50,
    "de:rural": 100,
    "de:motorway": undefined,
  };
  return zoneDefaults[t];
}

const OVERPASS_ENDPOINTS = [
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.openstreetmap.fr/api/interpreter",
  "https://overpass.osm.ch/api/interpreter",
  "https://overpass-api.de/api/interpreter",
];

interface OverpassElement {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  nodes?: number[];
  tags?: Record<string, string>;
  geometry?: { lat: number; lon: number }[];
}

interface OverpassResponse {
  elements: OverpassElement[];
}

const FETCH_TIMEOUT_MS = 10000;

async function fetchOverpass(
  endpoint: string,
  query: string,
  apiKey?: string,
): Promise<OverpassResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      body: query,
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Overpass API error: ${response.status}`);
    }
    return (await response.json()) as OverpassResponse;
  } finally {
    clearTimeout(timeout);
  }
}

// Tests connectivity to an Overpass endpoint with a tiny, cheap query — used
// by the "Test connection" button on the Settings page. Tests the values
// passed in (which may not be saved yet), falling back to stored settings
// for whichever of url/apiKey is omitted.
export const testConnection = action({
  args: {
    url: v.optional(v.string()),
    apiKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const settings = await ctx.runQuery(api.settings.get, {});
    const url = args.url || settings.overpassUrl;
    const apiKey = args.apiKey ?? settings.overpassApiKey;

    if (!url) {
      throw new Error("No Overpass URL configured");
    }

    // Tiny bbox (~100m) around Wellington, NZ, just to confirm the endpoint
    // responds with valid Overpass JSON — not a real speed-limit lookup.
    const query = `[out:json][timeout:10];
(
  way["highway"](-41.2871,174.7762,-41.2861,174.7772);
);
out geom;`;

    const start = Date.now();
    const data = await fetchOverpass(url, query, apiKey || undefined);
    const elapsedMs = Date.now() - start;

    return { elementCount: data.elements.length, elapsedMs };
  },
});

export const speedLimitWays = action({
  args: {
    south: v.number(),
    west: v.number(),
    north: v.number(),
    east: v.number(),
  },
  handler: async (ctx, { south, west, north, east }) => {
    const query = `[out:json][timeout:25];
(
  way["highway"]["maxspeed"](${south},${west},${north},${east});
);
out geom;`;

    const settings = await ctx.runQuery(api.settings.get, {});
    // A configured endpoint (e.g. a self-hosted Overpass instance) is tried
    // first, falling back to public mirrors if unset or it fails.
    const endpoints = settings.overpassUrl
      ? [settings.overpassUrl, ...OVERPASS_ENDPOINTS]
      : OVERPASS_ENDPOINTS;

    let lastError: Error | undefined;
    for (const endpoint of endpoints) {
      try {
        const apiKey = endpoint === settings.overpassUrl ? settings.overpassApiKey : undefined;
        const data = await fetchOverpass(endpoint, query, apiKey || undefined);
        const ways: { maxspeedKmh: number; points: [number, number][] }[] = [];
        for (const element of data.elements) {
          if (element.type === "way" && element.tags?.maxspeed) {
            const maxspeedKmh = parseMaxspeed(element.tags.maxspeed);
            const points = (element.geometry ?? [])
              .filter((g) => g.lat !== undefined && g.lon !== undefined)
              .map((g) => [g.lat, g.lon] as [number, number]);
            if (points.length > 0 && maxspeedKmh !== undefined) {
              ways.push({ maxspeedKmh, points });
            }
          }
        }
        return ways;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
      }
    }
    throw lastError ?? new Error("All Overpass mirrors failed");
  },
});

function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Place kinds ordered from most to least locally specific — a suburb/
// neighbourhood is a more useful label than the town/city it sits inside.
const PLACE_KIND_RANK = ["neighbourhood", "suburb", "hamlet", "village", "town", "city"];

// Best-effort reverse geocode of a point via nearby OSM features — Overpass
// isn't a real geocoding service, so this picks the closest reasonable label
// in tiers (street address, then named POI, then the enclosing place area)
// rather than promising an authoritative address.
export const nearestPlaceName = action({
  args: { lat: v.number(), lng: v.number() },
  handler: async (ctx, { lat, lng }): Promise<string | undefined> => {
    const query = `[out:json][timeout:15];
(
  nwr(around:60,${lat},${lng})["addr:housenumber"]["addr:street"];
  nwr(around:150,${lat},${lng})["name"];
  nwr(around:8000,${lat},${lng})["place"~"^(neighbourhood|suburb|hamlet|village|town|city)$"];
);
out center tags;`;

    const settings = await ctx.runQuery(api.settings.get, {});
    const endpoints = settings.overpassUrl
      ? [settings.overpassUrl, ...OVERPASS_ENDPOINTS]
      : OVERPASS_ENDPOINTS;

    let lastError: Error | undefined;
    for (const endpoint of endpoints) {
      try {
        const apiKey = endpoint === settings.overpassUrl ? settings.overpassApiKey : undefined;
        const data = await fetchOverpass(endpoint, query, apiKey || undefined);

        const withDistance = data.elements
          .map((el) => {
            const elLat = el.lat ?? el.center?.lat;
            const elLng = el.lon ?? el.center?.lon;
            if (elLat === undefined || elLng === undefined) return undefined;
            return { el, distance: haversineMeters(lat, lng, elLat, elLng) };
          })
          .filter((x): x is { el: OverpassElement; distance: number } => x !== undefined);

        const addressMatch = withDistance
          .filter((x) => x.el.tags?.["addr:housenumber"] && x.el.tags?.["addr:street"])
          .sort((a, b) => a.distance - b.distance)[0];
        if (addressMatch) {
          return `${addressMatch.el.tags!["addr:housenumber"]} ${addressMatch.el.tags!["addr:street"]}`;
        }

        const namedMatch = withDistance
          .filter((x) => x.el.tags?.name && !x.el.tags?.place)
          .sort((a, b) => a.distance - b.distance)[0];
        if (namedMatch) {
          return namedMatch.el.tags!.name;
        }

        const placeMatch = withDistance
          .filter((x) => x.el.tags?.name && x.el.tags?.place)
          .sort((a, b) => {
            const rankA = PLACE_KIND_RANK.indexOf(a.el.tags!.place);
            const rankB = PLACE_KIND_RANK.indexOf(b.el.tags!.place);
            if (rankA !== rankB) return rankA - rankB;
            return a.distance - b.distance;
          })[0];
        return placeMatch?.el.tags!.name;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
      }
    }
    throw lastError ?? new Error("All Overpass mirrors failed");
  },
});

// Nearest posted speed limit to a single point — used by the Live Tracking
// page to show "current speed / limit" next to the vehicle marker.
// Approximates "nearest way" as "nearest vertex across all maxspeed ways in
// a small radius", same tradeoff Journeys' assignSpeedLimits makes
// client-side — fine for a live indicator, not survey-grade.
export const nearestSpeedLimit = action({
  args: { lat: v.number(), lng: v.number() },
  handler: async (ctx, { lat, lng }): Promise<number | undefined> => {
    const query = `[out:json][timeout:10];
(
  way["highway"]["maxspeed"](around:150,${lat},${lng});
);
out geom;`;

    const settings = await ctx.runQuery(api.settings.get, {});
    const endpoints = settings.overpassUrl
      ? [settings.overpassUrl, ...OVERPASS_ENDPOINTS]
      : OVERPASS_ENDPOINTS;

    let lastError: Error | undefined;
    for (const endpoint of endpoints) {
      try {
        const apiKey = endpoint === settings.overpassUrl ? settings.overpassApiKey : undefined;
        const data = await fetchOverpass(endpoint, query, apiKey || undefined);

        let best: { distance: number; maxspeedKmh: number } | undefined;
        for (const element of data.elements) {
          if (element.type !== "way" || !element.tags?.maxspeed) continue;
          const maxspeedKmh = parseMaxspeed(element.tags.maxspeed);
          if (maxspeedKmh === undefined) continue;
          for (const point of element.geometry ?? []) {
            if (point.lat === undefined || point.lon === undefined) continue;
            const distance = haversineMeters(lat, lng, point.lat, point.lon);
            if (!best || distance < best.distance) best = { distance, maxspeedKmh };
          }
        }
        return best?.maxspeedKmh;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
      }
    }
    throw lastError ?? new Error("All Overpass mirrors failed");
  },
});
