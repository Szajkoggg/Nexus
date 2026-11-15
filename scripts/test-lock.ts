// One full test run on the machine at a time (decided 2026-11-15, queue FX). Two checkouts running `npm test` side by
// side took 480 to 510 s instead of 240 s, and unrelated tests failed on their time limits. So the full suite takes a
// lock first, one for the whole machine:
//
//   node scripts/test-lock.ts <node --test arguments>...      (npm test, npm run test:times)
//
// - The lock is a file in the system's temporary folder (NEXUS_TEST_LOCK names another), holding the pid and the
//   checkout of the run that took it. It is created exclusively, so of two runs starting at once one gets it.
// - A run that finds it taken waits, saying once a minute what it waits for; a lock whose process is no longer alive
//   (killed, crashed) is taken over at once.
// - After 15 minutes (NEXUS_TEST_LOCK_MAX_MS) it runs anyway, without the lock: a stuck run, or a pid reused by another
//   process, never blocks the suite for good.
// - The lock is removed when the run ends (only if it is still this run's).
//
// `npm run test:files` takes no lock and never waits: it runs a few files while working, and is short.
import { spawn } from "node:child_process";
import { openSync, readFileSync, statSync, unlinkSync, writeSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Who holds the lock, as its file says. */
export interface Holder { pid: number; cwd: string; since: string }

export interface LockOptions {
  /** The lock file (default: nexus-full-test.lock in the system's temporary folder, or NEXUS_TEST_LOCK). */
  file?: string;
  /** How long to wait at most before running without the lock (default 15 minutes, or NEXUS_TEST_LOCK_MAX_MS). */
  maxWaitMs?: number;
  /** How often the lock is looked at while waiting (default 1 s). */
  pollMs?: number;
  /** How often a waiting run says what it waits for (default a minute). */
  sayEveryMs?: number;
  /** Where the lines go (default: stderr, so the test reporter's output stays as it is). */
  say?: (line: string) => void;
  /** This run's pid and checkout, written into the lock (default: this process's). */
  pid?: number;
  cwd?: string;
}

/** The lock taken: `release()` removes it, if it is still this run's. */
export interface Lock { file: string; release: () => void }

const MINUTE = 60_000;
/** A lock file younger than this that cannot be read is being written: its taker is alive. */
const WRITING_MS = 5_000;

export function defaultLockFile(): string {
  return process.env.NEXUS_TEST_LOCK || join(tmpdir(), "nexus-full-test.lock");
}

function defaultMaxWait(): number {
  const raw = process.env.NEXUS_TEST_LOCK_MAX_MS;
  const v = Number(raw);
  return raw && Number.isFinite(v) && v >= 0 ? v : 15 * MINUTE;
}

/** Whether a process with this pid is alive (EPERM: it is, but not ours to signal). */
export function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

function readHolder(file: string): Holder | undefined {
  try {
    const h = JSON.parse(readFileSync(file, "utf8")) as Partial<Holder>;
    return typeof h.pid === "number" ? { pid: h.pid, cwd: String(h.cwd ?? "?"), since: String(h.since ?? "?") } : undefined;
  } catch { return undefined; }
}

/** Creates the lock file exclusively; false when it exists. */
function create(file: string, holder: Holder): boolean {
  let fd: number;
  try { fd = openSync(file, "wx"); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "EEXIST") return false; throw e; }
  try { writeSync(fd, JSON.stringify(holder)); } finally { closeSync(fd); }
  return true;
}

/** The lock's holder is gone (its process is not alive, or the file is unreadable and not being written). */
function stale(file: string): { holder?: Holder } | undefined {
  const h = readHolder(file);
  if (h) return alive(h.pid) ? undefined : { holder: h };
  try { return Date.now() - statSync(file).mtimeMs > WRITING_MS ? {} : undefined; }
  catch { return {}; } // removed meanwhile: free
}

const clock = (iso: string) => (/T(\d\d:\d\d)/.exec(iso)?.[1] ?? iso);

/**
 * Takes the machine's full-test lock, waiting for another run's end at most `maxWaitMs`. Resolves with the lock, or
 * with undefined when it waited that long (the caller runs without it).
 */
export async function acquire(o: LockOptions = {}): Promise<Lock | undefined> {
  const file = o.file ?? defaultLockFile();
  const maxWaitMs = o.maxWaitMs ?? defaultMaxWait();
  const pollMs = o.pollMs ?? 1000;
  const sayEveryMs = o.sayEveryMs ?? MINUTE;
  const say = o.say ?? ((line: string) => process.stderr.write(`${line}\n`));
  const me: Holder = { pid: o.pid ?? process.pid, cwd: resolve(o.cwd ?? process.cwd()), since: new Date().toISOString() };
  const lock: Lock = {
    file,
    release: () => {
      if (readHolder(file)?.pid !== me.pid) return;
      try { unlinkSync(file); } catch { /* gone already */ }
    },
  };
  const started = Date.now();
  let lastSaid: number | undefined;
  for (;;) {
    if (create(file, me)) return lock;
    const gone = stale(file);
    if (gone) {
      // Taken over: removed, then created exclusively again (of two runs taking it over at once, one gets it).
      try { unlinkSync(file); } catch { /* another run removed it */ }
      if (create(file, me)) {
        if (gone.holder) say(`npm test: took over the full-test lock of a run that is gone (pid ${gone.holder.pid}, ${gone.holder.cwd})`);
        return lock;
      }
      continue;
    }
    const waited = Date.now() - started;
    const h = readHolder(file);
    const who = h ? `the full test run in ${h.cwd} (pid ${h.pid}, since ${clock(h.since)})` : "another full test run";
    if (waited >= maxWaitMs) {
      say(`npm test: waited ${Math.round(waited / MINUTE)} min for ${who}; running now without the lock`);
      return undefined;
    }
    if (lastSaid === undefined || Date.now() - lastSaid >= sayEveryMs) {
      lastSaid = Date.now();
      say(`npm test: waiting for ${who} to end (${Math.round(waited / MINUTE)} of at most ${Math.round(maxWaitMs / MINUTE)} min)`);
    }
    await new Promise((r) => setTimeout(r, Math.max(0, Math.min(pollMs, maxWaitMs - waited))));
  }
}

/** Runs `node <args>` under the lock; resolves with its exit code. */
export async function runLocked(args: string[], o: LockOptions = {}): Promise<number> {
  const lock = await acquire(o);
  const child = spawn(process.execPath, args, { stdio: "inherit", windowsHide: true });
  const forward = (sig: NodeJS.Signals) => () => { try { child.kill(sig); } catch { /* ended */ } };
  const onInt = forward("SIGINT"), onTerm = forward("SIGTERM");
  process.on("SIGINT", onInt); process.on("SIGTERM", onTerm);
  const done = () => lock?.release();
  process.on("exit", done); // also when this process is ended some other way it can still run
  try {
    return await new Promise<number>((res) => {
      child.on("error", () => res(1));
      child.on("exit", (code, signal) => res(code ?? (signal ? 1 : 0)));
    });
  } finally {
    done();
    process.off("SIGINT", onInt); process.off("SIGTERM", onTerm); process.off("exit", done);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (!args.length) { console.error("usage: node scripts/test-lock.ts <node --test arguments>..."); process.exit(2); }
  process.exitCode = await runLocked(args);
}
