// The in-tab notifications' settings and choice (components/Notify.tsx shows them): where push is not available, the
// open tab notifies, and it filters exactly as the server does for a push device (@nexus/protocol notify.ts), with the
// settings kept in this browser. Pure apart from the localStorage wrapper at the end; unit tested (test/notify.test.ts).
import { notifySettingsOf, shouldNotify, type NotifySettings } from "@nexus/protocol/notify";

/** One item in a project's waiting list, keyed as the tab remembers it. */
export interface TabItem<T> { key: string; kind: Parameters<typeof shouldNotify>[0]; item: T }

/**
 * What the tab notifies of now: the items not in `seen` (the list as it was last time) that the settings let through
 * at `at`. With no `seen` (the page just loaded) nothing: the list found then is the baseline. What the quiet hours or
 * a kind turned off hold back is not shown later either.
 */
export function tabNews<T>(seen: ReadonlySet<string> | null, current: TabItem<T>[], settings: NotifySettings, at: Date): TabItem<T>[] {
  if (!seen) return [];
  return current.filter((c) => !seen.has(c.key) && shouldNotify(c.kind, at, settings));
}

// ---------------------------------------------------------------- localStorage

const STORAGE_KEY = "nexus.notify.settings";

/** This browser's in-tab settings: the defaults when none are kept (its quiet hours in the browser's own time zone). */
export function readLocalNotify(): NotifySettings {
  let raw: unknown;
  try { raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null"); } catch { raw = undefined; }
  return notifySettingsOf(raw);
}

/** Keeps this browser's in-tab settings. */
export function writeLocalNotify(s: NotifySettings): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch { /* storage blocked: the defaults hold */ }
}
