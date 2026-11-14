// Pictures the user adds to a chat message (PROTOCOL.md, "Uploads"). Browsers do not reveal a file's path, so the
// dashboard sends the picture itself, base64 in a JSON body (writes stay JSON-only), and the server saves it under the
// project's .nexus/uploads/; the message then carries the saved file's absolute path, which the agent opens.
// The server is the folder's only writer. The type is judged from the bytes, never from a name or a declared type, and
// the file is named by the server: no client-supplied name ever reaches the disk.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The largest picture taken, decoded. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
/**
 * The largest request body, checked before anything is parsed: 10 MB is about 13.4 MB of base64, and the rest is room
 * for the JSON around it (a data: URL prefix, the field name).
 */
export const MAX_UPLOAD_BODY = 14 * 1024 * 1024;

export type ImageType = "png" | "jpeg" | "webp" | "gif";
const EXT: Record<ImageType, string> = { png: ".png", jpeg: ".jpg", webp: ".webp", gif: ".gif" };

/** The image type from the file's first bytes (its signature), or undefined: PNG, JPEG, WebP and GIF only. */
export function imageType(b: Uint8Array): ImageType | undefined {
  const ascii = (from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
  if (b.length >= 8 && b[0] === 0x89 && ascii(1, 4) === "PNG" && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return "png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "webp";
  if (b.length >= 6 && (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a")) return "gif";
  return undefined;
}

/** The file name: the time it was taken (UTC) and a short hash of its bytes, with the detected type's extension. */
export function uploadName(bytes: Uint8Array, type: ImageType, at = new Date()): string {
  const t = at.toISOString(); // 2026-11-14T15:30:12.345Z
  const stamp = `${t.slice(0, 10).replaceAll("-", "")}-${t.slice(11, 19).replaceAll(":", "")}`;
  const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 10);
  return `${stamp}-${hash}${EXT[type]}`;
}

export class UploadError extends Error {
  readonly status: 400 | 413 | 415;
  constructor(message: string, status: 400 | 413 | 415) { super(message); this.status = status; }
}

/**
 * Checks and saves a picture under `<nexusDir>/uploads/`; answers its absolute path. `data` is base64, optionally as
 * a data: URL (whose declared type is ignored: the bytes decide).
 */
export function saveUpload(nexusDir: string, data: unknown, at = new Date()): { path: string; type: ImageType; bytes: number } {
  if (typeof data !== "string" || !data) throw new UploadError("data (the picture, base64) is required", 400);
  const b64 = data.startsWith("data:") ? data.slice(data.indexOf(",") + 1) : data;
  if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(b64)) throw new UploadError("data is not base64", 400);
  const bytes = Buffer.from(b64, "base64");
  if (bytes.length > MAX_UPLOAD_BYTES) throw new UploadError("only PNG, JPEG, WebP or GIF up to 10 MB", 413);
  const type = imageType(bytes);
  if (!type) throw new UploadError("only PNG, JPEG, WebP or GIF up to 10 MB", 415);
  const dir = join(nexusDir, "uploads");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, uploadName(bytes, type, at));
  // The same picture in the same second has the same name and the same bytes: the file is already there.
  if (!existsSync(path)) {
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, bytes);
    renameSync(tmp, path);
  }
  return { path: path.replaceAll("\\", "/"), type, bytes: bytes.length };
}
