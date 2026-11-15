// A seed for the capture tool: a test project "demo" with a finished queue (OT: three steps done, with summaries,
// checks and a review picture) and a cancelled one (LI: one step done, two never run). Run by scripts/capture.ts as
// `node <this> <data dir>` with NEXUS_HOME set to the development instance's; it writes only there.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { ProjectStore, approveQueue, newId, orchestratorStatusChange, writeRegistry, type Event, type SessionFile } from "@nexus/protocol";

const dir = process.argv[2];
if (!dir) throw new Error("usage: node seed-finished.ts <data dir>");
const root = join(dir, "demo");
mkdirSync(root, { recursive: true });
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

/** A plain PNG of a made-up screen: a header bar and three cards. */
function screen(width: number, height: number): Buffer {
  const px = Buffer.alloc(width * height * 4);
  const rect = (x0: number, y0: number, w: number, h: number, [r, g, b]: [number, number, number]) => {
    for (let y = y0; y < Math.min(height, y0 + h); y++) for (let x = x0; x < Math.min(width, x0 + w); x++) {
      const i = (y * width + x) * 4; px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = 255;
    }
  };
  rect(0, 0, width, height, [248, 250, 252]);
  rect(0, 0, width, 52, [13, 148, 136]);
  for (let c = 0; c < 3; c++) { rect(12, 68 + c * 92, width - 24, 80, [255, 255, 255]); rect(26, 84 + c * 92, 220, 12, [15, 23, 42]); }
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

const st = ProjectStore.init(root, { id: "demo", name: "Demo app", root, orchestrator: { session: null } });
writeRegistry({ protocol: 1, projects: [{ id: "demo", root }] });
st.markReviewLevels(ago(24 * 60));
const worker = (queue: string): SessionFile => {
  const s: SessionFile = { protocol: 1, id: newId(), project: "demo", role: "worker", runtime: "claude", title: `${queue} worker`, cwd: root, launched_by: "nexus", created_at: ago(600), queue };
  st.writeSession(s);
  return s;
};
const orchestrator: SessionFile = { protocol: 1, id: newId(), project: "demo", role: "orchestrator", runtime: "claude", title: "Orchestrator", cwd: root, launched_by: "nexus", created_at: ago(600) };
st.writeSession(orchestrator);
const emitter = (s: SessionFile) => (min: number, body: Record<string, unknown>) => st.appendEvent({ v: 1, id: newId(), at: ago(min), session: s.id, ...body } as Event);

const accept = emitter(orchestrator);

// OT: finished. Each step started, checked and done; OT2 with a review picture.
st.writeQueue({ protocol: 1, id: "OT", title: "Onboarding tour", revision: 1, status: "proposed", review_level: 3, stop_conditions: [], checks: ["npm test"],
  description: "A short tour for new users: four screens, then the first project.",
  steps: [
    { id: "OT1", title: "Tour data and routes", goal: "The tour's screens as data, each with its route.", acceptance: ["Unit tests for every screen's route"] },
    { id: "OT2", title: "The tour's look", goal: "The four screens drawn, light and dark.", acceptance: ["The screens feel calm and readable"], review: { prepare: "tour-screen@1440 result" } },
    { id: "OT3", title: "Skip and resume", goal: "The tour can be skipped and resumed later.", acceptance: ["A test for skip and one for resume"] },
  ] });
approveQueue(st, "OT");
const ot = emitter(worker("OT"));
const pics = join(root, "tmp/review/OT2");
mkdirSync(pics, { recursive: true });
const pic = join(pics, "tour-screen@1440.png").replaceAll("\\", "/");
writeFileSync(pic, screen(480, 300));
const steps: [string, number, string][] = [
  ["OT1", 240, "The four screens are data in tour.ts, each with its route; 12 unit tests cover the routes."],
  ["OT2", 180, "The screens are drawn in light and dark; the picture shows the first one."],
  ["OT3", 120, "Skip keeps the screen reached; Resume opens it again. Two tests."],
];
for (const [id, min, summary] of steps) {
  ot(min + 40, { type: "step.started", queue: "OT", step: id });
  if (id === "OT2") ot(min + 10, { type: "review.added", queue: "OT", step: id, round: 1, items: [{ path: pic, label: "The tour's first screen", kind: "image", key: "tour-screen@1440", role: "result", size: { width: 480, height: 300 } }] });
  ot(min + 5, { type: "check.result", queue: "OT", step: id, name: "npm test", ok: true, summary: "214 passed", duration_s: 41 });
  ot(min, { type: "step.done", queue: "OT", step: id, summary });
  accept(min - 2, { type: "review.accepted", queue: "OT", step: id });
}

// LI: cancelled after its first step.
st.writeQueue({ protocol: 1, id: "LI", title: "Legacy import", revision: 1, status: "proposed", review_level: 3, stop_conditions: [], checks: ["npm test"],
  steps: [
    { id: "LI1", title: "Read the old format", goal: "A reader for the old export files.", acceptance: ["Reads the three sample files"] },
    { id: "LI2", title: "Map to the new model", goal: "Each old record becomes a new one.", acceptance: ["Round-trip test"] },
    { id: "LI3", title: "Import screen", goal: "A screen to pick the file and see what comes in.", acceptance: ["Works with the samples"] },
  ] });
approveQueue(st, "LI");
const li = emitter(worker("LI"));
li(100, { type: "step.started", queue: "LI", step: "LI1" });
li(80, { type: "step.done", queue: "LI", step: "LI1", summary: "The reader handles all three sample files." });
accept(78, { type: "review.accepted", queue: "LI", step: "LI1" });
orchestratorStatusChange(st, { queue: "LI", to: "cancelled", reason: "The old format is no longer exported by anyone; the user dropped the import." });
console.log(`seeded ${root}`);
