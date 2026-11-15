// The steps Nexus keeps on the dashboard: the closing refactoring step (PROTOCOL.md, "The closing refactoring step"),
// which Nexus keeps after a coding queue's own steps, and the integration step ("The integration step"), last in a
// queue with a worktree of its own. Wherever steps are listed (the approval views, the queue's card and its step lines)
// they show last, as the derived state already orders them, and set apart: a mark instead of the long reserved id, and
// a tag that says Nexus keeps the step.
import type { StepView } from "@nexus/protocol";
import { t } from "../i18n.ts";

type Kept = Pick<StepView, "id" | "closing" | "integration">;

/** The closing step's mark, where a step's id would stand in a narrow column (its id is in the title). */
const CLOSING_MARK = "⟲";
/** The integration step's mark. */
const INTEGRATION_MARK = "⇄";

/** What stands in a step's id column: the mark of a step Nexus keeps, else the id. */
export function stepMark(step: Kept): string {
  return step.closing ? CLOSING_MARK : step.integration ? INTEGRATION_MARK : step.id;
}

/**
 * The tag beside the title of a step Nexus keeps: its mark and "by Nexus", and on hover what the step does. Nothing
 * for any other step.
 */
export function KeptTag({ step, className = "" }: { step: Kept; className?: string }) {
  if (!step.closing && !step.integration) return null;
  return (
    <span title={t(step.closing ? "closing.tagTitle" : "integration.tagTitle")}
      className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-line-strong px-1.5 text-[11px] font-medium leading-4 text-fg-2 ${className}`}>
      <span aria-hidden>{stepMark(step)}</span>{t("closing.tag")}
    </span>
  );
}
