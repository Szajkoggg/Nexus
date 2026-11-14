// `nexus status`: without a session it lists the queues at work and then the approved ones not running; a session with
// a queue sees only its own.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectStore, applyDraft, approveQueue, loadProjectState, newId, orchestratorStatusChange, setStepLevel, type Event } from "@nexus/protocol";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "../bin/nexus.js");
const T0 = Date.now() - 86_400_000;
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();

function setup() {
  const root = mkdtempSync(join(tmpdir(), "nexus-cli-status-"));
  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  store.writeSession({ protocol: 1, id: "w", project: "p", role: "worker", runtime: "claude", cwd: root, launched_by: "nexus", created_at: at(0), queue: "A" });
  const queue = (id: string, status: "draft" | "proposed", approve = true) => {
    store.writeQueue({
      protocol: 1, id, title: `Queue ${id}`, revision: 1, status, stop_conditions: [], checks: [],
      steps: [1, 2].map((n) => ({ id: `${id}${n}`, title: `Step ${id}${n}`, goal: "", acceptance: [] })),
    });
    if (approve) approveQueue(store, id);
  };
  const emit = (min: number, body: Record<string, unknown>, session = "w") => store.appendEvent({ v: 1, id: newId(), at: at(min), session, ...body } as Event);
  store.writeSession({ protocol: 1, id: "u", project: "p", role: "user", runtime: "external", cwd: root, launched_by: "nexus", created_at: at(0) });
  queue("D", "draft", false);
  queue("P", "proposed", false);
  queue("A", "proposed");
  queue("H", "proposed");
  queue("R", "proposed");
  queue("S", "proposed");
  queue("X", "proposed");
  queue("C", "proposed");
  // H: approved, its run halted before any step started.
  store.writeRun("H", { protocol: 1, session: "w", state: "halted", reason: "the session\nended", step: "H1", started_at: at(1), updated_at: at(2) });
  emit(3, { type: "step.started", queue: "R", step: "R1" });
  emit(4, { type: "step.started", queue: "S", step: "S1" });
  emit(5, { type: "queue.stop", queue: "S", step: "S1", condition: "art", reason: "missing" });
  for (const n of [1, 2]) {
    emit(5 + n, { type: "step.started", queue: "X", step: `X${n}` });
    emit(5 + n, { type: "step.done", queue: "X", step: `X${n}`, summary: "ok" });
    emit(5 + n, { type: "review.accepted", queue: "X", step: `X${n}` }, "u"); // every step is reviewed
  }
  orchestratorStatusChange(store, { queue: "C", to: "cancelled", reason: "no longer needed" });
  return store;
}

function status(store: ProjectStore, session?: string): string {
  const env: NodeJS.ProcessEnv = { ...process.env, NEXUS_DIR: store.dir };
  delete env.NEXUS_SESSION;
  return execFileSync(process.execPath, [CLI, "status", ...(session ? ["--session", session] : [])], { env, encoding: "utf8" });
}

const listed = (out: string) => [...out.matchAll(/^queue (\w+) \[(\w+)\]/gm)].map((m) => `${m[1]} ${m[2]}`);

test("without a session: the queues at work, then the approved ones not running, with a run left behind", () => {
  const store = setup();
  assert.deepEqual(
    loadProjectState(store).queues.map((q) => `${q.id} ${q.status}`).sort(),
    ["A approved", "C cancelled", "D draft", "H approved", "P proposed", "R running", "S stopped", "X done"],
  );
  const out = status(store);
  assert.deepEqual(listed(out), ["R running", "S stopped", "A approved", "H approved"]);
  assert.match(out, /^ {2}why: art: missing$/m);
  assert.match(out, /^ {2}run: halted at H1 \(the session ended\)$/m);
  assert.match(out, /^ {2}A1 {4}pending {2}Step A1$/m);
  assert.doesNotMatch(out, /no approval recorded/);
});

test("a session with a queue sees only its own", () => {
  const store = setup();
  const out = status(store, "w");
  assert.match(out, /^session w: worker, claude, queue A$/m);
  assert.deepEqual(listed(out), ["A approved"]);
});

test("a stopped queue's proposal to lift: under the queue, and in the orchestrator's Waiting for the user", () => {
  const store = setup();
  store.writeSession({ protocol: 1, id: "o", project: "p", role: "orchestrator", runtime: "claude", cwd: store.dir, launched_by: "nexus", created_at: at(0) });
  orchestratorStatusChange(store, { queue: "S", step: "S1", to: "skipped", reason: "replaced by S2" });
  orchestratorStatusChange(store, { queue: "S", to: "propose-lift", reason: "S2 can run now" });
  const proposal = /^ {2}proposal to lift \(orchestrator, [\d-]+T[\d:.]+Z\): S2 can run now$/m;

  const plain = status(store);
  assert.match(plain, /^ {2}stopped \(the stop came from S1, now skipped\); the user lifts it with Continue, or by approving a new revision$/m);
  assert.match(plain, proposal);

  const overview = status(store, "o");
  const [queues, waiting] = overview.split("\nWaiting for the user\n");
  assert.ok(waiting, overview);
  assert.match(queues!, /^- S \[stopped\][^\n]*\n {2}steps: [^\n]*\n {2}why: art: missing\n {2}stopped \(the stop came from S1, now skipped\); the user lifts it with Continue/m);
  assert.match(queues!, proposal);
  assert.match(waiting, /^- stopped S \(the stop came from S1, now skipped\): art: missing\n {2}Continue lifts it\n {2}proposal to lift \(orchestrator, [^)]+\): S2 can run now$/m);
});

test("a step's own runtime, model and effort: on its line, and in the orchestrator's overview", () => {
  const store = setup();
  const p = store.readQueue("P");
  store.writeQueue({ ...p, steps: [p.steps[0]!, { ...p.steps[1]!, runtime: "codex", model: "gpt-6-luna", effort: "low" }] });
  approveQueue(store, "P");
  const plain = status(store);
  assert.match(plain, /^ {2}P2 {4}pending {2}Step P2 {2}\[on Codex · gpt-6-luna · low effort\]$/m);
  assert.match(plain, /^ {2}P1 {4}pending {2}Step P1$/m, "a step without its own values: nothing");
  store.writeSession({ protocol: 1, id: "o", project: "p", role: "orchestrator", runtime: "claude", cwd: store.dir, launched_by: "nexus", created_at: at(0) });
  assert.match(status(store, "o"), /^ {2}steps: P1 pending \(level 2\), P2 pending \(level 2\) \[on Codex · gpt-6-luna · low effort\]$/m);
  // A level the user set is marked so.
  setStepLevel(store, "P", "P1", 1);
  assert.match(status(store, "o"), /^ {2}steps: P1 pending \(level 1, set by the user\), P2 pending \(level 2\)/m);
});

test("a planned queue whose new revision waits for approval says so first, the planned start after it", () => {
  const store = setup();
  store.writeSession({ protocol: 1, id: "o", project: "p", role: "orchestrator", runtime: "claude", cwd: store.dir, launched_by: "nexus", created_at: at(0) });
  store.writeQueue({ protocol: 1, id: "ST", title: "Queue ST", revision: 1, status: "proposed", stop_conditions: [], checks: [], steps: [{ id: "ST1", title: "Step", goal: "", acceptance: [] }] });
  approveQueue(store, "ST");
  store.writeStart("ST", { protocol: 1, after: "A", by: "orchestrator", revision: 1, created_at: at(1) });
  let out = status(store, "o");
  assert.match(out, /^- ST \[approved\] Queue ST: revision 1, approved\n {2}steps: [^\n]*\n {2}starts when A is done/m, "approved: the plan alone");
  assert.doesNotMatch(out.split("\n- ST")[1]!.split("\n- ")[0]!, /needs approval/);

  // The orchestrator changes it: revision 2, not approved yet.
  applyDraft(store, { id: "ST", title: "Queue ST", stop_conditions: [], checks: [], steps: [{ id: "ST1", title: "Step, revised", goal: "", acceptance: [] }] });
  out = status(store, "o");
  assert.match(out, /^- ST \[\w+\] Queue ST: revision 2, not approved\n {2}needs approval \(revision 2\): the planned start below waits for it\n {2}steps: [^\n]*\n {2}then starts when A is done/m);
  // Without a session: listed with its approval, when its status puts it in the list.
  if (loadProjectState(store).queues.find((q) => q.id === "ST")!.status !== "proposed") assert.match(status(store), /^queue ST \[\w+\] Queue ST \(needs approval: revision 2\)$/m);
});
