import { v } from "convex/values";

// Values read from the car over an OBD-II BLE dongle by the iOS app and
// carried on the live telemetry message. Nissan Leaf specific — the PID
// table these are decoded from lives in
// apps/safety-planner-ios/Sources/SafetyPlanner/ObdLeafCommands.swift, and
// the wire shape is mirrored in Models.swift (ObdTelemetry) and
// apps/mqtt-ingest/src/index.ts (ObdTelemetry). Change all four together.
//
// Defined here rather than inline so the liveTelemetry table and the report
// mutation's args validate against one definition — a mismatch between them
// is a runtime rejection of every live sample, which is exactly the sort of
// failure that looks like "the phone stopped publishing".
//
// Every field is optional: each comes from its own PID on its own polling
// interval, so a sample carries the latest value of each rather than a
// simultaneous set, and an unsupported PID is simply always absent.
export const obdReadingFields = {
  // The car's own speedometer, as opposed to the GPS speed alongside it.
  speedKmh: v.optional(v.number()),
  rpm: v.optional(v.number()),
  // Traction motor power in watts; negative under regenerative braking.
  motorPowerW: v.optional(v.number()),
  gearPosition: v.optional(v.string()),
  powerSwitchOn: v.optional(v.boolean()),
  bat12vVoltage: v.optional(v.number()),
  ambientTempC: v.optional(v.number()),
  ecoMode: v.optional(v.boolean()),
  ePedalMode: v.optional(v.boolean()),
  odometerKm: v.optional(v.number()),
  rangeRemainingKm: v.optional(v.number()),
  tyrePressureFrontLeftKpa: v.optional(v.number()),
  tyrePressureFrontRightKpa: v.optional(v.number()),
  tyrePressureRearLeftKpa: v.optional(v.number()),
  tyrePressureRearRightKpa: v.optional(v.number()),
  // High-voltage traction battery, from the Li-ion battery controller.
  stateOfChargePct: v.optional(v.number()),
  batteryHealthPct: v.optional(v.number()),
  batteryCapacityAh: v.optional(v.number()),
  batteryVoltage: v.optional(v.number()),
  batteryCurrentA: v.optional(v.number()),
};

// The live-telemetry flavour: the readings plus when the newest of them was
// taken. Only meaningful on the single latest-value row, where "how stale is
// this" is a question worth answering.
export const obdTelemetryValidator = v.object({
  ...obdReadingFields,
  // Phone-side time of the newest reading in this group, unix ms.
  updatedAt: v.optional(v.number()),
});

// The recorded flavour: the same readings stamped with the time they were
// taken, for the obdSamples history table. `updatedAt` would be redundant
// here — `timestamp` IS the reading time for a recorded sample, whereas on
// the live row it distinguishes "the phone reported" from "the car answered".
export const obdSampleFields = {
  ...obdReadingFields,
  timestamp: v.number(),
};

export const obdSampleValidator = v.object(obdSampleFields);
