// Numbers of context tokens as people read them (queue CT): free of Node, for the server's texts and the dashboard.

/** A number of tokens, short: "900", "204.8k", "1.2M". */
export function tokenCount(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${Math.round(n / 100) / 10}k`;
  return `${Math.round(n / 100_000) / 10}M`;
}
