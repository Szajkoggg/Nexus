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

/** One check's outcome as reported; `duration`: how long it ran, in seconds, when the reporter gave it. */
export interface CheckView { name: string; ok: boolean; summary?: string; duration?: number; at: string }
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
