// Conversations about a step ("Chat about this"): the link, the seed by the step's state, the "since then" addition,
// the step's latest conversation, and that a conversation changes nothing in the run. Against the fake runtimes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectStore, approveQueue, ensureUserSession, loadProjectState, newId, type Event, type StepDef } from "@nexus/protocol";
import { Engine } from "../src/engine.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import { Conversations } from "../src/conversations.ts";
import { stepSeed, sinceThen } from "../src/step-seed.ts";
import { WAIT_MS, until as waitUntil } from "./wait.ts";

const here = dirname(fileURLToPath(import.meta.url));
process.env.NEXUS_CLAUDE = join(here, "fake-claude.ts");
process.env.NEXUS_CODEX = join(here, "fake-codex.ts");
const CLI = join(here, "../../../packages/cli/bin/nexus.js");

const T0 = Date.now() - 86_400_000;
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();
const IDS = ["P1", "R1", "V1", "D1", "F1", "S1", "J1", "K1"] as const;
const step = (id: string): StepDef => ({ id, title: `Step ${id}`, goal: `The goal of ${id}.`, acceptance: [`${id} works`, `${id} is tested`] });

/** A queue with a step in every state: P1 pending, R1 running, V1 review, D1 done, F1 failed, S1 stopped, J1 rejected, K1 skipped. */
function setup() {
  const root = mkdtempSync(join(tmpdir(), "nexus-stepchat-"));
  process.env.NEXUS_HOME = join(root, "home");
  process.env.FAKE_LOG = join(root, "fake.log");
  delete process.env.FAKE_ARGS;
  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  store.writeSession({ protocol: 1, id: "w", project: "p", role: "worker", runtime: "claude", cwd: root, launched_by: "nexus", created_at: at(0), queue: "Q" });
  store.writeQueue({ protocol: 1, id: "Q", title: "Queue", revision: 1, status: "proposed", review_level: 1, stop_conditions: [], checks: [], steps: IDS.map(step) });
  approveQueue(store, "Q");
  ensureUserSession(store);
  const emit = (min: number, body: Record<string, unknown>, session = "w") => store.appendEvent({ v: 1, id: newId(), at: at(min), session, ...body } as Event);
  store.writeNote("Q", { id: newId(), step: "P1", from: "user", at: at(1) }, "Use the grassland settings.");
  emit(2, { type: "step.started", queue: "Q", step: "R1" });
  emit(3, { type: "step.progress", queue: "Q", step: "R1", text: "Half of the fixtures pass", pct: 50 });
  for (const [i, id] of (["V1", "D1", "J1"] as const).entries()) {
    emit(10 + i, { type: "step.started", queue: "Q", step: id });
    emit(10 + i, { type: "check.result", queue: "Q", step: id, name: "npm test", ok: true, summary: "212 passed" });
    emit(10 + i, { type: "review.added", queue: "Q", step: id, items: [{ path: `tmp/review/${id}.png`, label: `${id} sheet` }] });
    emit(10 + i, { type: "step.done", queue: "Q", step: id, summary: `${id} built`, commit: `c0ffee${i}` });
  }
  emit(20, { type: "review.accepted", queue: "Q", step: "D1" }, "user");
  emit(21, { type: "review.rejected", queue: "Q", step: "J1", text: "not this way" }, "user");
  emit(22, { type: "step.started", queue: "Q", step: "F1" });
  emit(23, { type: "step.failed", queue: "Q", step: "F1", reason: "the table does not exist" });
  emit(24, { type: "step.started", queue: "Q", step: "S1" });
  emit(25, { type: "queue.stop", queue: "Q", step: "S1", condition: "art", reason: "the art is missing" });
  const q = store.readQueue("Q");
  store.writeQueue({ ...q, steps: q.steps.map((s) => (s.id === "K1" ? { ...s, status: "skipped" as const } : s)) });
  const engine = new Engine(store, () => {});
  const orchestrator = new Orchestrator(store, engine, () => {});
  const conversations = new Conversations(store, orchestrator, () => {});
  const received = () => (existsSync(process.env.FAKE_LOG!) ? readFileSync(process.env.FAKE_LOG!, "utf8").trim().split("\n") : [])
    .map((l) => JSON.parse(l) as { text: string; session: string | null });
  const until = (what: string, pred: () => boolean, ms = WAIT_MS) => waitUntil(what, pred, ms);
  const stop = () => { conversations.shutdown(); orchestrator.shutdown(); engine.shutdown(); };
  return { root, store, emit, conversations, received, until, stop };
}

test("the seed by the step's state", () => {
  const { store, stop } = setup();
  try {
    const state = loadProjectState(store);
    assert.deepEqual(IDS.map((id) => state.queues[0]!.steps.find((s) => s.id === id)!.status),
      ["pending", "running", "review", "done", "failed", "stopped", "rejected", "skipped"]);
    const seed = (id: string) => stepSeed(state, "Q", id);
    const common = (id: string, s: string) => {
      assert.match(s, new RegExp(`about step ${id} \\("Step ${id}"\\) of queue Q \\("Queue"\\)`));
      assert.match(s, new RegExp(`Goal:\\nThe goal of ${id}\\.`));
      assert.match(s, new RegExp(`Acceptance criteria:\\n- ${id} works\\n- ${id} is tested`));
      assert.match(s, /changes nothing in the run/);
    };
    for (const id of IDS) common(id, seed(id));

    const pending = seed("P1");
    assert.match(pending, /Notes on the step:\n- from the user \([^)]+\): Use the grassland settings\./);
    assert.doesNotMatch(pending, /Progress|Summary|Checks|Review material|Commits/);

    const running = seed("R1");
    assert.match(running, /Progress so far \([^)]+\): Half of the fixtures pass \(50 %\)/);
    assert.doesNotMatch(running, /Summary|Checks:|Review material|Commits/);

    for (const id of ["V1", "D1", "J1"]) {
      const s = seed(id);
      assert.match(s, new RegExp(`Summary: ${id} built`));
      assert.match(s, /Checks:\n- npm test: ok: 212 passed/);
      assert.match(s, new RegExp(`Review material[^\\n]*\\n- tmp/review/${id}\\.png: ${id} sheet`));
      assert.match(s, /Commits: c0ffee\d/);
    }
    assert.match(seed("V1"), /The review waits for the user\./);
    assert.match(seed("J1"), /Reason \(rejected\): not this way/);
    assert.match(seed("F1"), /Reason \(failed\): the table does not exist/);
    assert.match(seed("S1"), /Reason \(stopped\): the art is missing/);
    const skipped = seed("K1");
    assert.doesNotMatch(skipped, /Progress|Summary|Checks|Commits/);
    assert.match(stepSeed(state, "Q", "X9"), /no longer exists/);
  } finally { stop(); }
});

test("a link needs an existing queue and step; it is kept apart from the session's queue", () => {
  const { conversations, stop } = setup();
  try {
    const c = conversations.create({ queue: "Q", step: "V1" });
    assert.deepEqual(c.about, { queue: "Q", step: "V1" });
    assert.equal(c.queue, undefined, "not a session of the queue");
    assert.equal(c.title, "V1: Step V1");
    assert.throws(() => conversations.create({ queue: "Q" }), /needs both queue and step/);
    assert.throws(() => conversations.create({ queue: "Q", step: "X9" }), /queue Q has no step X9/);
    assert.equal(conversations.create({ title: "Mining" }).about, undefined);
  } finally { stop(); }
});

test("the step's latest conversation: the newest by its last message; archived ones and other steps do not count", async () => {
  const { conversations, until, stop } = setup();
  try {
    assert.equal(conversations.latestFor("Q", "V1"), undefined);
    const a = conversations.create({ queue: "Q", step: "V1" });
    await new Promise((r) => setTimeout(r, 15));
    const b = conversations.create({ queue: "Q", step: "V1" });
    conversations.create({ queue: "Q", step: "D1" });
    conversations.create({ title: "Unlinked" });
    assert.equal(conversations.latestFor("Q", "V1")?.id, b.id, "the newer one");
    await new Promise((r) => setTimeout(r, 15));
    conversations.say(a.id, "Back to this one.");
    await until("a's reply", () => conversations.view(a.id).chat.some((x) => x.from === "partner"));
    assert.equal(conversations.latestFor("Q", "V1")?.id, a.id, "the one talked in last");
    conversations.update(a.id, { archived: true });
    assert.equal(conversations.latestFor("Q", "V1")?.id, b.id, "an archived one does not count");
    conversations.update(b.id, { archived: true });
    assert.equal(conversations.latestFor("Q", "V1"), undefined);
  } finally { stop(); }
});

test("opening and talking about a step in review leaves the run, the step and its notes untouched; nexus status there marks nothing read", async () => {
  const { root, store, conversations, received, until, stop } = setup();
  try {
    store.writeRun("Q", { protocol: 1, session: "w", state: "running", step: "V1", started_at: at(10), updated_at: at(13), revision: 1 });
    store.writeNote("Q", { id: newId(), step: "V1", from: "user", at: at(30) }, "A note for the worker.");
    const before = () => ({
      run: readFileSync(join(store.queueDir("Q"), "run.yaml"), "utf8"),
      events: store.sessionIds().map((id) => [id, existsSync(join(store.sessionDir(id), "events.jsonl")) ? readFileSync(join(store.sessionDir(id), "events.jsonl"), "utf8") : ""]),
    });
    const snapshot = before();
    const c = conversations.create({ queue: "Q", step: "V1" });
    assert.equal(received().length, 0, "opening starts no model turn");
    conversations.say(c.id, "Why is the sheet so dark?");
    await until("the reply", () => conversations.view(c.id).chat.some((x) => x.from === "partner"));

    // nexus status as the partner would run it.
    const env: NodeJS.ProcessEnv = { ...process.env, NEXUS_DIR: store.dir, NEXUS_SESSION: c.id };
    const out = execFileSync(process.execPath, [CLI, "status"], { env, encoding: "utf8", cwd: root });
    assert.match(out, /Queues/);

    const after = before();
    assert.equal(after.run, snapshot.run, "run.yaml untouched");
    assert.deepEqual(after.events.filter(([id]) => id !== c.id), snapshot.events, "no session's events changed");
    assert.ok(!existsSync(join(store.sessionDir(c.id), "events.jsonl")), "the conversation wrote no event (no note.read, no message.read)");
    const s = loadProjectState(store);
    const v1 = s.queues[0]!.steps.find((x) => x.id === "V1")!;
    assert.equal(v1.status, "review", "the step keeps waiting");
    assert.ok(v1.notes.every((n) => !n.read_at), "the worker's notes stay undelivered");
    assert.ok(s.attention.some((a) => a.kind === "review" && a.step === "V1"), "the review still waits for the user");
  } finally { stop(); }
});

test("the seed goes in with the first message; a state change since adds a short 'since then' to the next one", async () => {
  const { store, emit, conversations, received, until, stop } = setup();
  try {
    const c = conversations.create({ queue: "Q", step: "V1" });
    const said = () => received().filter((r) => r.session === c.id).map((r) => r.text);
    const replies = () => conversations.view(c.id).chat.filter((x) => x.from === "partner").length;

    conversations.say(c.id, "First question.");
    await until("the first reply", () => replies() >= 1);
    assert.match(said()[0]!, /^\[Nexus\] The user opened this conversation about step V1[\s\S]*The user's message follows\.\n\nFirst question\.$/);
    assert.deepEqual(store.readSession(c.id).about?.seeded?.status, "review");
    assert.deepEqual(conversations.view(c.id).chat.filter((x) => x.from === "user").map((x) => x.text), ["First question."], "the chat keeps the user's words only");

    conversations.say(c.id, "Second, nothing changed.");
    await until("the second reply", () => replies() >= 2);
    assert.equal(said()[1], "Second, nothing changed.");

    emit(40, { type: "review.accepted", queue: "Q", step: "V1" }, "user");
    conversations.say(c.id, "And now?");
    await until("the third reply", () => replies() >= 3);
    assert.match(said()[2]!, /^\[Nexus\] Since you got its context \([^)]+\), step V1 went from review to done\.\nSummary: V1 built\nCommits: c0ffee0\nChecks: 1 ok\.\nReview material: tmp\/review\/V1\.png\nThe user's message follows\.\n\nAnd now\?$/);
    assert.equal(store.readSession(c.id).about?.seeded?.status, "done");

    conversations.say(c.id, "Thanks.");
    await until("the fourth reply", () => replies() >= 4);
    assert.equal(said()[3], "Thanks.", "told once");

    const st = loadProjectState(store);
    assert.equal(sinceThen(st, "Q", "V1", { status: "done", at: at(0) }), undefined);
    assert.match(sinceThen(st, "Q", "R1", { status: "pending", at: at(0) })!, /went from pending to running\.\nStarted: [^\n]+\nProgress so far/);
  } finally { stop(); }
});
