// A seed for the capture tool: a test project "demo" with coding queues (coding: true), so the closing refactoring
// step shows where steps are listed (queue RF): CR waits for approval; CW is at its closing step; CX is at its second
// step, its closing step still to come. Run by scripts/capture.ts as `node <this> <data dir>` with NEXUS_HOME set to the
// development instance's; it writes only under the data directory and that NEXUS_HOME.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ProjectStore, approveQueue, newId, writeRegistry, type Event, type SessionFile, type StepDef } from "@nexus/protocol";

const dir = process.argv[2];
if (!dir) throw new Error("usage: node seed-closing.ts <data dir>");
const root = join(dir, "demo");
mkdirSync(root, { recursive: true });
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const st = ProjectStore.init(root, { id: "demo", name: "Demo app", root, orchestrator: { session: null } });
writeRegistry({ protocol: 1, projects: [{ id: "demo", root }] });
st.markReviewLevels(ago(24 * 60));
const session = (role: SessionFile["role"], title: string, queue?: string): SessionFile => {
  const s: SessionFile = { protocol: 1, id: newId(), project: "demo", role, runtime: "claude", title, cwd: root, launched_by: "nexus", created_at: ago(600), ...(queue ? { queue } : {}) };
  st.writeSession(s);
  return s;
};
const emit = (s: SessionFile, min: number, body: Record<string, unknown>) => st.appendEvent({ v: 1, id: newId(), at: ago(min), session: s.id, ...body } as Event);
const user = session("user", "You");
const step = (id: string, title: string, goal: string, acceptance: string[], level?: 1 | 2 | 3): StepDef =>
  ({ id, title, goal, acceptance, ...(level ? { review: { level } } : {}) });

// CR: a coding queue waiting for approval; the closing step after its three steps.
st.writeQueue({ protocol: 1, id: "CR", title: "Export to CSV", revision: 1, status: "proposed", coding: true, checks: ["npm run typecheck", "npm test"],
  stop_conditions: ["A change to the stored data format would be needed."],
  description: "Every table of the app can be exported as CSV, with the columns as shown.",
  steps: [
    step("CR1", "CSV writer", "A writer that quotes and escapes fields as RFC 4180 says, streaming large tables.", ["Unit tests for quoting, escaping and line breaks", "A table of 100 000 rows exports in under 2 s"], 2),
    step("CR2", "Export button", "An Export button on every table's toolbar, writing the visible columns in their order.", ["The button on every table", "A test per table type"], 2),
    step("CR3", "The export's look", "The button and its menu in light and dark.", ["The button sits well in both themes"], 1),
  ] });

// A started coding queue: its steps done up to `at` (accepted), the step `at` at work.
function started(id: string, title: string, defs: StepDef[], at: string, progress: string) {
  st.writeQueue({ protocol: 1, id, title, revision: 1, status: "proposed", coding: true, checks: ["npm test"], stop_conditions: [], steps: defs });
  approveQueue(st, id);
  const w = session("worker", `${id} worker`, id);
  let min = 200;
  for (const d of [...defs.map((x) => x.id), `${id}.refactor`]) {
    emit(w, min, { type: "step.started", queue: id, step: d });
    if (d === at) { emit(w, 5, { type: "step.progress", queue: id, step: d, text: progress, pct: 40 }); return; }
    emit(w, min - 20, { type: "step.done", queue: id, step: d, summary: `${d} done.` });
    emit(user, min - 25, { type: "review.accepted", queue: id, step: d });
    min -= 40;
  }
}
started("CW", "Search filters", [
  step("CW1", "Filter model", "Filters as data.", ["Tests"]),
  step("CW2", "Filter bar", "The bar above the results.", ["Tests"]),
], "CW.refactor", "Reading the queue's commits: two helpers to merge");
started("CX", "Saved views", [
  step("CX1", "Views as data", "A saved view as data.", ["Tests"]),
  step("CX2", "Save and load", "Save the current view, load a saved one.", ["Tests"]),
  step("CX3", "Share a view", "A link that opens a saved view.", ["Tests"]),
], "CX2", "Loading a saved view");

console.log(`seeded ${root}`);
