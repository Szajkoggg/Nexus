// A seed for the capture tool: a test project "nexus" whose plan looks like Nexus's own (docs/protocol/planning.md, "The plan"), for
// the plan view's design and build (queue PL and the build after it): 15 queues, several with more than one
// predecessor, lines that skip columns, and a group of finished queues. Run by scripts/capture.ts as
// `node <this> <data dir>` with NEXUS_HOME set to the development instance's; it writes only there.
//
// Done: FB, PW, MT. Now: MX runs (held "for an update", so the instance resumes it; FAKE: bglong keeps it running),
// ST2 has a step waiting for the user's review, PL waits for the usage window.
// The plan: RX after MX; IO after PL (the user's); CH after PW (done), its revision 2 waits for approval; NB at 22:00;
// ST3 after RX and ST2 (the user's: the line that skips a column, seen in the built view on 2026-11-14); TS after RX;
// LG after CH and MT (done, the user's); DG after ST3 and IO (the user's); RA after LG and MX (two columns skipped).
// The same plan is drawn by hand in the mockups docs/ux/mockups/22a-plan-columns.html and 22b-plan-layered.html.
//
// As in Nexus itself, an orchestrator takes the reviews (the project's level 2); the steps that wait for the user's
// review are ST2's (level 1 as a queue, ST21 waiting now), IO3 and DG2 (their own level 1). The queues carry the area
// tags the plan view's lanes group by (queue PVA, docs/ux/plan-view-modes.md): engine, dashboard, orchestrator; NB has
// none, and ST3 has a step in another area than its own (ST31, engine). docs/ux/mockups/26-plan-modes.html draws the
// same plan and states.
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ProjectStore, appendTurn, applyDraft, approveQueue, newId, writeRegistry, type Event, type PlanFile, type SessionFile } from "@nexus/protocol";

const dir = process.argv[2];
if (!dir) throw new Error("usage: node seed-plan-nexus.ts <data dir>");
const root = join(dir, "nexus");
mkdirSync(root, { recursive: true });
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

const st = ProjectStore.init(root, { id: "nexus", name: "Nexus", root, orchestrator: { session: null } });
writeRegistry({ protocol: 1, projects: [{ id: "nexus", root }] });
// Reviewed by level from before the seeded events (else the server's first start would mark them as from before).
st.markReviewLevels(ago(48 * 60));
const session = (id: string, role: SessionFile["role"], title: string, queue?: string): SessionFile => {
  const s: SessionFile = { protocol: 1, id, project: "nexus", role, runtime: "claude", native_id: randomUUID(), title, cwd: root, launched_by: "nexus", created_at: ago(3000), ...(queue ? { queue } : {}) };
  st.writeSession(s);
  return s;
};
const emit = (s: SessionFile, min: number, body: Record<string, unknown>) => st.appendEvent({ v: 1, id: newId(), at: ago(min), session: s.id, ...body } as Event);
/** A queue, approved; each step `[id, title, own?]`: its own review level or area, if any. */
const queue = (id: string, title: string, steps: [string, string, { level?: 1 | 2 | 3; area?: string }?][], over: Record<string, unknown> = {}) => {
  st.writeQueue({ protocol: 1, id, title, revision: 1, status: "proposed", stop_conditions: [], checks: [], ...over,
    steps: steps.map(([sid, stitle, own]) => ({ id: sid, title: stitle, goal: "FAKE: done", acceptance: ["Done"],
      ...(own?.level ? { review: { level: own.level } } : {}), ...(own?.area ? { area: own.area } : {}) })) });
  approveQueue(st, id);
};
/** The plan of a queue: its predecessors, each with who set it. */
const plan = (id: string, after: [string, "user" | "orchestrator"][], min: number) => {
  const by = after[0]![1];
  const p: PlanFile = { protocol: 1, by, created_at: ago(min), updated_at: ago(min), after: after.map(([q, b]) => ({ queue: q, by: b, at: ago(min) })), decisions: [] };
  st.writePlan(id, p);
  st.writeStart(id, { protocol: 1, by, revision: st.readQueue(id).revision, created_at: ago(min) });
};
session("orchestrator", "orchestrator", "Orchestrator");
const user = session("user", "user", "You");

// Done, with their workers' turns for the estimates.
const done = (id: string, title: string, minutes: number[], end: number) => {
  const w = session(newId(), "worker", `${id} worker`, id);
  queue(id, title, minutes.map((_, i) => [`${id}${i + 1}`, `Step ${i + 1}`]));
  minutes.forEach((m, i) => {
    const step = `${id}${i + 1}`, at = end - i * 90;
    emit(w, at + m, { type: "step.started", queue: id, step });
    emit(w, at, { type: "step.done", queue: id, step, summary: "Done." });
    emit(user, at - 5, { type: "review.accepted", queue: id, step });
    appendTurn({ v: 1, at: ago(at), started_at: ago(at + m), duration_ms: m * 60_000, project: "nexus", session: w.id, role: "worker", runtime: "claude", queue: id, step, outcome: "ok" });
  });
};
done("FB", "Feedback buttons on review items", [40, 55, 35], 2400);
done("PW", "Parallel worktrees and merge-back", [70, 85, 60, 50], 1900);
done("MT", "Maintenance queue templates", [30, 45], 1200);

// Now.
const mx = session(newId(), "worker", "MX worker", "MX");
queue("MX", "Small fixes from the user's notes of 14 November", [["MX1", "Rail overflow"], ["MX2", "Digest usage line"], ["MX3", "Chip spacing"]], { worktree: "auto", area: "engine" });
st.writeQueue({ ...st.readQueue("MX"), steps: st.readQueue("MX").steps.map((s, i) => (i === 0 ? { ...s, goal: "FAKE: bglong" } : s)) });
approveQueue(st, "MX");
st.writeRun("MX", { protocol: 1, session: mx.id, state: "paused", reason: "held for an update", resume_after_restart: true, started_at: ago(40), updated_at: ago(1), runtime: "claude", revision: 1 });

const s2 = session(newId(), "worker", "ST2 worker", "ST2");
queue("ST2", "Statistics views: the project page with step durations", [["ST21", "Durations by tag"], ["ST22", "Phone layout"]], { review_policy: "wait", worktree: "auto", area: "dashboard" });
emit(s2, 95, { type: "step.started", queue: "ST2", step: "ST21" });
emit(s2, 30, { type: "step.done", queue: "ST2", step: "ST21", summary: "The project page shows step durations by tag." });

const pl = session(newId(), "worker", "PL worker", "PL");
queue("PL", "Plan view design: layouts and features on mockups", [["PL1", "Layouts"], ["PL2", "Features"]], { worktree: "auto", area: "dashboard" });
emit(pl, 60, { type: "step.started", queue: "PL", step: "PL1" });
st.writeRun("PL", { protocol: 1, session: pl.id, state: "usage_wait", reason: "the 5-hour window is at 92 % (limit 90 %)", step: "PL1", resume_at: new Date(Date.now() + 3_600_000).toISOString(), started_at: ago(60), updated_at: ago(20), runtime: "claude", revision: 1 });

// The plan.
queue("RX", "Refactoring the queue engine's run loop", [["RX1", "Split the loop"], ["RX2", "Tests"]], { area: "engine" });
plan("RX", [["MX", "orchestrator"]], 300);
queue("IO", "Plan view build: layered layout and routed lines", [["IO1", "Layout"], ["IO2", "Lines"], ["IO3", "Phone", { level: 1 }]], { worktree: "auto", area: "dashboard" });
plan("IO", [["PL", "user"]], 280);
queue("CH", "Chat context: what the orchestrator keeps between chats", [["CH1", "Context file"], ["CH2", "Briefing"]], { area: "orchestrator" });
plan("CH", [["PW", "orchestrator"]], 260);
applyDraft(st, { id: "CH", area: "orchestrator", title: "Chat context: what the orchestrator keeps between chats", steps: [{ id: "CH1", title: "Context file", goal: "FAKE: done" }, { id: "CH2", title: "Briefing", goal: "FAKE: done" }, { id: "CH3", title: "Hand-over", goal: "FAKE: done" }] });
queue("NB", "Nightly full test run and static analysis", [["NB1", "Run"]], { worktree: "auto" });
st.writeStart("NB", { protocol: 1, at: new Date(new Date().setHours(22, 0, 0, 0) + (new Date().getHours() >= 22 ? 86_400_000 : 0)).toISOString(), by: "user", revision: 1, created_at: ago(240) });
queue("ST3", "Statistics views: estimates in the plan and on the phone", [["ST31", "Estimates", { area: "engine" }], ["ST32", "Phone"]], { area: "dashboard" });
plan("ST3", [["RX", "orchestrator"], ["ST2", "user"]], 220);
queue("TS", "Test speed: split the slow server tests", [["TS1", "Measure"], ["TS2", "Split"]], { area: "engine" });
plan("TS", [["RX", "orchestrator"]], 200);
queue("LG", "Reader's language across the dashboard", [["LG1", "Strings"], ["LG2", "Settings"]], { area: "dashboard" });
plan("LG", [["CH", "orchestrator"], ["MT", "user"]], 180);
queue("DG", "Morning digest: a summary of the night on the phone", [["DG1", "Digest"], ["DG2", "Phone", { level: 1 }]], { area: "dashboard" });
plan("DG", [["ST3", "orchestrator"], ["IO", "user"]], 160);
queue("RA", "Review autonomy: the orchestrator accepts look steps", [["RA1", "Rules"], ["RA2", "List for the user"]], { area: "orchestrator" });
plan("RA", [["LG", "orchestrator"], ["MX", "orchestrator"]], 140);
console.log(`seeded ${root}`);
