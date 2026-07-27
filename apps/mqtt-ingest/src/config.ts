import "dotenv/config";

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required env var ${name}`);
  }
  return value;
}

export const config = {
  // Must point at the same disk the poller's controlServer serves from
  // (STORAGE_PATH there) — the web app only ever fetches files through the
  // poller's /files/* endpoint, so anything this app saves needs to land on
  // that same volume under the same category subfolders for the existing
  // download links to work unmodified.
  storagePath: process.env.STORAGE_PATH ?? "../../storage",
  convexUrl: required("CONVEX_URL", process.env.VITE_CONVEX_URL),
  mqttUrl: required("MQTT_URL"),
  mqttUsername: process.env.MQTT_USERNAME,
  mqttPassword: process.env.MQTT_PASSWORD,
  mqttClientId: process.env.MQTT_CLIENT_ID ?? "mqtt-ingest",
  // Topic layout: `${topicPrefix}/{ssid}/{status|playback|events|gpsfile|thumbnail}`
  // — ssid (not a Convex id) is the identifier because that's all a phone
  // bridge knows for certain after joining the camera's AP, matching how the
  // poller's own /session/start already resolves ssid -> camera.
  topicPrefix: process.env.MQTT_TOPIC_PREFIX ?? "ddpai",
};
