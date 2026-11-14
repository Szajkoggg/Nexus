// Pictures in chat messages (PROTOCOL.md, "Uploads"). The composer uploads a pasted, dropped or attached picture; the
// server saves it under the project's .nexus/uploads/ and answers its absolute path; the message carries each path on
// its own line, after the text. A sent message shows those lines as pictures. The pure part, unit tested.

/** The largest picture taken (the server's limit too). */
export const MAX_PICTURE_BYTES = 10 * 1024 * 1024;
/** What the attach button offers. The type is judged from the bytes all the same (imageType). */
export const PICTURE_ACCEPT = "image/png,image/jpeg,image/webp,image/gif";

// A line that is an uploaded picture's absolute path (the server's rule in codex.ts uploadedPictures, without the file check).
const LINE = /^(?:[A-Za-z]:[\x5c/]|\/).*[\x5c/]\.nexus[\x5c/]uploads[\x5c/][^\x5c/]+\.(?:png|jpe?g|webp|gif)$/i;

/** A message's text without its picture lines, and the pictures' paths, in order. */
export function splitPictures(message: string): { text: string; pictures: string[] } {
  const pictures: string[] = [];
  const kept: string[] = [];
  for (const line of message.split(/\r?\n/)) {
    if (LINE.test(line.trim())) pictures.push(line.trim()); else kept.push(line);
  }
  if (!pictures.length) return { text: message, pictures };
  return { text: kept.join("\n").trimEnd(), pictures };
}

/** The message to send: the typed text, then each picture's path on its own line (after an empty line). */
export function withPictures(text: string, paths: readonly string[]): string {
  if (!paths.length) return text;
  return text.trim() ? `${text}\n\n${paths.join("\n")}` : paths.join("\n");
}

/** The image type from a file's first bytes (its signature): PNG, JPEG, WebP and GIF only, as the server judges. */
export function imageType(b: Uint8Array): "png" | "jpeg" | "webp" | "gif" | undefined {
  const ascii = (from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
  if (b.length >= 8 && b[0] === 0x89 && ascii(1, 4) === "PNG" && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return "png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "webp";
  if (b.length >= 6 && (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a")) return "gif";
  return undefined;
}

/** Whether a file can be sent: a picture of a taken type, by its first bytes, and not over 10 MB. */
export function pictureOk(size: number, head: Uint8Array): boolean {
  return size > 0 && size <= MAX_PICTURE_BYTES && imageType(head) !== undefined;
}

/** The pictures attached to a draft, as stored beside its text (one path per line). */
export const picturesKey = (draft: string) => `${draft}/pictures`;
export const parsePaths = (stored: string): string[] => stored.split("\n").map((l) => l.trim()).filter((l) => LINE.test(l));
