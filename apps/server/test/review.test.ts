// Review by the orchestrator, against the fake `claude`: a step with review policy orchestrator is held, the
// orchestrator is told and decides (accept, ask the user); without notices the user reviews; a reset orchestrator is
// told again; workers can do none of it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectStore, applyDraft, approveQueue, loadProjectState, newId, now, routeAnswers, updateSettings } from "@nexus/protocol";
import { Engine } from "../src/engine.ts";
import { Orchestrator } from "../src/orchestrator.ts";

process.env.NEXUS_CLAUDE = join(dirname(fileURLToPath(import.meta.url)), "fake-claude.ts");
const CLI = join(dirname(fileURLToPath(import.meta.url)), "../../../packages/cli/bin/nexus.js");

function setup() {
  const root = mkdtempSync(join(tmpdir(), "nexus-review-"));
  process.env.NEXUS_HOME = join(root, "home");
  process.env.FAKE_LOG = join(root, "fake.log");
  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  let orchestrator: Orchestrator;
  const engine: Engine = new Engine(store, () => tick());
  orchestrator = new Orchestrator(store, engine, () => tick());
  function tick() { routeAnswers(store); orchestrator.onChange(loadProjectState(store)); engine.onChange(loadProjectState(store)); }
  const timer = setInterval(tick, 150);
  const state = () => loadProjectState(store);
  const step = (q: string, s: string) => state().queues.find((x) => x.id === q)!.steps.find((x) => x.id === s)!;
  const until = async (what: string, pred: () => boolean, ms = 30_000) => {
    const t = Date.now();
    while (!pred()) {
      if (Date.now() - t > ms) assert.fail(`timed out waiting for ${what}; chat: ${JSON.stringify(orchestrator.view().chat.slice(-4))}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  const facts = () => orchestrator.view().chat.filter((c) => c.from === "nexus").map((c) => c.text);
  const delivered = () => existsSync(process.env.FAKE_LOG!)
    ? readFileSync(process.env.FAKE_LOG!, "utf8").split("\n").filter(Boolean).map((l) => (JSON.parse(l) as { text: string }).text) : [];
  /** A queue whose steps the orchestrator reviews, approved and started. */
  const run = async (id: string, steps = 2) => {
    orchestrator.say("Hello");
    await until("the session", () => !!orchestrator.session());
    applyDraft(store, {
      id, title: "Reviewed", review_policy: "orchestrator", checks: ["npm test"],
      steps: Array.from({ length: steps }, (_, i) => ({ id: `${id}${i + 1}`, title: `Step ${i + 1}`, goal: "FAKE: done", acceptance: [`Criterion ${i + 1}`] })),
    });
    approveQueue(store, id);
    engine.start(id);
  };
  const stop = () => { clearInterval(timer); engine.shutdown(); orchestrator.shutdown(); };
  return { store, engine, orchestrator, state, step, until, facts, delivered, run, stop };
}

const reviewFact = (q: string, s: string) => (t: string) => t.startsWith(`Step ${s} of queue ${q} is done and waits for your review`);

test("the orchestrator is told of a step waiting for its review, and its accept lets the run go on", async () => {
  const x = setup();
  try {
    await x.run("V");
    await x.until("the review notice", () => x.facts().some(reviewFact("V", "V1")));
    assert.equal(x.step("V", "V1").status, "review");
    assert.equal(x.step("V", "V1").review_with, "orchestrator");
    assert.equal(x.state().queues[0]!.status, "waiting");
    assert.deepEqual(x.state().attention, [], "not the user's");
    assert.equal(x.step("V", "V2").status, "pending", "held");
    await x.until("the delivery", () => x.delivered().some((t) => t.startsWith("[Nexus] Step V1")));
    const sent = x.delivered().find((t) => t.startsWith("[Nexus] Step V1"))!;
    for (const part of ["Acceptance:\n- Criterion 1", "Checks of the queue not reported this round: npm test", "Review material:", "Commits:", "nexus review accept V V1", "nexus review send-back V V1", "nexus review ask-user V V1"]) {
      assert.ok(sent.includes(part), `the notice has ${JSON.stringify(part)}:\n${sent}`);
    }
    assert.ok(!x.facts().find(reviewFact("V", "V1"))!.includes("nexus review"), "the chat shows only the fact");

    x.orchestrator.say(`FAKE-NEXUS: ["review","accept","V","V1","--note","fine"]`);
    await x.until("V2 in review", () => x.step("V", "V2").status === "review");
    assert.equal(x.step("V", "V1").status, "done");
    x.orchestrator.say(`FAKE-NEXUS: ["review","accept","V","V2"]`);
    await x.until("the run to finish", () => x.state().queues[0]!.run?.state === "finished");
  } finally { x.stop(); }
});

test("ask-user hands the review to the user, and the run waits for them", async () => {
  const x = setup();
  try {
    await x.run("U");
    await x.until("the review notice", () => x.facts().some(reviewFact("U", "U1")));
    x.orchestrator.say(`FAKE-NEXUS: ["review","ask-user","U","U1","The look is the user's to judge."]`);
    await x.until("the user's item", () => x.state().attention.some((a) => a.kind === "review" && a.step === "U1"));
    assert.equal(x.step("U", "U1").review_with, "user");
    assert.equal(x.state().attention.find((a) => a.step === "U1")!.text, "The look is the user's to judge.");
    assert.equal(x.state().queues[0]!.status, "waiting");
    // The orchestrator may no longer accept it.
    x.orchestrator.say(`FAKE-NEXUS: ["review","accept","U","U1"]`);
    await x.until("the refusal", () => x.orchestrator.view().chat.some((c) => /waits for the user's review, not yours/.test(c.text)));
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(x.step("U", "U1").status, "review");
    assert.equal(x.step("U", "U2").status, "pending");
    x.engine.acceptReview("U", "U1");
    await x.until("U2 in review", () => x.step("U", "U2").status === "review");
  } finally { x.stop(); }
});

test("with notices off the step goes straight to the user, and the orchestrator hears nothing of it", async () => {
  const x = setup();
  try {
    x.orchestrator.say("Hello");
    await x.until("the session", () => !!x.orchestrator.session());
    updateSettings(x.store, { orchestrator: { notify: false } });
    await x.run("N", 1);
    await x.until("the user's item", () => x.state().attention.some((a) => a.kind === "review" && a.step === "N1"));
    assert.equal(x.step("N", "N1").review_with, "user");
    await new Promise((r) => setTimeout(r, 600));
    assert.ok(!x.facts().some(reviewFact("N", "N1")));
    assert.ok(!x.delivered().some((t) => t.startsWith("[Nexus] Step N1")));
  } finally { x.stop(); }
});

test("a reset orchestrator is told of a step that entered review before it started", async () => {
  const x = setup();
  try {
    await x.run("R", 1);
    await x.until("the review notice", () => x.facts().some(reviewFact("R", "R1")));
    const first = x.orchestrator.session()!.id;
    x.orchestrator.reset();
    await x.until("a new session", () => !!x.orchestrator.session() && x.orchestrator.session()!.id !== first);
    await x.until("the notice in the new session", () => x.facts().some(reviewFact("R", "R1")));
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(x.facts().filter(reviewFact("R", "R1")).length, 1, "once per session");
    x.orchestrator.say(`FAKE-NEXUS: ["review","accept","R","R1"]`);
    await x.until("the run to finish", () => x.state().queues[0]!.run?.state === "finished");
  } finally { x.stop(); }
});

test("a worker can use neither the review commands nor their events", async () => {
  const x = setup();
  try {
    await x.run("W", 1);
    await x.until("the review", () => x.step("W", "W1").review_with === "orchestrator");
    const worker = x.state().queues[0]!.run!.session;
    for (const cmd of [["accept", "W", "W1"], ["send-back", "W", "W1", "redo"], ["ask-user", "W", "W1", "why"]]) {
      assert.throws(
        () => execFileSync(process.execPath, [CLI, "review", ...cmd], { env: { ...process.env, NEXUS_SESSION: worker, NEXUS_DIR: x.store.dir }, stdio: "pipe" }),
        (e: { stderr: Buffer }) => /only an orchestrator session may do this/.test(e.stderr.toString()),
        cmd[0],
      );
    }
    for (const type of ["review.accepted", "review.asked_user", "review.sent_back"]) {
      x.store.appendEvent({ v: 1, id: newId(), at: now(), session: worker, type, queue: "W", step: "W1", text: "by hand" } as never);
    }
    const s = x.state();
    assert.equal(s.queues[0]!.steps[0]!.status, "review");
    assert.equal(s.queues[0]!.steps[0]!.review_with, "orchestrator");
    assert.deepEqual(s.queues[0]!.steps[0]!.sent_back, []);
    assert.equal(s.warnings.filter((w) => /is for orchestrators; ignored/.test(w)).length, 3);
  } finally { x.stop(); }
});
