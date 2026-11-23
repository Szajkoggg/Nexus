// The worker host's lifetime is the ownership boundary, including loss of the server's control pipe.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFileSync, appendFileSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { until, LONGER } from "./wait.ts";
import { setup, restart } from "./engine-setup.ts";
import { spawnRuntimeChild } from "../src/worker-process.ts";
import { tempDir } from "./temp-dirs.ts";

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


// The job host's C# from a machine-wide cache (queue TI, TI3): compiled by the first host, loaded from its bytes by the
// next ones, compiled again when the source changes, and compiled in memory as before when the cached file is unusable.
const HOST_SOURCES = ["worker-job.ps1", "worker-job.cs"] as const;
const UP = "up false\n";

/** A copy of the host's two files, so that a test may change the source without touching the repository's. */
function hostCopy(): string {
  const dir = tempDir("nexus-job-src-");
  for (const f of HOST_SOURCES) copyFileSync(fileURLToPath(new URL(`../src/${f}`, import.meta.url)), join(dir, f));
  return dir;
}

/**
 * Starts a host from `dir` with its cache in `cache`; its runtime prints one line (whether it sees the trace variable)
 * and ends. How the host got its type, what the runtime printed, the host's stderr and exit code.
 */
async function startHost(dir: string, cache: string): Promise<{ how: string; out: string; errors: string; code: number | null }> {
  const host = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", join(dir, "worker-job.ps1")], {
    cwd: dir, stdio: "pipe", windowsHide: true, env: { ...process.env, NEXUS_JOB_CACHE: cache, NEXUS_JOB_CACHE_TRACE: "1" },
  });
  let out = "", errors = "";
  host.stdin.on("error", () => {});
  host.stdout.on("data", (chunk: Buffer) => { out += chunk.toString(); });
  host.stderr.on("data", (chunk: Buffer) => { errors += chunk.toString(); });
  const closed = new Promise<number | null>((resolve) => host.once("close", resolve));
  // The input stays open: its end would end the job, perhaps before the runtime printed.
  host.stdin.write(`${encode(process.execPath)}\n${encode(`-e "console.log('up', !!process.env.NEXUS_JOB_CACHE_TRACE)"`)}\n`);
  const code = await closed;
  const printed = out.split("\n").filter((l) => l.startsWith("O ")).map((l) => Buffer.from(l.slice(2).trim(), "base64").toString("utf8")).join("");
  return { code, errors, out: printed.replace(/\r/g, ""), how: /worker job cache: (cached|stored|fallback)\b/.exec(errors)?.[1] ?? "none" };
}

const assemblies = (cache: string) => readdirSync(cache).filter((f) => f.endsWith(".dll"));
const temporaries = (cache: string) => readdirSync(cache).filter((f) => f.endsWith(".tmp"));

test("the job host compiles its C# once into the cache, loads it from there next time, and again after a change", { skip: process.platform !== "win32" }, async () => {
  const dir = hostCopy(), cache = tempDir("nexus-job-cache-");
  const first = await startHost(dir, cache);
  assert.equal(first.how, "stored", first.errors);
  assert.equal(first.out, UP, "the runtime ran, without the trace variable");
  const [dll] = assemblies(cache);
  assert.ok(dll, "the compiled assembly is in the cache");
  const written = statSync(join(cache, dll)).mtimeMs;
  const second = await startHost(dir, cache);
  assert.equal(second.how, "cached", second.errors);
  assert.equal(second.out, UP);
  assert.deepEqual(assemblies(cache), [dll], "no second assembly");
  assert.equal(statSync(join(cache, dll)).mtimeMs, written, "the cached file was not written again");
  assert.deepEqual(temporaries(cache), [], "no temporary file left");

  // A changed source has another hash: compiled again, into a file of its own.
  appendFileSync(join(dir, "worker-job.cs"), "\n// changed\n");
  const changed = await startHost(dir, cache);
  assert.equal(changed.how, "stored", changed.errors);
  assert.equal(changed.out, UP);
  assert.equal(assemblies(cache).length, 2);
});

test("an unusable cached assembly falls back to compiling, logged, and the next host stores a sound one", { skip: process.platform !== "win32" }, async () => {
  const dir = hostCopy(), cache = tempDir("nexus-job-cache-");
  assert.equal((await startHost(dir, cache)).how, "stored");
  const [dll] = assemblies(cache);
  writeFileSync(join(cache, dll!), "not an assembly");
  const broken = await startHost(dir, cache);
  assert.equal(broken.how, "fallback", broken.errors);
  assert.match(broken.errors, /could not load .*worker-job-[0-9a-f]{16}\.dll, compiling instead/);
  assert.equal(broken.out, UP, "the runtime still ran");
  assert.match(readFileSync(join(cache, "worker-job.log"), "utf8"), /could not load/);
  const next = await startHost(dir, cache);
  assert.equal(next.how, "stored", next.errors);
  assert.equal(next.out, UP);
  assert.equal((await startHost(dir, cache)).how, "cached");
});

test("job hosts starting at once with an empty cache all start, and leave one sound assembly", { skip: process.platform !== "win32" }, async () => {
  const dir = hostCopy(), cache = tempDir("nexus-job-cache-");
  const hosts = await Promise.all([1, 2, 3, 4].map(() => startHost(dir, cache)));
  for (const h of hosts) {
    assert.equal(h.code, 0, h.errors);
    assert.equal(h.out, UP, h.errors);
    assert.ok(h.how === "stored" || h.how === "cached", h.errors);
  }
  assert.equal(assemblies(cache).length, 1);
  assert.deepEqual(temporaries(cache), [], "no temporary file left");
  assert.equal((await startHost(dir, cache)).how, "cached", "the stored assembly loads");
});
