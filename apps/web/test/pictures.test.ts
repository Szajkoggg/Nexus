import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_PICTURE_BYTES, imageType, parsePaths, pictureOk, picturesKey, splitPictures, withPictures } from "../src/pictures.ts";

const PIC = "C:/Users/me/AppData/Local/Temp/p/.nexus/uploads/20261114-120000-abcdef0123.png";
const PIC2 = "C:\\Code\\Game\\.nexus\\uploads\\20261114-120001-0123456789.jpg";

test("the message carries each picture's path on its own line, after the text", () => {
  assert.equal(withPictures("Make the header like this", [PIC]), `Make the header like this\n\n${PIC}`);
  assert.equal(withPictures("Two:", [PIC, PIC2]), `Two:\n\n${PIC}\n${PIC2}`);
  assert.equal(withPictures("", [PIC]), PIC, "pictures alone");
  assert.equal(withPictures("Just text", []), "Just text");
});

test("a sent message shows its picture lines as pictures, and its text without them", () => {
  assert.deepEqual(splitPictures(`Make the header like this\n\n${PIC}`), { text: "Make the header like this", pictures: [PIC] });
  assert.deepEqual(splitPictures(`Two:\r\n\r\n${PIC}\r\n${PIC2}`), { text: "Two:", pictures: [PIC, PIC2] });
  assert.deepEqual(splitPictures(PIC), { text: "", pictures: [PIC] });
  const inline = `see ${PIC} here`;
  assert.deepEqual(splitPictures(inline), { text: inline, pictures: [] }, "a path inside a sentence stays text");
  assert.deepEqual(splitPictures("C:/x/notes/a.png"), { text: "C:/x/notes/a.png", pictures: [] }, "not an upload");
  assert.deepEqual(splitPictures("  keep\n  this  "), { text: "  keep\n  this  ", pictures: [] }, "without pictures the text is as it was");
  // Round trip: what the composer sends is what the chat shows.
  assert.deepEqual(splitPictures(withPictures("Look", [PIC, PIC2])), { text: "Look", pictures: [PIC, PIC2] });
});

test("a file is taken by its first bytes and size, as the server judges: PNG, JPEG, WebP, GIF up to 10 MB", () => {
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);
  const bytes = (s: string) => Uint8Array.from([...s].map((c) => c.charCodeAt(0)));
  assert.equal(imageType(png), "png");
  assert.equal(imageType(Uint8Array.from([0xff, 0xd8, 0xff, 0xe1])), "jpeg");
  assert.equal(imageType(bytes("RIFF\x10\x00\x00\x00WEBPVP8 ")), "webp");
  assert.equal(imageType(bytes("GIF89a\x01\x00")), "gif");
  assert.equal(imageType(bytes("\x00\x00\x00\x18ftypheic")), undefined, "an iPhone HEIC photo");
  assert.equal(imageType(bytes("<svg xmlns=")), undefined, "SVG");
  assert.equal(pictureOk(1000, png), true);
  assert.equal(pictureOk(MAX_PICTURE_BYTES, png), true);
  assert.equal(pictureOk(MAX_PICTURE_BYTES + 1, png), false, "over 10 MB");
  assert.equal(pictureOk(0, png), false, "empty");
  assert.equal(pictureOk(1000, bytes("%PDF-1.7")), false, "a PDF");
});

test("the attached pictures are kept beside the draft, one path per line", () => {
  assert.equal(picturesKey("p/orchestrator"), "p/orchestrator/pictures");
  assert.deepEqual(parsePaths(`${PIC}\n\n${PIC2}\nnot a picture`), [PIC, PIC2]);
  assert.deepEqual(parsePaths(""), []);
});
