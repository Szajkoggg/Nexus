// A queue back from waiting (an answer, a review) asks for a place under the limit before it opens a new turn or its
// next step (src/coordinator.ts, src/engine.ts heldAtLimit; decided 2026-11-15, queue LQ): with the limit full it is
// held (run.yaml `held`), and the first place that frees goes to it, before a planned start. What reaches a live turn is
// never held. Against the fake runtimes, a limit of 2, each queue in a project of its own (so in a checkout of its own).
import { test } from "node:test";
import assert from "node:assert/strict";
import { answerAsUser, isOpenQuestion, loadProjectState, type ProjectStore } from "@nexus/protocol";
import { world, type Received } from "./coordinator-world.ts";
import { LONGER, holdWork, sleep, until } from "./wait.ts";

type World = ReturnType<typeof world>;
type Project = ReturnType<World["add"]>;

/**
 * Watches the projects while a test runs, every 20 ms: never more queues counted toward the limit than it allows, and
 * no worker of a held run at work. `check()` stops watching and fails with what it saw.
 */
function watchLimit(w: World, stores: ProjectStore[], limit: number) {
  const faults: string[] = [];
  let worst = 0;
  const timer = setInterval(() => {
    const counted = w.coordinator.holders().filter((h) => h.counts);
    worst = Math.max(worst, counted.length);
    if (counted.length > limit) faults.push(`${counted.length} counted: ${counted.map((h) => h.queue).join(", ")}`);
    for (const store of stores) {
      const state = loadProjectState(store);
      for (const q of state.queues) {
        if (!q.run?.held) continue;
        if (state.sessions.find((s) => s.id === q.run!.session)?.live?.state === "working") faults.push(`held queue ${q.id} at work`);
      }
    }
  }, 20);
  return {
    check() {
      clearInterval(timer);
      assert.deepEqual(faults.slice(0, 5), [], "the limit held throughout");
      assert.equal(worst, limit, "the limit was reached (the test tested something)");
    },
  };
}

/** The step's status. */
const status = (p: Project, queue: string, step: string) => p.queue(queue).steps.find((s) => s.id === step)?.status;
/** The live state of the queue's worker. */
const worker = (p: Project, queue: string) => {
  const state = loadProjectState(p.store);
  return state.sessions.find((s) => s.id === state.queues.find((q) => q.id === queue)?.run?.session)?.live?.state;
};
/** What reached the queue's worker session(s). */
const toWorker = (w: World, p: Project, queue: string): Received[] => {
  const sessions = new Set(loadProjectState(p.store).sessions.filter((s) => s.queue === queue).map((s) => s.id));
  return w.received().filter((r) => r.session && sessions.has(r.session));
};
/** The activity lines of the queue's worker session(s). */
const activity = (p: Project, queue: string): string[] =>
  loadProjectState(p.store).sessions.filter((s) => s.queue === queue).flatMap((s) => p.store.readActivity(s.id).entries.map((a) => a.text));

test("a queue back from its answer waits for a place, gets the first one before a planned start, and then its answer", async () => {
  const work = holdWork();
  const w = world({ limit: 2 });
  const a = w.add("a", { A: ["slow"] }), b = w.add("b", { B: ["slow"] }), c = w.add("c", { C: ["ask"] }), d = w.add("d", { D: ["done"] });
  const watch = watchLimit(w, [a.store, b.store, c.store, d.store], 2);
  try {
    c.engine.start("C");
    await w.until("C to ask and end its turn", () => c.queue("C").questions.some(isOpenQuestion) && worker(c, "C") === "idle", LONGER.step);
    // C waits for its answer and counts no more: two others start.
    a.engine.start("A");
    b.engine.start("B");
    await w.until("A and B at work", () => status(a, "A", "A1") === "running" && status(b, "B", "B1") === "running", LONGER.step);

    answerAsUser(c.store, c.queue("C").questions[0]!.qid, "this way", true);
    await w.until("C to be held", () => !!c.queue("C").run?.held);
    const run = c.queue("C").run!;
    assert.equal(run.state, "running", "held, the run goes on: it opens nothing");
    assert.equal(run.held!.kind, "limit");
    assert.equal(run.held!.reason, "waits: 2 queues run, the limit is 2");
    assert.equal(run.reason, "waits: 2 queues run, the limit is 2", "the run says why");
    assert.ok(activity(c, "C").some((t) => t.startsWith("Nexus holds queue C before the turn its answers or send-back open: it waits: 2 queues run")));
    // A planned start that comes due meanwhile waits too.
    d.engine.plan("D", { after: [], by: "user" });
    assert.equal(d.queue("D").start?.held?.kind, "limit");

    // Held, it stays so: the answer waits in the inbox, and no turn opens.
    await sleep(600);
    w.tick();
    assert.ok(c.queue("C").run!.held, "still held");
    assert.equal(toWorker(w, c, "C").filter((r) => r.text.includes("[Nexus] Answer")).length, 0, "no answer delivered yet");
    assert.equal(worker(c, "C"), "idle");

    // A's place frees: C takes it, before D's planned start.
    work.release("A1");
    await w.until("C to go on", () => !c.queue("C").run?.held, LONGER.run);
    assert.equal(d.queue("D").run, undefined, "the place went to the held queue, not to the planned start");
    assert.ok(activity(c, "C").some((t) => t.startsWith("Nexus lets queue C go on: a place under the limit is free")));
    await w.until("C to finish", () => c.queue("C").run?.state === "finished", LONGER.run);
    assert.equal(c.queue("C").run!.reason, undefined);
    const answers = toWorker(w, c, "C").filter((r) => r.text.includes("[Nexus] Answer"));
    assert.equal(answers.length, 1, "the answer arrived, once");
    assert.match(answers[0]!.text, /this way/);
    assert.equal(status(c, "C", "C1"), "done");

    // D starts once a place is free (C's), and B goes on meanwhile.
    await w.until("D to finish", () => d.queue("D").run?.state === "finished", LONGER.run);
    work.release();
    await w.until("B to finish", () => b.queue("B").run?.state === "finished", LONGER.run);
    watch.check();
  } finally { work.release(); w.stop(); work.done(); }
});

test("the next step after an accepted review waits for a place, and opens by itself once one frees", async () => {
  const work = holdWork();
  const w = world({ limit: 2 });
  const a = w.add("a", { A: ["slow"] }), b = w.add("b", { B: ["slow"] }), c = w.add("c", { C: { steps: ["done", "done"], level: 1 } });
  const watch = watchLimit(w, [a.store, b.store, c.store], 2);
  try {
    c.engine.start("C");
    await w.until("C1 in review", () => status(c, "C", "C1") === "review" && worker(c, "C") === "idle", LONGER.step);
    a.engine.start("A");
    b.engine.start("B");
    await w.until("A and B at work", () => status(a, "A", "A1") === "running" && status(b, "B", "B1") === "running", LONGER.step);

    c.engine.acceptReview("C", "C1");
    assert.equal(c.queue("C").run?.held?.reason, "waits: 2 queues run, the limit is 2", "held at once, at the step boundary");
    assert.ok(activity(c, "C").some((t) => t.startsWith("Nexus holds queue C before step C2: it waits: 2 queues run")));
    await sleep(600);
    w.tick();
    assert.equal(status(c, "C", "C2"), "pending", "C2 does not open while held");
    assert.equal(toWorker(w, c, "C").filter((r) => r.text.includes("step C2 (2 of 2)")).length, 0);

    work.release("B1");
    await w.until("C2 to open and reach its review", () => status(c, "C", "C2") === "review", LONGER.run);
    assert.equal(c.queue("C").run?.held, undefined);
    c.engine.acceptReview("C", "C2");
    await w.until("C to finish", () => c.queue("C").run?.state === "finished", LONGER.run);
    work.release();
    await w.until("A to finish", () => a.queue("A").run?.state === "finished", LONGER.run);
    watch.check();
  } finally { work.release(); w.stop(); work.done(); }
});

test("the closing refactoring step after an accepted review waits for a place too", async () => {
  const work = holdWork();
  const w = world({ limit: 2 });
  const a = w.add("a", { A: ["slow"] }), b = w.add("b", { B: ["slow"] }), c = w.add("c", { C: { steps: ["done"], level: 1, coding: true } });
  const watch = watchLimit(w, [a.store, b.store, c.store], 2);
  try {
    c.engine.start("C");
    await w.until("C1 in review", () => status(c, "C", "C1") === "review" && worker(c, "C") === "idle", LONGER.step);
    a.engine.start("A");
    b.engine.start("B");
    await w.until("A and B at work", () => status(a, "A", "A1") === "running" && status(b, "B", "B1") === "running", LONGER.step);

    c.engine.acceptReview("C", "C1");
    assert.equal(c.queue("C").run?.held?.reason, "waits: 2 queues run, the limit is 2");
    assert.ok(activity(c, "C").some((t) => t.startsWith("Nexus holds queue C before step C.refactor")));
    await sleep(600);
    w.tick();
    assert.equal(status(c, "C", "C.refactor"), "pending");
    assert.equal(c.queue("C").run?.switches, undefined, "no fresh session for it yet");

    work.release("A1");
    // Its review is at the closing step's own level: the fake reviewer may accept it before the test looks.
    await until("the closing step to open and end", () => ["review", "done"].includes(status(c, "C", "C.refactor") ?? ""), LONGER.processes,
      () => `; C: run ${JSON.stringify(c.queue("C").run)}; ${c.queue("C").steps.map((s) => `${s.id}=${s.status}`).join(" ")}; A: ${a.queue("A").run?.state}; activity: ${activity(c, "C").slice(-6).join(" | ")}`);
    assert.equal(c.queue("C").run?.switches?.at(-1)?.why, "refactor", "in its fresh session");
    if (status(c, "C", "C.refactor") === "review") c.engine.acceptReview("C", "C.refactor");
    await w.until("C to finish", () => c.queue("C").run?.state === "finished", LONGER.run);
    work.release();
    await w.until("B to finish", () => b.queue("B").run?.state === "finished", LONGER.run);
    watch.check();
  } finally { work.release(); w.stop(); work.done(); }
});

test("an answer that reaches a live turn is not held: the worker working on beside its question counts", async () => {
  const work = holdWork();
  const w = world({ limit: 2 });
  const a = w.add("a", { A: ["slow"] }), c = w.add("c", { C: ["askwork"] }), d = w.add("d", { D: ["done"] });
  const watch = watchLimit(w, [a.store, c.store, d.store], 2);
  try {
    c.engine.start("C");
    a.engine.start("A");
    await w.until("C to ask and work on", () => c.queue("C").questions.some(isOpenQuestion) && worker(c, "C") === "working", LONGER.step);
    assert.equal(c.queue("C").status, "waiting");
    // C counts while it works beside its question: a planned start finds the limit full.
    d.engine.plan("D", { after: [], by: "user" });
    assert.equal(d.queue("D").start?.held?.reason, "waits: 2 queues run, the limit is 2");

    answerAsUser(c.store, c.queue("C").questions[0]!.qid, "go on", true);
    w.tick();
    work.release("C1"); // the live turn ends; the answer's turn follows
    await w.until("C to finish", () => c.queue("C").run?.state === "finished", LONGER.run);
    assert.ok(!activity(c, "C").some((t) => t.startsWith("Nexus holds queue C")), "never held");
    assert.equal(toWorker(w, c, "C").filter((r) => r.text.includes("[Nexus] Answer")).length, 1, "the answer arrived");
    await w.until("D to finish in C's place", () => d.queue("D").run?.state === "finished", LONGER.run);
    work.release();
    await w.until("A to finish", () => a.queue("A").run?.state === "finished", LONGER.run);
    watch.check();
  } finally { work.release(); w.stop(); work.done(); }
});
