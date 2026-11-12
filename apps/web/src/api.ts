// Data access for the dashboard: the server's HTTP API and its change notifications.
import { useCallback, useEffect, useRef, useState } from "react";
import type { ProjectState } from "@nexus/protocol";

export type { ProjectState, QueueView, StepView, QuestionView, SessionView } from "@nexus/protocol";

export interface ProjectSummary {
  id: string; name: string; root: string; error?: string;
  running: number; waiting: number; stopped: number; open_questions: number;
}

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
