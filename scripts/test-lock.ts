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
// - A lock held longer than a full run can take (20 minutes since it was taken, NEXUS_TEST_LOCK_STALE_MS) is stale even
//   if its process lives (a hung run, a pid reused by another process): it is taken over at once (queue TF).
// - After 15 minutes (NEXUS_TEST_LOCK_MAX_MS) it runs anyway, without the lock: a stuck run, or a pid reused by another
//   process, never blocks the suite for good.
// - The lock is removed when the run ends (only if it is still this run's).
// - The run ends with whoever started it (queue TF): a watchdog process watches the run's starter (this script's
//   parent, and the shells and npm above it) and this script. When the starter is gone (a worker's background command
//   ended on its time limit, a shell killed), the run's process tree is ended and the lock removed; when this script is
//   killed by itself, the watchdog does it. On Windows a shell that is killed (cmd, Git Bash) leaves its children
//   running, so nothing else would; a killed Node process takes its children along (libuv's job object), but not its
//   lock.
//
// `npm run test:files` takes no lock and never waits: it runs a few files while working, and is short.
import { execFile, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { openSync, readFileSync, statSync, unlinkSync, writeFileSync, writeSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Who holds the lock, as its file says. */
export interface Holder { pid: number; cwd: string; since: string }

export interface LockOptions {
  /** The lock file (default: nexus-full-test.lock in the system's temporary folder, or NEXUS_TEST_LOCK). */
  file?: string;
  /** How long to wait at most before running without the lock (default 15 minutes, or NEXUS_TEST_LOCK_MAX_MS). */
  maxWaitMs?: number;
  /** A lock held longer than this is stale, its process alive or not (default 20 minutes, or NEXUS_TEST_LOCK_STALE_MS). */
  staleMs?: number;
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

/** A duration from the environment, or the default. */
function envMs(name: string, fallback: number): number {
  const raw = process.env[name];
  const v = Number(raw);
  return raw && Number.isFinite(v) && v >= 0 ? v : fallback;
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

/**
 * The lock's holder is gone (its process is not alive, or the file is unreadable and not being written), or has held it
 * longer than `staleMs` (`heldMs`: how long).
 */
function stale(file: string, staleMs: number): { holder?: Holder; heldMs?: number } | undefined {
  const h = readHolder(file);
  if (h) {
    if (!alive(h.pid)) return { holder: h };
    const heldMs = Date.now() - Date.parse(h.since);
    return heldMs > staleMs ? { holder: h, heldMs } : undefined; // an unreadable `since` (NaN) is never stale
  }
  try { return Date.now() - statSync(file).mtimeMs > WRITING_MS ? {} : undefined; }
  catch { return {}; } // removed meanwhile: free
}

/** Removes the lock file if `pid` still holds it. */
function releaseIf(file: string, pid: number): void {
  if (readHolder(file)?.pid !== pid) return;
  try { unlinkSync(file); } catch { /* gone already */ }
}

const clock = (iso: string) => (/T(\d\d:\d\d)/.exec(iso)?.[1] ?? iso);

/**
 * Takes the machine's full-test lock, waiting for another run's end at most `maxWaitMs`. Resolves with the lock, or
 * with undefined when it waited that long (the caller runs without it).
 */
export async function acquire(o: LockOptions = {}): Promise<Lock | undefined> {
  const file = o.file ?? defaultLockFile();
  const maxWaitMs = o.maxWaitMs ?? envMs("NEXUS_TEST_LOCK_MAX_MS", 15 * MINUTE);
  const staleMs = o.staleMs ?? envMs("NEXUS_TEST_LOCK_STALE_MS", 20 * MINUTE);
  const pollMs = o.pollMs ?? 1000;
  const sayEveryMs = o.sayEveryMs ?? MINUTE;
  const say = o.say ?? ((line: string) => process.stderr.write(`${line}\n`));
  const me: Holder = { pid: o.pid ?? process.pid, cwd: resolve(o.cwd ?? process.cwd()), since: new Date().toISOString() };
  const lock: Lock = { file, release: () => releaseIf(file, me.pid) };
  const started = Date.now();
  let lastSaid: number | undefined;
  for (;;) {
    if (create(file, me)) return lock;
    const gone = stale(file, staleMs);
    if (gone) {
      // Taken over: removed, then created exclusively again (of two runs taking it over at once, one gets it). A run
      // that held it too long is left running: it is not this run's to end, and its end leaves the lock alone.
      try { unlinkSync(file); } catch { /* another run removed it */ }
      if (create(file, me)) {
        const h = gone.holder;
        if (h && gone.heldMs !== undefined) say(`npm test: took over the full-test lock of a run that has held it for ${Math.round(gone.heldMs / MINUTE)} min, longer than a full run takes (pid ${h.pid}, ${h.cwd})`);
        else if (h) say(`npm test: took over the full-test lock of a run that is gone (pid ${h.pid}, ${h.cwd})`);
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

// ---------------------------------------------------------------- the run ends with its starter

/** A process as the system reports it: `created` in ms (Windows only, to tell a reused pid; 0 elsewhere). */
export interface Proc { pid: number; ppid: number; created: number; name: string; commandLine: string }

const SHELLS = new Set(["cmd", "bash", "sh", "dash", "zsh", "fish", "powershell", "pwsh"]);

/** A process between a run and whoever started it: a shell, or npm (a node process running npm-cli.js, or titled npm). */
export function isStarterLink(p: Pick<Proc, "name" | "commandLine">): boolean {
  const name = basename(p.name.replaceAll("\\", "/")).toLowerCase().replace(/\.exe$/, "");
  if (SHELLS.has(name) || name === "npm" || name === "npx") return true;
  return name === "node" && /np[mx]-cli\.js|^np[mx](\s|$)/i.test(p.commandLine);
}

/**
 * The processes whose end ends the run, from `chain` (the wrapper's parent and its ancestors, nearest first): the
 * parent, whoever started the run, always; then each ancestor while it is a shell or npm, the parent of the one below
 * and, where creation times are known, started before it (a pid the system gave to a newer process is no ancestor).
 */
export function starterChain(chain: readonly Proc[]): number[] {
  const out: number[] = [];
  for (const [i, p] of chain.entries()) {
    const below = chain[i - 1];
    if (below && (!isStarterLink(p) || p.pid !== below.ppid || (p.created && below.created && p.created > below.created))) break;
    out.push(p.pid);
  }
  return out;
}

const MAX_ANCESTRY = 12;
const run = (file: string, args: string[]) => new Promise<string | undefined>((done) => {
  execFile(file, args, { windowsHide: true, timeout: 60_000 }, (err, out) => done(err ? undefined : out));
});

/**
 * `pid` and its ancestors, nearest first (at most 12), as the system tells them; [] when it cannot. On Windows a pid
 * whose process is newer than the one below is no ancestor (Windows reuses pids), and the walk ends there, or goes on
 * through MSYS (Git Bash): there a forked and exec'd process's Windows parent is a stand-in that is gone, and its real
 * parent is in MSYS's own process table (its ps, beside its bash.exe), whose ppid it then gets.
 */
export async function ancestry(pid: number): Promise<Proc[]> {
  if (process.platform !== "win32") {
    const out = await run("ps", ["-A", "-o", "pid=", "-o", "ppid=", "-o", "args="]);
    const all = new Map<number, Proc>();
    for (const l of out?.split("\n") ?? []) {
      const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l);
      if (m) all.set(Number(m[1]), { pid: Number(m[1]), ppid: Number(m[2]), created: 0, name: m[3]!.split(/\s+/)[0] ?? "", commandLine: m[3]! });
    }
    const chain: Proc[] = [];
    for (let p = all.get(pid); p && chain.length < MAX_ANCESTRY; p = all.get(p.ppid)) chain.push(p);
    return chain;
  }
  const chain: (Proc & { exe: string })[] = [];
  let msys: Map<number, number> | undefined; // an MSYS process's Windows pid to its MSYS parent's Windows pid
  for (let next = pid, hops = 0; hops < 4 && chain.length < MAX_ANCESTRY; hops++) {
    const part = await windowsWalk(next, MAX_ANCESTRY - chain.length);
    for (const p of part) {
      const below = chain.at(-1);
      if (below && (p.pid !== below.ppid || p.created > below.created)) break;
      chain.push(p);
    }
    const top = chain.at(-1);
    const ps = top && /[\\/]usr[\\/]bin[\\/][^\\/]+\.exe$/i.test(top.exe) ? join(top.exe, "..", "ps.exe") : undefined;
    if (!top || !ps) break;
    msys ??= msysParents(await run(ps, ["-e", "-l"]) ?? "");
    const parent = msys.get(top.pid);
    if (!parent || parent === top.ppid) break;
    top.ppid = parent;
    next = parent;
  }
  return chain.map(({ exe: _, ...p }) => p);
}

/** Up to `max` processes from `pid` up its Windows parents, in one PowerShell, one CIM query per level (about a second). */
async function windowsWalk(pid: number, max: number): Promise<(Proc & { exe: string })[]> {
  const script = `$p = ${pid}; for ($i = 0; $i -lt ${max} -and $p -gt 0; $i++) { $x = Get-CimInstance Win32_Process -Filter "ProcessId=$p"; if (-not $x) { break }; "{0}\`t{1}\`t{2}\`t{3}\`t{4}\`t{5}" -f $x.ProcessId, $x.ParentProcessId, $x.CreationDate.ToFileTimeUtc(), $x.Name, $x.ExecutablePath, $x.CommandLine; $p = $x.ParentProcessId }`;
  const out = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);
  return (out ?? "").split(/\r?\n/).filter((l) => l.trim()).map((l) => {
    const [id, parent, created, name, exe, ...cmd] = l.split("\t");
    // FILETIME (100 ns since 1601) to ms: only compared with each other.
    return { pid: Number(id), ppid: Number(parent), created: Number(created) / 10_000, name: name ?? "", exe: exe ?? "", commandLine: cmd.join("\t") };
  });
}

/** From MSYS's `ps -e -l` (PID PPID PGID WINPID ...): each process's Windows pid to its parent's Windows pid. */
export function msysParents(out: string): Map<number, number> {
  const rows = out.split(/\r?\n/).map((l) => /^\s*[A-Z]?\s*(\d+)\s+(\d+)\s+\d+\s+(\d+)\s/.exec(l)).filter((m) => !!m).map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), win: Number(m[3]) }));
  const win = new Map(rows.map((r) => [r.pid, r.win]));
  const parents = new Map<number, number>();
  for (const r of rows) { const p = win.get(r.ppid); if (p) parents.set(r.win, p); }
  return parents;
}

/**
 * Ends the run (`pid`, spawned by the wrapper) and everything it started: on Windows its tree, elsewhere its process
 * group (it was detached). Only for a pid known to be the run's: Windows reuses pids at once, and a tree kill of a
 * reused one ends another program's processes (a parallel test's server, seen while building this).
 */
function killTree(pid: number): void {
  if (process.platform === "win32") spawnSync("taskkill", ["/T", "/F", "/PID", String(pid)], { stdio: "ignore", windowsHide: true });
  else try { process.kill(-pid, "SIGKILL"); } catch { /* the group is gone */ }
}

/**
 * The watchdog's end of a run whose wrapper is gone: on Windows only if `run` is still the wrapper's child (a process
 * keeps its parent's pid when the parent ends; a reused pid has another); elsewhere its process group, which exists
 * only while one of its processes lives.
 */
async function endOrphanedRun(run: number | undefined, wrapper: number): Promise<void> {
  if (!run || !alive(run)) return;
  if (process.platform === "win32" && (await windowsWalk(run, 1))[0]?.ppid !== wrapper) return;
  killTree(run);
}

/**
 * The watchdog (`node test-lock.ts --watchdog <wrapper> <parent> <lock file>`, started by runLocked with an IPC
 * channel): told the run's pid once it starts, it looks every second whether the starter chain lives. One of it gone:
 * it tells the wrapper, which ends the run and removes its lock (and does it itself if the wrapper has not after 10 s).
 * The channel closed without the watchdog being ended first, as a run's normal end does: the wrapper was killed, so it
 * ends the run's tree and removes the wrapper's lock. Until it knows the chain (a second or two on Windows), it watches
 * the parent alone; NEXUS_TEST_LOCK_WATCHED names a file it then writes the watched pids into (for tests).
 */
function watchdog(wrapper: number, parent: number, file: string, pollMs = 1000): void {
  process.stderr.on("error", () => {}); // the console may be gone with the starter
  let run: number | undefined;
  process.on("message", (m: { run?: number }) => { if (m.run) run = m.run; });
  let cleaning = false;
  const cleanUp = () => {
    if (cleaning) return;
    cleaning = true;
    void endOrphanedRun(run, wrapper).finally(() => { releaseIf(file, wrapper); process.exit(0); });
  };
  process.on("disconnect", cleanUp);
  let watched = [parent];
  void ancestry(parent).then((chain) => {
    if (chain[0]?.pid === parent) watched = starterChain(chain);
    const report = process.env.NEXUS_TEST_LOCK_WATCHED;
    if (report) writeFileSync(report, JSON.stringify(watched));
  });
  let told: number | undefined;
  setInterval(() => {
    const gone = watched.find((p) => !alive(p));
    if (gone === undefined) return;
    if (told === undefined) {
      told = Date.now();
      try { process.send!({ gone }); } catch { cleanUp(); }
    } else if (Date.now() - told > 10_000) cleanUp();
  }, pollMs);
}

/** Runs `node <args>` under the lock, ended with its starter (watchdog); resolves with its exit code. */
export async function runLocked(args: string[], o: LockOptions = {}): Promise<number> {
  const file = o.file ?? defaultLockFile();
  const say = o.say ?? ((line: string) => process.stderr.write(`${line}\n`));
  // The watchdog first: a starter that goes while the run waits for the lock ends the wait too. Detached, so that it
  // outlives this process: on Windows Node ends a process's children with it (libuv's job object), which ends the run's
  // tree when this process is killed, but would end the watchdog too and leave the lock. It keeps this process from
  // ending neither by itself nor by its channel.
  const guard = spawn(process.execPath, [fileURLToPath(import.meta.url), "--watchdog", String(process.pid), String(process.ppid), file], { stdio: ["ignore", "ignore", "inherit", "ipc"], windowsHide: true, detached: true });
  guard.on("error", () => {});
  guard.unref(); guard.channel?.unref();
  let child: ChildProcess | undefined;
  guard.on("message", (m: { gone?: number }) => {
    if (!m.gone) return;
    say(`npm test: the process that started this run is gone (pid ${m.gone}); ending the run`);
    if (child?.pid && child.exitCode === null && child.signalCode === null) killTree(child.pid); // still running: ours
    releaseIf(file, o.pid ?? process.pid);
    guard.kill();
    process.exit(1);
  });
  const lock = await acquire({ ...o, file, say });
  // In its own process group elsewhere than on Windows, so that its whole tree can be ended (killTree).
  const run = spawn(process.execPath, args, { stdio: "inherit", windowsHide: true, detached: process.platform !== "win32" });
  child = run;
  if (run.pid && guard.connected) guard.send({ run: run.pid }, () => {});
  const forward = (sig: NodeJS.Signals) => () => { try { run.kill(sig); } catch { /* ended */ } };
  const onInt = forward("SIGINT"), onTerm = forward("SIGTERM");
  process.on("SIGINT", onInt); process.on("SIGTERM", onTerm);
  const done = () => { guard.kill(); lock?.release(); };
  process.on("exit", done); // also when this process is ended some other way it can still run
  try {
    return await new Promise<number>((res) => {
      run.on("error", () => res(1));
      run.on("exit", (code, signal) => res(code ?? (signal ? 1 : 0)));
    });
  } finally {
    done();
    process.off("SIGINT", onInt); process.off("SIGTERM", onTerm); process.off("exit", done);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args[0] === "--watchdog") watchdog(Number(args[1]), Number(args[2]), args[3]!);
  else if (!args.length) { console.error("usage: node scripts/test-lock.ts <node --test arguments>..."); process.exit(2); }
  else process.exitCode = await runLocked(args);
}
