// Keyed reads for the dashboard, free of React so that they can be tested: an answer belongs to the URL it was asked
// for (a new URL shows nothing of the old one's, and a late answer for the old one is dropped), a failure is kept as
// the query's error instead of being swallowed, a request in flight is shared by every query asking the same, and the
// live notifications bump only the versions they concern (a change in one project refetches nothing of another's).
import { HttpError, request } from "./http.ts";

/** What a query is asked at: the same URL at a new version is asked again. */
export type Version = string | number | undefined;

/** What a query shows: only the answer to the URL it is asked now. */
export interface QueryView<T> { data: T | undefined; error: string | undefined }

export type Fetcher = (url: string) => Promise<unknown>;

/** A GET of a JSON reply; a refusal rejects with its status and the server's reason ("404 unknown project"). */
export const fetchJson = (url: string): Promise<unknown> => request(url).catch((e: unknown) => {
  throw e instanceof HttpError ? new Error(`${e.status} ${e.message}`) : e;
});

/** The requests in flight, one per URL and version: every query asking for the same answer waits on one request. */
export class Requests {
  private readonly inflight = new Map<string, { url: string; p: Promise<unknown> }>();
  private readonly fetcher: Fetcher;
  constructor(fetcher: Fetcher) { this.fetcher = fetcher; }

  get(url: string, version: Version): Promise<unknown> {
    // An encoded URL holds no space.
    const id = `${String(version)} ${url}`;
    let r = this.inflight.get(id);
    if (!r) {
      r = { url, p: this.fetcher(url).finally(() => this.inflight.delete(id)) };
      this.inflight.set(id, r);
    }
    return r.p;
  }

  /**
   * Resolves once every request in flight now (of these URLs; none given: of any) has settled, after the queries
   * waiting on them have taken their answers (their handlers were attached first, so they run first). Never rejects.
   */
  settled(urls: readonly string[] = []): Promise<void> {
    const of = [...this.inflight.values()].filter((r) => !urls.length || urls.includes(r.url));
    return Promise.allSettled(of.map((r) => r.p)).then(() => undefined);
  }
}

/**
 * The user's writes waiting for the page to show their outcome. A control that wrote stays "in progress" until the
 * reads asked after its write have landed; were it to stop at the write's answer, it would show the state from before
 * the write (and could be clicked again) until those reads land, and would seem to jump back.
 *
 * `next(urls)` is taken when the write is done, before the page's versions move: the URLs of the reads the control
 * shows (none: every read). `asked()` is called once the page has asked its reads at the new versions (after App's
 * effects, which run after every child's). The waits then resolve when those reads have settled, or after `limit` ms
 * at most (a read that hangs does not hold a control for ever). A control waits only for what it shows, not for a slow
 * read of something else.
 */
export class Reloads {
  private waiting: { urls: readonly string[]; done: () => void }[] = [];
  private readonly requests: Requests;
  private readonly limit: number;
  constructor(requests: Requests, limit = 10_000) { this.requests = requests; this.limit = limit; }

  next(urls: readonly string[] = []): Promise<void> {
    return new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined = undefined;
      const done = () => { clearTimeout(timer); resolve(); };
      timer = setTimeout(done, this.limit);
      this.waiting.push({ urls, done });
    });
  }

  asked(): void {
    for (const w of this.waiting.splice(0)) void this.requests.settled(w.urls).then(w.done);
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
export interface LiveMessage { type: string; project?: string; session?: string }

/**
 * What the live notifications have changed so far. `all` counts every message but a log's: what spans projects (the
 * digest, the usage, the server's state) is read at it. `list` counts what changes the project list and its counts.
 * `project` counts each project's own changes; a reconnect may have missed any, so it bumps `epoch`, part of every
 * project's version. `logs` counts each project's `log` messages: a line of an agent's activity, a chat or a refusal,
 * which changes no state (docs/design/model.md); only the views of those logs read at it.
 */
export interface Versions { all: number; list: number; epoch: number; project: Readonly<Record<string, number>>; logs: Readonly<Record<string, number>> }

export const noVersions: Versions = { all: 0, list: 0, epoch: 0, project: {}, logs: {} };

export function bump(v: Versions, m: LiveMessage): Versions {
  const all = v.all + 1;
  if (m.type === "reconnected") return { all, list: v.list + 1, epoch: v.epoch + 1, project: v.project, logs: v.logs };
  if (m.type === "projects") return { ...v, all, list: v.list + 1 };
  if (m.type === "log" && m.project) return { ...v, logs: { ...v.logs, [m.project]: (v.logs[m.project] ?? 0) + 1 } };
  if (m.type === "changed" && m.project) {
    return { ...v, all, list: v.list + 1, project: { ...v.project, [m.project]: (v.project[m.project] ?? 0) + 1 } };
  }
  return { ...v, all };
}

/** The version a project's own reads are asked at: it moves only with that project's changes (and a reconnect). */
export const projectVersion = (v: Versions, id: string | undefined): string => `${v.epoch}.${id ? v.project[id] ?? 0 : 0}`;
/** The version a project's logs (activity, chats, refusals) are asked at: its own version, and its log messages'. */
export const logsVersion = (v: Versions, id: string | undefined): string => `${projectVersion(v, id)}.${id ? v.logs[id] ?? 0 : 0}`;
