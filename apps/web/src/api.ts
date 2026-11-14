// Data access for the dashboard: the server's HTTP API and its change notifications.
import { useCallback, useEffect, useRef, useState } from "react";
import type { AttentionItem, ProjectState } from "@nexus/protocol";

export type { AttentionItem, ProjectState, QueueView, StepView, QuestionView, SessionView } from "@nexus/protocol";

export interface ProjectSummary {
  id: string; name: string; root: string; error?: string;
  running: number; waiting: number; stopped: number; open_questions: number;
  attention: AttentionItem[];
}

/** A write to the server. Resolves when it is done; rejects with the server's reason. */
export async function act(project: string, method: "POST" | "PATCH" | "DELETE", path: string, body: unknown = {}): Promise<void> {
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

/** Re-fetches whenever `version` changes (the page bumps it on every live change of the project). */
export function useFetch<T>(url: string | undefined, version: unknown): T | undefined {
  const [data, setData] = useState<T>();
  useEffect(() => {
    if (!url) { setData(undefined); return; }
    let alive = true;
    fetch(url).then((r) => (r.ok ? r.json() : undefined)).then((d) => { if (alive) setData(d as T); }, () => {});
    return () => { alive = false; };
  }, [url, version]);
  return data;
}
/** A stopped queue is one item whatever happens to its step (as the server's push notifications key it). */
export const attentionKey = (a: AttentionItem) => [a.kind, a.queue, a.lift ? undefined : a.step, a.qid].join("/");

export const fileUrl = (project: string, path: string) =>
  `/api/projects/${encodeURIComponent(project)}/file?path=${encodeURIComponent(path)}`;

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${(await r.json().catch(() => ({}))).error ?? r.statusText}`);
  return r.json() as Promise<T>;
}

type Listener = (msg: { type: string; project?: string }) => void;

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

export function useProjects() {
  const [projects, setProjects] = useState<ProjectSummary[]>();
  const [error, setError] = useState<string>();
  const reload = useCallback(() => {
    getJson<ProjectSummary[]>("/api/projects").then((p) => { setProjects(p); setError(undefined); }, (e: Error) => setError(e.message));
  }, []);
  useEffect(reload, [reload]);
  return { projects, error, reload };
}

export function useProjectState(id: string | undefined) {
  const [state, setState] = useState<ProjectState>();
  const [error, setError] = useState<string>();
  const reload = useCallback(() => {
    if (!id) return;
    getJson<ProjectState>(`/api/projects/${encodeURIComponent(id)}/state`)
      .then((s) => { setState(s); setError(undefined); }, (e: Error) => setError(e.message));
  }, [id]);
  useEffect(() => { setState(undefined); reload(); }, [reload]);
  return { state, error, reload };
}
