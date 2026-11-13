// How a step's own runtime, model and effort read, the same in the dashboard and in `nexus status`. Pure and free of
// Node: the dashboard imports this module directly (`@nexus/protocol/steps`).
import type { StepDef } from "./schemas.ts";

const RUNTIME = { claude: "Claude Code", codex: "Codex" } as const;

/**
 * "Codex · gpt-6-luna · low effort": the values a step names for itself (what it leaves out is the run's), or undefined
 * for a step that names none.
 */
export function stepValuesText(step: Pick<StepDef, "runtime" | "model" | "effort">): string | undefined {
  const parts = [step.runtime && RUNTIME[step.runtime], step.model, step.effort && `${step.effort} effort`].filter(Boolean);
  return parts.length ? parts.join(" · ") : undefined;
}
