// Token arithmetic shared by the token report's parts (analysis.ts, transcripts.ts, weights.ts): the four figures as
// turns.jsonl keeps them, summed, and the weights they are weighed with (TOKEN_WEIGHTS, usage-estimate.ts) in words.
import type { TokenCounts } from "@nexus/protocol";
import { PRICE_WEIGHTS, TOKEN_WEIGHTS } from "@nexus/protocol/usage-estimate";

export const KINDS = ["input", "output", "cache_read", "cache_creation"] as const;

export const zeroTokens = (): TokenCounts => ({ input: 0, output: 0, cache_read: 0, cache_creation: 0 });

/** Adds `b` times `f` to `a`. */
export function addTokens(a: TokenCounts, b: TokenCounts, f = 1): void {
  for (const k of KINDS) a[k] += b[k] * f;
}

const describe = (w: Readonly<TokenCounts>) => `input ${w.input}, output ${w.output}, cache write ${w.cache_creation}, cache read ${w.cache_read}`;

/** The weights the report counted with, for its head: each runtime's, and any other runtime's. */
export const weightsLine = (): string =>
  `${Object.entries(TOKEN_WEIGHTS).map(([runtime, w]) => `${runtime}: ${describe(w)}`).join("; ")}; any other runtime: ${describe(PRICE_WEIGHTS)}`;
