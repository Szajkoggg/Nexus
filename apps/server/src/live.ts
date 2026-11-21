// The live stream (queue SD; docs/design/live.md, docs/protocol/live.md): what the server publishes to the dashboards,
// numbered per project. The state's delta against the state last published (its parts' texts, kept here), the lines
// appended to the logs a view holds, and the chat agents' heads. The full reads of the state are answered from the
// same texts. Free of the HTTP and socket code: main.ts gives it its sources and the sending.
import { randomBytes } from "node:crypto";
import type { ProjectState } from "@nexus/protocol";
import type { ProjectSummary } from "@nexus/protocol/api";
import { deltaJson, stateJson, stateTexts, type LogKind, type StateTexts } from "@nexus/protocol/live";

/** A log's read as the store gives it: its entries, and each one's line in the file. */
export interface LogRead { entries: readonly unknown[]; lines: readonly number[] }

/** Where the stream's content comes from (main.ts: the project's model, its orchestrator and conversations). */
export interface LiveSources {
  state(id: string): ProjectState | undefined;
  summary(id: string, state: ProjectState | undefined): ProjectSummary;
  /** A session's log (activity, chat, refusals), or for `pins` the chat view's pins. */
  log(id: string, session: string, kind: Exclude<LogKind, "pins">): LogRead;
  pins(id: string, session: string): unknown[];
  /** The heads of the chat agents among `sessions` (and the orchestrator's current one), each with its item if a conversation. */
  heads(id: string, sessions: ReadonlySet<string>): { session: string; orchestrator?: boolean; head: unknown; conversation?: unknown }[];
}

/**
 * A state delta goes as a reload only when it is larger than half the state and than this: on a small project one
 * queue's view is half the state, and a full read would gain nothing.
 */
const RELOAD_FLOOR = 64 * 1024;
/** A log message larger than this goes as a reload of that log (docs/design/live.md, "Logs"). */
const LOG_LIMIT = 256 * 1024;

interface Baseline { count: number; line: number }
interface Project {
  seq: number;
  /** The state last published (the same object: nothing changed) and its texts. */
  state?: ProjectState;
  texts?: StateTexts;
  summary?: string;
  /** Per `<session> <log>`: how far the views hold it (a reply read it, or a message sent it). */
  logs: Map<string, Baseline>;
  /** The logs changed since the last publication. */
  pending: Set<string>;
  heads: Map<string, string>;
}

export class LiveStream {
  /** This process's epoch: a new one for every server process. */
  readonly epoch = randomBytes(6).toString("hex");
  private readonly projects = new Map<string, Project>();
  private readonly send: (json: string) => void;
  private readonly listening: () => boolean;
  private readonly src: LiveSources;

  constructor(o: { send: (json: string) => void; listening: () => boolean; sources: LiveSources }) {
    this.send = o.send; this.listening = o.listening; this.src = o.sources;
  }

  private of(id: string): Project {
    let p = this.projects.get(id);
    if (!p) this.projects.set(id, (p = { seq: 0, logs: new Map(), pending: new Set(), heads: new Map() }));
    return p;
  }

  /** The project's sequence number now: where a reply read now stands. */
  seq(id: string): number { return this.of(id).seq; }

  /** The `Nexus-Seq` header's value for a reply of the project now. */
  position(id: string): string { return `${this.epoch} ${this.seq(id)}`; }

  /** The socket's first message: the epoch and every project's sequence number. */
  hello(ids: readonly string[]): string {
    return JSON.stringify({ type: "hello", epoch: this.epoch, projects: Object.fromEntries(ids.map((id) => [id, this.seq(id)])) });
  }

  /** A project taken off the server: its stream is forgotten (a project added again starts from a full read). */
  forget(id: string): void { this.projects.delete(id); }

  /** One message about the project, the next in its sequence: `fields` the message's own JSON fields, without braces. */
  private message(id: string, type: string, fields: string): void {
    const p = this.of(id);
    p.seq++;
    this.send(`{"type":"${type}","project":${JSON.stringify(id)},"seq":${p.seq}${fields ? `,${fields}` : ""}}`);
  }

  /** A line of a session's log was reported: it goes out at the next publication. */
  logChanged(id: string, session: string, kind: LogKind): void { this.of(id).pending.add(`${session} ${kind}`); }

  /** A reply read this log now: the views hold it up to here, and later lines go out as messages. */
  opened(id: string, session: string, kind: Exclude<LogKind, "pins">, read?: LogRead): void {
    const r = read ?? this.src.log(id, session, kind);
    this.of(id).logs.set(`${session} ${kind}`, { count: r.entries.length, line: r.lines.at(-1) ?? -1 });
  }

  /**
   * Sends what changed in the project since the last publication: the state's delta (with the project list's line),
   * the logs' new lines, the chat agents' heads. With no socket open nothing is published and the texts are dropped.
   */
  publish(id: string): void {
    const p = this.of(id);
    if (!this.listening()) { p.state = undefined; p.texts = undefined; p.summary = undefined; p.heads.clear(); p.pending.clear(); p.logs.clear(); return; }
    const touched = new Set<string>();
    this.publishState(id, p, touched);
    for (const key of [...p.pending]) {
      p.pending.delete(key);
      const [session, kind] = key.split(" ") as [string, LogKind];
      if (kind === "chat" || kind === "pins") touched.add(session);
      this.publishLog(id, p, session, kind);
    }
    for (const h of this.src.heads(id, touched)) {
      const text = JSON.stringify([h.head, h.conversation]);
      if (p.heads.get(h.session) === text) continue;
      p.heads.set(h.session, text);
      this.message(id, "session", `"session":${JSON.stringify(h.session)}${h.orchestrator ? `,"orchestrator":true` : ""},"head":${JSON.stringify(h.head)}${h.conversation ? `,"conversation":${JSON.stringify(h.conversation)}` : ""}`);
    }
  }

  private publishState(id: string, p: Project, touched: Set<string>): void {
    const s = this.src.state(id);
    if (s && s === p.state) return;
    const texts = s && stateTexts(s);
    const summary = JSON.stringify(this.src.summary(id, s));
    const prev = p.texts;
    p.state = s; p.texts = texts;
    const summaryChanged = summary !== p.summary;
    p.summary = summary;
    if (!texts || !prev) {
      // Nothing to diff against (the first publication, a state that failed or repeats a key): the views read in full.
      if (prev || texts) this.message(id, "state", `"reload":true${summaryChanged ? `,"summary":${summary}` : ""}`);
      return;
    }
    const d = deltaJson(prev, texts);
    if (!d) { if (summaryChanged) this.message(id, "state", `"summary":${summary}`); return; }
    for (const sid of d.touched.sessions) touched.add(sid);
    const delta = d.json.length > Math.max(texts.size / 2, RELOAD_FLOOR) ? `"reload":true` : d.json;
    this.message(id, "state", `${delta}${summaryChanged ? `,"summary":${summary}` : ""}`);
  }

  private publishLog(id: string, p: Project, session: string, kind: LogKind): void {
    if (kind === "pins") {
      if (!p.logs.has(`${session} chat`)) return;
      this.message(id, "log", `"session":${JSON.stringify(session)},"log":"pins","pins":${JSON.stringify(this.src.pins(id, session))}`);
      return;
    }
    const key = `${session} ${kind}`;
    const base = p.logs.get(key);
    // No view holds a log no reply read since this stream began: nothing to send.
    if (!base) return;
    const r = this.src.log(id, session, kind);
    p.logs.set(key, { count: r.entries.length, line: r.lines.at(-1) ?? -1 });
    const head = `"session":${JSON.stringify(session)},"log":${JSON.stringify(kind)}`;
    // Read again from its start (shorter, or its lines no longer where they were): its views read it in full.
    if (r.entries.length < base.count || (base.count > 0 && r.lines[base.count - 1] !== base.line)) {
      this.message(id, "log", `${head},"reload":true`);
      return;
    }
    if (r.entries.length === base.count) return;
    const fresh = r.entries.slice(base.count).map((e, i) => kind === "chat" ? { ...(e as object), line: r.lines[base.count + i] } : e);
    const json = JSON.stringify(fresh);
    this.message(id, "log", json.length > LOG_LIMIT ? `${head},"reload":true` : `${head},"entries":${json}`);
  }

  /** The state's full read (after a publication: it stands where the stream does), or undefined. */
  stateJson(id: string): string | undefined {
    const p = this.of(id);
    if (p.texts && p.state === this.src.state(id)) return stateJson(p.texts);
    const s = this.src.state(id);
    const t = s && stateTexts(s);
    return t ? stateJson(t) : s && JSON.stringify(s);
  }
}
