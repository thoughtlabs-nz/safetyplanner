import { createServer, type IncomingMessage } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";

export type PollState = "idle" | "polling";

export type SessionStartResult =
  | { status: "started" }
  | { status: "unknown_ssid" };

interface ControlServerOptions {
  getState: () => PollState;
  triggerPoll: () => void;
  startSession: (ssid: string) => Promise<SessionStartResult>;
  endSession: () => void;
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

const FILE_CATEGORIES = ["videos", "gps", "thumbnails"] as const;

const CONTENT_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gpx": "application/gpx+xml",
};

function contentTypeFor(filename: string): string {
  return CONTENT_TYPES[path.extname(filename).toLowerCase()] ?? "application/octet-stream";
}

// Minimal local-only control surface so the web dashboard can request an
// immediate poll instead of waiting for the interval, and fetch downloaded
// files directly. No auth — assumes this runs on a trusted local machine
// alongside the camera's own WiFi AP.
export function startControlServer({
  getState,
  triggerPoll,
  startSession,
  endSession,
}: ControlServerOptions) {
  const server = createServer((req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === "GET" && req.url === "/status") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ state: getState() }));
      return;
    }

    if (req.method === "POST" && req.url === "/poll-now") {
      const state = getState();
      if (state === "polling") {
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "poll already in progress" }));
        return;
      }
      triggerPoll();
      res.writeHead(202, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "started" }));
      return;
    }

    // Called by the Wi-Fi watcher script running alongside the poller (e.g.
    // on the Raspberry Pi) whenever it joins a camera's network. Takes an
    // SSID rather than a cameraId so the watcher never needs to know about
    // Convex-internal IDs — the poller resolves ssid -> camera itself.
    if (req.method === "POST" && req.url === "/session/start") {
      readJsonBody(req)
        .then(async (body) => {
          const ssid = (body as { ssid?: unknown }).ssid;
          if (typeof ssid !== "string" || !ssid) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "missing ssid" }));
            return;
          }
          const result = await startSession(ssid);
          if (result.status === "unknown_ssid") {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: `no camera registered for ssid ${ssid}` }));
            return;
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "started" }));
        })
        .catch(() => {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "invalid request body" }));
        });
      return;
    }

    if (req.method === "POST" && req.url === "/session/end") {
      endSession();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ended" }));
      return;
    }

    if (req.method === "GET" && req.url?.startsWith("/files/")) {
      serveFile(req.url, res);
      return;
    }

    // Called by the web app after journeys.deleteRange removes the Convex
    // records for a deleted journey, to also clean up the on-disk video/
    // thumbnail/gps files those records pointed at.
    if (req.method === "POST" && req.url === "/files/delete") {
      readJsonBody(req)
        .then(async (body) => {
          const category = (body as { category?: unknown }).category;
          const filename = (body as { filename?: unknown }).filename;
          if (
            typeof category !== "string" ||
            !FILE_CATEGORIES.includes(category as (typeof FILE_CATEGORIES)[number]) ||
            typeof filename !== "string" ||
            !filename
          ) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "invalid category or filename" }));
            return;
          }

          const categoryDir = path.resolve(config.storagePath, category);
          const filePath = path.resolve(categoryDir, filename);
          if (!filePath.startsWith(categoryDir + path.sep)) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "invalid filename" }));
            return;
          }

          await rm(filePath, { force: true });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "deleted" }));
        })
        .catch(() => {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "invalid request body" }));
        });
      return;
    }

    res.writeHead(404);
    res.end();
  });

  server.listen(config.controlPort, "0.0.0.0", () => {
    console.log(`Poller control endpoint listening on http://0.0.0.0:${config.controlPort}`);
  });

  return server;
}

function serveFile(url: string, res: import("node:http").ServerResponse) {
  const [, , category, ...rest] = url.split("/"); // "", "files", category, filename
  const filename = decodeURIComponent(rest.join("/"));

  if (!FILE_CATEGORIES.includes(category as (typeof FILE_CATEGORIES)[number])) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "unknown category" }));
    return;
  }

  const categoryDir = path.resolve(config.storagePath, category);
  const filePath = path.resolve(categoryDir, filename);

  // Reject any path that escapes the category directory (e.g. via "../").
  if (!filePath.startsWith(categoryDir + path.sep)) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "invalid filename" }));
    return;
  }

  if (!existsSync(filePath)) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "file not found" }));
    return;
  }

  const stat = statSync(filePath);
  res.writeHead(200, {
    "Content-Type": contentTypeFor(filePath),
    "Content-Length": stat.size,
  });
  createReadStream(filePath).pipe(res);
}
