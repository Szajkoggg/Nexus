// A seed for the capture tool: a test project "demo" with queues in a few states and a step waiting for review with
// keyed pictures (a before and its after, a result). Run by scripts/capture.ts as `node <this> <data dir>` with
// NEXUS_HOME set to the development instance's; it writes only there. It uses only what the protocol has had since
// the review keys (RS1), so it also seeds the code of an older base commit from then on.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { ProjectStore, approveQueue, newId, writeRegistry, type Event, type SessionFile } from "@nexus/protocol";

const dir = process.argv[2];
if (!dir) throw new Error("usage: node seed-demo.ts <data dir>");
const root = join(dir, "demo");
mkdirSync(root, { recursive: true });
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

/** A PNG of a made-up app screen: a header bar in `accent` and `cards` white cards, some with a yellow tag. */
function screen(width: number, height: number, accent: [number, number, number], cards: number, tags: boolean): Buffer {
  const px = Buffer.alloc(width * height * 4);
  const rect = (x0: number, y0: number, w: number, h: number, [r, g, b]: [number, number, number]) => {
    for (let y = Math.max(0, y0); y < Math.min(height, y0 + h); y++) for (let x = Math.max(0, x0); x < Math.min(width, x0 + w); x++) {
      const i = (y * width + x) * 4; px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = 255;
    }
  };
  rect(0, 0, width, height, [248, 250, 252]);
  rect(0, 0, width, 52, accent);
  for (let c = 0; c < cards; c++) {
    const y = 68 + c * 92;
    rect(12, y, width - 24, 80, [255, 255, 255]);
    rect(26, y + 16, Math.min(260, width - 60), 12, [15, 23, 42]);
    rect(26, y + 38, Math.min(180, width - 60), 8, [148, 163, 184]);
    if (tags) rect(26, y + 56, 110, 12, [253, 230, 138]);
  }
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) px.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const st = ProjectStore.init(root, { id: "demo", name: "Demo app", root });
writeRegistry({ protocol: 1, projects: [{ id: "demo", root }] });
const w: SessionFile = { protocol: 1, id: newId(), project: "demo", role: "worker", runtime: "claude", native_id: "00000000-0000-4000-8000-000000000003", title: "UI worker", cwd: root, launched_by: "nexus", created_at: ago(120), queue: "UI" };
st.writeSession(w);
const emit = (min: number, body: Record<string, unknown>) => st.appendEvent({ v: 1, id: newId(), at: ago(min), session: w.id, ...body } as Event);

st.writeQueue({ protocol: 1, id: "UI", title: "Waiting tab with reasons", revision: 1, status: "proposed", review_policy: "wait", stop_conditions: [], checks: ["npm test"],
  steps: [
    { id: "UI1", title: "Reasons on the waiting tab", goal: "Each waiting item says why it waits.", acceptance: ["Every item has its reason"],
      review: { prepare: "waiting-tab@492 before -> after; usage-panel@390 result" } },
    { id: "UI2", title: "Polish", goal: "Spacing and colours.", acceptance: ["Polished"] },
  ] });
approveQueue(st, "UI");
st.writeQueue({ protocol: 1, id: "CL", title: "Cliff paths", revision: 1, status: "proposed", stop_conditions: [], checks: [],
  steps: [{ id: "CL1", title: "Path mesh", goal: "A path along the cliff.", acceptance: ["Walkable"] }, { id: "CL2", title: "Railings", goal: "Railings.", acceptance: ["Safe"] }] });
approveQueue(st, "CL");
st.writeQueue({ protocol: 1, id: "HS", title: "Hive sounds", revision: 1, status: "proposed", stop_conditions: [], checks: [],
  steps: [{ id: "HS1", title: "Ambient beds", goal: "Ambient sound.", acceptance: ["Audible"] }] });

const pics = join(root, "tmp/review/UI1");
mkdirSync(pics, { recursive: true });
const file = (name: string, png: Buffer) => { const p = join(pics, name).replaceAll("\\", "/"); writeFileSync(p, png); return p; };
const before = file("waiting-tab@492.before.png", screen(492, 844, [37, 99, 235], 3, false));
const after = file("waiting-tab@492.png", screen(492, 844, [37, 99, 235], 3, true));
const result = file("usage-panel@390.png", screen(390, 844, [124, 58, 237], 2, false));
emit(90, { type: "step.started", queue: "UI", step: "UI1" });
emit(60, { type: "review.added", queue: "UI", step: "UI1", round: 1, items: [
  { path: before, label: "Waiting tab, before", kind: "image", key: "waiting-tab@492", role: "before", size: { width: 492, height: 844 } },
  { path: after, label: "Waiting tab", kind: "image", key: "waiting-tab@492", role: "after", size: { width: 492, height: 844 } },
  { path: result, label: "Usage panel", kind: "image", key: "usage-panel@390", role: "result", size: { width: 390, height: 844 } },
] });
emit(58, { type: "check.result", queue: "UI", step: "UI1", name: "npm test", ok: true, summary: "212 passed" });
emit(55, { type: "step.done", queue: "UI", step: "UI1", summary: "Every waiting item now says why it waits: approval, a planned start, or nothing planned." });
console.log(`seeded ${root}`);
