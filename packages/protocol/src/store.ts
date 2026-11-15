// Reading and writing a project's .nexus/ directory and the Nexus registry.
// Rules (docs/PROTOCOL.md): one writer per file, JSONL is append-only, YAML is replaced atomically.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { monotonicFactory } from "ulid";
import YAML from "yaml";
import type { z } from "zod";
import {
  Activity, Applied, AwayFile, ChatEntry, PinsFile, Refusal, Delivery, Event, GlobalSettings, InboxEntry, MaxRunning, MetricsFile, NoteMeta, GitFile, ProjectFile, PushFile, QueueFile, type QueueInput, LegacyReviewPolicy, RegistryFile, RunFile, RuntimeFile, SessionFile, StartFile, PlanFile, StoredProject, TagsFile, TurnRecord, UsageFile,
  type Note,
} from "./schemas.ts";
import { applyChange, builtInSettings, effectiveProject, migrateStored, storedFrom } from "./settings.ts";

const NEXUS_DIRNAME = ".nexus";

const nextUlid = monotonicFactory();
export const newId = (): string => nextUlid();
export const now = (): string => new Date().toISOString();

/** Forward slashes, absolute. Every path stored in protocol files uses this form. */
export function normPath(p: string, base = process.cwd()): string {
  return (isAbsolute(p) ? p : resolve(base, p)).replaceAll("\\", "/");
}

// ---------------------------------------------------------------- generic file helpers

function readYaml<S extends z.ZodType>(file: string, schema: S): z.infer<S> {
  return schema.parse(YAML.parse(readFileSync(file, "utf8")));
}

/**
 * The writes this process has made through this module (and a note's withdrawal, actions.ts): a project state built
 * since the last one is still current as far as this process is concerned, so the server passes one snapshot on until
 * it writes (apps/server/src/main.ts, stateOf). Another process's writes (an agent's `nexus`) reach the server through
 * its file watcher instead.
 */
let writes = 0;
export const writeCount = (): number => writes;
/** Counts a write made outside this module's helpers. */
export const countWrite = (): void => { writes++; };

/** How long a rename is tried again while Windows refuses it (see renameRetrying). */
const RENAME_RETRY_MS = 2_000;

/**
 * renameSync, tried again while Windows refuses it for a moment. Windows does not replace (or move) a file that
 * another process has open, even only for reading: the rename fails with EPERM (or EACCES, EBUSY) until that process
 * closes it. A reader in another process is ordinary here (an agent's `nexus` CLI, a test, the other server of an
 * update, the search indexer or an antivirus). Measured on 2026-11-13: a rename onto a file another Node process held
 * open failed with EPERM and went through once it was closed. Tried again after 5, 10, 20, … ms (at most 200 ms
 * apart) for up to RENAME_RETRY_MS; then the last error is thrown. Synchronous, like the writes it serves.
 */
export function renameRetrying(from: string, to: string): void {
  const start = Date.now();
  for (let wait = 5; ; wait = Math.min(wait * 2, 200)) {
    try { renameSync(from, to); writes++; return; }
    catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if ((code !== "EPERM" && code !== "EACCES" && code !== "EBUSY") || Date.now() - start >= RENAME_RETRY_MS) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
    }
  }
}

/** Atomic replace: write a temporary file next to the target, then rename it over the target. */
export function writeYaml(file: string, data: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, YAML.stringify(data, { lineWidth: 120 }), "utf8");
  renameRetrying(tmp, file);
}

/** A JSONL file read: its valid entries, and for each the index of its line in the file (from 0); what was wrong. */
export interface JsonlRead<T> { entries: T[]; lines: number[]; errors: string[] }

/** Reads a JSONL log. A final line without a newline is still being written and is skipped. */
export function readJsonl<S extends z.ZodType>(file: string, schema: S): JsonlRead<z.infer<S>> {
  const out: JsonlRead<z.infer<S>> = { entries: [], lines: [], errors: [] };
  if (!existsSync(file)) return out;
  const text = readFileSync(file, "utf8");
  const complete = text.endsWith("\n") ? text : text.slice(0, text.lastIndexOf("\n") + 1);
  complete.split("\n").forEach((line, i) => {
    if (!line.trim()) return;
    try {
      const r = schema.safeParse(JSON.parse(line));
      if (r.success) { out.entries.push(r.data); out.lines.push(i); }
      else out.errors.push(`${file}:${i + 1}: ${r.error.issues.map((x) => `${x.path.join(".")} ${x.message}`).join("; ")}`);
    } catch (e) {
      out.errors.push(`${file}:${i + 1}: ${(e as Error).message}`);
    }
  });
  return out;
}

/** One complete line in a single write. */
function appendJsonl(file: string, entry: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify(entry) + "\n", "utf8");
  writes++;
}

// ---------------------------------------------------------------- registry

export function nexusHome(): string {
  return process.env.NEXUS_HOME ?? join(process.env.APPDATA ?? join(homedir(), ".config"), "Nexus");
}
const registryFile = () => join(nexusHome(), "projects.yaml");

export function readRegistry(): RegistryFile {
  const f = registryFile();
  return existsSync(f) ? readYaml(f, RegistryFile) : { protocol: 1, projects: [] };
}
export function writeRegistry(r: RegistryFile): void {
  writeYaml(registryFile(), r);
}

// ---------------------------------------------------------------- locating a project's .nexus/

/**
 * Finds the .nexus directory for a working directory: walking up from it, then (for a worktree outside the main
 * checkout) the main checkout of its git repository.
 */
export function findNexusDir(cwd = process.cwd()): string | null {
  for (let d = resolve(cwd); ; d = dirname(d)) {
    if (existsSync(join(d, NEXUS_DIRNAME, "project.yaml"))) return normPath(join(d, NEXUS_DIRNAME));
    if (dirname(d) === d) break;
  }
  try {
    const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const main = dirname(common);
    if (existsSync(join(main, NEXUS_DIRNAME, "project.yaml"))) return normPath(join(main, NEXUS_DIRNAME));
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
  constructor(nexusDir: string) { this.dir = normPath(nexusDir); }

  static forRoot(root: string): ProjectStore { return new ProjectStore(join(root, NEXUS_DIRNAME)); }

  /** Creates .nexus/ with a .gitignore that ignores the directory itself, so the project's own .gitignore is untouched. */
  /**
   * Creates .nexus/ with a .gitignore that ignores the directory itself, so the project's own .gitignore is untouched.
   * The settings given are the project's own values; every other setting follows the global one.
   */
  static init(root: string, project: Omit<z.input<typeof StoredProject>, "protocol" | "follows_global">): ProjectStore {
    const store = ProjectStore.forRoot(root);
    mkdirSync(join(store.dir, "queues"), { recursive: true });
    mkdirSync(join(store.dir, "sessions"), { recursive: true });
    writeFileSync(join(store.dir, ".gitignore"), "*\n", "utf8");
    writes++;
    if (!existsSync(store.projectFile)) store.writeStoredProject(StoredProject.parse({ protocol: 1, follows_global: true, ...project }));
    return store;
  }

  get projectFile(): string { return join(this.dir, "project.yaml"); }
  /** The project's effective settings: its own values where it has them, else the global ones (src/settings.ts). */
  readProject(): ProjectFile { return effectiveProject(this.readStoredProject(), readGlobalSettings()); }
  /** project.yaml as stored: project-only settings, state and the project's own values (overrides). */
  readStoredProject(): StoredProject { return readYaml(this.projectFile, StoredProject); }
  writeStoredProject(p: StoredProject): void { writeYaml(this.projectFile, StoredProject.parse(p)); }
  /**
   * Changes the project's effective settings, keeping "follows" and "own value" apart (settings.ts, applyChange): a
   * setting the change gives another value becomes the project's own; one it leaves alone keeps its state; those in
   * `follow` follow the global value again. Every writer of project.yaml goes through this.
   */
  updateProject(change: (p: ProjectFile) => ProjectFile, follow: readonly string[] = [], own: readonly string[] = []): ProjectFile {
    const global = readGlobalSettings();
    const stored = applyChange(this.readStoredProject(), global, change(this.readProject()), follow, own);
    this.writeStoredProject(stored);
    return effectiveProject(stored, global);
  }
  /**
   * Stores whole effective settings by the migration's rule: a value equal to the global one follows it, a different
   * one becomes the project's own (settings.ts, storedFrom). For setting up a project or a test; a change of some
   * settings goes through updateProject, which keeps an own value that happens to equal the global one.
   */
  writeProject(p: ProjectFile): void { this.writeStoredProject(storedFrom(p, readGlobalSettings())); }
  /**
   * Turns a project.yaml from before global settings into the stored form, once (settings.ts, migrateStored): values
   * equal to the global ones follow them, different ones become the project's own; effective settings do not change.
   * Writes only when the file is not migrated yet; returns whether it wrote.
   */
  migrateProject(): boolean {
    const migrated = migrateStored(YAML.parse(readFileSync(this.projectFile, "utf8")), readGlobalSettings());
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
  queueIds(): string[] { return subdirs(join(this.dir, "queues")).filter((q) => existsSync(join(this.queueDir(q), "queue.yaml"))); }
  /** queue.yaml in the present form (parseQueue: old review policies read as levels, their approvals kept). */
  readQueue(id: string): QueueFile { return parseQueue(YAML.parse(readFileSync(join(this.queueDir(id), "queue.yaml"), "utf8"))); }
  writeQueue(q: QueueInput): void { writeYaml(join(this.queueDir(q.id), "queue.yaml"), QueueFile.parse(q)); }

  readNotes(queueId: string): { notes: Note[]; errors: string[] } {
    const notes: Note[] = []; const errors: string[] = [];
    const root = join(this.queueDir(queueId), "notes");
    for (const step of subdirs(root)) {
      for (const f of readdirSync(join(root, step)).filter((n) => n.endsWith(".md"))) {
        const file = join(root, step, f);
        try {
          const { meta, body } = parseFrontMatter(readFileSync(file, "utf8"));
          notes.push({ ...NoteMeta.parse(meta), queue: queueId, body });
        } catch (e) { errors.push(`${file}: ${(e as Error).message}`); }
      }
    }
    return { notes: notes.sort((a, b) => a.at.localeCompare(b.at)), errors };
  }

  writeNote(queueId: string, meta: NoteMeta, body: string): string {
    const file = join(this.queueDir(queueId), "notes", meta.step, `${meta.id}.md`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `---\n${YAML.stringify(NoteMeta.parse(meta)).trimEnd()}\n---\n${body.trimEnd()}\n`, "utf8");
    writes++;
    return file;
  }

  // sessions
  sessionDir(id: string): string { return join(this.dir, "sessions", id); }
  sessionIds(): string[] { return subdirs(join(this.dir, "sessions")).filter((s) => existsSync(join(this.sessionDir(s), "session.yaml"))); }
  readSession(id: string): SessionFile { return readYaml(join(this.sessionDir(id), "session.yaml"), SessionFile); }
  writeSession(s: SessionFile): void { writeYaml(join(this.sessionDir(s.id), "session.yaml"), SessionFile.parse(s)); }

  readEvents(sessionId: string): JsonlRead<Event> { return readJsonl(join(this.sessionDir(sessionId), "events.jsonl"), Event); }
  appendEvent(e: Event): void { appendJsonl(join(this.sessionDir(e.session), "events.jsonl"), Event.parse(e)); }

  readInbox(sessionId: string): JsonlRead<InboxEntry> { return readJsonl(join(this.sessionDir(sessionId), "inbox.jsonl"), InboxEntry); }
  appendInbox(sessionId: string, entry: InboxEntry): void {
    appendJsonl(join(this.sessionDir(sessionId), "inbox.jsonl"), InboxEntry.parse(entry));
  }

  // server-owned runtime files
  readGit(queueId: string): GitFile | undefined {
    const f = join(this.queueDir(queueId), "git.yaml");
    return existsSync(f) ? readYaml(f, GitFile) : undefined;
  }
  writeGit(queueId: string, g: GitFile): void { writeYaml(join(this.queueDir(queueId), "git.yaml"), GitFile.parse(g)); }
  readPush(queueId: string): PushFile | undefined {
    const f = join(this.queueDir(queueId), "push.yaml");
    return existsSync(f) ? readYaml(f, PushFile) : undefined;
  }
  writePush(queueId: string, p: PushFile): void { writeYaml(join(this.queueDir(queueId), "push.yaml"), PushFile.parse(p)); }
  readStart(queueId: string): StartFile | undefined {
    const f = join(this.queueDir(queueId), "start.yaml");
    return existsSync(f) ? readYaml(f, StartFile) : undefined;
  }
  writeStart(queueId: string, s: StartFile): void { writeYaml(join(this.queueDir(queueId), "start.yaml"), StartFile.parse(s)); }
  clearStart(queueId: string): void {
    const f = join(this.queueDir(queueId), "start.yaml");
    if (existsSync(f)) { unlinkSync(f); writes++; }
  }
  readPlan(queueId: string): PlanFile | undefined {
    const f = join(this.queueDir(queueId), "plan.yaml");
    return existsSync(f) ? readYaml(f, PlanFile) : undefined;
  }
  writePlan(queueId: string, p: PlanFile): void { writeYaml(join(this.queueDir(queueId), "plan.yaml"), PlanFile.parse(p)); }
  clearPlan(queueId: string): void {
    const f = join(this.queueDir(queueId), "plan.yaml");
    if (existsSync(f)) { unlinkSync(f); writes++; }
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
  /** The project's tag lists (.nexus/tags.yaml); empty lists while the file does not exist. */
  readTags(): TagsFile {
    const f = join(this.dir, "tags.yaml");
    return existsSync(f) ? readYaml(f, TagsFile) : TagsFile.parse({ protocol: 1 });
  }
  /** Written only by the server (tags.ts). */
  writeTags(t: TagsFile): void { writeYaml(join(this.dir, "tags.yaml"), TagsFile.parse(t)); }
  /** The project's metrics (.nexus/metrics.yaml); none while the file does not exist. */
  readMetrics(): MetricsFile {
    const f = join(this.dir, "metrics.yaml");
    return existsSync(f) ? readYaml(f, MetricsFile) : MetricsFile.parse({ protocol: 1 });
  }
  /** Written only by the server (metric-define.ts). */
  writeMetrics(m: MetricsFile): void { writeYaml(join(this.dir, "metrics.yaml"), MetricsFile.parse(m)); }
  readRun(queueId: string): RunFile | undefined {
    const f = join(this.queueDir(queueId), "run.yaml");
    return existsSync(f) ? readYaml(f, RunFile) : undefined;
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
    const f = join(this.queueDir(queueId), "run.yaml");
    if (existsSync(f)) { unlinkSync(f); writes++; }
  }

  readDelivered(sessionId: string): JsonlRead<Delivery> { return readJsonl(join(this.sessionDir(sessionId), "delivered.jsonl"), Delivery); }
  appendDelivered(sessionId: string, d: Delivery): void { appendJsonl(join(this.sessionDir(sessionId), "delivered.jsonl"), Delivery.parse(d)); }

  readActivity(sessionId: string): JsonlRead<Activity> { return readJsonl(join(this.sessionDir(sessionId), "activity.jsonl"), Activity); }
  appendActivity(sessionId: string, a: Activity): void { appendJsonl(join(this.sessionDir(sessionId), "activity.jsonl"), Activity.parse(a)); }
  readRefusals(sessionId: string): JsonlRead<Refusal> { return readJsonl(join(this.sessionDir(sessionId), "refusals.jsonl"), Refusal); }
  appendRefusal(r: Refusal): void { appendJsonl(join(this.sessionDir(r.session), "refusals.jsonl"), Refusal.parse(r)); }

  readApplied(sessionId: string): JsonlRead<Applied> { return readJsonl(join(this.sessionDir(sessionId), "applied.jsonl"), Applied); }
  appendApplied(sessionId: string, a: Applied): void { appendJsonl(join(this.sessionDir(sessionId), "applied.jsonl"), Applied.parse(a)); }

  readChat(sessionId: string): JsonlRead<ChatEntry> { return readJsonl(join(this.sessionDir(sessionId), "chat.jsonl"), ChatEntry); }
  appendChat(sessionId: string, c: z.input<typeof ChatEntry>): void { appendJsonl(join(this.sessionDir(sessionId), "chat.jsonl"), ChatEntry.parse(c)); }

  /** The chat's pinned messages (none when the file is missing or broken). Written only by the server. */
  readPins(sessionId: string): PinsFile {
    const f = join(this.sessionDir(sessionId), "pins.json");
    try { return existsSync(f) ? PinsFile.parse(JSON.parse(readFileSync(f, "utf8"))) : { pins: [] }; } catch { return { pins: [] }; }
  }
  writePins(sessionId: string, p: PinsFile): void {
    const f = join(this.sessionDir(sessionId), "pins.json");
    mkdirSync(dirname(f), { recursive: true });
    const tmp = `${f}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(PinsFile.parse(p)), "utf8");
    renameRetrying(tmp, f);
  }

  readRuntime(sessionId: string): RuntimeFile | undefined {
    const f = join(this.sessionDir(sessionId), "runtime.json");
    try { return existsSync(f) ? RuntimeFile.parse(JSON.parse(readFileSync(f, "utf8"))) : undefined; } catch { return undefined; }
  }
  writeRuntime(sessionId: string, r: RuntimeFile): void {
    const f = join(this.sessionDir(sessionId), "runtime.json");
    const tmp = `${f}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(RuntimeFile.parse(r)), "utf8");
    renameRetrying(tmp, f);
  }
}

// ---------------------------------------------------------------- account-wide usage

const turnsFile = () => join(nexusHome(), "turns.jsonl");
/** One line per agent turn of every project (TurnRecord). Written only by the server (AgentHost). */
export function appendTurn(r: TurnRecord): void { mkdirSync(nexusHome(), { recursive: true }); appendJsonl(turnsFile(), TurnRecord.parse(r)); }
export function readTurns(): JsonlRead<TurnRecord> { return readJsonl(turnsFile(), TurnRecord); }

// ---------------------------------------------------------------- global settings

const globalSettingsFile = () => join(nexusHome(), "settings.yaml");
/** The global settings (<NEXUS_HOME>/settings.yaml); the built-in defaults while the file does not exist. */
export function readGlobalSettings(): GlobalSettings {
  const f = globalSettingsFile();
  return existsSync(f) ? readYaml(f, GlobalSettings) : builtInSettings();
}
/**
 * <NEXUS_HOME>/limits.json: where the limit on queues running at once was kept before it became a global setting
 * (`defaults.max_running`, decided 2026-11-15, queue OP). It stays, as a copy the server writes with every change of
 * the global settings, so that an older server (an update rolled back) still reads the current limit.
 */
const limitsFile = () => join(nexusHome(), "limits.json");
/** The limit limits.json holds, if it holds a valid one. */
function legacyMaxRunning(): number | undefined {
  try {
    return MaxRunning.safeParse((JSON.parse(readFileSync(limitsFile(), "utf8")) as { max_running?: unknown }).max_running).data;
  } catch { return undefined; }
}

/** Written only by the server; limits.json gets the limit's copy (see limitsFile). */
export function writeGlobalSettings(g: GlobalSettings): void {
  const parsed = GlobalSettings.parse(g);
  writeYaml(globalSettingsFile(), parsed);
  const f = limitsFile();
  writeFileSync(`${f}.tmp`, `${JSON.stringify({ max_running: parsed.defaults.max_running }, null, 2)}\n`);
  renameRetrying(`${f}.tmp`, f);
}
/**
 * At the server's start: the global settings file exists, the first time with the built-in defaults. A settings file
 * without `defaults.max_running` (from before it, or rewritten by an older server) takes the limit from limits.json.
 */
export function ensureGlobalSettings(): GlobalSettings {
  const f = globalSettingsFile();
  const raw = existsSync(f) ? (YAML.parse(readFileSync(f, "utf8")) as { defaults?: { max_running?: unknown } } | null) : undefined;
  const g = readGlobalSettings();
  if (raw?.defaults?.max_running !== undefined) return g;
  const legacy = legacyMaxRunning();
  const next = legacy === undefined ? g : { ...g, defaults: { ...g.defaults, max_running: legacy } };
  writeGlobalSettings(next);
  return next;
}

const awayFile = () => join(nexusHome(), "away.yaml");
/** The away mode (missing: never turned on). */
export function readAway(): AwayFile {
  try { return existsSync(awayFile()) ? readYaml(awayFile(), AwayFile) : AwayFile.parse({ protocol: 1 }); } catch { return AwayFile.parse({ protocol: 1 }); }
}
/** Only the server writes it, from the user's action or at its end (away.ts). */
export function writeAway(a: AwayFile): void {
  mkdirSync(nexusHome(), { recursive: true });
  writeYaml(awayFile(), AwayFile.parse(a));
}

const usageFile = () => join(nexusHome(), "usage.json");
export function readUsage(): UsageFile | undefined {
  try { return existsSync(usageFile()) ? UsageFile.parse(JSON.parse(readFileSync(usageFile(), "utf8"))) : undefined; } catch { return undefined; }
}
export function writeUsage(u: UsageFile): void {
  mkdirSync(nexusHome(), { recursive: true });
  const tmp = `${usageFile()}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(UsageFile.parse(u)), "utf8");
  renameRetrying(tmp, usageFile());
}

function subdirs(dir: string): string[] {
  if (!existsSync(dir)) return [];
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
 * defaults for its steps (its tags, runtime, model, effort and fallback). A step's drafted review level and tags are
 * part of it; the levels the user set (`user_levels`) and the queue's own level are not.
 */
export function revisionHash(q: HashedQueue): string {
  return hashOf(q.steps.map(({ status: _s, status_note: _n, ...def }) => def), q);
}
/** The queue's defaults for its steps: its tags, and its runtime, model, effort and fallback. */
const STEP_DEFAULTS = ["kind", "activities", "area", "size", "origin", "runtime", "model", "effort", "fallback"] as const;
type HashedQueue = Pick<QueueFile, "steps" | "stop_conditions" | "checks" | "coding"> & Partial<Pick<QueueFile, (typeof STEP_DEFAULTS)[number]>>;
// `coding` counts only when true, and a queue's tags and its runtime, model, effort and fallback only when set, so the
// hash of a queue without them is what it was before those fields (a step's left out is not in its JSON either).
const hashOf = (steps: unknown[], q: Omit<HashedQueue, "steps">) =>
  "sha256:" + createHash("sha256").update(JSON.stringify({
    steps, stop_conditions: q.stop_conditions, checks: q.checks, ...(q.coding ? { coding: true } : {}),
    ...Object.fromEntries(STEP_DEFAULTS.filter((k) => q[k] !== undefined).map((k) => [k, q[k]])),
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
