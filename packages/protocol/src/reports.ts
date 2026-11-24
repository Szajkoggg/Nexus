// Where workers write a queue's report before `nexus report` copies it into the queue's folder: outside every working
// tree and repository (a report left in a worktree would block its cleanup), in the system's temporary directory,
// one folder per project, one file per queue.
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";

/** Fingerprint of the exact report bytes registered by queue.report, without text normalization. */
export function reportSourceHash(content: Uint8Array): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

/**
 * The system's temporary folder as `env` names it, as os.tmpdir() reads it from this process's environment: the CLI
 * passes the environment of its call (several calls, each with its own, may run in one process).
 */
function tempDir(env: NodeJS.ProcessEnv): string {
  if (env === process.env) return tmpdir();
  return process.platform === "win32"
    ? env.TEMP || env.TMP || join(env.SystemRoot || env.windir || "C:/Windows", "temp")
    : env.TMPDIR || "/tmp";
}

/** The project's folder of reports: <temp>/nexus-reports/<project>. */
export function reportFolder(project: string, env: NodeJS.ProcessEnv = process.env): string { return join(tempDir(env), "nexus-reports", project); }

/** The file a worker writes the queue's report to (forward slashes, as prompts and the CLI show paths). */
export function reportFile(project: string, queue: string): string {
  return join(reportFolder(project), `${queue}.md`).replaceAll("\\", "/");
}

/** Makes the project's folder of reports, so a worker (and a Codex sandbox's writable root) finds it. */
export function ensureReportFolder(project: string): string {
  const dir = reportFolder(project);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** The file lies in the project's folder of reports: `nexus report` removes such a source once it is copied. */
export function inReportFolder(project: string, file: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const norm = (p: string) => { const r = resolve(p).replaceAll("\\", "/"); return process.platform === "win32" ? r.toLowerCase() : r; };
  return norm(file).startsWith(norm(reportFolder(project, env)) + "/");
}
