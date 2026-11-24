// Reading and writing a project's .nexus/ directory and the Nexus registry.
// Rules (docs/protocol/files.md, "Rules"): one writer per file, JSONL is append-only, YAML is replaced atomically.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { monotonicFactory } from "ulid";
import YAML from "yaml";
import type { z } from "zod";
import type { ProjectState } from "./state.ts";
import {
  Activity, Applied, AwayFile, CapacityFile, ChecksFile, IdeaMatchesFile, ChatEntry, PinsFile, RecurringFile, Refusal, Delivery, Event, GlobalSettings, InboxEntry, MaxRunning, MetricsFile, NoteMeta, GitFile, ProjectFile, PushFile, QueueFile, type QueueInput, LegacyReviewPolicy, RegistryFile, RunFile, RuntimeFile, SessionFile, StartFile, StaticAnalysisNote, PlanFile, StoredProject, TagsFile, TurnRecord, ServerSpeedRun, UsageFile,
  type Note,
  IdeaStatusesFile, IdeaHandoffsFile,
} from "./schemas.ts";
import { noteRefs } from "./ideas.ts";
import { clockMark, now, observe } from "./clock.ts";
import { applyChange, builtInSettings, effectiveProject, migrateStored, storedFrom } from "./settings.ts";

const NEXUS_DIRNAME = ".nexus";

const nextUlid = monotonicFactory();
export const newId = (): string => nextUlid();
export { now };

/** Forward slashes, absolute. Every path stored in protocol files uses this form. */
export function normPath(p: string, base = process.cwd()): string {
  return (isAbsolute(p) ? p : resolve(base, p)).replaceAll("\\", "/");
}

// ---------------------------------------------------------------- generic file helpers

function readYaml<S extends z.ZodType>(file: string, schema: S): z.infer<S> {
  return schema.parse(YAML.parse(readText(file)));
}

/**
 * Who hears of this process's writes through this module, by path, as they are made (queue SM: a model of the files
 * kept in memory, model.ts, takes them up before the write returns: write-through). A write of another process (an
 * agent's `nexus`) reaches it through the server's file watcher instead.
 */
const writeListeners = new Set<(file: string) => void>();
export function onWrite(fn: (file: string) => void): () => void { writeListeners.add(fn); return () => { writeListeners.delete(fn); }; }
/** Tells the listeners of a write of `file`; for a write made outside this module's helpers too (a note's withdrawal). */
export function wrote(file: string): void { for (const fn of writeListeners) fn(file); }

/** A write fault a test set (ProjectStore.faultWrites): the file it names, how many writes of it still go through. */
interface WriteFault { file: string; left: number; error: string; writes: number; failed: number }
let writeFault: WriteFault | undefined;

/** A test fault's file, named by its path's end with forward slashes ("git.yaml", "queues/Q/run.yaml"), is `file`. */
export const namesFile = (file: string, end: string): boolean => `/${file.replaceAll("\\", "/")}`.endsWith(`/${end}`);

/**
 * Before a replacement or an append through this module's helpers: throws when the test's fault names this file
 * (namesFile) and its writes that go through are used up.
 */
function faultCheck(file: string): void {
  const f = writeFault;
  if (!f || !namesFile(file, f.file)) return;
  f.writes++;
  if (f.left > 0) { f.left--; return; }
  f.failed++;
  throw Object.assign(new Error(`${f.error}: ${file}`), { code: "EIO" });
}
/** Removes a file if it is there, and tells of it. */
function removeFile(file: string): void {
  if (existsSync(file)) { unlinkSync(file); wrote(file); }
}

/**
 * The work this process's reads have done through this module, counted rather than timed so a test can hold it on a
 * busy machine (queue SM's gate, packages/protocol/test/work-gate.test.ts): `files` read whole, the `bytes` they had,
 * `probes` (a file's existence asked) and `listings` (a folder's entries listed), and `rebuilds`, whole derivations of
 * a project's state (loadProjectState), and `resets`, logs read again whole because they contradicted the position
 * a model read them to (model.ts; docs/design/model.md, "When a file contradicts its position"). Reads outside the
 * store (templates, the ideas' notes) are not counted.
 */
export interface WorkCounts { files: number; bytes: number; probes: number; listings: number; rebuilds: number; resets: number }
const work: WorkCounts = { files: 0, bytes: 0, probes: 0, listings: 0, rebuilds: 0, resets: 0 };
/** The work counted since the process started (or since the last resetWork). */
export const workCounts = (): WorkCounts => ({ ...work });
export const resetWork = (): void => { for (const k of Object.keys(work) as (keyof WorkCounts)[]) work[k] = 0; };
/** Counts a whole derivation of a project's state (state.ts). */
export const countRebuild = (): void => { work.rebuilds++; };
/** Counts work done by another reader of the files (model.ts). */
export const countWork = (k: keyof WorkCounts, n = 1): void => { work[k] += n; };

function readText(file: string): string {
  const b = readFileSync(file);
  work.files++; work.bytes += b.length;
  return b.toString("utf8");
}
function exists(file: string): boolean { work.probes++; return existsSync(file); }
function list(dir: string): string[] { work.listings++; return readdirSync(dir); }

/**
 * How a store reads: straight from the files (`fileReader`, the CLI's and every store's by default), or from a model
 * of them kept in memory (model.ts, the server's). `parsed`: the file's text through `parse`, throwing as `parse`
 * throws; the value may be shared, and must not be changed (a model freezes it). `jsonl`: a log's complete lines;
 * `observe`: their times taken up by this process's clock. `dirs`: a folder's subfolders, sorted (none when it is
 * missing); `names`: its entries. `state`: the project's state as the model derived it (model.ts): `loadProjectState`
 * over a store reading through a model answers with it, so every reader of the state shares one derivation per change.
 */
export interface Reader {
  has(file: string): boolean;
  parsed<T>(file: string, parse: (text: string) => T): T;
  jsonl<S extends z.ZodType>(file: string, schema: S, observe: boolean): JsonlRead<z.infer<S>>;
  dirs(dir: string): string[];
  names(dir: string): string[];
  /** The file's modification time in ms, undefined when it is missing (a model keeps it until the file changes). */
  modified(file: string): number | undefined;
  state?(): ProjectState;
}
const fileReader: Reader = {
  has: (file) => exists(file),
  parsed: (file, parse) => parse(readText(file)),
  jsonl: (file, schema, o) => { const r = readJsonl(file, schema); if (o) for (const e of r.entries as { at?: string }[]) observe(e.at); return r; },
  dirs: (dir) => subdirs(dir),
  names: (dir) => list(dir),
  modified: (file) => { try { return statSync(file).mtimeMs; } catch { return undefined; } },
};
/** How NEXUS_HOME's settings, away mode and turns are read (the server sets a model of them: model.ts). */
let home: Reader = fileReader;
export function useHomeReader(r: Reader): void { home = r; }
/**
 * How a store made without a reader reads its folder: the files, unless set. Only the tests set it, to run the server's
 * decisions over models as the server does (apps/server/test/model-reads.ts); the server gives each project's store
 * its model explicitly.
 */
let readerFor: ((nexusDir: string) => Reader | undefined) | undefined;
export function useProjectReaders(f: ((nexusDir: string) => Reader | undefined) | undefined): void { readerFor = f; }

/**
 * How long a rename is tried again while Windows refuses it (see renameRetrying). Longer than a read's open is retried
 * (model.ts, OPEN_RETRY_MS, 200 ms) on purpose: a write that gives up loses the change, a read that gives up is only
 * taken again at the next read, so the write waits out a slower reader (an antivirus scan, the other server of an update).
 */
const RENAME_RETRY_MS = 2_000;

/** A rename fault a test set (faultRenames): the file it names, how many renames onto it still fail, with what code. */
interface RenameFault { file: string; code: string; left: number; failed: number }
let renameFault: RenameFault | undefined;
/**
 * Test seam: the next `times` renames onto the file named by its path's end (`file`, as namesFile reads it) fail with
 * `code` (EPERM by default: what Windows gives while another process holds the file), in this process, until `clear`.
 * `failed` counts the renames refused.
 */
export function faultRenames(o: { file: string; code?: string; times?: number }): { failed(): number; clear(): void } {
  const f: RenameFault = { file: o.file.replaceAll("\\", "/"), code: o.code ?? "EPERM", left: o.times ?? 1, failed: 0 };
  renameFault = f;
  return { failed: () => f.failed, clear: () => { if (renameFault === f) renameFault = undefined; } };
}
function renameOnce(from: string, to: string): void {
  const f = renameFault;
  if (f && f.left > 0 && namesFile(to, f.file)) {
    f.left--; f.failed++;
    throw Object.assign(new Error(`${f.code}: operation not permitted, rename '${from}' -> '${to}'`), { code: f.code });
  }
  renameSync(from, to);
}

/**
 * renameSync, tried again while Windows refuses it for a moment. Windows does not replace (or move) a file that
 * another process has open, even only for reading: the rename fails with EPERM (or EACCES, EBUSY) until that process
 * closes it. A reader in another process is ordinary here (an agent's `nexus` CLI, a test, the other server of an
 * update, the search indexer or an antivirus). Measured on 2026-11-13: a rename onto a file another Node process held
 * open failed with EPERM and went through once it was closed. Tried again after 5, 10, 20, … ms (at most 200 ms
 * apart) for up to RENAME_RETRY_MS; then the last error is thrown. Synchronous, like the writes it serves.
 */
export function renameRetrying(from: string, to: string): void {
  try { faultCheck(to); } catch (e) { try { unlinkSync(from); } catch { /* already gone */ } throw e; }
  const start = Date.now();
  for (let wait = 5; ; wait = Math.min(wait * 2, 200)) {
    try { renameOnce(from, to); wrote(from); wrote(to); return; }
    catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if ((code !== "EPERM" && code !== "EACCES" && code !== "EBUSY") || Date.now() - start >= RENAME_RETRY_MS) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
    }
  }
}

// ---------------------------------------------------------------- missing and unreadable files
// The rule (docs/design/state.md, "Missing and unreadable files"): a reader gives its default only for a missing
// file. A file that is there but cannot be read is an error naming it, or, where the server goes on with a default,
// a warning with its path; nothing overwrites it: its writer sets it aside as <file>.corrupt first.

/** A file that is there but cannot be read (it does not parse, its schema refuses it, or the system refuses it). */
export class UnreadableFileError extends Error {
  readonly file: string;
  /** Its content is at fault (not a refusal of the system, such as a file another process holds). */
  readonly content: boolean;
  constructor(file: string, cause: unknown) {
    super(`${normPath(file)} cannot be read: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = "UnreadableFileError";
    this.file = normPath(file);
    this.content = typeof (cause as { syscall?: unknown } | undefined)?.syscall !== "string";
  }
}
const isMissing = (e: unknown): boolean => (e as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
const unreadable = (file: string, e: unknown): UnreadableFileError => e instanceof UnreadableFileError ? e : new UnreadableFileError(file, e);

/** Reads a file through `read`: a missing file's error goes through as it is, any other names the file. */
function named<T>(file: string, read: () => T): T {
  try { return read(); } catch (e) { throw isMissing(e) ? e : unreadable(file, e); }
}

/** Where a reader with a default tells of an unreadable file (console.warn, once per file, when none is given). */
export type Warn = (message: string) => void;
/** The unreadable files this process's readers with a default met, by path: their writer sets them aside. */
const metUnreadable = new Map<string, UnreadableFileError>();

/**
 * A reader with a default, for a file the server writes and goes on without: `read`'s value; `fallback` for a missing
 * file; for one that is there but cannot be read, `fallback` too, told to `warn` with the file's path, and the file
 * remembered so that writeFileAtomic sets it aside before replacing it.
 */
function orDefault<T>(file: string, read: () => T, fallback: T, warn?: Warn): T {
  const key = normPath(file);
  try {
    const value = read();
    metUnreadable.delete(key);
    return value;
  } catch (e) {
    if (isMissing(e)) return fallback;
    const err = unreadable(file, e);
    const message = `${err.message}; going on as if it were missing until it is written again (then it is set aside as ${basename(file)}.corrupt)`;
    if (warn) warn(message); else if (!metUnreadable.has(key)) console.warn(`nexus: ${message}`);
    metUnreadable.set(key, err);
    return fallback;
  }
}

/** Before a file is replaced: if a reader with a default found its content unreadable, it is moved to <file>.corrupt. */
function setAsideUnreadable(file: string): void {
  const key = normPath(file);
  const met = metUnreadable.get(key);
  if (!met) return;
  metUnreadable.delete(key);
  if (!met.content || !existsSync(file)) return;
  renameRetrying(file, `${file}.corrupt`);
  console.warn(`nexus: ${key} could not be read; set aside as ${basename(file)}.corrupt before it is written anew`);
}

/**
 * Atomic replace: creates the folder, writes the whole text to a temporary file next to the target (named by this
 * process's id, so two processes writing the same file never share one), then renames it over the target
 * (renameRetrying). A reader sees the old content or the new one, never half of it. When the write or the rename
 * fails, the temporary file is removed and the error thrown; the target is untouched.
 */
export function writeFileAtomic(file: string, text: string | Uint8Array): void {
  mkdirSync(dirname(file), { recursive: true });
  setAsideUnreadable(file);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    if (typeof text === "string") writeFileSync(tmp, text, "utf8"); else writeFileSync(tmp, text);
    renameRetrying(tmp, file);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* not written, or already gone */ }
    throw e;
  }
}

/** writeFileAtomic of the data as YAML. */
export function writeYaml(file: string, data: unknown): void {
  writeFileAtomic(file, YAML.stringify(data, { lineWidth: 120 }));
}

/** writeFileAtomic of the value as indented JSON with a final newline. */
export function writeJson(file: string, value: unknown): void {
  writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** A JSONL file read: its valid entries, and for each the index of its line in the file (from 0); what was wrong. */
export interface JsonlRead<T> { entries: T[]; lines: number[]; errors: string[] }

/** Reads a JSONL log. A final line without a newline is still being written and is skipped. */
export function readJsonl<S extends z.ZodType>(file: string, schema: S): JsonlRead<z.infer<S>> {
  const out: JsonlRead<z.infer<S>> = { entries: [], lines: [], errors: [] };
  if (!exists(file)) return out;
  const text = readText(file);
  parseJsonlLines(file, text.endsWith("\n") ? text : text.slice(0, text.lastIndexOf("\n") + 1), 0, schema, out);
  return out;
}

/**
 * Parses complete lines (`complete` ends with a newline, or is empty) into `out`; `first` is the index of its first line
 * in the file. Returns how many lines it had (blank and broken ones counted: a line's index is its place in the file).
 */
export function parseJsonlLines<S extends z.ZodType>(file: string, complete: string, first: number, schema: S, out: JsonlRead<z.infer<S>>): number {
  if (!complete) return 0;
  const lines = complete.split("\n");
  lines.pop(); // what follows the last newline: nothing
  lines.forEach((line, j) => {
    const i = first + j;
    if (!line.trim()) return;
    try {
      const r = schema.safeParse(JSON.parse(line));
      if (r.success) { out.entries.push(r.data); out.lines.push(i); }
      else out.errors.push(`${file}:${i + 1}: ${r.error.issues.map((x) => `${x.path.join(".")} ${x.message}`).join("; ")}`);
    } catch (e) {
      out.errors.push(`${file}:${i + 1}: ${(e as Error).message}`);
    }
  });
  return lines.length;
}

/** One complete line in a single write. */
function appendJsonl(file: string, entry: unknown): void {
  faultCheck(file);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify(entry) + "\n", "utf8");
  wrote(file);
}

// ---------------------------------------------------------------- registry

/** NEXUS_HOME of `env` (default: this process's); the CLI passes the environment of its call. */
export function nexusHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.NEXUS_HOME ?? join(env.APPDATA ?? join(homedir(), ".config"), "Nexus");
}
const registryFile = (env: NodeJS.ProcessEnv) => join(nexusHome(env), "projects.yaml");

export function readRegistry(env: NodeJS.ProcessEnv = process.env): RegistryFile {
  const f = registryFile(env);
  return exists(f) ? readYaml(f, RegistryFile) : { protocol: 1, projects: [] };
}
export function writeRegistry(r: RegistryFile, env: NodeJS.ProcessEnv = process.env): void {
  writeYaml(registryFile(env), r);
}

// ---------------------------------------------------------------- locating a project's .nexus/

/**
 * Finds the .nexus directory for a working directory: walking up from it, then (for a worktree outside the main
 * checkout) the main checkout of its git repository.
 */
export function findNexusDir(cwd = process.cwd(), env: NodeJS.ProcessEnv = process.env): string | null {
  for (let d = resolve(cwd); ; d = dirname(d)) {
    if (exists(join(d, NEXUS_DIRNAME, "project.yaml"))) return normPath(join(d, NEXUS_DIRNAME));
    if (dirname(d) === d) break;
  }
  try {
    const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const main = dirname(common);
    if (exists(join(main, NEXUS_DIRNAME, "project.yaml"))) return normPath(join(main, NEXUS_DIRNAME));
  } catch { /* not a git repository */ }
  return null;
}

/**
 * The plan a chain from before the plan becomes: a start.yaml with `after` (the one queue it waited for) read as a
 * plan.yaml with that predecessor, set by whoever made the chain; undefined without `after`. `updatedAt`: when the plan
 * file is written.
 */
export function chainPlan(start: StartFile | undefined, updatedAt?: string): PlanFile | undefined {
  if (!start?.after) return undefined;
  return {
    protocol: 1, by: start.by, reason: start.reason, created_at: start.created_at, updated_at: updatedAt ?? start.created_at,
    after: [{ queue: start.after, by: start.by, at: start.created_at, reason: start.reason }], decisions: [],
  };
}

// ---------------------------------------------------------------- a project's store

export class ProjectStore {
  readonly dir: string;
  /** How it reads: the files themselves (fileReader), or a model of them (model.ts). */
  readonly reader: Reader;
  /**
   * The environment it reads NEXUS_HOME from (the global settings, the away mode, the templates): this process's, or
   * the one a CLI call was given (several sessions' calls may run in one process).
   */
  readonly env: NodeJS.ProcessEnv;
  constructor(nexusDir: string, reader?: Reader, env: NodeJS.ProcessEnv = process.env) {
    this.dir = normPath(nexusDir); this.reader = reader ?? readerFor?.(this.dir) ?? fileReader; this.env = env;
  }
  private yaml<S extends z.ZodType>(file: string, schema: S): z.infer<S> { return named(file, () => schema.parse(this.reader.parsed(file, YAML.parse))); }

  static forRoot(root: string, env: NodeJS.ProcessEnv = process.env): ProjectStore { return new ProjectStore(join(root, NEXUS_DIRNAME), undefined, env); }

  /**
   * Test seam (queue LH): a server that ends between two writes. The first `after` writes of the file named by its
   * path's end (`file`: "git.yaml", "queues/Q/run.yaml") go through; every later one throws, in this process and for
   * every store, as the replacement or the append it is (the target untouched, the temporary file removed), until
   * `clear`. `writes` counts that file's writes tried, `failed` those refused. One fault at a time: a new one replaces
   * the last.
   */
  static faultWrites(o: { file: string; after?: number; error?: string }): { writes(): number; failed(): number; clear(): void } {
    const f: WriteFault = { file: o.file.replaceAll("\\", "/"), left: o.after ?? 0, error: o.error ?? "injected write fault", writes: 0, failed: 0 };
    writeFault = f;
    return { writes: () => f.writes, failed: () => f.failed, clear: () => { if (writeFault === f) writeFault = undefined; } };
  }

  /** Creates .nexus/ with a .gitignore that ignores the directory itself, so the project's own .gitignore is untouched. */
  /**
   * Creates .nexus/ with a .gitignore that ignores the directory itself, so the project's own .gitignore is untouched.
   * The settings given are the project's own values; every other setting follows the global one.
   */
  static init(root: string, project: Omit<z.input<typeof StoredProject>, "protocol" | "follows_global">, env: NodeJS.ProcessEnv = process.env): ProjectStore {
    const store = ProjectStore.forRoot(root, env);
    mkdirSync(join(store.dir, "queues"), { recursive: true });
    mkdirSync(join(store.dir, "sessions"), { recursive: true });
    writeFileSync(join(store.dir, ".gitignore"), "*\n", "utf8");
    wrote(join(store.dir, ".gitignore"));
    if (!existsSync(store.projectFile)) store.writeStoredProject(StoredProject.parse({ protocol: 1, follows_global: true, ...project }));
    return store;
  }

  get projectFile(): string { return join(this.dir, "project.yaml"); }
  /** The project's effective settings: its own values where it has them, else the global ones (src/settings.ts). */
  readProject(): ProjectFile { return effectiveProject(this.readStoredProject(), readGlobalSettings(this.env)); }
  /** project.yaml as stored: project-only settings, state and the project's own values (overrides). */
  readStoredProject(): StoredProject { return this.yaml(this.projectFile, StoredProject); }
  writeStoredProject(p: StoredProject): void { writeYaml(this.projectFile, StoredProject.parse(p)); }
  /**
   * Changes the project's effective settings, keeping "follows" and "own value" apart (settings.ts, applyChange): a
   * setting the change gives another value becomes the project's own; one it leaves alone keeps its state; those in
   * `follow` follow the global value again. Every writer of project.yaml goes through this.
   */
  updateProject(change: (p: ProjectFile) => ProjectFile, follow: readonly string[] = [], own: readonly string[] = []): ProjectFile {
    const global = readGlobalSettings(this.env);
    const stored = applyChange(this.readStoredProject(), global, change(this.readProject()), follow, own);
    this.writeStoredProject(stored);
    return effectiveProject(stored, global);
  }
  /**
   * Stores whole effective settings by the migration's rule: a value equal to the global one follows it, a different
   * one becomes the project's own (settings.ts, storedFrom). For setting up a project or a test; a change of some
   * settings goes through updateProject, which keeps an own value that happens to equal the global one.
   */
  writeProject(p: ProjectFile): void { this.writeStoredProject(storedFrom(p, readGlobalSettings(this.env))); }
  /**
   * .nexus/orchestrator/summary.md: the summary the orchestrator wrote when its context neared full, which the fresh
   * session that went on from it started from (the latest one; each is also a context.summary event of its session).
   */
  get orchestratorSummaryFile(): string { return join(this.dir, "orchestrator", "summary.md"); }
  /** Written only by the server (src/orchestrator.ts), replaced whole. */
  writeOrchestratorSummary(text: string): void {
    writeFileAtomic(this.orchestratorSummaryFile, text);
  }
  /**
   * Turns a project.yaml from before global settings into the stored form, once (settings.ts, migrateStored): values
   * equal to the global ones follow them, different ones become the project's own; effective settings do not change.
   * Writes only when the file is not migrated yet; returns whether it wrote.
   */
  migrateProject(): boolean {
    const migrated = migrateStored(YAML.parse(readText(this.projectFile)), readGlobalSettings(this.env));
    if (migrated) this.writeStoredProject(migrated);
    return !!migrated;
  }

  /**
   * Records when the project's steps began to be reviewed by level (`review_levels_since`), once: a step.done from
   * before it keeps the meaning it had under the old review policies. Run by the server at its start; returns whether
   * it wrote.
   */
  markReviewLevels(at = now()): boolean {
    const stored = this.readStoredProject();
    if (stored.review_levels_since) return false;
    this.writeStoredProject({ ...stored, review_levels_since: at });
    return true;
  }

  // queues
  queueDir(id: string): string { return join(this.dir, "queues", id); }
  /** Where `nexus review add` copies a step's review files (its only writer): queues/<queue>/review/<step>/. */
  reviewDir(queue: string, step: string): string { return join(this.queueDir(queue), "review", step); }
  queueIds(): string[] { return this.reader.dirs(join(this.dir, "queues")).filter((q) => this.reader.has(join(this.queueDir(q), "queue.yaml"))); }
  /** queue.yaml in the present form (parseQueue: old review policies read as levels, their approvals kept). */
  readQueue(id: string): QueueFile {
    const f = join(this.queueDir(id), "queue.yaml");
    return named(f, () => parseQueue(this.reader.parsed(f, YAML.parse)));
  }
  /** Whether the queue has a queue.yaml (readable or not: readQueue tells). */
  hasQueue(id: string): boolean { return this.reader.has(join(this.queueDir(id), "queue.yaml")); }
  writeQueue(q: QueueInput): void { writeYaml(join(this.queueDir(q.id), "queue.yaml"), QueueFile.parse(q)); }

  readNotes(queueId: string): { notes: Note[]; errors: string[] } {
    const notes: Note[] = []; const errors: string[] = [];
    const root = join(this.queueDir(queueId), "notes");
    for (const step of this.reader.dirs(root)) {
      for (const f of this.reader.names(join(root, step)).filter((n) => n.endsWith(".md"))) {
        const file = join(root, step, f);
        try {
          const { meta, body } = this.reader.parsed(file, parseFrontMatter);
          notes.push({ ...NoteMeta.parse(meta), queue: queueId, body });
        } catch (e) { errors.push(`${file}: ${(e as Error).message}`); }
      }
    }
    return { notes: notes.sort((a, b) => a.at.localeCompare(b.at)), errors };
  }

  writeNote(queueId: string, meta: NoteMeta, body: string): string {
    const file = join(this.queueDir(queueId), "notes", meta.step, `${meta.id}.md`);
    writeFileAtomic(file, `---\n${YAML.stringify(NoteMeta.parse(meta)).trimEnd()}\n---\n${body.trimEnd()}\n`);
    return file;
  }

  // sessions
  sessionDir(id: string): string { return join(this.dir, "sessions", id); }
  sessionIds(): string[] { return this.reader.dirs(join(this.dir, "sessions")).filter((s) => this.reader.has(join(this.sessionDir(s), "session.yaml"))); }
  readSession(id: string): SessionFile { return this.yaml(join(this.sessionDir(id), "session.yaml"), SessionFile); }
  /** Whether the session has a session.yaml (readable or not: readSession tells). */
  hasSession(id: string): boolean { return this.reader.has(join(this.sessionDir(id), "session.yaml")); }
  writeSession(s: SessionFile): void { writeYaml(join(this.sessionDir(s.id), "session.yaml"), SessionFile.parse(s)); }

  // The logs other writers append to and this process reads: what it stamps afterwards comes after their times
  // (clock.ts). Within a log, a reader keeps the order the lines were written in (state.ts, inFileOrder).
  readEvents(sessionId: string): JsonlRead<Event> { return this.reader.jsonl(join(this.sessionDir(sessionId), "events.jsonl"), Event, true); }
  appendEvent(e: Event): void { appendJsonl(join(this.sessionDir(e.session), "events.jsonl"), Event.parse(e)); }

  readInbox(sessionId: string): JsonlRead<InboxEntry> { return this.reader.jsonl(join(this.sessionDir(sessionId), "inbox.jsonl"), InboxEntry, true); }
  appendInbox(sessionId: string, entry: InboxEntry): void {
    appendJsonl(join(this.sessionDir(sessionId), "inbox.jsonl"), InboxEntry.parse(entry));
  }

  // server-owned runtime files
  readGit(queueId: string): GitFile | undefined {
    const f = join(this.queueDir(queueId), "git.yaml");
    return this.reader.has(f) ? this.yaml(f, GitFile) : undefined;
  }
  writeGit(queueId: string, g: GitFile): void { writeYaml(join(this.queueDir(queueId), "git.yaml"), GitFile.parse(g)); }
  readPush(queueId: string): PushFile | undefined {
    const f = join(this.queueDir(queueId), "push.yaml");
    return this.reader.has(f) ? this.yaml(f, PushFile) : undefined;
  }
  writePush(queueId: string, p: PushFile): void { writeYaml(join(this.queueDir(queueId), "push.yaml"), PushFile.parse(p)); }
  /** The checks Nexus ran (checks.yaml; one writer: the server's engine). */
  readChecks(queueId: string): ChecksFile | undefined {
    const f = join(this.queueDir(queueId), "checks.yaml");
    return this.reader.has(f) ? this.yaml(f, ChecksFile) : undefined;
  }
  writeChecks(queueId: string, c: ChecksFile): void { writeYaml(join(this.queueDir(queueId), "checks.yaml"), ChecksFile.parse(c)); }
  readStart(queueId: string): StartFile | undefined {
    const f = join(this.queueDir(queueId), "start.yaml");
    return this.reader.has(f) ? this.yaml(f, StartFile) : undefined;
  }
  writeStart(queueId: string, s: StartFile): void { writeYaml(join(this.queueDir(queueId), "start.yaml"), StartFile.parse(s)); }
  clearStart(queueId: string): void {
    removeFile(join(this.queueDir(queueId), "start.yaml"));
  }
  readPlan(queueId: string): PlanFile | undefined {
    const f = join(this.queueDir(queueId), "plan.yaml");
    return this.reader.has(f) ? this.yaml(f, PlanFile) : undefined;
  }
  writePlan(queueId: string, p: PlanFile): void { writeYaml(join(this.queueDir(queueId), "plan.yaml"), PlanFile.parse(p)); }
  clearPlan(queueId: string): void {
    removeFile(join(this.queueDir(queueId), "plan.yaml"));
  }
  /**
   * Moves the chains of before the plan into it: a start.yaml with `after` (one queue it waited for) becomes a
   * plan.yaml with that predecessor, set by whoever made the chain, and the start.yaml keeps the start's options. Run by
   * the server at its start; returns the queues moved.
   */
  migrateChains(): string[] {
    const moved: string[] = [];
    for (const id of this.queueIds()) {
      let start: StartFile | undefined;
      try { start = this.readStart(id); } catch { continue; }
      const plan = chainPlan(start, now());
      if (!start || !plan) continue;
      const { after: _after, ...rest } = start;
      if (!this.readPlan(id)) this.writePlan(id, plan);
      this.writeStart(id, rest);
      moved.push(id);
    }
    return moved;
  }
  /** The user's decisions on matching earlier queues to the notes (ideas-read.ts); none when the file is missing. */
  readIdeaMatches(): IdeaMatchesFile {
    const f = join(this.dir, "idea-matches.yaml");
    return this.reader.has(f) ? this.yaml(f, IdeaMatchesFile) : IdeaMatchesFile.parse({ protocol: 1 });
  }
  /** Written only by the server, from the user's action (actions.ts, decideIdeaMatches). */
  writeIdeaMatches(m: IdeaMatchesFile): void { writeYaml(join(this.dir, "idea-matches.yaml"), IdeaMatchesFile.parse(m)); }

  readIdeaStatuses(): IdeaStatusesFile {
    const f = join(this.dir, "idea-statuses.yaml");
    return this.reader.has(f) ? this.yaml(f, IdeaStatusesFile) : IdeaStatusesFile.parse({ protocol: 1 });
  }
  /** Only the server writes status decisions and observed assessment invalidations. */
  writeIdeaStatuses(value: IdeaStatusesFile): void { writeYaml(join(this.dir, "idea-statuses.yaml"), IdeaStatusesFile.parse(value)); }

  readIdeaHandoffs(): IdeaHandoffsFile {
    const file = join(this.dir, "idea-handoffs.yaml");
    return this.reader.has(file) ? this.yaml(file, IdeaHandoffsFile) : { protocol: 1, records: [] };
  }
  /** Only the server writes direct idea handoffs; never a partner's events. */
  writeIdeaHandoffs(value: IdeaHandoffsFile): void { writeYaml(join(this.dir, "idea-handoffs.yaml"), IdeaHandoffsFile.parse(value)); }

  /** The project's tag lists (.nexus/tags.yaml); empty lists while the file does not exist. */
  readTags(): TagsFile {
    const f = join(this.dir, "tags.yaml");
    return this.reader.has(f) ? this.yaml(f, TagsFile) : TagsFile.parse({ protocol: 1 });
  }
  /** Written only by the server (tags.ts). */
  writeTags(t: TagsFile): void { writeYaml(join(this.dir, "tags.yaml"), TagsFile.parse(t)); }
  /** The recurring queues' ids (.nexus/recurring/<id>.yaml). */
  recurringIds(): string[] {
    const d = join(this.dir, "recurring");
    return this.reader.has(d) ? this.reader.names(d).filter((f) => f.endsWith(".yaml")).map((f) => f.slice(0, -5)).sort() : [];
  }
  readRecurring(id: string): RecurringFile | undefined {
    const f = join(this.dir, "recurring", `${id}.yaml`);
    return this.reader.has(f) ? this.yaml(f, RecurringFile) : undefined;
  }
  /** Written only by the server (apps/server/src/recurring.ts). */
  writeRecurring(r: RecurringFile): void {
    writeYaml(join(this.dir, "recurring", `${r.id}.yaml`), RecurringFile.parse(r));
  }
  clearRecurring(id: string): void {
    removeFile(join(this.dir, "recurring", `${id}.yaml`));
  }
  /** The server's note on the static analysis reminder (.nexus/static-analysis.yaml); empty while there is none. */
  readStaticAnalysisNote(): StaticAnalysisNote {
    const f = join(this.dir, "static-analysis.yaml");
    return this.reader.has(f) ? this.yaml(f, StaticAnalysisNote) : StaticAnalysisNote.parse({ protocol: 1 });
  }
  /** Written only by the server (apps/server/src/static-reminder.ts). */
  writeStaticAnalysisNote(n: StaticAnalysisNote): void { writeYaml(join(this.dir, "static-analysis.yaml"), StaticAnalysisNote.parse(n)); }
  /** The project's metrics (.nexus/metrics.yaml); none while the file does not exist. */
  readMetrics(): MetricsFile {
    const f = join(this.dir, "metrics.yaml");
    return this.reader.has(f) ? this.yaml(f, MetricsFile) : MetricsFile.parse({ protocol: 1 });
  }
  /** Written only by the server (metric-define.ts). */
  writeMetrics(m: MetricsFile): void { writeYaml(join(this.dir, "metrics.yaml"), MetricsFile.parse(m)); }
  readRun(queueId: string): RunFile | undefined {
    const f = join(this.queueDir(queueId), "run.yaml");
    return this.reader.has(f) ? this.yaml(f, RunFile) : undefined;
  }
  writeRun(queueId: string, run: RunFile): void { writeYaml(join(this.queueDir(queueId), "run.yaml"), RunFile.parse(run)); }
  /**
   * Keeps a run record that is over beside the queue as run.<time>.yaml (the time of archiving, with `-` for `:` and
   * `.`), so the next start begins afresh. Returns the archive's file name, or undefined when there was no run.
   */
  archiveRun(queueId: string): string | undefined {
    const f = join(this.queueDir(queueId), "run.yaml");
    if (!existsSync(f)) return undefined;
    const name = `run.${new Date().toISOString().replace(/[:.]/g, "-")}.yaml`;
    renameRetrying(f, join(this.queueDir(queueId), name));
    return name;
  }
  clearRun(queueId: string): void {
    removeFile(join(this.queueDir(queueId), "run.yaml"));
  }

  readDelivered(sessionId: string): JsonlRead<Delivery> { return this.reader.jsonl(join(this.sessionDir(sessionId), "delivered.jsonl"), Delivery, false); }
  appendDelivered(sessionId: string, d: Delivery): void { appendJsonl(join(this.sessionDir(sessionId), "delivered.jsonl"), Delivery.parse(d)); }

  readActivity(sessionId: string): JsonlRead<Activity> { return this.reader.jsonl(join(this.sessionDir(sessionId), "activity.jsonl"), Activity, false); }
  appendActivity(sessionId: string, a: Activity): void { appendJsonl(join(this.sessionDir(sessionId), "activity.jsonl"), Activity.parse(a)); }
  /**
   * When a session's log was last written (ms), undefined when it has none: a reader of its recent lines (the digest)
   * leaves a log alone that was not written since, without reading it (queue AQ).
   */
  logModified(sessionId: string, log: "activity" | "refusals"): number | undefined {
    return this.reader.modified(join(this.sessionDir(sessionId), `${log}.jsonl`));
  }
  readRefusals(sessionId: string): JsonlRead<Refusal> { return this.reader.jsonl(join(this.sessionDir(sessionId), "refusals.jsonl"), Refusal, false); }
  appendRefusal(r: Refusal): void { appendJsonl(join(this.sessionDir(r.session), "refusals.jsonl"), Refusal.parse(r)); }

  readApplied(sessionId: string): JsonlRead<Applied> { return this.reader.jsonl(join(this.sessionDir(sessionId), "applied.jsonl"), Applied, true); }

  /**
   * The server's clock mark for the CLI (`.nexus/clock.json`, one writer: the server), written before the server hands
   * an agent anything to act on: the agent's `nexus` then stamps its records after everything the server had seen.
   */
  writeClock(): void {
    const at = clockMark();
    if (!at) return;
    writeFileAtomic(join(this.dir, "clock.json"), `${JSON.stringify({ protocol: 1, at })}\n`);
  }
  /** Takes up the server's clock mark (a missing file: none, as before the file existed; an unreadable one: none, warned). */
  observeClock(): void {
    const f = join(this.dir, "clock.json");
    observe(orDefault(f, () => (JSON.parse(readText(f)) as { at?: string }).at, undefined));
  }
  appendApplied(sessionId: string, a: Applied): void { appendJsonl(join(this.sessionDir(sessionId), "applied.jsonl"), Applied.parse(a)); }

  readChat(sessionId: string): JsonlRead<ChatEntry> { return this.reader.jsonl(join(this.sessionDir(sessionId), "chat.jsonl"), ChatEntry, false); }
  appendChat(sessionId: string, c: z.input<typeof ChatEntry>): void { appendJsonl(join(this.sessionDir(sessionId), "chat.jsonl"), ChatEntry.parse(c)); }

  /** The chat's pinned messages (none when the file is missing; unreadable: none, warned). Written only by the server. */
  readPins(sessionId: string, warn?: Warn): PinsFile {
    const f = join(this.sessionDir(sessionId), "pins.json");
    return orDefault(f, () => this.reader.has(f) ? PinsFile.parse(this.reader.parsed(f, JSON.parse)) : { pins: [] }, { pins: [] }, warn);
  }
  writePins(sessionId: string, p: PinsFile): void {
    writeFileAtomic(join(this.sessionDir(sessionId), "pins.json"), JSON.stringify(PinsFile.parse(p)));
  }

  /** The session's runtime record (none when the file is missing; unreadable: none, warned). */
  readRuntime(sessionId: string, warn?: Warn): RuntimeFile | undefined {
    const f = join(this.sessionDir(sessionId), "runtime.json");
    return orDefault(f, () => this.reader.has(f) ? RuntimeFile.parse(this.reader.parsed(f, JSON.parse)) : undefined, undefined, warn);
  }
  writeRuntime(sessionId: string, r: RuntimeFile): void {
    writeFileAtomic(join(this.sessionDir(sessionId), "runtime.json"), JSON.stringify(RuntimeFile.parse(r)));
  }
}

// ---------------------------------------------------------------- account-wide usage

const turnsFile = (env: NodeJS.ProcessEnv = process.env) => join(nexusHome(env), "turns.jsonl");
/** One line per agent turn of every project (TurnRecord). Written only by the server (AgentHost). */
export function appendTurn(r: TurnRecord): void { mkdirSync(nexusHome(), { recursive: true }); appendJsonl(turnsFile(), TurnRecord.parse(r)); }
export function readTurns(env: NodeJS.ProcessEnv = process.env): JsonlRead<TurnRecord> { return home.jsonl(turnsFile(env), TurnRecord, false); }

// ---------------------------------------------------------------- the server's speed (queue SB)

/** <NEXUS_HOME>/benchmarks/server-speed.jsonl: the runs of scripts/server-speed.ts, its one writer. */
export const serverSpeedFile = () => join(nexusHome(), "benchmarks", "server-speed.jsonl");
/** Appends a run (to `file`, default serverSpeedFile()); written only by scripts/server-speed.ts. */
export function appendServerSpeed(run: ServerSpeedRun, file = serverSpeedFile()): void { appendJsonl(file, ServerSpeedRun.parse(run)); }
/**
 * The runs, oldest first as appended; a line that does not parse is skipped and said in `errors`. Read from the disk
 * each time, not through NEXUS_HOME's model: the file is small, read only when asked, and outside what the server
 * watches (its watcher sees NEXUS_HOME's own files, not its subfolders).
 */
export function readServerSpeed(file = serverSpeedFile()): JsonlRead<ServerSpeedRun> { return readJsonl(file, ServerSpeedRun); }

// ---------------------------------------------------------------- global settings

const globalSettingsFile = (env: NodeJS.ProcessEnv = process.env) => join(nexusHome(env), "settings.yaml");
/** The global settings (<NEXUS_HOME>/settings.yaml); the built-in defaults while the file does not exist. */
export function readGlobalSettings(env: NodeJS.ProcessEnv = process.env): GlobalSettings {
  const f = globalSettingsFile(env);
  return home.has(f) ? GlobalSettings.parse(home.parsed(f, YAML.parse)) : builtInSettings();
}
/**
 * <NEXUS_HOME>/limits.json: where the limit on queues running at once was kept before it became a global setting
 * (`defaults.max_running`, decided 2026-11-15, queue OP). It stays, as a copy the server writes with every change of
 * the global settings, so that an older server (an update rolled back) still reads the current limit.
 */
const limitsFile = () => join(nexusHome(), "limits.json");
/** The limit limits.json holds, if it holds a valid one (an unreadable file: none, warned). */
function legacyMaxRunning(): number | undefined {
  const f = limitsFile();
  return orDefault(f, () => MaxRunning.safeParse((JSON.parse(readText(f)) as { max_running?: unknown }).max_running).data, undefined);
}

/** Written only by the server; limits.json gets the limit's copy (see limitsFile). */
export function writeGlobalSettings(g: GlobalSettings): void {
  const parsed = GlobalSettings.parse(g);
  writeYaml(globalSettingsFile(), parsed);
  writeJson(limitsFile(), { max_running: parsed.defaults.max_running });
}
/**
 * At the server's start: the global settings file exists, the first time with the built-in defaults. A settings file
 * without `defaults.max_running` (from before it, or rewritten by an older server) takes the limit from limits.json.
 */
export function ensureGlobalSettings(): GlobalSettings {
  const f = globalSettingsFile();
  const raw = exists(f) ? (YAML.parse(readText(f)) as { defaults?: { max_running?: unknown } } | null) : undefined;
  const g = readGlobalSettings();
  if (raw?.defaults?.max_running !== undefined) return g;
  const legacy = legacyMaxRunning();
  const next = legacy === undefined ? g : { ...g, defaults: { ...g.defaults, max_running: legacy } };
  writeGlobalSettings(next);
  return next;
}

const awayFile = (env: NodeJS.ProcessEnv = process.env) => join(nexusHome(env), "away.yaml");
/** The away mode (missing: never turned on; unreadable: off, warned). */
export function readAway(env: NodeJS.ProcessEnv = process.env, warn?: Warn): AwayFile {
  const f = awayFile(env);
  const off = AwayFile.parse({ protocol: 1 });
  return orDefault(f, () => home.has(f) ? AwayFile.parse(home.parsed(f, YAML.parse)) : off, off, warn);
}
/** Only the server writes it, from the user's action or at its end (away.ts). */
export function writeAway(a: AwayFile): void {
  mkdirSync(nexusHome(), { recursive: true });
  writeYaml(awayFile(), AwayFile.parse(a));
}

const capacityFile = (env: NodeJS.ProcessEnv = process.env) => join(nexusHome(env), "capacity.yaml");
/** The capacity coordinator's state; undefined when there is none, or it cannot be read (warned; nothing is shown then). */
export function readCapacity(env: NodeJS.ProcessEnv = process.env): CapacityFile | undefined {
  const f = capacityFile(env);
  return orDefault(f, () => exists(f) ? readYaml(f, CapacityFile) : undefined, undefined);
}
/** Only the server writes it (apps/server/src/capacity.ts). */
export function writeCapacity(c: CapacityFile): void {
  mkdirSync(nexusHome(), { recursive: true });
  writeYaml(capacityFile(), CapacityFile.parse(c));
}

const usageFile = () => join(nexusHome(), "usage.json");
/** The usage windows; undefined when the file is missing, or cannot be read (warned). */
export function readUsage(): UsageFile | undefined {
  const f = usageFile();
  return orDefault(f, () => exists(f) ? UsageFile.parse(JSON.parse(readText(f))) : undefined, undefined);
}
export function writeUsage(u: UsageFile): void {
  writeFileAtomic(usageFile(), JSON.stringify(UsageFile.parse(u)));
}

function subdirs(dir: string): string[] {
  if (!exists(dir)) return [];
  work.listings++;
  return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
}

function parseFrontMatter(text: string): { meta: unknown; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) throw new Error("missing front matter");
  return { meta: YAML.parse(m[1] ?? ""), body: (m[2] ?? "").trim() };
}

// ---------------------------------------------------------------- revision hash

/**
 * The hash an approval pins: steps (without baseline state), stop conditions and checks, `coding`, and the queue's
 * defaults for its steps (its tags, runtime, model, effort and fallback), and the note references of its `source`. A
 * step's drafted review level and tags are part of it; the levels the user set (`user_levels`), the queue's own level
 * and the file it was imported from are not.
 */
export function revisionHash(q: HashedQueue): string {
  return hashOf(q.steps.map(({ status: _s, status_note: _n, ...def }) => def), q);
}
/** The queue's defaults for its steps: its tags, and its runtime, model, effort and fallback. */
const STEP_DEFAULTS = ["kind", "activities", "area", "size", "origin", "runtime", "model", "effort", "fallback"] as const;
type HashedQueue = Pick<QueueFile, "steps" | "stop_conditions" | "checks" | "coding"> & Partial<Pick<QueueFile, (typeof STEP_DEFAULTS)[number] | "maintenance" | "source">>;
// `coding` counts only when true, and a queue's tags and its runtime, model, effort and fallback only when set, so the
// hash of a queue without them is what it was before those fields (a step's left out is not in its JSON either). So do
// note references: an imported queue's source (the file it was read from) never counts.
const hashOf = (steps: unknown[], q: Omit<HashedQueue, "steps">) =>
  "sha256:" + createHash("sha256").update(JSON.stringify({
    steps, stop_conditions: q.stop_conditions, checks: q.checks, ...(q.coding ? { coding: true } : {}),
    ...(q.maintenance ? { maintenance: q.maintenance } : {}),
    ...Object.fromEntries(STEP_DEFAULTS.filter((k) => q[k] !== undefined).map((k) => [k, q[k]])),
    ...(noteRefs(q.source).length ? { source: noteRefs(q.source) } : {}),
  })).digest("hex");

/**
 * The hash a queue had before review levels, when its steps still carried a review `policy` (continue, wait or
 * orchestrator): the same content with each step's review written as it was then. Undefined when no step has one.
 */
function legacyRevisionHash(raw: unknown, q: QueueFile): string | undefined {
  const rawSteps = raw && typeof raw === "object" && Array.isArray((raw as { steps?: unknown }).steps) ? (raw as { steps: unknown[] }).steps : [];
  const policyOf = (i: number) => {
    const r = (rawSteps[i] as { review?: { policy?: unknown } } | undefined)?.review;
    return r && typeof r === "object" && typeof r.policy === "string" ? r.policy : undefined;
  };
  if (!rawSteps.some((_, i) => policyOf(i) !== undefined)) return undefined;
  return hashOf(q.steps.map(({ status: _s, status_note: _n, ...def }, i) => {
    const policy = policyOf(i);
    if (policy === undefined || !def.review) return def;
    const { level: _l, ...review } = def.review;
    return { ...def, review: { ...review, policy } }; // the old key order: prepare, rounds, policy
  }), q);
}

/**
 * Parses queue.yaml as read. A file from before review levels reads in the present form: old review policies become
 * levels (schemas.ts, withLevel), and an approval that pinned the old form of the same content pins the new form, so
 * an approved queue stays approved (`continue` and `orchestrator` became level 2, `wait` level 1). The file is written
 * in the new form at its next write.
 */
function parseQueue(raw: unknown): QueueFile {
  const parsed = QueueFile.parse(raw);
  const q = parsed.legacy_policies ? parsed : { ...parsed, legacy_policies: legacyPolicies(raw) };
  const legacy = legacyRevisionHash(raw, q);
  if (legacy === undefined) return q;
  const hash = revisionHash(q);
  return { ...q, approvals: q.approvals.map((a) => (a.revision === q.revision && a.hash === legacy ? { ...a, hash } : a)) };
}

/**
 * The review policy each step of a queue.yaml from before review levels had (its own, else its queue's), by step id;
 * undefined for a file without the old fields. Steps done before the project's review_levels_since are derived by it.
 */
function legacyPolicies(raw: unknown): Record<string, LegacyReviewPolicy> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as { review_policy?: unknown; steps?: unknown };
  const policy = (x: unknown) => (LegacyReviewPolicy.safeParse(x).success ? x as LegacyReviewPolicy : undefined);
  const out: Record<string, LegacyReviewPolicy> = {};
  for (const st of Array.isArray(r.steps) ? r.steps as { id?: unknown; review?: { policy?: unknown } }[] : []) {
    const p = policy(st?.review?.policy) ?? policy(r.review_policy);
    if (typeof st?.id === "string" && p) out[st.id] = p;
  }
  return Object.keys(out).length ? out : undefined;
}
