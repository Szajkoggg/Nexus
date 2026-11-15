// Which notifications a device gets (PROTOCOL.md, "Push"): each device has its own settings, kept with its push
// subscription in <NEXUS_HOME>/push.json (the in-tab fallback keeps them in the browser). Each kind of notification can
// be turned off; quiet hours (in the device's time zone) hold back everything, and what they hold back is not sent
// later; "urgent breaks through" lets a stopped queue, a failed step and a failed update through the quiet hours. The
// test notification always goes. Pure, no schema library: the dashboard uses it too (unit tested in
// test/notify.test.ts).

/** The kinds a device can turn off, in the order the settings show them. */
export const NOTIFY_KINDS = [
  "question", "stopped", "approval", "review", "failed", "start", "provisional",
  "plan", "merge", "tags", "recurring",
  "update_failed", "deploy", "cancelled",
] as const;
export type NotifyKind = (typeof NOTIFY_KINDS)[number];

/** What a notification is: one of the kinds, or the test notification, which always goes. */
export type NotificationKind = NotifyKind | "test";

/** The kinds "urgent breaks through" lets through the quiet hours. */
export const URGENT_KINDS: readonly NotifyKind[] = ["stopped", "failed", "update_failed"];

export interface QuietHours {
  on: boolean;
  /** From and to, local time in the device's time zone, "HH:MM"; from later than to runs over midnight. */
  from: string;
  to: string;
}

export interface NotifySettings {
  /** The kinds turned off; a kind not named is on (so a kind added later is on). */
  off: NotifyKind[];
  quiet: QuietHours;
  /** The urgent kinds come through the quiet hours. */
  urgent: boolean;
  /** The device's IANA time zone ("Europe/Budapest"); none: the server's. */
  timezone?: string;
}

export const DEFAULT_NOTIFY: NotifySettings = { off: [], quiet: { on: false, from: "22:00", to: "07:00" }, urgent: false };

const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;
const isKind = (k: unknown): k is NotifyKind => typeof k === "string" && (NOTIFY_KINDS as readonly string[]).includes(k);

/** Whether a time zone is one this runtime knows (an unknown one makes Intl throw). */
export function knownTimeZone(tz: string): boolean {
  try { new Intl.DateTimeFormat("en", { timeZone: tz }); return true; } catch { return false; }
}

/**
 * The settings as stored (or as a device sends them), checked: the problems found, or the settings. Kinds this
 * version does not know are dropped rather than refused (a newer dashboard may know more).
 */
export function parseNotifySettings(raw: unknown): { settings: NotifySettings } | { error: string } {
  if (raw === undefined || raw === null) return { settings: structuredClone(DEFAULT_NOTIFY) };
  if (typeof raw !== "object" || Array.isArray(raw)) return { error: "notify settings: an object" };
  const r = raw as Record<string, unknown>;
  const problems: string[] = [];
  if (r.off !== undefined && !Array.isArray(r.off)) problems.push("off: a list of kinds");
  const quiet = (r.quiet ?? {}) as Record<string, unknown>;
  if (typeof quiet !== "object" || Array.isArray(quiet)) problems.push("quiet: an object");
  if (quiet.on !== undefined && typeof quiet.on !== "boolean") problems.push("quiet.on: true or false");
  for (const f of ["from", "to"] as const) {
    if (quiet[f] !== undefined && !(typeof quiet[f] === "string" && CLOCK.test(quiet[f]))) problems.push(`quiet.${f}: a time HH:MM`);
  }
  if (r.urgent !== undefined && typeof r.urgent !== "boolean") problems.push("urgent: true or false");
  if (r.timezone !== undefined && !(typeof r.timezone === "string" && knownTimeZone(r.timezone))) problems.push("timezone: an IANA time zone, e.g. Europe/Budapest");
  if (problems.length) return { error: `notify settings: ${problems.join("; ")}` };
  const settings: NotifySettings = {
    off: [...new Set((r.off as unknown[] | undefined ?? []).filter(isKind))],
    quiet: {
      on: (quiet.on as boolean | undefined) ?? DEFAULT_NOTIFY.quiet.on,
      from: (quiet.from as string | undefined) ?? DEFAULT_NOTIFY.quiet.from,
      to: (quiet.to as string | undefined) ?? DEFAULT_NOTIFY.quiet.to,
    },
    urgent: (r.urgent as boolean | undefined) ?? DEFAULT_NOTIFY.urgent,
  };
  if (r.timezone) settings.timezone = r.timezone as string;
  return { settings };
}

/** The settings of a stored subscription: what is wrong in them falls back to the defaults (a device is never silenced by a bad file). */
export function notifySettingsOf(raw: unknown): NotifySettings {
  const p = parseNotifySettings(raw);
  return "settings" in p ? p.settings : structuredClone(DEFAULT_NOTIFY);
}

/** The minute of the day (0-1439) at `at` in a time zone; the runtime's own zone when none is given or it is unknown. */
export function minuteOfDay(at: Date, timeZone?: string): number {
  const zone = timeZone && knownTimeZone(timeZone) ? timeZone : undefined;
  const parts = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", ...(zone ? { timeZone: zone } : {}) }).formatToParts(at);
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return n("hour") * 60 + n("minute");
}

const minutes = (clock: string) => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5));

/** Whether a minute of the day is within quiet hours from `from` up to (not including) `to`; over midnight when from > to; none when equal. */
export function inQuietHours(minute: number, from: string, to: string): boolean {
  const a = minutes(from), b = minutes(to);
  if (a === b) return false;
  return a < b ? minute >= a && minute < b : minute >= a || minute < b;
}

/** Whether a device with these settings gets a notification of this kind at `at`. */
export function shouldNotify(kind: NotificationKind, at: Date, s: NotifySettings): boolean {
  if (kind === "test") return true;
  if (s.off.includes(kind)) return false;
  if (!s.quiet.on || !inQuietHours(minuteOfDay(at, s.timezone), s.quiet.from, s.quiet.to)) return true;
  return s.urgent && URGENT_KINDS.includes(kind);
}
