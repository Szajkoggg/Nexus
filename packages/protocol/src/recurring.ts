// Recurring queues (PROTOCOL.md, "Recurring queues"): a template with its parameters and a schedule, run at each time
// while the user's standing approval holds. Pure: the schedule's forms and its next time, the standing approval's hash,
// a run's queue id, and what state a recurring is in. The server (apps/server/src/recurring.ts) acts on them.
import { createHash } from "node:crypto";
import type { RecurringFile } from "./schemas.ts";
import { fillTemplate, type MergedTemplates, type Template } from "./templates.ts";

/** A recurring queue's id: short enough that `<id>-<yyyymmdd>-<hhmm>` (and a number) is still a queue id. */
export const RECURRING_ID = /^[A-Za-z0-9][\w-]{0,15}$/;

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

/** A schedule, parsed: every day, one weekday (0 = Sunday) or one day of the month, at a local time. */
export type Every =
  | { kind: "daily"; hour: number; minute: number }
  | { kind: "weekly"; day: number; hour: number; minute: number }
  | { kind: "monthly"; date: number; hour: number; minute: number };

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * A schedule from its text: `daily HH:MM`, `<mon|tue|wed|thu|fri|sat|sun> HH:MM` or `monthly <1-31> HH:MM`, in the
 * server machine's local time. Throws an Error saying the forms.
 */
export function parseEvery(text: string): Every {
  const t = text.trim().toLowerCase().split(/\s+/);
  const clock = (s: string | undefined) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(s ?? "");
    if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return undefined;
    return { hour: Number(m[1]), minute: Number(m[2]) };
  };
  const forms = `"daily HH:MM", "<mon..sun> HH:MM" (for example "mon 03:00") or "monthly <day> HH:MM" (local time)`;
  if (t.length === 2 && t[0] === "daily" && clock(t[1])) return { kind: "daily", ...clock(t[1])! };
  const day = DAYS.indexOf(t[0] as (typeof DAYS)[number]);
  if (t.length === 2 && day >= 0 && clock(t[1])) return { kind: "weekly", day, ...clock(t[1])! };
  if (t.length === 3 && t[0] === "monthly" && /^\d{1,2}$/.test(t[1]!) && Number(t[1]) >= 1 && Number(t[1]) <= 31 && clock(t[2])) {
    return { kind: "monthly", date: Number(t[1]), ...clock(t[2])! };
  }
  throw new Error(`the schedule is ${forms}, not "${text}"`);
}

/** A schedule in its one written form ("mon 03:00"), as hashed and shown. */
export function everyText(e: Every): string {
  const at = `${pad(e.hour)}:${pad(e.minute)}`;
  return e.kind === "daily" ? `daily ${at}` : e.kind === "weekly" ? `${DAYS[e.day]} ${at}` : `monthly ${e.date} ${at}`;
}

/**
 * The schedule's first time after `afterMs` (ms since the epoch), in local time. A monthly day beyond the month's last
 * (31 in April) is its last day.
 */
export function nextOccurrence(e: Every, afterMs: number): number {
  const from = new Date(afterMs);
  for (let i = 0; i <= 400; i++) {
    const d = new Date(from.getFullYear(), from.getMonth(), from.getDate() + i, e.hour, e.minute);
    const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    const fits = e.kind === "daily" || (e.kind === "weekly" ? d.getDay() === e.day : d.getDate() === Math.min(e.date, last));
    if (fits && d.getTime() > afterMs) return d.getTime();
  }
  throw new Error("no next time within 400 days");
}

/** JSON with every object's keys sorted, so a hash does not depend on the order things were written in. */
function stable(x: unknown): string {
  if (Array.isArray(x)) return `[${x.map(stable).join(",")}]`;
  if (x && typeof x === "object") return `{${Object.keys(x).sort().map((k) => `${JSON.stringify(k)}:${stable((x as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(x);
}

/**
 * The standing approval's hash: the resolved, filled template (after the three layers, filled with the recurring's
 * id as the queue id), the parameters' values, the schedule and `coding`. A change of any of them (a project template
 * that replaces a shipped one, a deploy that changes the shipped one) gives another hash, and the approval no longer
 * holds.
 */
export function recurringHash(queue: Record<string, unknown>, r: Pick<RecurringFile, "params" | "every">): string {
  return "sha256:" + createHash("sha256").update(stable({
    queue, params: r.params, every: everyText(parseEvery(r.every)), coding: queue.coding === true,
  })).digest("hex");
}

/** What a recurring resolves to now: its template and filled queue with the hash, or why it cannot be used. */
export type Resolved = { template: Template; queue: Record<string, unknown>; hash: string } | { problem: string };

export function resolveRecurring(r: Pick<RecurringFile, "id" | "template" | "params" | "every">, merged: MergedTemplates): Resolved {
  const t = merged.templates.find((x) => x.id === r.template);
  if (!t) {
    const bad = merged.problems.find((p) => p.path.replace(/\\/g, "/").split("/").at(-1)!.replace(/\.ya?ml$/i, "") === r.template);
    return { problem: bad ? `template ${r.template} cannot be used: ${bad.problem}` : `no template ${r.template}` };
  }
  try {
    parseEvery(r.every);
    const queue = fillTemplate(t, r.params, r.id);
    return { template: t, queue, hash: recurringHash(queue, r) };
  } catch (e) { return { problem: (e as Error).message }; }
}

/**
 * The id of the queue a recurring makes for a time: `<id>-<yyyymmdd>-<hhmm>` in local time, with `-2`, `-3`, … when
 * a queue has it already (two runs in one minute).
 */
export function runQueueId(id: string, dueMs: number, taken: (queueId: string) => boolean): string {
  const d = new Date(dueMs);
  const base = `${id}-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  if (!taken(base)) return base;
  for (let n = 2; ; n++) if (!taken(`${base}-${n}`)) return `${base}-${n}`;
}

/**
 * A recurring's state: `broken` (its template is gone or cannot be filled), `paused` (by the user), `needs_approval`
 * (no standing approval, or the hash it approved is not the current one), `waiting_previous` (its last queue has not
 * closed: running, waiting or stopped; the next time passes without a run), else `approved`.
 */
export type RecurringStatus = "broken" | "paused" | "needs_approval" | "waiting_previous" | "approved";

export function recurringStatus(r: RecurringFile, resolved: Resolved, lastOpen: boolean): RecurringStatus {
  if ("problem" in resolved) return "broken";
  if (r.paused) return "paused";
  if (!r.approval || r.approval.hash !== resolved.hash) return "needs_approval";
  return lastOpen ? "waiting_previous" : "approved";
}

/** The time the next run is due after `nowMs` (ms), by the schedule; undefined when the schedule cannot be read. */
function nextRun(r: Pick<RecurringFile, "every" | "handled" | "created_at">, nowMs: number): number | undefined {
  try {
    const base = Math.max(nowMs, Date.parse(r.handled ?? r.created_at));
    return nextOccurrence(parseEvery(r.every), base);
  } catch { return undefined; }
}

/** A recurring queue as the state shows it: its file, its state now, its hash, the template's title and the next time. */
export interface RecurringView extends RecurringFile {
  status: RecurringStatus;
  /** The hash its standing approval would pin now (absent when broken). */
  hash?: string;
  /** Why it cannot be used (status broken). */
  problem?: string;
  template_title?: string;
  /** The layer its template comes from now. */
  template_layer?: Template["layer"];
  /** When the next run is due (ISO), by its schedule. */
  next_at?: string;
}

/**
 * The project's recurring queues as the state shows them (`files`: read from .nexus/recurring/), resolved through the
 * templates in effect; `open(queueId)` says whether a queue is still open (not done or cancelled, and there).
 */
export function recurringViews(files: readonly RecurringFile[], merged: MergedTemplates, open: (queueId: string) => boolean, nowMs: number): RecurringView[] {
  return files.map((r) => {
    const resolved = resolveRecurring(r, merged);
    const next = nextRun(r, nowMs);
    return {
      ...r,
      status: recurringStatus(r, resolved, !!r.last && open(r.last.queue)),
      ...("problem" in resolved ? { problem: resolved.problem } : { hash: resolved.hash, template_title: resolved.template.title, template_layer: resolved.template.layer }),
      ...(next !== undefined ? { next_at: new Date(next).toISOString() } : {}),
    };
  });
}
