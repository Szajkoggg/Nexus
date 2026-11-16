// The machine's full-test lock (scripts/test-lock.ts): a second run waits for the first, a lock whose process is gone
// or that was held longer than a full run takes is taken over, after the longest wait the run goes without the lock,
// a run ends with its starter (its process tree and its lock gone), and test:files never waits. Each test has a lock
// file of its own in a temporary folder, never the machine's real one, and ends only processes it started.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { acquire, alive, ancestry, msysParents, starterChain, type Proc } from "../test-lock.ts";

const here = dirname(fileURLToPath(import.meta.url));
const scripts = dirname(here);
const lockFile = () => join(mkdtempSync(join(tmpdir(), "nexus-test-lock-")), "full-test.lock");
/** The pid of a process that has ended. */
const deadPid = () => spawnSync(process.execPath, ["-e", ""]).pid!;
/** A tiny passing test file, for the scripts that run node --test. */
function tinyTest(): string {
  const file = join(mkdtempSync(join(tmpdir(), "nexus-test-lock-")), "tiny.test.mjs");
  writeFileSync(file, "import { test } from 'node:test';\ntest('tiny', () => {});\n");
  return file;
}
/** Runs node with these arguments; resolves with the exit code, the output and the time it took. */
function node(args: string[], env: Record<string, string>): Promise<{ code: number | null; out: string; ms: number }> {
  const started = performance.now();
  return new Promise((resolve) => {
    const env2: NodeJS.ProcessEnv = { ...process.env, ...env };
    // Not a test of this run's own: node --test inside a test file would skip its files.
    delete env2.NEXUS_DIR; delete env2.NEXUS_SESSION; delete env2.NEXUS_HANDOVER; delete env2.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, args, { env: env2, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let out = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => { out += d; });
    child.stderr.setEncoding("utf8").on("data", (d: string) => { out += d; });
    child.on("exit", (code) => resolve({ code, out, ms: performance.now() - started }));
  });
}

test("the second run waits for the first, saying what it waits for, and takes the lock once it is free", async () => {
  const file = lockFile();
  const first = await acquire({ file, say: () => {} });
  assert.ok(first && existsSync(file));
  assert.equal(JSON.parse(readFileSync(file, "utf8")).pid, process.pid);
  const lines: string[] = [];
  let second: Awaited<ReturnType<typeof acquire>> | "waiting" = "waiting";
  const waiting = acquire({ file, pid: process.pid + 1_000_000, cwd: "C:/other", maxWaitMs: 60_000, pollMs: 20, sayEveryMs: 100, say: (l) => lines.push(l) })
    .then((l) => { second = l; });
  await new Promise((r) => setTimeout(r, 350));
  assert.equal(second, "waiting", "the first still holds it");
  assert.match(lines[0]!, new RegExp(`^npm test: waiting for the full test run in .* \\(pid ${process.pid}, since \\d\\d:\\d\\d\\) to end \\(0 of at most 1 min\\)$`));
  assert.ok(lines.length >= 2, "and says it again while it waits");
  first.release();
  await waiting;
  assert.ok(second && second !== "waiting", "then it takes the lock");
  assert.equal(JSON.parse(readFileSync(file, "utf8")).cwd.replaceAll("\\", "/"), "C:/other");
  first.release(); // no longer the first's: left alone
  assert.ok(existsSync(file));
  (second as { release: () => void }).release();
  assert.ok(!existsSync(file));
});

test("a lock whose process is gone is taken over at once", async () => {
  const file = lockFile();
  const pid = deadPid();
  assert.equal(alive(pid), false);
  writeFileSync(file, JSON.stringify({ pid, cwd: "C:/crashed", since: new Date().toISOString() }));
  const lines: string[] = [];
  const started = performance.now();
  const lock = await acquire({ file, maxWaitMs: 60_000, pollMs: 20, say: (l) => lines.push(l) });
  assert.ok(lock);
  assert.ok(performance.now() - started < 1000, "no waiting");
  assert.deepEqual(lines, [`npm test: took over the full-test lock of a run that is gone (pid ${pid}, C:/crashed)`]);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).pid, process.pid);
  lock.release();
  // An unreadable lock file is being written while it is young; an old one is taken over too.
  writeFileSync(file, "");
  assert.equal(await acquire({ file, maxWaitMs: 100, pollMs: 20, say: () => {} }), undefined, "a young, empty file: its taker is alive");
  const old = new Date(Date.now() - 60_000);
  utimesSync(file, old, old);
  const taken = await acquire({ file, maxWaitMs: 100, pollMs: 20, say: () => {} });
  assert.ok(taken, "an old one that cannot be read is taken over");
  taken.release();
});

test("a lock held longer than a full run takes is taken over at once, its holder alive; a younger one makes a run wait", async () => {
  const file = lockFile();
  // Held by a live process (this one) for 25 minutes: a hung run, or a pid reused.
  writeFileSync(file, JSON.stringify({ pid: process.pid, cwd: "C:/hung", since: new Date(Date.now() - 25 * 60_000).toISOString() }));
  const lines: string[] = [];
  const started = performance.now();
  const lock = await acquire({ file, pid: process.pid + 1_000_000, cwd: "C:/next", maxWaitMs: 60_000, pollMs: 20, say: (l) => lines.push(l) });
  assert.ok(lock, "taken over");
  assert.ok(performance.now() - started < 1000, "no waiting");
  assert.deepEqual(lines, [`npm test: took over the full-test lock of a run that has held it for 25 min, longer than a full run takes (pid ${process.pid}, C:/hung)`]);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).cwd.replaceAll("\\", "/"), "C:/next");
  lock.release();
  // The limit is a setting of its own; a lock younger than it, held by a live process, makes the run wait.
  writeFileSync(file, JSON.stringify({ pid: process.pid, cwd: "C:/busy", since: new Date(Date.now() - 2 * 60_000).toISOString() }));
  const waited: string[] = [];
  assert.equal(await acquire({ file, pid: process.pid + 1_000_000, staleMs: 3 * 60_000, maxWaitMs: 300, pollMs: 20, say: (l) => waited.push(l) }), undefined);
  assert.match(waited[0]!, /^npm test: waiting for the full test run in C:\/busy/);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).cwd, "C:/busy", "left as it is");
  const taken = await acquire({ file, pid: process.pid + 1_000_000, staleMs: 60_000, maxWaitMs: 300, pollMs: 20, say: () => {} });
  assert.ok(taken, "the same lock is stale under a shorter limit");
  taken.release();
});

test("a process's ancestry, as the system tells it: itself, then its parent, each with its name and command line", async () => {
  const chain = await ancestry(process.pid);
  assert.ok(chain.length >= 2, JSON.stringify(chain));
  assert.deepEqual(chain.slice(0, 2).map((p) => p.pid), [process.pid, process.ppid]);
  assert.equal(chain[0]!.ppid, process.ppid);
  assert.match(chain[0]!.name, /^node(\.exe)?$/i);
  assert.match(chain[0]!.commandLine, /test-lock\.test\.ts/);
  if (process.platform === "win32") assert.ok(chain[1]!.created > 0 && chain[1]!.created <= chain[0]!.created, "creation times, the parent's first");
});

test("the processes whose end ends a run: its parent, then the shells and npm above it", () => {
  const p = (pid: number, ppid: number, name: string, commandLine = name, created = 1000 - pid): Proc => ({ pid, ppid, created, name, commandLine });
  const chain = [
    p(10, 20, "cmd.exe", 'cmd.exe /d /s /c "node scripts/test-lock.ts --test x.test.ts"'),
    p(20, 30, "node.exe", '"C:\\Program Files\\nodejs\\node.exe" "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js" test'),
    p(30, 40, "bash.exe"),
    p(40, 50, "claude.exe", "claude -p --input-format stream-json"),
    p(50, 60, "node.exe", "node apps/server/src/main.ts"),
  ];
  assert.deepEqual(starterChain(chain), [10, 20, 30], "up to the agent that ran the command, not beyond");
  // The parent always, whatever it is (here a test's node process that started the run).
  assert.deepEqual(starterChain([p(10, 20, "node.exe", "node -e ..."), p(20, 30, "node.exe", "node --test x.test.ts")]), [10]);
  // npm elsewhere: its process is titled npm.
  assert.deepEqual(starterChain([p(10, 20, "sh"), p(20, 30, "npm", "npm test"), p(30, 40, "zsh"), p(40, 1, "sshd")]), [10, 20, 30]);
  // A pid the system gave to a process newer than the one below is no ancestor (Windows reuses pids).
  assert.deepEqual(starterChain([p(10, 20, "cmd.exe"), p(20, 30, "bash.exe", "bash", 5000)]), [10]);
  assert.deepEqual(starterChain([p(10, 20, "cmd.exe"), p(21, 30, "bash.exe")]), [10], "not the parent of the one below");
});

/**
 * A run of test-lock.ts started by a shell of the test's ("the starter", which stays until it is ended; Git Bash with
 * `gitBash`), with a test file that starts a process of its own and waits long: resolves once the run is at work and
 * its watchdog knows what it watches, with the pids.
 */
async function longRun(file: string, gitBash?: string): Promise<{ starter: ChildProcess; watched: number[]; end: () => void; pids: { wrapper: number; runner: number; testFile: number; grandchild: number } }> {
  const dir = mkdtempSync(join(tmpdir(), "nexus-test-lock-"));
  const pidsFile = join(dir, "pids.json");
  const watchedFile = join(dir, "watched.json");
  const long = join(dir, "long.test.mjs");
  writeFileSync(long, [
    "import { test } from 'node:test';",
    "import { spawn } from 'node:child_process';",
    "import { writeFileSync } from 'node:fs';",
    // Everything ends by itself after two minutes, also when a failing test leaves it.
    "test('long', async () => {",
    "  const g = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore' });",
    "  g.unref();",
    `  writeFileSync(${JSON.stringify(pidsFile)}, JSON.stringify({ testFile: process.pid, runner: process.ppid, grandchild: g.pid }));`,
    "  await new Promise((r) => setTimeout(r, 120000));",
    "});",
    "",
  ].join("\n"));
  const env: NodeJS.ProcessEnv = { ...process.env, NEXUS_TEST_LOCK: file, NEXUS_TEST_LOCK_WATCHED: watchedFile };
  // Not a test of this run's own: node --test inside a test file would skip its files.
  delete env.NEXUS_DIR; delete env.NEXUS_SESSION; delete env.NEXUS_HANDOVER; delete env.NODE_TEST_CONTEXT;
  // A shell, as npm and a worker's command have: killed, it leaves its children running (a Node process would take its
  // own along, libuv's job object on Windows). sh runs the last command of -c in its own process unless more follows.
  const slash = (p: string) => p.replaceAll("\\", "/");
  const line = `"${slash(process.execPath)}" "${slash(join(scripts, "test-lock.ts"))}" --test "${slash(long)}"`;
  // In Git Bash a bash inside, as npm's own script has (an MSYS program exec'd by a forked MSYS process).
  const starter = gitBash ? spawn(gitBash, ["-c", `bash -c '${line}; true'; true`], { env, stdio: "ignore", windowsHide: true })
    : process.platform === "win32" ? spawn("cmd.exe", ["/d", "/s", "/c", `"${line}"`], { env, stdio: "ignore", windowsHide: true, windowsVerbatimArguments: true })
    : spawn("sh", ["-c", `${line}; true`], { env, stdio: "ignore" });
  const read = <T>(f: string): T | undefined => { try { return JSON.parse(readFileSync(f, "utf8")) as T; } catch { return undefined; } };
  const known = () => ({ ...read<{ runner: number; testFile: number; grandchild: number }>(pidsFile), wrapper: read<{ pid: number }>(file)?.pid });
  /** Ends what is left of the run, by the pids it recorded (all the test's own): for a test that fails half way. */
  const end = () => {
    for (const pid of [starter.pid, ...Object.values(known())]) {
      if (!pid || !alive(pid)) continue;
      if (process.platform === "win32") spawnSync("taskkill", ["/T", "/F", "/PID", String(pid)], { stdio: "ignore", windowsHide: true });
      else try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
    }
  };
  for (const until = Date.now() + 60_000; !(existsSync(pidsFile) && existsSync(file) && existsSync(watchedFile));) {
    if (Date.now() > until) { end(); throw new Error("the run did not start"); }
    await new Promise((r) => setTimeout(r, 50));
  }
  const pids = known() as { runner: number; testFile: number; grandchild: number; wrapper: number };
  return { starter, pids, end, watched: read<number[]>(watchedFile) ?? [] };
}

/** Git Bash's bash.exe on Windows (the launcher in its bin folder, as a worker's commands run), if it is installed. */
const gitBash = process.platform === "win32" ? [join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe")].find(existsSync) : undefined;

/** Waits until none of `pids` is alive and `file` is gone (at most 30 s). */
async function allGone(pids: Record<string, number>, file: string): Promise<void> {
  const left = () => Object.entries(pids).filter(([, pid]) => alive(pid)).map(([name]) => name);
  for (const until = Date.now() + 30_000; (left().length || existsSync(file)) && Date.now() < until;) await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(left(), [], "every process of the run ended");
  assert.ok(!existsSync(file), "the lock is removed");
}

test("a run ends with its starter: its runner, its test files and what they started exit, and the lock goes", async () => {
  const file = lockFile();
  const { starter, pids, end } = await longRun(file);
  try {
    assert.deepEqual(Object.values(pids).map(alive), [true, true, true, true], "the run is at work");
    starter.kill("SIGKILL"); // the starter ends without a word (a background command's time limit, a killed shell)
    await allGone({ ...pids, starter: starter.pid! }, file);
  } finally { end(); }
});

test("a run started by Git Bash ends with it too, its MSYS processes followed to the bash that started it", { skip: !gitBash && "Windows with Git Bash only" }, async () => {
  const file = lockFile();
  const { starter, pids, watched, end } = await longRun(file, gitBash);
  try {
    // Git Bash forks: the shell that runs the command is not the Windows parent of what it started (that one is gone),
    // only in MSYS's own process table. The watchdog follows it there, up to the launcher this test started.
    assert.ok(watched.includes(starter.pid!), `the launcher is watched: ${JSON.stringify(watched)}, launcher ${starter.pid}`);
    starter.kill("SIGKILL");
    await allGone({ ...pids, starter: starter.pid! }, file);
  } finally { end(); }
});

test("MSYS's process table: each process's Windows pid to its parent's", () => {
  // `ps -e -l` of Git Bash 2.x as it was seen (queue TF): PID PPID PGID WINPID TTY UID STIME COMMAND, a status letter
  // before some rows.
  const out = [
    "      PID    PPID    PGID     WINPID   TTY         UID    STIME COMMAND",
    "      712       1     712     116388  ?         197609 09:14:54 /usr/bin/bash",
    "      713     712     712     137616  ?         197609 09:14:54 /usr/bin/bash",
    "S     721     713     712     135796  ?         197609 09:14:54 /c/Program Files/nodejs/node",
    "      705       1     705     130660  ?         197609 09:14:53 /usr/bin/bash",
  ].join("\r\n");
  assert.deepEqual([...msysParents(out)], [[137616, 116388], [135796, 137616]]);
});

test("a run whose wrapper is killed by itself ends too, and its lock goes", async () => {
  const file = lockFile();
  const { pids, end } = await longRun(file);
  try {
    process.kill(pids.wrapper, "SIGKILL");
    await allGone(pids, file);
  } finally { end(); }
});

test("after the longest wait the run goes without the lock, and says so", async () => {
  const file = lockFile();
  // Taken a minute ago (an older lock would be stale) by a live process: this one.
  const since = new Date(Date.now() - 60_000).toISOString();
  writeFileSync(file, JSON.stringify({ pid: process.pid, cwd: "C:/stuck", since }));
  const lines: string[] = [];
  const lock = await acquire({ file, pid: process.pid + 1_000_000, maxWaitMs: 200, pollMs: 20, say: (l) => lines.push(l) });
  assert.equal(lock, undefined);
  assert.equal(lines.at(-1), `npm test: waited 0 min for the full test run in C:/stuck (pid ${process.pid}, since ${since.slice(11, 16)}); running now without the lock`);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).cwd, "C:/stuck", "the other run's lock is left as it is");
});

test("the script runs node --test under the lock and removes it after; held by a live run, it waits at most the longest wait", async () => {
  const tiny = tinyTest();
  const file = lockFile();
  const free = await node([join(scripts, "test-lock.ts"), "--test", tiny], { NEXUS_TEST_LOCK: file });
  assert.equal(free.code, 0, free.out);
  assert.match(free.out, /pass 1/);
  assert.ok(!existsSync(file), "the lock is removed after the run");

  writeFileSync(file, JSON.stringify({ pid: process.pid, cwd: "C:/busy", since: new Date().toISOString() }));
  const held = await node([join(scripts, "test-lock.ts"), "--test", tiny], { NEXUS_TEST_LOCK: file, NEXUS_TEST_LOCK_MAX_MS: "1500" });
  assert.equal(held.code, 0, held.out);
  assert.match(held.out, /npm test: waiting for the full test run in C:\/busy/);
  assert.match(held.out, /running now without the lock/);
  assert.ok(held.ms >= 1500, `it waited (${Math.round(held.ms)} ms)`);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).cwd, "C:/busy", "the live run's lock stays");

  // A failing run's exit code comes through.
  const failing = join(dirname(tiny), "failing.test.mjs");
  writeFileSync(failing, "import { test } from 'node:test';\ntest('fails', () => { throw new Error('no'); });\n");
  const other = lockFile();
  assert.equal((await node([join(scripts, "test-lock.ts"), "--test", failing], { NEXUS_TEST_LOCK: other })).code, 1);
  assert.ok(!existsSync(other));
});

test("test:files never waits for the lock", async () => {
  const file = lockFile();
  writeFileSync(file, JSON.stringify({ pid: process.pid, cwd: "C:/busy", since: new Date().toISOString() }));
  const r = await node([join(scripts, "test-files.mjs"), tinyTest()], { NEXUS_TEST_LOCK: file, NEXUS_TEST_LOCK_MAX_MS: "60000" });
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /waiting for/);
  assert.match(r.out, /1 file\(s\) passed/);
  assert.ok(r.ms < 30_000);
});
