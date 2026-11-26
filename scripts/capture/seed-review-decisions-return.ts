// A seed for the capture tool (queue RVD): the return batch after away mode. A test project "demo" whose queue WT runs
// at review level 3; while the user was away the orchestrator answered WT1's three decisions (each with why) and
// accepted WT1 and WT2 provisionally (WT2 declared it has nothing to decide). The waiting list then shows the batch
// with the orchestrator's answers, Instead…, Confirm, Fix it and Confirm all (docs/ux/mockups/27-review-decisions.html,
// ?v=return). Run by scripts/capture.ts as `node <this> <data dir>` with NEXUS_HOME set to the development instance's;
// it writes only there.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ProjectStore, approveQueue, newId, writeAway, writeRegistry, type Event, type SessionFile } from "@nexus/protocol";

const dir = process.argv[2];
if (!dir) throw new Error("usage: node seed-review-decisions-return.ts <data dir>");
const root = join(dir, "demo");
mkdirSync(root, { recursive: true });
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

const st = ProjectStore.init(root, { id: "demo", name: "Demo app", root, orchestrator: { session: null } });
writeRegistry({ protocol: 1, projects: [{ id: "demo", root }] });
st.markReviewLevels(ago(24 * 60));
st.markReviewDecisions(ago(24 * 60));
// The user was away from 4 hours ago until 1 hour ago.
writeAway({ protocol: 1, past: [{ since: ago(240), until: ago(60), ended: ago(60), why: "expired" }] });
const session = (role: SessionFile["role"], title: string, queue?: string): SessionFile => {
  const s: SessionFile = { protocol: 1, id: newId(), project: "demo", role, runtime: "claude", title, cwd: root, launched_by: "nexus", created_at: ago(600), ...(queue ? { queue } : {}) };
  st.writeSession(s);
  return s;
};
const orch = session("orchestrator", "Orchestrator");
const w = session("worker", "WT worker", "WT");
const emit = (s: SessionFile, min: number, body: Record<string, unknown>) => st.appendEvent({ v: 1, id: newId(), at: ago(min), session: s.id, ...body } as Event);

st.writeQueue({ protocol: 1, id: "WT", title: "Waiting tab redesign", revision: 1, status: "proposed", review_level: 3, stop_conditions: [], checks: ["npm test"],
  steps: [
    { id: "WT1", title: "Design: the waiting list's layout", kind: "design", goal: "Design the waiting list for many queues.", acceptance: ["Both layouts drawn"] },
    { id: "WT2", title: "Build the chosen layout", goal: "Build what WT1's review chose.", acceptance: ["Matches the accepted design"] },
  ] });
approveQueue(st, "WT");

const decisions: [string, string, string[], string, string, string][] = [
  ["D1", "Which layout for the waiting list on the desktop?", ["A: one list, oldest first", "B: grouped by queue"], "B: grouped by queue", "B: grouped by queue", "Many queues read better grouped; matches the goal."],
  ["D2", "What does Snooze do?", ["Hide it for an hour", "Hide it until it changes"], "Hide it until it changes", "Hide it until it changes", "An hour hides real changes."],
  ["D3", "Does the phone's Waiting tab change in this queue?", ["Yes, in WT2", "Later, in a queue of its own"], "Later, in a queue of its own", "Later, in a queue of its own", "The phone is a queue of its own."],
];
emit(w, 200, { type: "step.started", queue: "WT", step: "WT1" });
for (const [id, text, options, recommended] of decisions) emit(w, 180, { type: "review.decision", queue: "WT", step: "WT1", decision: id, text, options: options.map((label) => ({ label })), recommended, for: "user" });
emit(w, 175, { type: "step.done", queue: "WT", step: "WT1", summary: "Two layouts for the waiting list, A and B, at 1440 and 390 px; three decisions for the user." });
decisions.forEach(([id, , , , choice, why], i) => emit(orch, 170 - i, { type: "review.decided", queue: "WT", step: "WT1", decision: id, version: 1, round: 1, choice, text: why }));
emit(orch, 166, { type: "review.provisional", queue: "WT", step: "WT1", text: "the layout is yours to judge." });
emit(w, 160, { type: "step.started", queue: "WT", step: "WT2" });
emit(w, 100, { type: "review.decisions_none", queue: "WT", step: "WT2", text: "builds what WT1 chose" });
emit(w, 98, { type: "step.done", queue: "WT", step: "WT2", summary: "The grouped layout, as WT1 chose." });
emit(orch, 95, { type: "review.provisional", queue: "WT", step: "WT2" });
console.log(`seeded ${root}`);
