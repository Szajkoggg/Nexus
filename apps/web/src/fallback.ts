// A kind's fallback chain as the settings panel edits it, in one line of text: entries separated by commas, each
// `wait` or a runtime with an optional model and effort ("codex gpt-6-luna low, wait"). Pure, for the tests.
import type { FallbackEntry } from "@nexus/protocol";

const EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"];

/** The chain as a line: "codex gpt-6-luna low, wait"; empty for none. */
export function fallbackLine(chain: readonly FallbackEntry[] | undefined): string {
  return (chain ?? []).map((e) => (e === "wait" ? "wait" : [e.runtime, e.model, e.effort].filter(Boolean).join(" "))).join(", ");
}

/**
 * A line read back into a chain; the entry it cannot read (`bad`) otherwise. An entry is `wait`, or claude or codex
 * followed by at most a model and an effort (a word that is an effort level is the effort, another the model).
 */
export function parseFallback(line: string): { chain: FallbackEntry[] } | { bad: string } {
  const chain: FallbackEntry[] = [];
  for (const raw of line.split(",").map((x) => x.trim()).filter(Boolean)) {
    if (raw === "wait") { chain.push("wait"); continue; }
    const [runtime, ...rest] = raw.split(/\s+/);
    if (runtime !== "claude" && runtime !== "codex") return { bad: raw };
    const effort = rest.filter((w) => EFFORTS.includes(w));
    const model = rest.filter((w) => !EFFORTS.includes(w));
    if (effort.length > 1 || model.length > 1) return { bad: raw };
    chain.push({ runtime, ...(model[0] ? { model: model[0] } : {}), ...(effort[0] ? { effort: effort[0] as Exclude<FallbackEntry, "wait">["effort"] } : {}) });
  }
  return { chain };
}
