// Port of the DDPAI CGI protocol from hansaya/ddpai_downloader (MIT licensed).
// The camera exposes a proprietary JSON-over-HTTP API at /vcam/cmd.cgi.
// Every response is wrapped as { errcode, data } where `data` is itself a
// JSON string that must be parsed again into the real per-endpoint struct.

import http from "node:http";

const DEFAULT_UID = "f2cf6a332999fbc3";

export interface DdpaiClientOptions {
  camUrl: string; // e.g. http://193.168.0.1
  timeoutMs?: number;
}

// Field names below match the Go client's per-endpoint structs exactly
// (confirmed against upstream source). The camera's JSON encodes every field
// as a string regardless of its logical type — including size fields — so
// callers must coerce with Number(...) rather than trusting these types.
export interface PlaybackEntry {
  index: number;
  starttime: string | number;
  endtime: string | number;
  name: string;
  size?: string | number;
}

export interface EventEntry {
  index: number;
  imgname?: string;
  bvideoname: string;
  bstarttime: string | number;
  bendtime: string | number;
  bvideosize?: string | number;
}

export interface GpsFileEntry {
  index: number;
  type?: string;
  starttime: string | number;
  endtime: string | number;
  name: string;
  parentfile: string;
}

interface CgiEnvelope {
  errcode: number;
  data: string;
}

export class DdpaiClient {
  private camUrl: string;
  private timeoutMs: number;
  private sessionId: string | null = null;

  constructor(opts: DdpaiClientOptions) {
    this.camUrl = opts.camUrl.replace(/\/$/, "");
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  // GET-only calls (session request + all list endpoints). These send a
  // `sessionid` header once authenticated, but no Cookie and no Content-Type
  // — matching the upstream Go client exactly.
  private async cgiGet<T>(cmd: string): Promise<T> {
    const url = `${this.camUrl}/vcam/cmd.cgi?cmd=${cmd}`;
    const headers: Record<string, string> = {};
    if (this.sessionId) {
      headers["sessionid"] = this.sessionId;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, { method: "GET", headers, signal: controller.signal });
      if (!res.ok) {
        throw new Error(`${cmd} failed: HTTP ${res.status}`);
      }
      const envelope = (await res.json()) as CgiEnvelope;
      if (envelope.errcode !== 0) {
        throw new Error(`${cmd} failed: errcode ${envelope.errcode}`);
      }
      return JSON.parse(envelope.data) as T;
    } finally {
      clearTimeout(timeout);
    }
  }

  // API_RequestCertificate is a POST with Cookie + sessionid + Content-Type,
  // but its response body is NOT the standard {errcode,data} envelope — the
  // upstream Go client fetches it and discards it unparsed. Do the same:
  // just check the HTTP status, never try to JSON-parse the body.
  private async cgiPostRaw(cmd: string, body: unknown): Promise<void> {
    const url = `${this.camUrl}/vcam/cmd.cgi?cmd=${cmd}`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Cookie: `SessionID=${this.sessionId ?? ""}`,
      sessionid: this.sessionId ?? "",
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`${cmd} failed: HTTP ${res.status}`);
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Checks camera reachability without requiring an authenticated session. */
  async isReachable(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      await fetch(`${this.camUrl}/vcam/cmd.cgi?cmd=API_RequestSessionID`, {
        signal: controller.signal,
      });
      clearTimeout(timeout);
      return true;
    } catch {
      return false;
    }
  }

  async authenticate(): Promise<void> {
    const session = await this.cgiGet<{ acSessionId: string }>("API_RequestSessionID");
    this.sessionId = session.acSessionId;

    await this.cgiPostRaw("API_RequestCertificate", {
      user: "admin",
      password: "admin",
      level: 0,
      uid: DEFAULT_UID,
    });
  }

  async listPlayback(): Promise<PlaybackEntry[]> {
    const result = await this.cgiGet<{ num?: number; file?: PlaybackEntry[] }>(
      "APP_PlaybackListReq",
    );
    return result.file ?? [];
  }

  async listEvents(): Promise<EventEntry[]> {
    const result = await this.cgiGet<{ num?: number; event?: EventEntry[] }>(
      "APP_EventListReq",
    );
    return result.event ?? [];
  }

  async listGpsFiles(): Promise<GpsFileEntry[]> {
    const result = await this.cgiGet<{ num?: number; file?: GpsFileEntry[] }>(
      "API_GpsFileListReq",
    );
    return result.file ?? [];
  }

  /**
   * Downloads a raw file (video, thumbnail, or GPS sidecar) as a Buffer.
   * Recordings from this camera are large (100s of MB) and the AP link is
   * slow (~0.5MB/s observed), so a single download can take many minutes —
   * that's normal, not a hang. `onProgress` reports periodic byte counts so
   * callers can log liveness; `setTimeout` below is inactivity-based (resets
   * on each received chunk), not a hard cap on total transfer time.
   */
  async downloadFile(
    filename: string,
    onProgress?: (info: { bytesReceived: number; totalBytes?: number }) => void,
  ): Promise<Buffer> {
    const url = `${this.camUrl}/${filename}`;

    // Stall timeout: aborts only if no data arrives for this long, not a cap
    // on total download time.
    const stallTimeoutMs = Math.max(this.timeoutMs, 30_000);

    return new Promise<Buffer>((resolve, reject) => {
      const req = http.get(url, { headers: { Connection: "close" } }, (res) => {
        const status = res.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          res.resume();
          reject(new Error(`download ${filename} failed: HTTP ${status}`));
          return;
        }
        const totalBytes = Number(res.headers["content-length"]) || undefined;
        const chunks: Buffer[] = [];
        let bytesReceived = 0;
        res.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
          bytesReceived += chunk.length;
          onProgress?.({ bytesReceived, totalBytes });
        });
        res.on("end", () => resolve(Buffer.concat(chunks)));
        res.on("error", reject);
      });

      req.setTimeout(stallTimeoutMs, () => {
        req.destroy(new Error(`download ${filename} stalled (no data for ${stallTimeoutMs}ms, url: ${url})`));
      });
      req.on("error", reject);
    });
  }
}

/**
 * The camera's starttime/endtime fields come back as either a unix epoch
 * (seconds) or a "yyyy-MM-dd HH:mm:ss"-style string depending on firmware —
 * handle both rather than assuming one.
 *
 * The camera has no timezone concept — it stamps its own wall-clock (New
 * Zealand local) into the string with no offset marker. A bare
 * `Date.parse` on an offset-less datetime string is defined by the JS spec
 * to use the RUNNING PROCESS's local timezone, which is UTC on most
 * servers — that silently produced timestamps off by NZ's UTC+12 (NZST) or
 * UTC+13 (NZDT) offset instead of the camera's real recording time. This
 * explicitly converts from Pacific/Auckland to true UTC instead, using
 * Intl's timezone database so it stays correct across DST transitions.
 */
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
    // Heuristic: treat as seconds if it's too small to plausibly be ms.
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
