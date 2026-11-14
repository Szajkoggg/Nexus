// The dashboard's translation layer (DESIGN.md, "The interface texts in one place"): every text the dashboard shows
// is a key in a catalogue, English the source (messages/en.ts); t() looks a key up in the interface language, with
// parameters and plural forms, and falls back to English for a key a translation lacks. Dates, times and durations
// are formatted here too, through Intl with the interface language's locale. Pure and unit tested; no React.
import { en } from "./messages/en.ts";

/** A key of the English catalogue: every text has one. */
export type Key = keyof typeof en;

/** A text that depends on a number (the `count` parameter): one form per plural category of the language. */
export interface Plural { zero?: string; one?: string; two?: string; few?: string; many?: string; other: string }
export type Message = string | Plural;
/** A translation: any subset of the English keys; what it lacks shows in English. */
export type Catalogue = Partial<Record<Key, Message>>;
export type Params = Record<string, string | number>;

export interface Language {
  /** The interface language's code: "en", "hu", … */
  code: string;
  /** The locale Intl formats dates, times and numbers with: the English source keeps the dashboard's day-month form. */
  locale: string;
  messages: Catalogue;
}

const ENGLISH: Language = { code: "en", locale: "en-GB", messages: en };
const languages = new Map<string, Language>([["en", ENGLISH]]);
let current = ENGLISH;

/** Makes a translation available (a later queue adds the catalogues; tests add their own). */
export function addLanguage(lang: Language): void { languages.set(lang.code, lang); }

/** Switches the interface language; an unknown code keeps English. Returns the language in use. */
export function setLanguage(code: string): Language {
  current = languages.get(code) ?? ENGLISH;
  return current;
}

export const language = (): Language => current;

// Intl objects are not cheap to build; one per locale and shape.
const cache = new Map<string, Intl.PluralRules | Intl.NumberFormat | Intl.DateTimeFormat>();
function cached<T extends Intl.PluralRules | Intl.NumberFormat | Intl.DateTimeFormat>(key: string, make: () => T): T {
  let x = cache.get(key) as T | undefined;
  if (!x) { x = make(); cache.set(key, x); }
  return x;
}
const plurals = (locale: string) => cached(`p|${locale}`, () => new Intl.PluralRules(locale));
const numbers = (locale: string) => cached(`n|${locale}`, () => new Intl.NumberFormat(locale));
const dates = (locale: string, o: Intl.DateTimeFormatOptions) => cached(`d|${locale}|${JSON.stringify(o)}`, () => new Intl.DateTimeFormat(locale, o));

/** The message for a key and the language it is in: the interface language's, else English's. */
function lookup(key: Key): { message: Message; lang: Language } {
  const own = current.messages[key];
  if (own !== undefined) return { message: own, lang: current };
  return { message: en[key] as Message, lang: ENGLISH };
}

/** The form of a plural message for `count`, by the language's plural rules; `other` when the language lacks that form. */
function pick(message: Message, lang: Language, count: unknown): string {
  if (typeof message === "string") return message;
  const n = typeof count === "number" ? count : Number(count);
  const category = Number.isFinite(n) ? plurals(lang.locale).select(n) : "other";
  return message[category as keyof Plural] ?? message.other;
}

/**
 * The parts of a text with its `{name}` placeholders filled: strings, and the values as given when they are not
 * strings or numbers (React elements, for rich()). A number is formatted for the locale; a placeholder without a
 * value stays as written, so a missing parameter shows rather than vanishing.
 */
function fill<T>(text: string, params: Record<string, string | number | T> | undefined, locale: string): (string | T)[] {
  const out: (string | T)[] = [];
  const re = /\{(\w+)\}/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const v = params?.[m[1]!];
    if (v === undefined) continue;
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(typeof v === "number" ? numbers(locale).format(v) : v);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** A text in the interface language: `t("waiting.title", { count: 3 })`. A plural message chooses its form by `count`. */
export function t(key: Key, params?: Params): string {
  const { message, lang } = lookup(key);
  return fill(pick(message, lang, params?.count), params, lang.locale).join("");
}

/**
 * A text whose parameters may be elements (a link, a <code>): its parts in order, for React to render as children.
 * `rich("shell.noProjects", { command: <code>…</code> })`.
 */
export function rich<T>(key: Key, params: Record<string, string | number | T>): (string | T)[] {
  const { message, lang } = lookup(key);
  return fill(pick(message, lang, params.count), params, lang.locale);
}

/** A number for the interface language: "1,234". */
export const formatNumber = (n: number): string => numbers(current.locale).format(n);

// ---------------------------------------------------------------- dates, times and durations

const CLOCK: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit", hourCycle: "h23" };
const DAY: Intl.DateTimeFormatOptions = { day: "numeric", month: "short" };
const DAY_YEAR: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", year: "numeric" };
const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** A local time: "14:02" today, "11 Nov 14:02" on another day this year, "11 Nov 2025 14:02" in another year. */
export function formatClock(iso: string, now: Date): string {
  const at = new Date(iso);
  const clock = dates(current.locale, CLOCK).format(at);
  if (sameDay(at, now)) return clock;
  const date = dates(current.locale, at.getFullYear() === now.getFullYear() ? DAY : DAY_YEAR).format(at);
  return t("time.dayClock", { date, clock });
}

/** The full date and time, for a title on hover: "14 Nov 2026, 14:02:05". */
export const formatDateTime = (iso: string): string => dates(current.locale, { dateStyle: "medium", timeStyle: "medium" }).format(new Date(iso));
/** A date: "14 Nov 2026". */
export const formatDate = (iso: string): string => dates(current.locale, { dateStyle: "medium" }).format(new Date(iso));
/** A time of day with seconds: "14:02:05". */
export const formatTime = (iso: string): string => dates(current.locale, { ...CLOCK, second: "2-digit" }).format(new Date(iso));

/** "<1 min", "12 min", "1 h 12 min", "3 h", "2 d 5 h". Minutes are rounded down, so a running clock never jumps ahead. */
export function formatDuration(duration: number): string {
  const min = Math.floor(duration / 60_000);
  if (min < 1) return t("duration.underMinute");
  if (min < 60) return t("duration.minutes", { m: min });
  const h = Math.floor(min / 60), m = min % 60;
  if (h < 24) return m ? t("duration.hoursMinutes", { h, m }) : t("duration.hours", { h });
  const d = Math.floor(h / 24), rh = h % 24;
  return rh ? t("duration.daysHours", { d, h: rh }) : t("duration.days", { d });
}

/** How long ago: "just now", "5 min ago", "3 h ago", "2 d ago". */
export function timeAgo(iso: string, now: number): string {
  const s = (now - Date.parse(iso)) / 1000;
  if (s < 60) return t("time.justNow");
  if (s < 3600) return t("time.minutesAgo", { m: Math.floor(s / 60) });
  if (s < 86400) return t("time.hoursAgo", { h: Math.floor(s / 3600) });
  return t("time.daysAgo", { d: Math.floor(s / 86400) });
}
