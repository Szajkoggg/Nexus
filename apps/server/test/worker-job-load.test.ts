// A worker's cleanup in a real Windows job host that holds many busy processes and a parent that keeps starting
// children while the cleanup runs (survey LC3, F5 and its Recommended addition 4; queue LCK, LCK3). This is what a
// worker running `node scripts/load-tests.mjs` in its job leaves when its turn ends: the IPF halts ("worker process
// cleanup failed: Error: worker cleanup timed out") came from such a job on a saturated machine. The server's end
// gives a cleanup 15 s (WorkerProcess.cleanup); the host must answer within it: done (every member but the runtime
// ended) or its own failure (an F frame: "worker job did not settle", a Win32 error), never the server's timer.
// The deterministic branches of Clean (the 10 s limit per member) are on the scripted seam, worker-end.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnRuntimeChild, type RuntimeChild } from "../src/worker-process.ts";
import { tempDir } from "./temp-dirs.ts";
import { LONGER, until } from "./wait.ts";

const windows = { skip: process.platform !== "win32" };
/** The server's limit for one cleanup (worker-process.ts, WorkerProcess.cleanup). */
const SERVER_LIMIT_MS = 15_000;
/** Busy processes in the job: as many as a load-tests run's burners. */
const BUSY = 12;
/** Children the spawning parent has started before the cleanup is asked for. */
const STARTED_BEFORE = 10;
const NL = String.fromCharCode(10);

/**
 * The runtime: BUSY busy-loop children, and a parent that starts an idle child every 20 ms (up to 400) and writes how
 * many it started. It prints the PIDs of its busy children and of the parent, then one line for each of them that
 * exits (its own child's exit event: a PID the machine gives to another process meanwhile cannot pass for one still
 * alive), and idles: it is the runtime the cleanup keeps.
 */
function runtimeScript(dir: string): string {
  const spawner = join(dir, "spawner.mjs");
  writeFileSync(spawner, [
    "import {spawn} from 'node:child_process';",
    "import {writeFileSync} from 'node:fs';",
    "let n = 0;",
    "const t = setInterval(() => {",
    "  spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio: 'ignore', windowsHide: true});",
    "  writeFileSync(process.argv[2], String(++n));",
    "  if (n >= 400) clearInterval(t);",
    "}, 20);",
  ].join(NL));
  const script = join(dir, "runtime.mjs");
  writeFileSync(script, [
    "import {spawn} from 'node:child_process';",
    "const watch = (child) => { child.on('exit', () => console.log(JSON.stringify({exited: child.pid}))); return child.pid; };",
    "const busy = [];",
    `for (let i = 0; i < ${BUSY}; i++) busy.push(watch(spawn(process.execPath, ['-e', 'for (;;) {}'], {stdio: 'ignore', windowsHide: true})));`,
    `const spawner = watch(spawn(process.execPath, [${JSON.stringify(spawner)}, ${JSON.stringify(join(dir, "started"))}], {stdio: 'ignore', windowsHide: true}));`,
    "console.log(JSON.stringify({root: process.pid, busy, spawner}));",
    "setInterval(() => {}, 1000);",
  ].join(NL));
  return script;
}

type Line = { root?: number; busy?: number[]; spawner?: number; exited?: number };

test("a job of busy processes and a parent starting children: the host's cleanup answers within the server's 15 s, done with every member but the runtime ended, or with the host's own failure", windows, async () => {
  const dir = tempDir("nexus-job-load-");
  const runtime: RuntimeChild = spawnRuntimeChild(process.execPath, [runtimeScript(dir)], { cwd: dir, env: process.env, owned: true });
  let text = "";
  runtime.stdout.on("data", (chunk: Buffer) => { text += chunk.toString(); });
  let gone = false;
  const exited = new Promise<void>((resolve) => runtime.once("exit", () => { gone = true; resolve(); }));
  const lines = (): Line[] => text.split(NL).map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l) as Line);
  const ended = () => new Set(lines().flatMap((l) => (l.exited ? [l.exited] : [])));
  const started = () => (existsSync(join(dir, "started")) ? Number(readFileSync(join(dir, "started"), "utf8")) || 0 : 0);
  try {
    await until("the runtime's family is up", () => lines().some((l) => l.root), LONGER.step);
    const family = lines().find((l) => l.root) as { root: number; busy: number[]; spawner: number };
    await until(`the parent started ${STARTED_BEFORE} children`, () => started() >= STARTED_BEFORE, LONGER.step);
    const at = Date.now();
    const outcome = await runtime.cleanup!().then(() => "done", (e: Error) => e.message);
    const took = Date.now() - at;
    assert.notEqual(outcome, "worker cleanup timed out", `the server's timer, not the host, ended the cleanup after ${took} ms`);
    assert.ok(took < SERVER_LIMIT_MS, `the host answered after ${took} ms`);
    if (outcome === "done") {
      const all = [...family.busy, family.spawner];
      // The runtime reports its children's exits: it is kept, and they are ended.
      await until("the runtime reports every busy process and the parent ended", () => all.every((pid) => ended().has(pid)), LONGER.processes, () => `; not reported: ${all.filter((pid) => !ended().has(pid)).join(" ")}`);
      assert.equal(gone, false, "the runtime is kept");
    } else assert.match(outcome, /worker job did not settle|worker job member|did not exit|TerminateProcess/, `the host's own failure: ${outcome}`);
    const line = `cleanup: ${outcome} in ${took} ms; the parent had started ${started()} children`;
    console.log(line);
    // A load run's record of every run's time (scripts/load-tests.mjs keeps only failed runs' output).
    if (process.env.NEXUS_TEST_JOB_LOAD_LOG) appendFileSync(process.env.NEXUS_TEST_JOB_LOAD_LOG, line + NL);
  } finally {
    runtime.kill();
    await exited;
  }
});
