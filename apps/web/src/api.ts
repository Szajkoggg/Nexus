// Data access for the dashboard: the server's HTTP API and its change notifications.
import { useEffect, useReducer, useRef, useState } from "react";
import type { AttentionItem } from "@nexus/protocol";
import { Query, Requests, fetchJson, type LiveMessage, type QueryView, type Version } from "./query.ts";

export type { QueryView, Version } from "./query.ts";
export type { AttentionItem, ProjectState, QueueView, StepView, QuestionView, SessionView } from "@nexus/protocol";

export interface ProjectSummary {
  id: string; name: string; root: string; error?: string;
  running: number; waiting: number; stopped: number; open_questions: number;
  attention: AttentionItem[];
}

/** A write to the server. Resolves when it is done; rejects with the server's reason. */
export async function act(project: string, method: "POST" | "PATCH" | "PUT" | "DELETE", path: string, body: unknown = {}): Promise<void> {
  const r = await fetch(`/api/projects/${encodeURIComponent(project)}${path}`, {
    method, headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? r.statusText);
}

export const enc = encodeURIComponent;

/** A write whose answer matters: resolves with the server's `result` (e.g. `{ message }`); rejects with its reason. */
export async function actResult<T>(project: string, method: "POST" | "PATCH" | "DELETE", path: string, body: unknown = {}): Promise<T | null> {
  const r = await fetch(`/api/projects/${encodeURIComponent(project)}${path}`, {
    method, headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const b = await r.json().catch(() => ({})) as { result?: T; error?: string };
  if (!r.ok) throw new Error(b.error ?? r.statusText);
  return b.result ?? null;
}

/** A write the server refused, with its HTTP status (the reason's text is the server's, in English). */
export class HttpError extends Error {
  readonly status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}

/** Uploads a picture for a chat message (base64, as a data: URL); resolves with the saved file's absolute path. */
export async function uploadPicture(project: string, data: string): Promise<string> {
  const r = await fetch(`/api/projects/${encodeURIComponent(project)}/uploads`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ data }),
  });
  const b = await r.json().catch(() => ({})) as { result?: { path: string }; error?: string };
  if (!r.ok || !b.result) throw new HttpError(b.error ?? r.statusText, r.status);
  return b.result.path;
}

export interface Usage { updated_at: string; windows: Record<string, { utilization: number; resets_at?: string; status?: string }> }
export interface ActivityEntry { at: string; kind: string; text: string; queue?: string; step?: string }

const requests = new Requests(fetchJson);

/**
 * A keyed read (query.ts): asked again whenever `version` changes; while a new URL's answer is on its way it shows
 * nothing, never the previous URL's. A failure is the view's `error`; the data it had for the same URL stays.
 */
export function useQuery<T>(url: string | undefined, version?: Version): QueryView<T> {
  const [, render] = useReducer((n: number) => n + 1, 0);
  const [query] = useState(() => new Query<T>(requests, render));
  useEffect(() => { query.ask(url, version); return () => query.stop(); }, [query, url, version]);
  return query.view(url);
}

/**
 * A stopped queue is one item whatever happens to its step (as the server's push notifications key it); a tag
 * proposal is one item each.
 */
export const attentionKey = (a: AttentionItem) => [a.kind, a.queue, a.lift ? undefined : a.step, a.qid, ...(a.tags ? [a.tags.id] : [])].join("/");

export const fileUrl = (project: string, path: string) =>
  `/api/projects/${encodeURIComponent(project)}/file?path=${encodeURIComponent(path)}`;

type Listener = (msg: LiveMessage) => void;

/** One WebSocket for the page, reconnecting with backoff. */
export function useLive(onMessage: Listener): boolean {
  const [connected, setConnected] = useState(false);
  const handler = useRef(onMessage);
  handler.current = onMessage;
  useEffect(() => {
    let ws: WebSocket | undefined; let timer: number | undefined; let delay = 500; let closed = false;
    const open = () => {
      ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
      ws.onopen = () => { setConnected(true); delay = 500; handler.current({ type: "reconnected" }); };
      ws.onmessage = (e) => { try { handler.current(JSON.parse(e.data as string)); } catch { /* ignore */ } };
      ws.onclose = () => {
        setConnected(false);
        if (!closed) { timer = window.setTimeout(open, delay); delay = Math.min(delay * 2, 10_000); }
      };
    };
    open();
    return () => { closed = true; clearTimeout(timer); ws?.close(); };
  }, []);
  return connected;
}
