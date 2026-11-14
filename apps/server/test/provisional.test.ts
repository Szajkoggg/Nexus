// Review level 3 against the fake `claude` (PROTOCOL.md, "Review"): the orchestrator accepts provisionally and the
// queue goes on; its send-backs end at the limit with the step waiting for the user; the provisional acceptances wait
// in the user's return batch, where only the user confirms them; and the user's Fix it on one asks the orchestrator
// for a revision, on a queue that went on and on a finished one. The pushes are in accepted.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectStore, applyDraft, approveQueue, confirmProvisional, loadProjectState, newId, routeAnswers, sendBack } from "@nexus/protocol";
import { Engine } from "../src/engine.ts";
import { Orchestrator } from "../src/orchestrator.ts";

process.env.NEXUS_CLAUDE = join(dirname(fileURLToPath(import.meta.url)), "fake-claude.ts");

function setup() {
  const root = mkdtempSync(join(tmpdir(), "nexus-provisional-"));
  process.env.NEXUS_HOME = join(root, "home");
  process.env.FAKE_LOG = join(root, "fake.log");
  delete process.env.FAKE_REVIEW_ACCEPT;
  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  let orchestrator: Orchestrator;
  const engine: Engine = new Engine(store, () => tick());
  orchestrator = new Orchestrator(store, engine, () => tick());
  function tick() { routeAnswers(store); orchestrator.onChange(loadProjectState(store)); engine.onChange(loadProjectState(store)); }
  const timer = setInterval(tick, 150);
  const state = () => loadProjectState(store);
  const queue = (q: string) => state().queues.find((x) => x.id === q)!;
  const step = (q: string, s: string) => queue(q).steps.find((x) => x.id === s)!;
  const until = async (what: string, pred: () => boolean, ms = 30_000) => {
    const t = Date.now();
    while (!pred()) {
      if (Date.now() - t > ms) assert.fail(`timed out waiting for ${what}; chat: ${JSON.stringify(orchestrator.view().chat.slice(-4))}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  const facts = () => orchestrator.view().chat.filter((c) => c.from === "nexus").map((c) => c.text);
  const said = (re: RegExp) => orchestrator.view().chat.some((c) => re.test(c.text));
  const delivered = () => existsSync(process.env.FAKE_LOG!)
    ? readFileSync(process.env.FAKE_LOG!, "utf8").split("\n").filter(Boolean).map((l) => (JSON.parse(l) as { text: string }).text) : [];
  /** A queue at review level 3 (its steps' behaviours given), approved and started, the orchestrator's session up. */
  const run = async (id: string, behaviours: string[]) => {
    orchestrator.say("Hello");
    await until("the session", () => !!orchestrator.session());
    applyDraft(store, {
      id, title: "Level 3", review_level: 3,
      steps: behaviours.map((b, i) => ({ id: `${id}${i + 1}`, title: `Step ${i + 1}`, goal: `FAKE: ${b}`, acceptance: [`Criterion ${i + 1}`] })),
    });
    approveQueue(store, id);
    engine.start(id);
  };
  const inReview = (q: string, s: string) => until(`${s} in the orchestrator's review`, () => step(q, s).status === "review" && step(q, s).review_with === "orchestrator");
  const say = (...args: string[]) => orchestrator.say(`FAKE-NEXUS: ${JSON.stringify(args)}`);
  const stop = () => { clearInterval(timer); engine.shutdown(); orchestrator.shutdown(); delete process.env.FAKE_SLOW_MS; };
  return { store, engine, orchestrator, state, queue, step, until, facts, said, delivered, run, inReview, say, stop };
}

test("level 3: a provisional acceptance lets the queue go on, and the return batch holds each one, oldest first", async () => {
  const x = setup();
  try {
    await x.run("P", ["done", "done", "done"]);
    await x.inReview("P", "P1");
    await x.until("the review notice", () => x.delivered().some((t) => t.includes("Step P1 of queue P is done and waits for your review")));
    const notice = x.delivered().find((t) => t.includes("Step P1 of queue P is done and waits for your review"))!;
    assert.match(notice, /Review level 3: judge all of it; the queue goes on/);
    assert.match(notice, /nexus review provisional P P1 --note/);
    assert.equal(x.queue("P").status, "waiting", "held until the orchestrator judges");

    x.say("review", "provisional", "P", "P1", "--note", "Look at the colours.");
    await x.inReview("P", "P2");
    assert.deepEqual([x.step("P", "P1").status, x.step("P", "P1").provisional?.text], ["done", "Look at the colours."]);
    x.say("review", "accept", "P", "P2"); // nothing of the user's in it: accepted for good
    await x.inReview("P", "P3");
    x.say("review", "provisional", "P", "P3");
    await x.until("the run to finish", () => x.queue("P").run?.state === "finished");
    assert.equal(x.queue("P").status, "done");

    const batch = x.state().attention.filter((a) => a.kind === "provisional");
    assert.equal(batch.length, 1, "one item for the project");
    assert.equal(batch[0]!.text, "2 provisional acceptances wait for your confirmation");
    assert.deepEqual(batch[0]!.provisional!.map((p) => [p.queue, p.step, p.title, p.text]), [["P", "P1", "Step 1", "Look at the colours."], ["P", "P3", "Step 3", undefined]]);
    assert.equal(x.step("P", "P2").provisional, undefined);
  } finally { x.stop(); }
});

test("level 3: the third send-back hands the step to the user, and its queue waits at that step", async () => {
  const x = setup();
  try {
    await x.run("T", ["done", "done"]);
    for (const round of [1, 2, 3]) {
      await x.until(`round ${round} in review`, () => x.step("T", "T1").review_with === "orchestrator" && x.facts().filter((t) => t.startsWith("Step T1 of queue T is done")).length === round);
      x.say("review", "send-back", "T", "T1", `Not yet ${round}.`);
      if (round < 3) await x.until(`round ${round + 1} at work`, () => x.step("T", "T1").sent_back.length === round && x.step("T", "T1").status !== "review");
    }
    await x.until("the step with the user", () => x.step("T", "T1").review_with === "user");
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(x.queue("T").status, "waiting");
    assert.equal(x.step("T", "T2").status, "pending", "the queue does not go past it");
    assert.ok(x.state().attention.some((a) => a.kind === "review" && a.step === "T1"));
    assert.deepEqual(x.step("T", "T1").sent_back.map((b) => !!b.to_user), [false, false, true]);
  } finally { x.stop(); }
});

test("only the user confirms; a provisional acceptance is for level 3 only", async () => {
  const x = setup();
  try {
    await x.run("C", ["done"]);
    await x.inReview("C", "C1");
    x.say("review", "provisional", "C", "C1");
    await x.until("the run to finish", () => x.queue("C").run?.state === "finished");

    // The orchestrator has no command for it, and its event is ignored.
    x.say("review", "confirm", "C", "C1");
    await x.until("the refusal", () => x.said(/nexus review add <step>/));
    const o = x.orchestrator.session()!.id;
    x.store.appendEvent({ v: 1, id: newId(), at: new Date().toISOString(), session: o, type: "review.confirmed", queue: "C", step: "C1" });
    assert.equal(x.step("C", "C1").provisional?.confirmed, undefined);
    assert.ok(x.state().warnings.some((w) => /review.confirmed is the user's; ignored/.test(w)));

    assert.match(confirmProvisional(x.store, "C", "C1"), /confirmed/);
    assert.ok(x.step("C", "C1").provisional?.confirmed);
    assert.equal(x.state().attention.filter((a) => a.kind === "provisional").length, 0, "the batch is empty");
    assert.throws(() => confirmProvisional(x.store, "C", "C1"), /confirmed already/);

    // At level 2 the command is refused, and its event would be ignored.
    applyDraft(x.store, { id: "L", title: "Level 2", review_level: 2, steps: [{ id: "L1", title: "One", goal: "FAKE: done", acceptance: [] }] });
    approveQueue(x.store, "L");
    x.engine.start("L");
    await x.inReview("L", "L1");
    x.say("review", "provisional", "L", "L1");
    await x.until("the refusal", () => x.said(/at review level 2 and away mode is off: a provisional acceptance is for level 3/));
    assert.equal(x.step("L", "L1").status, "review");
  } finally { x.stop(); }
});

test("Fix it on a provisional step of a queue that went on: the orchestrator drafts a fix, and the run waits for its approval", async () => {
  process.env.FAKE_SLOW_MS = "2500";
  const x = setup();
  try {
    await x.run("G", ["done", "slow"]);
    await x.inReview("G", "G1");
    x.say("review", "provisional", "G", "G1");
    await x.until("G2 at work", () => x.step("G", "G2").status === "running");

    assert.match(sendBack(x.store, { queue: "G", step: "G1", from: "user", text: "Make the header blue." }), /the orchestrator drafts a fix of step G\/G1/);
    assert.deepEqual([x.step("G", "G1").status, x.step("G", "G1").provisional?.fix?.text], ["done", "Make the header blue."]);
    assert.equal(x.state().attention.filter((a) => a.kind === "provisional").length, 0, "out of the batch");
    await x.until("the orchestrator told", () => x.delivered().some((t) => t.includes("The user asked a fix of step G1 of queue G")));
    const notice = x.delivered().find((t) => t.includes("The user asked a fix of step G1 of queue G"))!;
    assert.match(notice, /Make the header blue\.[\s\S]*Draft a revision of queue G with a step that makes this fix/);
    assert.match(notice, /its run waits for the approval at its running step's end/);
    assert.ok(x.said(/^You asked a fix of step G1 of queue G/), "the user sees it in the chat");
    assert.throws(() => sendBack(x.store, { queue: "G", step: "G1", from: "user", text: "Again." }), /not waiting for your review/);

    // The orchestrator's revision: a fix step after the running one.
    applyDraft(x.store, {
      id: "G", title: "Level 3", review_level: 3,
      steps: [1, 2].map((n) => ({ id: `G${n}`, title: `Step ${n}`, goal: `FAKE: ${n === 1 ? "done" : "slow"}`, acceptance: [`Criterion ${n}`] }))
        .concat([{ id: "G1b", title: "Fix the header", goal: "FAKE: done", acceptance: ["The header is blue"] }]),
    });
    await x.inReview("G", "G2");
    x.say("review", "accept", "G", "G2");
    await x.until("the run waits for the approval", () => x.queue("G").run?.state === "approval_wait");
    assert.equal(x.step("G", "G1b").status, "pending");
    approveQueue(x.store, "G");
    await x.inReview("G", "G1b");
  } finally { x.stop(); }
});

test("Fix it on a provisional step of a finished queue: the orchestrator drafts a revision the user approves and starts", async () => {
  const x = setup();
  try {
    await x.run("D", ["done"]);
    await x.inReview("D", "D1");
    x.say("review", "provisional", "D", "D1");
    await x.until("the run to finish", () => x.queue("D").run?.state === "finished");
    sendBack(x.store, { queue: "D", step: "D1", from: "user", text: "The text is too small." });
    await x.until("the orchestrator told", () => x.delivered().some((t) => t.includes("The user asked a fix of step D1 of queue D")));
    assert.match(x.delivered().find((t) => t.includes("asked a fix of step D1"))!, /The queue is finished: the user approves the revision, and then it is started/);

    applyDraft(x.store, {
      id: "D", title: "Level 3", review_level: 3,
      steps: [{ id: "D1", title: "Step 1", goal: "FAKE: done", acceptance: ["Criterion 1"] }, { id: "D1b", title: "Bigger text", goal: "FAKE: done", acceptance: ["Readable"] }],
    });
    assert.equal(x.queue("D").approved, false, "the revision waits for the user's approval");
    approveQueue(x.store, "D");
    x.engine.start("D");
    await x.inReview("D", "D1b");
    assert.equal(x.step("D", "D1").status, "done", "the step itself stays done");
  } finally { x.stop(); }
});
