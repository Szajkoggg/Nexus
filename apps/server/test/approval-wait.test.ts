// A new revision of a running queue never stops the running step (queue RQ): the step goes on to its end through its
// questions and answers; at its end the run goes on under the approved revision in the same session, or waits for the
// approval (approval_wait) and goes on by itself once it comes. Restarts, updates, pauses and the refusals while it
// waits. Against the fake runtimes; no model.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ProjectStore, answerAsUser, applyDraft, approveQueue, loadProjectState, orchestratorStatusChange, routeAnswers, type StepDef,
} from "@nexus/protocol";
import { Engine, type EngineOptions } from "../src/engine.ts";
import { acceptReviews } from "./fake-reviewer.ts";
import { WAIT_MS, until as waitUntil, LONGER, holdWork } from "./wait.ts";


const here = dirname(fileURLToPath(import.meta.url));
process.env.NEXUS_CLAUDE = join(here, "fake-claude.ts");
process.env.NEXUS_CODEX = join(here, "fake-codex.ts");
const FAST: EngineOptions = { retryBaseMs: 30, usageMarginMs: 100 };

const step = (id: string, behaviour: string): StepDef => ({ id, title: `Step ${id}`, goal: `FAKE: ${behaviour}`, acceptance: [] });

function setup(steps: StepDef[]) {
  const root = mkdtempSync(join(tmpdir(), "nexus-approval-wait-"));
  process.env.NEXUS_HOME = join(root, "home");
  process.env.FAKE_LOG = join(root, "fake.log");
  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  store.writeQueue({ protocol: 1, id: "W", title: "Cliffs", revision: 1, status: "proposed", stop_conditions: [], checks: [], steps });
  approveQueue(store, "W");
  const engines: Engine[] = [];
  /** An engine as the server makes one: every change it notices calls onChange (a restart is a new one). */
  const engine = (): Engine => {
    const e: Engine = new Engine(store, () => { routeAnswers(store); acceptReviews(store); e.onChange(loadProjectState(store)); }, FAST);
    engines.push(e);
    return e;
  };
  const queue = (id = "W") => loadProjectState(store).queues.find((q) => q.id === id)!;
  const statuses = () => queue().steps.map((s) => `${s.id}=${s.status}`).join(" ");
  const log = () => (existsSync(process.env.FAKE_LOG!) ? readFileSync(process.env.FAKE_LOG!, "utf8").trim().split("\n") : [])
    .map((l) => JSON.parse(l) as { text: string; session: string | null });
  /** The steps opened, in order, with the Nexus session each was opened in. */
  const opened = () => log().filter((m) => m.text.startsWith("[Nexus] Queue W ")).map((m) => `${/step (\S+) \(/.exec(m.text)![1]}@${m.session}`);
  const until = (what: string, pred: () => boolean, ms = WAIT_MS) => waitUntil(what, pred, ms, () => `; run ${JSON.stringify(queue().run)}; ${statuses()}`);
  /** A new revision as the orchestrator drafts one: the steps as they are, then `more`; pending ones may change. */
  const revise = (o: { change?: Record<string, Partial<StepDef>>; drop?: string[]; more?: StepDef[] } = {}) => applyDraft(store, {
    id: "W", title: "Cliffs", stop_conditions: [], checks: [],
    steps: [
      ...store.readQueue("W").steps.filter((s) => !o.drop?.includes(s.id)).map(({ status: _s, status_note: _n, ...s }) => ({ ...s, ...o.change?.[s.id] })),
      ...(o.more ?? []),
    ],
  });
  const answer = (e: Engine) => {
    const qid = loadProjectState(store).questions.find((x) => x.state === "open")!.qid;
    answerAsUser(store, qid, "Left.", true);
    e.onChange(loadProjectState(store));
  };
  /** What the server's file watcher does after the user approves in the dashboard. */
  const approve = (e: Engine) => { approveQueue(store, "W"); e.onChange(loadProjectState(store)); };
  const stop = () => { for (const e of engines) e.shutdown(); delete process.env.FAKE_SLOW_MS; delete process.env.FAKE_RELEASE; };
  return { root, store, engine, queue, statuses, opened, until, revise, answer, approve, stop };
}

for (const runtime of ["claude", "codex"] as const) {
  test(`${runtime}: a draft during a step's turn, a question answered mid-step, approved by the step's end: the next step opens in the same session`, async () => {
    const work = holdWork();
    const x = setup([step("W1", "slowask"), step("W2", "done")]);
    const e = x.engine();
    try {
      e.start("W", { runtime });
      await x.until("W1 at work", () => x.queue().steps[0]!.segments.length > 0, LONGER.step);
      const session = x.queue().run!.session;
      x.revise({ change: { W2: { title: "Step W2, revised" } }, more: [step("W3", "done")] });
      work.release(); // W1 may end now: the revision came while it worked
      await x.until("the question", () => x.queue().steps[0]!.status === "waiting", LONGER.step);
      await new Promise((r) => setTimeout(r, 400));
      assert.equal(x.queue().run!.state, "running", "the draft stopped nothing");
      assert.equal(x.queue().approved, false);
      x.approve(e);
      assert.equal(x.queue().run!.state, "running", "approved mid-step: the step goes on");
      x.answer(e);
      await x.until("the run to finish", () => x.queue().run?.state === "finished", LONGER.run);
      assert.deepEqual(x.opened(), [`W1@${session}`, `W2@${session}`, `W3@${session}`], "every step in the one session, no new start");
      assert.equal(x.statuses(), "W1=done W2=done W3=done");
      assert.equal(x.queue().run!.revision, 2, "the run took the new revision at W1's end");
      assert.equal(x.queue().changes.filter((c) => c.by === "nexus").length, 0, "no step was released");
    } finally { x.stop(); }
  });

  test(`${runtime}: a step that ends before the approval: the run waits, keeps its session, and goes on by itself once approved`, async () => {
    const work = holdWork();
    const x = setup([step("W1", "slowask"), step("W2", "done")]);
    const e = x.engine();
    try {
      e.start("W", { runtime });
      await x.until("W1 at work", () => x.queue().steps[0]!.segments.length > 0, LONGER.step);
      const session = x.queue().run!.session;
      x.revise({ more: [step("W3", "done")] });
      work.release(); // W1 may end now: the revision came while it worked
      await x.until("the question", () => x.queue().steps[0]!.status === "waiting", LONGER.step);
      x.answer(e);
      await x.until("the wait", () => x.queue().run?.state === "approval_wait");
      const q = x.queue();
      assert.equal(q.run!.reason, "waits for approval of revision 2");
      assert.equal(q.run!.session, session);
      assert.equal(q.run!.revision, 1, "the run's revision moves only when it goes on");
      assert.equal(x.statuses(), "W1=done W2=pending W3=pending");
      assert.notEqual(q.status, "done");
      await new Promise((r) => setTimeout(r, 400));
      assert.equal(x.queue().run!.state, "approval_wait", "it waits, not halted");
      assert.throws(() => e.resume("W"), /waits for approval of revision 2; it goes on by itself once you approve it/);

      x.approve(e);
      await x.until("the run to finish", () => x.queue().run?.state === "finished", LONGER.run);
      assert.deepEqual(x.opened(), [`W1@${session}`, `W2@${session}`, `W3@${session}`]);
      assert.equal(x.queue().run!.revision, 2);
      assert.equal(x.queue().status, "done");
    } finally { x.stop(); }
  });
}

test("a revision that removes every remaining step: the queue is done only once approved, and a chain after it fires then", async () => {
  const work = holdWork();
  const x = setup([step("W1", "slow"), step("W2", "done")]);
  x.store.writeQueue({ protocol: 1, id: "C", title: "After", revision: 1, status: "proposed", stop_conditions: [], checks: [], steps: [step("C1", "done")] });
  approveQueue(x.store, "C");
  const e = x.engine();
  try {
    e.start("W");
    assert.match(e.chain("C", { after: "W", by: "user" }), /starts when queue W is done/);
    await x.until("W1 at work", () => x.queue().steps[0]!.segments.length > 0, LONGER.step);
    x.revise({ drop: ["W2"] });
    work.release(); // W1 may end now: the revision came while it worked
    await x.until("the wait", () => x.queue().run?.state === "approval_wait");
    await new Promise((r) => setTimeout(r, 1700)); // past the first look at the planned starts
    assert.equal(x.statuses(), "W1=done");
    assert.equal(x.queue().status, "waiting", "not done while the revision waits");
    assert.equal(x.queue().status_reason, "waits for approval of revision 2");
    assert.equal(x.queue("C").run, undefined, "the chain has not fired");

    x.approve(e);
    await x.until("the run to finish", () => x.queue().run?.state === "finished", LONGER.run);
    assert.equal(x.queue().status, "done");
    await x.until("the chain to fire", () => x.queue("C").run?.state === "finished");
  } finally { x.stop(); }
});

test("an approval while an update drains: the run goes on after the restart, or once the drain is cancelled", async () => {
  for (const how of ["restart", "cancel"] as const) {
    const work = holdWork();
    const x = setup([step("W1", "slow"), step("W2", "done")]);
    const e = x.engine();
    try {
      e.start("W");
      await x.until("W1 at work", () => x.queue().steps[0]!.segments.length > 0, LONGER.step);
      const session = x.queue().run!.session;
      x.revise({ change: { W2: { title: "Step W2, revised" } } });
      work.release(); // W1 may end now: the revision came while it worked
      await x.until("the wait", () => x.queue().run?.state === "approval_wait");
      assert.deepEqual(e.drainForUpdate(false), [], "a run waiting for approval is not held");
      x.approve(e);
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(x.queue().run!.state, "approval_wait", `${how}: no continuation while the update drains`);
      if (how === "cancel") e.cancelDrain();
      else { e.shutdown(); x.engine(); }
      await x.until("the run to finish", () => x.queue().run?.state === "finished", LONGER.run);
      assert.deepEqual(x.opened(), [`W1@${session}`, `W2@${session}`], how);
      assert.equal(x.queue().run!.revision, 2);
    } finally { x.stop(); }
  }
});

test("the user's pause wins over approval_wait; a resume before the approval waits again, one after it goes on", async () => {
  const x = setup([step("W1", "done"), step("W2", "ask"), step("W3", "done")]);
  const e = x.engine();
  try {
    e.start("W");
    await x.until("the question", () => x.queue().steps[1]!.status === "waiting", LONGER.step);
    const session = x.queue().run!.session;
    x.revise({ change: { W3: { title: "Step W3, revised" } } });
    x.answer(e);
    await x.until("the wait", () => x.queue().run?.state === "approval_wait");
    e.pause("W");
    assert.equal(x.queue().run!.state, "paused");
    assert.equal(x.queue().run!.reason, "paused by the user");
    e.resume("W"); // the revision still waits: back to waiting for it
    await x.until("the wait again", () => x.queue().run?.state === "approval_wait");
    e.pause("W");
    x.approve(e);
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(x.queue().run!.state, "paused", "the approval does not undo the user's pause");
    e.resume("W");
    await x.until("the run to finish", () => x.queue().run?.state === "finished", LONGER.run);
    assert.deepEqual(x.opened(), [`W1@${session}`, `W2@${session}`, `W3@${session}`]);
    assert.equal(x.queue().run!.revision, 2);
  } finally { x.stop(); }
});

test("a deploy and a plain restart mid-step with an unapproved revision keep the step and the session", async () => {
  for (const how of ["deploy", "restart"] as const) {
    const x = setup([step("W1", "ask"), step("W2", "done")]);
    let e = x.engine();
    try {
      e.start("W");
      await x.until("the question", () => x.queue().steps[0]!.status === "waiting", LONGER.step);
      const session = x.queue().run!.session;
      x.revise({ more: [step("W3", "done")] });
      if (how === "deploy") assert.deepEqual(e.drainForUpdate(false), ["W"]);
      e.shutdown();
      await x.until("the process to exit", () => x.store.readRuntime(session)?.state === "exited");
      e = x.engine();
      if (how === "deploy") await x.until("the resume after the update", () => x.queue().run?.state === "running");
      else {
        assert.equal(x.queue().run!.state, "paused", "a plain restart pauses the run, as any");
        e.resume("W");
      }
      const q = x.queue();
      assert.equal(q.run!.session, session, how);
      assert.equal(q.steps[0]!.status, "waiting", `${how}: W1 still waits for its answer`);
      assert.equal(q.changes.filter((c) => c.by === "nexus").length, 0, `${how}: no step was released`);
      x.answer(e);
      await x.until("the wait", () => x.queue().run?.state === "approval_wait");
      x.approve(e);
      await x.until("the run to finish", () => x.queue().run?.state === "finished", LONGER.run);
      assert.equal(x.statuses(), "W1=done W2=done W3=done", how);
      assert.ok(x.opened().every((o) => o.endsWith(`@${session}`)), how);
    } finally { x.stop(); }
  }
});

test("a deploy and a plain restart in approval_wait: it still waits, in its session, and goes on once approved", async () => {
  for (const how of ["deploy", "restart"] as const) {
    const x = setup([step("W1", "ask"), step("W2", "done")]);
    let e = x.engine();
    try {
      e.start("W");
      await x.until("the question", () => x.queue().steps[0]!.status === "waiting", LONGER.step);
      const session = x.queue().run!.session;
      x.revise({ more: [step("W3", "done")] });
      x.answer(e);
      await x.until("the wait", () => x.queue().run?.state === "approval_wait");
      if (how === "deploy") assert.deepEqual(e.drainForUpdate(false), []);
      e.shutdown();
      e = x.engine();
      await new Promise((r) => setTimeout(r, 1800)); // past the restart's own resumes
      const q = x.queue();
      assert.deepEqual([q.run!.state, q.run!.session, q.run!.reason], ["approval_wait", session, "waits for approval of revision 2"], how);
      assert.equal(x.statuses(), "W1=done W2=pending W3=pending", how);
      x.approve(e);
      await x.until("the run to finish", () => x.queue().run?.state === "finished", LONGER.run);
      assert.ok(x.opened().every((o) => o.endsWith(`@${session}`)), how);
    } finally { x.stop(); }
  }
});

test("while a run waits for approval: a start, a session chain onto its session and a cancel are refused", async () => {
  const work = holdWork();
  const x = setup([step("W1", "slow"), step("W2", "done")]);
  // O and A work in checkouts of their own: W's run, waiting for approval, holds the project's.
  const own = (id: string) => { const d = join(x.store.dir, "..", `wt-${id}`); mkdirSync(d, { recursive: true }); return d; };
  x.store.writeQueue({ protocol: 1, id: "O", title: "Other", revision: 1, status: "proposed", stop_conditions: [], checks: [], steps: [step("O1", "done")], worktree: own("O") });
  approveQueue(x.store, "O");
  x.store.writeQueue({ protocol: 1, id: "A", title: "Before", revision: 1, status: "proposed", stop_conditions: [], checks: [], steps: [step("A1", "done")], worktree: own("A") });
  approveQueue(x.store, "A");
  const e = x.engine();
  try {
    // A pending step changed while W1 runs: at W1's end the run waits.
    e.start("W");
    await x.until("W1 at work", () => x.queue().steps[0]!.segments.length > 0, LONGER.step);
    const session = x.queue().run!.session;
    x.revise({ change: { W2: { title: "Step W2, revised" } } });
    work.release(); // W1 may end now: the revision came while it worked
    await x.until("the wait", () => x.queue().run?.state === "approval_wait");

    assert.throws(() => e.start("W"), /the queue's run waits for approval of revision 2; it goes on by itself once you approve it/);
    assert.throws(() => e.start("O", { session }), /that session is running queue W/);
    // A chain onto the session waits for it, also once the queue it follows is done.
    e.start("A");
    await x.until("A to finish", () => x.queue("A").run?.state === "finished", LONGER.run);
    assert.match(e.chain("O", { after: "A", by: "user", session }), /starts when session \S+ is free \(it runs queue W; queue A is done\)/);
    await new Promise((r) => setTimeout(r, 1700));
    assert.equal(x.queue("O").run, undefined, "the chain waits for the session");
    assert.throws(() => orchestratorStatusChange(x.store, { queue: "W", to: "cancelled", reason: "no longer needed" }), /queue W is running \(approval_wait\): stop its run first/);

    x.approve(e);
    await x.until("W to finish", () => x.queue().run?.state === "finished", LONGER.run);
    await x.until("the chain to fire once the session is free", () => x.queue("O").run?.state === "finished");
    assert.equal(x.queue("O").run!.session, session);
  } finally { x.stop(); }
});
