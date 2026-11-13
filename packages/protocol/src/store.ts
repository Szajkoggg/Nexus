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
  Activity, Applied, ChatEntry, Refusal, Delivery, Event, InboxEntry, NoteMeta, ProjectFile, PushFile, QueueFile, RegistryFile, RunFile, RuntimeFile, SessionFile, StartFile, UsageFile,
  type Note,
} from "./schemas.ts";

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

/** Atomic replace: write a temporary file next to the target, then rename it over the target. */
export function writeYaml(file: string, data: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, YAML.stringify(data, { lineWidth: 120 }), "utf8");
  renameSync(tmp, file);
}

export interface JsonlRead<T> { entries: T[]; errors: string[] }

/** Reads a JSONL log. A final line without a newline is still being written and is skipped. */
export function readJsonl<S extends z.ZodType>(file: string, schema: S): JsonlRead<z.infer<S>> {
  const out: JsonlRead<z.infer<S>> = { entries: [], errors: [] };
  if (!existsSync(file)) return out;
  const text = readFileSync(file, "utf8");
  const complete = text.endsWith("\n") ? text : text.slice(0, text.lastIndexOf("\n") + 1);
  complete.split("\n").forEach((line, i) => {
    if (!line.trim()) return;
    try {
      const r = schema.safeParse(JSON.parse(line));
      if (r.success) out.entries.push(r.data);
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
  static init(root: string, project: Omit<z.input<typeof ProjectFile>, "protocol">): ProjectStore {
    const store = ProjectStore.forRoot(root);
    mkdirSync(join(store.dir, "queues"), { recursive: true });
    mkdirSync(join(store.dir, "sessions"), { recursive: true });
    writeFileSync(join(store.dir, ".gitignore"), "*\n", "utf8");
    if (!existsSync(store.projectFile)) store.writeProject(ProjectFile.parse({ protocol: 1, ...project }));
    return store;
  }

  get projectFile(): string { return join(this.dir, "project.yaml"); }
  readProject(): ProjectFile { return readYaml(this.projectFile, ProjectFile); }
  writeProject(p: ProjectFile): void { writeYaml(this.projectFile, p); }

  // queues
  queueDir(id: string): string { return join(this.dir, "queues", id); }
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
    renameSync(f, join(this.queueDir(queueId), name));
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

  readRuntime(sessionId: string): RuntimeFile | undefined {
    const f = join(this.sessionDir(sessionId), "runtime.json");
    try { return existsSync(f) ? RuntimeFile.parse(JSON.parse(readFileSync(f, "utf8"))) : undefined; } catch { return undefined; }
  }
  writeRuntime(sessionId: string, r: RuntimeFile): void {
    const f = join(this.sessionDir(sessionId), "runtime.json");
    const tmp = `${f}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(RuntimeFile.parse(r)), "utf8");
    renameSync(tmp, f);
  }
}

// ---------------------------------------------------------------- account-wide usage

const usageFile = () => join(nexusHome(), "usage.json");
export function readUsage(): UsageFile | undefined {
  try { return existsSync(usageFile()) ? UsageFile.parse(JSON.parse(readFileSync(usageFile(), "utf8"))) : undefined; } catch { return undefined; }
}
export function writeUsage(u: UsageFile): void {
  mkdirSync(nexusHome(), { recursive: true });
  const tmp = `${usageFile()}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(UsageFile.parse(u)), "utf8");
  renameSync(tmp, usageFile());
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
