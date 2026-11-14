// The closing refactoring step on the dashboard (PROTOCOL.md, "The closing refactoring step"): Nexus keeps it after a
// coding queue's own steps. Wherever steps are listed (the approval views, the queue's card and its step lines) it
// shows last, as the derived state already orders it, and set apart: its mark instead of its long reserved id, and a
// tag that says it is the closing step Nexus keeps.
import type { StepView } from "@nexus/protocol";
import { t } from "../i18n.ts";

/** The closing step's mark, where a step's id would stand in a narrow column (its id is in the title). */
export const CLOSING_MARK = "⟲";

/** What stands in a step's id column: the closing step's mark, else the id. */
export function stepMark(step: Pick<StepView, "id" | "closing">): string {
  return step.closing ? CLOSING_MARK : step.id;
}

/** The tag beside the closing step's title ("Closing refactoring"): "by Nexus", and what that means on hover. */
export function ClosingTag({ className = "" }: { className?: string }) {
  return (
    <span title={t("closing.tagTitle")}
      className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-line-strong px-1.5 text-[11px] font-medium leading-4 text-fg-2 ${className}`}>
      <span aria-hidden>{CLOSING_MARK}</span>{t("closing.tag")}
    </span>
  );
}
