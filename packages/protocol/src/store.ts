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
  Activity, Applied, ChatEntry, PinsFile, Refusal, Delivery, Event, GlobalSettings, InboxEntry, NoteMeta, GitFile, ProjectFile, PushFile, QueueFile, RegistryFile, RunFile, RuntimeFile, SessionFile, StartFile, StoredProject, TurnRecord, UsageFile,
  type Note,
} from "./schemas.ts";
import { applyChange, builtInSettings, effectiveProject, migrateStored, storedFrom } from "./settings.ts";

export const NEXUS_DIRNAME = ".nexus";

const nextUlid = monotonicFactory();
export const newId = (): string => nextUlid();
export const now = (): string => new Date().toISOString();

/** Forward slashes, absolute. Every path stored in protocol files uses this form. */
export function normPath(p: string, base = process.cwd()): string {
  return (isAbsolute(p) ? p : resolve(base, p)).replaceAll("\\", "/");
}

// ---------------------------------------------------------------- generic file helpers

export function readYaml<S extends z.ZodType>(file: string, schema: S): z.infer<S> {
  return schema.parse(YAML.parse(readFileSync(file, "utf8")));
}

/** How long a rename is tried again while Windows refuses it (see renameRetrying). */
export const RENAME_RETRY_MS = 2_000;

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
    try { renameSync(from, to); return; }
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
export function appendJsonl(file: string, entry: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify(entry) + "\n", "utf8");
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

  // queues
  queueDir(id: string): string { return join(this.dir, "queues", id); }
  /** Where `nexus review add` copies a step's review files (its only writer): queues/<queue>/review/<step>/. */
  reviewDir(queue: string, step: string): string { return join(this.queueDir(queue), "review", step); }
  queueIds(): string[] { return subdirs(join(this.dir, "queues")).filter((q) => existsSync(join(this.queueDir(q), "queue.yaml"))); }
  readQueue(id: string): QueueFile { return readYaml(join(this.queueDir(id), "queue.yaml"), QueueFile); }
  writeQueue(q: z.input<typeof QueueFile>): void { writeYaml(join(this.queueDir(q.id), "queue.yaml"), QueueFile.parse(q)); }

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
    if (existsSync(f)) unlinkSync(f);
  }
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
    if (existsSync(f)) unlinkSync(f);
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
/** Written only by the server. */
export function writeGlobalSettings(g: GlobalSettings): void { writeYaml(globalSettingsFile(), GlobalSettings.parse(g)); }
/** At the server's start: the global settings file exists, the first time with the built-in defaults. */
export function ensureGlobalSettings(): GlobalSettings {
  const g = readGlobalSettings();
  if (!existsSync(globalSettingsFile())) writeGlobalSettings(g);
  return g;
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

export function parseFrontMatter(text: string): { meta: unknown; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) throw new Error("missing front matter");
  return { meta: YAML.parse(m[1] ?? ""), body: (m[2] ?? "").trim() };
}

// ---------------------------------------------------------------- revision hash

/** The hash an approval pins: steps (without baseline state), stop conditions and checks. */
export function revisionHash(q: QueueFile): string {
  const content = {
    steps: q.steps.map(({ status: _s, status_note: _n, ...def }) => def),
    stop_conditions: q.stop_conditions,
    checks: q.checks,
  };
  return "sha256:" + createHash("sha256").update(JSON.stringify(content)).digest("hex");
}
