// How each live view applies the stream's messages to the reply it holds (queue SD; docs/design/live.md, "The views"):
// the project's state, a step's activity, the refusals, the orchestrator's chat, a conversation and the conversation
// list. Each returns the new reply, undefined when the message does not concern it, or "reload" for a full read. Free
// of React, so that the tests apply them as the page does.
import type { ProjectState } from "@nexus/protocol";
import { applyState, byConversationOrder } from "@nexus/protocol/live";
import type { Applied, ProjectMessage } from "./query.ts";

/** The project's state: a state message's delta (a summary alone changes nothing of it). */
export function applyStateMessage(held: ProjectState, m: ProjectMessage): Applied<ProjectState> {
  if (m.type !== "state") return undefined;
  if (m.reload) return "reload";
  if (!m.set && !m.upsert && !m.remove && !m.order) return undefined;
  return applyState(held, m) ?? "reload";
}

interface Placed { queue?: string; step?: string }
const placed = (where: Placed) => (e: Placed) => (!where.queue || e.queue === where.queue) && (!where.step || e.step === where.step);

/** A session's activity, of one step (`where`): its new lines appended, its newest `limit` kept (the route's 300). */
export function activityApplier<T extends Placed>(session: string, where: Placed, limit = 300) {
  return (held: T[], m: ProjectMessage): Applied<T[]> => {
    if (m.type !== "log" || m.log !== "activity" || m.session !== session) return undefined;
    if (m.reload || !m.entries) return "reload";
    const fresh = (m.entries as T[]).filter(placed(where));
    return fresh.length ? [...held, ...fresh].slice(-limit) : undefined;
  };
}

/** The refusals of every session (or of one step, `where`), oldest first. */
export function refusalsApplier<T extends Placed & { at: string }>(where: Placed) {
  return (held: T[], m: ProjectMessage): Applied<T[]> => {
    if (m.type !== "log" || m.log !== "refusals") return undefined;
    if (m.reload || !m.entries) return "reload";
    const fresh = (m.entries as T[]).filter(placed(where));
    return fresh.length ? [...held, ...fresh].sort((a, b) => a.at.localeCompare(b.at)) : undefined;
  };
}

/** A chat view (the orchestrator's or a conversation's) as the server sends it, as far as applying needs. */
interface ChatHeld { session: { id: string } | null; chat: unknown[]; pins: unknown[] }

/** A chat's new lines and pins of its session; its newest `limit` lines kept (the server's window). */
function chatLines<T extends ChatHeld>(held: T, m: ProjectMessage, limit: number): Applied<T> {
  if (m.type !== "log" || !held.session || m.session !== held.session.id) return undefined;
  if (m.log === "pins") return m.pins ? { ...held, pins: m.pins } : "reload";
  if (m.log !== "chat") return undefined;
  if (m.reload || !m.entries) return "reload";
  return { ...held, chat: [...held.chat, ...m.entries].slice(-limit) };
}

/** The orchestrator's chat: its lines and pins, and its head; another session as its head (context care): a full read. */
export function applyOrchestrator<T extends ChatHeld>(held: T, m: ProjectMessage): Applied<T> {
  if (m.type === "session") {
    if (!m.orchestrator) return undefined;
    const head = m.head as Partial<T>;
    if ((head.session?.id ?? "") !== (held.session?.id ?? "")) return "reload";
    return { ...held, ...head };
  }
  return chatLines(held, m, 300);
}

/** An open conversation: its lines and pins, and its head. */
export function applyConversation<T extends ChatHeld>(held: T, m: ProjectMessage): Applied<T> {
  if (m.type === "session") return !m.orchestrator && m.session === held.session?.id ? { ...held, ...(m.head as Partial<T>) } : undefined;
  return chatLines(held, m, 400);
}

/** The conversation list: a conversation's item replaced or added, the list sorted again. */
export function applyConversations<T extends { id: string; archived?: boolean; last_at: string }>(held: T[], m: ProjectMessage): Applied<T[]> {
  if (m.type !== "session" || !m.conversation) return undefined;
  const item = m.conversation as unknown as T;
  return [...held.filter((c) => c.id !== item.id), item].sort(byConversationOrder);
}
