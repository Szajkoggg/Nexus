// Expected times (estimates.ts): a step's own work from its worker turns, averages by model and effort, and no
// estimate from too few finished steps.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MIN_SAMPLES, estimateStep, queueEstimate, stepSamples, type Sample, type TurnRecord } from "../src/index.ts";

const MIN = 60_000;
const turn = (step: string, minutes: number, over: Partial<TurnRecord> = {}): TurnRecord => ({
  v: 1, at: `2026-11-14T10:${String(minutes).padStart(2, "0")}:00.000Z`, project: "p", session: "s", role: "worker", runtime: "claude",
  model: "opus", effort: "high", queue: "Q", step, outcome: "ok", duration_ms: minutes * MIN, ...over,
});

test("a step's time is the sum of its worker turns: send-backs count, the review wait and other turns do not", () => {
  const done = new Set(["p/Q/Q1", "p/Q/Q2"]);
  const samples = stepSamples([
    turn("Q1", 10), turn("Q1", 20, { at: "2026-11-14T15:00:00.000Z" }),   // a send-back's round hours later: 30 min of work
    turn("Q1", 5, { role: "orchestrator" }),                                // the orchestrator's review is not the step's work
    turn("Q2", 7, { model: "sonnet", effort: "low" }),
    turn("Q2", 3, { duration_ms: undefined }),                             // no duration: not counted
    turn("Q3", 40),                                                         // not finished: no sample
  ], (p, q, s) => done.has(`${p}/${q}/${s}`));
  assert.deepEqual(samples, [{ model: "opus", effort: "high", ms: 30 * MIN }, { model: "sonnet", effort: "low", ms: 7 * MIN }]);
});

test("fewer than five finished steps: no estimate", () => {
  const four: Sample[] = Array.from({ length: MIN_SAMPLES - 1 }, () => ({ model: "opus", effort: "high", ms: 10 * MIN }));
  assert.equal(estimateStep(four, "opus", "high"), undefined);
  assert.equal(estimateStep([...four, { ms: 20 * MIN }], "opus", "high"), 12 * MIN, "five: the average of all (no group has five)");
});

test("the average of the same model and effort, else the same model, else all", () => {
  const s = (model: string, effort: string, minutes: number): Sample => ({ model, effort, ms: minutes * MIN });
  const samples = [
    ...Array.from({ length: 5 }, () => s("opus", "high", 60)),
    ...Array.from({ length: 3 }, () => s("opus", "low", 20)),
    ...Array.from({ length: 4 }, () => s("sonnet", "low", 10)),
  ];
  assert.equal(estimateStep(samples, "opus", "high"), 60 * MIN, "five of its own");
  assert.equal(estimateStep(samples, "opus", "low"), ((5 * 60 + 3 * 20) * MIN) / 8, "three of its own: the model's");
  assert.equal(estimateStep(samples, "sonnet", "low"), ((5 * 60 + 3 * 20 + 4 * 10) * MIN) / 12, "four of the model: all");
});

test("a queue's estimate: its steps left, each on its own values, else the run's, else the project's", () => {
  const samples: Sample[] = [
    ...Array.from({ length: 5 }, () => ({ model: "opus", effort: "high", ms: 60 * MIN })),
    ...Array.from({ length: 5 }, () => ({ model: "haiku", effort: "low", ms: 6 * MIN })),
  ];
  const project = { runtimes: { default: "claude", claude: { model: "opus", effort: "high" }, codex: {} } } as never;
  const step = (id: string, status: string, own: Record<string, unknown> = {}) => ({ id, status, ...own }) as never;
  const q = { steps: [step("Q1", "done"), step("Q2", "pending"), step("Q3", "pending", { model: "haiku", effort: "low" }), step("Q4", "skipped")] } as never;
  assert.deepEqual(queueEstimate(q, project, samples), { steps: 2, ms: 66 * MIN });
  assert.deepEqual(queueEstimate(q, project, samples.slice(0, 4)), { steps: 2 }, "too few: no estimate");
  const run = { ...(q as object), run: { runtime: "claude", model: "haiku", effort: "low" } } as never;
  assert.deepEqual(queueEstimate(run, project, samples), { steps: 2, ms: 12 * MIN }, "the run's values for a step without its own");
});
