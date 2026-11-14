// Where the user is in each chat (decided 2026-11-14; docs/ideas/side-panels-and-waiting-list.md): every chat, the
// orchestrator's and each conversation, opens where the user left it; messages that came meanwhile do not move the
// view, a "N new" button jumps to them; a chat opened for the first time opens at its newest message. Kept per chat
// in the browser's localStorage (decided 2026-11-14, queue FU: it outlasts a reload and a closed tab), keyed by project
// and chat; another tab's change is heard too. The same state gives the unread markers on the chat switch
// ("Orchestrator (2)", "Ideas •").
//
// The pure part (what to open at, what is unread, what was seen) has no DOM in it and is unit tested; the store below
// it is a thin wrapper around localStorage with listeners, so the markers follow.
import { useSyncExternalStore } from "react";

/** A chat's place: the entry at the top of the view (its index in the whole chat) and how far it was scrolled past it. */
export interface Place {
  /** The index, in the whole chat (tool lines included), of the entry at the top of the view. */
  anchor: number;
  /** Pixels between the view's top and that entry's top (negative: the entry starts above the view). */
  offset: number;
  /** The view was at the chat's end: while the chat is open, new messages keep it there. */
  end: boolean;
  /** The time of the latest entry the user has had in view: what came after it is unread. */
  seen?: string;
}

/** What the helpers read of a chat entry. */
export interface EntryLike { at: string; from: string; kind?: string }

/** The key of a chat's place: the project and the chat ("orchestrator", or "conversation" and its id). */
export const placeKey = (project: string, ...chat: string[]) => [project, ...chat].map(encodeURIComponent).join("/");

/** An entry the user did not write and that is a message (not a tool line): what "new" and "unread" count. */
const fromOthers = (e: EntryLike) => e.from !== "user" && e.kind !== "tool";

const after = (at: string, seen: string) => Date.parse(at) > Date.parse(seen);

/**
 * How many messages came after the time seen. A chat never seen in this browser has no count: the first time it opens
 * at its newest message, so nothing in it is unread.
 */
export function unreadCount(chat: readonly EntryLike[], seen: string | undefined): number {
  if (!seen) return 0;
  return chat.filter((e) => fromOthers(e) && after(e.at, seen)).length;
}

/** The index of the first unread message, where "N new" jumps; undefined when nothing is unread. */
export function firstUnread(chat: readonly EntryLike[], seen: string | undefined): number | undefined {
  if (!seen) return undefined;
  const i = chat.findIndex((e) => fromOthers(e) && after(e.at, seen));
  return i < 0 ? undefined : i;
}

/** A conversation in a list (its last entry's time) has something unread: it was seen before, and has moved on since. */
export const hasUnread = (lastAt: string | undefined, seen: string | undefined) => !!lastAt && !!seen && after(lastAt, seen);

/**
 * The time seen once the entries up to `lastVisible` (an index in the whole chat) have been in view: the latest of
 * theirs and what was seen before. It never goes back.
 */
export function seenUpTo(chat: readonly EntryLike[], lastVisible: number, before: string | undefined): string | undefined {
  let seen = before;
  for (let i = 0; i <= Math.min(lastVisible, chat.length - 1); i++) {
    const at = chat[i]!.at;
    if (!seen || after(at, seen)) seen = at;
  }
  return seen;
}

/**
 * Where a chat opens once it has loaded: at its end the first time (no place) or when its place is gone (the chat
 * was started over and is shorter now); else at its place, whatever came after it.
 */
export function opening(place: Place | undefined, length: number): { at: "end" } | { at: "place"; anchor: number; offset: number } {
  if (!place || place.anchor >= length) return { at: "end" };
  return { at: "place", anchor: place.anchor, offset: place.offset };
}

/** Parses a stored place; anything malformed is no place. */
export function parsePlace(raw: string | null): Place | undefined {
  if (!raw) return undefined;
  try {
    const p = JSON.parse(raw) as Partial<Place>;
    if (typeof p.anchor !== "number" || typeof p.offset !== "number" || typeof p.end !== "boolean") return undefined;
    return { anchor: p.anchor, offset: p.offset, end: p.end, ...(typeof p.seen === "string" ? { seen: p.seen } : {}) };
  } catch { return undefined; }
}

// ---------------------------------------------------------------- localStorage

const PREFIX = "nexus.place:";
const listeners = new Set<() => void>();
/** Bumped when a time seen changes, so the markers re-read. */
let version = 0;

export function readPlace(key: string): Place | undefined {
  try { return parsePlace(localStorage.getItem(PREFIX + key)); } catch { return undefined; }
}

/** Stores a place; listeners hear of it when its time seen changed (the anchor alone moves on every scroll). */
export function writePlace(key: string, place: Place): void {
  const before = readPlace(key);
  try { localStorage.setItem(PREFIX + key, JSON.stringify(place)); } catch { /* storage blocked: the place lives as long as the view */ }
  if (before?.seen !== place.seen) { version++; for (const l of listeners) l(); }
}

/** Re-renders when any chat's time seen changes; read the places with readPlace inside. */
export function usePlaces(): number {
  return useSyncExternalStore(subscribe, () => version);
}

/** Listens for changes here and, through the storage event, for another tab's change of a place. */
function subscribe(l: () => void): () => void {
  listeners.add(l);
  if (listeners.size === 1 && typeof window !== "undefined") window.addEventListener("storage", fromOtherTab);
  return () => { listeners.delete(l); if (!listeners.size && typeof window !== "undefined") window.removeEventListener("storage", fromOtherTab); };
}

function fromOtherTab(e: StorageEvent): void {
  if (e.key !== null && !e.key.startsWith(PREFIX)) return;
  version++;
  for (const l of listeners) l();
}
