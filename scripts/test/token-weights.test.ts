// The usage windows' token weights (scripts/token-report/weights.ts): made-up turns whose windows grow by known
// weights, which the fits must give back; tokens prorated over a stretch; resets and turns without tokens left out;
// the period.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { TokenCounts, TurnRecord } from "@nexus/protocol";
import { tokenWeights } from "@nexus/protocol/usage-estimate";
import { bootstrap, leastSquares, renderWeights, soloSamples, stretchSamples, weightEstimates } from "../token-report/weights.ts";

const RESET = "2026-11-17T20:00:00.000Z";
const at = (min: number) => new Date(Date.parse("2026-11-17T10:00:00.000Z") + min * 60_000).toISOString();
/** The windows' true weights, percentage points per million tokens: the price ratios but a cache read at 0.02. */
const W: TokenCounts = { input: 10, output: 50, cache_read: 0.2, cache_creation: 12.5 };
const use = (t: TokenCounts) => (t.input * W.input + t.output * W.output + t.cache_read * W.cache_read + t.cache_creation * W.cache_creation) / 1e6;
const close = (actual: number | undefined, expected: number, eps = 1e-6) =>
  assert.ok(actual !== undefined && Math.abs(actual - expected) < eps, `${actual} is not ${expected}`);

function turn(start: number, end: number, tokens: TokenCounts | undefined, u0: number, u1: number, more: Partial<TurnRecord> = {}): TurnRecord {
  const w = (u: number) => ({ five_hour: { utilization: u / 100, resets_at: RESET } });
  return {
    v: 1, at: at(end), started_at: at(start), project: "p", session: "s", role: "worker", runtime: "claude",
    outcome: tokens ? "ok" : "interrupted", tokens, windows_start: w(u0), windows_end: w(u1), ...more,
  };
}

/** Twelve turns of 30 minutes, 10 minutes apart, one after another; the window grows by each one's true use. */
function sequence(): TurnRecord[] {
  const out: TurnRecord[] = [];
  let u = 0;
  for (let i = 0; i < 12; i++) {
    const tokens = { input: 1e5 * (1 + (i % 3)), output: 1e4 * (1 + ((i * 2) % 5)), cache_read: 1e6 * (3 + i), cache_creation: 1e4 * (1 + ((i * 3) % 4)) };
    const grown = u + use(tokens);
    out.push(turn(40 * i, 40 * i + 30, tokens, u, grown));
    u = grown;
  }
  return out;
}

test("least squares through the origin gives back exact coefficients, and none when the columns do not decide", () => {
  const f = leastSquares(["a", "b"], [[1, 0], [0, 1], [1, 1], [2, 1]], [2, 3, 5, 7])!;
  close(f.beta[0], 2);
  close(f.beta[1], 3);
  close(f.rss, 0);
  assert.equal(leastSquares(["a", "b"], [[1, 2], [2, 4], [3, 6]], [1, 2, 3]), undefined);
  assert.equal(leastSquares(["a"], [[1]], [1]), undefined);
});

test("turns that ran alone give back the true weights, the cache read's at 0.02 of an input token", () => {
  const turns = sequence();
  const samples = soloSamples(turns, "claude", "five_hour");
  assert.equal(samples.length, 12);
  const [e] = weightEstimates(turns, {}).filter((x) => x.method === "solo");
  assert.ok(e);
  assert.equal(e.n, 12);
  close(e.ratio, 0.02);
  for (const [i, k] of (["input", "output", "cache_read", "cache_creation"] as const).entries()) close(e.free!.beta[i], W[k]);
  assert.equal(e.coarse, false);
  // Exact data: the bootstrap's interval closes on the ratio, and the samples are enough.
  close(e.ci!.low, 0.02);
  close(e.ci!.high, 0.02);
  assert.ok(e.needed! <= e.n);
  // The one-number fit weighs with Claude Code's own weights (a cache read at 0.02): one scale explains the growth whole.
  close(e.price!.beta[0], 10);
  close(e.price!.r2, 1);
});

test("a Codex turn is weighed with Codex's weights: the one-number fit misses a cache read weighed at 0.02", () => {
  const turns = sequence().map((t) => ({ ...t, runtime: "codex" as const, windows_start: { primary: t.windows_start!.five_hour! }, windows_end: { primary: t.windows_end!.five_hour! } }));
  const e = weightEstimates(turns, {}).find((x) => x.runtime === "codex" && x.method === "solo")!;
  close(e.ratio, 0.02);
  assert.ok(e.price!.r2 < 0.999, `R² ${e.price!.r2}`);
});

test("stretches of an hour or more join the turns within, and give back the same weights", () => {
  const turns = sequence();
  const { samples, dropped } = stretchSamples(turns, "claude", "five_hour", 60);
  // Readings at 0, 30, 40, 70, …: the first stretch runs 0–70 (turns 0 and 1), the next 70–150, and so on.
  assert.deepEqual(samples.map((s) => [s.from, s.to].map((t) => (t - Date.parse(at(0))) / 60_000)), [[0, 70], [70, 150], [150, 230], [230, 310], [310, 390], [390, 470]]);
  assert.equal(dropped, 0);
  assert.deepEqual(samples.map((s) => s.turns), [2, 2, 2, 2, 2, 2]);
  const e = weightEstimates(turns, {}).find((x) => x.method === "stretch")!;
  close(e.ratio, 0.02);
  close(e.background_ratio, 0.02);
  close(e.growth, turns.reduce((a, t) => a + use(t.tokens!), 0));
});

test("a turn a stretch cuts is counted with the part of its tokens within; a turn without tokens drops its stretch", () => {
  const long = { input: 0, output: 0, cache_read: 4e6, cache_creation: 0 };
  const short = { input: 0, output: 1e4, cache_read: 0, cache_creation: 0 };
  const turns = [
    turn(0, 60, long, 0, 2),
    turn(30, 31, short, 1, 1.5),
  ];
  const { samples } = stretchSamples(turns, "claude", "five_hour", 30);
  // Readings at 0 (0%), 30 (1%), 31 (1.5%), 60 (2%): stretches 0–30 and 30–60.
  assert.equal(samples.length, 2);
  close(samples[0]!.tokens.cache_read, 2);
  close(samples[0]!.growth, 1);
  close(samples[1]!.tokens.cache_read, 2);
  close(samples[1]!.tokens.output, 0.01);
  assert.equal(samples[1]!.turns, 2);

  const withUnknown = [...turns, turn(40, 45, undefined, 1.5, 1.5)];
  const r = stretchSamples(withUnknown, "claude", "five_hour", 30);
  assert.deepEqual([r.samples.length, r.dropped], [1, 1]);
});

test("a reset between two readings ends a stretch and keeps a turn out of the solo samples", () => {
  const t = (s: number, e: number, u0: number, u1: number, reset0: string, reset1: string): TurnRecord => ({
    ...turn(s, e, { input: 1e5, output: 0, cache_read: 0, cache_creation: 0 }, u0, u1),
    windows_start: { five_hour: { utilization: u0 / 100, resets_at: reset0 } },
    windows_end: { five_hour: { utilization: u1 / 100, resets_at: reset1 } },
  });
  const later = "2026-11-18T01:00:00.000Z";
  const turns = [t(0, 30, 50, 51, RESET, RESET), t(40, 70, 51, 2, RESET, later), t(80, 110, 2, 3, later, later), t(120, 150, 3, 4, later, later)];
  assert.deepEqual(soloSamples(turns, "claude", "five_hour").map((s) => Math.round(s.growth * 1e6) / 1e6), [1, 1, 1]);
  const { samples } = stretchSamples(turns, "claude", "five_hour", 60);
  // 0–70 crosses the reset (51 → 2): no stretch; from 70 on: 70–150.
  assert.deepEqual(samples.map((s) => (s.from - Date.parse(at(0))) / 60_000), [70]);
});

test("the period keeps only its turns; too little growth is said so; the bootstrap repeats itself", () => {
  const turns = sequence();
  const half = weightEstimates(turns, { until: at(240) }).find((x) => x.method === "solo")!;
  assert.equal(half.n, 6);
  const tiny = turns.map((t) => ({ ...t, windows_start: { five_hour: { utilization: 0.01, resets_at: RESET } }, windows_end: { five_hour: { utilization: 0.01, resets_at: RESET } } }));
  assert.equal(weightEstimates(tiny, {}).find((x) => x.method === "solo")!.coarse, true);
  const samples = soloSamples(turns, "claude", "five_hour").map((s, i) => ({ ...s, growth: s.growth * (1 + (i % 2 ? 0.1 : -0.1)) }));
  assert.deepEqual(bootstrap(samples, tokenWeights("claude"), 200, 7), bootstrap(samples, tokenWeights("claude"), 200, 7));
  const md = renderWeights(weightEstimates(turns, {}), { minMinutes: 60, turns: turns.length });
  assert.match(md, /\| claude \| five_hour \(stretch\) \| 6 \| 0 \| .* \| 0\.020 \|/);
  assert.match(md, /\| enough \|/);
  assert.match(md, /TOKEN_WEIGHTS now, by runtime: claude: input 1, output 5, cache write 1\.25, cache read 0\.02; codex: .* cache read 0\.1; any other runtime: .* cache read 0\.1\./);
});
