// How a step's own runtime, model and effort read, the same in the dashboard and in `nexus status`. Pure and free of
// Node: the dashboard imports this module directly (`@nexus/protocol/steps`).
import type { StepDef } from "./schemas.ts";
import { formatSeconds } from "./times.ts";

const RUNTIME = { claude: "Claude Code", codex: "Codex" } as const;

/**
 * "Codex · gpt-6-luna · low effort": the values a step names for itself (what it leaves out is the run's), or undefined
 * for a step that names none.
 */
export function stepValuesText(step: Pick<StepDef, "runtime" | "model" | "effort">): string | undefined {
  const parts = [step.runtime && RUNTIME[step.runtime], step.model, step.effort && `${step.effort} effort`].filter(Boolean);
  return parts.length ? parts.join(" · ") : undefined;
}

/**
 * The checks a step of a queue runs: the project's (`defaults.checks`, as its run fixed them) first, then the queue's
 * own; a check named by both (or twice) runs once, where it first comes.
 */
export function stepChecks(project: readonly string[] | undefined, queue: readonly string[]): string[] {
  const out: string[] = [];
  for (const c of [...(project ?? []), ...queue]) {
    const name = c.trim();
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

/** One check's outcome as reported; `duration`: how long it ran, in seconds, when the reporter gave it. */
/** A check's outcome: reported by the worker (`check.result`), or run by Nexus (`by: "nexus"`; `flaky`: it failed, then passed). */
export interface CheckView { name: string; ok: boolean; summary?: string; duration?: number; at: string; by?: "nexus"; flaky?: boolean }
/** The latest outcome of each check, in the order the checks were first reported (a check run again replaces its earlier outcome). */
export function latestChecks(checks: readonly CheckView[]): CheckView[] {
  const byName = new Map<string, CheckView>();
  for (const c of checks) byName.set(c.name, c);
  return [...byName.values()];
}
/** The latest outcome of each check on one line: "typecheck ok (12 s), test FAILED (3 min 10 s)"; empty without checks. */
export function checksLine(checks: readonly CheckView[]): string {
  return latestChecks(checks).map((c) => `${c.name} ${c.ok ? "ok" : "FAILED"}${c.duration !== undefined ? ` (${formatSeconds(c.duration)})` : ""}`).join(", ");
}
