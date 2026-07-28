import { ConvexHttpClient } from "convex/browser";
import { api } from "../../../convex/_generated/api.js";
import type { Id } from "../../../convex/_generated/dataModel.js";

// Derived from the Convex mutation's own argument type rather than restated,
// so a field added to convex/lib/obdTelemetry.ts's obdSampleFields is a
// compile error here until it's carried through — the failure mode this
// avoids is a new reading silently never reaching the database.
export type ObdSampleInput = (typeof api.obdSamples.insertBatch)["_args"]["samples"][number];

// The chunking rationale is accelBatching's (Convex caps mutation array args
// at 8192 elements and rate-limits writes), but the numbers are smaller
// here: an OBD sample is ~20 fields against an accel sample's 5, so the same
// row count is a much larger write. A recording session also produces far
// fewer samples overall — one every few seconds rather than 15 a second —
// so a whole drive is typically one or two chunks either way.
const CHUNK_SIZE = 200;
const DELAY_BETWEEN_CHUNKS_MS = 150;
const MAX_RETRIES = 5;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function insertObdSamplesChunked(
  convex: ConvexHttpClient,
  cameraId: Id<"cameras">,
  gpsFileId: Id<"gpsFiles"> | undefined,
  recordingId: Id<"recordings"> | undefined,
  batchId: string,
  samples: ObdSampleInput[],
): Promise<void> {
  for (let i = 0; i < samples.length; i += CHUNK_SIZE) {
    const chunk = samples.slice(i, i + CHUNK_SIZE);

    let attempt = 0;
    for (;;) {
      try {
        await convex.mutation(api.obdSamples.insertBatch, {
          cameraId,
          gpsFileId,
          recordingId,
          batchId,
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
