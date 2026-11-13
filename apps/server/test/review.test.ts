// Review by the orchestrator, against the fake `claude`: a step with review policy orchestrator is held, the
// orchestrator is told and decides (accept, ask the user); without notices the user reviews; a reset orchestrator is
// told again; workers can do none of it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectStore, addNote, applyDraft, approveQueue, commentOnPicture, loadProjectState, newId, now, routeAnswers, sendBack, updateSettings } from "@nexus/protocol";
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
  const run = async (id: string, steps = 2, o: { policy?: "orchestrator" | "wait"; hello?: boolean } = {}) => {
    if (o.hello !== false) {
      orchestrator.say("Hello");
      await until("the session", () => !!orchestrator.session());
    }
    applyDraft(store, {
      id, title: "Reviewed", review_policy: o.policy ?? "orchestrator", checks: ["npm test"],
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

// ---------------------------------------------------------------- send-backs and the user's Fix it

const roundTurn = (s: string, round: number) => (t: string) => new RegExp(`^\\[Nexus\\] The (orchestrator reviewed|user sent) step ${s} .*\\(round ${round}\\)`).test(t);
const chatSays = (x: ReturnType<typeof setup>, re: RegExp) => x.orchestrator.view().chat.some((c) => re.test(c.text));

test("a send-back reaches the worker as round 2, and the round comes back to the orchestrator", async () => {
  const x = setup();
  try {
    await x.run("B", 1);
    await x.until("the review", () => x.step("B", "B1").review_with === "orchestrator");
    x.orchestrator.say(`FAKE-NEXUS: ["review","send-back","B","B1","Measure the build time too."]`);
    await x.until("the result", () => chatSays(x, /sent back to its worker as round 2/));
    await x.until("round 2 at the worker", () => x.delivered().some(roundTurn("B1", 2)));
    const turn = x.delivered().find(roundTurn("B1", 2))!;
    assert.match(turn, /What to fix:\nMeasure the build time too\./);
    assert.match(turn, /Acceptance criteria of the step:\n- Criterion 1/);
    assert.doesNotMatch(turn, /words win/);
    await x.until("round 2 in review", () => x.step("B", "B1").status === "review" && x.step("B", "B1").summary === "fake finished B1 round 2");
    assert.equal(x.step("B", "B1").review_with, "orchestrator");
    assert.equal(x.step("B", "B1").session, x.state().queues[0]!.run!.session, "the same session");
    await x.until("told again", () => x.facts().filter(reviewFact("B", "B1")).length === 2);
  } finally { x.stop(); }
});

test("the orchestrator's third send-back hands the step to the user", async () => {
  const x = setup();
  try {
    await x.run("T", 1);
    for (const round of [2, 3]) {
      await x.until(`round ${round - 1} in review`, () => x.step("T", "T1").status === "review" && x.step("T", "T1").review_with === "orchestrator" && x.facts().filter(reviewFact("T", "T1")).length === round - 1);
      x.orchestrator.say(`FAKE-NEXUS: ["review","send-back","T","T1","Not yet ${round}."]`);
      await x.until(`round ${round}`, () => x.delivered().some(roundTurn("T1", round)));
    }
    await x.until("round 3 in review", () => x.step("T", "T1").status === "review" && x.step("T", "T1").review_with === "orchestrator" && x.facts().filter(reviewFact("T", "T1")).length === 3);
    x.orchestrator.say(`FAKE-NEXUS: ["review","send-back","T","T1","Still not."]`);
    await x.until("the result", () => chatSays(x, /goes to the user: it was sent back 2 times already/));
    const st = x.step("T", "T1");
    assert.equal(st.status, "review");
    assert.equal(st.review_with, "user");
    assert.match(st.asked_user!.text, /sent this step back 2 times already and would again: Still not\./);
    assert.ok(x.state().attention.some((a) => a.kind === "review" && a.step === "T1"));
    await new Promise((r) => setTimeout(r, 600));
    assert.ok(!x.delivered().some(roundTurn("T1", 4)), "no round 4 for the worker");
    assert.deepEqual(st.sent_back.map((b) => [b.by, b.delivered, !!b.to_user]), [["orchestrator", true, false], ["orchestrator", true, false], ["orchestrator", false, true]]);
  } finally { x.stop(); }
});

test("the user's Fix it: verbatim, with the override wording, not counted, and its round waits for the user", async () => {
  const x = setup();
  try {
    await x.run("F", 1);
    await x.until("the review", () => x.step("F", "F1").review_with === "orchestrator");
    x.orchestrator.say(`FAKE-NEXUS: ["review","send-back","F","F1","Tighten it."]`);
    await x.until("round 2 in review", () => x.step("F", "F1").summary === "fake finished F1 round 2" && x.step("F", "F1").review_with === "orchestrator");
    x.orchestrator.say(`FAKE-NEXUS: ["review","ask-user","F","F1","The colour is yours."]`);
    await x.until("the user's review", () => x.step("F", "F1").review_with === "user");

    assert.throws(() => sendBack(x.store, { queue: "F", step: "F1", from: "user", text: "   " }), /what to fix is empty/);
    const words = "  Blue, not red: ignore the criterion about red.\nAnd keep the old shape.  ";
    assert.match(sendBack(x.store, { queue: "F", step: "F1", from: "user", text: words }), /sent back to its worker as round 3/);
    await x.until("round 3 at the worker", () => x.delivered().some(roundTurn("F1", 3)));
    const turn = x.delivered().find(roundTurn("F1", 3))!;
    assert.match(turn, /The user sent step F1 of queue F back to you \(round 3\)/);
    assert.ok(turn.includes(words), "the user's words, verbatim");
    assert.match(turn, /The user's words win over the step's acceptance criteria where they conflict/);

    await x.until("round 3 in review", () => x.step("F", "F1").summary === "fake finished F1 round 3" && x.step("F", "F1").status === "review");
    const st = x.step("F", "F1");
    assert.equal(st.review_with, "user", "after a Fix it the round is the user's, though the policy is orchestrator");
    const fix = st.sent_back.find((b) => b.by === "user")!;
    assert.equal(fix.text, words, "recorded verbatim");
    const userSession = loadProjectState(x.store).sessions.find((s) => s.role === "user")!;
    const ev = x.store.readEvents(userSession.id).entries.find((e) => e.type === "review.sent_back")!;
    assert.equal((ev as { text: string }).text, words);
    assert.equal(st.sent_back.filter((b) => b.by === "orchestrator" && !b.to_user).length, 1, "the Fix it does not count toward the limit");
    assert.equal(x.state().queues[0]!.revision, 1, "no new revision");
    // A Fix it only on a step waiting for the user.
    x.engine.acceptReview("F", "F1");
    await x.until("done", () => x.step("F", "F1").status === "done");
    assert.throws(() => sendBack(x.store, { queue: "F", step: "F1", from: "user", text: "more" }), /not waiting for your review/);
  } finally { x.stop(); }
});

test("a send-back on a halted run waits for the resume", async () => {
  const x = setup();
  try {
    await x.run("H", 1);
    await x.until("the review", () => x.step("H", "H1").review_with === "orchestrator");
    const run = x.store.readRun("H")!;
    x.store.writeRun("H", { ...run, state: "halted", reason: "halted for the test", updated_at: now() });
    x.orchestrator.say(`FAKE-NEXUS: ["review","send-back","H","H1","Redo the sheet."]`);
    await x.until("the result", () => chatSays(x, /sent back to its worker as round 2/));
    await new Promise((r) => setTimeout(r, 800));
    assert.ok(!x.delivered().some(roundTurn("H1", 2)), "nothing reaches the worker while halted");
    assert.equal(x.step("H", "H1").status, "running", "reopened, waiting");
    x.engine.resume("H");
    await x.until("round 2 at the worker", () => x.delivered().some(roundTurn("H1", 2)));
    await x.until("round 2 in review", () => x.step("H", "H1").summary === "fake finished H1 round 2" && x.step("H", "H1").status === "review");
  } finally { x.stop(); }
});

// ---------------------------------------------------------------- the user's Accept with a note

test("a note on Accept for the next step reaches the worker when that step starts", async () => {
  const x = setup();
  try {
    await x.run("A", 2, { policy: "wait" });
    await x.until("the user's review", () => x.step("A", "A1").review_with === "user");
    assert.deepEqual(x.engine.acceptReview("A", "A1", "Keep the old shader names in A2.", "next"), { to: "next", step: "A2" });
    await x.until("A2 opened", () => x.delivered().some((t) => t.includes("step A2 (2 of 2)")));
    const turn = x.delivered().find((t) => t.includes("step A2 (2 of 2)"))!;
    assert.match(turn, /Notes from the user for this step:\n- Keep the old shader names in A2\./);
    const ev = x.step("A", "A1").timeline.find((e) => e.type === "review.accepted") as { text?: string; to?: string };
    assert.deepEqual([ev.text, ev.to], ["Keep the old shader names in A2.", "next"]);
    await new Promise((r) => setTimeout(r, 400));
    assert.ok(!x.delivered().some((t) => t.includes("with this note for you")), "nothing for the orchestrator");
  } finally { x.stop(); }
});

test("a note for the orchestrator starts and tells it, with notices off and no session; once per project", async () => {
  const x = setup();
  try {
    updateSettings(x.store, { orchestrator: { notify: false } });
    await x.run("O", 2, { policy: "wait", hello: false });
    await x.until("the user's review", () => x.step("O", "O1").review_with === "user");
    assert.equal(x.orchestrator.session(), undefined, "no orchestrator session yet");
    assert.deepEqual(x.engine.acceptReview("O", "O1", "Caves before cliffs from now on.", "orchestrator"), { to: "orchestrator", step: undefined });
    await x.until("the note told", () => x.delivered().some((t) => t.startsWith("[Nexus] The user accepted step O1 of queue O with this note for you:\nCaves before cliffs from now on.")));
    assert.ok(x.facts().some((t) => t === "You accepted step O1 of queue O with a note for the orchestrator:\nCaves before cliffs from now on."), "the chat shows it");
    assert.equal(x.step("O", "O2").notes.length, 0, "not a note on the next step");
    const first = x.orchestrator.session()!.id;
    x.orchestrator.reset();
    x.orchestrator.say("Hello again");
    await x.until("a new session", () => x.orchestrator.session()?.id !== first && !!x.orchestrator.session());
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(x.delivered().filter((t) => t.includes("with this note for you")).length, 1, "a reset does not repeat it");
  } finally { x.stop(); }
});

test("on the queue's last step the note goes to the orchestrator", async () => {
  const x = setup();
  try {
    await x.run("L", 1, { policy: "wait" });
    await x.until("the user's review", () => x.step("L", "L1").review_with === "user");
    assert.deepEqual(x.engine.acceptReview("L", "L1", "Good; next, the sound pass.", "next"), { to: "orchestrator", step: undefined });
    await x.until("the note told", () => x.delivered().some((t) => t.startsWith("[Nexus] The user accepted step L1 of queue L (its last step) with this note for you:\nGood; next, the sound pass.")));
    await x.until("the run to finish", () => x.state().queues[0]!.run?.state === "finished");
  } finally { x.stop(); }
});

// ---------------------------------------------------------------- the user's Reject

test("a rejection pauses the run and tells the orchestrator once; the run goes on only after a new approved revision", async () => {
  const x = setup();
  try {
    updateSettings(x.store, { orchestrator: { notify: false } });
    await x.run("J", 3, { policy: "wait", hello: false });
    await x.until("the user's review", () => x.step("J", "J1").review_with === "user");
    assert.throws(() => x.engine.rejectStep("J", "J2"), /not waiting for your review/);
    assert.match(x.engine.rejectStep("J", "J1", "Wrong approach: no lattice."), /rejected; the run is paused/);
    const q = () => x.state().queues.find((y) => y.id === "J")!;
    assert.equal(x.step("J", "J1").status, "rejected");
    assert.equal(q().run!.state, "paused");
    assert.equal(q().run!.rejected, "J1");
    assert.equal(q().status, "paused");

    // Told once, with notices off and no session before.
    await x.until("the orchestrator told", () => x.delivered().some((t) => t.startsWith("[Nexus] The user rejected step J1 of queue J. Their reason:\nWrong approach: no lattice.")));
    const told = x.delivered().find((t) => t.startsWith("[Nexus] The user rejected step J1"))!;
    assert.match(told, /Propose what follows as queue revisions/);
    assert.ok(x.facts().includes("You rejected step J1 of queue J:\nWrong approach: no lattice."));
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(x.delivered().filter((t) => t.startsWith("[Nexus] The user rejected")).length, 1);
    assert.ok(!x.delivered().some((t) => /Run of J paused/.test(t)), "not told as a requested pause");

    // No resume, no start before a new revision is approved, not even once it is drafted.
    assert.throws(() => x.engine.resume("J"), /J1 of queue J was rejected/);
    assert.throws(() => x.engine.start("J"), /J1 of queue J was rejected/);
    applyDraft(x.store, {
      id: "J", title: "Reviewed", review_policy: "wait", checks: ["npm test"],
      steps: [
        { id: "J1", title: "Step 1", goal: "FAKE: done", acceptance: ["Criterion 1"] },
        { id: "J2", title: "Step 2, without the lattice", goal: "FAKE: done", acceptance: ["Criterion 2"] },
        { id: "J3", title: "Step 3", goal: "FAKE: done", acceptance: ["Criterion 3"] },
      ],
    });
    assert.throws(() => x.engine.resume("J"), /was rejected/);
    approveQueue(x.store, "J");
    assert.equal(q().rejection, undefined);
    const before = x.delivered().length;
    x.engine.resume("J");
    await x.until("J2 opened", () => x.delivered().some((t) => t.includes("step J2 (2 of 3)")));
    assert.ok(!x.delivered().slice(before).some((t) => t.includes("step J1 (1 of 3)")), "the rejected step is not run again");
    assert.equal(x.step("J", "J1").status, "rejected");
  } finally { x.stop(); }
});

test("after a rejection and a newer approved revision, start runs what is pending and the queue ends done, its run finished", async () => {
  const x = setup();
  try {
    updateSettings(x.store, { orchestrator: { notify: false } });
    const def = (k2: string) => ({
      id: "K", title: "Rejected then revised", review_policy: "continue" as const, checks: [],
      steps: [
        { id: "K1", title: "Step 1", goal: "FAKE: done", acceptance: [], review: { policy: "wait" as const } },
        { id: "K2", title: k2, goal: "FAKE: done", acceptance: [] },
      ],
    });
    applyDraft(x.store, def("Step 2"));
    approveQueue(x.store, "K");
    x.engine.start("K");
    await x.until("K1 waits for the user", () => x.step("K", "K1").review_with === "user");
    x.engine.rejectStep("K", "K1", "Not this way.");
    const q = () => x.state().queues.find((y) => y.id === "K")!;
    assert.equal(q().status, "paused");

    applyDraft(x.store, def("Step 2, done the other way"));
    approveQueue(x.store, "K");
    x.engine.start("K");
    await x.until("the run to finish", () => q().run?.state === "finished");
    assert.equal(q().status, "done");
    assert.deepEqual(q().steps.map((s) => s.status), ["rejected", "done"]);
    assert.equal(x.step("K", "K1").reason, "Not this way.");
    assert.equal(x.delivered().filter((t) => t.includes("step K1 (1 of 2)")).length, 1, "the rejected step is not run again");
    assert.ok(!x.state().attention.some((a) => a.queue === "K"), "nothing of K waits for the user");
  } finally { x.stop(); }
});

// ---------------------------------------------------------------- the user's notes on a step in the orchestrator's review

test("a note on a step in orchestrator review goes to the orchestrator, whatever notify says and with no session", async () => {
  const x = setup();
  try {
    await x.run("N", 2);
    await x.until("the orchestrator's review", () => x.step("N", "N1").review_with === "orchestrator");
    x.orchestrator.reset();
    // Written while the orchestrator holds the step; notices turned off before it is told: it is told all the same.
    addNote(x.store, "N", "N1", "The shader looks right, but the moss is too bright: fix that.");
    updateSettings(x.store, { orchestrator: { notify: false } });
    const note = x.step("N", "N1").notes[0]!;
    assert.equal(note.to, "orchestrator");
    await x.until("the note told", () => x.delivered().some((t) => t.startsWith("[Nexus] The user wrote a note on step N1 of queue N, which waits for your review:\nThe shader looks right, but the moss is too bright: fix that.")));
    const told = x.delivered().find((t) => t.startsWith("[Nexus] The user wrote a note on step N1"))!;
    assert.match(told, /Weigh it in your acceptance of the step\. If it asks for a fix, send the step back with nexus review send-back N N1/);
    assert.ok(x.facts().some((t) => t.startsWith("Your note on step N1 of queue N, in the orchestrator's review:")));
    await x.until("marked delivered", () => !!x.step("N", "N1").notes[0]!.read_at);
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(x.delivered().filter((t) => t.startsWith("[Nexus] The user wrote a note on step N1")).length, 1, "once");
  } finally { x.stop(); }
});

test("a picture comment on a step in orchestrator review goes to the orchestrator too", async () => {
  const x = setup();
  try {
    await x.run("P", 2);
    await x.until("the orchestrator's review", () => x.step("P", "P1").review_with === "orchestrator");
    const pic = join(x.store.dir, "..", "cliff.png").replaceAll("\\", "/");
    writeFileSync(pic, "png");
    const worker = x.state().queues.find((q) => q.id === "P")!.run!.session;
    x.store.appendEvent({ v: 1, id: newId(), at: now(), session: worker, type: "review.added", queue: "P", step: "P1", items: [{ path: pic, label: "Cliff" }] });
    assert.match(commentOnPicture(x.store, { queue: "P", step: "P1", path: pic, text: "Too dark at the bottom." }), /goes to the orchestrator/);
    await x.until("the comment told", () => x.delivered().some((t) => t.startsWith("[Nexus] The user wrote a note on step P1 of queue P") && t.includes(`About the picture "Cliff" (${pic}):\nToo dark at the bottom.`)));
    assert.equal(x.step("P", "P1").pictures[pic]!.comments[0]!.to, "orchestrator");
    assert.equal(x.step("P", "P1").status, "review", "nothing sent back by itself");
  } finally { x.stop(); }
});

test("a note on a pending step still waits for that step, and never goes to the orchestrator", async () => {
  const x = setup();
  try {
    await x.run("W", 2);
    await x.until("the orchestrator's review", () => x.step("W", "W1").review_with === "orchestrator");
    addNote(x.store, "W", "W2", "Use the grassland settings.");
    assert.equal(x.step("W", "W2").notes[0]!.to, undefined);
    await new Promise((r) => setTimeout(r, 600));
    assert.ok(!x.delivered().some((t) => t.includes("Use the grassland settings.")), "nobody told yet");
    x.orchestrator.say(`FAKE-NEXUS: ["review","accept","W","W1"]`);
    await x.until("W2 opened with the note", () => x.delivered().some((t) => t.includes("step W2 (2 of 2)") && t.includes("Notes from the user for this step:\n- Use the grassland settings.")));
    assert.ok(!x.delivered().some((t) => t.startsWith("[Nexus] The user wrote a note")), "not the orchestrator's");
  } finally { x.stop(); }
});
