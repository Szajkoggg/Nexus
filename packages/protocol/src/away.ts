// The user's away mode (PROTOCOL.md, "Away mode"): while it is on, level-2 steps are reviewed as level 3. Pure: the
// file is read and written by the store (store.ts, readAway/writeAway), and written only by the server.
import type { AwayFile, ReviewLevel } from "./schemas.ts";

/** Away mode as it is at `at`: on (since, until) or off. */
export interface AwayNow { on: boolean; since?: string; until?: string }

/** Whether away mode was on at time `at` (ISO 8601): within the current period or an earlier one. */
export function awayAt(a: Pick<AwayFile, "current" | "past">, at: string): boolean {
  if (a.current && a.current.since <= at && at < a.current.until) return true;
  return a.past.some((p) => p.since <= at && at < p.ended);
}

/** Away mode now. */
export function awayNow(a: Pick<AwayFile, "current" | "past">, now = new Date()): AwayNow {
  const at = now.toISOString();
  return a.current && awayAt({ current: a.current, past: [] }, at) ? { on: true, since: a.current.since, until: a.current.until } : { on: false };
}

/** The level a step is reviewed at now: level 2 runs as 3 while away mode is on; levels 1 and 3 as they are. */
export function levelNow(level: ReviewLevel, away: AwayNow): ReviewLevel {
  return level === 2 && away.on ? 3 : level;
}

/**
 * When away mode is to end, from what the user gave: a local clock time "8:00" or "08:00" (the next such time: later
 * today, else tomorrow), or an ISO 8601 time (in the future). Throws with the reason for anything else.
 */
export function awayUntil(input: unknown, now = new Date()): string {
  if (typeof input !== "string" || !input.trim()) throw new Error("until: a local time such as 8:00, or an ISO 8601 time");
  const t = input.trim();
  const clock = /^(\d{1,2}):(\d{2})$/.exec(t);
  if (clock) {
    const h = Number(clock[1]), m = Number(clock[2]);
    if (h > 23 || m > 59) throw new Error(`until: ${t} is not a time of day`);
    const d = new Date(now);
    d.setHours(h, m, 0, 0);
    if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
    return d.toISOString();
  }
  const ms = Date.parse(t);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(t) || Number.isNaN(ms)) throw new Error(`until: ${t} is neither a local time such as 8:00 nor an ISO 8601 time`);
  if (ms <= now.getTime()) throw new Error(`until: ${t} has passed`);
  return new Date(ms).toISOString();
}

/** Away mode turned on until `until` (an on mode gets the new end), or off (`until` null): the file to write. */
export function turnAway(a: AwayFile, until: string | null, now = new Date()): AwayFile {
  const out = expireAway(a, now);
  const at = now.toISOString();
  if (until === null) {
    if (!out.current) return out;
    return { ...out, current: undefined, past: [...out.past, { ...out.current, ended: at, why: "off" }] };
  }
  return { ...out, current: { since: out.current?.since ?? at, until } };
}

/** A current period whose time has come moves to the past (`expired`, ended at its `until`); else the file as it is. */
export function expireAway(a: AwayFile, now = new Date()): AwayFile {
  if (!a.current || a.current.until > now.toISOString()) return a;
  return { ...a, current: undefined, past: [...a.past, { ...a.current, ended: a.current.until, why: "expired" }] };
}
