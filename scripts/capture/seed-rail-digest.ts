// A seed for the capture tool: a test project "demo" for the right rail's "Running in" and the morning digest's usage
// line (queue FU), and an orchestrator chat long enough to scroll. Run by scripts/capture.ts as `node <this> <data dir>`
// with NEXUS_HOME set to the development instance's; it writes only there.
//
// - RN runs: its run is held "for an update", so the instance resumes it once it is up; its first step (FAKE: bglong)
//   leaves background work running, so the run stays running while the pictures are taken (allow a few seconds).
// - UW waits for the usage window, CL starts after RN (a chain), RV has a step waiting for the user's review.
// - DN finished two hours ago, so the digest has something new; the turn records (turns.jsonl) since yesterday give
//   the usage line: a 5-hour peak of 82 %, the 7-day window at 41 %, and two waits: a turn that hit the limit (70 min
//   until its session went on) and UW, waiting for 20 minutes now.
// It uses only what the protocol has had since queue FU1 (the fake's bglong), so it also seeds the code of a base
// commit from then on.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ProjectStore, appendTurn, approveQueue, newId, writeRegistry, type Event, type SessionFile, type TurnRecord } from "@nexus/protocol";

const dir = process.argv[2];
if (!dir) throw new Error("usage: node seed-rail-digest.ts <data dir>");
const root = join(dir, "demo");
mkdirSync(root, { recursive: true });
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

const st = ProjectStore.init(root, { id: "demo", name: "Demo app", root });
writeRegistry({ protocol: 1, projects: [{ id: "demo", root }] });
const session = (id: string, role: SessionFile["role"], title: string, queue?: string): SessionFile => {
  const s: SessionFile = { protocol: 1, id, project: "demo", role, runtime: "claude", title, cwd: root, launched_by: "nexus", created_at: ago(300), ...(queue ? { queue } : {}) };
  st.writeSession(s);
  return s;
};
const emit = (s: SessionFile, min: number, body: Record<string, unknown>) => st.appendEvent({ v: 1, id: newId(), at: ago(min), session: s.id, ...body } as Event);
const queue = (id: string, title: string, steps: [string, string, string][], over: Record<string, unknown> = {}) => {
  st.writeQueue({ protocol: 1, id, title, revision: 1, status: "proposed", stop_conditions: [], checks: [], ...over,
    steps: steps.map(([sid, stitle, goal]) => ({ id: sid, title: stitle, goal, acceptance: ["Done"] })) });
  approveQueue(st, id);
};

// RN: runs (resumed by the instance; the fake leaves background work running).
const rn = session(newId(), "worker", "RN worker", "RN");
queue("RN", "Search in the docs", [["RN1", "Index the docs", "FAKE: bglong"], ["RN2", "Search box", "FAKE: done"]]);
st.writeRun("RN", { protocol: 1, session: rn.id, state: "paused", reason: "held for an update", resume_after_restart: true, started_at: ago(30), updated_at: ago(1), runtime: "claude", revision: 1 });

// UW: waits for the usage window (an hour from now).
const uw = session(newId(), "worker", "UW worker", "UW");
queue("UW", "Hive sounds", [["UW1", "Ambient beds", "Ambient sound."], ["UW2", "Mixing", "Levels."]]);
emit(uw, 50, { type: "step.started", queue: "UW", step: "UW1" });
st.writeRun("UW", { protocol: 1, session: uw.id, state: "usage_wait", reason: "the 5-hour window is at 92 % (limit 90 %)", step: "UW1", resume_at: new Date(Date.now() + 3_600_000).toISOString(), started_at: ago(50), updated_at: ago(20), runtime: "claude", revision: 1 });

// CL: starts after RN.
queue("CL", "Cliff paths", [["CL1", "Path mesh", "A path along the cliff."], ["CL2", "Railings", "Railings."]]);
st.writeStart("CL", { protocol: 1, after: "RN", by: "user", revision: 1, created_at: ago(40) });

// RV: a step waiting for the user's review.
const rv = session(newId(), "worker", "RV worker", "RV");
queue("RV", "Waiting tab with reasons", [["RV1", "Reasons", "Each waiting item says why."], ["RV2", "Polish", "Spacing."]], { review_policy: "wait" });
emit(rv, 95, { type: "step.started", queue: "RV", step: "RV1" });
emit(rv, 70, { type: "step.done", queue: "RV", step: "RV1", summary: "Every waiting item now says why it waits." });

// DN: done two hours ago.
const dn = session(newId(), "worker", "DN worker", "DN");
queue("DN", "Export to CSV", [["DN1", "Export", "A CSV export."]]);
emit(dn, 150, { type: "step.started", queue: "DN", step: "DN1" });
emit(dn, 120, { type: "step.done", queue: "DN", step: "DN1", summary: "The table exports to CSV with the visible columns." });

// The turn records since yesterday: the usage line's numbers.
const turn = (min: number, s: SessionFile, u5: number, u7: number, over: Partial<TurnRecord> = {}) => appendTurn({
  v: 1, at: ago(min), started_at: ago(min + 4), project: "demo", session: s.id, role: "worker", runtime: "claude", outcome: "ok",
  windows_end: { five_hour: { utilization: u5 }, seven_day: { utilization: u7 } }, ...over,
});
turn(400, dn, 0.35, 0.36); turn(330, dn, 0.61, 0.38); turn(260, dn, 0.82, 0.4, { outcome: "usage", failure: "rate_limit" });
turn(186, dn, 0.12, 0.4); turn(125, dn, 0.3, 0.41); turn(75, rv, 0.44, 0.41);

// The orchestrator's chat: long enough that the view scrolls (its place is kept across a reload).
const orch = session(newId(), "orchestrator", "Orchestrator");
st.updateProject((p) => ({ ...p, orchestrator: { runtime: "claude", notify: false, ...p.orchestrator, session: orch.id } }));
for (let i = 0; i < 80; i++) {
  st.appendChat(orch.id, { at: ago(240 - i * 2), from: i % 2 ? "orchestrator" : "user",
    text: i % 2 ? `Answer ${i}: the queue goes on with its next step; nothing waits for you there.\n\nA second paragraph, so the message takes some room.` : `Question ${i}: where does the run stand?` });
}
console.log(`seeded ${root}`);
