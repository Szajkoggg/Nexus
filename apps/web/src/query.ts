// Keyed reads for the dashboard, free of React so that they can be tested: an answer belongs to the URL it was asked
// for (a new URL shows nothing of the old one's, and a late answer for the old one is dropped), a failure is kept as
// the query's error instead of being swallowed, a request in flight is shared by every query asking the same, and the
// live notifications bump only the versions they concern (a change in one project refetches nothing of another's).
// The live stream's views (docs/design/live.md) hold a reply and apply the changes the server sends after it.
import { HttpError, request } from "./http.ts";
import { SEQ_HEADER, readPosition, type LiveMessage } from "@nexus/protocol/live";

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
export type PageMessage = LiveMessage | { type: "reconnected" };
/** A message about one project: it carries the project's sequence number. */
export type ProjectMessage = Extract<LiveMessage, { project: string }>;
type StateMessage = Extract<LiveMessage, { type: "state" }>;

/**
 * What the live messages have changed so far, for the reads that are asked again in full (the others apply the
 * messages: `LiveView`). `all` (what spans projects: the digest, the usage, the server's state) moves with `server`,
 * `projects` and a project's change of its queues, questions or attention; `list` with the project list (`projects`).
 * A reconnect may have missed anything: it bumps `epoch`, part of every project's version. Per project: `project`
 * moves with every change of its state, `queues` with a change of a queue (or its metrics), `settings` with its
 * settings, `queue` per queue, and `reloads` with a change too large to name its queues (or a gap).
 */
export interface Versions {
  all: number; list: number; epoch: number;
  project: Readonly<Record<string, number>>; queues: Readonly<Record<string, number>>; settings: Readonly<Record<string, number>>;
  queue: Readonly<Record<string, number>>; reloads: Readonly<Record<string, number>>;
}

export const noVersions: Versions = { all: 0, list: 0, epoch: 0, project: {}, queues: {}, settings: {}, queue: {}, reloads: {} };

const plus = (r: Readonly<Record<string, number>>, k: string): Record<string, number> => ({ ...r, [k]: (r[k] ?? 0) + 1 });

/** Whether a state message changed this list (an upsert, a removal or a new order of it). */
const names = (m: StateMessage, part: "queues" | "questions") => !!(m.upsert?.[part] ?? m.remove?.[part] ?? m.order?.[part]);

export function bump(v: Versions, m: PageMessage): Versions {
  if (m.type === "reconnected") return { ...v, all: v.all + 1, list: v.list + 1, epoch: v.epoch + 1 };
  if (m.type === "projects") return { ...v, all: v.all + 1, list: v.list + 1 };
  if (m.type === "server") return { ...v, all: v.all + 1 };
  if (m.type !== "state") return v;
  const p = m.project;
  const out: Versions = { ...v, project: plus(v.project, p) };
  if (m.reload) return { ...out, all: v.all + 1, queues: plus(v.queues, p), settings: plus(v.settings, p), reloads: plus(v.reloads, p) };
  const queues = names(m, "queues") || !!m.set?.metrics;
  if (queues) {
    out.queues = plus(v.queues, p);
    let q = v.queue;
    for (const x of [...(m.upsert?.queues ?? []).map((x) => x.id), ...(m.remove?.queues ?? [])]) q = plus(q, `${p}/${x}`);
    out.queue = q;
  }
  if (queues || names(m, "questions") || m.set?.attention) out.all = v.all + 1;
  if (m.set?.project) out.settings = plus(v.settings, p);
  return out;
}

/** Every read of the project asked again in full, as a reload message moves them (a gap, or the user's own write). */
export const bumpProject = (v: Versions, project: string): Versions => bump(v, { type: "state", project, seq: 0, reload: true });

/** The version a project's own reads are asked at: it moves with every change of its state (and a reconnect). */
export const projectVersion = (v: Versions, id: string | undefined): string => `${v.epoch}.${id ? v.project[id] ?? 0 : 0}`;
/** The version of the reads that change only with the project's queues (estimates, metrics). */
export const queuesVersion = (v: Versions, id: string | undefined): string => `${v.epoch}.${id ? v.queues[id] ?? 0 : 0}`;
/** The version of the project's settings. */
export const settingsVersion = (v: Versions, id: string | undefined): string => `${v.epoch}.${id ? v.settings[id] ?? 0 : 0}`;
/** The version of one queue's reads (its branch, a step's commits): only its own changes move it. */
export const queueVersion = (v: Versions, id: string | undefined, queue: string): string =>
  `${v.epoch}.${id ? `${v.reloads[id] ?? 0}.${v.queue[`${id}/${queue}`] ?? 0}` : 0}`;

// ---------------------------------------------------------------- the live stream

/** A reply that names where the project's stream stood when it was read (the `Nexus-Seq` header). */
export interface Positioned { body: unknown; epoch: string | undefined; seq: number | undefined }
export type LiveFetcher = (url: string) => Promise<Positioned>;

/** A GET of a JSON reply with where it stands; a refusal rejects as `fetchJson` does. */
export const fetchPositioned: LiveFetcher = async (url) => {
  const r = await fetch(url);
  const body = await r.json().catch(() => undefined) as unknown;
  if (!r.ok) throw new Error(`${r.status} ${(body as { error?: string } | undefined)?.error ?? r.statusText}`);
  return { body, ...readPosition(r.headers.get(SEQ_HEADER)) };
};

/** What applying a message to a held answer gives: the new answer, nothing (it does not concern it), or a full read. */
export type Applied<T> = T | undefined | "reload";

/** A view the stream feeds: told of each message about its project, and to read in full. */
interface Fed { project: string; message(m: ProjectMessage): void; reload(): void }

/** How many of a project's latest messages the page keeps for a read in flight to take after it lands. */
const KEPT = 2000;

/**
 * The page's stream (docs/protocol/live.md, "The dashboard's rules"): each project's last sequence number, its latest
 * messages, and the views it feeds. A message that is not the next one is a gap: every view of the project reads in
 * full (`gap` tells the page, for its versions). A new hello (the socket opened, perhaps on a new server) makes every
 * view read in full.
 */
export class Stream {
  epoch: string | undefined;
  private readonly at = new Map<string, number>();
  private readonly hello = new Map<string, number>();
  private readonly kept = new Map<string, ProjectMessage[]>();
  private readonly views = new Set<Fed>();
  private readonly waits: { project: string; seq: number; done: () => void }[] = [];
  /** Told of a gap in a project's stream. */
  gap: (project: string) => void = () => {};

  receive(m: PageMessage): void {
    if (m.type === "hello") {
      this.epoch = m.epoch;
      this.at.clear(); this.kept.clear(); this.hello.clear();
      for (const [p, seq] of Object.entries(m.projects)) { this.at.set(p, seq); this.hello.set(p, seq); }
      for (const v of [...this.views]) v.reload();
      this.settle();
      return;
    }
    if (!("project" in m)) return;
    const last = this.at.get(m.project);
    this.at.set(m.project, m.seq);
    if (last !== undefined && m.seq !== last + 1) {
      this.kept.delete(m.project);
      this.gap(m.project);
      for (const v of [...this.views]) if (v.project === m.project) v.reload();
    } else {
      const k = this.kept.get(m.project) ?? [];
      k.push(m);
      if (k.length > KEPT) k.splice(0, k.length - KEPT);
      this.kept.set(m.project, k);
      for (const v of [...this.views]) if (v.project === m.project) v.message(m);
    }
    this.settle();
  }

  /** Where the project's stream stands on this page. */
  position(project: string): number | undefined { return this.at.get(project); }

  /**
   * The messages after `seq` for a reply read at it, or undefined when the reply cannot be fed: from another server
   * process, from before this socket listened (below the hello's number), or older than what the page still keeps.
   */
  since(project: string, epoch: string | undefined, seq: number | undefined): ProjectMessage[] | undefined {
    if (!this.epoch || epoch !== this.epoch || seq === undefined || seq < (this.hello.get(project) ?? 0)) return undefined;
    const at = this.at.get(project) ?? 0;
    if (seq > at) return undefined;
    const k = (this.kept.get(project) ?? []).filter((m) => m.seq > seq);
    return k.length === at - seq ? k : undefined;
  }

  add(v: Fed): void { this.views.add(v); }
  remove(v: Fed): void { this.views.delete(v); }

  /** Resolves once the page stands at `seq` of the project or beyond (a write's outcome), or after `limit` ms. */
  reached(project: string, seq: number | undefined, limit = 10_000): Promise<void> {
    if (seq === undefined || (this.at.get(project) ?? -1) >= seq) return Promise.resolve();
    return new Promise((resolve) => {
      const w = { project, seq, done: () => { clearTimeout(timer); resolve(); } };
      const timer = setTimeout(() => { this.waits.splice(this.waits.indexOf(w), 1); resolve(); }, limit);
      this.waits.push(w);
    });
  }

  private settle(): void {
    for (const w of [...this.waits]) if ((this.at.get(w.project) ?? -1) >= w.seq) { this.waits.splice(this.waits.indexOf(w), 1); w.done(); }
  }
}

/**
 * One reply held and fed by the stream: read in full when it starts, on a gap, a reload message or a new hello; then
 * every message after where the reply stood is applied to it. While a read is on its way the held answer stays shown;
 * a reply that cannot be fed (`Stream.since`) is shown as it is, and read again at the stream's next hello.
 */
export class LiveView<T> implements Fed {
  readonly project: string;
  private readonly url: string;
  private readonly stream: Stream;
  private readonly fetcher: LiveFetcher;
  private readonly apply: (held: T, m: ProjectMessage) => Applied<T>;
  private readonly listeners = new Set<() => void>();
  private data: T | undefined;
  private error: string | undefined;
  /** Where the held answer stands; undefined while it is not fed (a read on its way, or one that could not be). */
  private seq: number | undefined;
  private reads = 0;
  /** How many full reads it made. */
  loads = 0;

  constructor(o: { url: string; project: string; stream: Stream; fetcher: LiveFetcher; apply: (held: T, m: ProjectMessage) => Applied<T> }) {
    this.url = o.url; this.project = o.project; this.stream = o.stream; this.fetcher = o.fetcher; this.apply = o.apply;
  }

  view(): QueryView<T> { return { data: this.data, error: this.error }; }

  /** Starts it (the first subscriber) and returns the unsubscribing. */
  subscribe(changed: () => void): () => void {
    this.listeners.add(changed);
    if (this.listeners.size === 1) { this.stream.add(this); this.reload(); }
    return () => {
      this.listeners.delete(changed);
      if (!this.listeners.size) { this.stream.remove(this); this.reads++; this.seq = undefined; }
    };
  }

  private changed(): void { for (const l of [...this.listeners]) l(); }

  /** Whether anything shows it. */
  get active(): boolean { return this.listeners.size > 0; }

  reload(): void {
    const n = ++this.reads;
    this.seq = undefined;
    this.loads++;
    this.fetcher(this.url).then(async (r) => {
      if (n !== this.reads) return;
      // The reply may land before the socket brings the messages up to where it stands: those are waited for.
      if (r.epoch && r.epoch === this.stream.epoch && r.seq !== undefined && r.seq > (this.stream.position(this.project) ?? -1)) {
        await this.stream.reached(this.project, r.seq);
        if (n !== this.reads) return;
      }
      let data = r.body as T;
      const after = this.stream.since(this.project, r.epoch, r.seq);
      if (after) {
        for (const m of after) {
          const a = this.apply(data, m);
          if (a === "reload") { this.reload(); return; }
          if (a !== undefined) data = a;
        }
        this.seq = this.stream.position(this.project);
      }
      this.data = data; this.error = undefined;
      this.changed();
    }, (e: unknown) => {
      if (n !== this.reads) return;
      this.error = e instanceof Error ? e.message : String(e);
      this.changed();
    });
  }

  message(m: ProjectMessage): void {
    if (this.seq === undefined || this.data === undefined || m.seq <= this.seq) return;
    this.seq = m.seq;
    const a = this.apply(this.data, m);
    if (a === "reload") { this.reload(); return; }
    if (a === undefined) return;
    this.data = a;
    this.changed();
  }
}
