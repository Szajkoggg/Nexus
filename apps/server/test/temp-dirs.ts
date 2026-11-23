// The test helpers' folders in the system's temporary folder, removed when the test file's process ends (queue TI2).
// The helpers used to leave every root they made: after a few days of full runs the folder held 366,000 of them.
//
// The removal waits for the process's end, not the test's: a fake runtime, a git command or the engine of a test may
// still write into its root after the test's last assertion, and a later test of the same file may read an earlier
// one's (a restart on the same files). Each file runs in its own process (node --test), so its roots go with it.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const made: string[] = [];

function removeAll(): void {
  for (const dir of made.splice(0)) {
    // A process the test started may still hold a file for a moment (Windows): a few retries, then it is left.
    // The project's worktrees are beside it (worktree.ts: <root>.worktrees), when the test's root is a project's.
    for (const d of [dir, `${dir}.worktrees`]) {
      try { rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { /* left behind */ }
    }
  }
}

/**
 * A new folder `<tmpdir>/<prefix>XXXXXX`, removed with everything in it when this process ends, and the worktrees folder
 * beside it if one was made.
 */
export function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  if (!made.length) process.once("exit", removeAll);
  made.push(dir);
  return dir;
}
