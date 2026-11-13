// A stopped queue's way on, decided in one place for every place that offers it (the queue's bar, the stopped step's
// line, the waiting cards; components/Stop.tsx): from whether the revision is approved, what the stopped step left
// and the user's Keep or Discard so far, which buttons show, with what words, and the hint beside them. Pure, unit
// tested (test/stopDecision.test.ts).

/** What the stopped step left, as `/queues/:queue/left` gives it (null outside git). */
export interface LeftView {
  step: string;
  commits: { sha: string; subject: string; author: string; at: string; files: number; insertions: number; deletions: number }[];
  uncommitted: { status: string; path: string }[];
  uncommitted_note: string;
  discarded: { at: string } | null;
}

/** What is known of it: undefined while first read, "error" when it could not be read. */
export type LeftState = LeftView | null | "error" | undefined;

export type WorkChoice = "keep" | "discard";

/** Whether the user must choose Keep or Discard before the stop is lifted: the step left commits, not yet discarded. */
export const needsWorkChoice = (left: LeftState): boolean =>
  !!left && left !== "error" && left.commits.length > 0 && !left.discarded;

export interface StopDecision {
  /** Keep or Discard is asked before Continue (or the approval). */
  needsChoice: boolean;
  /** Discard is recorded: no Continue; approving the orchestrator's revert lifts the stop. */
  discarded: boolean;
  /**
   * The one button where the stop is shown in short (a step's line, a waiting card): Continue lifts the stop at once;
   * "Continue…" opens the choice first; "Approve revision N…" opens the queue. None once Discard is recorded.
   */
  opener?: { action: "continue" | "choose" | "open"; label: string; title: string; disabled: boolean };
  /** The button that lifts the stop once the choice is made (the queue's bar, the open choice); when approved. */
  confirm?: { label: string; disabled: boolean };
  /**
   * The approval of a revision not yet approved (approving lifts the stop): its button, waiting for Keep or Discard
   * when the step left commits, and what the choice means (else nothing: the approval's own hint says what it pins).
   */
  approve?: { label: string; disabled: boolean; hint?: string };
  /** Beside the buttons: what pressing does, or what is still missing. */
  hint?: string;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** A stopped queue's buttons and hint, from its approval, what its stopped step left, and the user's choice so far. */
export function stopDecision({ approved, revision, left, work }: {
  approved: boolean; revision: number; left: LeftState; work?: WorkChoice;
}): StopDecision {
  const known = left === "error" ? undefined : left;
  const needsChoice = needsWorkChoice(known);
  const discarded = !!known?.discarded;
  if (!approved) {
    return {
      needsChoice, discarded,
      opener: { action: "open", label: `Approve revision ${revision}…`, title: `Revision ${revision} is not approved yet: approving it lifts the stop`, disabled: false },
      approve: {
        label: needsChoice && work === "discard" ? "Discard the step's work" : `Approve revision ${revision}`,
        disabled: needsChoice && !work,
        hint: needsChoice
          ? !work ? `First choose Keep or Discard for step ${known!.step}'s commits, in the stop box.`
            : work === "discard" ? `With Discard nothing is approved now: the orchestrator proposes a revision that reverts step ${known!.step}'s commits.`
            : `With Keep: step ${known!.step}'s commits stay, and approving revision ${revision} lifts the stop.`
          : discarded ? `You chose to discard step ${known!.step}'s work: approving revision ${revision} lifts the stop.`
          : undefined,
      },
    };
  }
  if (discarded) {
    return { needsChoice, discarded, hint: `You chose to discard step ${known!.step}'s commits: the orchestrator proposes a revision that reverts them, and approving it lifts the stop.` };
  }
  return {
    needsChoice, discarded,
    opener: needsChoice
      ? { action: "choose", label: "Continue…", title: `Step ${known!.step} left ${plural(known!.commits.length, "commit")}: keep or discard them first`, disabled: false }
      // Before what the step left is known (undefined) the choice may be needed: wait for it. Unreadable: try, the server asks.
      : { action: "continue", label: "Continue", title: "Lifts the stop; the stopped step runs again in its session, unless it was skipped", disabled: left === undefined },
    confirm: { label: needsChoice && work === "discard" ? "Discard and ask for a revert" : "Continue", disabled: left === undefined || (needsChoice && !work) },
    hint: needsChoice && !work ? "Choose Keep or Discard first."
      : needsChoice && work === "discard" ? "The stop stays until you approve the orchestrator's revert."
      : "Lifts the stop; the stopped step runs again in its session, unless it was skipped.",
  };
}
