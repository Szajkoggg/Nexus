// A Codex session's recovery of its thread under failure (queue LCR, LC-F7): only thread/resume's "no rollout found for
// thread id" text starts a new thread (CodexSession.resumeThread, queue RN), whatever the JSON-RPC code; any other resume
// error, a near miss of the text included, keeps the thread's id and ends the process. The new thread's start may fail
// in every way a request can (an error, a malformed answer, the process's exit, no answer): no turn then runs as if it
// had started, the recorded id is not replaced, and the failure shows. A new id is kept before the turn starts in it.
// Against Codex's fake in this process (FAKE_CODEX_RPC steers its answers), through AgentHost, whose records are the
// durable state; and at the worker role, through the engine.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectStore, newId, now, type SessionFile } from "@nexus/protocol";
import { AgentHost, ROLE_RECORDS } from "../src/agent-host.ts";
import { CodexSession } from "../src/codex.ts";
import { RETRY_LIMIT } from "../src/engine.ts";
import type { SpawnRuntimeChild } from "../src/worker-process.ts";
import { inProcessCodex } from "./in-process-runtime.ts";
import { activityOf, setup } from "./engine-setup.ts";
import { LONGER, holds, until } from "./wait.ts";

const OLD = "019a0000-0000-7000-8000-000000000001";

/**
 * A worker session on Codex whose record names thread OLD (never saved by the fake, so its resume finds no rollout
 * unless FAKE_CODEX_RPC answers otherwise), hosted by AgentHost. `trail` keeps, in order, every request the adapter
 * wrote and every native id the store was given: the order of the two is what is checked.
 */
function codexWorker(rpc: Record<string, unknown>) {
  const root = mkdtempSync(join(tmpdir(), "nexus-codex-recovery-"));
  process.env.NEXUS_HOME = join(root, "home");
  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  const s: SessionFile = { protocol: 1, id: newId(), project: "p", role: "worker", runtime: "codex", title: "S", native_id: OLD, cwd: root, launched_by: "nexus", created_at: now() };
  store.writeSession(s);
  store.writeRuntime(s.id, { state: "exited", turns: 0, updated_at: now() });
  const trail: string[] = [];
  const writeSession = store.writeSession.bind(store);
  store.writeSession = (x) => { trail.push(`native_id ${x.native_id}`); writeSession(x); };
  const spawnChild: SpawnRuntimeChild = (bin, args, options) => {
    const child = inProcessCodex(bin, args, options);
    const write = child.stdin.write.bind(child.stdin) as (...a: unknown[]) => boolean;
    (child.stdin as unknown as { write: (...a: unknown[]) => boolean }).write = (chunk: unknown, ...rest: unknown[]) => {
      const m = /^\{"id":\d+,"method":"([^"]+)"/.exec(String(chunk));
      if (m) trail.push(`request ${m[1]}`);
      return write(chunk, ...rest);
    };
    return child;
  };
  const h = new AgentHost(store, ROLE_RECORDS.worker, { spawn: (launch) => new CodexSession({ ...(launch.options as ConstructorParameters<typeof CodexSession>[0]), spawnChild }) });
  const env = { ...h.env(s.id), FAKE_LOG: join(root, "fake.log"), FAKE_ARGS: join(root, "args.log"), FAKE_CODEX_RPC: JSON.stringify(rpc) };
  const events: string[] = [];
  const failures: string[] = [];
  const errors: string[] = [];
  const l = h.start(s, () => ({ runtime: "codex", options: { cwd: root, threadId: store.readSession(s.id).native_id, env, sandbox: "read-only", approvalPolicy: "never", writableRoots: [] } }), {}, () => ({
    turnEnd: (e) => { events.push(`turnEnd ${e.ok}`); if (e.failure) failures.push(`${e.failure.kind} ${e.failure.code}`); },
    exit: (code, byNexus) => events.push(`exit ${code}${byNexus ? " by Nexus" : ""}`),
    // What the role shows of the process's errors (the engine writes them to the session's activity).
    activity: (a) => { if (a.kind === "error") errors.push(a.text); },
  }));
  const lines = (file: string) => existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((x) => JSON.parse(x) as Record<string, unknown>) : [];
  return {
    store, s, h, l, trail, events, failures,
    /** The requests the fake was asked, by method, in order. */
    asked: () => lines(env.FAKE_ARGS).map((x) => String(x.method)),
    /** What reached the agent's thread as turns. */
    received: () => lines(env.FAKE_LOG).map((x) => String(x.text)),
    errors: () => errors,
    native: () => store.readSession(s.id).native_id,
    record: () => store.readRuntime(s.id),
  };
}

// ---------------------------------------------------------------- a resume error that is not the missing rollout

const OTHER_ERRORS: [string, number, string][] = [
  ["an authentication failure", -32001, "401 Unauthorized: the session expired"],
  ["a network failure", -32603, "stream disconnected before completion"],
  ["an arbitrary error", -32000, "something else broke"],
  ["a near miss (\"no rollout was found\")", -32600, "no rollout was found for thread id ${threadId}"],
  ["a near miss (no \"id\")", -32600, "no rollout found for thread ${threadId}"],
];

for (const [what, code, message] of OTHER_ERRORS) {
  test(`codex: ${what} on resume starts no new thread: the id is kept, the error shows, the process ends, the message is not taken`, async () => {
    const w = codexWorker({ "thread/resume": { error: { code, message } } });
    w.h.send(w.l, "hello");
    await until("the exit", () => w.events.includes("exit 1"));
    assert.deepEqual(w.asked(), ["thread/resume"]);
    assert.deepEqual(w.trail, ["request initialize", "request thread/resume"]);
    assert.equal(w.native(), OLD);
    assert.deepEqual(w.received(), []);
    assert.deepEqual(w.errors(), [`codex: thread/resume: ${message.replace("${threadId}", OLD)}`]);
    assert.deepEqual(w.events, ["exit 1"]);
    assert.equal(w.record()?.state, "exited");
  });
}

// ---------------------------------------------------------------- the missing rollout, whatever its code

for (const code of [-32600, -32000, -32603, 1]) {
  test(`codex: "no rollout found for thread id" with code ${code}: one new thread, its id kept before the turn starts in it, the message taken once`, async () => {
    const w = codexWorker({ "thread/resume": { error: { code, message: "no rollout found for thread id ${threadId}" } } });
    w.h.send(w.l, "hello");
    await until("the turn's end", () => w.events.includes("turnEnd true"));
    assert.deepEqual(w.asked(), ["thread/resume", "thread/start", "turn/start"]);
    const id = w.native();
    assert.ok(id && id !== OLD);
    const kept = w.trail.indexOf(`native_id ${id}`);
    assert.ok(kept > w.trail.indexOf("request thread/start") && kept < w.trail.indexOf("request turn/start"), `the id is kept before turn/start: ${w.trail.join(", ")}`);
    assert.deepEqual(w.received(), ["hello"]);
    assert.equal(w.record()?.state, "idle");
    w.h.shutdown();
    await until("the exit", () => w.events.some((e) => e.startsWith("exit")));
  });
}

// ---------------------------------------------------------------- the new thread's start fails

test("codex: the new thread's start is refused: no turn, the old id kept, the error shows, the process ends", async () => {
  const w = codexWorker({ "thread/start": { error: { code: -32000, message: "fake: thread/start refused" } } });
  w.h.send(w.l, "hello");
  await until("the exit", () => w.events.includes("exit 1"));
  assert.deepEqual(w.asked(), ["thread/resume", "thread/start"]);
  assert.equal(w.native(), OLD);
  assert.deepEqual(w.received(), []);
  assert.deepEqual(w.errors(), ["codex: thread/start: fake: thread/start refused"]);
  assert.deepEqual(w.events, ["exit 1"]);
});

test("codex: the new thread's start answers without a thread: no turn, the old id kept, the error shows, the process ends", async () => {
  const w = codexWorker({ "thread/start": { result: {} } });
  w.h.send(w.l, "hello");
  await until("the exit", () => w.events.includes("exit 1"));
  assert.equal(w.native(), OLD);
  assert.deepEqual(w.received(), []);
  assert.equal(w.errors().length, 1);
  assert.match(w.errors()[0]!, /^codex: .*\bid\b/);
  assert.deepEqual(w.events, ["exit 1"]);
});

test("codex: the new thread's start answers a thread without an id: its turn is refused (no turn as if started), the old id kept", async () => {
  const w = codexWorker({ "thread/start": { result: { thread: {} } } });
  w.h.send(w.l, "hello");
  await until("the turn's end", () => w.events.length > 0);
  // Today's contract: the turn/start in no thread is refused, and that is the turn's lasting failure.
  assert.deepEqual(w.events, ["turnEnd false"]);
  assert.deepEqual(w.failures, ["lasting turnStartRejected"]);
  assert.equal(w.native(), OLD);
  assert.deepEqual(w.received(), []);
  assert.match(w.errors().join("\n"), /turn\/start: turn\/start: thread not found/);
  assert.equal(w.record()?.state, "idle");
  w.h.shutdown();
  await until("the exit", () => w.events.some((e) => e.startsWith("exit")));
});

test("codex: the process exits instead of answering the new thread's start: one exit, no turn, the old id kept", async () => {
  const w = codexWorker({ "thread/start": { exit: 1 } });
  w.h.send(w.l, "hello");
  await until("the exit", () => w.events.includes("exit 1"));
  await until("the start's failure shown", () => w.errors().length > 0);
  assert.equal(w.native(), OLD);
  assert.deepEqual(w.received(), []);
  assert.deepEqual(w.errors(), ["codex: codex exited"]);
  assert.deepEqual(w.events, ["exit 1"]);
  assert.equal(w.record()?.state, "exited");
});

test("codex: the new thread's start never answered: no deadline, the message waits; a shutdown ends it, and nothing can be sent after", async () => {
  const w = codexWorker({ "thread/start": "silent" });
  w.h.send(w.l, "hello");
  await until("the new thread's start asked", () => w.asked().includes("thread/start"));
  // Today's contract: requests have no time limit (queue LCR does not add one); the session stays at work.
  await holds("the session at work with nothing answered", () => w.l.proc.state === "working" && w.events.length === 0, 300);
  assert.equal(w.native(), OLD);
  w.h.shutdown();
  await until("the exit", () => w.events.length > 0);
  assert.deepEqual(w.events, ["exit 1 by Nexus"]);
  assert.equal(w.record()?.state, "exited");
  assert.deepEqual(w.received(), []);
  assert.throws(() => w.l.proc.send("too late"), /the session's process has exited/);
});

// ---------------------------------------------------------------- at the role: a worker

test("codex: a worker whose every thread start is refused is tried as a passing failure and halts once, naming the exit", async () => {
  process.env.FAKE_CODEX_RPC = JSON.stringify({ "thread/start": { error: { code: -32000, message: "fake: thread/start refused" } } });
  const { store, engine, queue, until: untilRun } = setup(["done"]);
  try {
    engine.start("Q", { runtime: "codex" });
    await untilRun("the halt", () => queue().run?.state === "halted", LONGER.run);
    assert.match(queue().run!.reason!, new RegExp(`failed ${RETRY_LIMIT + 1} times in a row.*exited \\(1\\)`));
    const activity = activityOf(store, queue().run!.session);
    assert.equal(activity.filter((a) => a.kind === "retry" && a.text.startsWith("Nexus tries")).length, RETRY_LIMIT);
    assert.ok(activity.some((a) => a.kind === "error" && a.text === "codex: thread/start: fake: thread/start refused"), "the refusal is shown");
    assert.deepEqual(queue().steps.map((st) => st.status), ["pending"]);
  } finally { engine.shutdown(); delete process.env.FAKE_CODEX_RPC; }
});
