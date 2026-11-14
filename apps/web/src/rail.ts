// The right rail of a desktop (UX proposals, 11A): what runs in the project and what finished in it today, with the
// honest status of each queue (queueStatus.ts). What waits (all projects) comes from mergeAttention. Pure and unit
// tested; components/Rail.tsx draws it.
import { queueStatus, type HonestStatus, type QueueLike as StatusLike } from "./queueStatus.ts";
import { splitFinished, type FinishedRow, type QueueLike as FinishLike } from "./finished.ts";
import { t } from "./i18n.ts";

type Q = StatusLike & FinishLike & { id: string };

/**
 * The queues that run in a project now: their run goes (running, or pausing after the current step; decided
 * 2026-11-14, queue FU). Everything else is elsewhere: what waits for the user (an answer, a review, an approval, a
 * stop) in the rail's first section; what waits on its own (a retry, the usage window), what is paused and what is
 * planned in the project's queues ("All queues").
 */
export function atWork<T extends Q>(queues: readonly T[], now = new Date()): { queue: T; status: HonestStatus }[] {
  return queues.map((queue) => ({ queue, status: queueStatus(queue, now) })).filter(({ status }) => status.tone === "running");
}

/** The status in a few words, for the end of a rail line: "1/3" while it runs, "review", "after SF", "paused"… */
export function shortStatus(s: HonestStatus): string {
  const key = s.says?.key;
  const p = s.says?.params ?? {};
  /** A planned start in short: "after SF", "at 14:00". */
  const start = (k: unknown) => k === "status.startsAfter" ? t("rail.short.after", { queue: p.queue ?? "" })
    : k === "status.startsAt" ? t("rail.short.at", { time: p.time ?? "" }) : t("status.planned");
  switch (s.tone) {
    case "running": return key === "status.pausingAfter" || key === "status.pausingThisStep" ? t("rail.short.pausing") : `${s.closed}/${s.total}`;
    case "review": return key === "status.orchestratorReviews" ? t("rail.short.orchestratorReviews") : t("rail.short.review");
    case "planned":
      return key === "status.heldCheckout" ? t("rail.short.heldCheckout") : key === "status.heldLimit" ? t("rail.short.heldLimit")
        : key === "status.startsAfter" || key === "status.startsAt" ? start(key) : s.label;
    case "approval":
      return key === "status.approvalWait" || key === "status.approvalWaitAfter" ? t("rail.short.waitsApproval")
        : key === "status.needsApprovalRevision" ? t("rail.short.needsApproval")
        : key === "status.needsApprovalThen" ? t("rail.short.needsApprovalThen", { start: start(p.startKind) })
        : s.label;
    case "waiting": return key === "status.waitingAnswer" ? t("rail.short.question") : key === "status.usage" ? t("rail.short.usage") : t("rail.short.retry");
    default: return s.label;
  }
}

/** The queues that finished today (the local day of `now`), most recent first; one that still waits for the user is not finished. */
export function finishedToday<T extends Q>(queues: readonly T[], waiting: ReadonlySet<string>, now = new Date()): FinishedRow<T>[] {
  const today = now.toDateString();
  return splitFinished(queues, waiting).finished.filter((r) => !!r.finished_at && new Date(r.finished_at).toDateString() === today);
}
