// Claude's start-up under failure (queue LCR, LC-F6 and the save signals of LC-F5): the one corrective start a refusal
// gets (ClaudeSession mayRetry/startAgain, queue RN) and what gets none; the one-second wait for a refusal's stderr
// after the exit (not the 1.5 s settling of a turn's end, LATE_TURN_MS, queue KM4); a resumed refusal's early error
// result, handed on once when no start follows; the first output that says the conversation is saved. Against Claude's
// fake in this process where it can give the order (with its gates, fake-behaviour.ts), and against a process the
// test writes itself (scripted-child.ts) where it cannot: stderr after the exit, stderr that never ends, a spawn
// error. The one-second wait runs on node:test's mock timers: no test sleeps.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeSession } from "../src/claude.ts";
import { RETRY_LIMIT } from "../src/engine.ts";
import type { SpawnRuntimeChild } from "../src/worker-process.ts";
import { FakeGates, saveFakeConversation } from "./fake-behaviour.ts";
import { inProcessClaude } from "./in-process-runtime.ts";
import { scriptedSpawn, type ScriptedChild } from "./scripted-child.ts";
import { activityOf, setup } from "./engine-setup.ts";
import { LONGER, until } from "./wait.ts";

const root = mkdtempSync(join(tmpdir(), "nexus-claude-startup-"));
// The adapter writes the `nexus` shims into NEXUS_HOME's bin: this test's own folder, never the user's.
process.env.NEXUS_HOME = join(root, "home");

/** A resumed refusal's first output, as Claude Code 2.1.323 writes it (fake-claude.ts). */
const ERROR_RESULT = { type: "result", subtype: "error_during_execution", is_error: true, num_turns: 0, total_cost_usd: 0, modelUsage: {}, permission_denials: [] };
const tick = () => new Promise<void>((r) => setImmediate(r));
/** Lets streamed chunks, their ends and the events after them through (a few loop turns, no timer). */
const flush = async () => { for (let i = 0; i < 5; i++) await tick(); };

/** A session and what it emitted, in order: turn ends, exits, saved facts, error and retry activity. */
function watch(proc: ClaudeSession) {
  const events: string[] = [];
  proc.on("turnEnd", (e) => events.push(`turnEnd ${e.ok}`));
  proc.on("exit", (code) => events.push(`exit ${code}`));
  proc.on("facts", (f) => { if (f.saved !== undefined) events.push(`saved ${f.saved}`); });
  proc.on("activity", (a) => { if (a.kind === "error" || a.kind === "retry") events.push(`${a.kind}: ${a.text.replace(/ \(.*$/s, "")}`); });
  const count = (prefix: string) => events.filter((e) => e.startsWith(prefix)).length;
  return { events, count, waitFor: (prefix: string) => until(`"${prefix}" among ${events.join("; ")}`, () => count(prefix) > 0) };
}

/** A session on Claude's fake in this process, its starts' arguments counted. */
function fakeSession(resume: boolean, env: Record<string, string> = {}, uuid = randomUUID()) {
  const dir = mkdtempSync(join(root, "f-"));
  const fakeEnv = { FAKE_LOG: join(dir, "log.jsonl"), ...env };
  const starts: string[][] = [];
  const spawnChild: SpawnRuntimeChild = (bin, args, options) => { starts.push(args); return inProcessClaude(bin, args, options); };
  const proc = new ClaudeSession({ cwd: dir, uuid, resume, permissionMode: "default", allowedTools: [], env: fakeEnv, spawnChild });
  const received = () => existsSync(fakeEnv.FAKE_LOG) ? readFileSync(fakeEnv.FAKE_LOG, "utf8").split("\n").filter(Boolean).map((l) => (JSON.parse(l) as { text: string }).text) : [];
  /** How each start named the session: --resume or --session-id. */
  const flags = () => starts.map((a) => a.find((x) => x === "--resume" || x === "--session-id"));
  return { proc, ...watch(proc), starts, flags, received, uuid, env: fakeEnv };
}

/** A session on processes the test writes (ScriptedChild), the first one started. */
function scriptedSession(resume: boolean) {
  const { children, spawnChild } = scriptedSpawn();
  const proc = new ClaudeSession({ cwd: root, uuid: randomUUID(), resume, permissionMode: "default", allowedTools: [], env: {}, spawnChild });
  return { proc, ...watch(proc), children, first: children[0]! as ScriptedChild };
}

/** The one-second wait after a refused start's exit runs on these mock timers (node:test, reset at the test's end). */
const mockTimers = (t: TestContext) => t.mock.timers.enable({ apis: ["setTimeout"] });

// ---------------------------------------------------------------- the one corrective start

for (const wrong of ["resume of a conversation never saved", "fresh start of a saved conversation"] as const) {
  test(`a refused ${wrong}: exactly one more start, the other way, and its message reaches the agent once`, async () => {
    const uuid = randomUUID();
    const resume = wrong.startsWith("resume");
    const s = fakeSession(resume, {}, uuid);
    if (!resume) saveFakeConversation(uuid, "claude", s.env);
    s.proc.send("hello");
    await s.waitFor("turnEnd");
    assert.deepEqual(s.flags(), resume ? ["--resume", "--session-id"] : ["--session-id", "--resume"]);
    assert.deepEqual(s.received(), ["hello"]);
    assert.deepEqual(s.events, resume
      ? ["saved false", "retry: Claude Code refused the start", "saved true", "turnEnd true"]
      : ["saved true", "retry: Claude Code refused the start", "turnEnd true"]);
    s.proc.kill();
    await s.waitFor("exit");
  });

  test(`a ${wrong} refused a second time: no third start, one exit 1, and the role is told once`, async () => {
    const resume = wrong.startsWith("resume");
    const s = fakeSession(resume, { FAKE_REFUSE: "1" });
    s.proc.send("hello");
    await s.waitFor("exit");
    assert.deepEqual(s.flags(), resume ? ["--resume", "--session-id"] : ["--session-id", "--resume"]);
    assert.deepEqual(s.received(), [], "a refused process reads nothing");
    // The first refusal's early result (a resumed start) goes with the start it was for; the second, a resumed start's
    // own, is the turn's end the role gets: once, before the exit.
    assert.deepEqual(s.events, resume
      ? ["saved false", "retry: Claude Code refused the start", "saved true", "error: Error: Session ID", "exit 1"].map((e) => e.replace(/ID$/, `ID ${s.uuid} is already in use.`))
      : ["saved true", "retry: Claude Code refused the start", "turnEnd false", "saved false", "error: No conversation found with session ID: " + s.uuid, "exit 1"]);
    assert.equal(s.count("exit"), 1);
  });
}

// ---------------------------------------------------------------- what gets no corrective start

test("an unrelated start-up failure (exit 2 with its own words, no output) is not tried again: one start, one exit, its words once", async () => {
  const s = fakeSession(false);
  s.proc.send("FAKE-EXIT: 2 claude: unrelated start-up failure");
  await s.waitFor("exit");
  assert.equal(s.starts.length, 1);
  assert.deepEqual(s.events, ["error: claude: unrelated start-up failure", "exit 2"]);
});

test("refusal-like words on stderr after real output: no second start, the turn's input not written again", async () => {
  const gates = new FakeGates(["stderr"]);
  const s = fakeSession(false, gates.env());
  try {
    s.proc.send("hello");
    await s.waitFor("turnEnd");
    s.proc.send(`FAKE-EXIT: 1 No conversation found with session ID: ${s.uuid}`);
    (await gates.reached("stderr")).release();
    await s.waitFor("exit");
    await flush();
    assert.equal(s.starts.length, 1);
    assert.deepEqual(s.received(), ["hello", `FAKE-EXIT: 1 No conversation found with session ID: ${s.uuid}`]);
    assert.equal(s.count("retry"), 0);
    assert.equal(s.count("exit"), 1);
    assert.equal(s.events.at(-1), "exit 1");
    // Today's behaviour, pinned (queue LCR): the words still tell a saved fact, here false although the conversation
    // was saved; the next start's own refusal ("already in use") corrects it back, at the cost of one start (queue RN).
    assert.deepEqual(s.events.filter((e) => e.startsWith("saved")), ["saved true", "saved false"]);
  } finally { gates.dispose(); }
});

for (const [how, code] of [["exit 0", 0], ["a signal", null]] as const) {
  test(`a process that ends on ${how} before any output: no second start, its input not written again, one exit`, async () => {
    const s = scriptedSession(false);
    s.proc.send("hello");
    s.first.end(code);
    await flush();
    assert.equal(s.children.length, 1);
    assert.deepEqual(s.events, [`exit ${code}`]);
    assert.equal(s.first.written.length, 1);
  });
}

// ---------------------------------------------------------------- the one-second wait for a refusal's words

test("a refusal's words after the exit, within the one-second wait: the start is corrected once, with its input", async (t) => {
  mockTimers(t);
  const s = scriptedSession(false);
  s.proc.send("hello");
  s.first.exitEvent(1); // stderr still open
  await flush();
  t.mock.timers.tick(999);
  await flush();
  assert.deepEqual([s.events, s.children.length], [[], 1], "still waiting for the words");
  s.first.err(`Error: Session ID ${"x".repeat(8)} is already in use.\n`);
  s.first.endStreams();
  await flush();
  assert.equal(s.children.length, 2);
  assert.ok(s.children[1]!.args.includes("--resume"));
  assert.deepEqual(s.children[1]!.written, s.first.written);
  assert.deepEqual(s.events, ["saved true", "retry: Claude Code refused the start"]);
});

test("a refusal's words split across chunks are read whole: one corrective start", async () => {
  const s = scriptedSession(true);
  s.proc.send("hello");
  s.first.out(ERROR_RESULT);
  s.first.err("No conversation fo");
  await flush();
  s.first.err("und with session ID: abc\n");
  s.first.end(1);
  await flush();
  assert.equal(s.children.length, 2);
  assert.ok(s.children[1]!.args.includes("--session-id"));
  assert.deepEqual(s.events, ["saved false", "retry: Claude Code refused the start"]);
});

test("stderr that does not end: the exit counts after one second, no corrective start, and words after it start none", async (t) => {
  mockTimers(t);
  const s = scriptedSession(false);
  s.proc.send("hello");
  s.first.exitEvent(1);
  await flush();
  t.mock.timers.tick(999);
  await flush();
  assert.deepEqual(s.events, []);
  t.mock.timers.tick(1);
  await flush();
  assert.deepEqual(s.events, ["exit 1"]);
  s.first.err(`Error: Session ID ${"x".repeat(8)} is already in use.\n`);
  s.first.endStreams();
  await flush();
  assert.equal(s.children.length, 1, "too late to correct the start");
  assert.equal(s.count("exit"), 1);
});

// ---------------------------------------------------------------- the early error result

test("a resumed start's early error result with unrelated words: no corrective start, the result reaches the role once, then the exit", async () => {
  const s = scriptedSession(true);
  s.proc.send("hello");
  s.first.out(ERROR_RESULT);
  await flush();
  assert.deepEqual(s.events, [], "held until the exit says whether the start is tried again");
  s.first.err("Error: something else went wrong\n");
  s.first.end(1);
  await flush();
  assert.equal(s.children.length, 1);
  assert.deepEqual(s.events, ["turnEnd false", "error: Error: something else went wrong", "exit 1"]);
});

test("a resumed process that writes only an error result and stays: no turn's end, no deadline; a kill ends it and hands the result on once", async (t) => {
  mockTimers(t);
  const s = scriptedSession(true);
  s.proc.send("hello");
  s.first.out(ERROR_RESULT);
  await flush();
  t.mock.timers.tick(600_000);
  await flush();
  // Today's contract: no start-up deadline; the session is working until its process ends.
  assert.deepEqual([s.events, s.proc.state], [[], "working"]);
  s.proc.kill();
  await flush();
  assert.equal(s.first.kills, 1);
  assert.equal(s.children.length, 1, "a kill is never followed by a corrective start");
  assert.deepEqual(s.events, ["turnEnd false", "exit 1"]);
});

// ---------------------------------------------------------------- spawn errors

test("the first process's spawn error: told once, one exit, no other start", async () => {
  const s = scriptedSession(false);
  s.proc.send("hello");
  s.first.fail(Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" }));
  s.first.end(1);
  await flush();
  assert.equal(s.children.length, 1);
  assert.deepEqual(s.events, ["error: could not start claude: spawn claude ENOENT", "exit 1"]);
});

test("the corrective start's spawn error: two starts, no third, one exit, the refused start's result not handed on", async () => {
  const s = scriptedSession(true);
  s.proc.send("hello");
  s.first.out(ERROR_RESULT);
  s.first.err("No conversation found with session ID: abc\n");
  s.first.end(1);
  await flush();
  assert.equal(s.children.length, 2);
  s.children[1]!.fail(new Error("spawn claude ENOENT"));
  s.children[1]!.end(1);
  await flush();
  assert.equal(s.children.length, 2);
  assert.deepEqual(s.events, ["saved false", "retry: Claude Code refused the start", "error: could not start claude: spawn claude ENOENT", "exit 1"]);
});

// ---------------------------------------------------------------- the first output that says the conversation is saved (LC-F5)

const EVIDENCE = {
  "init": { type: "system", subtype: "init", model: "fake-model", session_id: "s" },
  "assistant-only": { type: "assistant", message: { content: [{ type: "text", text: "hi" }] }, parent_tool_use_id: null },
  "result-only": { type: "result", subtype: "success", is_error: false, result: "r", num_turns: 1 },
} as const;

for (const [kind, line] of Object.entries(EVIDENCE)) {
  test(`saved by ${kind} output: false until it comes whole after broken and other lines, then true once, kept through the exit`, async () => {
    const s = scriptedSession(false);
    s.proc.send("hello");
    s.first.out("not json at all\n");
    s.first.out("{\"type\": \"assistant\", \"message\": \n"); // a broken line: skipped, not taken half
    s.first.out({ type: "system", subtype: "status", status: "requesting" });
    s.first.out({ type: "rate_limit_event", rate_limit_info: { status: "allowed" } });
    const json = JSON.stringify(line);
    s.first.out(json.slice(0, 20));
    await flush();
    assert.equal(s.events.length, 0, "nothing yet says the conversation is saved");
    s.first.out(json.slice(20) + "\n");
    await flush();
    assert.deepEqual(s.events.filter((e) => e.startsWith("saved")), ["saved true"]);
    s.first.out(EVIDENCE["result-only"]);
    s.first.end(0);
    await flush();
    assert.deepEqual(s.events.filter((e) => e.startsWith("saved")), ["saved true"]);
    assert.equal(s.events.at(-1), "exit 0");
  });
}

// ---------------------------------------------------------------- at the role: a worker

test("a worker whose every start fails (exit 2, no output) is tried as a passing failure and halts once, naming the exit", async () => {
  const { store, engine, queue, until: untilRun } = setup(["done\nFAKE-EXIT: 2 claude: unrelated start-up failure"]);
  try {
    engine.start("Q", { runtime: "claude" });
    await untilRun("the halt", () => queue().run?.state === "halted", LONGER.run);
    assert.match(queue().run!.reason!, new RegExp(`failed ${RETRY_LIMIT + 1} times in a row.*exited \\(2\\)`));
    const activity = activityOf(store, queue().run!.session);
    assert.equal(activity.filter((a) => a.kind === "retry" && a.text.startsWith("Nexus tries")).length, RETRY_LIMIT);
    assert.ok(activity.some((a) => a.kind === "error" && a.text.includes("claude: unrelated start-up failure")), "the runtime's words are shown");
    assert.deepEqual(queue().steps.map((st) => st.status), ["pending"]);
  } finally { engine.shutdown(); }
});
