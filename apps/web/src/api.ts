// Data access for the dashboard: the server's HTTP API and its change notifications.
import { useEffect, useReducer, useRef, useState } from "react";
import { Action, type ActionState } from "./action.ts";
import { HttpError, onReply, request } from "./http.ts";
import { LiveView, Query, Reloads, Requests, Stream, fetchJson, fetchPositioned, type Applied, type PageMessage, type ProjectMessage, type QueryView, type Version } from "./query.ts";
import { SEQ_HEADER, readPosition } from "@nexus/protocol/live";

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
/** The page's writes waiting for their outcome to show (query.ts, Reloads); App.tsx drives it. */
export const reloads = new Reloads(requests);

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

/** The page's live stream (query.ts): App.tsx feeds it the socket's messages. */
export const stream = new Stream();
const liveViews = new Map<string, LiveView<unknown>>();

/** Where each project's last write left the live stream (its answer's header), for the control to wait on. */
const written = new Map<string, number>();
onReply((url, r) => {
  const project = /^\/api\/projects\/([^/?]+)\//.exec(url)?.[1];
  const { epoch, seq } = readPosition(r.headers.get(SEQ_HEADER));
  if (project && seq !== undefined && epoch === stream.epoch) written.set(decodeURIComponent(project), seq);
});
/** Where the project's last write left the stream (undefined: none known). */
export const writtenAt = (project: string): number | undefined => written.get(project);

/**
 * A live read (query.ts, LiveView): read in full once, then the stream's messages applied to it (`apply`), so it is not
 * asked again on a change. One view per URL, shared by every component that shows it.
 */
export function useLiveRead<T>(url: string | undefined, project: string | undefined, apply: (held: T, m: ProjectMessage) => Applied<T>): QueryView<T> {
  const [, render] = useReducer((n: number) => n + 1, 0);
  let view: LiveView<T> | undefined;
  if (url && project) {
    view = liveViews.get(url) as LiveView<T> | undefined;
    if (!view) liveViews.set(url, (view = new LiveView<T>({ url, project, stream, fetcher: fetchPositioned, apply }) as LiveView<T>) as LiveView<unknown>);
  }
  useEffect(() => {
    if (!view || !url) return;
    // Registered again: a remount's cleanup of the same view may have let it go before this effect ran.
    if (!liveViews.has(url)) liveViews.set(url, view as LiveView<unknown>);
    const off = view.subscribe(render);
    // Only this view is let go: another one may hold the URL by now.
    return () => { off(); if (!view.active && liveViews.get(url) === view) liveViews.delete(url); };
  }, [view, url]);
  return view ? view.view() : { data: undefined, error: undefined };
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

export const fileUrl = (project: string, path: string) => projectUrl(project, `/file?path=${enc(path)}`);

type Listener = (msg: PageMessage) => void;

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
