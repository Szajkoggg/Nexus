// Templates and recurring queues on the Queues view, the parts free of React (unit tested in test/recurring.test.ts):
// what "New queue from template" asks of the orchestrator, which parameters are still missing, and how a recurring
// queue's state and schedule read. The components are in components/Recurring.tsx.
import type { RecurringView, TemplatesResponse } from "@nexus/protocol";
import { language, t, type Key } from "./i18n.ts";

export type Template = TemplatesResponse["templates"][number];
export type Mode = "survey" | "fix_small";

/** The values to send: each typed value (trimmed), and nothing for an empty one (its default, if any, then applies). */
export function filledValues(tpl: Pick<Template, "params">, typed: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(tpl.params.flatMap((p) => {
    const v = (typed[p.name] ?? "").trim();
    return v ? [[p.name, v]] : [];
  }));
}

/** The parameters without a default that are still empty: the form cannot be sent until they are given. */
export function missingParams(tpl: Pick<Template, "params">, typed: Readonly<Record<string, string>>): string[] {
  return tpl.params.filter((p) => p.default === undefined && !(typed[p.name] ?? "").trim()).map((p) => p.name);
}

/** A value as one shell word for the command line in the message: quoted when it has more than letters and digits. */
const word = (v: string) => (/^[\w.,:/@-]+$/.test(v) ? v : `"${v.replace(/(["\\$`])/g, "\\$1")}"`);

/**
 * The user's message to the orchestrator for "New queue from template": the template, the values given, the mode for a
 * maintenance template (when other than its own), the command that writes the draft, and the user's own words. The
 * orchestrator drafts from it and fills in the rest; the queue then waits for the user's approval as any.
 */
export function templateMessage(tpl: Pick<Template, "id" | "title" | "params" | "maintenance">, typed: Readonly<Record<string, string>>, mode?: Mode, note?: string): string {
  const values = filledValues(tpl, typed);
  const own = mode && mode !== tpl.maintenance ? mode : undefined;
  const command = ["nexus queue draft --template", tpl.id, ...Object.entries(values).map(([k, v]) => `--set ${k}=${word(v)}`), ...(own ? [`--maintenance ${own}`] : [])].join(" ");
  const lines = [
    t("templates.message.ask", { template: tpl.id, title: tpl.title }),
    ...Object.entries(values).map(([k, v]) => `- ${k}: ${v}`),
    ...tpl.params.filter((p) => !values[p.name] && p.default !== undefined).map((p) => `- ${p.name}: ${t("templates.message.default", { value: p.default! })}`),
    ...(own ? [t("templates.message.mode", { mode: own })] : []),
    t("templates.message.command", { command }),
    ...(note?.trim() ? [t("templates.message.note", { note: note.trim() })] : []),
    t("templates.message.rest"),
  ];
  return lines.join("\n");
}

const STATUS: Record<RecurringView["status"], { key: Key; tone: string }> = {
  approved: { key: "recurring.status.approved", tone: "approved" },
  needs_approval: { key: "recurring.status.needsApproval", tone: "proposed" },
  paused: { key: "recurring.status.paused", tone: "paused" },
  waiting_previous: { key: "recurring.status.waitingPrevious", tone: "waiting" },
  broken: { key: "recurring.status.broken", tone: "failed" },
};

/** A recurring queue's state as a word, and the status colour it takes (ui.tsx's tones). */
export function recurringStatus(r: Pick<RecurringView, "status">): { word: string; tone: string } {
  const s = STATUS[r.status];
  return { word: t(s.key), tone: s.tone };
}

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/** A weekday's name in the interface language (0 = Sunday), from a week known to start on a Sunday (2026-11-15). */
const weekday = (day: number) => new Intl.DateTimeFormat(language().locale, { weekday: "long" }).format(new Date(2026, 10, 15 + day, 12));

/**
 * Its schedule in words: "every day at 03:00", "every Monday at 03:00", "on day 1 of every month at 09:00", or "after
 * every 5 queues done (3 counted)". The server writes `every` in one form (daily HH:MM, <mon..sun> HH:MM, monthly D
 * HH:MM); another is shown as it is.
 */
export function scheduleWords(r: Pick<RecurringView, "every" | "after_queues" | "counted">): string {
  if (r.every === undefined) return t("recurring.afterQueues", { count: r.after_queues ?? 0, counted: r.counted ?? 0 });
  const [a, b, c] = r.every.split(" ");
  if (a === "daily" && b) return t("recurring.daily", { time: b });
  if (a && DAYS.includes(a) && b) return t("recurring.weekly", { day: weekday(DAYS.indexOf(a)), time: b });
  if (a === "monthly" && b && c) return t("recurring.monthly", { date: b, time: c });
  return t("recurring.every", { when: r.every });
}

/** What the user may do with it now: approve (only when it waits for that), pause or resume, remove. */
export function recurringActions(r: Pick<RecurringView, "status" | "paused">): ("approve" | "pause" | "resume" | "remove")[] {
  return [...(r.status === "needs_approval" ? ["approve" as const] : []), r.paused ? "resume" as const : "pause" as const, "remove" as const];
}
