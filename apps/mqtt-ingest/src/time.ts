// Copied from apps/poller/src/ddpaiClient.ts — the camera's starttime/endtime
// fields come back as either a unix epoch (seconds) or a
// "yyyy-MM-dd HH:mm:ss"-style string depending on firmware, and a phone
// bridge forwarding the camera's raw list JSON verbatim hits the exact same
// ambiguity, so the same coercion applies here.

// The camera has no timezone concept — it stamps its own wall-clock (New
// Zealand local) into the string with no offset marker. A bare
// `Date.parse` on an offset-less datetime string is defined by the JS spec
// to use the RUNNING PROCESS's local timezone, which is UTC on most
// servers — that silently produced timestamps off by NZ's UTC+12 (NZST) or
// UTC+13 (NZDT) offset instead of the camera's real recording time. This
// explicitly converts from Pacific/Auckland to true UTC instead, using
// Intl's timezone database so it stays correct across DST transitions.
function nzOffsetMs(instant: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Pacific/Auckland",
    timeZoneName: "shortOffset",
  }).formatToParts(instant);
  const offsetName = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT+12";
  const match = offsetName.match(/GMT([+-]\d+)(?::(\d+))?/);
  if (!match) return 12 * 60 * 60 * 1000; // NZST fallback
  const hours = Number(match[1]);
  const minutes = match[2] ? Number(match[2]) : 0;
  const sign = hours < 0 ? -1 : 1;
  return (hours * 60 + sign * minutes) * 60 * 1000;
}

// The camera's numeric "epoch" fields carry the same wall-clock bug as its
// datetime strings: confirmed on real hardware that starttime 1784982684
// decodes to 12:31:24 UTC while the matching filename (20260725123124_*)
// shows 12:31:24 was the camera's NZ LOCAL clock — i.e. the camera encodes
// local wall-time as if it were a UTC epoch. Both paths therefore need the
// same Pacific/Auckland correction.
function localAsUtcToRealMs(naiveAsUtcMs: number): number {
  return naiveAsUtcMs - nzOffsetMs(new Date(naiveAsUtcMs));
}

export function parseCameraTime(value: string | number): number {
  if (typeof value === "number") {
    return localAsUtcToRealMs(value < 10_000_000_000 ? value * 1000 : value);
  }
  const numeric = Number(value);
  if (!Number.isNaN(numeric) && /^\d+$/.test(value.trim())) {
    return localAsUtcToRealMs(numeric < 10_000_000_000 ? numeric * 1000 : numeric);
  }
  const naiveAsUtcMs = Date.parse(`${value.replace(" ", "T")}Z`);
  if (Number.isNaN(naiveAsUtcMs)) return Date.now();
  return localAsUtcToRealMs(naiveAsUtcMs);
}
