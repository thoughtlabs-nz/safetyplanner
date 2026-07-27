import { extract } from "tar-stream";
import { Readable } from "node:stream";

export interface GpsFix {
  timestamp: number;
  lat: number;
  lng: number;
  speedKmh?: number;
  headingDeg?: number;
}

export interface AccelSample {
  timestamp: number;
  x: number;
  y: number;
  z: number;
  magnitudeG: number;
}

const KNOTS_TO_KMH = 1.852;

/**
 * Converts an NMEA lat/lon field (ddmm.mmmm for latitude, dddmm.mmmm for
 * longitude) plus its hemisphere letter into signed decimal degrees.
 */
function toDecimalDegrees(raw: string, hemisphere: string): number {
  const value = Number(raw);
  const degrees = Math.floor(value / 100);
  const minutes = value - degrees * 100;
  const decimal = degrees + minutes / 60;
  return hemisphere === "S" || hemisphere === "W" ? -decimal : decimal;
}

/**
 * Parses $GPRMC sentences (the ones carrying a full date) into fixes.
 * $GPRMC,hhmmss.ss,status,lat,N/S,lon,E/W,speedKnots,course,ddmmyy,...
 */
function parseNmeaText(text: string): GpsFix[] {
  const fixes: GpsFix[] = [];
  for (const line of text.split(/[\r\n]+/)) {
    if (!line.startsWith("$GPRMC")) continue;
    const fields = line.split(",");
    if (fields.length < 10) continue;

    const [, time, status, lat, ns, lon, ew, speedKnots, course, date] = fields;
    if (status !== "A" || !lat || !lon || !date || !time) continue;

    const day = date.slice(0, 2);
    const month = date.slice(2, 4);
    const year = `20${date.slice(4, 6)}`;
    const hour = time.slice(0, 2);
    const minute = time.slice(2, 4);
    const second = time.slice(4, 6);
    const timestamp = Date.parse(
      `${year}-${month}-${day}T${hour}:${minute}:${second}Z`,
    );
    if (Number.isNaN(timestamp)) continue;

    fixes.push({
      timestamp,
      lat: toDecimalDegrees(lat, ns),
      lng: toDecimalDegrees(lon, ew),
      speedKmh: speedKnots ? Number(speedKnots) * KNOTS_TO_KMH : undefined,
      headingDeg: course ? Number(course) : undefined,
    });
  }
  return fixes;
}

/**
 * Parses "$GSENSORSTARTTIME yyyyMMddHHmmss" — the camera's own wall clock
 * (NZ local, same convention as its other local-time fields; see
 * parseCameraTime's Pacific/Auckland handling) — into a real unix-ms epoch.
 */
function parseCameraWallClockMs(raw: string): number | null {
  if (raw.length < 14) return null;
  const naiveAsUtcMs = Date.parse(
    `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}T` +
      `${raw.slice(8, 10)}:${raw.slice(10, 12)}:${raw.slice(12, 14)}Z`,
  );
  if (Number.isNaN(naiveAsUtcMs)) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Pacific/Auckland",
    timeZoneName: "shortOffset",
  }).formatToParts(new Date(naiveAsUtcMs));
  const offsetName = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT+12";
  const match = offsetName.match(/GMT([+-]\d+)(?::(\d+))?/);
  const hours = match ? Number(match[1]) : 12;
  const minutes = match?.[2] ? Number(match[2]) : 0;
  const sign = hours < 0 ? -1 : 1;
  return naiveAsUtcMs - (hours * 60 + sign * minutes) * 60 * 1000;
}

/**
 * Parses $GSENSOR sentences — raw accelerometer readings, in either of two
 * observed dialects (distinguished by field count; keep in sync with the
 * iOS NmeaParser.swift copy):
 *  - v1: $GSENSOR,x,y,z,timestampMs — x/y/z in MILLI-g, per-sample unix-ms
 *    timestamp, ~15Hz.
 *  - v2: a "$GSENSORSTARTTIME yyyyMMddHHmmss" header (camera wall clock)
 *    plus "$GSENSORDATAFREQUENCY 50 v2.0", then timestamp-less
 *    $GSENSOR,x,y,z samples ALREADY IN g at the stated rate, interleaved
 *    with $GYRO lines (ignored). Timestamps derived as start + index/rate.
 */
function parseAccelText(text: string): AccelSample[] {
  const samples: AccelSample[] = [];
  let v2StartMs: number | null = null;
  let v2FrequencyHz = 50;
  let v2SampleIndex = 0;

  for (const line of text.split(/[\r\n]+/)) {
    if (line.startsWith("$GSENSORSTARTTIME")) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 2) v2StartMs = parseCameraWallClockMs(parts[1]);
      continue;
    }
    if (line.startsWith("$GSENSORDATAFREQUENCY")) {
      const parts = line.trim().split(/\s+/);
      const f = parts.length >= 2 ? Number(parts[1]) : NaN;
      if (!Number.isNaN(f) && f > 0) v2FrequencyHz = f;
      continue;
    }
    if (!line.startsWith("$GSENSOR,")) continue;
    const fields = line.split(",");

    if (fields.length >= 5) {
      // v1: milli-g + explicit per-sample timestamp
      const [, xRaw, yRaw, zRaw, tsRaw] = fields;
      const x = Number(xRaw);
      const y = Number(yRaw);
      const z = Number(zRaw);
      const timestamp = Number(tsRaw);
      if ([x, y, z, timestamp].some(Number.isNaN)) continue;
      samples.push({
        timestamp,
        x: x / 1000,
        y: y / 1000,
        z: z / 1000,
        magnitudeG: Math.sqrt(x * x + y * y + z * z) / 1000,
      });
    } else if (fields.length === 4 && v2StartMs !== null) {
      // v2: already in g, timestamp derived from header + rate
      const x = Number(fields[1]);
      const y = Number(fields[2]);
      const z = Number(fields[3]);
      if ([x, y, z].some(Number.isNaN)) continue;
      const timestamp = v2StartMs + (v2SampleIndex * 1000) / v2FrequencyHz;
      v2SampleIndex += 1;
      samples.push({
        timestamp,
        x,
        y,
        z,
        magnitudeG: Math.sqrt(x * x + y * y + z * z),
      });
    }
  }
  return samples;
}

async function extractTarEntries(data: Buffer): Promise<string[]> {
  const texts: string[] = [];

  await new Promise<void>((resolve, reject) => {
    const extractor = extract();

    extractor.on("entry", (_header, stream, next) => {
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("end", () => {
        texts.push(Buffer.concat(chunks).toString("utf-8"));
        next();
      });
      stream.on("error", reject);
      stream.resume();
    });

    extractor.on("finish", resolve);
    extractor.on("error", reject);

    Readable.from(data).pipe(extractor);
  });

  return texts;
}

/**
 * The camera's GPS file list returns two different physical formats under
 * the same API, observed on real hardware:
 *  - "_0480"-suffixed files are tar archives (despite the .gpx/.git
 *    extension) bundling one plain-text NMEA log per minute segment.
 *  - "_0060"-suffixed files are a single plain-text NMEA log directly, no
 *    tar wrapper at all.
 * Both contain a `$GPSCAMTIME` header followed by per-second
 * $GPRMC/$GPGGA sentence pairs. Rather than branch on filename (unconfirmed
 * to be a reliable signal), try tar extraction first and fall back to
 * treating the bytes as raw NMEA text if that fails.
 */
export interface ParsedGpsFile {
  fixes: GpsFix[];
  accelSamples: AccelSample[];
}

export async function parseGpsFile(data: Buffer): Promise<ParsedGpsFile> {
  let texts: string[];
  try {
    texts = await extractTarEntries(data);
  } catch {
    texts = [data.toString("utf-8")];
  }

  const fixes = texts.flatMap(parseNmeaText).sort((a, b) => a.timestamp - b.timestamp);
  const accelSamples = texts
    .flatMap(parseAccelText)
    .sort((a, b) => a.timestamp - b.timestamp);

  return { fixes, accelSamples };
}
