// Token arithmetic shared by the token report's parts (analysis.ts, transcripts.ts, weights.ts): the four figures as
// turns.jsonl keeps them, summed, and weighted with TOKEN_WEIGHTS (the API's price ratios).
import type { TokenCounts } from "@nexus/protocol";
import { TOKEN_WEIGHTS } from "@nexus/protocol/usage-estimate";

export const KINDS = ["input", "output", "cache_read", "cache_creation"] as const;

export const zeroTokens = (): TokenCounts => ({ input: 0, output: 0, cache_read: 0, cache_creation: 0 });

/** Adds `b` times `f` to `a`. */
export function addTokens(a: TokenCounts, b: TokenCounts, f = 1): void {
  for (const k of KINDS) a[k] += b[k] * f;
}

/** The tokens weighted with TOKEN_WEIGHTS (an uncached input token = 1). */
export const weigh = (t: TokenCounts): number => KINDS.reduce((a, k) => a + t[k] * TOKEN_WEIGHTS[k], 0);
