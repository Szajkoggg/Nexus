// The line of a "Paused for long" waiting card (queue IWS, docs/ux/idea-work-signals.md part c): why and since when the
// queue's run is paused, and at which step. Pure, unit tested (test/paused.test.ts).
import type { PausedWarning } from "@nexus/protocol";
import { t } from "./i18n.ts";

const DAY_MS = 86_400_000;

/** "Paused by you 4 days ago, before step AD2 (Summarize). Nothing runs until you resume it.", as of `now` (ms). */
export function pausedLine(w: PausedWarning, now: number): string {
  const ago = t("waiting.paused.ago", { count: Math.max(1, Math.floor((now - Date.parse(w.since)) / DAY_MS)) });
  const step = w.step;
  switch (w.cause) {
    case "pause": {
      if (!step) return t("waiting.paused.pause", { ago });
      const named = `${step}${w.step_title ? ` (${w.step_title})` : ""}`;
      return t(w.before ? "waiting.paused.pauseBefore" : "waiting.paused.pauseAt", { ago, step: named });
    }
    case "stop": return step ? t("waiting.paused.stop", { ago, step }) : t("waiting.paused.stopNoStep", { ago });
    case "stop_now": return step ? t("waiting.paused.stopNow", { ago, step }) : t("waiting.paused.stopNowNoStep", { ago });
    case "restart": return t("waiting.paused.restart", { ago });
  }
}
