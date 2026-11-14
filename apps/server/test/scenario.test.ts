// A behaviour guard for refactoring the engine (queues R1, R2, R3): one scenario against the fake runtimes that records
// run.yaml and runtime.json at each point of a queue's run (start, pause, resume, a failed turn and its retry, a usage
// wait, a server restart in the middle of a step, finishing) and compares them with golden files
// (test/golden/scenario-<runtime>.txt) using assert.equal.
//
// Fixed dates: the test process's Date is frozen (node:test's mock timers, Date only) and moved by the scenario, so
// every time the engine writes is a fixed one; the engine's long timers run on a clock that looks every 20 ms whether
// the frozen time has reached them. Ids and pids differ per run and are written as <session> and <pid>; the reset time
// the runtime names for its usage limit (the fake computes it from the real clock) as <the runtime's reset time>.
// The fake runtimes and the `nexus` CLI they call run on the real clock: their events are not recorded here.
//
// The golden files must stay unchanged through R1, R2 and R3, apart from the finish fields decided in R1. To write
// them anew (only for a decided change of behaviour): NEXUS_UPDATE_GOLDEN=1 node --test apps/server/test/scenario.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { ProjectStore, approveQueue, loadProjectState, routeAnswers, writeUsage, type StepDef } from "@nexus/protocol";
import { Engine, type Clock } from "../src/engine.ts";
import { acceptReviews } from "./fake-reviewer.ts";
import { WAIT_MS, until as waitUntil, LONGER } from "./wait.ts";

const here = dirname(fileURLToPath(import.meta.url));
process.env.NEXUS_CLAUDE = join(here, "fake-claude.ts");
process.env.NEXUS_CODEX = join(here, "fake-codex.ts");

const T0 = Date.parse("2026-01-01T09:00:00.000Z");
const MINUTE = 60_000;

/** A JSON text with sorted keys, so the order a writer puts fields in does not count. */
function canonical(value: unknown): string {
  const sort = (v: unknown): unknown => Array.isArray(v) ? v.map(sort)
    : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort((v as Record<string, unknown>)[k])])) : v;
  return JSON.stringify(sort(value), null, 2);
}

for (const runtime of ["claude", "codex"] as const) {
  test(`${runtime}: run.yaml and runtime.json at each point of a queue's run match the golden file`, async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: T0 });
    const later = (ms = 10 * MINUTE) => t.mock.timers.setTime(Date.now() + ms);
    process.env.FAKE_SLOW_MS = "2000";

    const root = mkdtempSync(join(tmpdir(), "nexus-scenario-"));
    process.env.NEXUS_HOME = join(root, "home");
    process.env.FAKE_LOG = join(root, "fake.log");
    const store = ProjectStore.init(root, { id: "p", name: "P", root });
    const behaviours = ["slow", "overloaded1", "limit1", "slow"];
    const steps: StepDef[] = behaviours.map((b, i) => ({ id: `Q${i + 1}`, title: `Step ${i + 1}`, goal: `FAKE: ${b}`, acceptance: [] }));
    store.writeQueue({ protocol: 1, id: "Q", title: "Queue", revision: 1, status: "proposed", stop_conditions: [], checks: [], steps, approvals: [], history: [] });
    approveQueue(store, "Q");

    // What the files hold now, with what differs per run replaced.
    const replaced = new Map<string, string>();
    const points: string[] = [];
    const runFile = () => join(store.queueDir("Q"), "run.yaml");
    const runText = () => (existsSync(runFile()) ? readFileSync(runFile(), "utf8") : "");
    const record = (label: string) => {
      const run = store.readRun("Q");
      const file = run ? join(store.sessionDir(run.session), "runtime.json") : undefined;
      const rt = file && existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown> : undefined;
      if (run) replaced.set(run.session, "<session>");
      if (rt && typeof rt.pid === "number") rt.pid = "<pid>";
      let text = `== ${label}\n-- run.yaml\n${run ? canonical(run) : "(none)"}\n-- runtime.json\n${rt ? canonical(rt) : "(none)"}\n`;
      for (const [value, name] of replaced) text = text.replaceAll(value, name);
      points.push(text);
    };

    // The engine's long timers (retries, usage waits): looked at every 20 ms against the frozen time. A wake that
    // changed the run is recorded at once, under the label the scenario set, and the time moves on.
    let wakeLabel: string | undefined;
    const clock: Clock = {
      now: () => Date.now(),
      setTimeout: (fn) => setTimeout(() => {
        const before = runText();
        fn();
        if (wakeLabel && runText() !== before) { record(wakeLabel); wakeLabel = undefined; later(); }
      }, 20),
      clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
    };
    const engineOn = (): Engine => {
      const e: Engine = new Engine(store, () => { routeAnswers(store); acceptReviews(store); e.onChange(loadProjectState(store)); }, { clock });
      return e;
    };

    const queue = () => loadProjectState(store).queues.find((q) => q.id === "Q")!;
    const runtimeState = () => { const r = store.readRun("Q"); return r ? store.readRuntime(r.session) : undefined; };
    const until = (what: string, pred: () => boolean, ms = WAIT_MS) => waitUntil(what, pred, ms, () => `; run: ${JSON.stringify(store.readRun("Q"))}; runtime: ${JSON.stringify(runtimeState())}; steps: ${queue().steps.map((s) => `${s.id}=${s.status}`).join(" ")}`);
    const stepIs = (id: string, status: string) => queue().steps.find((s) => s.id === id)?.status === status;
    const idleAfter = (turns: number) => runtimeState()?.state === "idle" && runtimeState()?.turns === turns;

    let engine = engineOn();
    try {
      // Start: the first step opens at once.
      engine.start("Q", { runtime });
      record("started: the first step opened");
      later();

      // Pause during the step: pausing until its turn ends, then paused.
      await until("Q1 at work", () => stepIs("Q1", "running") && runtimeState()?.state === "working", LONGER.step);
      record("Q1 at work");
      later();
      engine.pause("Q");
      record("paused by the user during a turn: pausing");
      later();
      await until("the pause", () => store.readRun("Q")?.state === "paused" && idleAfter(1), LONGER.run);
      record("the turn ended: paused");

      // Resume: the next step opens; its turn fails for a passing reason and waits for its retry.
      later();
      engine.resume("Q");
      record("resumed by the user: the next step opened");
      later();
      await until("the retry wait", () => store.readRun("Q")?.state === "retry_wait" && idleAfter(2));
      record("a turn failed for a passing reason: retry_wait");

      // The retry, when its time comes. Meanwhile the usage window fills up: after the step, the run waits for it.
      const resetsAt = new Date(Date.now() + 30 * MINUTE).toISOString();
      writeUsage({ updated_at: new Date().toISOString(), windows: { [runtime === "claude" ? "five_hour" : "codex_5h"]: { utilization: 1, resets_at: resetsAt } } });
      wakeLabel = "the retry's time came: the step continued";
      t.mock.timers.setTime(Date.parse(store.readRun("Q")!.resume_at!));
      await until("the retry", () => wakeLabel === undefined);
      await until("the usage wait", () => store.readRun("Q")?.state === "usage_wait" && idleAfter(3));
      record("the step done with the usage window full: usage_wait");

      // The window resets: the next step opens; its turn meets the runtime's usage limit and waits for its reset.
      wakeLabel = "the usage window reset: the next step opened";
      t.mock.timers.setTime(Date.parse(resetsAt) + MINUTE);
      await until("the window's reset", () => wakeLabel === undefined);
      await until("the runtime's usage limit", () => store.readRun("Q")?.state === "usage_wait" && idleAfter(4));
      replaced.set(store.readRun("Q")!.resume_at!, "<the runtime's reset time>");
      record("a turn met the runtime's usage limit: usage_wait");

      // The user resumes during the wait: the step continues and is done; the last step opens.
      later();
      writeUsage({ updated_at: new Date().toISOString(), windows: {} });
      engine.resume("Q");
      record("resumed by the user during the usage wait: the step continued");
      later();
      // The record is working from the turn's start, for both runtimes (until queue FU4, Codex's stayed idle until the
      // turn's token figures came, so idle did not mean the turn was over).
      await until("Q4 at work", () => stepIs("Q3", "done") && stepIs("Q4", "running") && runtimeState()?.turns === 5
        && runtimeState()?.state === "working", LONGER.step);
      record("the last step at work");

      // The server stops in the middle of the step; the next one pauses the run, and a resume continues the step.
      later();
      engine.shutdown();
      await until("the process to exit", () => runtimeState()?.state === "exited");
      record("the server stopped in the middle of a step");
      later();
      engine = engineOn();
      record("the next server started: paused");
      later();
      engine.resume("Q");
      record("resumed by the user after the restart: the step continued");
      later();

      // Finishing: the last step done, the process closed.
      await until("the finish", () => store.readRun("Q")?.state === "finished" && runtimeState()?.state === "exited", LONGER.run);
      record("the last step done: finished");
    } finally { engine.shutdown(); delete process.env.FAKE_SLOW_MS; }

    const golden = join(here, "golden", `scenario-${runtime}.txt`);
    const actual = points.join("\n");
    if (process.env.NEXUS_UPDATE_GOLDEN) { mkdirSync(dirname(golden), { recursive: true }); writeFileSync(golden, actual); }
    assert.equal(actual, readFileSync(golden, "utf8"));
  });
}
