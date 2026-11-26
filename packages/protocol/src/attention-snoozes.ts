// A queue paused for long (queue IWS, docs/ux/idea-work-signals.md part c; docs/protocol/conversations.md, "A queue paused
// for long"): a run paused and waiting for the user longer than the project's `defaults.paused_warning_days` comes up in
// the user's Waiting list (attention kind `paused`), until it is resumed or cancelled, or the user puts it off ("Remind
// me in N days": .nexus/attention-snoozes.yaml, written only by the server at the user's request). Pure but for the
// put-off's write; the time is given, so a test moves it. Nothing re-derives by itself over time: the server's
// pause-warning.ts sets a timer for the next moment a warning comes due (nextPauseWarning).
import { ActionError } from "./actions.ts";
import type { AttentionSnooze, RunFile } from "./schemas.ts";
import type { AttentionItem, ProjectState, QueueView } from "./state.ts";
import { now, type ProjectStore } from "./store.ts";

export const DAY_MS = 86_400_000;

/**
 * Why a run is paused, of the pauses that wait for the user (decision D4): the user's Pause (`pause`), Stop now
 * (`stop`), Stop at once (`stop_now`), the pause a server restart left (`restart`). A rejected step (its review item),
 * a hold for an update or the merge train (they go on by themselves) and every other state do not count.
 */
export type PauseCause = "pause" | "stop" | "stop_now" | "restart";

/** The cause of a run's pause that waits for the user, by the reason the engine writes (engine.ts); undefined: none. */
export function pauseCause(run: Pick<RunFile, "state" | "reason" | "resume_after_restart" | "rejected"> | undefined): PauseCause | undefined {
  if (run?.state !== "paused" || run.resume_after_restart || run.rejected) return undefined;
  const r = run.reason ?? "";
  if (r.startsWith("paused by the user")) return "pause";
  if (r.startsWith("stopped at once by the user")) return "stop_now";
  if (r.startsWith("stopped by the user")) return "stop";
  if (r.startsWith("the Nexus server restarted")) return "restart";
  return undefined;
}

/** A long pause's waiting item's own part (kind `paused`). */
export interface PausedWarning {
  cause: PauseCause;
  /** When the run stopped going (its `ended_at`, else `updated_at`). */
  since: string;
  /** The put-off's key: `paused:<queue>:<since>`, so a new pause of the same queue starts afresh. */
  key: string;
  /** The deadline in days (the project's `defaults.paused_warning_days`): Remind me puts it off by as many. */
  days: number;
  /** The queue's title (the card's text). */
  title: string;
  /** The step it stands at, and its title; `before`: the step has not started (a Pause reached at a step's end). */
  step?: string;
  step_title?: string;
  before?: true;
}

const pauseKey = (queue: string, since: string) => `paused:${queue}:${since}`;

/** The pause's step: the one at work or waiting, else the next one to open (`before`), else the run's last opened. */
function pausedStep(q: QueueView): Pick<PausedWarning, "step" | "step_title" | "before"> {
  const at = q.current_step ? q.steps.find((s) => s.id === q.current_step) : undefined;
  if (at) return { step: at.id, step_title: at.title };
  const next = q.steps.find((s) => s.status === "pending");
  if (next) return { step: next.id, step_title: next.title, before: true };
  const last = q.run?.step ? q.steps.find((s) => s.id === q.run!.step) : undefined;
  return last ? { step: last.id, step_title: last.title } : q.run?.step ? { step: q.run.step } : {};
}

/**
 * Every queue whose run waits paused for the user, with the moment its warning shows (`due`, ms): the pause's start
 * plus the deadline, or the end of the user's put-off when later. None when the deadline is 0 (off).
 */
export function pauseWarnings(queues: readonly QueueView[], days: number, snoozes: readonly AttentionSnooze[]): { queue: QueueView; warning: PausedWarning; due: number }[] {
  if (!(days > 0)) return [];
  const until = new Map(snoozes.map((s) => [s.key, Date.parse(s.until)]));
  const out: { queue: QueueView; warning: PausedWarning; due: number }[] = [];
  for (const q of queues) {
    if (q.status === "done" || q.status === "cancelled" || q.status === "stopped" || q.rejection) continue;
    const cause = pauseCause(q.run);
    if (!cause) continue;
    const since = q.run!.ended_at ?? q.run!.updated_at;
    const start = Date.parse(since);
    if (!Number.isFinite(start)) continue;
    const key = pauseKey(q.id, since);
    const due = Math.max(start + days * DAY_MS, until.get(key) ?? 0);
    out.push({ queue: q, warning: { cause, since, key, days, title: q.title, ...pausedStep(q) }, due });
  }
  return out;
}

/** How long ago, in whole days: "1 day ago", "4 days ago". */
const daysAgo = (since: string, at: number) => {
  const d = Math.max(1, Math.floor((at - Date.parse(since)) / DAY_MS));
  return `${d} day${d === 1 ? "" : "s"} ago`;
};

/** The warning in a line, for the agents (`nexus status`) and the notifications: "paused by the user 4 days ago at step AD2; …". */
export function pausedText(w: PausedWarning, at: number): string {
  const ago = daysAgo(w.since, at);
  const step = w.step ? ` ${w.before ? "before" : "at"} step ${w.step}` : "";
  const what = w.cause === "pause" ? `paused by the user ${ago}${step}`
    : w.cause === "stop" ? `stopped by the user ${ago}${step}`
    : w.cause === "stop_now" ? `stopped at once by the user ${ago}${step}`
    : `paused when the Nexus server restarted, ${ago}${step ? `,${step}` : ""}`;
  return `${what}; nothing runs until it is resumed`;
}

/** The waiting items of the queues paused for long at `at` (ms): one per queue, its time the moment it came due. */
export function pausedAttention(queues: readonly QueueView[], days: number, snoozes: readonly AttentionSnooze[], at: number): AttentionItem[] {
  return pauseWarnings(queues, days, snoozes).filter((w) => w.due <= at).map(({ queue, warning, due }) => ({
    kind: "paused", queue: queue.id, text: pausedText(warning, at), at: new Date(due).toISOString(), paused: warning,
  }));
}

/** The next moment after `at` (ms) a warning comes due or a put-off ends; undefined when none waits. */
export function nextPauseWarning(queues: readonly QueueView[], days: number, snoozes: readonly AttentionSnooze[], at: number): number | undefined {
  const later = pauseWarnings(queues, days, snoozes).map((w) => w.due).filter((d) => d > at);
  return later.length ? Math.min(...later) : undefined;
}

/**
 * The user's "Remind me in N days" on a long pause's waiting item (`key`): put off by the deadline once more. Put-offs
 * of pauses that are over are dropped in the same write. Returns when it comes back.
 */
export function snoozeAttention(store: ProjectStore, state: ProjectState, key: string, at = Date.now()): string {
  const item = state.attention.find((a) => a.paused?.key === key);
  if (!item?.paused) throw new ActionError(`nothing waits under ${key}: the queue was resumed, or the warning is not due`, 409);
  const until = new Date(at + item.paused.days * DAY_MS).toISOString();
  const open = new Set(pauseWarnings(state.queues, item.paused.days, []).map((w) => w.warning.key));
  const items = store.readAttentionSnoozes().items.filter((s) => s.key !== key && open.has(s.key));
  store.writeAttentionSnoozes({ protocol: 1, items: [...items, { key, until, at: now() }] });
  return until;
}
