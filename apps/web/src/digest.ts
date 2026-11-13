// The morning digest on the dashboard (UX proposals, 16): whether it shows, its four numbers, and what each line says.
// The lines come from the server (GET /api/digest; packages/protocol/src/digest.ts); this part is pure and unit tested,
// components/Digest.tsx draws it.
import type { DigestEvent, DigestRunning } from "@nexus/protocol/digest";
import type { WaitingItem } from "@nexus/protocol/attention";
import { formatDuration } from "@nexus/protocol/times";

const after = (at: string | undefined, since: string) => !!at && Date.parse(at) > Date.parse(since);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Something new since the user last looked: a line of what happened, or an item that came to wait after it. */
export function hasNews(events: readonly DigestEvent[], waiting: readonly Pick<WaitingItem, "at">[], since: string): boolean {
  return events.some((e) => after(e.at, since)) || waiting.some((w) => after(w.at, since));
}

export interface Tile { n: number; text: string }
export interface Tiles { finished: Tile; stopped: Tile; waiting: Tile; running: Tile }

const KIND_WORDS: Record<WaitingItem["kind"], [string, string]> = {
  question: ["question", "questions"], review: ["review", "reviews"], approval: ["approval", "approvals"],
  stopped: ["stop", "stops"], failed: ["failure", "failures"], start: ["start that failed", "starts that failed"],
};

/**
 * The four numbers: steps finished (and queues done) and queues stopped since the time; what waits now (by kind) and
 * what runs now (the first with how long it has been at it).
 */
export function digestTiles(events: readonly DigestEvent[], waiting: readonly Pick<WaitingItem, "kind">[], running: readonly DigestRunning[], now = new Date()): Tiles {
  const done = events.filter((e) => e.kind === "done").length;
  const queuesDone = events.filter((e) => e.kind === "queue_done").length;
  const stops = events.filter((e) => e.kind === "stopped");
  const where = (e: DigestEvent) => `${e.project_name} ${e.queue ?? ""}${e.step ? ` at ${e.step}` : ""}`.trim();
  const kinds = (Object.keys(KIND_WORDS) as WaitingItem["kind"][])
    .map((k) => [k, waiting.filter((w) => w.kind === k).length] as const).filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${KIND_WORDS[k][n === 1 ? 0 : 1]}`);
  const first = running[0];
  const runText = first ? `${first.step ?? first.queue}${first.since ? `, ${formatDuration(now.getTime() - Date.parse(first.since))} in` : ""}${running.length > 1 ? ` +${running.length - 1}` : ""}` : "";
  return {
    finished: { n: done, text: `${done === 1 ? "step" : "steps"} finished${queuesDone ? ` · ${plural(queuesDone, "queue")} done` : ""}` },
    stopped: { n: stops.length, text: `${stops.length === 1 ? "queue" : "queues"} stopped${stops[0] ? ` · ${where(stops[0])}` : ""}` },
    waiting: { n: waiting.length, text: `waiting for you${kinds.length ? ` · ${kinds.join(", ")}` : ""}` },
    running: { n: running.length, text: `running now${runText ? ` · ${runText}` : ""}` },
  };
}

export type Tone = "ok" | "stop" | "danger" | "warn" | "muted";

/** A line's outcome in a word or two, and its colour: "done", "stopped at W4c", "queue done", "2 refused actions", "retried twice". */
export function outcome(e: Pick<DigestEvent, "kind" | "step" | "count">): { word: string; tone: Tone } {
  const n = e.count ?? 1;
  switch (e.kind) {
    case "done": return { word: "done", tone: "ok" };
    case "failed": return { word: "failed", tone: "danger" };
    case "stopped": return { word: e.step ? `stopped at ${e.step}` : "stopped", tone: "stop" };
    case "queue_done": return { word: "queue done", tone: "ok" };
    case "queue_cancelled": return { word: "queue cancelled", tone: "muted" };
    case "refused": return { word: plural(n, "refused action"), tone: "danger" };
    case "retried": return { word: n === 1 ? "retried" : n === 2 ? "retried twice" : `retried ${n} times`, tone: "warn" };
  }
}
