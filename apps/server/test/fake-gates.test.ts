// The fake runtimes' start-up and end points a test holds and releases (FakeGates in fake-behaviour.ts, queue LCR):
// each point stops Claude's fake under the real adapter (ClaudeSession, in this process) until the test lets it go,
// and the gates leave nothing behind. A held point is waited for (an acknowledged arrival), never slept for.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { ClaudeSession } from "../src/claude.ts";
import { FakeGates, fakeGateSets, fakeSaved } from "./fake-behaviour.ts";
import { runFakeClaude } from "./fake-claude.ts";
import { inProcessClaude } from "./in-process-runtime.ts";
import { arrival, until } from "./wait.ts";

const root = mkdtempSync(join(tmpdir(), "nexus-fake-gates-"));
// The adapter writes the `nexus` shims into NEXUS_HOME's bin: this test's own folder, never the user's.
process.env.NEXUS_HOME = join(root, "home");

/** A Claude session under `gates`: what it emitted, in order, and what reached its fake (FAKE_LOG). */
function session(gates: FakeGates, resume = false) {
  const dir = mkdtempSync(join(root, "s-"));
  const env = { ...gates.env(), FAKE_LOG: join(dir, "log.jsonl") };
  const uuid = randomUUID();
  const events: string[] = [];
  const proc = new ClaudeSession({ cwd: dir, uuid, resume, permissionMode: "default", allowedTools: [], env, spawnChild: inProcessClaude });
  proc.on("turnEnd", (e) => events.push(`turnEnd ${e.ok} ${e.text}`));
  proc.on("exit", (code) => events.push(`exit ${code}`));
  proc.on("facts", (f) => { if (f.saved !== undefined) events.push(`saved ${f.saved}`); });
  proc.on("activity", (a) => { if (a.kind === "error" || a.kind === "retry") events.push(`${a.kind}: ${a.text}`); });
  const received = () => existsSync(env.FAKE_LOG) ? readFileSync(env.FAKE_LOG, "utf8").split("\n").filter(Boolean).map((l) => (JSON.parse(l) as { text: string }).text) : [];
  const saved = () => fakeSaved(uuid, "claude", env);
  const has = (prefix: string) => events.some((e) => e.startsWith(prefix));
  return { proc, events, received, saved, has, waitFor: (prefix: string) => until(`"${prefix}" among ${events.join("; ")}`, () => has(prefix)) };
}

/** Ends the session (if it still runs) and the gates; nothing of them may be left: no held fake, timer or set. */
async function finish(gates: FakeGates, s: ReturnType<typeof session>, before: number): Promise<void> {
  if (s.proc.state !== "exited") { s.proc.kill(); await s.waitFor("exit"); }
  gates.dispose();
  assert.deepEqual(gates.leftovers(), { held: [], running: 0, timers: 0 });
  assert.equal(fakeGateSets(), before);
  assert.equal(process.env.FAKE_GATES, undefined);
}

test("first-read: the fake reads nothing until released, then takes the message in and answers", async () => {
  const before = fakeGateSets();
  const gates = new FakeGates(["first-read"]);
  const s = session(gates);
  s.proc.send("hello");
  const held = await arrival(gates, "first-read");
  assert.equal(held.process, 1);
  assert.deepEqual([s.received(), s.saved(), s.events], [[], false, []]);
  held.release();
  await s.waitFor("turnEnd");
  assert.deepEqual(s.received(), ["hello"]);
  assert.deepEqual(s.events, ["saved true", "turnEnd true ok"]);
  await finish(gates, s, before);
});

test("save: the conversation is saved and nothing of the turn written until released", async () => {
  const before = fakeGateSets();
  const gates = new FakeGates(["save"]);
  const s = session(gates);
  s.proc.send("hello");
  const held = await arrival(gates, "save");
  assert.deepEqual([s.saved(), s.received(), s.events], [true, [], []]);
  held.release();
  await s.waitFor("turnEnd");
  assert.deepEqual(s.received(), ["hello"]);
  assert.deepEqual(s.events, ["saved true", "turnEnd true ok"]);
  await finish(gates, s, before);
});

test("first-output: the message is taken in, but no line reaches the adapter until released", async () => {
  const before = fakeGateSets();
  const gates = new FakeGates(["first-output"]);
  const s = session(gates);
  s.proc.send("hello");
  const held = await arrival(gates, "first-output");
  assert.equal(held.detail, "system");
  // The whole turn is written behind the held line, in its order.
  await until("the turn's whole output held", () => s.received().length === 1);
  assert.deepEqual([s.saved(), s.events, s.proc.state], [true, [], "working"]);
  held.release();
  await s.waitFor("turnEnd");
  assert.deepEqual(s.events, ["saved true", "turnEnd true ok"]);
  await finish(gates, s, before);
});

test("refusal: a refused start writes nothing and does not exit until released; then it is tried again", async () => {
  const before = fakeGateSets();
  const gates = new FakeGates(["refusal"]);
  const s = session(gates, true); // resumes a conversation never saved
  s.proc.send("hello");
  const held = await arrival(gates, "refusal");
  assert.match(held.detail ?? "", /^No conversation found with session ID: /);
  assert.deepEqual([s.events, s.proc.state], [[], "working"]);
  held.release();
  await s.waitFor("turnEnd");
  assert.deepEqual(s.events.map((e) => e.replace(/ \(.*$/, "")), ["saved false", "retry: Claude Code refused the start", "saved true", "turnEnd true ok"]);
  assert.deepEqual(s.received(), ["hello"]);
  await finish(gates, s, before);
});

test("stderr: the refusal's words wait until released; the error result before them is held by the adapter", async () => {
  const before = fakeGateSets();
  const gates = new FakeGates(["stderr"]);
  const s = session(gates, true);
  s.proc.send("hello");
  const held = await arrival(gates, "stderr");
  assert.match(held.detail ?? "", /^No conversation found/);
  assert.deepEqual(s.events, []); // the error result came, and is held until the exit; no refusal is known yet
  held.release();
  await s.waitFor("turnEnd");
  assert.deepEqual(s.events[0], "saved false");
  assert.equal(s.events.at(-1), "turnEnd true ok");
  await finish(gates, s, before);
});

test("exit, non-zero: a start-up failure (FAKE-EXIT) ends the process only when released, with its stderr", async () => {
  const before = fakeGateSets();
  const gates = new FakeGates(["exit"]);
  const s = session(gates);
  s.proc.send("FAKE-EXIT: 2 fake start-up failure");
  const held = await arrival(gates, "exit");
  assert.equal(held.detail, "2");
  assert.deepEqual([s.events, s.proc.state], [[], "working"]);
  held.release();
  await s.waitFor("exit");
  assert.deepEqual(s.events, ["error: fake start-up failure", "exit 2"]);
  await finish(gates, s, before);
});

test("exit, zero: a process whose input closed exits only when released", async () => {
  const before = fakeGateSets();
  const gates = new FakeGates(["exit"]);
  const s = session(gates);
  s.proc.send("hello");
  await s.waitFor("turnEnd");
  s.proc.close();
  const held = await arrival(gates, "exit");
  assert.equal(held.detail, "0");
  assert.equal(s.has("exit"), false);
  held.release();
  await s.waitFor("exit");
  assert.equal(s.events.at(-1), "exit 0");
  await finish(gates, s, before);
});

test("exit on a signal: FAKE-EXIT: signal after a turn ends the process only when released", async () => {
  const before = fakeGateSets();
  const gates = new FakeGates(["exit"]);
  const s = session(gates);
  s.proc.send("hello");
  await s.waitFor("turnEnd");
  s.proc.send("FAKE-EXIT: signal");
  const held = await arrival(gates, "exit");
  assert.equal(held.detail, "signal");
  assert.equal(s.has("exit"), false);
  held.release();
  await s.waitFor("exit");
  // In this process a signal ends the fake as the Windows job host reports it: exit code 1, no retry after output.
  assert.deepEqual(s.events, ["saved true", "turnEnd true ok", "exit 1"]);
  await finish(gates, s, before);
});

test("a fake killed while held stays ended: its release writes nothing, and the gates leave nothing behind", async () => {
  const before = fakeGateSets();
  const gates = new FakeGates(["first-read", "exit"]);
  const s = session(gates);
  s.proc.send("hello");
  const held = await arrival(gates, "first-read");
  assert.deepEqual(gates.leftovers(), { held: ["first-read#1"], running: 1, timers: 0 });
  s.proc.kill();
  await s.waitFor("exit");
  held.release();
  assert.deepEqual([s.received(), s.events], [[], ["exit 1"]]);
  await finish(gates, s, before);
});

test("a fake whose FAKE_GATES names no set in this process fails at its start", () => {
  const gates = new FakeGates(["first-read"]);
  gates.dispose();
  const io = { argv: [], env: gates.env(), cwd: root, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exit: () => {}, signal: () => {} };
  assert.throws(() => runFakeClaude(io), /FAKE_GATES names gates-\d+-\d+, which is not registered/);
});
