// The morning digest on the dashboard (UX proposals, 16): whether it shows, its four numbers, and what each line says.
// The lines come from the server (GET /api/digest; packages/protocol/src/digest.ts); this part is pure and unit tested,
// components/Digest.tsx draws it.
import type { DigestEvent, DigestRunning } from "@nexus/protocol/digest";
import type { WaitingItem } from "@nexus/protocol/attention";
import { formatDuration, t, type Key } from "./i18n.ts";

const after = (at: string | undefined, since: string) => !!at && Date.parse(at) > Date.parse(since);

/** Something new since the user last looked: a line of what happened, or an item that came to wait after it. */
export function hasNews(events: readonly DigestEvent[], waiting: readonly Pick<WaitingItem, "at">[], since: string): boolean {
  return events.some((e) => after(e.at, since)) || waiting.some((w) => after(w.at, since));
}

export interface Tile { n: number; text: string }
export interface Tiles { finished: Tile; stopped: Tile; waiting: Tile; running: Tile }

const KIND_WORDS: Record<WaitingItem["kind"], Key> = {
  question: "digest.kind.question", review: "digest.kind.review", approval: "digest.kind.approval",
  stopped: "digest.kind.stopped", failed: "digest.kind.failed", start: "digest.kind.start",
};

/**
 * The four numbers: steps finished (and queues done) and queues stopped since the time; what waits now (by kind) and
 * what runs now (the first with how long it has been at it).
 */
export function digestTiles(events: readonly DigestEvent[], waiting: readonly Pick<WaitingItem, "kind">[], running: readonly DigestRunning[], now = new Date()): Tiles {
  const done = events.filter((e) => e.kind === "done").length;
  const queuesDone = events.filter((e) => e.kind === "queue_done").length;
  const stops = events.filter((e) => e.kind === "stopped");
  const where = (e: DigestEvent) =>
    (e.step ? t("digest.tile.whereStep", { project: e.project_name, queue: e.queue ?? "", step: e.step }) : t("digest.tile.where", { project: e.project_name, queue: e.queue ?? "" })).trim();
  const kinds = (Object.keys(KIND_WORDS) as WaitingItem["kind"][])
    .map((k) => [k, waiting.filter((w) => w.kind === k).length] as const).filter(([, n]) => n > 0)
    .map(([k, n]) => t(KIND_WORDS[k], { count: n }));
  const first = running[0];
  const what = first ? first.step ?? first.queue : "";
  const runText = first ? `${first.since ? t("digest.tile.runningIn", { what, duration: formatDuration(now.getTime() - Date.parse(first.since)) }) : what}${running.length > 1 ? ` +${running.length - 1}` : ""}` : "";
  return {
    finished: { n: done, text: `${t("digest.tile.finished", { count: done })}${queuesDone ? ` · ${t("digest.tile.queuesDone", { count: queuesDone })}` : ""}` },
    stopped: { n: stops.length, text: `${t("digest.tile.stopped", { count: stops.length })}${stops[0] ? ` · ${where(stops[0])}` : ""}` },
    waiting: { n: waiting.length, text: `${t("digest.tile.waiting")}${kinds.length ? ` · ${kinds.join(", ")}` : ""}` },
    running: { n: running.length, text: `${t("digest.tile.running")}${runText ? ` · ${runText}` : ""}` },
  };
}

export type Tone = "ok" | "stop" | "danger" | "warn" | "muted";

/** A line's outcome in a word or two, and its colour: "done", "stopped at W4c", "queue done", "2 refused actions", "retried twice". */
export function outcome(e: Pick<DigestEvent, "kind" | "step" | "count">): { word: string; tone: Tone } {
  const n = e.count ?? 1;
  switch (e.kind) {
    case "done": return { word: t("digest.outcome.done"), tone: "ok" };
    case "failed": return { word: t("digest.outcome.failed"), tone: "danger" };
    case "stopped": return { word: e.step ? t("digest.outcome.stoppedAt", { step: e.step }) : t("digest.outcome.stopped"), tone: "stop" };
    case "queue_done": return { word: t("digest.outcome.queueDone"), tone: "ok" };
    case "queue_cancelled": return { word: t("digest.outcome.queueCancelled"), tone: "muted" };
    case "refused": return { word: t("digest.outcome.refused", { count: n }), tone: "danger" };
    case "retried": return { word: n === 2 ? t("digest.outcome.retriedTwice") : t("digest.outcome.retried", { count: n }), tone: "warn" };
  }
}
