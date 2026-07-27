import "dotenv/config";

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required env var ${name}`);
  }
  return value;
}

export const config = {
  storagePath: process.env.STORAGE_PATH ?? "../../storage",
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS ?? 60_000),
  timeoutMs: Number(process.env.TIMEOUT_MS ?? 10_000),
  controlPort: Number(process.env.CONTROL_PORT ?? 4100),
  convexUrl: required("CONVEX_URL", process.env.VITE_CONVEX_URL),
};
