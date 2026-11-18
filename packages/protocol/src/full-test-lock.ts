// The machine's full-test lock, read (PROTOCOL.md, "Full-test lock and lifetime channel"). Its writer is
// scripts/test-lock.ts, which takes it for `npm test`; the server's capacity coordinator reads it to tell a full run
// outside Nexus, and grants no heavy operation while one holds it. One place for when a lock counts as held, so the
// two never disagree: free when its holder is gone, or when it is stale (held, or unrenewed, longer than `staleMs`).
// Node only (fs, os), no other dependency: scripts/test-lock.ts loads it before every full run.
import { readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Who holds the lock, as its file says. */
export interface FullTestHolder { pid: number; cwd: string; since: string; token?: string; lease?: boolean }

/** A lock file younger than this that cannot be read is being written: its taker is alive. */
const WRITING_MS = 5_000;
/** How long a lock counts at most (20 minutes, NEXUS_TEST_LOCK_STALE_MS): five times a full run. */
const FULL_TEST_STALE_MS = 20 * 60_000;

/** The lock file: nexus-full-test.lock in the system's temporary folder, or NEXUS_TEST_LOCK. */
export function fullTestLockFile(): string {
  return process.env.NEXUS_TEST_LOCK || join(tmpdir(), "nexus-full-test.lock");
}

/** NEXUS_TEST_LOCK_STALE_MS, or the default. */
export function fullTestStaleMs(): number {
  const raw = process.env.NEXUS_TEST_LOCK_STALE_MS;
  const v = Number(raw);
  return raw && Number.isFinite(v) && v >= 0 ? v : FULL_TEST_STALE_MS;
}

/** Whether a process with this pid is alive (EPERM: it is, but not ours to signal). */
export function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

export function readFullTestHolder(file: string): FullTestHolder | undefined {
  try {
    const h = JSON.parse(readFileSync(file, "utf8")) as Partial<FullTestHolder>;
    return typeof h.pid === "number" ? { pid: h.pid, cwd: String(h.cwd ?? "?"), since: String(h.since ?? "?"), token: h.token, lease: h.lease } : undefined;
  } catch { return undefined; }
}

/**
 * The lock's holder is gone (its process is not alive, or the file is unreadable and not being written), or has held it
 * longer than `staleMs` (`heldMs`: how long): it may be taken over. Undefined while it counts as held.
 */
export function fullTestStale(file: string, staleMs: number): { holder?: FullTestHolder; heldMs?: number } | undefined {
  const h = readFullTestHolder(file);
  if (h) {
    if (h.lease) {
      try { const heldMs = Date.now() - statSync(file).mtimeMs; return heldMs > staleMs ? { holder: h, heldMs } : undefined; }
      catch { return {}; }
    }
    if (!processAlive(h.pid)) return { holder: h };
    const heldMs = Date.now() - Date.parse(h.since);
    return heldMs > staleMs ? { holder: h, heldMs } : undefined; // an unreadable `since` (NaN) is never stale
  }
  try { return Date.now() - statSync(file).mtimeMs > WRITING_MS ? {} : undefined; }
  catch { return {}; } // removed meanwhile, or never there: free
}

/** Who holds the lock now, when it counts as held (a young file still being written: a holder not yet known). */
export function fullTestHeld(file = fullTestLockFile(), staleMs = fullTestStaleMs()): FullTestHolder | undefined {
  if (fullTestStale(file, staleMs)) return undefined;
  return readFullTestHolder(file) ?? { pid: 0, cwd: "?", since: "?" };
}
