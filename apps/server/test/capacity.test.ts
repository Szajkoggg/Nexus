// The capacity coordinator's first slice (src/capacity.ts; queue EC, EC2): heavy operations of two projects asked for
// at once run one after the other, the second's wait shown in capacity.yaml and `nexus status`; the slot follows the
// operation's processes (a killed process frees it, its whole tree gone; an operation said to be over still holds it
// while a process of it runs); and no wait, however long, ends in a start beside another heavy operation or beside a
// full test run outside Nexus. Real child processes (node sleepers), no agent runtime: the coordinator starts none.
// Each test has its own NEXUS_HOME and full-test lock file in a temporary folder, never the machine's real ones, and
// ends only the processes it started.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { constants, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectStore, readCapacity } from "@nexus/protocol";
import { processAlive } from "@nexus/protocol/full-test-lock";
import { Capacity, type Grant, type HeavyProcess } from "../src/capacity.ts";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "../../../packages/cli/bin/nexus.js");
process.env.NEXUS_HOME = mkdtempSync(join(tmpdir(), "nexus-capacity-home-"));
const lockFile = () => join(mkdtempSync(join(tmpdir(), "nexus-capacity-lock-")), "full-test.lock");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Whether the promise has settled within `ms`. */
async function settledWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  let done = false;
  void p.then(() => { done = true; }, () => { done = true; });
  await sleep(ms);
  return done;
}

/** A node process that waits `ms`; with `child`, it first starts a detached grandchild that would outlive it. */
function sleeper(grant: Grant, ms: number, o: { child?: boolean } = {}): HeavyProcess & { out: () => string } {
  const code = o.child
    ? `const g = require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], { detached: true, stdio: "ignore" }); g.unref(); console.log("grandchild " + g.pid); setTimeout(() => {}, ${ms});`
    : `console.log("started"); setTimeout(() => {}, ${ms});`;
  const p = grant.spawn(process.execPath, ["-e", code], { cwd: tmpdir() });
  let out = "";
  p.child.stdout.on("data", (d: Buffer) => { out += d.toString(); });
  p.child.stderr.on("data", () => {});
  return Object.assign(p, { out: () => out });
}

async function until(what: string, check: () => boolean, ms = 30_000): Promise<void> {
  for (const end = Date.now() + ms; !check(); await sleep(20)) if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
}

function status(): string {
  const root = mkdtempSync(join(tmpdir(), "nexus-capacity-project-"));
  const store = ProjectStore.init(root, { id: "b", name: "B", root });
  const env: NodeJS.ProcessEnv = { ...process.env, NEXUS_DIR: store.dir };
  delete env.NEXUS_SESSION;
  return execFileSync(process.execPath, [CLI, "status"], { env, encoding: "utf8" });
}

test("two projects' heavy operations asked for at once run one after the other; the second's wait is shown", async () => {
  const capacity = new Capacity({ testLock: lockFile() });
  try {
    const a = capacity.request({ kind: "checks", project: "a", queue: "EC", step: "EC3" });
    const b = capacity.request({ kind: "checks", project: "b", queue: "W", step: "W5" });
    const first = await a.granted;
    assert.equal(await settledWithin(b.granted, 200), false, "the second waits while the first holds the slot");

    const file = readCapacity()!;
    assert.deepEqual(file.held.map((r) => `${r.project} ${r.queue}/${r.step}`), ["a EC/EC3"]);
    assert.deepEqual(file.waiting.map((r) => `${r.project} ${r.queue}/${r.step}`), ["b W/W5"]);
    assert.equal(file.slots.heavy, 1);
    const shown = status();
    assert.match(shown, /^machine .+ \(one heavy operation at a time, across projects\):$/m);
    assert.match(shown, /^ {2}running: checks of EC\/EC3 \(project a\), since \d\d:\d\d$/m);
    assert.match(shown, /^ {2}waiting: checks of W\/W5 \(project b\), since \d\d:\d\d, 1st in line, behind checks of EC\/EC3 \(project a\)$/m);

    const run = sleeper(first, 300);
    first.end();
    let ended = 0;
    void run.done.then(() => { ended = Date.now(); });
    const second = await b.granted;
    assert.ok(ended > 0, "granted only after the first's process ended");
    assert.match(run.out(), /started/);
    assert.deepEqual(readCapacity()!.held.map((r) => r.project), ["b"]);
    assert.deepEqual(readCapacity()!.waiting, []);
    second.end();
    await until("the slot to be free", () => readCapacity()!.held.length === 0);
    assert.equal(status().includes("machine "), false, "nothing to show once nothing holds or waits");
  } finally { capacity.shutdown(); }
});

test("the slot follows the processes: an operation said to be over holds it while its process runs, and a killed process frees it", async () => {
  const capacity = new Capacity({ testLock: lockFile() });
  let run: (HeavyProcess & { out: () => string }) | undefined;
  let grandchild = 0;
  try {
    const first = await capacity.request({ kind: "checks", project: "a", queue: "EC", step: "EC3" }).granted;
    run = sleeper(first, 120_000, { child: true });
    await until("the grandchild's pid", () => /grandchild (\d+)/.test(run!.out()));
    grandchild = Number(/grandchild (\d+)/.exec(run.out())![1]);
    first.end(); // its owner is done, its process is not
    const b = capacity.request({ kind: "checks", project: "b", queue: "W", step: "W5" });
    assert.equal(await settledWithin(b.granted, 500), false, "still held: its process runs");
    assert.equal(readCapacity()!.held[0]!.project, "a");

    // Killed from outside, by its pid (this test's own process), as a crash or a hand would: not through the grant.
    assert.ok(run.child.pid);
    process.kill(run.child.pid);
    const second = await b.granted;
    assert.equal(readCapacity()!.held[0]!.project, "b");
    if (process.platform === "win32") {
      // On Windows the job ends the whole tree before the slot is free: the detached grandchild is gone too.
      assert.equal(processAlive(grandchild), false, "the operation's whole tree ended before the slot was freed");
    }
    second.end();
  } finally {
    run?.kill();
    capacity.shutdown();
  }
});

test("no wait ends in a start beside another heavy operation, however long it lasts", async () => {
  const capacity = new Capacity({ testLock: lockFile(), pollMs: 20 });
  let run: HeavyProcess | undefined;
  try {
    const first = await capacity.request({ kind: "checks", project: "a", queue: "EC", step: "EC3" }).granted;
    run = sleeper(first, 120_000);
    const b = capacity.request({ kind: "checks", project: "b", queue: "W", step: "W5" });
    // Many times the poll interval: there is no time after which it starts anyway.
    assert.equal(await settledWithin(b.granted, 2000), false);
    assert.equal(readCapacity()!.waiting.length, 1);
    first.end();
    assert.equal(await settledWithin(b.granted, 300), false, "ended, but its process still runs");
    run.kill();
    (await b.granted).end();
  } finally {
    run?.kill();
    capacity.shutdown();
  }
});

test("a full test run outside Nexus keeps every request waiting, shown as what occupies the machine, until it ends", async () => {
  const lock = lockFile();
  // Held by a live process (this one) for 19 minutes, just short of stale.
  const since = new Date(Date.now() - 19 * 60_000).toISOString();
  writeFileSync(lock, JSON.stringify({ pid: process.pid, cwd: "C:/by-hand", since }));
  const capacity = new Capacity({ testLock: lock, pollMs: 20 });
  try {
    const a = capacity.request({ kind: "checks", project: "a", queue: "EC", step: "EC3" });
    assert.equal(await settledWithin(a.granted, 1000), false, "not granted beside the run outside Nexus");
    const file = readCapacity()!;
    assert.deepEqual(file.outside, { cwd: "C:/by-hand", pid: process.pid, since });
    const shown = status();
    assert.match(shown, /^ {2}waiting: checks of EC\/EC3 \(project a\), since \d\d:\d\d, 1st in line, behind a full test run outside Nexus$/m);
    assert.match(shown, new RegExp(`^ {2}outside Nexus: a full test run in C:/by-hand \\(pid ${process.pid}, since .+\\); nothing is granted until it ends$`, "m"));

    unlinkSync(lock); // the run by hand ends
    (await a.granted).end();
    await until("the slot to be free", () => readCapacity()!.held.length === 0);
    assert.equal(readCapacity()!.outside, undefined);
  } finally { capacity.shutdown(); }
});

test("a starting server writes the file anew, a cancelled request leaves the line, and a stopped coordinator grants nothing", async () => {
  const lock = lockFile();
  const old = new Capacity({ testLock: lock });
  const held = await old.request({ kind: "checks", project: "a", queue: "EC", step: "EC3" }).granted;
  old.request({ kind: "checks", project: "b", queue: "W", step: "W5" });
  assert.equal(readCapacity()!.waiting.length, 1);
  old.shutdown();
  held.end();

  const next = new Capacity({ testLock: lock });
  try {
    const file = readCapacity()!;
    assert.deepEqual([file.held, file.waiting], [[], []], "the old server's grants and line are gone");
    const a = await next.request({ kind: "checks", project: "a", queue: "Q", step: "Q1" }).granted;
    const b = next.request({ kind: "checks", project: "b", queue: "R", step: "R1" });
    const c = next.request({ kind: "checks", project: "c", queue: "S", step: "S1" });
    b.cancel();
    await assert.rejects(b.granted, /cancelled/);
    assert.deepEqual(readCapacity()!.waiting.map((r) => r.project), ["c"]);
    a.end();
    (await c.granted).end();
  } finally { next.shutdown(); }
  await assert.rejects(next.request({ kind: "checks", project: "d", queue: "T", step: "T1" }).granted, /stopped/);
  assert.ok(!existsSync(lock) || readFileSync(lock, "utf8") === "", "the coordinator never takes the test lock itself");
});

test("a granted process and the children it starts run below normal priority (queue SV3)", async () => {
  const capacity = new Capacity({ testLock: lockFile() });
  try {
    const grant = await capacity.request({ kind: "checks", project: "a", queue: "SV", step: "SV3" }).granted;
    const code = `const os = require("node:os");
const child = require("node:child_process").spawnSync(process.execPath, ["-e", "console.log(require('node:os').getPriority())"], { encoding: "utf8", windowsHide: true });
console.log("priority " + os.getPriority() + " " + child.stdout.trim());`;
    const p = grant.spawn(process.execPath, ["-e", code], { cwd: tmpdir() });
    let out = "";
    p.child.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    p.child.stderr.on("data", () => {});
    await p.done;
    grant.end();
    const below = constants.priority.PRIORITY_BELOW_NORMAL;
    assert.match(out, new RegExp(`priority ${below} ${below}`), out);
  } finally { capacity.shutdown(); }
});
