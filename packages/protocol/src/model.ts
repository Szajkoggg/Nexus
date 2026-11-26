// A model of a folder's files kept in memory (queue SM; docs/design/model.md): every file a store reads, parsed once,
// a log read on from where it was left, the state derived from it once per change. The files stay the one source of
// truth: the model can be thrown away and built again at any time, and gives what the files give.
import { closeSync, existsSync, fstatSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { z } from "zod";
import { clockMark, observe } from "./clock.ts";
import { ProjectStore, countWork, namesFile, nexusHome, onWrite, parseJsonlLines, type JsonlRead, type Reader } from "./store.ts";
import { deriveProjectState, type ProjectState } from "./state.ts";
import { templatesStamp } from "./templates.ts";

/** A path as the model keys it: absolute, forward slashes, lower case on Windows (its file names ignore case). */
function fileKey(p: string): string {
  const k = resolve(p).replaceAll("\\", "/");
  return process.platform === "win32" ? k.toLowerCase() : k;
}

/** A read fault a test set (FileCache.faultReads): opens of the file it names fail with `code`, `times` times. */
interface ReadFault { file: string; code: string; left: number; failed: number }
let readFault: ReadFault | undefined;

/** openSync for reading, through the test's read fault (store.ts, namesFile): the fault it met, if any. */
function openOnce(file: string, met: { fault?: ReadFault }): number {
  const f = readFault;
  if (f && f.left > 0 && namesFile(file, f.file)) {
    f.left--; met.fault = f;
    throw Object.assign(new Error(`${f.code}: injected read fault, open '${file}'`), { code: f.code });
  }
  return openSync(file, "r");
}

/** An error that says nothing of the file's content: Windows refuses it for a moment (another process holds it). */
const TRANSIENT = new Set(["EBUSY", "EPERM", "EACCES", "EMFILE", "ENFILE"]);
const transient = (e: unknown): boolean => TRANSIENT.has((e as NodeJS.ErrnoException)?.code ?? "");
/** How long an open refused for a moment is tried again (as a write's rename is: store.ts, renameRetrying). */
const OPEN_RETRY_MS = 200;

/**
 * Opens the file for reading, tried again after 5, 10, 20, … ms for up to OPEN_RETRY_MS while the error is a passing
 * one (queue LH); then the last error is thrown, and the caller keeps nothing of it as the file's content.
 */
function openRead(file: string): number {
  const start = Date.now();
  // A test's fault counts the opens it refused (an open tried again within its wait counts once).
  const met: { fault?: ReadFault } = {};
  try {
    for (let wait = 5; ; wait = Math.min(wait * 2, 50)) {
      try { return openOnce(file, met); }
      catch (e) {
        if (!transient(e) || Date.now() - start >= OPEN_RETRY_MS) throw e;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
      }
    }
  } finally { if (met.fault) met.fault.failed++; }
}

/** The bytes before a log's position compared on each read (a file rewritten under it is read again whole). */
const GUARD = 64;
/**
 * How long a log only (activity, chat, refusals) is kept after it was last asked for (queue AQ): then it is let go, and
 * read again from its file when asked (docs/design/archive.md). Its index, a position, goes with it.
 */
const LOG_IDLE_MS = 2 * 60_000;

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
  /** When it was last asked for (Date.now()): a log only no one asked for in LOG_IDLE_MS is let go (release). */
  asked: number;
}
type Parsed = { ok: true; value: unknown } | { ok: false; error: unknown };
/** A log as before its first read: nothing read, from no file. */
const unread = () => ({ read: { entries: [], lines: [], errors: [] }, pos: 0, lines: 0, seen: 0, guard: Buffer.alloc(0), ino: 0n, ahead: [] as string[] });

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
  /** Files' modification times (ms; null: missing), asked by `modified` and forgotten at the file's change. */
  private readonly times = new Map<string, number | null>();
  private readonly unhook: () => void;
  /** How long a log only is kept unasked (LOG_IDLE_MS; a test shortens it), and when the logs were last looked over. */
  logIdleMs = LOG_IDLE_MS;
  private swept = Date.now();

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

  /**
   * Test seam (queue LH): the next `times` opens of the file named by its path's end (`file`: "applied.jsonl",
   * "queues/Q/queue.yaml") fail with `code` (EBUSY, EPERM, EMFILE: what Windows gives while another process holds a
   * file), in this process and for every cache, until `clear`. `failed` counts the opens refused: an open tried again
   * within its wait (openRead) counts once, whether it got the file in the end or not.
   */
  static faultReads(o: { file: string; code?: string; times?: number }): { failed(): number; clear(): void } {
    const f: ReadFault = { file: o.file.replaceAll("\\", "/"), code: o.code ?? "EBUSY", left: o.times ?? 1, failed: 0 };
    readFault = f;
    return { failed: () => f.failed, clear: () => { if (readFault === f) readFault = undefined; } };
  }

  /** Stops hearing of this process's writes. */
  close(): void { this.unhook(); }

  /**
   * While a derivation runs (`within`), the files whose open was refused for a moment, with the error: each is opened
   * (and waited for) once per derivation, not at each read of it (queue LCF; LC2 finding 5: a log stayed locked, and
   * each derivation waited up to OPEN_RETRY_MS twice for it, synchronously).
   */
  private refused?: Map<string, unknown>;

  /**
   * Runs `f` as one derivation: a file refused for a moment in it is not opened again in it (`refused`). The state it
   * derived lacks what such a file holds now (a log keeps what it read before): unless it is a log only, the version
   * moves after it, so the next read derives again and tries the file once more, rather than keep that state until
   * another file changes.
   */
  within<T>(f: () => T): T {
    if (this.refused) return f();
    const refused = (this.refused = new Map());
    try { return f(); } finally {
      this.refused = undefined;
      if ([...refused.keys()].some((k) => !this.logOnly(k))) this.version++;
    }
  }

  /** openRead, unless the file was refused already in this derivation: then that error again, at once. */
  private open(file: string): number {
    const k = fileKey(file);
    if (this.refused?.has(k)) throw this.refused.get(k);
    try { return openRead(file); } catch (e) {
      if (this.refused && transient(e)) this.refused.set(k, e);
      throw e;
    }
  }

  /** A file (or folder) under the root changed, was made or went: what is kept of it is read again when asked. */
  touched(path: string): void {
    const k = fileKey(path);
    if (k !== this.root && !k.startsWith(`${this.root}/`)) return;
    if (k.endsWith(".tmp") || k.endsWith(".lock")) return;
    this.parsedFiles.delete(k);
    this.present.delete(k);
    this.times.delete(k);
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
    const maps = [this.parsedFiles, this.present, this.listings, this.logs, this.times] as Map<string, unknown>[];
    const holds = (m: Map<string, unknown>) => { for (const key of m.keys()) if (key.startsWith(under)) return true; return false; };
    if (maps.some(holds) && !existsSync(path)) {
      for (const m of maps) for (const key of m.keys()) if (key.startsWith(under)) m.delete(key);
    }
    if (!this.logOnly(k)) this.version++;
  }

  /** Everything forgotten: read again from the files when asked. */
  clear(): void {
    this.parsedFiles.clear(); this.present.clear(); this.listings.clear(); this.logs.clear(); this.times.clear();
    this.version++;
  }

  /**
   * Lets go of the logs only (activity, chat, refusals, pins are not logs) no one asked for since `now - logIdleMs`
   * (queue AQ): a closed queue's logs are kept while they are read, not for the server's life. A log let go is read
   * again from its file when asked; it is no change (the version stays). Returns how many were let go.
   */
  release(now = Date.now()): number {
    this.swept = now;
    let n = 0;
    for (const [k, log] of this.logs) if (this.logOnly(k) && log.asked < now - this.logIdleMs) { this.logs.delete(k); n++; }
    return n;
  }

  /** The logs held in memory now, with their entries (a test's and the measurement's look at the memory). */
  held(): { file: string; entries: number }[] {
    return [...this.logs.values()].map((l) => ({ file: l.file, entries: l.read.entries.length }));
  }

  /**
   * The file's modification time in ms, undefined when it is missing: a stat at the first ask, then kept until the
   * file's change is reported (write-through or the watcher), so asking again costs nothing.
   */
  modified(file: string): number | undefined {
    const k = fileKey(file);
    let t = this.times.get(k);
    if (t === undefined) {
      countWork("probes");
      try { t = statSync(file).mtimeMs; } catch { t = null; }
      this.times.set(k, t);
    }
    return t ?? undefined;
  }

  /** Reads now what has grown in these logs, not waiting for the watcher (another process appends to them now). */
  sync(files: readonly string[]): void {
    for (const f of files) {
      const k = fileKey(f);
      const log = this.logs.get(k);
      if (log && !log.dirty) this.dirtyIfGrown(k, log);
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
      try { p = { ok: true, value: freeze(parse(readWhole(this.open(file)))) }; } catch (error) {
        // A read refused for a moment is not the file's content: not kept, read again at the next read (queue LH).
        if (transient(error)) throw error;
        p = { ok: false, error };
      }
      this.parsedFiles.set(k, p);
    }
    if (!p.ok) throw p.error;
    return p.value as T;
  }

  jsonl<S extends z.ZodType>(file: string, schema: S, o: boolean): JsonlRead<z.infer<S>> {
    const k = fileKey(file);
    const now = Date.now();
    if (now - this.swept > this.logIdleMs / 4) this.release(now);
    let log = this.logs.get(k);
    if (log && log.schema !== schema) log = undefined;
    if (log && !log.dirty && this.live?.(k)) this.dirtyIfGrown(k, log);
    if (!log) {
      log = { file, schema, ...unread(), dirty: true, asked: now };
      this.logs.set(k, log);
    }
    log.asked = now;
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

  /** The log is read on at its next read if its file grew (or is another): a change unless it is a log only. */
  private dirtyIfGrown(k: string, log: Log): void {
    if (!this.grew(log)) return;
    log.dirty = true;
    if (!this.logOnly(k)) this.version++;
  }

  /** Whether the file has more than was read, or is not the file read (then it is read again whole). */
  private grew(log: Log): boolean {
    try {
      const fd = this.open(log.file);
      try {
        const st = fstatSync(fd, { bigint: true });
        return st.ino !== log.ino || Number(st.size) !== log.seen;
      } finally { closeSync(fd); }
    } catch (e) { return transient(e) || log.seen > 0; }
  }

  /** Reads the log on from its position: the complete lines added since, once each. */
  private readOn(log: Log, o: boolean): void {
    log.dirty = false;
    let fd: number;
    try { fd = this.open(log.file); } catch (e) {
      // Refused for a moment (queue LH): what was read is kept, and the log is read on at its next read.
      if (transient(e)) { log.dirty = true; return; }
      // Gone (or never there): nothing, as a read of a missing log gives.
      this.reset(log);
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
        // Read before and now not what it was read as: a contradiction, counted and logged (docs/design/model.md).
        if (log.pos > 0) { countWork("resets"); console.warn(`model: ${log.file} contradicts the position it was read to (${log.pos} bytes); read again from its start`); }
        this.reset(log);
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

  /** Forgets what was read of the log (counted as a reset when there was something). */
  private reset(log: Log): void {
    if (log.pos > 0) this.resets++;
    Object.assign(log, unread());
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
/** The whole file open at `fd`, closed after. */
function readWhole(fd: number): string {
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
    // One derivation (with the reads on before it): a file refused for a moment is waited for once in it.
    return this.cache.within(() => this.derive());
  }

  private derive(): ProjectState {
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
