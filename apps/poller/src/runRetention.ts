// Manually triggers one round of the accelSamples retention job (downsample
// + expire). Safe to run repeatedly — each call only processes a bounded
// number of pages, so run it a few times in a row to work down a backlog
// faster than waiting for the daily cron.
// Usage: npx tsx src/runRetention.ts
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../../convex/_generated/api.js";
import { config } from "./config.js";

const convex = new ConvexHttpClient(config.convexUrl);

async function main() {
  const result = await convex.action(api.accelRetention.runRetention, {});
  console.log(result);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
