// The estimate of a turn's use of the usage windows (usage-estimate.ts; DESIGN.md, "Estimating a turn's use"), on a
// made-up turns.jsonl read back as the server would read it: a turn alone, two overlapping turns with different tokens,
// an overlapping Codex turn (Codex's windows are apart from Claude Code's), a window that reset during the turn, missing
// window data, a partial overlap, sub-agent tokens, and a turn whose tokens are unknown; and the token weights by runtime.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PRICE_WEIGHTS, TOKEN_WEIGHTS, readTurns, tokenWeights, usageEstimates, weightedTokens, type TurnRecord, type WindowEstimate } from "../src/index.ts";

const at = (hm: string) => `2026-11-15T${hm}:00.000Z`;
const tok = (input: number, extra: Partial<NonNullable<TurnRecord["tokens"]>> = {}) => ({ input, output: 0, cache_read: 0, cache_creation: 0, ...extra });
const win = (utilization: number, reset: string) => ({ utilization, resets_at: at(reset) });

function turn(session: string, from: string, to: string, more: Partial<TurnRecord>): TurnRecord {
  return { v: 1, at: at(to), started_at: at(from), duration_ms: Date.parse(at(to)) - Date.parse(at(from)), project: "p", session, role: "worker", runtime: "claude", outcome: "ok", ...more };
}

const TURNS: TurnRecord[] = [
  // Alone: 0.10 -> 0.13 of the 5-hour window, 0.40 -> 0.41 of the 7-day one.
  turn("alone", "10:00", "10:10", { tokens: tok(1000), windows_start: { five_hour: win(0.1, "15:00"), seven_day: win(0.4, "23:00") }, windows_end: { five_hour: win(0.13, "15:00"), seven_day: win(0.41, "23:00") } }),
  // Two Claude Code turns side by side, one with three times the other's tokens, an orchestrator's among them; and a
  // Codex turn meanwhile with far more tokens, on Codex's own window.
  turn("big", "11:00", "11:10", { tokens: tok(3000), windows_start: { five_hour: win(0.2, "15:00") }, windows_end: { five_hour: win(0.28, "15:00") } }),
  turn("small", "11:00", "11:10", { role: "orchestrator", tokens: tok(1000), windows_start: { five_hour: win(0.2, "15:00") }, windows_end: { five_hour: win(0.28, "15:00") } }),
  turn("codex", "11:00", "11:10", { runtime: "codex", tokens: tok(90_000), windows_start: { primary: win(0.5, "16:00") }, windows_end: { primary: win(0.6, "16:01") } }),
  // The window reset during the turn: its reset time passed, and the value fell.
  turn("reset", "12:00", "12:10", { tokens: tok(1000), windows_start: { five_hour: win(0.95, "12:05") }, windows_end: { five_hour: win(0.02, "17:05") } }),
  // No reading at the turn's start; none at all.
  turn("halfknown", "13:00", "13:10", { tokens: tok(1000), windows_end: { five_hour: win(0.3, "17:00") } }),
  turn("unknown", "13:20", "13:30", { tokens: tok(1000) }),
  // Half of the other's tokens fall within this turn.
  turn("first", "14:00", "14:10", { tokens: tok(1000), windows_start: { five_hour: win(0.3, "18:00") }, windows_end: { five_hour: win(0.33, "18:00") } }),
  turn("second", "14:05", "14:15", { tokens: tok(1000) }),
  // A turn whose sub-agents used as much as its main loop: it weighs as much as one with twice the main tokens.
  turn("withsub", "15:00", "15:10", { tokens: tok(1000), subagent_tokens: tok(1000), windows_start: { five_hour: win(0.4, "19:00") }, windows_end: { five_hour: win(0.44, "19:00") } }),
  turn("double", "15:00", "15:10", { tokens: tok(2000), windows_start: { five_hour: win(0.4, "19:00") }, windows_end: { five_hour: win(0.44, "19:00") } }),
  // Interrupted, its tokens unknown: no estimate of its own, and it takes nothing from the others.
  turn("interrupted", "16:00", "16:10", { outcome: "interrupted", windows_start: { five_hour: win(0.5, "20:00") }, windows_end: { five_hour: win(0.52, "20:00") } }),
];

function estimates(): Map<string, Record<string, WindowEstimate>> {
  const home = mkdtempSync(join(tmpdir(), "nexus-usage-estimate-"));
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "turns.jsonl"), TURNS.map((t) => JSON.stringify(t)).join("\n") + "\n");
  const before = process.env.NEXUS_HOME;
  process.env.NEXUS_HOME = home;
  try {
    const read = readTurns();
    assert.deepEqual(read.errors, []);
    const out = usageEstimates(read.entries);
    return new Map(read.entries.map((t, i) => [t.session, out[i]!]));
  } finally { if (before === undefined) delete process.env.NEXUS_HOME; else process.env.NEXUS_HOME = before; }
}
const share = (e: WindowEstimate | undefined) => (e && "share" in e ? Math.round(e.share * 1e6) / 1e6 : e);

test("a turn alone has its windows' whole growth, each window apart", () => {
  const e = estimates().get("alone")!;
  assert.deepEqual([share(e.five_hour), share(e.seven_day)], [0.03, 0.01]);
});

test("overlapping turns of one runtime share the growth by their tokens; a Codex turn meanwhile shares nothing of it", () => {
  const e = estimates();
  assert.deepEqual([share(e.get("big")!.five_hour), share(e.get("small")!.five_hour)], [0.06, 0.02], "3:1, an orchestrator's turn counted like a worker's");
  assert.deepEqual(share(e.get("codex")!.primary), 0.1, "Codex's turn alone on Codex's window (its reset drifting by a minute)");
});

test("a window that reset between the readings, or a reading missing, gives no estimate", () => {
  const e = estimates();
  assert.deepEqual(e.get("reset")!.five_hour, { none: "reset" });
  assert.deepEqual(e.get("halfknown")!.five_hour, { none: "missing" });
  assert.deepEqual(e.get("unknown"), {}, "no window named");
});

test("a partly overlapping turn counts with the part of its tokens within; sub-agent tokens count; unknown tokens give none", () => {
  const e = estimates();
  assert.equal(share(e.get("first")!.five_hour), Math.round((0.03 * 1000) / 1500 * 1e6) / 1e6);
  assert.deepEqual([share(e.get("withsub")!.five_hour), share(e.get("double")!.five_hour)], [0.02, 0.02]);
  assert.deepEqual(e.get("interrupted")!.five_hour, { none: "tokens" });
});

test("the token weights by runtime: Claude Code's cache read at 0.02 (measured), Codex's and any other runtime's at the price ratio", () => {
  assert.deepEqual(TOKEN_WEIGHTS, {
    claude: { input: 1, output: 5, cache_read: 0.02, cache_creation: 1.25 },
    codex: { input: 1, output: 5, cache_read: 0.1, cache_creation: 1.25 },
  });
  assert.deepEqual(PRICE_WEIGHTS, { input: 1, output: 5, cache_read: 0.1, cache_creation: 1.25 });
  for (const runtime of ["external", "gemini", "constructor", "toString"]) assert.equal(tokenWeights(runtime), PRICE_WEIGHTS, runtime);
  const tokens = { input: 10, output: 2, cache_read: 100, cache_creation: 4 };
  assert.equal(weightedTokens({ runtime: "claude", tokens }), 10 + 10 + 2 + 5);
  assert.equal(weightedTokens({ runtime: "claude", tokens, subagent_tokens: tokens }), 2 * (10 + 10 + 2 + 5));
  assert.equal(weightedTokens({ runtime: "codex", tokens }), 10 + 10 + 10 + 5);
  assert.equal(weightedTokens({ runtime: "external", tokens }), 10 + 10 + 10 + 5, "an unknown runtime: the price ratios");
  assert.equal(weightedTokens({ runtime: "claude" }), undefined);
});

test("the shares follow the runtime's weights: a turn of cache reads takes less of Claude Code's window than of Codex's", () => {
  // Two turns side by side on each runtime: one of 100k cache reads, one of 2000 uncached input tokens; each window grows
  // by 4 points. Claude Code: 2000 against 2000 weighted (half each); Codex: 10 000 against 2000 (five sixths).
  const pair = (runtime: TurnRecord["runtime"], window: string, reset: string): TurnRecord[] => ["reads", "input"].map((kind) =>
    turn(`${runtime}-${kind}`, "17:00", "17:10", {
      runtime, tokens: kind === "reads" ? tok(0, { cache_read: 100_000 }) : tok(2000),
      windows_start: { [window]: win(0.5, reset) }, windows_end: { [window]: win(0.54, reset) },
    }));
  const turns = [...pair("claude", "five_hour", "21:00"), ...pair("codex", "primary", "21:00")];
  const out = usageEstimates(turns).map((e) => Object.values(e).map(share)[0]);
  assert.deepEqual(out, [0.02, 0.02, Math.round((0.04 * 5) / 6 * 1e6) / 1e6, Math.round(0.04 / 6 * 1e6) / 1e6]);
});
