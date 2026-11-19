// How much of the subscription's usage windows a turn used: an estimate, labelled as one (decided 2026-11-14,
// docs/ideas/statistics.md; docs/design/usage.md, "Estimating a turn's use"). The windows (Claude Code's 5-hour and 7-day, Codex's
// own) are the account's, so their growth over a turn is shared by every turn of the same runtime running meanwhile,
// in every project and role. A turn's part of the growth is its weighted tokens over the weighted tokens spent in that
// stretch by all of them. Pure and free of Node: `nexus stats`, the server's statistics and the dashboard read it.
import type { TokenCounts, TurnRecord } from "./schemas.ts";

/**
 * How much each kind of token counts toward the windows, relative to an input token not read from the cache, for a
 * runtime without weights of its own (and Codex's): the ratios of the API's prices (output 5×, a cache write 1.25×, a
 * cache read 0.1×), the best public proxy for what the windows meter. Only ratios matter: a turn's share compares
 * turns of one runtime.
 */
export const PRICE_WEIGHTS: Readonly<TokenCounts> = Object.freeze({ input: 1, output: 5, cache_read: 0.1, cache_creation: 1.25 });

/**
 * The token weights by runtime (decided 2026-11-18, queue TW). Claude Code: the price ratios but a cache read at 0.02,
 * measured on 2026-11-18 from its 5-hour window over the turns to 2026-11-17 (queue TB, step TB2: 0.022, 95%
 * 0.014-0.028; docs/design/usage.md, "Measuring token use"). Codex: the price ratios, its own window could not tell the cache
 * read's weight yet. Any other runtime: PRICE_WEIGHTS (tokenWeights).
 */
export const TOKEN_WEIGHTS: Readonly<Record<"claude" | "codex", Readonly<TokenCounts>>> = Object.freeze({
  claude: Object.freeze({ input: 1, output: 5, cache_read: 0.02, cache_creation: 1.25 }),
  codex: PRICE_WEIGHTS,
});

/** A runtime's token weights: its own in TOKEN_WEIGHTS, else the price ratios (PRICE_WEIGHTS). */
export function tokenWeights(runtime: string): Readonly<TokenCounts> {
  return Object.hasOwn(TOKEN_WEIGHTS, runtime) ? TOKEN_WEIGHTS[runtime as keyof typeof TOKEN_WEIGHTS] : PRICE_WEIGHTS;
}

/** Tokens weighted with a runtime's weights (an uncached input token = 1). */
export function weighTokens(t: TokenCounts, w: Readonly<TokenCounts>): number {
  return t.input * w.input + t.output * w.output + t.cache_read * w.cache_read + t.cache_creation * w.cache_creation;
}

/** A turn's weighted tokens with its runtime's weights, its sub-agents' included; undefined when the turn's tokens are unknown. */
export function weightedTokens(t: { runtime: string } & Pick<TurnRecord, "tokens" | "subagent_tokens">): number | undefined {
  if (!t.tokens) return undefined;
  const w = tokenWeights(t.runtime);
  return weighTokens(t.tokens, w) + (t.subagent_tokens ? weighTokens(t.subagent_tokens, w) : 0);
}

/**
 * One window's estimate for a turn: `share`, the part of the window's utilization (0 to 1, as the windows report it)
 * the turn used; or `none`, why there is no estimate: `missing` (the window's value is not known at the turn's start
 * or end), `reset` (the window reset between the two readings), `tokens` (the turn's tokens are unknown).
 */
export type WindowEstimate = { share: number } | { none: "missing" | "reset" | "tokens" };

/** A reset time differing by more than this is another window (Codex's is computed from a countdown, and drifts). */
const RESET_SLACK_MS = 5 * 60_000;

const endOf = (t: TurnRecord) => Date.parse(t.at);
const startOf = (t: TurnRecord) => (t.started_at ? Date.parse(t.started_at) : t.duration_ms !== undefined ? endOf(t) - t.duration_ms : endOf(t));

/** The part of `o`'s tokens spent within [start, end]: its share of the overlap, its tokens taken as spent evenly. */
function overlapFraction(o: TurnRecord, start: number, end: number): number {
  const os = startOf(o), oe = endOf(o);
  const overlap = Math.min(oe, end) - Math.max(os, start);
  if (oe <= os) return os >= start && os <= end ? 1 : 0; // a turn of no duration: inside or not
  return overlap > 0 ? overlap / (oe - os) : 0;
}

function windowEstimate(turn: TurnRecord, name: string, own: number | undefined, others: number): WindowEstimate {
  const a = turn.windows_start?.[name], b = turn.windows_end?.[name];
  if (!a || !b) return { none: "missing" };
  const growth = b.utilization - a.utilization;
  const aReset = a.resets_at ? Date.parse(a.resets_at) : undefined, bReset = b.resets_at ? Date.parse(b.resets_at) : undefined;
  const reset = growth < 0
    || (aReset !== undefined && aReset <= endOf(turn))
    || (aReset !== undefined && bReset !== undefined && Math.abs(aReset - bReset) > RESET_SLACK_MS);
  if (reset) return { none: "reset" };
  if (own === undefined) return { none: "tokens" };
  if (growth === 0) return { share: 0 };
  const all = own + others;
  return { share: all > 0 ? (growth * own) / all : 0 };
}

/**
 * Each turn's estimate, by window, in the order given. A turn shares a window's growth over it with the turns of the
 * same runtime that overlap it (of any project and role; Claude Code's windows and Codex's are apart), each counted
 * with the part of its tokens spent within the turn; a turn whose tokens are unknown counts with none. The windows are
 * those named at the turn's start or end; none named: no entry.
 */
export function usageEstimates(turns: readonly TurnRecord[]): Record<string, WindowEstimate>[] {
  const byRuntime = new Map<string, TurnRecord[]>();
  for (const t of turns) {
    const list = byRuntime.get(t.runtime) ?? [];
    list.push(t);
    byRuntime.set(t.runtime, list);
  }
  const sorted = new Map([...byRuntime].map(([k, v]) => [k, [...v].sort((x, y) => startOf(x) - startOf(y))]));
  const longest = new Map([...sorted].map(([k, v]) => [k, Math.max(0, ...v.map((t) => endOf(t) - startOf(t)))]));
  return turns.map((turn) => {
    const names = new Set([...Object.keys(turn.windows_start ?? {}), ...Object.keys(turn.windows_end ?? {})]);
    if (!names.size) return {};
    const start = startOf(turn), end = endOf(turn);
    const same = sorted.get(turn.runtime)!;
    // The first turn that may overlap starts no earlier than the longest turn before this one's start.
    let lo = 0, hi = same.length;
    const from = start - longest.get(turn.runtime)!;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (startOf(same[mid]!) < from) lo = mid + 1; else hi = mid; }
    let others = 0;
    for (let i = lo; i < same.length && startOf(same[i]!) <= end; i++) {
      const o = same[i]!;
      if (o === turn) continue;
      const w = weightedTokens(o);
      if (w) others += w * overlapFraction(o, start, end);
    }
    const own = weightedTokens(turn);
    const out: Record<string, WindowEstimate> = {};
    for (const name of names) out[name] = windowEstimate(turn, name, own, others);
    return out;
  });
}
