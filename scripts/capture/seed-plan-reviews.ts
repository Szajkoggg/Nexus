// A seed for the capture tool: a test project "demo" with an orchestrator whose plan has steps that wait for the user's
// review (queue PVA, step PVAR). Run by scripts/capture.ts as `node <this> <data dir>` with NEXUS_HOME set to the
// development instance's; it writes only there.
//
// The project reviews at level 2. RN runs (held "for an update", so the instance resumes it; its first step, FAKE:
// bglong, keeps the run going while the pictures are taken), both its steps at level 2. CL waits for RN: CL1 at level 2,
// CL2 and CL3 at level 1 (their own). MP waits for RN and is level 1 as a queue. DP waits for CL, at level 2 only.
// OL, finished yesterday, gives the estimates their samples.
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ProjectStore, appendTurn, approveQueue, newId, writeRegistry, type Event, type PlanFile, type SessionFile } from "@nexus/protocol";

const dir = process.argv[2];
if (!dir) throw new Error("usage: node seed-plan-reviews.ts <data dir>");
const root = join(dir, "demo");
mkdirSync(root, { recursive: true });
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

const st = ProjectStore.init(root, { id: "demo", name: "Demo app", root, orchestrator: { session: null } });
writeRegistry({ protocol: 1, projects: [{ id: "demo", root }] });
// Reviewed by level from before the seeded events (else the server's first start would mark them as from before).
st.markReviewLevels(ago(48 * 60));
// Each with its runtime's session id, so the instance can resume RN's run.
const session = (id: string, role: SessionFile["role"], title: string, queue?: string): SessionFile => {
  const s: SessionFile = { protocol: 1, id, project: "demo", role, runtime: "claude", native_id: randomUUID(), title, cwd: root, launched_by: "nexus", created_at: ago(3000), ...(queue ? { queue } : {}) };
  st.writeSession(s);
  return s;
};
const emit = (s: SessionFile, min: number, body: Record<string, unknown>) => st.appendEvent({ v: 1, id: newId(), at: ago(min), session: s.id, ...body } as Event);
/** A queue, approved; each step `[id, title, level?]` (its own level, if any). */
const queue = (id: string, title: string, steps: [string, string, (1 | 2 | 3)?][], over: Record<string, unknown> = {}) => {
  st.writeQueue({ protocol: 1, id, title, revision: 1, status: "proposed", stop_conditions: [], checks: [], ...over,
    steps: steps.map(([sid, stitle, level]) => ({ id: sid, title: stitle, goal: "FAKE: done", acceptance: ["Done"], ...(level ? { review: { level } } : {}) })) });
  approveQueue(st, id);
};
const plan = (id: string, after: string[], min: number) => {
  const p: PlanFile = { protocol: 1, by: "user", created_at: ago(min), updated_at: ago(min), after: after.map((queue) => ({ queue, by: "user", at: ago(min) })), decisions: [] };
  st.writePlan(id, p);
  st.writeStart(id, { protocol: 1, by: "user", revision: st.readQueue(id).revision, created_at: ago(min) });
};
session("orchestrator", "orchestrator", "Orchestrator");
const user = session("user", "user", "You");

// At work.
const rn = session(newId(), "worker", "RN worker", "RN");
queue("RN", "Search in the docs", [["RN1", "Index the docs"], ["RN2", "Search box"]]);
st.writeQueue({ ...st.readQueue("RN"), steps: st.readQueue("RN").steps.map((s, i) => (i === 0 ? { ...s, goal: "FAKE: bglong" } : s)) });
approveQueue(st, "RN");
emit(rn, 30, { type: "step.started", queue: "RN", step: "RN1" });
st.writeRun("RN", { protocol: 1, session: rn.id, state: "paused", reason: "held for an update", resume_after_restart: true, step: "RN1", started_at: ago(30), updated_at: ago(1), runtime: "claude", revision: 1 });

// The plan.
queue("CL", "Cliff paths", [["CL1", "Path mesh"], ["CL2", "The paths' look", 1], ["CL3", "Railings", 1]]);
plan("CL", ["RN"], 40);
queue("MP", "Map of the island", [["MP1", "Tiles"], ["MP2", "Legend"]], { review_level: 1 });
plan("MP", ["RN"], 38);
queue("DP", "Deploy notes", [["DP1", "Notes"]]);
plan("DP", ["CL"], 35);

// Finished work for the estimates: OL's six steps, done yesterday, each with its worker turns' time in turns.jsonl.
const ol = session(newId(), "worker", "OL worker", "OL");
queue("OL", "Onboarding tour", [["OL1", "Welcome"], ["OL2", "Tour"], ["OL3", "Hints"], ["OL4", "Skip"], ["OL5", "Progress"], ["OL6", "Polish"]]);
[35, 50, 70, 90, 45, 60].forEach((minutes, i) => {
  const step = `OL${i + 1}`, end = 1500 - i * 100;
  emit(ol, end + minutes, { type: "step.started", queue: "OL", step });
  emit(ol, end, { type: "step.done", queue: "OL", step, summary: "Done." });
  emit(user, end - 5, { type: "review.accepted", queue: "OL", step });
  appendTurn({ v: 1, at: ago(end), started_at: ago(end + minutes), duration_ms: minutes * 60_000, project: "demo", session: ol.id, role: "worker", runtime: "claude", queue: "OL", step, outcome: "ok" });
});
console.log(`seeded ${root}`);
