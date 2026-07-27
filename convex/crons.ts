import { cronJobs } from "convex/server";
import { api } from "./_generated/api";

const crons = cronJobs();

// Keeps gpsFixes/accelSamples from growing unbounded (15Hz accel data alone
// adds up to ~1.3M rows/day of continuous recording). Ticks every 15
// minutes but only does real work when the user's configured interval
// (Settings > Data Retention) has elapsed — see retentionScheduler.ts for
// why this indirection exists. Each actual run only processes a bounded
// number of pages (see gpsRetention.ts / accelRetention.ts), so a large
// backlog is worked down gradually rather than all at once.
crons.interval(
  "data retention",
  { minutes: 15 },
  api.retentionScheduler.runIfDue,
);

// Rebuild derived journeys whenever new gpsFixes land, so the Journeys list
// stays fast without recomputing trips on every page load.
crons.interval(
  "rebuild journeys",
  { minutes: 5 },
  api.journeys.rebuild,
);

export default crons;
