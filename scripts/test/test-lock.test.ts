// The machine's full-test lock (scripts/test-lock.ts): a second run waits for the first, a lock whose process is gone
// is taken over, after the longest wait the run goes without the lock, and test:files never waits. Each test has a
// lock file of its own in a temporary folder, never the machine's real one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { acquire, alive } from "../test-lock.ts";

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

test("after the longest wait the run goes without the lock, and says so", async () => {
  const file = lockFile();
  writeFileSync(file, JSON.stringify({ pid: process.pid, cwd: "C:/stuck", since: "2026-11-15T10:00:00.000Z" }));
  const lines: string[] = [];
  const lock = await acquire({ file, pid: process.pid + 1_000_000, maxWaitMs: 200, pollMs: 20, say: (l) => lines.push(l) });
  assert.equal(lock, undefined);
  assert.match(lines.at(-1)!, /^npm test: waited 0 min for the full test run in C:\/stuck \(pid \d+, since 10:00\); running now without the lock$/);
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
