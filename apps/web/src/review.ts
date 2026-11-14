// Which review actions a step offers the user, as pure helpers (unit tested); the dashboard draws them.
import { counterpartOf, type Comparison, type KeyedLike, type PictureRole } from "@nexus/protocol/pictures";
import { t, type Key } from "./i18n.ts";

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
 * A review picture and the one it is compared with, if any (`before` is a path; `other` the item, when it is one of
 * the step's). `beforeLabel` names the other side: "before" (an explicit --before, or a keyed before), "mockup",
 * "variant A", "round N", or "earlier". `compare` says how a keyed picture is compared (pictures.ts); unkeyed pairs
 * have none.
 */
export interface Pair<T extends PictureLike> { item: T; before?: string; beforeLabel?: string; compare?: Comparison; other?: T }

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
      const label = c.compare === "round" ? t("review.round", { round: String(c.item.round) }) : c.compare === "variant" ? t("review.role.variantA") : t(c.compare === "mockup" ? "review.role.mockup" : "review.role.before");
      return { item, before: c.item.path, beforeLabel: label, compare: c.compare, other: c.item };
    }
    if (item.before) return { item, before: item.before, beforeLabel: t("review.role.before") };
    if (item.label === undefined) return { item };
    const earlier = items.slice(0, i).filter((x) => x.path && !x.key && x.label === item.label
      && (item.round === undefined || x.round === undefined ? item.round === undefined && x.round === undefined : x.round < item.round));
    const best = earlier.sort((a, b) => (a.round ?? 0) - (b.round ?? 0)).at(-1);
    return best ? { item, before: best.path, beforeLabel: best.round !== undefined ? t("review.round", { round: String(best.round) }) : t("review.earlier"), other: best } : { item };
  });
}

/**
 * How the viewer names a picture's comparison: `text` for the line under its title (what is compared with what, or
 * the role of a keyed picture shown alone: "result", "before", …), `left` and `right` for the two sides. Unkeyed
 * pictures keep "Before" and "After", with no text.
 */
export interface ComparisonNames { text?: string; left: string; right: string }

const ALONE: Record<PictureRole, Key> = {
  before: "review.role.before", mockup: "review.role.mockup", after: "review.role.after",
  "variant-a": "review.role.variantA", "variant-b": "review.role.variantB", result: "review.role.result",
};

export function comparisonOf<T extends PictureLike>(p: Pair<T>): ComparisonNames {
  const { item, compare, other } = p;
  if (compare === "before" || compare === "mockup") {
    return {
      text: t(compare === "before" ? "review.compare.beforeAfter" : "review.compare.mockupAfter"),
      left: t(compare === "before" ? "review.side.before" : "review.side.mockup"), right: t("review.side.after"),
    };
  }
  if (compare === "variant") return { text: t("review.compare.variants"), left: t("review.side.variantA"), right: t("review.side.variantB") };
  if (compare === "round") {
    const from = String(other?.round), to = String(item.round);
    return { text: t("review.compare.rounds", { from, to }), left: t("review.side.round", { round: from }), right: t("review.side.round", { round: to }) };
  }
  return { text: item.key && item.role ? t(ALONE[item.role]) : undefined, left: t("review.side.before"), right: t("review.side.after") };
}
