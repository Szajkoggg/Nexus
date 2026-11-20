// A model of a folder's files kept in memory (queue SM; docs/design/model.md): every file a store reads, parsed once,
// a log read on from where it was left, the state derived from it once per change. The files stay the one source of
// truth: the model can be thrown away and built again at any time, and gives what the files give.
import { closeSync, existsSync, fstatSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { z } from "zod";
import { clockMark, observe } from "./clock.ts";
import { ProjectStore, countWork, nexusHome, onWrite, parseJsonlLines, type JsonlRead, type Reader } from "./store.ts";
import { deriveProjectState, type ProjectState } from "./state.ts";
import { templatesStamp } from "./templates.ts";

/** A path as the model keys it: absolute, forward slashes, lower case on Windows (its file names ignore case). */
function fileKey(p: string): string {
  const k = resolve(p).replaceAll("\\", "/");
  return process.platform === "win32" ? k.toLowerCase() : k;
}

/** The bytes before a log's position compared on each read (a file rewritten under it is read again whole). */
const GUARD = 64;

interface Log {
  file: string;
  schema: z.ZodType;
  read: JsonlRead<unknown>;
  /** Bytes up to the end of the last complete line read, and the lines up to there. */
  pos: number;
  lines: number;
  /** The file's size when it was last read (a line still being written lies between `pos` and it). */
  seen: number;
  /** The GUARD bytes before `pos`, and the file's id, as read. */
  guard: Uint8Array;
  ino: bigint;
  /** Times read that this process's clock did not take up yet (too far ahead): offered again on each read. */
  ahead: string[];
  dirty: boolean;
}
type Parsed = { ok: true; value: unknown } | { ok: false; error: unknown };

/** Freezes a value read from a file and everything in it: a reader that changes it fails rather than changes it for all. */
function freeze<T>(v: T): T {
  if (v && typeof v === "object" && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const x of Object.values(v)) freeze(x);
  }
  return v;
}

/**
 * The files under `dir` as a Reader serves them, from memory. It hears of this process's writes as they are made
 * (onWrite: write-through) and of another's from `touched` (the server's watcher); until then a file is what it was.
 * `version` moves with every change of a file that is not a log only (`logOnly`).
 */
export class FileCache implements Reader {
  readonly root: string;
  version = 0;
  /** Whole reads of a log because it did not go on from its position (shorter, other bytes, another file). */
  resets = 0;
  private readonly parsedFiles = new Map<string, Parsed>();
  private readonly present = new Map<string, boolean>();
  private readonly listings = new Map<string, { dirs: string[]; names: string[] } | null>();
  private readonly logs = new Map<string, Log>();
  private readonly unhook: () => void;

  private readonly logOnly: (key: string) => boolean;
  /** The state derived from these files, when a model owns the cache (Reader.state). */
  state?: () => ProjectState;
  /**
   * Logs another process appends to now (a running agent's events): each read of one first looks whether it grew,
   * not waiting for the watcher, as a read of the file would see it.
   */
  live?: (key: string) => boolean;

  /** A file whose change means another may have changed unreported too (`linked`: that one's key), read on when asked. */
  private readonly linked: (key: string) => string | undefined;

  constructor(dir: string, logOnly: (key: string) => boolean = () => false, linked: (key: string) => string | undefined = () => undefined) {
    this.root = fileKey(dir);
    this.logOnly = logOnly;
    this.linked = linked;
    this.unhook = onWrite((f) => this.touched(f));
  }

  /** Stops hearing of this process's writes. */
  close(): void { this.unhook(); }

  /** A file (or folder) under the root changed, was made or went: what is kept of it is read again when asked. */
  touched(path: string): void {
    const k = fileKey(path);
    if (k !== this.root && !k.startsWith(`${this.root}/`)) return;
    if (k.endsWith(".tmp") || k.endsWith(".lock")) return;
    this.parsedFiles.delete(k);
    this.present.delete(k);
    const log = this.logs.get(k);
    if (log) log.dirty = true;
    const other = this.linked(k);
    const otherLog = other && this.logs.get(other);
    if (otherLog) otherLog.dirty = true;
    // A folder made or gone: its listing and those of the folders above it, and whether each exists (a write may make
    // the folders it lies in).
    for (let d = k; d.length >= this.root.length; d = dirname(d)) {
      this.listings.delete(d);
      this.present.delete(d);
      if (d === this.root) break;
    }
    // A folder gone: everything kept under it (one still there keeps it: what changed in it is reported for itself).
    const under = `${k}/`;
    const maps = [this.parsedFiles, this.present, this.listings, this.logs] as Map<string, unknown>[];
    const holds = (m: Map<string, unknown>) => { for (const key of m.keys()) if (key.startsWith(under)) return true; return false; };
    if (maps.some(holds) && !existsSync(path)) {
      for (const m of maps) for (const key of m.keys()) if (key.startsWith(under)) m.delete(key);
    }
    if (!this.logOnly(k)) this.version++;
  }

  /** Everything forgotten: read again from the files when asked. */
  clear(): void {
    this.parsedFiles.clear(); this.present.clear(); this.listings.clear(); this.logs.clear();
    this.version++;
  }

  /** Reads now what has grown in these logs, not waiting for the watcher (another process appends to them now). */
  sync(files: readonly string[]): void {
    for (const f of files) {
      const log = this.logs.get(fileKey(f));
      if (log && !log.dirty && this.grew(log)) { log.dirty = true; if (!this.logOnly(fileKey(f))) this.version++; }
    }
  }

  has(file: string): boolean {
    const k = fileKey(file);
    let p = this.present.get(k);
    if (p === undefined) {
      countWork("probes");
      p = existsSync(file);
      this.present.set(k, p);
    }
    return p;
  }

  parsed<T>(file: string, parse: (text: string) => T): T {
    const k = fileKey(file);
    let p = this.parsedFiles.get(k);
    if (!p) {
      try { p = { ok: true, value: freeze(parse(readWhole(file))) }; } catch (error) { p = { ok: false, error }; }
      this.parsedFiles.set(k, p);
    }
    if (!p.ok) throw p.error;
    return p.value as T;
  }

  jsonl<S extends z.ZodType>(file: string, schema: S, o: boolean): JsonlRead<z.infer<S>> {
    const k = fileKey(file);
    let log = this.logs.get(k);
    if (log && log.schema !== schema) log = undefined;
    if (log && !log.dirty && this.live?.(k) && this.grew(log)) { log.dirty = true; if (!this.logOnly(k)) this.version++; }
    if (!log) {
      log = { file, schema, read: { entries: [], lines: [], errors: [] }, pos: 0, lines: 0, seen: 0, guard: Buffer.alloc(0), ino: 0n, ahead: [], dirty: true };
      this.logs.set(k, log);
    }
    if (log.dirty) this.readOn(log, o);
    if (o && log.ahead.length) log.ahead = taken(log.ahead);
    const r = log.read as JsonlRead<z.infer<S>>;
    return { entries: [...r.entries], lines: [...r.lines], errors: [...r.errors] };
  }

  dirs(dir: string): string[] { return [...(this.listing(dir)?.dirs ?? [])]; }
  names(dir: string): string[] {
    const l = this.listing(dir);
    if (!l) throw Object.assign(new Error(`ENOENT: no such file or directory, scandir '${dir}'`), { code: "ENOENT" });
    return [...l.names];
  }

  private listing(dir: string): { dirs: string[]; names: string[] } | null {
    const k = fileKey(dir);
    let l = this.listings.get(k);
    if (l === undefined) {
      countWork("probes");
      if (!existsSync(dir)) l = null;
      else {
        countWork("listings");
        const entries = readdirSync(dir, { withFileTypes: true });
        l = { dirs: entries.filter((d) => d.isDirectory()).map((d) => d.name).sort(), names: entries.map((d) => d.name) };
      }
      this.listings.set(k, l);
    }
    return l;
  }

  /** Whether the file has more than was read, or is not the file read (then it is read again whole). */
  private grew(log: Log): boolean {
    try {
      const fd = openSync(log.file, "r");
      try {
        const st = fstatSync(fd, { bigint: true });
        return st.ino !== log.ino || Number(st.size) !== log.seen;
      } finally { closeSync(fd); }
    } catch { return log.seen > 0; }
  }

  /** Reads the log on from its position: the complete lines added since, once each. */
  private readOn(log: Log, o: boolean): void {
    log.dirty = false;
    let fd: number;
    try { fd = openSync(log.file, "r"); } catch {
      // Gone (or never there): nothing, as a read of a missing log gives.
      if (log.pos > 0) this.resets++;
      Object.assign(log, { read: { entries: [], lines: [], errors: [] }, pos: 0, lines: 0, seen: 0, guard: Buffer.alloc(0), ino: 0n, ahead: [] });
      return;
    }
    try {
      const st = fstatSync(fd, { bigint: true });
      const size = Number(st.size);
      const from = Math.max(0, log.pos - GUARD);
      let fresh = log.pos === 0;
      if (!fresh && (st.ino !== log.ino || size < log.pos)) fresh = true;
      let buf: Buffer = Buffer.alloc(0);
      if (!fresh) {
        buf = readAt(fd, from, size - from);
        if (!buf.subarray(0, log.pos - from).equals(log.guard)) fresh = true;
      }
      if (fresh) {
        if (log.pos > 0) this.resets++;
        Object.assign(log, { read: { entries: [], lines: [], errors: [] }, pos: 0, lines: 0, ahead: [] });
        buf = readAt(fd, 0, size);
      }
      const start = fresh ? 0 : log.pos - from;
      const end = buf.lastIndexOf(0x0a) + 1;
      if (end > start) {
        const added = { entries: [] as unknown[], lines: [] as number[], errors: [] as string[] };
        log.lines += parseJsonlLines(log.file, buf.subarray(start, end).toString("utf8"), log.lines, log.schema, added);
        for (const e of added.entries) freeze(e);
        log.read.entries.push(...added.entries);
        log.read.lines.push(...added.lines);
        log.read.errors.push(...added.errors);
        const base = fresh ? 0 : from;
        log.pos = base + end;
        log.guard = Buffer.from(buf.subarray(Math.max(0, end - GUARD), end));
        if (o) for (const e of added.entries) {
          const at = (e as { at?: string }).at;
          observe(at);
          if (at && !past(at)) log.ahead.push(at);
        }
      }
      log.ino = st.ino;
      log.seen = size;
    } finally { closeSync(fd); }
  }
}

function readAt(fd: number, from: number, length: number): Buffer {
  const buf = Buffer.alloc(Math.max(0, length));
  let got = 0;
  while (got < buf.length) {
    const n = readSync(fd, buf, got, buf.length - got, from + got);
    if (!n) break;
    got += n;
  }
  countWork("files"); countWork("bytes", got);
  return buf.subarray(0, got);
}
function readWhole(file: string): string {
  const fd = openSync(file, "r");
  try { return readAt(fd, 0, Number(fstatSync(fd).size)).toString("utf8"); } finally { closeSync(fd); }
}
/** The clock has taken `at` up (or a later time). */
const past = (at: string): boolean => { const m = clockMark(); return !!m && Date.parse(m) > Date.parse(at); };
/** Offers the times again; keeps those the clock still has not taken up. */
function taken(ahead: string[]): string[] {
  for (const at of ahead) observe(at);
  return ahead.filter((at) => !past(at));
}

/** A session's logs that only show what an agent did: no state is derived from them (docs/design/model.md). */
const LOG_ONLY = /\/sessions\/[^/]+\/(activity\.jsonl|chat\.jsonl|refusals\.jsonl|pins\.json)$/;
export const isLogOnly = (path: string): boolean => LOG_ONLY.test(fileKey(path));
/**
 * A session's runtime record changed (its agent started, reported, ended): its events are read on at the next read.
 * An agent's last lines are written before its end is recorded, and the watcher may not have reported them yet.
 */
const eventsOfRuntime = (key: string): string | undefined => /\/sessions\/[^/]+\/runtime\.json$/.test(key) ? `${key.slice(0, -"runtime.json".length)}events.jsonl` : undefined;

/**
 * A project's model: its store reading from memory, and its state derived once per version. Before the state is read,
 * the events of the sessions whose agents run (`volatile`: by default those whose runtime record is not exited) are
 * read on from their files, not waiting for the watcher: their agents' `nexus` appends to them now.
 */
export class ProjectModel {
  readonly cache: FileCache;
  readonly store: ProjectStore;
  /** The state, the version it was derived at, and the templates it read (while the project has recurring queues). */
  private state?: { version: number; value: ProjectState; templates?: string };
  private live?: { version: number; files: string[]; keys: Set<string> };
  private readonly volatile?: () => readonly string[];
  private readonly unhook: () => void;

  constructor(nexusDir: string, o: { volatile?: () => readonly string[] } = {}) {
    this.cache = new FileCache(nexusDir, isLogOnly, eventsOfRuntime);
    this.store = new ProjectStore(nexusDir, this.cache);
    this.volatile = o.volatile;
    this.cache.state = () => this.current();
    this.cache.live = (k) => this.liveLogs().keys.has(k);
    // The global settings and the away mode are part of every project's state.
    const home = new Set(["settings.yaml", "away.yaml"].map((f) => fileKey(`${nexusHome()}/${f}`)));
    this.unhook = onWrite((f) => { if (home.has(fileKey(f))) this.changed(); });
  }

  /** The logs read on before each read of the state, and looked at before each read of one of them. */
  private liveLogs(): { files: string[]; keys: Set<string> } {
    const eventsOf = (s: string) => `${this.store.sessionDir(s)}/events.jsonl`;
    if (this.volatile) {
      const files = this.volatile().map(eventsOf);
      return { files, keys: new Set(files.map(fileKey)) };
    }
    if (this.live?.version !== this.cache.version) {
      const files = this.store.sessionIds().filter((s) => this.store.readRuntime(s)?.state !== "exited" && this.store.reader.has(`${this.store.sessionDir(s)}/runtime.json`))
        .map(eventsOf);
      const keys = new Set(files.map(fileKey));
      this.live = { version: this.cache.version, files, keys };
    }
    return this.live;
  }

  /** Whether the next read of the state derives it again. */
  stale(): boolean { return this.state?.version !== this.cache.version || this.awayEnded() || this.templatesChanged(); }

  /**
   * The recurring queues' views read the templates, which lie outside the project's folder (no watcher reports them):
   * while there are recurring queues, whether a template was added, removed or edited since the derivation.
   */
  private templatesChanged(): boolean {
    const s = this.state;
    return s?.templates !== undefined && templatesStamp(s.value.project.root) !== s.templates;
  }

  /** The away mode the state shows is that of its derivation's time: whether its period has ended since. */
  private awayEnded(): boolean {
    const away = this.state?.value.away;
    return !!away?.on && !!away.until && Date.parse(away.until) <= Date.now();
  }

  /** The project's state now: derived again only when a file of it changed (or `changed` was called) since. */
  current(): ProjectState {
    this.cache.sync(this.liveLogs().files);
    if (this.awayEnded() || this.templatesChanged()) this.changed();
    if (this.state?.version !== this.cache.version) {
      const version = this.cache.version;
      // Shared by every reader of the state until the next change: frozen, so that none changes it for the others.
      const templates = this.store.recurringIds().length ? templatesStamp(this.store.readProject().root) : undefined;
      this.state = { version, value: freeze(deriveProjectState(this.store)), templates };
    }
    return this.state.value;
  }

  /** Something the state depends on besides the files changed (the clock passed a time it shows): derive it again. */
  changed(): void { this.cache.version++; }
  /** A file under the project changed (the watcher's report). */
  touched(path: string): void { this.cache.touched(path); }

  /**
   * A report of Node's recursive watcher (fs.watch: `rename` or `change`, and the path): passed on as `touched`,
   * except a folder's `change` (what changed in it is reported for itself). Says what it was: a state input, a log
   * only, or nothing for the model.
   */
  watched(event: string, path: string): "state" | "log" | undefined {
    if (event === "change") { try { if (statSync(path).isDirectory()) return undefined; } catch { /* gone: as any other */ } }
    this.touched(path);
    return isLogOnly(path) ? "log" : "state";
  }
  /** Thrown away: everything read again from the files. */
  rebuild(): void { this.cache.clear(); this.state = undefined; }
  close(): void { this.cache.close(); this.unhook(); }
}
