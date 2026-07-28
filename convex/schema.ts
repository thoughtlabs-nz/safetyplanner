import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  // Registered dashcams. Each runs its own local Wi-Fi network at the same
  // fixed camUrl, so the SSID (not the URL) is what distinguishes them — the
  // poller looks a camera up by ssid when a network session starts.
  cameras: defineTable({
    ssid: v.string(),
    name: v.string(),
    camUrl: v.string(),

    // Connection config the iOS app used to require manual entry for (see
    // AppSettings.swift) — now fetched centrally via devices.myDevices /
    // the /api/device-config HTTP endpoint on login instead. All optional
    // so existing rows and the poller's create/update (which don't set
    // these) keep working.
    wifiPassword: v.optional(v.string()),
    mqttHost: v.optional(v.string()),
    mqttPort: v.optional(v.number()),
    mqttUseTLS: v.optional(v.boolean()),
    mqttUsername: v.optional(v.string()),
    mqttPassword: v.optional(v.string()),
    topicPrefix: v.optional(v.string()),

    // Optional user-uploaded avatar photo — stored in Convex file storage,
    // resolved to a URL wherever a camera is listed (see cameras.list /
    // devices.myDevices / devices.listAllDevices). Absent one, every UI
    // surface falls back to a colored car icon whose color is derived
    // deterministically from the camera's _id (see avatarColor helpers in
    // apps/web/src/cameraAvatar.ts and the iOS CameraAvatar view) — no
    // color field needed here since it's pure presentation, computed the
    // same way on both clients from an id both already have.
    avatarStorageId: v.optional(v.id("_storage")),
  }).index("by_ssid", ["ssid"]),

  // Grants a Clerk user access to a camera's config (many-to-many — a
  // household can have several cameras, and in principle a camera could be
  // shared). clerkUserId is the Clerk JWT `sub` claim, not a Convex id —
  // there's no separate `users` table since role lives in Clerk
  // publicMetadata, not here.
  userDeviceAccess: defineTable({
    clerkUserId: v.string(),
    cameraId: v.id("cameras"),
  })
    .index("by_clerkUserId", ["clerkUserId"])
    .index("by_cameraId", ["cameraId"]),

  cameraStatus: defineTable({
    cameraId: v.id("cameras"),
    connected: v.boolean(),
    lastSeenAt: v.optional(v.number()),
    lastPollAt: v.number(),
    lastError: v.optional(v.string()),
  }).index("by_cameraId", ["cameraId"]),

  recordings: defineTable({
    // Optional so historical rows created before multi-camera support don't
    // break — the poller always sets this once a camera session is active.
    cameraId: v.optional(v.id("cameras")),
    kind: v.union(
      v.literal("continuous"),
      v.literal("timelapse"),
      v.literal("event"),
    ),
    filename: v.string(),
    // Recordings are listed (metadata only) as soon as the camera reports
    // them; the video file itself is only fetched when the user requests it
    // from the UI, since continuous/timelapse clips are large (100s of MB).
    status: v.union(
      v.literal("listed"),
      v.literal("queued"),
      v.literal("downloading"),
      v.literal("downloaded"),
      v.literal("failed"),
    ),
    filePath: v.optional(v.string()),
    // Legacy: thumbnails used to be written to local disk and served by the
    // poller's control server (thumbnailPath). New ingests upload to Convex
    // file storage instead (thumbnailStorageId) — served from Convex's CDN,
    // reachable from anywhere, no poller process/tunnel required.
    thumbnailPath: v.optional(v.string()),
    thumbnailStorageId: v.optional(v.id("_storage")),
    // Set once a bulk "delete all thumbnails" purge has cleared this
    // recording's thumbnail — mqtt-ingest's thumbnail handler checks this so
    // a re-sent MQTT thumbnail message doesn't repopulate what was purged
    // (see recordings.purgeThumbnail and mqtt-ingest's handleThumbnail).
    thumbnailDeleted: v.optional(v.boolean()),
    startTime: v.number(),
    durationSeconds: v.optional(v.number()),
    sizeBytes: v.optional(v.number()),
    channel: v.optional(v.string()),
    error: v.optional(v.string()),
    downloadedAt: v.optional(v.number()),
  })
    .index("by_filename", ["filename"])
    .index("by_camera_filename", ["cameraId", "filename"])
    .index("by_startTime", ["startTime"])
    .index("by_kind", ["kind"])
    .index("by_status", ["status"]),

  gpsFiles: defineTable({
    // Optional so historical rows created before multi-camera support don't
    // break — the poller always sets this once a camera session is active.
    cameraId: v.optional(v.id("cameras")),
    // The camera's GPS file list isn't reliably matched to a parent
    // recording (its `parentfile` field doesn't consistently correspond to
    // a recording we've downloaded) — the reference client downloads every
    // GPS file unconditionally rather than gating on a match, so we do the
    // same and only attach a recordingId when a match happens to be found.
    recordingId: v.optional(v.id("recordings")),
    filename: v.string(),
    // Undefined once the raw file has been deleted from disk post-parse
    // (see gpsFiles.clearFilePath) — fixes/accelSamples already extracted
    // into their own tables aren't affected, only the raw download link.
    filePath: v.optional(v.string()),
    parsed: v.boolean(),
    downloadedAt: v.number(),
    // Denormalized peak accelerometer magnitude (g), updated whenever new
    // accelSamples land for this file — lets list views show it without a
    // per-row subscription (100+ rows each with their own query was
    // overwhelming the client and never resolving under write load).
    peakG: v.optional(v.number()),
  })
    .index("by_recordingId", ["recordingId"])
    .index("by_filename", ["filename"])
    .index("by_camera_filename", ["cameraId", "filename"]),

  gpsFixes: defineTable({
    gpsFileId: v.id("gpsFiles"),
    recordingId: v.optional(v.id("recordings")),
    // Denormalized from gpsFiles.cameraId at insert time so journeys.rebuild
    // can cluster trips per camera without a join — optional for rows
    // created before multi-camera support existed.
    cameraId: v.optional(v.id("cameras")),
    timestamp: v.number(),
    lat: v.number(),
    lng: v.number(),
    speedKmh: v.optional(v.number()),
    headingDeg: v.optional(v.number()),
    // Set once this fix has been through the retention job's downsample
    // pass (see gpsRetention.ts) — either kept as a bucket's representative
    // fix, or the bucket had only one fix to begin with. Lets the job skip
    // rows it already processed on the next run.
    downsampled: v.optional(v.boolean()),
  })
    .index("by_gpsFileId", ["gpsFileId"])
    .index("by_recordingId", ["recordingId"])
    .index("by_timestamp", ["timestamp"]),

  // Raw accelerometer (G-sensor) readings from the camera's GPS files —
  // $GSENSOR sentences, sampled at ~15Hz (x/y/z in g, magnitude precomputed
  // so range queries don't need to recompute sqrt over every row).
  accelSamples: defineTable({
    gpsFileId: v.id("gpsFiles"),
    recordingId: v.optional(v.id("recordings")),
    timestamp: v.number(),
    x: v.number(),
    y: v.number(),
    z: v.number(),
    magnitudeG: v.number(),
    // Set once a raw 15Hz second-window has been consolidated down to a
    // single peak sample by the retention job (see accelRetention.ts) — lets
    // the job skip rows it already processed on the next run.
    downsampled: v.optional(v.boolean()),
  })
    .index("by_gpsFileId", ["gpsFileId"])
    .index("by_timestamp", ["timestamp"]),

  // Derived trips built from gpsFixes and persisted so the Journeys list
  // doesn't have to scan and group raw fixes on every load. Rebuilt by a
  // cron job whenever new gpsFixes land.
  journeys: defineTable({
    // Optional so historical trips built before multi-camera support don't
    // break. rebuild clusters fixes per camera, so new trips always set this.
    cameraId: v.optional(v.id("cameras")),
    startTime: v.number(),
    endTime: v.number(),
    durationSeconds: v.number(),
    distanceKm: v.number(),
    maxSpeedKmh: v.number(),
    avgSpeedKmh: v.number(),
    fixCount: v.number(),
    // Nearest named place to the trip's first/last GPS fix, looked up via
    // Overpass at rebuild time (see overpass.nearestPlaceName). Undefined
    // when no named feature was found nearby or the lookup failed.
    startLocation: v.optional(v.string()),
    endLocation: v.optional(v.string()),
  })
    .index("by_startTime", ["startTime"])
    .index("by_endTime", ["endTime"])
    .index("by_cameraId", ["cameraId"]),

  // Live vehicle telemetry relayed by the iOS app from the phone's own
  // GPS/motion sensors (NOT the camera — see LiveTelemetryManager.swift).
  // Exactly one row per camera, upserted at ~1Hz while live tracking is on;
  // the web app's Live page subscribes to it reactively. `trail` is a
  // rolling breadcrumb (appended at most every trailIntervalMs, capped) so
  // a freshly-loaded page still shows where the vehicle has been.
  liveTelemetry: defineTable({
    cameraId: v.id("cameras"),
    // When the phone took the sample (unix ms) — staleness is judged
    // against this, not _creationTime, since MQTT can deliver late.
    timestamp: v.number(),
    lat: v.number(),
    lng: v.number(),
    speedKmh: v.optional(v.number()),
    headingDeg: v.optional(v.number()),
    // Gravity-removed acceleration in g (CoreMotion userAcceleration).
    accelX: v.optional(v.number()),
    accelY: v.optional(v.number()),
    accelZ: v.optional(v.number()),
    gForce: v.optional(v.number()),
    // Peak |g| since the phone's live session started (phone-computed).
    peakG: v.optional(v.number()),
    // Server receive time — lets the UI distinguish "phone stopped
    // sending" from "phone clock is wrong".
    updatedAt: v.number(),
    trail: v.array(
      v.object({
        timestamp: v.number(),
        lat: v.number(),
        lng: v.number(),
        speedKmh: v.optional(v.number()),
      }),
    ),
  }).index("by_cameraId", ["cameraId"]),

  // Tombstones for recordings/gpsFiles deleted via the Journeys screen. The
  // camera has no delete API of its own, so its next listing will report the
  // same filename again — this table lets the poller recognize "already
  // deleted, don't reimport" instead of silently recreating everything a
  // journey delete just removed. Keyed the same way as the upsert lookups
  // (cameraId + filename) it guards.
  deletedFiles: defineTable({
    cameraId: v.id("cameras"),
    filename: v.string(),
  }).index("by_camera_filename", ["cameraId", "filename"]),

  downloadProgress: defineTable({
    filename: v.string(),
    bytesReceived: v.number(),
    totalBytes: v.optional(v.number()),
    bytesPerSecond: v.optional(v.number()),
    status: v.union(
      v.literal("downloading"),
      v.literal("completed"),
      v.literal("failed"),
    ),
    error: v.optional(v.string()),
    updatedAt: v.number(),
  }).index("by_filename", ["filename"]),

  pollEvents: defineTable({
    timestamp: v.number(),
    level: v.union(v.literal("info"), v.literal("warn"), v.literal("error")),
    message: v.string(),
    meta: v.optional(v.string()),
  }).index("by_timestamp", ["timestamp"]),

  events: defineTable({
    recordingId: v.id("recordings"),
    type: v.union(
      v.literal("impact"),
      v.literal("parking"),
      v.literal("manual"),
      v.literal("other"),
    ),
    severity: v.optional(v.string()),
    timestamp: v.number(),
    lat: v.optional(v.number()),
    lng: v.optional(v.number()),
  })
    .index("by_recordingId", ["recordingId"])
    .index("by_timestamp", ["timestamp"]),

  // Singleton settings row (app-wide config editable from the Settings
  // page), e.g. the Overpass API endpoint/key used for OSM speed-limit
  // lookups on the Journeys map. Read via settings.get, written via
  // settings.update — never hardcode this kind of config in the app.
  settings: defineTable({
    overpassUrl: v.optional(v.string()),
    overpassApiKey: v.optional(v.string()),

    // Data retention — how long gpsFixes/accelSamples are kept at full
    // resolution before being thinned out, and when they're deleted
    // entirely. See gpsRetention.ts / accelRetention.ts.
    gpsDownsampleAfterDays: v.optional(v.number()),
    gpsGranularitySeconds: v.optional(v.number()),
    gpsExpireDays: v.optional(v.number()),
    accelDownsampleAfterDays: v.optional(v.number()),
    accelGranularitySeconds: v.optional(v.number()),
    accelExpireDays: v.optional(v.number()),
    // How often the retention cron actually does work (it ticks far more
    // often than this — see retentionScheduler.ts — and self-throttles
    // against this interval plus lastRetentionRunAt).
    retentionIntervalMinutes: v.optional(v.number()),
    lastRetentionRunAt: v.optional(v.number()),

    // Percentage tolerance applied above the posted speed limit before a
    // fix is considered "over limit" on the Journeys map (e.g. 10 means a
    // fix isn't flagged until it exceeds limit * 1.10). See Journeys.tsx.
    speedTolerancePercent: v.optional(v.number()),
  }),
});
