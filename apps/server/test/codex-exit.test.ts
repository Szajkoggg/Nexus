// The Codex adapter after its process exited (queue KM): a request made then fails at once instead of waiting for an
// answer nothing will write, and a line read after the exit (stdout drains after it) starts no turn. Against the fake.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CodexSession } from "../src/codex.ts";

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
