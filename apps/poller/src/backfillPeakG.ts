// One-off migration: rolls up peakG on gpsFiles docs whose accelSamples
// were inserted before insertBatch started patching peakG automatically.
// Run with: npx tsx src/backfillPeakG.ts
import { ConvexHttpClient } from "convex/browser";
import type { PaginationResult } from "convex/server";
import { api } from "../../../convex/_generated/api.js";
import type { Doc } from "../../../convex/_generated/dataModel.js";
import { config } from "./config.js";

const convex = new ConvexHttpClient(config.convexUrl);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const gpsFiles = await convex.query(api.gpsFiles.listAll, { limit: 10_000 });
  console.log(`checking ${gpsFiles.length} gps files`);

  let updated = 0;
  for (const gpsFile of gpsFiles) {
    // Paginate instead of collecting all samples at once — a single file
    // can hold 7000-8000+ samples, enough to hit Convex's per-query
    // operation limit if fetched in one go.
    let peakG: number | null = null;
    let cursor: string | null = null;
    for (;;) {
      // Explicit annotation: `cursor` is assigned from `result` below, and
      // letting inference chase that loop through the generated query types
      // trips TS7022 (implicit any from self-referencing initializer).
      const result: PaginationResult<Doc<"accelSamples">> = await convex.query(api.accelSamples.pageForGpsFile, {
        gpsFileId: gpsFile._id,
        paginationOpts: { numItems: 1000, cursor },
      });
      for (const sample of result.page) {
        if (peakG === null || sample.magnitudeG > peakG) peakG = sample.magnitudeG;
      }
      if (result.isDone) break;
      cursor = result.continueCursor;
    }
    if (peakG === null) continue;

    if (gpsFile.peakG != null && gpsFile.peakG >= peakG) continue;

    await convex.mutation(api.gpsFiles.setPeakG, { id: gpsFile._id, peakG });
    console.log(`${gpsFile.filename}: peakG = ${peakG.toFixed(2)}g`);
    updated += 1;
    await sleep(50);
  }

  console.log(`done: updated ${updated} files`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
