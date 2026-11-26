// H6 of the LWH survey (queue WHR, WHR3): the server's end of a job host's control pipe (WorkerProcess). The frame tests
// give it a pipe of their own (FakeHost) and node:test's mock timers for its 5 s and 15 s deadlines, so every frame,
// every timer and every kill is the test's to send, pass and count. A fake pipe proves no OS resource is freed: the last
// test runs the real job host and shows its job's process and directory lock gone.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { CleanupTimedOut } from "../src/agent.ts";
import { ENDED_CLIENT, WorkerProcess, agentOwning, endAgentJobs, spawnRuntimeChild } from "../src/worker-process.ts";
import { LONGER, until } from "./wait.ts";

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");

/** The job host's side of the pipe: what the server wrote, frames the test sends back, the kills it got. */
class FakeHost extends EventEmitter {
  input = "";
  kills = 0;
  readonly stdin = new Writable({ write: (chunk: Buffer, _e, done) => { this.input += chunk.toString(); done(); } });
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  kill(): boolean { this.kills++; return true; }
  /** The server's lines after the two start lines (the runtime's binary and arguments). */
  frames(): string[] { return this.input.split("\n").filter(Boolean).slice(2); }
  send(text: string): void { this.stdout.write(text); }
  close(code: number | null = 0): void { this.emit("close", code); }
}

/** A promise's outcome as the test sees it, counted: a second settlement would show as a count of 2. */
function watch(p: Promise<void>) {
  const seen = { resolved: 0, rejected: 0, error: undefined as Error | undefined };
  p.then(() => { seen.resolved++; }, (e: Error) => { seen.rejected++; seen.error = e; });
  return seen;
}

/** Lets the streams deliver what was written (setImmediate is not among the mocked timers). */
const settle = () => new Promise<void>((r) => setImmediate(r));

function start(t: TestContext, clock = true) {
  if (clock) t.mock.timers.enable({ apis: ["setTimeout"] });
  const host = new FakeHost();
  const worker = new WorkerProcess("runtime.exe", ["--flag"], { cwd: tmpdir(), env: {} }, () => host as unknown as ChildProcessWithoutNullStreams);
  let errors = "";
  worker.stderr.on("data", (b: Buffer) => { errors += b.toString(); });
  const exits: (number | null)[] = [];
  worker.on("exit", (code: number | null) => exits.push(code));
  const tick = async (ms: number) => { t.mock.timers.tick(ms); await settle(); };
  return { host, worker, errors: () => errors, exits, tick };
}

/** Nothing armed is left: a minute on the clock writes no frame and kills nothing. */
async function quiet(h: ReturnType<typeof start>): Promise<void> {
  const frames = h.host.frames().length, kills = h.host.kills;
  await h.tick(60_000);
  assert.equal(h.host.frames().length, frames, "no frame written by a leftover timer");
  assert.equal(h.host.kills, kills, "no kill by a leftover timer");
}

test("two cleanups, two ids: only each one's own C resolves it, exactly once; a foreign, repeated or another request's id does nothing", async (t) => {
  const h = start(t);
  const a = watch(h.worker.cleanup()), b = watch(h.worker.cleanup());
  const owner = h.worker.owns(5000, 4318);
  assert.deepEqual(h.host.frames(), ["C 1", "C 2", "T 3 5000 4318"]);
  h.host.send("C 99\nC 3\n"); await settle();
  assert.deepEqual([a.resolved, b.resolved, a.rejected, b.rejected], [0, 0, 0, 0], "an unknown id and the T request's id resolve no cleanup");
  h.host.send("C 2\n"); await settle();
  assert.deepEqual([a.resolved, b.resolved], [0, 1]);
  h.host.send("C 2\r\n"); await settle();
  assert.deepEqual([a.resolved, b.resolved], [0, 1], "a repeated C resolves nothing more");
  h.host.send("C 1\r\n"); await settle();
  assert.deepEqual([a.resolved, b.resolved, a.rejected, b.rejected], [1, 1, 0, 0]);
  h.host.send("T 3 1\n");
  assert.equal(await owner, "job");
  assert.equal(h.host.kills, 0);
  assert.equal(h.errors(), "");
  await quiet(h);
});

test("a frame split across chunks and within its line is read whole, and only once its line ends", async (t) => {
  const h = start(t);
  const a = watch(h.worker.cleanup());
  let out = "";
  h.worker.stdout.on("data", (b: Buffer) => { out += b.toString(); });
  h.host.send("C"); await settle();
  h.host.send(" "); await settle();
  h.host.send("1"); await settle();
  assert.equal(a.resolved, 0, "no line end yet");
  h.host.send(`\nO ${b64("hello ")}`); await settle();
  assert.equal(a.resolved, 1);
  assert.equal(out, "", "the O frame is not whole yet");
  h.host.send(`\nO ${b64("world")}\n`); await settle();
  assert.equal(out, "hello world");
  await quiet(h);
});

test("an invalid frame goes to stderr and ends the job (K, then the host killed 15 s later); a pending cleanup fails when the host closes", async (t) => {
  const h = start(t);
  h.host.send("Z what\n"); await settle();
  assert.equal(h.errors(), "invalid worker job frame: Z what");
  assert.deepEqual(h.host.frames(), ["K"]);
  // Asked 10 s later, the cleanup's own 15 s limit lies beyond the kill's: the host's close answers it.
  await h.tick(10_000);
  const a = watch(h.worker.cleanup());
  assert.deepEqual(h.host.frames(), ["K", "C 1"]);
  await h.tick(4_999);
  assert.equal(a.rejected, 0, "a K does not answer the cleanup");
  assert.equal(h.host.kills, 0);
  await h.tick(1);
  assert.equal(h.host.kills, 1);
  h.host.close(1); await settle();
  assert.equal(a.rejected, 1);
  assert.equal(a.error?.message, "worker job host exited");
  assert.deepEqual(h.exits, [1]);
  await quiet(h);
});

test("F fails every pending cleanup with the host's text, once, and ends the job; a late C resolves nothing", async (t) => {
  const h = start(t);
  const a = watch(h.worker.cleanup()), b = watch(h.worker.cleanup());
  const text = "OpenProcess for worker job member 7: Access is denied.";
  h.host.send(`F ${b64(text)}\n`); await settle();
  assert.deepEqual([a.rejected, b.rejected, a.resolved, b.resolved], [1, 1, 0, 0]);
  assert.equal(a.error?.message, text);
  assert.equal(b.error?.message, text);
  assert.equal(h.errors(), text);
  assert.deepEqual(h.host.frames(), ["C 1", "C 2", "K"]);
  h.host.send("C 1\nC 2\n"); await settle();
  assert.deepEqual([a.rejected, b.rejected, a.resolved, b.resolved], [1, 1, 0, 0], "the late acknowledgements change nothing");
  h.host.close(1); await settle();
  assert.deepEqual([a.rejected, b.rejected], [1, 1], "the close rejects nothing twice");
  assert.equal(h.host.kills, 0, "the host closed before the 15 s backstop");
  await quiet(h);
});

test("the host closing before C fails the pending cleanups and clears the timers; afterwards cleanup resolves at once and nothing is written", async (t) => {
  // Since 6c1149c (CI82) the engine asks no cleanup of a process that has run no turn, so a host closing under a
  // pending C is one whose runtime has worked: the cleanup was asked after a turn.
  const h = start(t);
  const a = watch(h.worker.cleanup()), b = watch(h.worker.cleanup());
  h.worker.kill();
  h.host.send("X 3\n"); await settle();
  h.host.close(1); await settle();
  assert.deepEqual([a.rejected, b.rejected], [1, 1]);
  assert.equal(a.error?.message, "worker job host exited");
  assert.deepEqual(h.exits, [3], "the runtime's own exit code (X), not the host's");
  const after = watch(h.worker.cleanup());
  h.worker.kill();
  await settle();
  assert.equal(after.resolved, 1);
  assert.deepEqual(h.host.frames(), ["C 1", "C 2", "K"], "nothing written after the close");
  await quiet(h);
});

test("a missing C: the cleanup fails at 15 s, not before, as CleanupTimedOut, and ends nothing (the engine asks once more, queue LCK); a late C changes nothing; the next C has a fresh 15 s", async (t) => {
  const h = start(t);
  const a = watch(h.worker.cleanup());
  await h.tick(14_999);
  assert.deepEqual([a.resolved, a.rejected], [0, 0]);
  assert.deepEqual(h.host.frames(), ["C 1"]);
  await h.tick(1);
  assert.equal(a.rejected, 1);
  assert.ok(a.error instanceof CleanupTimedOut);
  assert.equal(a.error.message, "worker cleanup timed out");
  assert.deepEqual(h.host.frames(), ["C 1"], "no K");
  h.host.send("C 1\n"); await settle();
  assert.deepEqual([a.resolved, a.rejected], [0, 1], "the late C resolves nothing");
  const b = watch(h.worker.cleanup());
  assert.deepEqual(h.host.frames(), ["C 1", "C 2"]);
  await h.tick(14_999);
  assert.deepEqual([b.resolved, b.rejected], [0, 0], "its own 15 s, not the first one's");
  h.host.send("C 2\n"); await settle();
  assert.deepEqual([b.resolved, b.rejected], [1, 0]);
  assert.equal(a.rejected, 1, "rejected once");
  assert.equal(h.host.kills, 0);
  await quiet(h);
});

// H8 (queue WHR, WHR6): the host's own settle limit (Clean, "worker job did not settle", sent as F) and the server's
// 15 s are two errors; whichever comes first decides, once, and nothing the other sends later changes it.
const NOT_SETTLED = "worker job did not settle";

test("the native settle timeout before the server's 15 s: the cleanup fails with the host's text, not the wrapper's, once; K once, no wrapper timeout later; a late C resolves nothing", async (t) => {
  const h = start(t);
  const a = watch(h.worker.cleanup());
  await h.tick(14_999);
  h.host.send(`F ${b64(NOT_SETTLED)}\n`); await settle();
  assert.deepEqual([a.resolved, a.rejected], [0, 1]);
  assert.equal(a.error?.message, NOT_SETTLED);
  assert.deepEqual(h.host.frames(), ["C 1", "K"]);
  await h.tick(1);
  assert.equal(a.rejected, 1, "the wrapper's 15 s does not fail it again");
  assert.deepEqual(h.host.frames(), ["C 1", "K"], "and writes no second K");
  h.host.send("C 1\n"); await settle();
  assert.deepEqual([a.resolved, a.rejected], [0, 1], "the late C resolves nothing");
  await h.tick(14_998); // the K went at 14 999 ms, 1 ms has passed since
  assert.equal(h.host.kills, 0);
  await h.tick(1);
  assert.equal(h.host.kills, 1, "the host killed once, 15 s after the K");
  h.host.close(null); await settle();
  assert.equal(a.rejected, 1);
  await quiet(h);
});

test("the server's 15 s before the native settle timeout: the cleanup fails as timed out, once; the host's later F only repeats the K, fails nothing again, and a late C resolves nothing", async (t) => {
  const h = start(t);
  const a = watch(h.worker.cleanup());
  await h.tick(15_000);
  assert.equal(a.error?.message, "worker cleanup timed out");
  h.host.send(`F ${b64(NOT_SETTLED)}\nC 1\n`); await settle();
  assert.deepEqual([a.resolved, a.rejected], [0, 1]);
  assert.equal(a.error?.message, "worker cleanup timed out", "the first error stays");
  assert.deepEqual(h.host.frames(), ["C 1", "K"], "the timeout wrote no K (queue LCK); the late F writes one");
  assert.equal(h.errors(), NOT_SETTLED, "its text goes to the runtime's stderr");
  await h.tick(14_999);
  assert.equal(h.host.kills, 0);
  await h.tick(1);
  assert.equal(h.host.kills, 1, "the backstop armed by the F's K, once");
  h.host.close(null); await settle();
  await quiet(h);
});

test("a forced kill (SIGKILL, the engine's end deadline): K and the host killed at once, which closes its job; nothing more later (queue LCK, F2)", async (t) => {
  const h = start(t);
  h.worker.kill("SIGKILL");
  assert.deepEqual(h.host.frames(), ["K"]);
  assert.equal(h.host.kills, 1, "the host itself, not 15 s later");
  h.host.close(null); await settle();
  h.worker.kill("SIGKILL");
  assert.equal(h.host.kills, 1, "an exited host is not killed again");
  await quiet(h);
});

test("kill: K at once, the host killed 15 s later and only once however often it is asked; a close before then kills nothing", async (t) => {
  const h = start(t);
  h.worker.kill();
  await h.tick(10_000);
  h.worker.kill();
  assert.deepEqual(h.host.frames(), ["K", "K"]);
  await h.tick(4_999);
  assert.equal(h.host.kills, 0, "the first kill's 15 s, not the second's");
  await h.tick(1);
  assert.equal(h.host.kills, 1);
  await h.tick(30_000);
  assert.equal(h.host.kills, 1);
  h.host.close(1); await settle();

  const second = start(t, false); // the same mocked clock
  second.worker.kill();
  await second.tick(14_999);
  second.host.close(1); await settle();
  await quiet(second);
  assert.equal(second.host.kills, 0);
});

test("the input's end: E written, K 5 s later, the host killed 15 s after; an E frame from the host is the runtime's stderr and arms nothing", async (t) => {
  const h = start(t);
  h.host.send(`E ${b64("a warning")}\n`); await settle();
  assert.equal(h.errors(), "a warning");
  await h.tick(60_000);
  assert.deepEqual(h.host.frames(), [], "the runtime's stderr is no input end");
  h.worker.stdin.end(); await settle();
  assert.deepEqual(h.host.frames(), ["E"]);
  await h.tick(4_999);
  assert.deepEqual(h.host.frames(), ["E"]);
  await h.tick(1);
  assert.deepEqual(h.host.frames(), ["E", "K"]);
  await h.tick(14_999);
  assert.equal(h.host.kills, 0);
  await h.tick(1);
  assert.equal(h.host.kills, 1);
  h.host.close(0); await settle();
  await quiet(h);
});

// The real host: what the fake pipe cannot show. A cleanup's C comes after the job's other member is gone and its
// directory free, with the runtime kept; the host's end takes the runtime too.
test("Windows: a real cleanup frees the job member's directory and keeps the runtime; the job's end takes the runtime", { skip: process.platform !== "win32" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "nexus-frames-"));
  const held = join(root, "held"), ready = join(root, "ready"); mkdirSync(held);
  const script = join(root, "runtime.mjs");
  // The child holds its directory only once it has started (its current directory is opened then, not at spawn):
  // it says so with the ready file.
  const child = `require('fs').writeFileSync(${JSON.stringify(ready)}, ''); setInterval(() => {}, 1000)`;
  writeFileSync(script, `import {spawn} from 'node:child_process';
const child = spawn(process.execPath, ['-e', ${JSON.stringify(child)}], {cwd: ${JSON.stringify(held)}, stdio: 'ignore', windowsHide: true});
console.log(JSON.stringify({root: process.pid, child: child.pid}));
setInterval(() => {}, 1000);
`);
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const locked = () => assert.throws(() => rmdirSync(held), (e: NodeJS.ErrnoException) => e.code === "EBUSY" || e.code === "EPERM");
  const runtime = spawnRuntimeChild(process.execPath, [script], { cwd: root, env: process.env, owned: true });
  const exited = new Promise<void>((r) => runtime.once("close", () => r()));
  let text = "";
  runtime.stdout.on("data", (b: Buffer) => { text += b.toString(); });
  try {
    await until("runtime and its child up", () => text.includes("\n") && existsSync(ready), LONGER.step);
    const family = JSON.parse(text.trim()) as { root: number; child: number };
    locked();
    await runtime.cleanup!();
    assert.equal(alive(family.child), false, "the job member is ended before the C");
    rmdirSync(held);
    assert.equal(alive(family.root), true, "the runtime is kept");
    runtime.kill();
    await exited;
    assert.equal(alive(family.root), false);
    await runtime.cleanup!();
  } finally { runtime.kill(); await exited; }
});

// ---------------------------------------------------------------- the write guard's question (LCF6)
// What agentOwning answers from each agent's host's T frame (queue HG, its lifecycle paths in queue LCF, LCF6): a host
// that fails its lookup, does not answer, closes while asked, or never created its job; and endAgentJobs, an update's
// release's last act. The hosts are pipes of the test's own; agent-guard.test.ts runs the real hosts.

/** An agent's job host's side of the pipe: the T questions the server wrote, and whether it closed. */
class AgentHostPipe extends EventEmitter {
  input = "";
  readonly stdin = new Writable({ write: (chunk: Buffer, _e, done) => { this.input += chunk.toString(); done(); } });
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  kill(): boolean { this.close(null); return true; }
  /** The T questions the server wrote: [id, client port, server port]. */
  asked(): string[][] { return this.input.split("\n").filter((l) => l.startsWith("T ")).map((l) => l.slice(2).split(" ")); }
  send(text: string): void { this.stdout.write(text); }
  closed = false;
  close(code: number | null = 0): void { if (!this.closed) { this.closed = true; this.emit("close", code); } }
}

/** An agent's job host for `role`, closed when the test ends (the hosts are module state). */
function agentHost(t: TestContext, role: string) {
  const h = new AgentHostPipe();
  new WorkerProcess("runtime.exe", [], { cwd: tmpdir(), env: {}, agent: role }, () => h as unknown as ChildProcessWithoutNullStreams);
  t.after(() => h.close());
  return h;
}

/** Asks about the connection 50000 to 4317, and lets each host answer with `digits` (undefined: no answer). */
async function ask(hosts: [AgentHostPipe, string | undefined][]) {
  const answer = agentOwning(50000, 4317);
  await settle();
  for (const [h, digits] of hosts) {
    const q = h.asked().at(-1);
    assert.deepEqual(q?.slice(1), ["50000", "4317"], "every host is asked about the connection's two ports");
    if (digits !== undefined) h.send(`T ${q![0]} ${digits}\n`);
  }
  return answer;
}

function errors(t: TestContext) {
  const logged: string[] = [];
  t.mock.method(console, "error", (text: string) => { logged.push(text); });
  return logged;
}

test("a host naming its job wins over the sandbox, an ended client and nobody; the sandbox over an ended client", async (t) => {
  const orchestrator = agentHost(t, "orchestrator"), partner = agentHost(t, "conversation"), worker = agentHost(t, "worker");
  assert.equal(await ask([[orchestrator, "3"], [partner, "0"], [worker, "1"]]), "worker");
  assert.equal(await ask([[orchestrator, "3"], [partner, "2"], [worker, "0"]]), "codex-sandbox");
  assert.equal(await ask([[orchestrator, "3"], [partner, "3"], [worker, "3"]]), ENDED_CLIENT);
  assert.equal(await ask([[orchestrator, "0"], [partner, "0"], [worker, "0"]]), undefined);
});

test("a failed lookup (4 and its reason) counts as nobody's and is logged with the reason; another host's answer still counts", async (t) => {
  const logged = errors(t);
  const a = agentHost(t, "orchestrator"), b = agentHost(t, "worker");
  assert.equal(await ask([[a, `4 ${b64("the TCP table could not be read (5)")}`], [b, "0"]]), undefined);
  assert.equal(logged.length, 1);
  assert.match(logged[0]!, /could not look up the connection's owner \(the TCP table could not be read \(5\)\); the request is let through/);
  assert.equal(await ask([[a, `4 ${b64("x")}`], [b, "1"]]), "worker");
});

test("a host that does not answer in 3 s counts as nobody's and is logged; its late answer changes nothing", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const logged = errors(t);
  const slow = agentHost(t, "orchestrator");
  let answered: string | undefined | null = null;
  const pending = ask([[slow, undefined]]).then((a) => { answered = a; });
  await settle();
  t.mock.timers.tick(2_999); await settle();
  assert.equal(answered, null, "not before 3 s");
  t.mock.timers.tick(1); await pending;
  assert.equal(answered, undefined);
  assert.match(logged.join("\n"), /did not answer \(no answer in 3000 ms\); the request is let through/);
  slow.send(`T ${slow.asked()[0]![0]} 1\n`); await settle();
  assert.equal(logged.length, 1, "a late answer is dropped quietly");
});

test("a host that closes while asked answers nobody's, unlogged, and is asked no more; with no host left nothing is asked", async (t) => {
  const logged = errors(t);
  const ending = agentHost(t, "conversation");
  const answer = agentOwning(50001, 4317);
  await settle();
  assert.equal(ending.asked().length, 1);
  ending.close(1);
  assert.equal(await answer, undefined);
  assert.equal(logged.length, 0);
  assert.equal(await agentOwning(50002, 4317), undefined);
  assert.equal(ending.asked().length, 1, "an ended host is not asked");
});

test("a job that could not be created (F before the runtime started): the host ends, and is never asked", async (t) => {
  const failed = agentHost(t, "orchestrator");
  const other = agentHost(t, "worker");
  let exit: unknown;
  failed.on("close", (code) => { exit = code; });
  failed.send(`F ${b64("CreateJobObject failed")}\n`);
  await settle();
  assert.match(failed.input, /\nK\n/, "the server ends the job at once");
  failed.close(1); // the real host quits after its F (worker-job.cs)
  await settle();
  assert.equal(exit, 1);
  assert.equal(await ask([[other, "0"]]), undefined);
  assert.equal(failed.asked().length, 0);
});

test("endAgentJobs (an update's release, after its wait) ends every agent's job still running at once: K and its host killed; an ended host is left alone", async (t) => {
  const left = agentHost(t, "orchestrator"), other = agentHost(t, "worker"), gone = agentHost(t, "conversation");
  gone.close(0);
  let kills = 0;
  for (const h of [left, other, gone]) { const kill = h.kill.bind(h); h.kill = () => { kills++; return kill(); }; }
  endAgentJobs();
  await settle();
  assert.equal(kills, 2);
  for (const h of [left, other]) { assert.match(h.input, /\nK\n$/); assert.ok(h.closed); }
  assert.doesNotMatch(gone.input, /\nK\n/);
  assert.equal(await agentOwning(50003, 4317), undefined, "no host left to ask");
});
