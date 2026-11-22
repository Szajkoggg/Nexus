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
//   Without process queries, the holder instead renews the lock's mtime; only an unrenewed lease expires (queue PT).
// - It never runs without the lock (queue EC, 2026-11-18, EC1's proposal P11). It used to after 15 minutes, beside the
//   run it waited for, which is what the lock is there to prevent. A waiting run keeps waiting and keeps saying what
//   for; a hung holder or a reused pid is handled by the staleness above, not by a time after which waiting gives up.
//   The Nexus server's capacity coordinator reads the same lock: packages/protocol/src/full-test-lock.ts holds the
//   rules both go by.
// - The lock is removed when the run ends (only if it is still this run's).
// - The run ends with whoever started it (queue TF): a watchdog process watches the run's starter (this script's
//   parent, and the shells and npm above it) and this script. The watchdog owns the runner. A known starter gone or
//   the wrapper's IPC channel closed: it ends its own child and releases the lock. This needs no process query for
//   ownership. If a sandbox ends both wrapper and watchdog, the lease expires without renewal.
//
// `npm run test:files` takes no lock and never waits: it runs a few files while working, and is short.
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { openSync, unlinkSync, writeFileSync, writeSync, closeSync, futimesSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  fullTestLockFile, fullTestStale, fullTestStaleMs, processAlive as alive, readFullTestHolder as readHolder,
  type FullTestHolder as Holder,
} from "@nexus/protocol/full-test-lock";

export { alive };

interface LockOptions {
  /** The lock file (default: nexus-full-test.lock in the system's temporary folder, or NEXUS_TEST_LOCK). */
  file?: string;
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
  /** Without process queries, renew a lease rather than relying on PID visibility or absolute run age. */
  lease?: boolean;
  /** Ends the wait (the run's starter is gone): acquire resolves with undefined, and nothing runs. */
  signal?: AbortSignal;
}

/** The lock taken: `release()` removes it, if it is still this run's. */
interface Lock { file: string; token?: string; release: () => void }

const MINUTE = 60_000;

/** Creates the lock file exclusively, optionally renewing its lease; undefined when it exists. */
function create(file: string, holder: Holder, staleMs: number): Lock | undefined {
  let fd: number;
  try { fd = openSync(file, "wx"); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "EEXIST") return undefined; throw e; }
  try { writeSync(fd, JSON.stringify(holder)); } catch (error) { closeSync(fd); throw error; }
  // Renew through the open file, never its path: a replaced lock belongs to someone else.
  const timer = holder.lease ? setInterval(() => {
    try { const now = new Date(); futimesSync(fd, now, now); } catch { /* expiry releases an unrenewable lease */ }
  }, Math.max(10, Math.min(1000, staleMs / 3))) : undefined;
  timer?.unref();
  let released = false;
  return { file, token: holder.token, release: () => {
    if (released) return;
    released = true;
    clearInterval(timer); closeSync(fd);
    releaseIf(file, holder.pid, holder.token);
  } };
}

/** Removes the lock file if `pid` still holds it. */
function releaseIf(file: string, pid: number, token?: string): void {
  const holder = readHolder(file);
  if (holder?.pid !== pid || (token !== undefined && holder.token !== token)) return;
  try { unlinkSync(file); } catch { /* gone already */ }
}

const clock = (iso: string) => (/T(\d\d:\d\d)/.exec(iso)?.[1] ?? iso);

/**
 * Takes the machine's full-test lock, waiting for another run's end as long as it takes (the lock is taken over only
 * when it is stale). Resolves with the lock, or with undefined once `signal` ended the wait: the caller does not run.
 */
export async function acquire(o: LockOptions = {}): Promise<Lock | undefined> {
  const file = o.file ?? fullTestLockFile();
  const staleMs = o.staleMs ?? fullTestStaleMs();
  const pollMs = o.pollMs ?? 1000;
  const sayEveryMs = o.sayEveryMs ?? MINUTE;
  const say = o.say ?? ((line: string) => process.stderr.write(`${line}\n`));
  const me: Holder = { pid: o.pid ?? process.pid, cwd: resolve(o.cwd ?? process.cwd()), since: new Date().toISOString(), token: randomUUID(), ...(o.lease ? { lease: true } : {}) };
  const started = Date.now();
  let lastSaid: number | undefined;
  for (;;) {
    if (o.signal?.aborted) return undefined;
    const fresh = create(file, me, staleMs);
    if (fresh) return fresh;
    const gone = fullTestStale(file, staleMs);
    if (gone) {
      // Taken over: removed, then created exclusively again (of two runs taking it over at once, one gets it). A run
      // that held it too long is left running: it is not this run's to end, and its end leaves the lock alone.
      try { unlinkSync(file); } catch { /* another run removed it */ }
      const taken = create(file, me, staleMs);
      if (taken) {
        const h = gone.holder;
        if (h?.lease) say(`npm test: took over an expired full-test lease (pid ${h.pid}, ${h.cwd})`);
        else if (h && gone.heldMs !== undefined) say(`npm test: took over the full-test lock of a run that has held it for ${Math.round(gone.heldMs / MINUTE)} min, longer than a full run takes (pid ${h.pid}, ${h.cwd})`);
        else if (h) say(`npm test: took over the full-test lock of a run that is gone (pid ${h.pid}, ${h.cwd})`);
        return taken;
      }
      continue;
    }
    const waited = Date.now() - started;
    const h = readHolder(file);
    const who = h ? `the full test run in ${h.cwd} (pid ${h.pid}, since ${clock(h.since)})` : "another full test run";
    if (lastSaid === undefined || Date.now() - lastSaid >= sayEveryMs) {
      lastSaid = Date.now();
      say(`npm test: waiting for ${who} to end (${Math.round(waited / MINUTE)} min so far; it never runs without the lock)`);
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

// ---------------------------------------------------------------- the run ends with its starter

/** A process as the system reports it: `created` in ms (Windows only, to tell a reused pid; 0 elsewhere). */
export interface Proc { pid: number; ppid: number; created: number; name: string; commandLine: string }

const SHELLS = new Set(["cmd", "bash", "sh", "dash", "zsh", "fish", "powershell", "pwsh"]);

/** A process between a run and whoever started it: a shell, or npm (a node process running npm-cli.js, or titled npm). */
function isStarterLink(p: Pick<Proc, "name" | "commandLine">): boolean {
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
 * `pid` and its ancestors, nearest first (at most 12), as the system tells them; [] when it cannot. On Windows only up
 * to the first ancestor that is no shell or npm (windowsWalk). A pid whose process is newer than the one below is no
 * ancestor (Windows reuses pids), and the walk ends there, or goes on
 * through MSYS (Git Bash): there a forked and exec'd process's Windows parent is a stand-in that is gone, and its real
 * parent is in MSYS's own process table (its ps, beside its bash.exe), whose ppid it then gets.
 */
export async function ancestry(pid: number): Promise<Proc[]> {
  if (process.env.NEXUS_TEST_LOCK_QUERY === "off") return [];
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

/**
 * Up to `max` processes from `pid` up its Windows parents, in one PowerShell, one CIM query per level (a few hundred
 * ms each), ending after the first one beyond `pid` that is no shell or npm (isStarterLink's rule, roughly: the chain
 * ends there anyway). WMI is not cheap: a full suite with 12 levels per walk made the slowest load-bound tests slower.
 */
async function windowsWalk(pid: number, max: number): Promise<(Proc & { exe: string })[]> {
  const links = [...SHELLS, "npm", "npx"].map((n) => `'${n}'`).join(",");
  const script = `
$p = ${pid}
for ($i = 0; $i -lt ${max} -and $p -gt 0; $i++) {
  $x = Get-CimInstance Win32_Process -Filter "ProcessId=$p"
  if (-not $x) { break }
  "{0}\`t{1}\`t{2}\`t{3}\`t{4}\`t{5}" -f $x.ProcessId, $x.ParentProcessId, $x.CreationDate.ToFileTimeUtc(), $x.Name, $x.ExecutablePath, $x.CommandLine
  $n = ($x.Name -replace '\\.exe$', '').ToLower()
  if ($i -gt 0 -and -not (@(${links}) -contains $n -or ($n -eq 'node' -and $x.CommandLine -match 'np[mx]-cli\\.js'))) {
    break
  }
  $p = $x.ParentProcessId
}`;
  const out = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);
  return (out ?? "").split(/\r?\n/).filter((l) => l.trim()).map((l) => {
    const [id, parent, created, name, exe, ...cmd] = l.split("\t");
    // FILETIME (100 ns since 1601) to ms: only compared with each other.
    return { pid: Number(id), ppid: Number(parent), created: Number(created) / 10_000, name: name ?? "", exe: exe ?? "", commandLine: cmd.join("\t") };
  });
}

/** From MSYS's `ps -e -l` (PID PPID PGID WINPID ...): each process's Windows pid to its parent's Windows pid. */
export function msysParents(out: string): Map<number, number> {
  const rows: { pid: number; ppid: number; win: number }[] = [];
  for (const line of out.split(/\r?\n/)) {
    const match = /^\s*[A-Z]?\s*(\d+)\s+(\d+)\s+\d+\s+(\d+)\s/.exec(line);
    if (match) rows.push({ pid: Number(match[1]), ppid: Number(match[2]), win: Number(match[3]) });
  }
  const windowsPids = new Map(rows.map((row) => [row.pid, row.win]));
  const parents = new Map<number, number>();
  for (const row of rows) {
    const parent = windowsPids.get(row.ppid);
    if (parent) parents.set(row.win, parent);
  }
  return parents;
}

interface Control { args?: string[]; token?: string; stop?: boolean; signal?: NodeJS.Signals }
interface Notice { ready?: boolean; queried?: boolean; code?: number; gone?: number }

/** The watchdog owns the runner. IPC loss ends its own child; no orphan PID needs to be rediscovered or trusted. */
function watchdog(wrapper: number, parent: number, file: string, pollMs = 1000): void {
  process.stderr.on("error", () => {}); // the console may be gone with the starter
  let child: ChildProcess | undefined, token: string | undefined;
  let ending = false;
  const send = (message: Notice) => { if (process.connected) process.send!(message, () => {}); };
  const finish = (code: number) => {
    if (token) releaseIf(file, wrapper, token);
    if (process.connected) process.send!({ code }, () => process.exit(code));
    else process.exit(code);
  };
  const stop = () => {
    if (ending) return;
    ending = true;
    if (!child || child.exitCode !== null || child.signalCode !== null) return finish(1);
    if (process.platform !== "win32" && child.pid) {
      try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
    } else child.kill("SIGKILL"); // the held child handle; its Node/libuv job ends the descendants
  };
  process.on("disconnect", stop);
  process.on("message", (m: Control) => {
    if (m.stop) return stop();
    if (m.signal) { child?.kill(m.signal); return; }
    if (!m.args || child || ending) return;
    token = m.token;
    child = spawn(process.execPath, m.args, { stdio: "inherit", windowsHide: true, detached: process.platform !== "win32" });
    child.on("error", () => finish(1));
    child.on("exit", (code, signal) => finish(ending ? 1 : code ?? (signal ? 1 : 0)));
  });
  let watched: number[] = [];
  void ancestry(parent).then((chain) => {
    const queried = chain[0]?.pid === parent;
    if (queried) watched = starterChain(chain);
    const report = process.env.NEXUS_TEST_LOCK_WATCHED;
    if (report) writeFileSync(report, JSON.stringify({ watched, guard: process.pid, queried }));
    send({ ready: true, queried });
  });
  setInterval(() => {
    const gone = watched.find((p) => !alive(p));
    if (gone === undefined) return;
    send({ gone }); stop();
  }, pollMs);
}

/** Runs `node <args>` under the lock, ended with its starter (watchdog); resolves with its exit code. */
async function runLocked(args: string[], o: LockOptions = {}): Promise<number> {
  const file = o.file ?? fullTestLockFile();
  const say = o.say ?? ((line: string) => process.stderr.write(`${line}\n`));
  // Detached so it can remove the lock when the sandbox kills this wrapper. The IPC channel is the lifetime
  // connection, including where WMI/ps is denied. If the sandbox kills both, the unrenewed lease expires instead.
  const guard = spawn(process.execPath, [fileURLToPath(import.meta.url), "--watchdog", String(process.pid), String(process.ppid), file], { stdio: ["ignore", "inherit", "inherit", "ipc"], windowsHide: true, detached: true });
  const send = (message: Control) => { if (guard.connected) guard.send(message, () => {}); };
  let lock: Lock | undefined;
  const ready = new Promise<Notice | undefined>((res) => {
    guard.on("message", (m: Notice) => { if (m.ready) res(m); });
    guard.on("exit", () => res(undefined)); guard.on("error", () => res(undefined));
  });
  const ended = new Promise<number>((res) => {
    guard.on("exit", (code) => res(code ?? 1)); guard.on("error", () => res(1));
    guard.on("message", (m: Notice) => {
      if (m.gone) say(`npm test: the process that started this run is gone (pid ${m.gone}); ending the run`);
    });
  });
  const parentGone = () => send({ stop: true });
  process.on("disconnect", parentGone); // cooperative callers can supply their own lifetime IPC too
  const forward = (signal: NodeJS.Signals) => () => send({ signal });
  const onInt = forward("SIGINT"), onTerm = forward("SIGTERM");
  process.on("SIGINT", onInt); process.on("SIGTERM", onTerm);
  try {
    const mode = await ready;
    if (!mode) return await ended;
    if (!mode.queried) say("npm test: process queries unavailable; using lifetime IPC and a renewable lock lease");
    // A starter lost while waiting for a busy lock ends the wait too.
    const controller = new AbortController();
    void ended.then(() => controller.abort());
    const acquired = acquire({ ...o, file, say, lease: o.lease ?? !mode.queried, signal: controller.signal });
    const result = await Promise.race([acquired.then((value) => ({ lock: value })), ended.then((code) => ({ code }))]);
    if ("code" in result) { void acquired.then((value) => value?.release()); return result.code; }
    lock = result.lock;
    // Never without the lock: undefined only when the wait was ended, and then nothing runs.
    if (!lock || !guard.connected) { send({ stop: true }); return await ended; }
    send({ args, token: lock.token });
    return await ended;
  } finally {
    lock?.release();
    process.off("disconnect", parentGone); process.off("SIGINT", onInt); process.off("SIGTERM", onTerm);
    if (process.connected) process.disconnect();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args[0] === "--watchdog") watchdog(Number(args[1]), Number(args[2]), args[3]!);
  else if (!args.length) { console.error("usage: node scripts/test-lock.ts <node --test arguments>..."); process.exit(2); }
  else process.exitCode = await runLocked(args);
}
