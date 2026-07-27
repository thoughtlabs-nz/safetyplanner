import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";

export type FileCategory = "thumbnails" | "gps";

// Mirrors apps/poller/src/storage.ts's naming scheme exactly (cameraId
// prefixed onto the filename, not nested in a subdirectory) — this app
// writes into the same shared storage volume, and the poller's control
// server is what actually serves these files back to the web app, so the
// on-disk layout must match byte-for-byte or existing download links break.
export async function saveFile(
  category: FileCategory,
  filename: string,
  data: Buffer,
  cameraId: string,
): Promise<string> {
  const dir = path.resolve(config.storagePath, category);
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${cameraId}_${filename}`);
  await writeFile(filePath, data);
  return filePath;
}

export async function deleteFile(filePath: string): Promise<void> {
  await rm(filePath, { force: true });
}
