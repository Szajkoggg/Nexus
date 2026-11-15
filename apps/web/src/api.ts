// Data access for the dashboard: the server's HTTP API and its change notifications.
import { useEffect, useReducer, useRef, useState } from "react";
import type { AttentionItem } from "@nexus/protocol";
import { Action, type ActionState } from "./action.ts";
import { HttpError, request } from "./http.ts";
import { Query, Requests, fetchJson, type LiveMessage, type QueryView, type Version } from "./query.ts";

export { HttpError, open, request } from "./http.ts";

export type { QueryView, Version } from "./query.ts";
export type { ProjectSummary } from "@nexus/protocol/api";
export type { AttentionItem, ProjectState, QueueView, StepView, QuestionView, SessionView } from "@nexus/protocol";

export const enc = encodeURIComponent;

/** A project's part of the API: `/api/projects/<id>` and `path`. */
export const projectUrl = (project: string, path = "") => `/api/projects/${enc(project)}${path}`;

type Write = "POST" | "PATCH" | "PUT" | "DELETE";

/** A write to the server. Resolves when it is done; rejects with the server's reason. */
export async function act(project: string, method: Write, path: string, body: unknown = {}): Promise<void> {
  await request(projectUrl(project, path), { method, body });
}

/** A write whose answer matters: resolves with the server's `result` (e.g. `{ message }`); rejects with its reason. */
export async function actResult<T>(project: string, method: Write, path: string, body: unknown = {}): Promise<T | null> {
  const b = await request<{ result?: T } | undefined>(projectUrl(project, path), { method, body });
  return b?.result ?? null;
}

/** Uploads a picture for a chat message (base64, as a data: URL); resolves with the saved file's absolute path. */
export async function uploadPicture(project: string, data: string): Promise<string> {
  const path = (await actResult<{ path: string }>(project, "POST", "/uploads", { data }))?.path;
  if (!path) throw new HttpError("the server saved no picture", 500);
  return path;
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
 * A user's action with its busy and error state (action.ts): `run(work, done)` marks it busy, clears the last error,
 * and keeps the failure's message as `error`; `done` gets a success's result. `fail` shows a failure found before
 * any request.
 */
export function useAction(): ActionState & { run: Action["run"]; fail: Action["fail"] } {
  const [state, setState] = useState<ActionState>(() => ({ busy: false, error: undefined }));
  const [action] = useState(() => new Action(setState));
  return { ...state, run: action.run, fail: action.fail };
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
