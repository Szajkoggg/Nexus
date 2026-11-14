// A stopped queue's way on, decided in one place for every place that offers it (the queue's bar, the stopped step's
// line, the waiting cards; components/Stop.tsx): from whether the revision is approved, what the stopped step left
// and the user's Keep or Discard so far, which buttons show, with what words, and the hint beside them. Pure, unit
// tested (test/stopDecision.test.ts).
import { t } from "./i18n.ts";

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
      opener: { action: "open", label: t("stop.approveOpen", { revision }), title: t("stop.approveOpenTitle", { revision }), disabled: false },
      approve: {
        label: needsChoice && work === "discard" ? t("stop.discardWork") : t("stop.approve", { revision }),
        disabled: needsChoice && !work,
        hint: needsChoice
          ? !work ? t("stop.hint.chooseFirstApprove", { step: known!.step })
            : work === "discard" ? t("stop.hint.discardApprove", { step: known!.step })
            : t("stop.hint.keepApprove", { step: known!.step, revision })
          : discarded ? t("stop.hint.discardedApprove", { step: known!.step, revision })
          : undefined,
      },
    };
  }
  if (discarded) {
    return { needsChoice, discarded, hint: t("stop.hint.discarded", { step: known!.step }) };
  }
  return {
    needsChoice, discarded,
    opener: needsChoice
      ? { action: "choose", label: t("stop.continueChoose"), title: t("stop.continueChooseTitle", { step: known!.step, count: known!.commits.length }), disabled: false }
      // Before what the step left is known (undefined) the choice may be needed: wait for it. Unreadable: try, the server asks.
      : { action: "continue", label: t("stop.continue"), title: t("stop.continueTitle"), disabled: left === undefined },
    confirm: { label: needsChoice && work === "discard" ? t("stop.discardRevert") : t("stop.continue"), disabled: left === undefined || (needsChoice && !work) },
    hint: needsChoice && !work ? t("stop.hint.chooseFirst")
      : needsChoice && work === "discard" ? t("stop.hint.staysUntilRevert")
      : t("stop.hint.lifts"),
  };
}
