// The worker host's lifetime is the ownership boundary, including loss of the server's control pipe.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { until, LONGER } from "./wait.ts";
import { setup, restart } from "./engine-setup.ts";
import { spawnRuntimeChild } from "../src/worker-process.ts";

const encode = (s: string) => Buffer.from(s, "utf8").toString("base64");
function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }

for (const how of ["pipe closed", "pipe closed during blocked input", "host killed"] as const) {
  test(`Windows job ends its runtime and child when ${how}`, { skip: process.platform !== "win32" }, async () => {
    const root = mkdtempSync(join(tmpdir(), "nexus-job-"));
    const script = join(root, "runtime.mjs");
    writeFileSync(script, `import {spawn} from 'node:child_process';
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio: 'ignore', windowsHide: true});
console.log(JSON.stringify({root: process.pid, child: child.pid, priority: (await import('node:os')).getPriority()}));
setInterval(() => {}, 1000);
`);
    const host = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", fileURLToPath(new URL("../src/worker-job.ps1", import.meta.url))], { cwd: root, stdio: "pipe", windowsHide: true, env: { ...process.env, NEXUS_JOB_BELOW_NORMAL: "1" } });
    let data = "", errors = "", family: { root: number; child: number; priority: number } | undefined;
    host.stdin.on("error", () => {});
    host.stderr.on("data", (chunk: Buffer) => { errors += chunk.toString(); });
    host.stdout.on("data", (chunk: Buffer) => {
      data += chunk.toString();
      let end: number;
      while ((end = data.indexOf("\n")) >= 0) {
        const line = data.slice(0, end).trimEnd(); data = data.slice(end + 1);
        if (line.startsWith("O ")) family = JSON.parse(Buffer.from(line.slice(2), "base64").toString("utf8")) as typeof family;
      }
    });
    const closed = new Promise<void>((resolve) => host.once("close", () => resolve()));
    host.stdin.write(`${encode(process.execPath)}\n${encode(`"${script}"`)}\n`);
    try {
      await until("runtime and child ready", () => !!family, LONGER.step, () => errors);
      assert.ok(alive(family!.root) && alive(family!.child));
      // Asked by the server, the job runs its whole tree below normal priority (queue SV3).
      assert.equal(family!.priority, constants.priority.PRIORITY_BELOW_NORMAL);
      if (how === "host killed") host.kill();
      else host.stdin.end(how === "pipe closed during blocked input" ? `W ${encode("x".repeat(512_000))}\n` : undefined);
      await closed;
      await until("job members gone", () => !alive(family!.root) && !alive(family!.child));
    } finally { host.kill(); await closed; }
  });
}

test("Windows worker recovery never terminates an unrelated process named by a stale PID", { skip: process.platform !== "win32" }, async () => {
  const fixture = setup(["done"]);
  const sentinel = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
  const closed = new Promise<void>((resolve) => sentinel.once("close", () => resolve()));
  let next: ReturnType<typeof restart> | undefined;
  try {
    fixture.store.writeSession({ protocol: 1, id: "stale-worker", project: "p", role: "worker", runtime: "claude", cwd: tmpdir(), launched_by: "nexus", created_at: new Date().toISOString() });
    fixture.store.writeRuntime("stale-worker", { state: "idle", pid: sentinel.pid, turns: 0, updated_at: new Date().toISOString() });
    fixture.engine.shutdown();
    next = restart(fixture.store);
    assert.equal(fixture.store.readRuntime("stale-worker")?.state, "exited");
    assert.ok(alive(sentinel.pid!));
  } finally { fixture.engine.shutdown(); next?.shutdown(); sentinel.kill(); await closed; }
});

// How soon after a worker's runtime ends the engine hears of it (the RuntimeChild's exit). The job host used to leave
// through Environment.Exit, whose PowerShell/.NET shutdown took 2.3 s (2294 to 2368 ms, queue FL, FL8); with the native
// ExitProcess it took 22 to 45 ms at rest. The bound leaves room for a busy machine and stays far under the old delay.
const EXIT_NOTICE_MS = 1000;

test("a worker runtime's exit reaches the engine at once, with its process tree already ended", { skip: process.platform !== "win32" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "nexus-job-exit-"));
  const script = join(root, "runtime.mjs");
  writeFileSync(script, `import {spawn} from 'node:child_process';
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio: 'ignore', windowsHide: true});
console.log(JSON.stringify({root: process.pid, child: child.pid}));
setTimeout(() => { console.log(JSON.stringify({exiting: Date.now()})); process.exit(3); }, 300);
`);
  const runtime = spawnRuntimeChild(process.execPath, [script], { cwd: root, env: process.env, owned: true });
  let text = "";
  runtime.stdout.on("data", (chunk: Buffer) => { text += chunk.toString(); });
  const code = await new Promise<number>((resolve) => runtime.once("exit", resolve));
  const heard = Date.now();
  const [family, end] = text.trim().split("\n").map((l) => JSON.parse(l) as { root: number; child: number; exiting: number });
  assert.equal(code, 3, "the runtime's own exit code");
  const took = heard - end!.exiting;
  assert.ok(took < EXIT_NOTICE_MS, `the exit was heard ${took} ms after the runtime ended; the bound is ${EXIT_NOTICE_MS} ms`);
  assert.ok(!alive(family!.root) && !alive(family!.child), "the runtime and its child are gone when the exit is heard");
});
