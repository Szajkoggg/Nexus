// The chats' reads and pins (queue CH4): the orchestrator's and the conversations' chat views send each entry with its
// line in chat.jsonl (`NumberedEntry`), so the dashboard can load older entries (`chatRange`), search the whole chat
// (`searchLines`, decided: not only what is loaded) and pin a message by its line. pins.json has one writer: here.
import { ActionError, ProjectStore, searchChat, setPin, type NumberedEntry, type SessionFile } from "@nexus/protocol";

/** Every entry of a session's chat, with its line. */
export function numberedChat(store: ProjectStore, sessionId: string): NumberedEntry[] {
  const r = store.readChat(sessionId);
  return r.entries.map((e, i) => ({ ...e, line: r.lines[i]! }));
}

/** A pinned message as the views send it: the pin, and the entry it names (for its excerpt, wherever it is). */
export interface PinView { line: number; at: string; entry: NumberedEntry }

/** A chat view's part: its newest `last` entries, and its pins (those whose line holds an entry). */
export function chatView(store: ProjectStore, sessionId: string, last: number): { chat: NumberedEntry[]; pins: PinView[] } {
  const all = numberedChat(store, sessionId);
  const byLine = new Map(all.map((e) => [e.line, e]));
  const pins = store.readPins(sessionId).pins.flatMap((p) => { const entry = byLine.get(p.line); return entry ? [{ ...p, entry }] : []; });
  return { chat: all.slice(-last), pins };
}

/** A session whose chat the dashboard shows: the project's orchestrator or one of its conversations. */
export function chatSession(store: ProjectStore, sessionId: string): SessionFile {
  let s: SessionFile | undefined;
  try { s = store.readSession(sessionId); } catch { s = undefined; }
  if (!s || (s.role !== "orchestrator" && s.role !== "conversation")) throw new ActionError("no such chat", 404);
  return s;
}

/** The entries with lines from `from` up to (not including) `to`: older entries the view did not send. */
export function chatRange(store: ProjectStore, sessionId: string, from: number, to: number): NumberedEntry[] {
  chatSession(store, sessionId);
  return numberedChat(store, sessionId).filter((e) => e.line >= from && e.line < to);
}

/** The lines of the whole chat that contain the query, oldest first. */
export function searchLines(store: ProjectStore, sessionId: string, query: string, tools: boolean): number[] {
  chatSession(store, sessionId);
  return searchChat(numberedChat(store, sessionId), query, { tools });
}

/** Pins or unpins a message of the chat (not a tool line); answers the pins. */
export function pin(store: ProjectStore, sessionId: string, line: unknown, pinned: unknown): { line: number; at: string }[] {
  chatSession(store, sessionId);
  if (typeof line !== "number" || !Number.isInteger(line) || line < 0) throw new ActionError("line: the message's line in the chat, a whole number");
  if (typeof pinned !== "boolean") throw new ActionError("pinned: true or false");
  const entry = numberedChat(store, sessionId).find((e) => e.line === line);
  if (pinned && (!entry || entry.kind === "tool")) throw new ActionError(`there is no message at line ${line} of the chat`);
  const pins = setPin(store.readPins(sessionId).pins, line, pinned, new Date().toISOString());
  store.writePins(sessionId, { pins });
  return pins;
}
