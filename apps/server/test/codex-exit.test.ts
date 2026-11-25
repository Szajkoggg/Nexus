// The Codex adapter after its process exited (queue KM): a request made then fails at once instead of waiting for an
// answer nothing will write, and a line read after the exit (stdout drains after it) starts no turn. Against the fake.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectStore, newId, now, readTurns, type SessionFile } from "@nexus/protocol";
import { AgentHost, ROLE_RECORDS } from "../src/agent-host.ts";
import { CodexSession, EXIT_DRAIN_MS } from "../src/codex.ts";
import { existsSync, readFileSync } from "node:fs";
import { activityOf, setup } from "./engine-setup.ts";
import { LONGER, holds, until } from "./wait.ts";

const here = dirname(fileURLToPath(import.meta.url));
process.env.NEXUS_CODEX = join(here, "fake-codex.ts");
const cwd = mkdtempSync(join(tmpdir(), "nexus-codex-exit-"));
process.env.NEXUS_HOME = join(cwd, "home");
delete process.env.FAKE_LOG;

/** The adapter's private parts these tests reach into. */
interface Inside { request(method: string, params: object): Promise<unknown>; read(chunk: string): void; queue: string[]; pending: Map<number, unknown> }

/** A session whose thread started, then its process killed and its exit seen. */
async function exited(): Promise<CodexSession> {
  const proc = new CodexSession({ cwd, env: {}, sandbox: "read-only", approvalPolicy: "never", writableRoots: [] });
  await new Promise<void>((r) => proc.on("facts", (f) => { if (f.nativeId) r(); }));
  const exit = new Promise((r) => proc.once("exit", r));
  proc.kill();
  await exit;
  return proc;
}

/** The promise's outcome, or "pending" if it has none within `ms`. */
function settled(p: Promise<unknown>, ms = 2000): Promise<string> {
  return Promise.race([
    p.then(() => "resolved", (e: Error) => `rejected: ${e.message}`),
    new Promise<string>((r) => setTimeout(() => r("pending"), ms).unref()),
  ]);
}

test("a request made after the process exited fails at once", async () => {
  const proc = await exited();
  const inside = proc as unknown as Inside;
  assert.equal(await settled(inside.request("thread/read", { threadId: "t" })), "rejected: codex exited");
  assert.equal(inside.pending.size, 0);
});

test("a turn's end read after the exit was handled changes nothing and starts no turn with what waited for it (queue KM, LH)", async () => {
  const proc = await exited();
  const inside = proc as unknown as Inside;
  const ends: unknown[] = [];
  proc.on("turnEnd", (e) => ends.push(e));
  inside.queue.push("waiting message");
  inside.read(JSON.stringify({ method: "turn/completed", params: { turn: { id: "t1", status: "completed" } } }) + "\n");
  await new Promise((r) => setTimeout(r, 100));
  assert.notEqual(proc.state, "working", "no turn started after the exit");
  assert.equal(inside.pending.size, 0, "no turn/start waits for an answer");
  assert.equal(ends.length, 0, "no turn ends after the process did (queue LH: its drained lines are read before the exit)");
  assert.equal(proc.state, "exited");
});

test("a turn's end still draining from stdout as the exit event comes is read before the exit, which stays the end (queue LH, finding 10)", async () => {
  // Node may emit a child's `exit` before its stdout has drained: the turn/completed the process wrote before it ended
  // is then read after the exit. Without care it set the state back to idle over `exited`, and its turnEnd came after
  // the exit (AgentHost then wrote the runtime record back to idle and recorded the turn after the process's end).
  const proc = new CodexSession({ cwd, env: {}, sandbox: "read-only", approvalPolicy: "never", writableRoots: [] });
  await new Promise<void>((r) => proc.on("facts", (f) => { if (f.nativeId) r(); }));
  const inside = proc as unknown as Inside & { proc: import("node:child_process").ChildProcess };
  const order: string[] = [];
  try {
  proc.on("turnEnd", () => order.push(`turnEnd:${proc.state}`));
  proc.on("exit", () => order.push(`exit:${proc.state}`));
  inside.read(JSON.stringify({ method: "turn/started", params: { turn: { id: "t1" } } }) + "\n");
  // The exit event first, as Node may give it, then the line the process wrote before it ended.
  inside.proc.emit("exit", 0, null);
  inside.read(JSON.stringify({ method: "turn/completed", params: { turn: { id: "t1", status: "completed" } } }) + "\n");
  await new Promise<void>((r) => { if (order.some((o) => o.startsWith("exit"))) r(); else proc.once("exit", () => r()); });
  assert.deepEqual(order, ["turnEnd:idle", "exit:exited"], "the turn ended, then the process");
  assert.equal(proc.state, "exited");
  inside.read(JSON.stringify({ method: "turn/started", params: { turn: { id: "t2" } } }) + "\n");
  assert.equal(proc.state, "exited", "a line after the exit's end changes nothing");
  } finally { inside.proc.kill(); } // the exit event was the test's: the process itself still runs
});

// ---------------------------------------------------------------- a turn/start refused: by the exit, or by a live process (LC-F8)

/**
 * A worker session on Codex's fake as a process, hosted by AgentHost (its records are the durable state), the fake's
 * answers steered by FAKE_CODEX_RPC. Every runtime record written after the process's exit is kept.
 */
function hosted(rpc: Record<string, unknown>) {
  const root = mkdtempSync(join(cwd, "hosted-"));
  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  const s: SessionFile = { protocol: 1, id: newId(), project: "p", role: "worker", runtime: "codex", title: "S", cwd: root, launched_by: "nexus", created_at: now() };
  store.writeSession(s);
  const h = new AgentHost(store, ROLE_RECORDS.worker);
  const args = join(root, "args.log");
  const env = { ...h.env(s.id), FAKE_LOG: join(root, "fake.log"), FAKE_ARGS: args, FAKE_CODEX_RPC: JSON.stringify(rpc) };
  const ends: { ok: boolean; code?: string; kind?: string }[] = [];
  const exits: (number | null)[] = [];
  const afterExit: string[] = [];
  const writeRuntime = store.writeRuntime.bind(store);
  store.writeRuntime = (id, r) => { if (exits.length) afterExit.push(r.state); writeRuntime(id, r); };
  const l = h.start(s, () => ({ runtime: "codex", options: { cwd: root, threadId: store.readSession(s.id).native_id, env, sandbox: "read-only", approvalPolicy: "never", writableRoots: [] } }), {}, () => ({
    turnEnd: (e) => ends.push({ ok: e.ok, code: e.failure?.code, kind: e.failure?.kind }),
    exit: (code) => exits.push(code),
  }));
  return {
    h, l, ends, exits, afterExit,
    record: () => store.readRuntime(s.id),
    asked: () => existsSync(args) ? readFileSync(args, "utf8").split("\n").filter(Boolean).map((x) => String((JSON.parse(x) as { method?: string }).method)) : [],
    turns: () => readTurns().entries.filter((t) => t.session === s.id).length,
  };
}

test("a turn/start still unanswered when the process is killed: past the exit's drain, no turn's end, no turn recorded or counted, and the record stays exited (queue LCR, LC-F8)", async () => {
  const w = hosted({ "turn/start": "silent" });
  try {
    w.h.send(w.l, "hello");
    await until("turn/start asked", () => w.asked().includes("turn/start"));
    w.l.proc.kill(); // a crash: not ended by Nexus
    await until("the exit", () => w.exits.length > 0);
    // The rejected turn/start's late callback, and anything else, would show within the drain window after the exit.
    await holds("nothing after the exit", () => w.ends.length === 0 && w.exits.length === 1 && w.afterExit.length === 0 && w.record()?.state === "exited", EXIT_DRAIN_MS + 250);
    assert.equal(w.record()?.turns ?? 0, 0, "no turn counted");
    assert.equal(w.turns(), 0, "no turn recorded (turns.jsonl)");
    assert.equal(w.l.proc.state, "exited");
  } finally { w.h.shutdown(); }
});

test("a live process's turn/start error: exactly one turn's end, lasting turnStartRejected, idle, no exit; the next message runs (queue LCR, LC-F8)", async () => {
  const w = hosted({ "turn/start": [{ error: { code: -32000, message: "fake: turn/start refused" } }] });
  try {
    w.h.send(w.l, "hello");
    await until("the turn's end", () => w.ends.length > 0);
    await holds("one turn's end and no exit", () => w.ends.length === 1 && w.exits.length === 0 && w.record()?.state === "idle", EXIT_DRAIN_MS + 250);
    assert.deepEqual(w.ends, [{ ok: false, code: "turnStartRejected", kind: "lasting" }]);
    // Today's contract: the refused start ends a turn as any turn's end does, and the worker's record counts it.
    assert.equal(w.record()?.turns, 1);
    assert.equal(w.l.proc.state, "idle");
    w.h.send(w.l, "again");
    await until("the next turn's end", () => w.ends.length === 2);
    assert.deepEqual(w.ends[1], { ok: true, code: undefined, kind: undefined });
    assert.deepEqual(w.exits, []);
  } finally { w.h.shutdown(); }
});

test("a worker whose turn/start is refused halts at once on the lasting failure, without a retry or a nudge for its outcome (queue LCR, LC-F8)", async () => {
  process.env.FAKE_CODEX_RPC = JSON.stringify({ "turn/start": { error: { code: -32000, message: "fake: turn/start refused" } } });
  const { store, engine, queue, received, until: untilRun } = setup(["done"]);
  try {
    engine.start("Q", { runtime: "codex" });
    await untilRun("the halt", () => queue().run?.state === "halted", LONGER.run);
    assert.match(queue().run!.reason!, /fake: turn\/start refused/);
    const activity = activityOf(store, queue().run!.session);
    assert.equal(activity.filter((a) => a.kind === "retry" && a.text.startsWith("Nexus tries")).length, 0);
    assert.deepEqual(received(), [], "no turn reached the agent, and no nudge followed");
    assert.deepEqual(queue().steps.map((st) => st.status), ["pending"]);
  } finally { engine.shutdown(); delete process.env.FAKE_CODEX_RPC; }
});
