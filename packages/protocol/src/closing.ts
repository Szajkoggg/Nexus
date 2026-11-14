// The closing refactoring step (docs/ideas/refactor-step.md, PROTOCOL.md "The closing refactoring step"): every queue
// that contains coding (`coding: true` in queue.yaml) ends with a step Nexus keeps, outside the queue's list of steps.
// Derivation adds it after the steps (state.ts), so it is always the last: a revision that adds steps cannot put
// anything after it, and once it has run, a later step at work makes it run again at the end. Its id is reserved, its
// goal and acceptance are Nexus's standard text, and its review level is 2 (its criteria can be checked).
import type { QueueFile, ReviewLevel, StepDef } from "./schemas.ts";

/** The closing step's review level: its criteria can be checked (tests, the diff), so the orchestrator reviews it. */
export const CLOSING_LEVEL: ReviewLevel = 2;

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
export function closingStep(q: Pick<QueueFile, "id" | "coding">): StepDef | undefined {
  if (!q.coding) return undefined;
  return {
    id: closingStepId(q.id), title: CLOSING_TITLE, goal: CLOSING_GOAL, acceptance: [...CLOSING_ACCEPTANCE],
    review: { level: CLOSING_LEVEL },
  };
}

/** Every step the queue runs, in order: its own, then the closing step when it has one. */
export function stepDefs(q: Pick<QueueFile, "id" | "coding" | "steps">): StepDef[] {
  const closing = closingStep(q);
  return closing ? [...q.steps, closing] : q.steps;
}

/** The step is a queue's closing step. */
export function isClosingStep(queue: string, step: string): boolean {
  return step === closingStepId(queue);
}
