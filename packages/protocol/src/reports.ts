// Where workers write a queue's report before `nexus report` copies it into the queue's folder: outside every working
// tree and repository (a report left in a worktree would block its cleanup), in the system's temporary directory,
// one folder per project, one file per queue.
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** The project's folder of reports: <temp>/nexus-reports/<project>. */
export function reportFolder(project: string): string { return join(tmpdir(), "nexus-reports", project); }

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
export function inReportFolder(project: string, file: string): boolean {
  const norm = (p: string) => { const r = resolve(p).replaceAll("\\", "/"); return process.platform === "win32" ? r.toLowerCase() : r; };
  return norm(file).startsWith(norm(reportFolder(project)) + "/");
}
