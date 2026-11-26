// A seed for the capture tool (queue RVD): a test project "demo" whose design step WT1 waits for the user's review,
// with two alternative layouts and a phone mockup, three acceptance criteria and a summary that names three choices
// the user has to make. It was the data of RVD1's before (today's review, where those choices sit in the summary's
// prose) and of its mockups (docs/ux/mockups/27-review-decisions.html); since RVD4 the worker also declares the three
// choices as review decisions, and the user saved D1 already (the afters: scripts/capture/examples/review-decisions.yaml).
// Run by scripts/capture.ts as `node <this> <data dir>` with NEXUS_HOME set to the development instance's; it writes
// only there.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { ProjectStore, answerDecision, approveQueue, newId, writeRegistry, type Event, type SessionFile } from "@nexus/protocol";
import { requireTempHome } from "../temp-home.ts";

requireTempHome();

const dir = process.argv[2];
if (!dir) throw new Error("usage: node seed-review-decisions.ts <data dir>");
const root = join(dir, "demo");
mkdirSync(root, { recursive: true });
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

/** A PNG of a made-up app screen: a header bar in `accent` and `cards` white cards in `columns` columns. */
function screen(width: number, height: number, accent: [number, number, number], cards: number, columns: number): Buffer {
  const px = Buffer.alloc(width * height * 4);
  const rect = (x0: number, y0: number, w: number, h: number, [r, g, b]: [number, number, number]) => {
    for (let y = Math.max(0, y0); y < Math.min(height, y0 + h); y++) for (let x = Math.max(0, x0); x < Math.min(width, x0 + w); x++) {
      const i = (y * width + x) * 4; px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = 255;
    }
  };
  rect(0, 0, width, height, [248, 250, 252]);
  rect(0, 0, width, 52, accent);
  const colWidth = Math.floor((width - 12) / columns);
  for (let c = 0; c < cards; c++) {
    const x = 12 + (c % columns) * colWidth, y = 68 + Math.floor(c / columns) * 92;
    rect(x, y, colWidth - 12, 80, [255, 255, 255]);
    rect(x + 14, y + 16, Math.min(260, colWidth - 48), 12, [15, 23, 42]);
    rect(x + 14, y + 38, Math.min(180, colWidth - 48), 8, [148, 163, 184]);
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

const st = ProjectStore.init(root, { id: "demo", name: "Demo app", root, orchestrator: { session: null } });
writeRegistry({ protocol: 1, projects: [{ id: "demo", root }] });
// Reviewed by level from before the seeded events (else the server's first start would mark them as from before).
st.markReviewLevels(ago(24 * 60));
st.markReviewDecisions(ago(24 * 60));
const w: SessionFile = { protocol: 1, id: newId(), project: "demo", role: "worker", runtime: "claude", title: "WT worker", cwd: root, launched_by: "nexus", created_at: ago(120), queue: "WT" };
st.writeSession(w);
const emit = (min: number, body: Record<string, unknown>) => st.appendEvent({ v: 1, id: newId(), at: ago(min), session: w.id, ...body } as Event);

st.writeQueue({ protocol: 1, id: "WT", title: "Waiting tab redesign", revision: 1, status: "proposed", stop_conditions: [], checks: ["npm test"],
  steps: [
    { id: "WT1", title: "Design: the waiting list's layout", kind: "design",
      goal: "Design the waiting list for many queues: its layout on the desktop, what Snooze does, and whether the phone changes in this queue.",
      acceptance: ["Both layouts drawn at 1440 and 390 px with the same data", "Snooze's behaviour described with its edge cases", "The user chose the layout"],
      review: { level: 1, prepare: "waiting-list@1440 variant-a, variant-b; waiting-list@390 mockup" } },
    { id: "WT2", title: "Build the chosen layout", goal: "Build what WT1's review chose.", acceptance: ["Matches the accepted design"] },
  ] });
approveQueue(st, "WT");

const pics = join(root, "tmp/review/WT1");
mkdirSync(pics, { recursive: true });
const file = (name: string, png: Buffer) => { const p = join(pics, name).replaceAll("\\", "/"); writeFileSync(p, png); return p; };
const a = file("waiting-list@1440.a.png", screen(1440, 900, [37, 99, 235], 8, 1));
const b = file("waiting-list@1440.b.png", screen(1440, 900, [37, 99, 235], 8, 3));
const phone = file("waiting-list@390.png", screen(390, 844, [37, 99, 235], 6, 1));
emit(90, { type: "step.started", queue: "WT", step: "WT1" });
emit(60, { type: "review.added", queue: "WT", step: "WT1", round: 1, items: [
  { path: a, label: "A: one list, oldest first", kind: "image", key: "waiting-list@1440", role: "variant-a", size: { width: 1440, height: 900 } },
  { path: b, label: "B: grouped by queue", kind: "image", key: "waiting-list@1440", role: "variant-b", size: { width: 1440, height: 900 } },
  { path: phone, label: "Phone: one list", kind: "image", key: "waiting-list@390", role: "mockup", size: { width: 390, height: 844 } },
] });
// The three choices of the summary, as the worker declares them before its step.done (nexus decide).
const decide = (min: number, decision: string, text: string, options: string[], recommended: string, material: string[], why: string) =>
  emit(min, { type: "review.decision", queue: "WT", step: "WT1", decision, text, options: options.map((label) => ({ label })), recommended, material, why, for: "user" });
decide(59.5, "D1", "Which layout for the waiting list on the desktop?", ["A: one list, oldest first", "B: grouped by queue"], "B: grouped by queue",
  ["waiting-list@1440"], "WT2 builds it; the other one is dropped.");
decide(59.4, "D2", "What does Snooze do?", ["Hide it for an hour", "Hide it until it changes"], "Hide it until it changes",
  [], "When a snoozed item comes back to the list.");
decide(59.3, "D3", "Does the phone's Waiting tab change in this queue?", ["Yes, in WT2", "Later, in a queue of its own"], "Later, in a queue of its own",
  ["waiting-list@390"], "Yes adds a step to WT; later leaves the phone as it is.");
emit(58, { type: "check.result", queue: "WT", step: "WT1", name: "npm test", ok: true, summary: "212 passed" });
emit(55, { type: "step.done", queue: "WT", step: "WT1", activities: ["ui", "capture"],
  summary: "Two layouts for the waiting list, A (one list, oldest first) and B (grouped by queue), at 1440 and 390 px. For your decision: which layout (I recommend B); whether Snooze hides an item for an hour or until it changes (I recommend until it changes); and whether the phone changes in this queue or later (I recommend later)." });
// The user saved D1 already (the dashboard's answer: version 1, round 1).
answerDecision(st, { queue: "WT", step: "WT1", decision: "D1", version: 1, round: 1, choice: "B: grouped by queue" });
console.log(`seeded ${root}`);
