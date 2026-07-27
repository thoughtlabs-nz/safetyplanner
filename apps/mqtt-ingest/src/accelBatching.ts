import { ConvexHttpClient } from "convex/browser";
import { api } from "../../../convex/_generated/api.js";
import type { Id } from "../../../convex/_generated/dataModel.js";
import type { AccelSample } from "./nmeaTarParser.js";

// Convex caps mutation array arguments at 8192 elements and enforces a
// ~4MiB/sec write-rate limit per deployment. A single accelerometer file can
// have 7000-8000+ 15Hz samples, and inserting them all in one mutation call
// can trip either limit (observed directly: "Array length is too long" and
// "TooManyWrites" errors during backfill). Chunking + a small delay between
// chunks keeps each call small and spreads writes out over time.
const CHUNK_SIZE = 500;
const DELAY_BETWEEN_CHUNKS_MS = 150;
const MAX_RETRIES = 5;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function insertAccelSamplesChunked(
  convex: ConvexHttpClient,
  gpsFileId: Id<"gpsFiles">,
  recordingId: Id<"recordings"> | undefined,
  samples: AccelSample[],
): Promise<void> {
  for (let i = 0; i < samples.length; i += CHUNK_SIZE) {
    const chunk = samples.slice(i, i + CHUNK_SIZE);

    let attempt = 0;
    for (;;) {
      try {
        await convex.mutation(api.accelSamples.insertBatch, {
          gpsFileId,
          recordingId,
          samples: chunk,
        });
        break;
      } catch (err) {
        attempt += 1;
        const message = err instanceof Error ? err.message : String(err);
        const isRateLimit = message.includes("TooManyWrites");
        if (!isRateLimit || attempt > MAX_RETRIES) throw err;
        await sleep(DELAY_BETWEEN_CHUNKS_MS * 2 ** attempt);
      }
    }

    await sleep(DELAY_BETWEEN_CHUNKS_MS);
  }
}
