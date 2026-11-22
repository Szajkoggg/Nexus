// A seed for the capture tool (queue RH, RH4): a test project "demo" whose finished queue RV has a step accepted by the
// review helper (RV1, after a send-back of its own), one accepted by the orchestrator after the helper passed it on
// (RV2) and one accepted by the user (RV3); the project runs its review helper on a model of its own (Haiku, low),
// the global settings keep the shipped one. Run by scripts/capture.ts as `node <this> <data dir>` with NEXUS_HOME set
// to the development instance's; it writes only there.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ProjectStore, approveQueue, ensureNexusSession, ensureUserSession, newId, writeRegistry, type Event, type SessionFile } from "@nexus/protocol";

const dir = process.argv[2];
if (!dir) throw new Error("usage: node seed-review-helper.ts <data dir>");
const root = join(dir, "demo");
mkdirSync(root, { recursive: true });
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

const st = ProjectStore.init(root, { id: "demo", name: "Demo app", root });
writeRegistry({ protocol: 1, projects: [{ id: "demo", root }] });
const session = (id: string, role: SessionFile["role"], min: number, more: Partial<SessionFile> = {}) => {
  st.writeSession({ protocol: 1, id, project: "demo", role, runtime: "claude", native_id: null, cwd: root, launched_by: "nexus", created_at: ago(min), ...more });
  return id;
};
const orch = session(newId(), "orchestrator", 200, { title: "Orchestrator", model: "claude-opus-5-5", effort: "high" });
// Reviewed by level from before the seeded events (the server marks a project without the mark as of its start).
st.updateProject((p) => ({ ...p, review_levels_since: ago(300), orchestrator: { runtime: "claude", notify: true, ...p.orchestrator, session: orch }, review_helper: { ...p.review_helper, model: "claude-haiku-5-5", effort: "low" } }));
const worker = session(newId(), "worker", 190, { title: "RV worker", queue: "RV" });
const user = ensureUserSession(st).id;
ensureNexusSession(st);
const emit = (session: string, min: number, body: Record<string, unknown>) => st.appendEvent({ v: 1, id: newId(), at: ago(min), session, ...body } as Event);

st.writeQueue({ protocol: 1, id: "RV", title: "Review rows", revision: 1, status: "proposed", review_level: 2, stop_conditions: [], checks: ["npm test"],
  steps: [
    { id: "RV1", title: "Rows for the review list", goal: "Each review shows its step and who reviews it.", acceptance: ["Every row names its step", "A test covers an empty list"] },
    { id: "RV2", title: "Calm colours", goal: "The list's colours follow the palette.", acceptance: ["The palette's colours only", "The look is calm"] },
    { id: "RV3", title: "Wording", goal: "The list's texts.", acceptance: ["Short texts"], review: { level: 1 } },
  ] });
approveQueue(st, "RV");

// RV1: sent back by the helper in round 1, accepted by it in round 2.
emit(worker, 180, { type: "step.started", queue: "RV", step: "RV1" });
emit(worker, 160, { type: "step.done", queue: "RV", step: "RV1", summary: "Rows with their step.", commit: "a1b2c3d" });
const h1 = session(newId(), "helper", 159, { model: "claude-haiku-5-5", effort: "low", about: { queue: "RV", step: "RV1", round: 1, level: 2 } });
emit(h1, 158, { type: "review.sent_back", queue: "RV", step: "RV1", text: "The test for an empty list is missing." });
const sent = st.readEvents(h1).entries.at(-1)!.id;
st.appendInbox(worker, { v: 1, id: `send-back-${sent}`, at: ago(158), from: "helper", type: "send_back", ref: sent, queue: "RV", step: "RV1", text: "The test for an empty list is missing.", round: 2 });
emit(worker, 150, { type: "step.started", queue: "RV", step: "RV1" });
emit(worker, 140, { type: "step.done", queue: "RV", step: "RV1", summary: "Rows with their step, and the empty-list test.", commit: "b2c3d4e" });
const h2 = session(newId(), "helper", 139, { model: "claude-haiku-5-5", effort: "low", about: { queue: "RV", step: "RV1", round: 2, level: 2 } });
emit(h2, 137, { type: "review.accepted", queue: "RV", step: "RV1", text: "Both criteria checked: the rows in the diff, the test in test/rows.test.ts." });

// RV2: passed on by the helper (the look is the user's judgement), accepted by the orchestrator.
emit(worker, 130, { type: "step.started", queue: "RV", step: "RV2" });
emit(worker, 110, { type: "step.done", queue: "RV", step: "RV2", summary: "The palette's colours.", commit: "c3d4e5f" });
const h3 = session(newId(), "helper", 109, { model: "claude-haiku-5-5", effort: "low", about: { queue: "RV", step: "RV2", round: 1, level: 2 } });
emit(h3, 108, { type: "review.passed_on", queue: "RV", step: "RV2", round: 1, reasons: ["criterion"], text: "The palette's colours checked; whether the look is calm cannot be judged from the packet." });
emit(orch, 100, { type: "review.accepted", queue: "RV", step: "RV2", text: "Calm enough against the mockup." });

// RV3: level 1, accepted by the user.
emit(worker, 90, { type: "step.started", queue: "RV", step: "RV3" });
emit(worker, 80, { type: "step.done", queue: "RV", step: "RV3", summary: "Shorter texts.", commit: "d4e5f6a" });
emit(user, 70, { type: "review.accepted", queue: "RV", step: "RV3" });
console.log("seeded demo: RV1 accepted by the review helper, RV2 by the orchestrator, RV3 by the user");
