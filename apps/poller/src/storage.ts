import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";

export type FileCategory = "videos" | "thumbnails" | "gps";

// cameraId is prefixed onto the on-disk filename (not nested into a
// subdirectory) so two cameras' identically-timestamped files never collide,
// while every existing "basename(filePath)" URL builder in the web app keeps
// working unchanged.
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
