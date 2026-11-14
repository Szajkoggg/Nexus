// The morning digest (UX proposals, 16): what happened in the projects since the user last looked, newest first:
// steps done or failed, queues stopped, done or cancelled (with their report), refused actions and retries. The
// server serves it across projects (GET /api/digest?since=); this part is pure and unit tested.
import type { Activity, Event, Refusal } from "./schemas.ts";
import { HOLDING_RUN_STATES } from "./times.ts";
import type { ProjectState } from "./state.ts";

export type DigestKind = "done" | "failed" | "stopped" | "queue_done" | "queue_cancelled" | "refused" | "retried";

export interface DigestEvent {
  at: string;
  project: string;
  project_name: string;
  kind: DigestKind;
  queue?: string;
  step?: string;
  /** What it was: a step's summary or reason, a queue's title, the refused action, the last retry's words. */
  text: string;
  /** Refused actions and retries of one step are one line: how many there were. */
  count?: number;
  /** A finished queue's report: its path in the project, for the file endpoint. */
  report?: string;
}

/** A queue at work now, for "running now · SF3, 40 min in". */
export interface DigestRunning { project: string; project_name: string; queue: string; step?: string; since?: string }

export interface DigestResponse { since: string; events: DigestEvent[]; running: DigestRunning[] }

export interface ProjectDigestInput {
  state: ProjectState;
  /** The events of every session of the project. */
  events: readonly Event[];
  refusals: readonly Refusal[];
  activity: readonly Activity[];
}

const after = (at: string | undefined, since: string) => !!at && Date.parse(at) > Date.parse(since);
const latest = (xs: (string | undefined)[]) => xs.filter((x): x is string => !!x).sort().at(-1);

/** What happened in one project after `since`, newest first. */
export function projectDigest(input: ProjectDigestInput, since: string): DigestEvent[] {
  const { state } = input;
  const base = { project: state.project.id, project_name: state.project.name };
  const out: DigestEvent[] = [];

  for (const e of input.events) {
    if (!after(e.at, since)) continue;
    if (e.type === "step.done") out.push({ ...base, at: e.at, kind: "done", queue: e.queue, step: e.step, text: e.summary });
    else if (e.type === "step.failed") out.push({ ...base, at: e.at, kind: "failed", queue: e.queue, step: e.step, text: e.reason });
    else if (e.type === "queue.stop") out.push({ ...base, at: e.at, kind: "stopped", queue: e.queue, ...(e.step ? { step: e.step } : {}), text: e.reason });
  }

  // A queue that finished: when its last step finished, else its run ended, else its latest event.
  for (const q of state.queues) {
    if (q.status !== "done" && q.status !== "cancelled") continue;
    const at = latest(q.steps.map((s) => s.finished_at)) ?? q.run?.ended_at ?? q.updated;
    if (!at || !after(at, since)) continue;
    out.push({ ...base, at, kind: q.status === "done" ? "queue_done" : "queue_cancelled", queue: q.id, text: q.title, ...(q.report ? { report: q.report.path } : {}) });
  }

  // Refused actions and retries: one line per step, at the latest, with how many.
  const grouped = (kind: "refused" | "retried", items: { at: string; queue?: string; step?: string; text: string }[]) => {
    const by = new Map<string, DigestEvent>();
    for (const x of items) {
      if (!after(x.at, since)) continue;
      const key = `${x.queue ?? ""}/${x.step ?? ""}`;
      const had = by.get(key);
      if (!had) { by.set(key, { ...base, at: x.at, kind, ...(x.queue ? { queue: x.queue } : {}), ...(x.step ? { step: x.step } : {}), text: x.text, count: 1 }); continue; }
      had.count = (had.count ?? 1) + 1;
      if (x.at >= had.at) { had.at = x.at; had.text = x.text; }
    }
    out.push(...by.values());
  };
  grouped("refused", input.refusals.map((r) => ({ at: r.at, queue: r.queue, step: r.step, text: `${r.tool} ${r.input}`.trim() })));
  grouped("retried", input.activity.filter((a) => a.kind === "retry").map((a) => ({ at: a.at, queue: a.queue, step: a.step, text: a.text })));

  return newestFirst(out);
}

export const newestFirst = (events: DigestEvent[]) => events.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));

/**
 * The project's queues at work now: a run that holds its session (HOLDING_RUN_STATES), except one waiting for an
 * approval: that one waits for the user (an attention item of kind approval), it is not running.
 */
export function projectRunning(state: ProjectState): DigestRunning[] {
  return state.queues
    .filter((q) => q.run && HOLDING_RUN_STATES.includes(q.run.state) && q.run.state !== "approval_wait")
    .map((q) => {
      const step = q.run!.step ?? q.current_step;
      const since = step ? q.steps.find((s) => s.id === step)?.segments.at(-1)?.start ?? q.run!.started_at : q.run!.started_at;
      return { project: state.project.id, project_name: state.project.name, queue: q.id, ...(step ? { step } : {}), ...(since ? { since } : {}) };
    });
}
