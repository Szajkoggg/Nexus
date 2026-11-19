// Context in tokens (queue CT): the thresholds, the cap at a share of the model's window, and token counts as people
// read them. Free of Node, for the server's texts and the dashboard.

/**
 * About how many context tokens a session may hold for the orchestrator to continue it for a new queue (queue CT): a
 * rule of thumb in its briefing, not a setting. Beyond it a fresh session costs less than carrying the old context.
 */
export const REUSE_TOKENS = 150_000;

/** The workers' context threshold when nothing else is set (context_reuse_tokens). */
export const DEFAULT_CONTEXT_REUSE_TOKENS = 300_000;
/** The orchestrator's context threshold when nothing else is set (orchestrator.context_threshold_tokens). */
export const DEFAULT_ORCHESTRATOR_CONTEXT_TOKENS = 500_000;
/** The share of a model's context window a context threshold is capped at (contextLimit). */
const CONTEXT_WINDOW_CAP = 0.8;
/**
 * The context threshold in use for a session (queue CT): the set number of tokens, but at most 80 % of the model's
 * context window, so a small window is never filled before a switch. An unknown window: undefined, no switch.
 */
export function contextLimit(tokens: number, window: number | undefined): number | undefined {
  return window && window > 0 ? Math.min(tokens, CONTEXT_WINDOW_CAP * window) : undefined;
}
/** Whether a session's context (`used` tokens of `window`) is beyond its threshold (contextLimit); unknown: no. */
export function contextBeyond(used: number | undefined, window: number | undefined, tokens: number): boolean {
  const limit = contextLimit(tokens, window);
  return used !== undefined && limit !== undefined && used > limit;
}

/** A number of tokens, short: "900", "204.8k", "1.2M". */
export function tokenCount(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${Math.round(n / 100) / 10}k`;
  return `${Math.round(n / 100_000) / 10}M`;
}
