// Which review actions a step offers the user, as pure helpers (unit tested); the dashboard draws them.

/** What the helpers read of a step (a StepView has all of it). */
export interface StepLike { id: string; status: string; review_with?: "orchestrator" | "user" }

/**
 * Accept, Fix it (and Reject) appear only on a step waiting for the user's review: policy wait, or orchestrator once
 * the step went to the user. Never on a step that went on under continue, nor on one the orchestrator still holds.
 */
export function showsReviewActions(step: StepLike): boolean {
  return step.status === "review" && step.review_with !== "orchestrator";
}

/**
 * Where a note on Accept can go: the next pending step after this one, or the orchestrator. Without a next step (the
 * queue's last) only the orchestrator.
 */
export function noteTargets(steps: StepLike[], step: string): { next?: string; orchestrator: true } {
  const i = steps.findIndex((s) => s.id === step);
  const next = i < 0 ? undefined : steps.slice(i + 1).find((s) => s.status === "pending");
  return { next: next?.id, orchestrator: true };
}
