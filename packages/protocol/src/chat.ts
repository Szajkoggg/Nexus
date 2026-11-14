// Searching a chat and its pins (decided 2026-11-14, queue CH4; docs/ideas/chat-improvements.md). Search covers the
// whole chat, not only what the dashboard has loaded: the server runs `searchChat` over every line of chat.jsonl and
// the dashboard highlights with `matchRanges`. A pin names a message by its line in the append-only chat.jsonl (from
// 0), so it stays right however the chat grows. Pure: the server and the dashboard both use it.
import type { ChatEntry, Pin } from "./schemas.ts";

/** A chat entry with the index of its line in chat.jsonl (from 0): what the server's chat views send. */
export type NumberedEntry = ChatEntry & { line: number };

/**
 * Text folded for matching: lower case, accents dropped ("Kérdés" matches "kerdes"), with `map[i]` the index in the
 * original text of folded character i (and one more entry, the original's length).
 */
export function fold(text: string): { folded: string; map: number[] } {
  let folded = "";
  const map: number[] = [];
  let at = 0;
  for (const ch of text) {
    const f = ch.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
    for (let k = 0; k < f.length; k++) map.push(at);
    folded += f;
    at += ch.length;
  }
  map.push(text.length);
  return { folded, map };
}

/** A query as matched: folded, its whitespace collapsed, trimmed. Empty matches nothing. */
const folded = (query: string) => fold(query.replace(/\s+/g, " ").trim()).folded;

/** Where a query occurs in a text, as [start, end) ranges of the original text, in order and not overlapping. */
export function matchRanges(text: string, query: string): [number, number][] {
  const q = folded(query);
  if (!q) return [];
  const { folded: f, map } = fold(text);
  const out: [number, number][] = [];
  for (let i = f.indexOf(q); i >= 0; i = f.indexOf(q, i + q.length)) out.push([map[i]!, map[i + q.length]!]);
  return out;
}

/**
 * The lines of a chat's entries that contain the query, oldest first. Tool lines only with `tools` (the chat shows
 * them only when asked).
 */
export function searchChat(entries: readonly NumberedEntry[], query: string, o: { tools?: boolean } = {}): number[] {
  const q = folded(query);
  if (!q) return [];
  return entries.filter((e) => (o.tools || e.kind !== "tool") && fold(e.text).folded.includes(q)).map((e) => e.line);
}

/** Pins with a message pinned (`pinned`) or unpinned: pinning twice keeps the first time; the list stays in chat order. */
export function setPin(pins: readonly Pin[], line: number, pinned: boolean, at: string): Pin[] {
  const rest = pins.filter((p) => p.line !== line);
  const kept = pins.find((p) => p.line === line);
  return (pinned ? [...rest, kept ?? { line, at }] : rest).sort((a, b) => a.line - b.line);
}

/** A message as one short line for the pins: its first words without Markdown's marks, at most `max` characters. */
export function excerpt(text: string, max = 120): string {
  const plain = text
    .replace(/```[^\n]*\n([\s\S]*?)```/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, "")
    .replace(/[*_`~]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > max ? `${plain.slice(0, max - 1).trimEnd()}…` : plain;
}
