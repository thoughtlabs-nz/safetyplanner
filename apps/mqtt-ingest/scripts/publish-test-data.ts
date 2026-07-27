import "dotenv/config";
import mqtt from "mqtt";

// Publishes one synthetic sync pass to the broker mqtt-ingest is listening
// on, exercising every topic/payload shape it handles — lets you verify the
// Convex ingestion path end-to-end without a real camera or the iOS app in
// the loop. Message shapes must match apps/mqtt-ingest/src/index.ts's
// handlers and apps/safety-planner-ios's Models.swift exactly.
//
// Usage (all configuration comes from .env):
//   npx tsx scripts/publish-test-data.ts          # one synthetic sync pass
//   npx tsx scripts/publish-test-data.ts --live   # simulated live drive
//
// --live publishes a `live` telemetry message every second (a fake vehicle
// looping around central Auckland) until Ctrl-C — open the web app's Live
// page to watch it move. Exercises the same topic/payload the iOS app's
// LiveTelemetryManager publishes.
//
// TEST_CAMERA_SSID must match a camera already registered in Convex
// (Settings page) — mqtt-ingest resolves every message's camera via
// cameras.getBySsid and silently drops anything for an unknown ssid.

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name}`);
  return value;
}

const ssid = required("TEST_CAMERA_SSID");
const mqttUrl = required("MQTT_URL");
const topicPrefix = process.env.MQTT_TOPIC_PREFIX ?? "ddpai";
const topicSsid = encodeURIComponent(ssid);

function topic(kind: string): string {
  return `${topicPrefix}/${topicSsid}/${kind}`;
}

// A run identifier baked into every fabricated filename so repeat runs
// don't collide with (and get silently skipped as duplicates of) a
// previous test run's recordings/gpsFiles.
const runId = Date.now();
const now = Date.now();
const recordingStart = now - 5 * 60_000;
const recordingEnd = now - 4 * 60_000;
const videoFilename = `TEST_${runId}_0060.mp4`;
const eventVideoFilename = `TEST_EVENT_${runId}_0060.mp4`;
const thumbnailFilename = `TEST_EVENT_${runId}_thumb.jpg`;
const gpsFilename = `TEST_${runId}_0060.gps`;

// Plain-text NMEA log (no tar wrapper) — matches the "_0060"-suffixed raw
// format apps/poller/src/nmeaTarParser.ts documents. Three $GPRMC fixes a
// few seconds apart plus a couple of $GSENSOR accelerometer samples.
function toNmeaTimestamp(ms: number): { date: string; time: string } {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  const date = `${pad(d.getUTCDate())}${pad(d.getUTCMonth() + 1)}${String(d.getUTCFullYear()).slice(-2)}`;
  const time = `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}.00`;
  return { date, time };
}

function buildNmeaText(): string {
  const lines: string[] = [];
  for (let i = 0; i < 3; i++) {
    const ts = recordingStart + i * 5_000;
    const { date, time } = toNmeaTimestamp(ts);
    // $GPRMC,time,status,lat,N/S,lon,E/W,speedKnots,course,date,,,checksum
    lines.push(
      `$GPRMC,${time},A,3651.0000,S,17445.8000,E,${(10 + i).toFixed(1)},90.0,${date},,,A*00`,
    );
  }
  for (let i = 0; i < 5; i++) {
    const ts = recordingStart + i * 1_000;
    lines.push(`$GSENSOR,${20 + i * 5},${-10 - i},980,${ts}`);
  }
  return lines.join("\n") + "\n";
}

// A valid 1x1 transparent PNG, base64-encoded — small enough to hand-embed,
// enough to exercise the thumbnail save-to-disk path for real.
const ONE_PIXEL_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

// Simulated drive: a slow loop around the Auckland waterfront, one live
// message per second — matches Models.swift's LiveTelemetryMessage shape.
async function runLive(publish: (kind: string, payload: unknown) => Promise<void>): Promise<never> {
  const centerLat = -36.8445;
  const centerLng = 174.7635;
  const radiusDeg = 0.004; // ~400m
  let angle = 0;
  let peakG = 0;
  console.log("Publishing live telemetry every 1s — Ctrl-C to stop");
  for (;;) {
    angle += 0.03; // full lap in ~3.5 minutes
    const lat = centerLat + radiusDeg * Math.sin(angle);
    const lng = centerLng + radiusDeg * Math.cos(angle);
    // Heading is the tangent of the (clockwise-from-north) circle.
    const headingDeg = (((-angle * 180) / Math.PI) % 360 + 360) % 360;
    const gForce = 0.05 + Math.random() * 0.15;
    peakG = Math.max(peakG, gForce);
    await publish("live", {
      timestamp: Date.now(),
      lat,
      lng,
      speedKmh: 38 + Math.random() * 8,
      headingDeg,
      accelX: gForce,
      accelY: 0,
      accelZ: 0,
      gForce,
      peakG,
    });
    process.stdout.write(".");
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function main() {
  const client = mqtt.connect(mqttUrl, {
    clientId: `test-publisher-${runId}`,
    username: process.env.MQTT_USERNAME,
    password: process.env.MQTT_PASSWORD,
  });

  await new Promise<void>((resolve, reject) => {
    client.once("connect", () => resolve());
    client.once("error", reject);
  });
  console.log(`Connected to ${mqttUrl}`);

  function publish(kind: string, payload: unknown): Promise<void> {
    return new Promise((resolve, reject) => {
      client.publish(topic(kind), JSON.stringify(payload), { qos: 1 }, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  if (process.argv.includes("--live")) {
    await runLive(publish);
  }

  await publish("status", { connected: true });
  console.log("Published status");

  await publish("playback", {
    entries: [
      {
        starttime: String(Math.round(recordingStart / 1000)),
        endtime: String(Math.round(recordingEnd / 1000)),
        name: videoFilename,
        size: "12345678",
      },
    ],
  });
  console.log(`Published playback: ${videoFilename}`);

  await publish("events", {
    entries: [
      {
        bvideoname: eventVideoFilename,
        bstarttime: String(Math.round(recordingStart / 1000)),
        bendtime: String(Math.round(recordingEnd / 1000)),
        bvideosize: "2345678",
        imgname: thumbnailFilename,
      },
    ],
  });
  console.log(`Published events: ${eventVideoFilename}`);

  await publish("thumbnail", {
    filename: thumbnailFilename,
    dataBase64: ONE_PIXEL_PNG_BASE64,
    for: eventVideoFilename,
  });
  console.log(`Published thumbnail: ${thumbnailFilename}`);

  await publish("gpsfile", {
    filename: gpsFilename,
    parentfile: videoFilename,
    dataBase64: Buffer.from(buildNmeaText(), "utf-8").toString("base64"),
  });
  console.log(`Published gpsfile: ${gpsFilename}`);

  console.log("\nDone. Check mqtt-ingest's logs and the Convex dashboard (recordings/events/gpsFixes/accelSamples) for:");
  console.log(`  - a recording named ${videoFilename} and ${eventVideoFilename}`);
  console.log(`  - an event on ${eventVideoFilename} with a thumbnail`);
  console.log(`  - gpsFixes/accelSamples parsed from ${gpsFilename}`);

  client.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
