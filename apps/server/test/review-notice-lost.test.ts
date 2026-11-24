// Queue NL (NL1): the review notice the orchestrator never got for ND/ND1 on 2026-11-19. The review helper passed the
// step on at 12:23:29 while the orchestrator's turn worked on another notice (the accepted check failure, 12:23:21).
// The first test shows that a pass-on during a running turn is not lost: the notices are derived from the state at
// every change and told once by key, so a busy orchestrator gets it in or after its turn. The others follow ND1's
// path, a check failure accepted after the worker took up its check-fix round: before NL2 the derivation dropped the
// pass-on (packages/protocol/test/check-sets.test.ts), the helper counted as still running and the orchestrator was
// never told; with the helper off it was told, but its acceptance was dropped.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectStore, applyDraft, approveQueue, loadProjectState, newId, routeAnswers, updateSettings, type CheckSet, type Event } from "@nexus/protocol";
import { Engine } from "../src/engine.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import { QUICK_ENGINE, LONGER, WAIT_MS, holdWork, until as waitUntil } from "./wait.ts";
import { inProcessRuntime } from "./in-process-runtime.ts";

// Not FAKE_REVIEW_ACCEPT: a notice that comes in while the held turn runs is read inside that turn, where the fake acts
// on nothing but FAKE-NEXUS; whether it comes in during the turn or after it depends on the machine's load. The test
// accepts as the orchestrator itself once the notice reached it.
delete process.env.FAKE_REVIEW_ACCEPT;

function setup(o: { helper?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "nexus-notice-lost-"));
  process.env.NEXUS_HOME = join(root, "home");
  process.env.FAKE_LOG = join(root, "fake.log");
  process.env.FAKE_ARGS = join(root, "fake-args.log");
  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  updateSettings(store, { review_helper: { model: "claude-haiku-5-5", effort: "low", ...(o.helper === false ? { enabled: false } : {}) } });
  const engine: Engine = new Engine(store, () => tick(), { spawn: inProcessRuntime(), ...QUICK_ENGINE });
  const orchestrator: Orchestrator = new Orchestrator(store, engine, () => tick(), {}, { spawn: inProcessRuntime(), helpers: {} });
  function tick() { routeAnswers(store); orchestrator.onChange(loadProjectState(store)); engine.onChange(loadProjectState(store)); }
  const timer = setInterval(tick, 150);
  const state = () => loadProjectState(store);
  const step = (q: string, s: string) => state().queues.find((x) => x.id === q)!.steps.find((x) => x.id === s)!;
  const until = (what: string, pred: () => boolean, ms = WAIT_MS) => waitUntil(what, pred, ms, () => `; steps: ${state().queues.flatMap((q) => q.steps.map((s) => `${s.id}=${s.status}/${s.review_with ?? "-"}/${s.helper?.state ?? "-"}`)).join(" ")}; warnings: ${state().warnings.slice(-3).join(" | ")}`);
  const delivered = () => existsSync(process.env.FAKE_LOG!)
    ? readFileSync(process.env.FAKE_LOG!, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { text: string; session: string | null }) : [];
  const orchestratorSaw = () => { const id = orchestrator.session()?.id; return delivered().filter((d) => d.session === id).map((d) => d.text); };
  const stop = () => { clearInterval(timer); engine.shutdown(); orchestrator.shutdown(); };
  return { root, store, engine, orchestrator, state, step, until, orchestratorSaw, stop };
}

const reviewFact = (q: string, s: string) => (t: string) => t.includes(`Step ${s} of queue ${q} is done and waits for your review`);

test("a pass-on while the orchestrator's turn works on something else reaches it, and its acceptance counts", async () => {
  const hold = holdWork();
  const x = setup();
  try {
    x.orchestrator.say("Hello");
    await x.until("the orchestrator's session", () => !!x.orchestrator.session());
    await x.until("the greeting's turn to end", () => x.orchestratorSaw().length > 0 && x.orchestrator.view().state !== "working");
    // Its turn is held at work, as on 2026-11-19 while it drafted the fix queue of the accepted check failure.
    x.orchestrator.say("FAKE-HOLD");
    await x.until("the held turn", () => x.orchestratorSaw().some((t) => t.includes("FAKE-HOLD")));
    applyDraft(x.store, { id: "R", title: "Reviewed", review_level: 2, steps: [{ id: "R1", title: "One", goal: "FAKE: done FAKE-HELPER: passon:deviation", acceptance: ["Criterion"] }] });
    approveQueue(x.store, "R");
    x.engine.start("R");
    await x.until("the helper's pass-on", () => x.step("R", "R1").helper?.state === "passed_on", LONGER.step);
    assert.ok(x.orchestrator.view().state === "working", "the pass-on came while the orchestrator's turn ran");
    hold.release();
    await x.until("the orchestrator's review notice", () => x.orchestratorSaw().some(reviewFact("R", "R1")), LONGER.step);
    // Its acceptance, as nexus review accept writes it from the orchestrator's session.
    x.store.appendEvent({ v: 1, id: newId(), at: new Date().toISOString(), session: x.orchestrator.session()!.id, type: "review.accepted", queue: "R", step: "R1", text: "fine" } as Event);
    await x.until("the run to finish", () => x.state().queues.find((q) => q.id === "R")?.run?.state === "finished", LONGER.run);
    assert.equal(x.step("R", "R1").accepted?.by, "orchestrator");
  } finally { x.stop(); hold.done(); }
});

/** ND1's files, as the engine and its sessions wrote them: the step's done, its checks failed, the worker took up the
 * check-fix round and disputed the failure, Nexus accepted it (it fails on the base too); with `helper`, a review
 * helper took round 1 and passed it on. */
function nd1Path(x: ReturnType<typeof setup>, helper: boolean) {
  applyDraft(x.store, { id: "N", title: "Reviewed", review_level: 2, checks: ["npm test"], steps: [{ id: "N1", title: "One", goal: "g", acceptance: ["Criterion"] }] });
  approveQueue(x.store, "N");
  const t0 = Date.now();
  const at = (s: number) => new Date(t0 + s * 1000).toISOString();
  x.store.writeSession({ protocol: 1, id: "w", project: "p", role: "worker", runtime: "claude", cwd: x.root, launched_by: "nexus", created_at: at(0), queue: "N" });
  const emit = (session: string, s: number, body: Record<string, unknown>) => { const e = { v: 1, id: newId(), at: at(s), session, ...body } as Event; x.store.appendEvent(e); return e; };
  emit("w", 0, { type: "step.started", queue: "N", step: "N1" });
  const done = emit("w", 1, { type: "step.done", queue: "N", step: "N1", summary: "done" }).id;
  const failed = { name: "npm test", command: "npm test", ok: false, runs: [{ started_at: at(2), ended_at: at(3), exit_code: 1, duration: 1, log: "checks/N1/x.log", failed_tests: ["a"] }] };
  const set = (o: Partial<CheckSet>): CheckSet => ({ done, round: 1, fix: 0, requested_at: at(1), state: "failed", checks: [failed], ...o });
  emit("w", 5, { type: "step.started", queue: "N", step: "N1" });
  emit("w", 6, { type: "check.disputed", queue: "N", step: "N1", name: "npm test", evidence: "fails on main" });
  const dispute = { event: "e", name: "npm test", evidence: "fails on main", at: at(6), base: { state: "failed" as const }, outcome: "accepted" as const };
  if (helper) {
    x.store.writeSession({ protocol: 1, id: "h", project: "p", role: "helper", runtime: "claude", cwd: x.root, launched_by: "nexus", created_at: at(7), about: { queue: "N", step: "N1", round: 1, level: 2 } });
    emit("h", 8, { type: "review.passed_on", queue: "N", step: "N1", round: 1, reasons: ["deviation"], text: "a deviation" });
  }
  x.store.writeChecks("N", { protocol: 1, steps: { N1: { by: "nexus", sets: [set({ state: "accepted", ended_at: at(7), dispute })] } } });
}

for (const helper of [true, false]) {
  test(`a check failure accepted in a taken-up check-fix round (ND/ND1)${helper ? ", passed on by the helper" : ", no helper"}: the orchestrator is told, and its acceptance counts`, async () => {
    const x = setup({ helper });
    try {
      x.orchestrator.say("Hello");
      await x.until("the orchestrator's session", () => !!x.orchestrator.session());
      await x.until("the greeting's turn to end", () => x.orchestratorSaw().length > 0 && x.orchestrator.view().state !== "working");
      nd1Path(x, helper);
      assert.deepEqual([x.step("N", "N1").status, x.step("N", "N1").review_with], ["review", "orchestrator"], "it waits for the orchestrator's review");
      if (helper) assert.equal(x.step("N", "N1").helper?.state, "passed_on", `the pass-on counts; warnings: ${x.state().warnings.join(" | ")}`);
      await x.until("the orchestrator's review notice", () => x.orchestratorSaw().some(reviewFact("N", "N1")), LONGER.step);
      const notice = x.orchestratorSaw().find(reviewFact("N", "N1"))!;
      if (helper) assert.ok(notice.includes("a deviation"), `the notice carries the helper's findings:
${notice}`);
      x.store.appendEvent({ v: 1, id: newId(), at: new Date(Date.now() + 10_000).toISOString(), session: x.orchestrator.session()!.id, type: "review.accepted", queue: "N", step: "N1", text: "fine" } as Event);
      assert.deepEqual([x.step("N", "N1").status, x.step("N", "N1").accepted?.by], ["done", "orchestrator"], `warnings: ${x.state().warnings.join(" | ")}`);
    } finally { x.stop(); }
  });
}
