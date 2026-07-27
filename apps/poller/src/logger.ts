import { ConvexHttpClient } from "convex/browser";
import { api } from "../../../convex/_generated/api.js";

type Level = "info" | "warn" | "error";

export function createLogger(convex: ConvexHttpClient) {
  async function log(level: Level, message: string, meta?: unknown) {
    const metaStr = meta !== undefined ? JSON.stringify(meta) : undefined;
    const consoleFn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
    consoleFn(`[${level}] ${message}`, meta ?? "");
    try {
      await convex.mutation(api.pollEvents.log, { level, message, meta: metaStr });
    } catch (err) {
      // Don't let a logging failure (e.g. Convex briefly unreachable) crash the poll cycle.
      console.error("failed to persist poll event", err);
    }
  }

  return {
    info: (message: string, meta?: unknown) => log("info", message, meta),
    warn: (message: string, meta?: unknown) => log("warn", message, meta),
    error: (message: string, meta?: unknown) => log("error", message, meta),
  };
}
