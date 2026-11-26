// Review decisions against the engine and the fake `claude` (queue RVD; docs/protocol/review.md, "Review decisions"): a
// partial answer saves without accepting and starts no turn; the user's Accept is refused while a decision is open,
// with nothing written (no note goes ahead), and with a page's stale answers; once complete it lets the next step
// start. Reject and Fix it need no answer. The rules themselves are in packages/protocol/test/review-decisions.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActionError, ProjectStore, answerDecision, applyDraft, approveQueue, currentAnswer, loadProjectState, newId, routeAnswers, sendBack, type Event } from "@nexus/protocol";
import { Engine } from "../src/engine.ts";
import { QUICK_ENGINE, LONGER, holdWork, until } from "./wait.ts";
import { inProcessRuntime } from "./in-process-runtime.ts";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "nexus-decisions-"));
  process.env.NEXUS_HOME = join(root, "home");
  process.env.FAKE_LOG = join(root, "fake.log");
  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  store.markReviewDecisions();
  const engine = new Engine(store, () => tick(), { spawn: inProcessRuntime(), ...QUICK_ENGINE });
  function tick() { routeAnswers(store); engine.onChange(loadProjectState(store)); }
  const timer = setInterval(tick, 150);
  const state = () => loadProjectState(store);
  const step = (s: string) => state().queues.find((x) => x.id === "D")!.steps.find((x) => x.id === s)!;
  const delivered = () => existsSync(process.env.FAKE_LOG!)
    ? readFileSync(process.env.FAKE_LOG!, "utf8").split("\n").filter(Boolean).length : 0;
  const hold = holdWork();
  /** Queue D at level 1: D1 works until released, declaring three decisions meanwhile; D2 is done at once. */
  const toReview = async () => {
    applyDraft(store, {
      id: "D", title: "Decisions", review_level: 1,
      steps: [
        { id: "D1", title: "Design", goal: "FAKE: slow", acceptance: ["Drawn"] },
        { id: "D2", title: "Build", goal: "FAKE: done", acceptance: ["Built"] },
      ],
    });
    approveQueue(store, "D");
    engine.start("D");
    await until("D1 at work", () => step("D1").status === "running" && !!step("D1").session, LONGER.step);
    const worker = step("D1").session!;
    for (const id of ["D1", "D2", "D3"]) {
      store.appendEvent({ v: 1, id: newId(), at: new Date().toISOString(), session: worker, type: "review.decision", queue: "D", step: "D1", decision: id, text: `Question ${id}?`, options: [{ label: "A" }, { label: "B" }], recommended: "B", for: "user" } as Event);
    }
    hold.release("D1");
    await until("D1 in the user's review", () => step("D1").status === "review" && step("D1").review_with === "user", LONGER.step);
  };
  const answer = (decision: string, choice: string) => answerDecision(store, { queue: "D", step: "D1", decision, version: 1, round: 1, choice }).answer;
  const stop = () => { clearInterval(timer); engine.shutdown(); hold.done(); };
  return { store, engine, state, step, delivered, toReview, answer, tick, stop };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("a partial answer starts nothing; Accept waits for every decision, writes nothing when refused, then lets D2 start", async () => {
  const x = setup();
  try {
    await x.toReview();
    assert.deepEqual(x.step("D1").decisions.items.map((d) => d.id), ["D1", "D2", "D3"]);
    const turns = x.delivered();
    const a1 = x.answer("D1", "B");
    x.tick();
    await sleep(800);
    assert.equal(x.delivered(), turns, "no turn for a saved answer");
    assert.equal(x.step("D1").status, "review");
    assert.equal(x.step("D2").status, "pending");

    // Refused with what is open; neither the note nor the acceptance is written.
    assert.throws(() => x.engine.acceptReview("D", "D1", "Keep it calm", "next"),
      (e: ActionError) => e.status === 409 && /2 decisions are open: D2 \(not answered\), D3 \(not answered\)/.test(e.message));
    assert.equal(x.step("D2").notes.length, 0, "no note went ahead of the refusal");
    assert.ok(!x.step("D1").timeline.some((e) => e.type === "review.accepted"));

    const a2 = x.answer("D2", "A");
    const a3 = x.answer("D3", "B");
    // A page that saw other answers (D3 answered again in another tab) is refused too.
    const a3b = x.answer("D3", "A");
    assert.throws(() => x.engine.acceptReview("D", "D1", undefined, undefined, { D1: a1, D2: a2, D3: a3 }), /answers changed since you read them \(D3\)/);
    assert.equal(currentAnswer(x.step("D1").decisions.items[2]!, 1)?.event, a3b);
    x.engine.acceptReview("D", "D1", "Keep it calm", "next", { D1: a1, D2: a2, D3: a3b });
    assert.equal(x.step("D1").status, "done");
    assert.equal(x.step("D2").notes.length, 1, "the note went to D2 once accepted");
    await until("D2 starts after the acceptance", () => x.step("D2").status !== "pending", LONGER.step);
  } finally { x.stop(); }
});

test("Reject and Fix it need no answer", async () => {
  const x = setup();
  try {
    await x.toReview();
    assert.match(sendBack(x.store, { queue: "D", step: "D1", from: "user", text: "Make B denser" }), /round 2/);
    await until("D1 back at work", () => x.step("D1").status === "running" || x.step("D1").status === "review", LONGER.step);
    await until("D1 in review again", () => x.step("D1").status === "review", LONGER.step);
    assert.match(x.engine.rejectStep("D", "D1", "wrong direction"), /rejected/);
    assert.equal(x.step("D1").status, "rejected");
  } finally { x.stop(); }
});
