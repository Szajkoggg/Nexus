// Keyed review pictures: counterparts, the refusals of a wrong pair, and the pixel size read from the file's bytes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkPicture, counterpartOf, pictureSize, type KeyedLike, type NewPicture } from "../src/pictures.ts";

const at = (width: number, height: number) => ({ width, height });
const pic = (p: Partial<NewPicture> & Pick<NewPicture, "key" | "role">): NewPicture => ({ path: "/new.png", round: 1, size: at(984, 1600), ...p });

test("an after pairs with the latest before or mockup of its key, else with its key's after of the latest earlier round", () => {
  const items: KeyedLike[] = [
    { path: "/b390.png", key: "waiting-tab@390", role: "before", round: 1 },
    { path: "/b.png", key: "waiting-tab@492", role: "before", round: 1 },
    { path: "/m.png", key: "settings@492", role: "mockup", round: 1 },
    { path: "/a1.png", key: "digest@492", role: "after", round: 1 },
    { path: "/a2.png", key: "digest@492", role: "after", round: 2 },
    { path: "/a2b.png", key: "digest@492", role: "after", round: 2 },
  ];
  const c = (p: KeyedLike) => { const x = counterpartOf(items, p); return x && [x.item.path, x.compare]; };
  assert.deepEqual(c({ key: "waiting-tab@492", role: "after", round: 1 }), ["/b.png", "before"], "same key only, never the 390 one");
  assert.deepEqual(c({ key: "settings@492", role: "after", round: 3 }), ["/m.png", "mockup"]);
  assert.deepEqual(c({ key: "digest@492", role: "after", round: 3 }), ["/a2b.png", "round"], "the latest earlier round, the one added last");
  assert.deepEqual(c({ key: "digest@492", role: "after", round: 2 }), ["/a1.png", "round"]);
  assert.equal(c({ key: "digest@492", role: "after", round: 1 }), undefined, "no earlier round");
  assert.equal(c({ key: "digest@492", role: "after" }), undefined, "without a round no round pairing");
  // A new screen: round 1's result is what round 2's after is compared with.
  assert.deepEqual(counterpartOf([{ path: "/r1.png", key: "usage@492", role: "result", round: 1 }], { key: "usage@492", role: "after", round: 2 })?.compare, "round");
  // A before added later in the step wins over the earlier round's after.
  assert.deepEqual(counterpartOf([...items, { path: "/db.png", key: "digest@492", role: "before", round: 2 }], { key: "digest@492", role: "after", round: 3 })?.compare, "before");
});

test("variant-b pairs with variant-a; before, mockup, variant-a, result and unkeyed pictures have no counterpart", () => {
  const items: KeyedLike[] = [{ path: "/va.png", key: "rail@1280", role: "variant-a" }, { path: "/r.png", key: "rail@1280", role: "result" }];
  assert.deepEqual(counterpartOf(items, { key: "rail@1280", role: "variant-b" })?.item.path, "/va.png");
  assert.equal(counterpartOf(items, { key: "rail@492", role: "variant-b" }), undefined);
  for (const role of ["before", "mockup", "variant-a", "result"] as const) assert.equal(counterpartOf(items, { key: "rail@1280", role }), undefined, role);
  assert.equal(counterpartOf(items, { path: "/x.png" }), undefined, "no key");
});

test("a keyed picture is accepted with a counterpart of the same pixel size, or with a role that needs none", () => {
  const items: KeyedLike[] = [{ path: "/b.png", key: "waiting-tab@492", role: "before", round: 1, size: at(984, 1600) }];
  const ok = checkPicture(items, pic({ key: "waiting-tab@492", role: "after" }), "RS/RS1");
  assert.ok(ok.ok && ok.counterpart?.item.path === "/b.png");
  for (const role of ["before", "mockup", "variant-a", "result"] as const) assert.deepEqual(checkPicture([], pic({ key: "new-view@492", role }), "RS/RS1"), { ok: true }, role);
});

test("refusals: the key format, another key, a missing counterpart, another pixel size; each points to nexus help review", () => {
  const items: KeyedLike[] = [
    { path: "/b390.png", key: "waiting-tab@390", role: "before", round: 1, size: at(780, 1600) },
    { path: "/m.png", key: "settings@492", role: "mockup", round: 1, size: at(984, 1600) },
    { path: "/va.png", key: "rail@1280", role: "variant-a", round: 1, size: at(2560, 1600) },
  ];
  const refused = (p: NewPicture) => { const r = checkPicture(items, p, "RS/RS1"); assert.ok(!r.ok); assert.match(r.message, /See: nexus help review$/); return r; };

  for (const key of ["Waiting-Tab@492", "waiting tab@492", "waiting-tab", "waiting-tab@0", "@492", "waiting--tab@492"]) {
    assert.equal(refused(pic({ key, role: "result" })).reason, "key-format", key);
  }
  const other = refused(pic({ key: "waiting-tab@492", role: "after" }));
  assert.equal(other.reason, "other-key");
  assert.match(other.message, /waiting-tab@390 \(before\), another key/);

  const missing = refused(pic({ key: "digest@492", role: "after" }));
  assert.equal(missing.reason, "missing");
  assert.match(missing.message, /\(the step has waiting-tab@390 \(before\), settings@492 \(mockup\)\)/);
  assert.match(missing.message, /--role result/);
  assert.equal(refused(pic({ key: "rail@492", role: "variant-b" })).reason, "other-key", "the variant-a of the same view at another width");
  assert.equal(refused(pic({ key: "header@492", role: "variant-b" })).reason, "missing");

  const size = refused(pic({ key: "settings@492", role: "after", size: at(984, 2400) }));
  assert.equal(size.reason, "size");
  assert.match(size.message, /984×2400 px, its mockup \(\/m\.png\) is 984×1600 px/);
  assert.equal(refused(pic({ key: "rail@1280", role: "variant-b", size: at(2560, 1500) })).reason, "size");
  // An earlier round's after of other size.
  const round = checkPicture([{ path: "/a1.png", key: "digest@492", role: "after", round: 1, size: at(984, 1600) }], pic({ key: "digest@492", role: "after", round: 2, size: at(984, 1200) }), "RS/RS1");
  assert.ok(!round.ok && round.reason === "size" && /the after of round 1/.test(round.message));
});

test("pictureSize reads PNG, GIF, JPEG and WebP headers, and nothing else", () => {
  const png = new Uint8Array(33); png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 3, 0xd8, 0, 0, 6, 0x40]);
  assert.deepEqual(pictureSize(png), at(984, 1600));
  const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x10, 0x01, 0x20, 0x00, 0, 0, 0]);
  assert.deepEqual(pictureSize(gif), at(272, 32));
  // JPEG: SOI, an APP0 segment of 16 bytes, then SOF0 with height 600 and width 800.
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, ...new Array(14).fill(0), 0xff, 0xc0, 0, 17, 8, 0x02, 0x58, 0x03, 0x20, 3, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(pictureSize(jpeg), at(800, 600));
  const riff = (chunk: string, body: number[]) => new Uint8Array([..."RIFF"].map((c) => c.charCodeAt(0)).concat([0, 0, 0, 0], [..."WEBP"].map((c) => c.charCodeAt(0)), [...chunk].map((c) => c.charCodeAt(0)), body));
  assert.deepEqual(pictureSize(riff("VP8X", [10, 0, 0, 0, 0, 0, 0, 0, 0xd7, 0x03, 0, 0x3f, 0x06, 0, 0, 0])), at(984, 1600));
  assert.deepEqual(pictureSize(riff("VP8 ", [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xd8, 0x03, 0x40, 0x06, 0, 0])), at(984, 1600));
  // VP8L: the signature byte 0x2f, then 14 bits width-1 and 14 bits height-1.
  const bits = (983) | (1599 << 14);
  assert.deepEqual(pictureSize(riff("VP8L", [0, 0, 0, 0, 0x2f, bits & 0xff, (bits >> 8) & 0xff, (bits >> 16) & 0xff, (bits >>> 24) & 0xff, 0, 0, 0, 0, 0])), at(984, 1600));
  assert.equal(pictureSize(new TextEncoder().encode("<svg width='10' height='10'/>")), undefined);
  assert.equal(pictureSize(png.subarray(0, 20)), undefined, "too short");
});
