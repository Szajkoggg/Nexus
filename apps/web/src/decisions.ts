// A step's review decisions in the dashboard (queue RVD; docs/design/review-decisions.md, "The screens"): what each
// decision's card shows, what holds the user's Accept, and the user's unsaved choices. Pure helpers (unit tested in
// test/decisions.test.ts) and one small store of drafts, shared by the step's panel and the picture viewer, so both
// show the same open and unsaved decisions. Drafts live in memory only: a reload shows what was saved, never a choice
// the user did not save; their key holds the decision's version, the review round and who holds the review, so a new
// version, a send-back's new round, another project or a change of who reviews never shows an old choice.
import { activeDecisions, asksFix, currentAnswer, openDecisions, type DecisionAnswer, type DecisionView } from "@nexus/protocol/review-decisions";
import type { StepView } from "./api.ts";
import { t } from "./i18n.ts";

/** What one decision's card is in the user's review. */
export interface CardState {
  d: DecisionView;
  /** The answer that counts now (any answerer's), if any. */
  current?: DecisionAnswer;
  /** `saved`: answered so that it counts for the user's Accept; `fix`: answered with an option asking for a change; `proposal`: the orchestrator's provisional answer, which the user must make their own; `open` otherwise. */
  state: "saved" | "fix" | "proposal" | "open";
  /** An answer to an earlier version in this round (the question changed since). */
  stale?: DecisionAnswer;
  /** The latest answer of an earlier round (the review before a send-back). */
  earlier?: DecisionAnswer;
}

/** Who gave an answer, in words: you, the orchestrator, the review helper. */
export const answererWord = (by: DecisionAnswer["by"]): string =>
  t(by === "user" ? "decisions.by.you" : by === "helper" ? "decisions.by.helper" : "decisions.by.orchestrator");

/** Each decision still on the list with its state for the user, in the list's order. */
export function decisionCards(step: Pick<StepView, "decisions">, round: number): CardState[] {
  const open = new Map(openDecisions(step.decisions, round, "user").map((o) => [o.id, o.why]));
  return activeDecisions(step.decisions).map((d) => {
    const current = currentAnswer(d, round);
    const stale = current ? undefined : d.answers.findLast((a) => a.round === round);
    const earlier = d.answers.findLast((a) => a.round < round);
    const state = !open.has(d.id) ? "saved" : asksFix(d, current) ? "fix" : current && current.by !== "user" && current.provisional ? "proposal" : "open";
    return { d, ...(current ? { current } : {}), state, ...(stale ? { stale } : {}), ...(earlier ? { earlier } : {}) };
  });
}

/** The answers the page shows, by decision: what an Accept names, so that answers saved meanwhile elsewhere refuse it. */
export function seenAnswers(step: Pick<StepView, "decisions">, round: number): Record<string, string> {
  return Object.fromEntries(activeDecisions(step.decisions).flatMap((d) => { const a = currentAnswer(d, round); return a ? [[d.id, a.event]] : []; }));
}

/** The decisions first whose material names the shown picture (its path or view key), the others after, each in order. */
export function materialFirst<T extends { d: Pick<DecisionView, "material"> }>(cards: T[], picture: { path?: string; key?: string } | undefined): T[] {
  if (!picture) return cards;
  const names = [picture.path, picture.key].filter((x): x is string => !!x);
  const shows = (c: T) => c.d.material.some((m) => names.includes(m));
  return [...cards.filter(shows), ...cards.filter((c) => !shows(c))];
}

// ---------------------------------------------------------------- drafts

/** One decision's unsaved answer: the option chosen (none) and the words. */
export interface Draft { choice?: string; words: string }

/** Who holds a review now, as a draft's key reads it: a change of level or of who reviews drops what was chosen before. */
export const holder = (step: Pick<StepView, "level" | "review_with" | "status">): string => `${step.status}:${step.review_with ?? "user"}:${step.level}`;

/** A draft's key: the project, step, decision, its version, the review round and who holds the review. */
export function draftId(project: string, queue: string, step: Pick<StepView, "id" | "level" | "review_with" | "status">, d: Pick<DecisionView, "id" | "version">, round: number): string {
  return [project, queue, step.id, d.id, d.version, round, holder(step)].join("|");
}

/** Whether a draft is an answer the user chose but has not saved: not empty, and not the answer saved already. */
export function unsaved(draft: Draft | undefined, current: DecisionAnswer | undefined): boolean {
  if (!draft) return false;
  const words = draft.words.trim();
  if (!draft.choice && !words) return false;
  return !(current?.by === "user" && current.choice === draft.choice && (current.text ?? "") === words);
}

const drafts = new Map<string, Draft>();
const listeners = new Set<() => void>();
let version = 0;

/** The drafts' store, for useSyncExternalStore: subscribe, and a number that changes with every change. */
export const draftStore = {
  subscribe(f: () => void): () => void { listeners.add(f); return () => { listeners.delete(f); }; },
  version: (): number => version,
  get: (id: string): Draft | undefined => drafts.get(id),
  set(id: string, draft: Draft | undefined): void {
    if (draft) drafts.set(id, draft); else drafts.delete(id);
    version++;
    for (const f of listeners) f();
  },
};

// ---------------------------------------------------------------- the Accept

/**
 * Why the user may not accept the step now for its decisions, as the action bar says it, or undefined when it may:
 * an answer asking for a change first, then the open decisions, then the unsaved ones. `unsavedIds`: the decisions
 * with an unsaved choice on this page.
 */
export function acceptHold(cards: CardState[], unsavedIds: string[]): { kind: "fix" | "open" | "proposal" | "unsaved"; ids: string[] } | undefined {
  const fix = cards.filter((c) => c.state === "fix").map((c) => c.d.id);
  if (fix.length) return { kind: "fix", ids: fix };
  const open = cards.filter((c) => c.state === "open").map((c) => c.d.id);
  if (open.length) return { kind: "open", ids: open };
  const proposal = cards.filter((c) => c.state === "proposal").map((c) => c.d.id);
  if (proposal.length) return { kind: "proposal", ids: proposal };
  return unsavedIds.length ? { kind: "unsaved", ids: unsavedIds } : undefined;
}

/** "1 of 3 answered": how many decisions count as answered for the user's Accept. */
export const answeredCount = (cards: CardState[]): { answered: number; total: number } =>
  ({ answered: cards.filter((c) => c.state === "saved").length, total: cards.length });

/**
 * The text Fix it starts with for "Instead…" beside an orchestrator's answer in the return batch: with two options the
 * other one is named; with more the user writes which.
 */
export function insteadText(a: { id: string; choice?: string; options: string[] }): string {
  const others = a.options.filter((o) => o !== a.choice);
  const theirs = a.choice ?? t("decisions.instead.noChoice");
  return others.length === 1 ? t("decisions.instead.other", { id: a.id, option: others[0]!, theirs }) : t("decisions.instead.choose", { id: a.id, theirs });
}
