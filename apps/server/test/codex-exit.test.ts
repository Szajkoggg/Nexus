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

test("a turn's end read after the exit starts no turn with what waited for it", async () => {
  const proc = await exited();
  const inside = proc as unknown as Inside;
  const ends: unknown[] = [];
  proc.on("turnEnd", (e) => ends.push(e));
  inside.queue.push("waiting message");
  inside.read(JSON.stringify({ method: "turn/completed", params: { turn: { id: "t1", status: "completed" } } }) + "\n");
  await new Promise((r) => setTimeout(r, 100));
  assert.notEqual(proc.state, "working", "no turn started after the exit");
  assert.equal(inside.pending.size, 0, "no turn/start waits for an answer");
  assert.equal(ends.length, 1, "only the turn's end itself, no failed turn/start after it");
});
