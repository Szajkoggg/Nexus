// The review helper (queue RH, RH2), against the fake `claude`: a step waiting for the orchestrator's review gets a
// short-lived helper on the review_helper settings, with its packet; what it accepts goes on without the orchestrator,
// what it (or Nexus) passes on reaches the orchestrator with the reason; its send-backs count toward the limit; a
// refused action comes back in its verdict, never as a question.
import { test } from "node:test";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectStore, applyDraft, approveQueue, helperAbout, loadProjectState, reviewStats, reviewStatsText, routeAnswers, updateSettings, type StepDef } from "@nexus/protocol";
import { audited } from "../src/review-helper.ts";
import { Engine } from "../src/engine.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import { QUICK_ENGINE, LONGER, WAIT_MS, until as waitUntil } from "./wait.ts";
import { inProcessRuntime } from "./in-process-runtime.ts";

// The orchestrator's fake accepts a step whose review notice it gets (and answers a worker's question).
process.env.FAKE_REVIEW_ACCEPT = "1";

function setup(o: { limit?: number; helper?: Record<string, unknown> } = {}) {
  const root = mkdtempSync(join(tmpdir(), "nexus-helper-"));
  process.env.NEXUS_HOME = join(root, "home");
  process.env.FAKE_LOG = join(root, "fake.log");
  process.env.FAKE_ARGS = join(root, "fake-args.log");
  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  updateSettings(store, { defaults: { review_send_back_limit: o.limit ?? 2 }, review_helper: { model: "claude-haiku-5-5", effort: "low", ...o.helper } });
  const engine: Engine = new Engine(store, () => tick(), { spawn: inProcessRuntime(), ...QUICK_ENGINE });
  const orchestrator: Orchestrator = new Orchestrator(store, engine, () => tick(), {}, { spawn: inProcessRuntime(), helpers: {} });
  function tick() { routeAnswers(store); orchestrator.onChange(loadProjectState(store)); engine.onChange(loadProjectState(store)); }
  const timer = setInterval(tick, 150);
  const state = () => loadProjectState(store);
  const step = (q: string, s: string) => state().queues.find((x) => x.id === q)!.steps.find((x) => x.id === s)!;
  const until = (what: string, pred: () => boolean, ms = WAIT_MS) => waitUntil(what, pred, ms, () => `; steps: ${state().queues.flatMap((q) => q.steps.map((s) => `${s.id}=${s.status}/${s.helper?.state ?? "-"}`)).join(" ")}; warnings: ${state().warnings.slice(-3).join(" | ")}`);
  /** What reached each agent: the orchestrator's and the helpers' messages, with the session they went to. */
  const delivered = () => existsSync(process.env.FAKE_LOG!)
    ? readFileSync(process.env.FAKE_LOG!, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { text: string; session: string | null }) : [];
  const orchestratorSaw = () => { const id = orchestrator.session()?.id; return delivered().filter((d) => d.session === id).map((d) => d.text); };
  const helpers = () => state().sessions.filter((s) => s.role === "helper");
  /** A queue whose steps the orchestrator (and its helpers) review, approved and started; the orchestrator first. */
  const run = async (id: string, steps: Partial<StepDef>[], level: 2 | 3 = 2) => {
    if (!orchestrator.session()) {
      orchestrator.say("Hello");
      await until("the orchestrator's session", () => !!orchestrator.session());
    }
    applyDraft(store, {
      id, title: "Reviewed", review_level: level,
      steps: steps.map((s, i) => ({ id: `${id}${i + 1}`, title: `Step ${i + 1}`, goal: "FAKE: done", acceptance: [`Criterion ${i + 1}`], ...s })),
    });
    approveQueue(store, id);
    engine.start(id);
  };
  const stop = () => { clearInterval(timer); engine.shutdown(); orchestrator.shutdown(); };
  return { store, engine, orchestrator, state, step, until, delivered, orchestratorSaw, helpers, run, tick, stop };
}

const reviewFact = (q: string, s: string) => (t: string) => t.includes(`Step ${s} of queue ${q} is done and waits for your review`);

test("a checkable level-2 step: the helper accepts it on its own model and effort, the run goes on, the orchestrator hears nothing", async () => {
  const x = setup();
  try {
    await x.run("A", [{ goal: "FAKE: done FAKE-HELPER: accept" }, { goal: "FAKE: done FAKE-HELPER: accept" }]);
    await x.until("the run to finish", () => x.state().queues.find((q) => q.id === "A")?.run?.state === "finished", LONGER.run);
    for (const s of ["A1", "A2"]) {
      const st = x.step("A", s);
      assert.equal(st.status, "done");
      assert.equal(st.accepted?.by, "helper", JSON.stringify({ saw: x.orchestratorSaw(), h: x.helpers().map((h) => [h.id, h.about]), w: x.state().warnings }, null, 1));
      assert.deepEqual([st.accepted?.runtime, st.accepted?.model, st.accepted?.effort], ["claude", "claude-haiku-5-5", "low"]);
    }
    assert.equal(x.helpers().length, 2, "one helper per review round");
    // Its packet: the step, its acceptance, the worker's summary, the diff's file.
    const h = x.helpers().find((s) => helperAbout(s)?.step === "A1")!;
    assert.deepEqual(helperAbout(h), { queue: "A", step: "A1", round: 1, level: 2 });
    const packet = readFileSync(join(x.store.sessionDir(h.id), "packet.md"), "utf8");
    for (const part of ["[Nexus] Review step A1 of queue A, round 1", "Acceptance:\n- Criterion 1", "The worker's summary:\nfake finished A1", "diff.patch", "nexus review accept A A1"]) {
      assert.ok(packet.includes(part), `the packet has ${JSON.stringify(part)}:\n${packet}`);
    }
    assert.ok(x.delivered().some((d) => d.session === h.id && d.text === packet), "the packet is the helper's turn");
    // The model and effort from the settings are on the helper's command line, with its rights.
    const args = readFileSync(process.env.FAKE_ARGS!, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { argv: string[]; briefing: string | null });
    const started = args.filter((a) => a.briefing?.includes("review helper"));
    assert.equal(started.length, 2);
    const argv = started[0]!.argv.join(" ");
    for (const part of ["--model claude-haiku-5-5", "--effort low", "--permission-mode dontAsk", "Bash(nexus review pass-on:*)", "Read"]) assert.ok(argv.includes(part), `${part} in ${argv}`);
    assert.ok(!/Bash\(nexus:\*\)/.test(argv), "not every nexus command");
    // Nothing reached the orchestrator: no review notice, no accepted line.
    assert.ok(!x.orchestratorSaw().some(reviewFact("A", "A1")) && !x.orchestratorSaw().some(reviewFact("A", "A2")), x.orchestratorSaw().join("\n---\n"));
    assert.ok(!x.orchestrator.view().chat.some((c) => /A1|A2/.test(c.text)), "no line in the orchestrator's chat");
  } finally { x.stop(); }
});

test("every reason to pass a step on takes it to the orchestrator, with the reason", async () => {
  const x = setup({ limit: 1 });
  try {
    await x.run("P", [
      { goal: "FAKE: done FAKE-HELPER: passon:criterion" },
      { goal: "FAKE: done FAKE-HELPER: passon:deviation" },
      { goal: "FAKE: done FAKE-HELPER: passon:doubt" },
      { goal: "FAKE: done FAKE-HELPER: none" },
      // The worker asks first: Nexus passes it on before any helper starts.
      { goal: "FAKE: ask1 FAKE-HELPER: accept" },
      // Sent back once by the helper (the limit is 1): Nexus passes round 2 on.
      { goal: "FAKE: done FAKE-HELPER: sendback" },
    ]);
    await x.until("the run to finish", () => x.state().queues.find((q) => q.id === "P")?.run?.state === "finished", LONGER.run * 2);
    const expected: [string, string, "helper" | "nexus", string][] = [
      ["P1", "criterion", "helper", "a criterion it cannot settle"],
      ["P2", "deviation", "helper", "a deviation from the plan"],
      ["P3", "doubt", "helper", "it doubts its own verdict"],
      ["P4", "no_verdict", "nexus", "ended without a verdict"],
      ["P5", "question", "nexus", "the worker asked a question"],
      ["P6", "limit", "nexus", "as often as the limit allows"],
    ];
    for (const [s, reason, by, text] of expected) {
      const st = x.step("P", s);
      assert.equal(st.status, "done", s);
      assert.equal(st.accepted?.by, "orchestrator", `${s}: the orchestrator decided`);
      assert.deepEqual([st.helper?.state, st.helper?.by, st.helper?.reasons], ["passed_on", by, [reason]], `${s}: ${JSON.stringify({ saw: x.orchestratorSaw().map((t) => t.slice(0, 120)), w: x.state().warnings })}`);
      const notice = x.orchestratorSaw().find(reviewFact("P", s));
      assert.ok(notice?.includes(text), `${s}'s notice names the reason:\n${notice}`);
      if (by === "helper") assert.ok(notice!.includes(`fake helper findings for ${s}`), `${s}'s notice has the findings`);
    }
    // P5: no helper ever started; P6: one helper, for round 1 only.
    const of = (s: string) => x.helpers().filter((h) => helperAbout(h)?.step === s).map((h) => helperAbout(h)!.round);
    assert.deepEqual(of("P5"), []);
    assert.deepEqual(of("P6"), [1]);
    assert.deepEqual(x.step("P", "P6").sent_back.map((b) => [b.by, b.round]), [["helper", 2]]);
    // The statistics: 7 review rounds the helpers took (P6 twice), 6 passed on, each reason once; above a quarter.
    const r = reviewStats([x.state()]);
    assert.deepEqual([r.passed_on.reviews, r.passed_on.passed_on, r.passed_on.high], [7, 6, true]);
    assert.deepEqual(r.passed_on.by_reason, { criterion: 1, deviation: 1, doubt: 1, no_verdict: 1, question: 1, limit: 1 });
    assert.equal(r.sent_back.helper, 1);
    assert.equal(r.accepted.orchestrator, 6);
    assert.ok(reviewStatsText(r).includes("6 of 7 passed on to the orchestrator (86 %, above 25 %"), reviewStatsText(r));
  } finally { x.stop(); }
});

test("a level-3 step goes to the orchestrator after the helper, with its findings; the helper may not accept it", async () => {
  const x = setup();
  try {
    await x.run("T", [{ goal: "FAKE: done" }], 3);
    await x.until("the orchestrator's review", () => x.orchestratorSaw().some(reviewFact("T", "T1")), LONGER.step);
    const notice = x.orchestratorSaw().find(reviewFact("T", "T1"))!;
    assert.ok(notice.includes("review level 3: the checkable criteria are met, the judgement is yours"), notice);
    assert.ok(notice.includes("fake helper findings for T1"), notice);
    assert.ok(notice.includes("nexus review provisional T T1"), "the orchestrator keeps its level-3 choices");
    await x.until("the run to finish", () => x.state().queues.find((q) => q.id === "T")?.run?.state === "finished", LONGER.run);
    assert.equal(x.step("T", "T1").accepted?.by, "orchestrator");
  } finally { x.stop(); }
});

test("the helper's send-backs follow the limit: back to the worker, and with the limit reached the orchestrator decides", async () => {
  const x = setup({ limit: 2 });
  try {
    await x.run("S", [{ goal: "FAKE: done FAKE-HELPER: sendback1" }, { goal: "FAKE: done FAKE-HELPER: sendback" }]);
    await x.until("the run to finish", () => x.state().queues.find((q) => q.id === "S")?.run?.state === "finished", LONGER.run * 2);
    // S1: sent back once, the worker's round 2 accepted by the helper.
    const s1 = x.step("S", "S1");
    assert.deepEqual(s1.sent_back.map((b) => [b.by, b.round, b.delivered]), [["helper", 2, true]]);
    assert.equal(s1.accepted?.by, "helper");
    // S2: sent back twice (the limit), then passed on: the orchestrator decides round 3.
    const s2 = x.step("S", "S2");
    assert.deepEqual(s2.sent_back.map((b) => b.by), ["helper", "helper"]);
    assert.deepEqual([s2.helper?.by, s2.helper?.reasons], ["nexus", ["limit"]]);
    assert.equal(s2.accepted?.by, "orchestrator");
    // The worker saw them as the review helper's.
    assert.ok(x.delivered().some((d) => d.text.includes("fake helper: fix round 1")));
  } finally { x.stop(); }
});

test("a refused action comes back in the helper's verdict, never as a question", async () => {
  const x = setup();
  try {
    await x.run("R", [{ goal: "FAKE: done FAKE-HELPER: refused" }]);
    await x.until("the orchestrator's review", () => x.orchestratorSaw().some(reviewFact("R", "R1")), LONGER.step);
    const h = x.helpers()[0]!;
    // The Write's refusal comes with the turn's result, which may follow the pass-on.
    await x.until("both refusals", () => x.store.readRefusals(h.id).entries.length === 2, LONGER.step);
    const refusals = x.store.readRefusals(h.id).entries;
    // As Claude Code reports them: a Bash call denied by its mode, a Write denied by its rules.
    assert.deepEqual(refusals.map((r) => [r.tool, r.queue, r.step]), [["Bash", "R", "R1"], ["Write", "R", "R1"]]);
    assert.deepEqual(x.state().questions, [], "no question");
    const st = x.step("R", "R1");
    assert.deepEqual(st.helper?.reasons, ["doubt"]);
    assert.ok(st.helper?.findings?.includes("git push was refused"));
    assert.ok(st.helper?.findings?.includes("a review helper only reads"), `the CLI refused its question: ${st.helper?.findings}`);
    assert.ok(x.orchestratorSaw().find(reviewFact("R", "R1"))!.includes("git push was refused"));
  } finally { x.stop(); }
});

test("a helper that cannot run passes the step on at once; with the helper off the orchestrator reviews as before", async () => {
  const x = setup();
  try {
    // An effort Claude Code does not take, written past the settings' check: Nexus passes on without a helper.
    x.store.updateProject((p) => ({ ...p, review_helper: { ...p.review_helper, effort: "ultra" } }));
    await x.run("U", [{ goal: "FAKE: done FAKE-HELPER: accept" }]);
    await x.until("the orchestrator's review", () => x.orchestratorSaw().some(reviewFact("U", "U1")), LONGER.step);
    assert.deepEqual([x.step("U", "U1").helper?.by, x.step("U", "U1").helper?.reasons], ["nexus", ["unavailable"]]);
    assert.ok(x.orchestratorSaw().find(reviewFact("U", "U1"))!.includes("could not run"));
    await x.until("U to finish", () => x.state().queues.find((q) => q.id === "U")?.run?.state === "finished", LONGER.run);
    updateSettings(x.store, { review_helper: { enabled: false, effort: "low" } });
    await x.run("V", [{ goal: "FAKE: done FAKE-HELPER: accept" }]);
    await x.until("V's review", () => x.orchestratorSaw().some(reviewFact("V", "V1")), LONGER.step);
    assert.equal(x.step("V", "V1").helper, undefined);
    assert.equal(x.helpers().length, 0);
  } finally { x.stop(); }
});

test("the next notice lists what the helper accepted and sent back; an audit picked rides with it, and the orchestrator's disagreement is recorded and counted", async () => {
  const x = setup({ helper: { audit_rate: 1 } });
  try {
    await x.run("D", [{ goal: "FAKE: done FAKE-HELPER: sendback1" }, { goal: "FAKE: done FAKE-HELPER: passon:criterion" }]);
    await x.until("the run to finish", () => x.state().queues.find((q) => q.id === "D")?.run?.state === "finished", LONGER.run * 2);
    const notice = x.orchestratorSaw().find(reviewFact("D", "D2"))!;
    const list = notice.slice(notice.indexOf("Since your last notice"));
    assert.ok(list.startsWith("Since your last notice (for your overview; nothing to do):\n- step D1 of queue D: sent back by the review helper, round 2: fake helper: fix round 1\n- step D1 of queue D: accepted by the review helper (Claude Code, claude-haiku-5-5, low)"), notice);
    assert.ok(notice.includes("Audit: review again step D1 of queue D") && notice.includes("nexus review audit D D1 agree|disagree"), notice);
    assert.ok(!x.orchestrator.view().chat.some((c) => c.text.includes("Since your last notice") || c.text.includes("Audit:")), "not in the chat");
    // Told once: a later notice carries neither again.
    for (const t of x.orchestratorSaw().slice(x.orchestratorSaw().indexOf(notice) + 1)) assert.ok(!t.includes("Since your last notice") && !t.includes("Audit:"), t);
    x.orchestrator.say(`FAKE-NEXUS: ["review","audit","D","D1","disagree","--reason","The empty-list test checks nothing."]`);
    await x.until("the audit", () => !!x.step("D", "D1").audit);
    assert.deepEqual([x.step("D", "D1").audit?.verdict, x.step("D", "D1").audit?.text, x.step("D", "D1").status], ["disagree", "The empty-list test checks nothing.", "done"]);
    const r = reviewStats([x.state()]);
    assert.deepEqual(r.audit, [{ group: "review helper claude claude-haiku-5-5 low", acceptances: 1, audited: 1, disagreed: 1 }]);
    assert.ok(reviewStatsText(r).includes("- review helper claude claude-haiku-5-5 low: 1 accepted, 1 audited, 1 disagreed (100 % of the audited)"), reviewStatsText(r));
  } finally { x.stop(); }
});

test("with an audit rate of 0 nothing is audited, and the orchestrator cannot audit what it was not given", async () => {
  const x = setup({ helper: { audit_rate: 0 } });
  try {
    await x.run("E", [{ goal: "FAKE: done FAKE-HELPER: accept" }, { goal: "FAKE: done FAKE-HELPER: passon:doubt" }]);
    await x.until("the run to finish", () => x.state().queues.find((q) => q.id === "E")?.run?.state === "finished", LONGER.run);
    const notice = x.orchestratorSaw().find(reviewFact("E", "E2"))!;
    assert.ok(notice.includes("- step E1 of queue E: accepted by the review helper") && !notice.includes("Audit:"), notice);
    x.orchestrator.say(`FAKE-NEXUS: ["review","audit","E","E1","agree","--reason","fine"]`);
    await x.until("the refusal", () => x.orchestrator.view().chat.some((c) => c.text.includes("no audit of step E/E1 was given to you")));
    assert.equal(x.step("E", "E1").audit, undefined);
  } finally { x.stop(); }
});

test("which acceptances are audited is decided by the event id's hash: the same each time, about the rate's share", () => {
  const ids = Array.from({ length: 2000 }, (_, i) => `01JEVENT${String(i).padStart(6, "0")}`);
  const picked = ids.filter((id) => audited(id, 0.1));
  assert.ok(picked.length > 140 && picked.length < 260, `${picked.length} of 2000`);
  assert.deepEqual(ids.filter((id) => audited(id, 0.1)), picked, "deterministic");
  assert.ok(ids.every((id) => audited(id, 1) && !audited(id, 0)));
  // A known id: the first 8 hexadecimal digits of its SHA-256 decide it.
  const first = Number.parseInt(createHash("sha256").update("01JEVENT000000").digest("hex").slice(0, 8), 16) / 2 ** 32;
  assert.equal(audited("01JEVENT000000", first + 1e-9), true);
  assert.equal(audited("01JEVENT000000", first), false);
});
