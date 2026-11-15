// Keyed reads for the dashboard, free of React so that they can be tested: an answer belongs to the URL it was asked
// for (a new URL shows nothing of the old one's, and a late answer for the old one is dropped), a failure is kept as
// the query's error instead of being swallowed, a request in flight is shared by every query asking the same, and the
// live notifications bump only the versions they concern (a change in one project refetches nothing of another's).

/** What a query is asked at: the same URL at a new version is asked again. */
export type Version = string | number | undefined;

/** What a query shows: only the answer to the URL it is asked now. */
export interface QueryView<T> { data: T | undefined; error: string | undefined }

export type Fetcher = (url: string) => Promise<unknown>;

/** A GET of a JSON reply; a refusal rejects with its status and the server's reason. */
export async function fetchJson(url: string): Promise<unknown> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${((await r.json().catch(() => ({}))) as { error?: string }).error ?? r.statusText}`);
  return r.json();
}

/** The requests in flight, one per URL and version: every query asking for the same answer waits on one request. */
export class Requests {
  private readonly inflight = new Map<string, Promise<unknown>>();
  private readonly fetcher: Fetcher;
  constructor(fetcher: Fetcher) { this.fetcher = fetcher; }

  get(url: string, version: Version): Promise<unknown> {
    // An encoded URL holds no space.
    const id = `${String(version)} ${url}`;
    let p = this.inflight.get(id);
    if (!p) {
      p = this.fetcher(url).finally(() => this.inflight.delete(id));
      this.inflight.set(id, p);
    }
    return p;
  }
}

/**
 * One query of a component. `ask` it at each render's URL and version (the same pair asks nothing again), `stop` it when
 * the component leaves or asks something else, and read it with `view(url)`, which holds nothing for any other URL even
 * before the new answer lands. `changed` is called when an answer lands that the view shows.
 */
export class Query<T> {
  private asked: { url: string | undefined; version: Version } | undefined;
  private seq = 0;
  private held: { url: string; seq: number; data: T | undefined; error: string | undefined } | undefined;

  private readonly requests: Requests;
  private readonly changed: () => void;
  constructor(requests: Requests, changed: () => void) { this.requests = requests; this.changed = changed; }

  ask(url: string | undefined, version: Version): void {
    if (this.asked && this.asked.url === url && this.asked.version === version) return;
    this.asked = { url, version };
    if (this.held && this.held.url !== url) this.held = undefined;
    if (url === undefined) return;
    const seq = ++this.seq;
    this.requests.get(url, version).then(
      (data) => this.settle(url, seq, { data: data as T }),
      (e: unknown) => this.settle(url, seq, { error: e instanceof Error ? e.message : String(e) }),
    );
  }

  /** Nothing asked any more: answers still on their way are dropped (asking again joins the same request). */
  stop(): void { this.asked = undefined; }

  view(url: string | undefined): QueryView<T> {
    const h = this.held && this.held.url === url ? this.held : undefined;
    return { data: h?.data, error: h?.error };
  }

  /** An answer counts for the URL asked now, and only if no later one has landed; a failure keeps the data it had. */
  private settle(url: string, seq: number, outcome: { data: T } | { error: string }): void {
    if (this.asked?.url !== url || (this.held && this.held.seq > seq)) return;
    this.held = "data" in outcome
      ? { url, seq, data: outcome.data, error: undefined }
      : { url, seq, data: this.held?.data, error: outcome.error };
    this.changed();
  }
}

/** A message of the page's WebSocket (`reconnected` is the page's own, sent when the socket opens again). */
export interface LiveMessage { type: string; project?: string }

/**
 * What the live notifications have changed so far. `all` counts every message: what spans projects (the digest, the
 * usage, the server's state) is read at it. `list` counts what changes the project list and its counts. `project`
 * counts each project's own changes; a reconnect may have missed any, so it bumps `epoch`, part of every project's
 * version.
 */
export interface Versions { all: number; list: number; epoch: number; project: Readonly<Record<string, number>> }

export const noVersions: Versions = { all: 0, list: 0, epoch: 0, project: {} };

export function bump(v: Versions, m: LiveMessage): Versions {
  const all = v.all + 1;
  if (m.type === "reconnected") return { all, list: v.list + 1, epoch: v.epoch + 1, project: v.project };
  if (m.type === "projects") return { ...v, all, list: v.list + 1 };
  if (m.type === "changed" && m.project) {
    return { ...v, all, list: v.list + 1, project: { ...v.project, [m.project]: (v.project[m.project] ?? 0) + 1 } };
  }
  return { ...v, all };
}

/** The version a project's own reads are asked at: it moves only with that project's changes (and a reconnect). */
export const projectVersion = (v: Versions, id: string | undefined): string => `${v.epoch}.${id ? v.project[id] ?? 0 : 0}`;
