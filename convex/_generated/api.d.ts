/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as accelRetention from "../accelRetention.js";
import type * as accelSamples from "../accelSamples.js";
import type * as cameraStatus from "../cameraStatus.js";
import type * as cameras from "../cameras.js";
import type * as crons from "../crons.js";
import type * as dataVolume from "../dataVolume.js";
import type * as dedupeCleanup from "../dedupeCleanup.js";
import type * as deletedFiles from "../deletedFiles.js";
import type * as devices from "../devices.js";
import type * as downloadProgress from "../downloadProgress.js";
import type * as events from "../events.js";
import type * as gpsFiles from "../gpsFiles.js";
import type * as gpsFixes from "../gpsFixes.js";
import type * as gpsRetention from "../gpsRetention.js";
import type * as http from "../http.js";
import type * as journeys from "../journeys.js";
import type * as lib_authz from "../lib/authz.js";
import type * as liveTelemetry from "../liveTelemetry.js";
import type * as overpass from "../overpass.js";
import type * as pollEvents from "../pollEvents.js";
import type * as recordings from "../recordings.js";
import type * as reports from "../reports.js";
import type * as retentionScheduler from "../retentionScheduler.js";
import type * as settings from "../settings.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  accelRetention: typeof accelRetention;
  accelSamples: typeof accelSamples;
  cameraStatus: typeof cameraStatus;
  cameras: typeof cameras;
  crons: typeof crons;
  dataVolume: typeof dataVolume;
  dedupeCleanup: typeof dedupeCleanup;
  deletedFiles: typeof deletedFiles;
  devices: typeof devices;
  downloadProgress: typeof downloadProgress;
  events: typeof events;
  gpsFiles: typeof gpsFiles;
  gpsFixes: typeof gpsFixes;
  gpsRetention: typeof gpsRetention;
  http: typeof http;
  journeys: typeof journeys;
  "lib/authz": typeof lib_authz;
  liveTelemetry: typeof liveTelemetry;
  overpass: typeof overpass;
  pollEvents: typeof pollEvents;
  recordings: typeof recordings;
  reports: typeof reports;
  retentionScheduler: typeof retentionScheduler;
  settings: typeof settings;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
