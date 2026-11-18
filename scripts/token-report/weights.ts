// How much each kind of token weighs in the subscription's usage windows, estimated from turns.jsonl (queue TB, step
// TB2; docs/ideas/token-costs.md, "Open"): the windows' growth between readings set against the tokens the turns spent
// meanwhile, by least squares. The question is the cache read's weight: the API's price ratio is 0.1 of an input token
// (PRICE_WEIGHTS; Codex's TOKEN_WEIGHTS), and TB2 measured Claude Code's at about 0.02, which its TOKEN_WEIGHTS took
// (queue TW); the less the windows weigh it, the more the number of calls matters against the context's size.
// Pure: scripts/token-report.ts reads the file (--weights), the tests give made-up turns. Method: docs/DESIGN.md,
// "Measuring token use".
import type { TokenCounts, TurnRecord } from "@nexus/protocol";
import { tokenWeights } from "@nexus/protocol/usage-estimate";
import { addTokens, KINDS, weigh, weightsLine, zeroTokens } from "./tokens.ts";

/** Readings whose reset times differ by more than this belong to different windows (Codex's drift; usage-estimate.ts). */
const RESET_SLACK_MS = 5 * 60 * 1000;
const MINUTE = 60 * 1000;

/** One observation: a window's growth over a stretch and the tokens the runtime's turns spent in it. */
export interface Sample {
  from: number; to: number;
  /** In percentage points of the window. */
  growth: number;
  /** In millions of tokens, sub-agents' included. */
  tokens: TokenCounts;
  turns: number;
}

interface Reading { t: number; u: number; reset?: number }

/** A turn's tokens, its sub-agents' included, times `f`; undefined when the turn has none. */
const tokensOf = (t: TurnRecord, f = 1): TokenCounts | undefined => {
  if (!t.tokens) return undefined;
  const sum = zeroTokens();
  addTokens(sum, t.tokens, f);
  if (t.subagent_tokens) addTokens(sum, t.subagent_tokens, f);
  return sum;
};
const span = (t: TurnRecord) => ({ s: Date.parse(t.started_at ?? t.at), e: Date.parse(t.at) });

/** The second reading continues the first's window: no fall, the same reset (within slack), the reset not passed. */
function sameWindow(a: Reading, b: Reading): boolean {
  if (b.u < a.u) return false;
  if ((a.reset === undefined) !== (b.reset === undefined)) return false;
  if (a.reset !== undefined && b.reset !== undefined && Math.abs(a.reset - b.reset) > RESET_SLACK_MS) return false;
  return a.reset === undefined || a.reset > b.t;
}

function reading(t: number, w: { utilization: number; resets_at?: string } | undefined): Reading | undefined {
  if (!w) return undefined;
  return { t, u: w.utilization, reset: w.resets_at ? Date.parse(w.resets_at) : undefined };
}

/** The windows the turns of a runtime name. */
function windowNames(turns: readonly TurnRecord[], runtime: string): string[] {
  const names = new Set<string>();
  for (const t of turns) if (t.runtime === runtime) for (const k of Object.keys({ ...t.windows_start, ...t.windows_end })) names.add(k);
  return [...names].sort();
}

/**
 * Turns that ran alone (no other turn of the runtime overlapped them, in any project or role) with a reading at both
 * ends in one window: the window's growth over the turn is the turn's own.
 */
export function soloSamples(turns: readonly TurnRecord[], runtime: string, window: string): Sample[] {
  const mine = turns.filter((t) => t.runtime === runtime).map((t) => ({ t, ...span(t) }));
  const out: Sample[] = [];
  for (const a of mine) {
    const tokens = tokensOf(a.t, 1e-6);
    const r0 = reading(a.s, a.t.windows_start?.[window]);
    const r1 = reading(a.e, a.t.windows_end?.[window]);
    if (!tokens || !r0 || !r1 || !sameWindow(r0, r1)) continue;
    if (mine.some((b) => b !== a && b.s < a.e && b.e > a.s)) continue;
    out.push({ from: a.s, to: a.e, growth: (r1.u - r0.u) * 100, tokens, turns: 1 });
  }
  return out;
}

/**
 * Stretches between readings of one window at least `minMinutes` long, every turn of the runtime counted with the part
 * of its tokens within (spent evenly over its duration, as usage-estimate.ts takes them). A stretch any turn without
 * tokens touches is left out (`dropped`): its tokens are unknown.
 */
export function stretchSamples(turns: readonly TurnRecord[], runtime: string, window: string, minMinutes: number): { samples: Sample[]; dropped: number } {
  const mine = turns.filter((t) => t.runtime === runtime).map((t) => ({ t, tokens: tokensOf(t), ...span(t) }));
  const readings: Reading[] = [];
  for (const m of mine) {
    const r0 = reading(m.s, m.t.windows_start?.[window]);
    const r1 = reading(m.e, m.t.windows_end?.[window]);
    if (r0) readings.push(r0);
    if (r1) readings.push(r1);
  }
  readings.sort((a, b) => a.t - b.t || a.u - b.u);
  const samples: Sample[] = [];
  let dropped = 0;
  const close = (a: Reading, b: Reading) => {
    const tokens = zeroTokens();
    let n = 0;
    let unknown = false;
    for (const m of mine) {
      const overlap = Math.min(m.e, b.t) - Math.max(m.s, a.t);
      const inside = m.e === m.s ? m.s >= a.t && m.s < b.t : overlap > 0;
      if (!inside) continue;
      if (!m.tokens) { unknown = true; continue; }
      addTokens(tokens, m.tokens, (m.e === m.s ? 1 : overlap / (m.e - m.s)) * 1e-6);
      n++;
    }
    if (unknown) { dropped++; return; }
    samples.push({ from: a.t, to: b.t, growth: (b.u - a.u) * 100, tokens, turns: n });
  };
  let start = 0;
  for (let i = 1; i < readings.length; i++) {
    const a = readings[start]!;
    const prev = readings[i - 1]!;
    const b = readings[i]!;
    if (!sameWindow(prev, b) || !sameWindow(a, b)) { start = i; continue; }
    if (b.t - a.t >= minMinutes * MINUTE) { close(a, b); start = i; }
  }
  return { samples, dropped };
}

// ---------------------------------------------------------------- least squares

export interface Fit {
  names: string[];
  beta: number[];
  /** Standard errors, and the covariance of the coefficients. */
  se: number[]; cov: number[][];
  n: number; rss: number;
  /** The share of the growth's sum of squares the fit explains (through the origin). */
  r2: number;
}

/** The inverse of a square matrix, by Gauss-Jordan elimination with partial pivoting; undefined when singular. */
function inverse(a: number[][]): number[][] | undefined {
  const n = a.length;
  const m = a.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r]![c]!) > Math.abs(m[p]![c]!)) p = r;
    const scaleOf = Math.max(...a.map((row) => Math.abs(row[c]!)));
    if (Math.abs(m[p]![c]!) <= 1e-12 * (scaleOf || 1)) return undefined;
    [m[c], m[p]] = [m[p]!, m[c]!];
    const pivot = m[c]![c]!;
    for (let j = 0; j < 2 * n; j++) m[c]![j]! /= pivot;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = m[r]![c]!;
      if (f) for (let j = 0; j < 2 * n; j++) m[r]![j]! -= f * m[c]![j]!;
    }
  }
  return m.map((row) => row.slice(n));
}

/** Least squares through the origin: y ≈ X·beta. Undefined when the columns do not determine it. */
export function leastSquares(names: string[], x: number[][], y: number[]): Fit | undefined {
  const n = y.length;
  const p = names.length;
  if (n <= p) return undefined;
  const xtx = names.map((_, i) => names.map((_, j) => x.reduce((a, row) => a + row[i]! * row[j]!, 0)));
  const xty = names.map((_, i) => x.reduce((a, row, k) => a + row[i]! * y[k]!, 0));
  const inv = inverse(xtx);
  if (!inv) return undefined;
  const beta = inv.map((row) => row.reduce((a, v, j) => a + v * xty[j]!, 0));
  const rss = x.reduce((a, row, k) => a + (y[k]! - row.reduce((s, v, j) => s + v * beta[j]!, 0)) ** 2, 0);
  const sigma2 = rss / (n - p);
  const cov = inv.map((row) => row.map((v) => v * sigma2));
  const tss = y.reduce((a, v) => a + v * v, 0);
  return { names, beta, se: cov.map((row, i) => Math.sqrt(Math.max(0, row[i]!))), cov, n, rss, r2: tss > 0 ? 1 - rss / tss : 0 };
}

/**
 * The tokens other than cache reads, weighted with the runtime's TOKEN_WEIGHTS: the yardstick the cache read is
 * measured against (input 1, output 5, cache write 1.25 for every runtime so far, so the cache read's weight is in the
 * same units whatever its own weight now is).
 */
const rest = (t: TokenCounts, runtime: string) => {
  const w = tokenWeights(runtime);
  return t.input * w.input + t.output * w.output + t.cache_creation * w.cache_creation;
};

/** Growth ≈ a·rest + b·cache read. */
const readFit = (samples: readonly Sample[], runtime: string) =>
  leastSquares(["rest", "cache_read"], samples.map((s) => [rest(s.tokens, runtime), s.tokens.cache_read]), samples.map((s) => s.growth));

/** The cache read's weight in TOKEN_WEIGHTS units (an uncached input token = 1): b / a of the read fit. */
function readRatio(samples: readonly Sample[], runtime: string): number | undefined {
  const f = readFit(samples, runtime);
  return f && f.beta[0]! > 0 ? f.beta[1]! / f.beta[0]! : undefined;
}

/** A small seeded generator, so a report is the same each time it is made from the same data. */
function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

/** The 2.5th and 97.5th percentiles of the ratio over resamplings of the samples (undefined fits left out). */
export function bootstrap(samples: readonly Sample[], runtime: string, rounds = 1000, seed = 1): { low: number; high: number; failed: number } | undefined {
  if (samples.length < 3) return undefined;
  const next = random(seed);
  const ratios: number[] = [];
  let failed = 0;
  for (let r = 0; r < rounds; r++) {
    const pick = samples.map(() => samples[Math.floor(next() * samples.length)]!);
    const v = readRatio(pick, runtime);
    if (v === undefined) failed++; else ratios.push(v);
  }
  if (ratios.length < rounds / 2) return undefined;
  ratios.sort((a, b) => a - b);
  const q = (p: number) => ratios[Math.min(ratios.length - 1, Math.floor(p * ratios.length))]!;
  return { low: q(0.025), high: q(0.975), failed };
}

export interface WindowEstimate {
  runtime: string; window: string; method: "solo" | "stretch";
  n: number; dropped: number;
  growth: number; tokens: TokenCounts;
  /** The four kinds fitted freely (kinds absent from the data left out), percentage points per million tokens. */
  free?: Fit;
  /** Growth ≈ a·(the rest, TOKEN_WEIGHTS) + b·cache read: the cache read's weight is b/a (the price ratio: 0.1). */
  read?: Fit; ratio?: number; ratio_se?: number; ci?: { low: number; high: number };
  /** The same with a constant use per hour beside (other use of the account: the user's own chats, another machine). */
  background?: Fit; background_ratio?: number;
  /** Growth ≈ s·(tokens weighted with the runtime's TOKEN_WEIGHTS): s, and how well that one number fits beside the two-part fit. */
  price?: Fit;
  /** How many samples a 95% interval of ±HALF_WIDTH on the ratio would take, at the spread seen now. */
  needed?: number;
  /** The days the samples cover (first start to last end), to turn `needed` into days at the same pace. */
  days: number;
  /** Too little growth to say anything: fewer than MIN_GROWTH steps of a whole percent. */
  coarse: boolean;
}

/** The interval that tells the price ratio (0.1) from a weight of half of it or less: ±0.025. */
const HALF_WIDTH = 0.025;
/** The readings are whole percents: below this many points of growth, the steps are the signal. */
const MIN_GROWTH = 20;

function estimate(runtime: string, window: string, method: WindowEstimate["method"], samples: Sample[], dropped: number): WindowEstimate {
  const tokens = zeroTokens();
  for (const s of samples) addTokens(tokens, s.tokens);
  const growth = samples.reduce((a, s) => a + s.growth, 0);
  const days = samples.length ? (Math.max(...samples.map((s) => s.to)) - Math.min(...samples.map((s) => s.from))) / 86_400_000 : 0;
  const e: WindowEstimate = { runtime, window, method, n: samples.length, dropped, growth, tokens, days, coarse: growth < MIN_GROWTH };
  const y = samples.map((s) => s.growth);
  const kinds = KINDS.filter((k) => tokens[k] > 0);
  e.free = leastSquares([...kinds], samples.map((s) => kinds.map((k) => s.tokens[k])), y);
  e.read = readFit(samples, runtime);
  if (e.read && e.read.beta[0]! > 0) {
    const [a, b] = e.read.beta as [number, number];
    const c = e.read.cov;
    e.ratio = b / a;
    // The delta method: var(b/a) ≈ (b/a)²·(var b / b² + var a / a² − 2 cov / (a b)), written to stay finite at b = 0.
    e.ratio_se = Math.sqrt(Math.max(0, (c[1]![1]! + e.ratio * e.ratio * c[0]![0]! - 2 * e.ratio * c[0]![1]!) / (a * a)));
    e.ci = bootstrap(samples, runtime);
    const half = e.ci ? (e.ci.high - e.ci.low) / 2 : 1.96 * e.ratio_se;
    e.needed = Math.ceil(samples.length * (half / HALF_WIDTH) ** 2);
  }
  const hours = samples.map((s) => (s.to - s.from) / 3_600_000);
  e.background = leastSquares(["rest", "cache_read", "hours"], samples.map((s, i) => [rest(s.tokens, runtime), s.tokens.cache_read, hours[i]!]), y);
  if (e.background && e.background.beta[0]! > 0) e.background_ratio = e.background.beta[1]! / e.background.beta[0]!;
  e.price = leastSquares(["priced"], samples.map((s) => [weigh(s.tokens, runtime)]), y);
  return e;
}

/** The turns that ended in the period (since inclusive, until exclusive). */
export function turnsIn(all: readonly TurnRecord[], since?: string, until?: string): TurnRecord[] {
  const from = since ? Date.parse(since) : -Infinity;
  const to = until ? Date.parse(until) : Infinity;
  return all.filter((t) => { const at = Date.parse(t.at); return at >= from && at < to; });
}

/** Every runtime's windows, by both methods, over the turns in the period (all projects: the windows are the account's). */
export function weightEstimates(all: readonly TurnRecord[], o: { since?: string; until?: string; minMinutes?: number }): WindowEstimate[] {
  const turns = turnsIn(all, o.since, o.until);
  const out: WindowEstimate[] = [];
  for (const runtime of ["claude", "codex"]) {
    for (const window of windowNames(turns, runtime)) {
      out.push(estimate(runtime, window, "solo", soloSamples(turns, runtime, window), 0));
      const { samples, dropped } = stretchSamples(turns, runtime, window, o.minMinutes ?? 60);
      out.push(estimate(runtime, window, "stretch", samples, dropped));
    }
  }
  return out;
}

// ---------------------------------------------------------------- the report

const f3 = (x: number | undefined) => (x === undefined || !Number.isFinite(x) ? "–" : Math.abs(x) >= 100 ? x.toFixed(0) : Math.abs(x) >= 1 ? x.toFixed(2) : x.toFixed(3));
const m1 = (x: number) => `${x.toFixed(1)}M`;
const coef = (f: Fit | undefined, name: string) => {
  const i = f?.names.indexOf(name) ?? -1;
  return f && i >= 0 ? `${f3(f.beta[i])} ± ${f3(f.se[i])}` : "–";
};

/** The estimates in Markdown, against TOKEN_WEIGHTS. */
export function renderWeights(list: readonly WindowEstimate[], o: { since?: string; until?: string; minMinutes: number; turns: number }): string {
  const out: string[] = [];
  out.push("# Token weights in the usage windows", "");
  out.push(`- Period: ${o.since ?? "the beginning"} to ${o.until ?? "now"}; ${o.turns} turn records (every project: the windows are the account's).`);
  out.push(`- TOKEN_WEIGHTS now, by runtime: ${weightsLine()}. The fits below measure against the input, output and cache write weights; the "one number" fit uses the runtime's whole weights.`);
  out.push("- Samples: `solo` = a turn no other turn of the runtime overlapped, growth between its own readings; " +
    `\`stretch\` = readings at least ${o.minMinutes} minutes apart, every turn's tokens prorated over its duration (stretches touched by a turn without tokens left out).`);
  out.push("- Growth in percentage points of the window; tokens in millions, sub-agents' included. Coefficients are percentage points per million tokens, ± one standard error.", "");

  out.push("## The cache read's weight (TOKEN_WEIGHTS units: an uncached input token = 1; the price ratio 0.1)", "");
  out.push(`| runtime | window | samples | dropped | growth (pp) | ratio | ± se | 95% bootstrap | with background/h | R² two-part | R² one number | samples for ±${HALF_WIDTH} |`);
  out.push("|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const e of list) {
    const pace = e.days > 0 ? e.n / e.days : 0;
    const needed = e.coarse ? `too little growth (under ${MIN_GROWTH} pp)`
      : e.needed === undefined ? "–"
      : e.needed <= e.n ? "enough"
      : `${e.needed} (~${pace > 0 ? Math.ceil(e.needed / pace) : "?"} days at this pace)`;
    out.push(`| ${e.runtime} | ${e.window} (${e.method}) | ${e.n} | ${e.dropped} | ${e.growth.toFixed(0)} | ${f3(e.ratio)} | ${f3(e.ratio_se)} | ${e.ci ? `${f3(e.ci.low)} – ${f3(e.ci.high)}` : "–"} | ${f3(e.background_ratio)} | ${e.read ? e.read.r2.toFixed(2) : "–"} | ${e.price ? e.price.r2.toFixed(2) : "–"} | ${needed} |`);
  }
  out.push("", `The ratio is b / a of growth ≈ a·(input + 5·output + 1.25·cache write) + b·cache read. "with background/h" adds a constant use per hour (the account's use outside these turns). The samples needed: for a 95% interval of ±${HALF_WIDTH}, enough to tell the price ratio 0.1 from half of it, at the spread seen now.`, "");
  out.push("## The four kinds fitted freely", "");
  out.push("| runtime | window | input | output | cache read | cache write | tokens in (in/out/read/write) | R² |");
  out.push("|---|---|---|---|---|---|---|---|");
  for (const e of list) {
    const t = e.tokens;
    out.push(`| ${e.runtime} | ${e.window} (${e.method}) | ${coef(e.free, "input")} | ${coef(e.free, "output")} | ${coef(e.free, "cache_read")} | ${coef(e.free, "cache_creation")} | ${m1(t.input)} / ${m1(t.output)} / ${m1(t.cache_read)} / ${m1(t.cache_creation)} | ${e.free ? e.free.r2.toFixed(2) : "–"} |`);
  }
  out.push("");
  out.push("## One number: percentage points per million tokens weighted with the runtime's TOKEN_WEIGHTS", "");
  out.push("| runtime | window | pp per M weighted | weighted tokens per 1% |");
  out.push("|---|---|---|---|");
  for (const e of list) {
    const s = e.price?.beta[0];
    out.push(`| ${e.runtime} | ${e.window} (${e.method}) | ${coef(e.price, "priced")} | ${s && s > 0 ? m1(1 / s) : "–"} |`);
  }
  out.push("");
  return out.join("\n");
}
