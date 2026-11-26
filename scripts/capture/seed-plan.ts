// A seed for the capture tool: a test project "demo" whose queues make a plan (docs/protocol/planning.md, "The plan"), for the
// Queues view's plan (queue PV). Run by scripts/capture.ts as `node <this> <data dir>` with NEXUS_HOME set to the
// development instance's; it writes only there.
//
// Now: RN runs (held "for an update", so the instance resumes it; its first step, FAKE: bglong, leaves background work
// running, so the run stays running while the pictures are taken), UW waits for the usage window, RV has a step
// waiting for the user's review, ST is stopped.
// The plan: CL after RN (set by the user; the orchestrator proposes UW instead), MP after RN (the user's) and RV (the orchestrator's), DP after CL (the
// orchestrator's), AP after RN but its revision 2 waits for approval, SC at 22:00, WT after DN (done) but waits for
// the checkout RN holds, XB after ST (stopped). NP is approved but not in the plan; DN is done.
// It uses only what the protocol has had since queue PV1 (plan.yaml), so it also seeds the code of a base commit from
// then on.
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { ProjectStore, appendTurn, applyDraft, approveQueue, newId, writeRegistry, type Event, type PlanFile, type SessionFile } from "@nexus/protocol";
import { requireTempHome } from "../temp-home.ts";

requireTempHome();

const dir = process.argv[2];
if (!dir) throw new Error("usage: node seed-plan.ts <data dir>");
const root = join(dir, "demo");
mkdirSync(root, { recursive: true });
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

const st = ProjectStore.init(root, { id: "demo", name: "Demo app", root });
writeRegistry({ protocol: 1, projects: [{ id: "demo", root }] });
const session = (id: string, role: SessionFile["role"], title: string, queue?: string): SessionFile => {
  const s: SessionFile = { protocol: 1, id, project: "demo", role, runtime: "claude", native_id: randomUUID(), title, cwd: root, launched_by: "nexus", created_at: ago(300), ...(queue ? { queue } : {}) };
  st.writeSession(s);
  return s;
};
const emit = (s: SessionFile, min: number, body: Record<string, unknown>) => st.appendEvent({ v: 1, id: newId(), at: ago(min), session: s.id, ...body } as Event);
const queue = (id: string, title: string, steps: [string, string][], over: Record<string, unknown> = {}) => {
  st.writeQueue({ protocol: 1, id, title, revision: 1, status: "proposed", stop_conditions: [], checks: [], ...over,
    steps: steps.map(([sid, stitle]) => ({ id: sid, title: stitle, goal: "FAKE: done", acceptance: ["Done"] })) });
  approveQueue(st, id);
};
/** The plan of a queue: its predecessors, each with who set it. */
const plan = (id: string, after: [string, "user" | "orchestrator"][], min: number, by: "user" | "orchestrator" = after[0]?.[1] ?? "user") => {
  const p: PlanFile = { protocol: 1, by, created_at: ago(min), updated_at: ago(min), after: after.map(([queue, b]) => ({ queue, by: b, at: ago(min) })), decisions: [] };
  st.writePlan(id, p);
  st.writeStart(id, { protocol: 1, by, revision: st.readQueue(id).revision, created_at: ago(min) });
};
const user = session("user", "user", "You");

// Now.
const rn = session(newId(), "worker", "RN worker", "RN");
queue("RN", "Search in the docs", [["RN1", "Index the docs"], ["RN2", "Search box"]]);
st.writeQueue({ ...st.readQueue("RN"), steps: st.readQueue("RN").steps.map((s, i) => (i === 0 ? { ...s, goal: "FAKE: bglong" } : s)) });
approveQueue(st, "RN");
st.writeRun("RN", { protocol: 1, session: rn.id, state: "paused", reason: "held for an update", resume_after_restart: true, started_at: ago(30), updated_at: ago(1), runtime: "claude", revision: 1 });

const uw = session(newId(), "worker", "UW worker", "UW");
queue("UW", "Hive sounds", [["UW1", "Ambient beds"], ["UW2", "Mixing"]], { worktree: "auto" });
emit(uw, 50, { type: "step.started", queue: "UW", step: "UW1" });
st.writeRun("UW", { protocol: 1, session: uw.id, state: "usage_wait", reason: "the 5-hour window is at 92 % (limit 90 %)", step: "UW1", resume_at: new Date(Date.now() + 3_600_000).toISOString(), started_at: ago(50), updated_at: ago(20), runtime: "claude", revision: 1 });

const rv = session(newId(), "worker", "RV worker", "RV");
queue("RV", "Waiting tab with reasons", [["RV1", "Reasons"], ["RV2", "Polish"]], { review_policy: "wait" }); // level 1
emit(rv, 95, { type: "step.started", queue: "RV", step: "RV1" });
emit(rv, 70, { type: "step.done", queue: "RV", step: "RV1", summary: "Every waiting item now says why it waits." });

const sx = session(newId(), "worker", "ST worker", "ST");
queue("ST", "Sync to the cloud", [["ST1", "Upload"], ["ST2", "Conflicts"]]);
emit(sx, 200, { type: "step.started", queue: "ST", step: "ST1" });
emit(sx, 180, { type: "queue.stop", queue: "ST", step: "ST1", condition: "A decision is the user's", reason: "which cloud to sync to" });

// Done.
const dn = session(newId(), "worker", "DN worker", "DN");
queue("DN", "Export to CSV", [["DN1", "Export"]]);
emit(dn, 150, { type: "step.started", queue: "DN", step: "DN1" });
emit(dn, 120, { type: "step.done", queue: "DN", step: "DN1", summary: "The table exports to CSV." });
emit(user, 119, { type: "review.accepted", queue: "DN", step: "DN1" });

// The plan.
queue("CL", "Cliff paths", [["CL1", "Path mesh"], ["CL2", "Railings"]]);
plan("CL", [["RN", "user"]], 40);
// The orchestrator proposes to change the user's dependency: CL after UW instead of RN.
st.writePlan("CL", { ...st.readPlan("CL")!, proposal: { at: ago(5), after: ["UW"], reason: "The cliff paths reuse the ambient beds of Hive sounds; the search does not touch them." } });
queue("MP", "Map of the island", [["MP1", "Tiles"], ["MP2", "Legend"]]);
plan("MP", [["RN", "user"], ["RV", "orchestrator"]], 38);
queue("DP", "Deploy notes", [["DP1", "Notes"]]);
plan("DP", [["CL", "orchestrator"]], 35);
queue("AP", "Accounts page", [["AP1", "Form"], ["AP2", "Avatar"]]);
plan("AP", [["RN", "orchestrator"]], 33);
applyDraft(st, { id: "AP", title: "Accounts page", steps: [{ id: "AP1", title: "Form", goal: "FAKE: done" }, { id: "AP2", title: "Avatar", goal: "FAKE: done" }, { id: "AP3", title: "Password", goal: "FAKE: done" }] });
queue("SC", "Night build", [["SC1", "Build"]], { worktree: "auto" });
st.writeStart("SC", { protocol: 1, at: new Date(new Date().setHours(22, 0, 0, 0) + (new Date().getHours() >= 22 ? 86_400_000 : 0)).toISOString(), by: "user", revision: 1, created_at: ago(30) });
queue("WT", "Tidy the README", [["WT1", "Tidy"]]);
plan("WT", [["DN", "user"]], 25);
queue("XB", "Backups", [["XB1", "Snapshots"]], { worktree: "auto" });
plan("XB", [["ST", "user"]], 60);
queue("NP", "Dark mode", [["NP1", "Colours"]]);
// Finished work for the estimates (queue PV4): OL's six steps, done yesterday, each with its worker turns' time in
// turns.jsonl (one sent back once: two turns); the project's default model and effort (none named), like the plan's.
const ol = session(newId(), "worker", "OL worker", "OL");
queue("OL", "Onboarding tour", [["OL1", "Welcome"], ["OL2", "Tour"], ["OL3", "Hints"], ["OL4", "Skip"], ["OL5", "Progress"], ["OL6", "Polish"]]);
[35, 50, 70, 90, 45, 60].forEach((minutes, i) => {
  const step = `OL${i + 1}`, end = 1500 - i * 100;
  emit(ol, end + minutes, { type: "step.started", queue: "OL", step });
  emit(ol, end, { type: "step.done", queue: "OL", step, summary: "Done." });
  emit(user, end - 5, { type: "review.accepted", queue: "OL", step });
  const parts = i === 3 ? [60, 30] : [minutes];
  parts.forEach((m, j) => appendTurn({ v: 1, at: ago(end - j * 20), started_at: ago(end - j * 20 + m), duration_ms: m * 60_000, project: "demo", session: ol.id, role: "worker", runtime: "claude", queue: "OL", step, outcome: "ok" }));
});
console.log(`seeded ${root}`);
