import mqtt from "mqtt";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../../convex/_generated/api.js";
import type { Id } from "../../../convex/_generated/dataModel.js";
import { config } from "./config.js";
import { createLogger } from "./logger.js";
import { saveFile, deleteFile } from "./storage.js";
import { parseGpsFile, type GpsFix, type AccelSample } from "./nmeaTarParser.js";
import { insertAccelSamplesChunked } from "./accelBatching.js";
import { parseCameraTime } from "./time.js";

const convex = new ConvexHttpClient(config.convexUrl);
const log = createLogger(convex);

// This app is a bridge consumer, not the thing talking to the camera — a
// phone (or any other relay) authenticates with the camera over its own
// Wi-Fi the same way apps/poller/src/ddpaiClient.ts does, then republishes
// what it fetched unchanged: raw playback/event list JSON, raw GPS file
// bytes, raw thumbnail bytes. All parsing/upload logic here is deliberately
// a mirror of apps/poller/src/index.ts's sync* functions so a journey /
// recording ends up identical regardless of which path (Wi-Fi poller or
// MQTT bridge) produced it. Neither the poller nor the web app import
// anything from this app, and nothing here imports from them — kept
// separate on purpose so this can fail, restart, or be redeployed
// independently.

interface PlaybackListMessage {
  entries: { starttime: string | number; endtime: string | number; name: string; size?: string | number }[];
}

interface EventListMessage {
  entries: {
    bvideoname: string;
    bstarttime: string | number;
    bendtime: string | number;
    bvideosize?: string | number;
    imgname?: string;
  }[];
}

interface ThumbnailMessage {
  filename: string;
  dataBase64: string;
  // The camera names an event's thumbnail independently of its video
  // (imgname vs bvideoname), so there's no shared key to join them on other
  // than the bridge telling us explicitly which recording this belongs to.
  for: string;
}

interface GpsFileMessage {
  filename: string;
  parentfile?: string;
  dataBase64: string;
}

// Sent when the phone bridge parses NMEA text on-device instead of
// forwarding the raw file (see SyncEngine.swift's NmeaParser use) — large
// GPS files (100s of KB to several MB) blow past CocoaMQTT's hardcoded 5s
// socket write timeout on cellular, so the phone chunks each file's fixes
// into several small self-contained messages like this one instead. Each
// chunk gets its own gpsFiles row (same as one entry from an untarred
// multi-segment file already does) — there's no ordering/append dependency
// between chunks.
interface GpsDataMessage {
  filename: string;
  parentfile?: string;
  fixes: GpsFix[];
  accelSamples: AccelSample[];
}

interface StatusMessage {
  connected: boolean;
  error?: string;
}

// Live vehicle telemetry from the phone's own GPS/motion sensors, published
// at ~1Hz by the iOS app's LiveTelemetryManager while live tracking is on.
// Field-for-field match with Models.swift's LiveTelemetryMessage.
interface LiveTelemetryMessage {
  timestamp: number;
  lat: number;
  lng: number;
  speedKmh?: number;
  headingDeg?: number;
  accelX?: number;
  accelY?: number;
  accelZ?: number;
  gForce?: number;
  peakG?: number;
}

// Cached rather than looked up per-message — a bridge only ever talks about
// the one camera whose Wi-Fi it joined, so its ssid doesn't change mid-session.
const cameraIdBySsid = new Map<string, Id<"cameras">>();

async function resolveCameraId(ssid: string): Promise<Id<"cameras"> | null> {
  const cached = cameraIdBySsid.get(ssid);
  if (cached) return cached;
  const camera = await convex.query(api.cameras.getBySsid, { ssid });
  if (!camera) return null;
  cameraIdBySsid.set(ssid, camera._id);
  return camera._id;
}

async function handleStatus(cameraId: Id<"cameras">, msg: StatusMessage): Promise<void> {
  await convex.mutation(api.cameraStatus.report, {
    cameraId,
    connected: msg.connected,
    lastError: msg.error,
  });
}

async function handlePlayback(cameraId: Id<"cameras">, msg: PlaybackListMessage): Promise<void> {
  let listed = 0;
  for (const entry of msg.entries) {
    const existing = await convex.query(api.recordings.getByFilename, { cameraId, filename: entry.name });
    if (existing) continue;
    if (await convex.query(api.deletedFiles.isDeleted, { cameraId, filename: entry.name })) continue;

    const startTime = parseCameraTime(entry.starttime);
    const endTime = parseCameraTime(entry.endtime);
    await convex.mutation(api.recordings.upsertMetadata, {
      cameraId,
      kind: "continuous",
      filename: entry.name,
      startTime,
      durationSeconds: Math.max(0, Math.round((endTime - startTime) / 1000)),
      sizeBytes: entry.size !== undefined ? Number(entry.size) : undefined,
    });
    listed += 1;
  }
  if (listed > 0) await log.info(`mqtt playback sync: listed ${listed} recordings`);
}

async function handleEvents(cameraId: Id<"cameras">, msg: EventListMessage): Promise<void> {
  let listed = 0;
  for (const entry of msg.entries) {
    const existing = await convex.query(api.recordings.getByFilename, {
      cameraId,
      filename: entry.bvideoname,
    });
    if (existing) continue;
    if (await convex.query(api.deletedFiles.isDeleted, { cameraId, filename: entry.bvideoname })) continue;

    const startTime = parseCameraTime(entry.bstarttime);
    const endTime = parseCameraTime(entry.bendtime);
    const recordingId = await convex.mutation(api.recordings.upsertMetadata, {
      cameraId,
      kind: "event",
      filename: entry.bvideoname,
      startTime,
      durationSeconds: Math.max(0, Math.round((endTime - startTime) / 1000)),
      sizeBytes: entry.bvideosize !== undefined ? Number(entry.bvideosize) : undefined,
    });
    await convex.mutation(api.events.create, { recordingId, type: "other", timestamp: startTime });
    listed += 1;
    // The thumbnail bytes themselves arrive separately on the `thumbnail`
    // topic (they're forwarded as soon as the bridge downloads them, which
    // may be before or after this list message) — handleThumbnail below
    // attaches them to this same recording by filename once they land.
  }
  if (listed > 0) await log.info(`mqtt events sync: listed ${listed} events`);
}

async function handleThumbnail(cameraId: Id<"cameras">, msg: ThumbnailMessage): Promise<void> {
  const recording = await convex.query(api.recordings.getByFilename, { cameraId, filename: msg.for });
  if (!recording) return;
  // Already uploaded on a previous sync — thumbnails are immutable per
  // recording, so skip the (re-)upload rather than orphaning storage blobs.
  if (recording.thumbnailStorageId) return;

  // Convex file storage rather than local disk: the old thumbnailPath model
  // needed the poller's control server running (and reachable — a problem
  // for the tunneled deployment) just to serve static JPEGs. Storage blobs
  // are served from Convex's CDN via ctx.storage.getUrl in the queries.
  const data = Buffer.from(msg.dataBase64, "base64");
  const uploadUrl = await convex.mutation(api.recordings.generateThumbnailUploadUrl, {});
  const res = await fetch(uploadUrl, {
    method: "POST",
    headers: { "Content-Type": "image/jpeg" },
    body: data,
  });
  if (!res.ok) {
    await log.warn(`thumbnail upload failed: HTTP ${res.status}`, { filename: msg.filename });
    return;
  }
  const { storageId } = (await res.json()) as { storageId: string };
  await convex.mutation(api.recordings.setThumbnailStorage, {
    id: recording._id,
    storageId: storageId as Id<"_storage">,
  });
  await log.info(`thumbnail stored in Convex storage`, { filename: msg.filename });
}

async function handleGpsFile(cameraId: Id<"cameras">, msg: GpsFileMessage): Promise<void> {
  const existing = await convex.query(api.gpsFiles.getByFilename, { cameraId, filename: msg.filename });
  if (existing) return;
  if (await convex.query(api.deletedFiles.isDeleted, { cameraId, filename: msg.filename })) return;

  const recording = msg.parentfile
    ? await convex.query(api.recordings.getByFilename, { cameraId, filename: msg.parentfile })
    : null;

  const data = Buffer.from(msg.dataBase64, "base64");
  const filePath = await saveFile("gps", msg.filename, data, cameraId);

  const gpsFileId = await convex.mutation(api.gpsFiles.upsert, {
    cameraId,
    recordingId: recording?._id,
    filename: msg.filename,
    filePath,
  });

  const { fixes, accelSamples } = await parseGpsFile(data);
  if (fixes.length > 0) {
    await convex.mutation(api.gpsFixes.insertBatch, {
      gpsFileId,
      recordingId: recording?._id,
      cameraId,
      fixes,
    });
    await convex.mutation(api.gpsFiles.markParsed, { id: gpsFileId });
  }
  if (accelSamples.length > 0) {
    await insertAccelSamplesChunked(convex, gpsFileId, recording?._id, accelSamples);
  }

  // Matches the poller's behavior exactly: the raw file is only useful as
  // parse input, so once fixes are extracted, drop it from disk.
  if (fixes.length > 0) {
    await deleteFile(filePath);
    await convex.mutation(api.gpsFiles.clearFilePath, { id: gpsFileId });
  }

  await log.info(`mqtt gps file ingested: ${msg.filename}`, {
    fixes: fixes.length,
    accelSamples: accelSamples.length,
  });
}

async function handleLive(cameraId: Id<"cameras">, msg: LiveTelemetryMessage): Promise<void> {
  // Deliberately no logging here — this fires ~1Hz per driving camera and
  // would drown pollEvents. liveTelemetry.report is a single upsert; the
  // web page observes the row directly, so nothing else to do.
  await convex.mutation(api.liveTelemetry.report, {
    cameraId,
    timestamp: msg.timestamp,
    lat: msg.lat,
    lng: msg.lng,
    speedKmh: msg.speedKmh,
    headingDeg: msg.headingDeg,
    accelX: msg.accelX,
    accelY: msg.accelY,
    accelZ: msg.accelZ,
    gForce: msg.gForce,
    peakG: msg.peakG,
  });
}

async function handleGpsData(cameraId: Id<"cameras">, msg: GpsDataMessage): Promise<void> {
  // A piece's message filename depends on its parse results: accel-carrying
  // pieces get chunk-suffixed names ("X__chunk0", "X__chunk1", …) while
  // fix-only pieces are named bare ("X"). A parser change on the phone can
  // therefore re-send the SAME piece under the other naming scheme — which
  // is exactly how duplicate fixes got imported (bare-named rows from
  // before the accel parser worked, chunk0-named rows after). Dedupe must
  // treat "X" and "X__chunk0" as the same identity, in both directions.
  const baseName = msg.filename.split("__chunk")[0];
  const aliasName = msg.filename === baseName ? `${baseName}__chunk0` : baseName;
  const existing = await convex.query(api.gpsFiles.getByFilename, { cameraId, filename: msg.filename });
  if (existing) return;
  const existingAlias = await convex.query(api.gpsFiles.getByFilename, { cameraId, filename: aliasName });
  if (existingAlias) {
    await log.info(`mqtt gps data skipped, already ingested under alias name`, {
      filename: msg.filename,
      alias: aliasName,
    });
    return;
  }
  if (await convex.query(api.deletedFiles.isDeleted, { cameraId, filename: msg.filename })) return;
  if (await convex.query(api.deletedFiles.isDeleted, { cameraId, filename: baseName })) return;

  const recording = msg.parentfile
    ? await convex.query(api.recordings.getByFilename, { cameraId, filename: msg.parentfile })
    : null;

  // No filePath — this chunk already carries parsed data; there was never a
  // raw file downloaded/stored for it to point at.
  const gpsFileId = await convex.mutation(api.gpsFiles.upsert, {
    cameraId,
    recordingId: recording?._id,
    filename: msg.filename,
  });

  if (msg.fixes.length > 0) {
    await convex.mutation(api.gpsFixes.insertBatch, {
      gpsFileId,
      recordingId: recording?._id,
      cameraId,
      fixes: msg.fixes,
    });
    await convex.mutation(api.gpsFiles.markParsed, { id: gpsFileId });
  }
  if (msg.accelSamples.length > 0) {
    await insertAccelSamplesChunked(convex, gpsFileId, recording?._id, msg.accelSamples);
  }

  await log.info(`mqtt gps data ingested: ${msg.filename}`, {
    fixes: msg.fixes.length,
    accelSamples: msg.accelSamples.length,
  });
}

// Convex mutations aren't safe to fire concurrently against the same
// recording/gpsFile row from this process (two in-flight upserts could both
// miss an "already exists" check) — a single serial queue removes that race
// without needing per-key locking, at the cost of one consumer instance's
// throughput. Run more than one instance only against disjoint camera sets.
type Job = () => Promise<void>;
const queue: Job[] = [];
let draining = false;

function enqueue(job: Job): void {
  queue.push(job);
  if (!draining) void drainQueue();
}

async function drainQueue(): Promise<void> {
  draining = true;
  while (queue.length > 0) {
    const job = queue.shift()!;
    try {
      await job();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await log.error("mqtt message handling failed", { error: message });
    }
  }
  draining = false;
}

function parseTopic(topic: string): { ssid: string; kind: string } | null {
  const prefix = `${config.topicPrefix}/`;
  if (!topic.startsWith(prefix)) return null;
  const rest = topic.slice(prefix.length);
  const slash = rest.indexOf("/");
  if (slash === -1) return null;
  return { ssid: decodeURIComponent(rest.slice(0, slash)), kind: rest.slice(slash + 1) };
}

async function main() {
  console.log(`Starting MQTT ingest, broker ${config.mqttUrl}, topic prefix "${config.topicPrefix}"`);

  const client = mqtt.connect(config.mqttUrl, {
    clientId: config.mqttClientId,
    username: config.mqttUsername,
    password: config.mqttPassword,
    reconnectPeriod: 5000,
  });

  client.on("connect", () => {
    console.log("connected to MQTT broker");
    client.subscribe(
      [
        `${config.topicPrefix}/+/status`,
        `${config.topicPrefix}/+/playback`,
        `${config.topicPrefix}/+/events`,
        `${config.topicPrefix}/+/thumbnail`,
        `${config.topicPrefix}/+/gpsfile`,
        `${config.topicPrefix}/+/gpsdata`,
        `${config.topicPrefix}/+/live`,
      ],
      { qos: 1 },
    );
  });

  client.on("error", (err) => {
    console.error("mqtt client error", err);
  });

  // Latest-wins coalescing for live telemetry. Samples arrive at ~1Hz per
  // driving camera and only the newest matters — if the serial queue is
  // busy (a gpsfile parse takes seconds), queueing one job per sample would
  // replay a stale-position slideshow afterwards. Instead the newest
  // payload per ssid is parked here and at most one queued job per ssid
  // drains whatever is newest by the time it runs.
  const pendingLive = new Map<string, LiveTelemetryMessage>();
  // Diagnostics use plain console.* (container stdout), never the
  // Convex-backed `log` helper — that writes a pollEvents mutation per
  // call, which a 1Hz stream would drown. Each Set below dedupes so a
  // stuck failure logs once, not every tick, but still SOMETHING is
  // visible in `docker logs` instead of every live sample vanishing
  // silently (the gap that made an unresolvable ssid indistinguishable
  // from "nothing arrived at all" the first time this shipped).
  const liveSeenSsids = new Set<string>();
  const liveUnresolvedWarned = new Set<string>();

  client.on("message", (topic, payload) => {
    const parsedTopic = parseTopic(topic);
    if (!parsedTopic) return;
    const { ssid, kind } = parsedTopic;

    if (kind === "live") {
      if (!liveSeenSsids.has(ssid)) {
        liveSeenSsids.add(ssid);
        console.log(`live telemetry: first sample received for ssid "${ssid}"`);
      }
      let msg: LiveTelemetryMessage;
      try {
        msg = JSON.parse(payload.toString("utf-8")) as LiveTelemetryMessage;
      } catch (err) {
        console.warn(`live telemetry: unparseable payload from ssid "${ssid}"`, err);
        return;
      }
      const alreadyQueued = pendingLive.has(ssid);
      pendingLive.set(ssid, msg);
      if (!alreadyQueued) {
        enqueue(async () => {
          const latest = pendingLive.get(ssid);
          pendingLive.delete(ssid);
          if (!latest) return;
          const cameraId = await resolveCameraId(ssid);
          if (!cameraId) {
            if (!liveUnresolvedWarned.has(ssid)) {
              liveUnresolvedWarned.add(ssid);
              console.warn(`live telemetry: no camera registered for ssid "${ssid}", dropping`);
            }
            return;
          }
          liveUnresolvedWarned.delete(ssid);
          await handleLive(cameraId, latest);
        });
      }
      return;
    }

    enqueue(async () => {
      const cameraId = await resolveCameraId(ssid);
      if (!cameraId) {
        await log.warn(`mqtt message for unknown camera ssid, dropped`, { ssid, kind });
        return;
      }

      const json = JSON.parse(payload.toString("utf-8"));
      switch (kind) {
        case "status":
          return handleStatus(cameraId, json as StatusMessage);
        case "playback":
          return handlePlayback(cameraId, json as PlaybackListMessage);
        case "events":
          return handleEvents(cameraId, json as EventListMessage);
        case "thumbnail":
          return handleThumbnail(cameraId, json as ThumbnailMessage);
        case "gpsfile":
          return handleGpsFile(cameraId, json as GpsFileMessage);
        case "gpsdata":
          return handleGpsData(cameraId, json as GpsDataMessage);
        default:
          console.warn(`unknown mqtt topic kind "${kind}", ignoring`);
      }
    });
  });
}

main().catch((err) => {
  console.error("mqtt-ingest crashed", err);
  process.exit(1);
});
