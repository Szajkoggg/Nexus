// The chats' reads and pins (queue CH4): the orchestrator's and the conversations' chat views send each entry with its
// line in chat.jsonl (`NumberedEntry`), so the dashboard can load older entries (`chatRange`), search the whole chat
// (`searchLines`, decided: not only what is loaded) and pin a message by its line. pins.json has one writer: here.
import { ActionError, ProjectStore, searchChat, setPin, type NumberedEntry, type SessionFile } from "@nexus/protocol";
import type { ActivityItem, AgentEvents } from "./agent.ts";

/** What a chat shows where the user stopped its agent's turn (a Nexus notice; the stop button, queue CH4). */
export const STOPPED = "Stopped.";
/**
 * What a chat shows where an update's restart cut off its agent's turn, which goes on in the same session after the
 * restart (a Nexus notice, written by the next server as it goes on).
 */
export const RESTARTED = "Nexus restarted while answering; it goes on.";

/**
 * The error rows of a chat (the orchestrator's and a thinking partner's), by one rule (queue CHC, D1): a turn that ends
 * neither ok nor stopped gets one error row at its end, whose text is the turn's end's reason (the runtime's turn_end
 * activity, or, where it gave none, the failure or the error that came before); a turn that ends ok or stopped gets
 * none, whatever words its texts hold. An error of the process outside a turn (it could not start, it exited) is
 * written at once. `write` appends the row.
 */
export class TurnErrorRows {
  /** The first error activity of the open turn, held for its end. */
  private held: string | undefined;
  /** The open turn's turn_end activity. */
  private ended: string | undefined;
  private readonly write: (text: string) => void;
  constructor(write: (text: string) => void) { this.write = write; }

  /** An activity of the session's process; `inTurn`: a turn of it is open (its process is working). */
  activity(a: ActivityItem, inTurn: boolean): void {
    if (a.kind === "turn_start") { this.held = undefined; this.ended = undefined; }
    else if (a.kind === "turn_end") this.ended = a.text;
    else if (a.kind === "error") {
      if (inTurn) this.held ??= a.text;
      else this.write(a.text);
    }
  }

  /** The turn's end: one row when it failed. */
  turnEnd(end: AgentEvents["turnEnd"][0]): void {
    const reason = this.ended
      ?? (end.failure ? `turn failed (${end.failure.kind}, ${end.failure.code}): ${end.failure.text}` : this.held ?? `turn ended early: ${end.text}`);
    this.drop();
    if (!end.ok && !end.stopped) this.write(reason);
  }

  /** The turn's end where the chat writes a row of its own for it (a compaction that did not happen): none from here. */
  drop(): void { this.held = undefined; this.ended = undefined; }
}

/** Every entry of a session's chat, with its line. */
function numberedChat(store: ProjectStore, sessionId: string): NumberedEntry[] {
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
function chatSession(store: ProjectStore, sessionId: string): SessionFile {
  const s = store.hasSession(sessionId) ? store.readSession(sessionId) : undefined;
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
