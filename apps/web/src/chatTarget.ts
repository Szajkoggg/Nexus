// The chat message a search hit goes to (queue SR): kept here until the chat that holds it has loaded, which then
// scrolls to it (CH4's jump, components/Chat.tsx) and takes it. Set by a click in the search's results, or by a link's
// query at load (hash.ts, chatHref: ?chat=<session>&line=<n> or ?conversation=<id>&line=<n>).
import { useSyncExternalStore } from "react";
import { chatOf, parseHash } from "./hash.ts";
import { placeKey } from "./chatPlace.ts";

/**
 * Where to go: the chat's place key (chatPlace.ts: the orchestrator's, or a conversation's), the session whose
 * chat.jsonl holds the entry (the orchestrator's current one or one it went on from), the entry's line, and whether it
 * is a tool line (the chat shows its tool calls then).
 */
export interface ChatTarget { place: string; session: string; line: number; tool?: boolean }

let target: ChatTarget | undefined;
let started = false;
const listeners = new Set<() => void>();
const emit = () => { for (const l of listeners) l(); };

/** The target a link's query names, read once at the first use. */
function start(): void {
  if (started || typeof location === "undefined") return;
  started = true;
  const c = chatOf(location.search);
  const project = parseHash(location.hash).project;
  if (c && project) target = { place: c.conversation ? placeKey(project, "conversation", c.session) : placeKey(project, "orchestrator"), session: c.session, line: c.line };
}

export function setChatTarget(t: ChatTarget): void { start(); target = t; emit(); }
/** The chat that went to the target (or found it gone) takes it, so it is gone to once. */
export function clearChatTarget(): void { if (target) { target = undefined; emit(); } }

/** The target now; re-renders when it changes. */
export function useChatTarget(): ChatTarget | undefined {
  start();
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => target);
}
