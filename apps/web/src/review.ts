// Which review actions a step offers the user, as pure helpers (unit tested); the dashboard draws them.
import { counterpartOf, type Comparison, type KeyedLike } from "@nexus/protocol/pictures";

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

/** What the pairing reads of a review item. */
export interface PictureLike extends KeyedLike { path?: string; label?: string; round?: number; before?: string; at?: string }

/**
 * A review picture and the one it is compared with, if any (`before` is a path). `beforeLabel` names the other side:
 * "before" (an explicit --before, or a keyed before), "mockup", "variant A", "round N", or "earlier". `compare` says
 * how a keyed picture is compared (pictures.ts); unkeyed pairs have none.
 */
export interface Pair<T extends PictureLike> { item: T; before?: string; beforeLabel?: string; compare?: Comparison }

/**
 * Pairs each picture with what it is compared with. A picture with a view key pairs only by key and role
 * (`counterpartOf`, the rule `nexus review add` checks): an after with the before or mockup of its key, else with
 * its key's after of the latest earlier round; a variant-b with the variant-a; the others stand alone. A picture
 * without a key pairs as before keys existed: with the one named by `nexus review add --before`, else with the latest
 * earlier unkeyed picture with the same label from an earlier round (without round numbers: the latest earlier one
 * with that label, the items being in the order they were added).
 */
export function pairPictures<T extends PictureLike>(items: T[]): Pair<T>[] {
  return items.map((item, i) => {
    if (item.key) {
      const c = counterpartOf(items.slice(0, i), item);
      if (!c) return { item };
      const label = c.compare === "round" ? `round ${c.item.round}` : c.compare === "variant" ? "variant A" : c.compare;
      return { item, before: c.item.path, beforeLabel: label, compare: c.compare };
    }
    if (item.before) return { item, before: item.before, beforeLabel: "before" };
    if (item.label === undefined) return { item };
    const earlier = items.slice(0, i).filter((x) => x.path && !x.key && x.label === item.label
      && (item.round === undefined || x.round === undefined ? item.round === undefined && x.round === undefined : x.round < item.round));
    const best = earlier.sort((a, b) => (a.round ?? 0) - (b.round ?? 0)).at(-1);
    return best ? { item, before: best.path, beforeLabel: best.round !== undefined ? `round ${best.round}` : "earlier" } : { item };
  });
}
