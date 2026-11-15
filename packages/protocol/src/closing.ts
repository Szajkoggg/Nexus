// The steps Nexus keeps after a queue's own: the closing refactoring step, and the integration step (below).
// The closing refactoring step (docs/ideas/refactor-step.md, PROTOCOL.md "The closing refactoring step"): every queue
// that contains coding (`coding: true` in queue.yaml) ends with a step Nexus keeps, outside the queue's list of steps.
// Derivation adds it after the steps (state.ts), so no step of the queue's own comes after it (only the integration
// step does), and once it has run, a later step at work makes it run again at the end. Its id is reserved, its
// goal and acceptance are Nexus's standard text, and its review level is 2 (its criteria can be checked).
import type { QueueFile, ReviewLevel, StepDef } from "./schemas.ts";

/** The closing step's review level: its criteria can be checked (tests, the diff), so the orchestrator reviews it. */
const CLOSING_LEVEL: ReviewLevel = 2;

/** The closing step's reserved id in queue `queue`: no step of the queue's own may have it. */
export function closingStepId(queue: string): string {
  return `${queue}.refactor`;
}

export const CLOSING_TITLE = "Closing refactoring";

/** Nexus's standard goal of the closing step. The step's opening adds the queue's commit range and the project's rules. */
export const CLOSING_GOAL = `Refactor what this queue changed, and the code closely tied to it, so that it reads simpler and clearer, with the same behaviour. Scope: the queue's commits (the range Nexus gives when the step opens) and the code right around them, never the codebase at large. If the project's AGENTS.md has a "Refactoring" section, follow it; without one, this text alone applies. A change too small to be worth refactoring is a valid outcome: say so, with your reasons, in the step's summary.`;

/** Nexus's standard acceptance criteria of the closing step. */
export const CLOSING_ACCEPTANCE: readonly string[] = [
  "Behaviour stays the same: no new features; the queue's checks pass before and after.",
  "Small commits, each saying in its message what it simplified; or none, with the reasons in the summary why nothing was worth refactoring.",
  "Only what the queue changed, or code closely tied to it.",
];

/** The closing step of a queue that contains coding; undefined for one that does not. */
function closingStep(q: Pick<QueueFile, "id" | "coding">): StepDef | undefined {
  if (!q.coding) return undefined;
  return {
    id: closingStepId(q.id), title: CLOSING_TITLE, goal: CLOSING_GOAL, acceptance: [...CLOSING_ACCEPTANCE],
    review: { level: CLOSING_LEVEL },
  };
}

// ---------------------------------------------------------------- the integration step

// The integration step (docs/ideas/parallel-worktrees-and-merge-back.md, PROTOCOL.md "The integration step"): every
// queue with a worktree of its own ends with it, after the closing refactoring step, whatever `coding` says. In the
// queue's worktree a worker merges the current base into the queue's branch and runs the checks there, so the base
// later only moves forward to that result. Kept like the closing step: outside the list, a reserved id, Nexus's text.

/** The integration step's review level: the merge and the checks can be judged, so the orchestrator reviews it. */
const INTEGRATION_LEVEL: ReviewLevel = 2;

/** The integration step's reserved id in queue `queue`. */
export function integrationStepId(queue: string): string {
  return `${queue}.integrate`;
}

export const INTEGRATION_TITLE = "Integration";

/** Nexus's standard goal of the integration step. Its opening adds the base, the branch and whether to resolve conflicts. */
export const INTEGRATION_GOAL = `Merge the current base branch into this queue's branch, in the queue's worktree, and run the queue's checks on the result, so that the queue's work and what reached the base meanwhile are tested together. The base then only moves forward to this step's result (a fast-forward), so nothing new arises on the base itself. The step's opening names the base, and whether you may resolve a conflict.`;

/** Nexus's standard acceptance criteria of the integration step. */
export const INTEGRATION_ACCEPTANCE: readonly string[] = [
  "The base branch the opening names is merged into the queue's branch (or the branch already contains it), with no change beyond what the merge needs.",
  "The queue's checks pass on the merged result.",
  "A conflict is resolved only where the opening allows it; one that is not resolved leaves the merge aborted and the queue stopped for the user.",
];

/** The condition a worker names when it stops the integration step on a conflict it does not resolve. */
export const INTEGRATION_CONDITION = "The integration found a conflict that it does not resolve";

/**
 * The queue has a worktree of its own: `worktree: auto` (made when it starts), or the server marked it when it began
 * to work in one (`integration`). A queue that worked in a worktree before the integration step existed has neither.
 */
function hasOwnWorktree(q: Pick<QueueFile, "worktree" | "integration">): boolean {
  return q.integration === true || q.worktree === "auto";
}

/** The integration step of a queue with a worktree of its own; undefined for one without. */
function integrationStep(q: Pick<QueueFile, "id" | "worktree" | "integration">): StepDef | undefined {
  if (!hasOwnWorktree(q)) return undefined;
  return {
    id: integrationStepId(q.id), title: INTEGRATION_TITLE, goal: INTEGRATION_GOAL, acceptance: [...INTEGRATION_ACCEPTANCE],
    review: { level: INTEGRATION_LEVEL },
  };
}

/** Every step the queue runs, in order: its own, then the closing step, then the integration step, each when it has one. */
export function stepDefs(q: Pick<QueueFile, "id" | "coding" | "steps"> & Partial<Pick<QueueFile, "worktree" | "integration">>): StepDef[] {
  return [...q.steps, ...[closingStep(q), integrationStep(q)].filter((s): s is StepDef => !!s)];
}

/** The step is one Nexus keeps after the queue's own (the closing or the integration step), so its id is reserved. */
export function isKeptStep(queue: string, step: string): boolean {
  return step === closingStepId(queue) || step === integrationStepId(queue);
}
