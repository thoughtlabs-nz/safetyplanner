// One-off backfill: extract accelerometer samples from GPS files already on
// disk (storage/gps/), without needing the camera online. Run with:
//   npx tsx src/reparseAccel.ts
import { readFile } from "node:fs/promises";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../../convex/_generated/api.js";
import { config } from "./config.js";
import { parseGpsFile } from "./nmeaTarParser.js";
import { insertAccelSamplesChunked } from "./accelBatching.js";

const convex = new ConvexHttpClient(config.convexUrl);

async function main() {
  const gpsFiles = await convex.query(api.gpsFiles.listAll, { limit: 10_000 });
  console.log(`found ${gpsFiles.length} downloaded gps files`);

  let filesWithAccel = 0;
  let totalSamples = 0;

  for (const gpsFile of gpsFiles) {
    try {
      // Safe to re-run: skip files that already have samples stored (a
      // single-item page is enough to check existence cheaply).
      const existing = await convex.query(api.accelSamples.pageForGpsFile, {
        gpsFileId: gpsFile._id,
        paginationOpts: { numItems: 1, cursor: null },
      });
      if (existing.page.length > 0) continue;

      // filePath is cleared once a file's fixes are extracted (see
      // gpsFiles.clearFilePath) — nothing left on disk to reparse.
      if (!gpsFile.filePath) continue;
      const data = await readFile(gpsFile.filePath);
      const { accelSamples } = await parseGpsFile(data);
      if (accelSamples.length === 0) continue;

      await insertAccelSamplesChunked(convex, gpsFile._id, gpsFile.recordingId, accelSamples);

      const peakG = Math.max(...accelSamples.map((s) => s.magnitudeG));
      console.log(
        `${gpsFile.filename}: ${accelSamples.length} samples, peak ${peakG.toFixed(2)}g`,
      );
      filesWithAccel += 1;
      totalSamples += accelSamples.length;
    } catch (err) {
      console.error(`failed on ${gpsFile.filename}:`, err instanceof Error ? err.message : err);
    }
  }

  console.log(`done: ${filesWithAccel} files had accel data, ${totalSamples} samples total`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
