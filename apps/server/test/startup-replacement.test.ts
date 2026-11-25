// A session's start being corrected while Nexus acts on it (queue LCR, LC-F1 and LC-F2): Claude's refused start and its
// one corrective start (ClaudeSession startAgain, queue RN), Codex's thread resumed or replaced (CodexSession
// resumeThread). A kill, a shutdown, a closed input or a stop that comes meanwhile stays in force; what was sent
// meanwhile reaches the corrected process once each, in order, with its priority; the corrected process starts with the
// same settings; its usage counts from its own baseline, never twice; a late event of the old process changes nothing.
// Through AgentHost (its records are the durable state), against the fakes in this process, held at their points
// (FakeGates, fake-behaviour.ts); where only a scripted process gives the order, against one (scripted-child.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectStore, newId, now, type SessionFile } from "@nexus/protocol";
import { AgentHost, ROLE_RECORDS, type HostHandlers } from "../src/agent-host.ts";
import { ClaudeSession } from "../src/claude.ts";
import { CodexSession } from "../src/codex.ts";
import type { SpawnRuntimeChild } from "../src/worker-process.ts";
import { FakeGates, saveFakeConversation } from "./fake-behaviour.ts";
import { inProcessClaude, inProcessCodex } from "./in-process-runtime.ts";
import { scriptedSpawn } from "./scripted-child.ts";
import { arrival, holds, until } from "./wait.ts";

const OLD = "019a0000-0000-7000-8000-000000000004";

const lines = (file: string) => existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((x) => JSON.parse(x) as Record<string, unknown>) : [];

/** A worker session's project in a temporary folder, its AgentHost, and what the role saw of its process. */
function project(runtime: "claude" | "codex", native: string) {
  const root = mkdtempSync(join(tmpdir(), "nexus-startup-replacement-"));
  process.env.NEXUS_HOME = join(root, "home");
  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  const s: SessionFile = { protocol: 1, id: newId(), project: "p", role: "worker", runtime, title: "S", native_id: native, cwd: root, launched_by: "nexus", created_at: now() };
  store.writeSession(s);
  const events: string[] = [];
  const replies: string[] = [];
  const turns: { ok: boolean; text: string; cost?: number; input?: number }[] = [];
  const handlers: HostHandlers = {
    message: (t) => replies.push(t),
    turnEnd: (e) => { events.push(`turnEnd ${e.ok}`); turns.push({ ok: e.ok, text: e.text, cost: e.costUsd, input: e.tokens?.input }); },
    exit: (code, byNexus) => events.push(`exit ${code}${byNexus ? " by Nexus" : ""}`),
    activity: (a) => { if (a.kind === "error" || a.kind === "retry") events.push(`${a.kind}: ${a.text.replace(/ \(.*$/s, "")}`); },
  };
  const log = join(root, "fake.log"), args = join(root, "args.log");
  return {
    root, store, s, events, replies, turns, handlers, log, args,
    /** What reached the agent, with its priority. */
    received: () => lines(log).map((x) => `${x.text as string}${x.priority ? ` (${x.priority as string})` : ""}`),
    record: () => store.readRuntime(s.id),
  };
}

/**
 * A Claude worker whose runtime record gives the wrong mark: "a resume of a conversation never saved" (the record says
 * saved, the fake saved nothing) or "a fresh start of a saved conversation" (the record says unsaved, the fake saved it).
 */
function claudeWorker(wrong: "resume" | "fresh", o: { gates?: FakeGates; env?: Record<string, string>; spawnChild?: SpawnRuntimeChild } = {}) {
  const native = randomUUID();
  const p = project("claude", native);
  p.store.writeRuntime(p.s.id, { state: "exited", turns: 0, updated_at: now(), conversation_saved: wrong === "resume" });
  const launches: { args: string[]; cwd: string }[] = [];
  const spawnChild: SpawnRuntimeChild = (bin, args, options) => { launches.push({ args, cwd: options.cwd }); return (o.spawnChild ?? inProcessClaude)(bin, args, options); };
  const h = new AgentHost(p.store, ROLE_RECORDS.worker, { spawn: (launch) => new ClaudeSession({ ...(launch.options as ConstructorParameters<typeof ClaudeSession>[0]), spawnChild }) });
  const env = { ...h.env(p.s.id), FAKE_LOG: p.log, FAKE_ARGS: p.args, ...o.gates?.env(), ...o.env };
  if (wrong === "fresh") saveFakeConversation(native, "claude", env);
  const l = h.start(p.s, (resume) => ({ runtime: "claude", options: {
    cwd: p.root, uuid: native, resume, model: "fake-model-x", effort: "high", permissionMode: "dontAsk", allowedTools: ["Bash(nexus:*)"],
    disallowedTools: ["Write(//c/secret/**)"], appendSystemPrompt: "BRIEFING-LCR4", settings: "{\"lcr\":4}", lateTurnMs: 100, env,
  } }), {}, () => p.handlers);
  /** How each start named the session: --resume or --session-id. */
  const flags = () => launches.map((x) => x.args.find((a) => a === "--resume" || a === "--session-id"));
  return { ...p, h, l, launches, flags, native, env };
}

/** A Codex worker whose record names thread OLD, which the fake never saved (its resume finds no rollout). */
function codexWorker(o: { gates?: FakeGates; env?: Record<string, string> } = {}) {
  const p = project("codex", OLD);
  p.store.writeRuntime(p.s.id, { state: "exited", turns: 0, updated_at: now() });
  const h = new AgentHost(p.store, ROLE_RECORDS.worker, { spawn: (launch) => new CodexSession({ ...(launch.options as ConstructorParameters<typeof CodexSession>[0]), spawnChild: inProcessCodex }) });
  const env = { ...h.env(p.s.id), FAKE_LOG: p.log, FAKE_ARGS: p.args, ...o.gates?.env(), ...o.env };
  const l = h.start(p.s, () => ({ runtime: "codex", options: {
    cwd: p.root, threadId: p.store.readSession(p.s.id).native_id, model: "fake-codex-m", effort: "high", instructions: "BRIEFING-LCR4", env,
    sandbox: "workspace-write", approvalPolicy: "never", writableRoots: [p.root],
  } }), {}, () => p.handlers);
  /** The requests the fake was asked, by method, in order. */
  const asked = () => lines(p.args).map((x) => String(x.method));
  return { ...p, h, l, asked, native: () => p.store.readSession(p.s.id).native_id };
}

// ---------------------------------------------------------------- Claude: a kill, a close or a stop while the start is corrected (LC-F1)

test("claude: killed while its refused start is held before the exit: no corrective start, one exit by Nexus, the record exited", async () => {
  const gates = new FakeGates(["exit"]);
  const w = claudeWorker("resume", { gates });
  try {
    w.h.send(w.l, "hello");
    const held = await arrival(gates, "exit");
    assert.equal(held.detail, "1");
    w.h.shutdown();
    await until("the exit", () => w.events.some((e) => e.startsWith("exit")));
    held.release();
    await holds("no other start and no other event", () => w.launches.length === 1 && w.events.length === 3, 200);
    // The refused start's early error result is the turn's end the role gets, and its words the error shown: once each,
    // before the exit.
    assert.deepEqual(w.events, ["turnEnd false", `error: No conversation found with session ID: ${w.native}`, "exit 1 by Nexus"]);
    assert.deepEqual(w.received(), []);
    assert.equal(w.record()?.state, "exited");
  } finally { gates.dispose(); }
});

test("claude: killed during the one-second wait for a refusal's words: no corrective start, one exit", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const flush = async () => { for (let i = 0; i < 5; i++) await new Promise<void>((r) => setImmediate(r)); };
  const { children, spawnChild } = scriptedSpawn();
  const proc = new ClaudeSession({ cwd: tmpdir(), uuid: randomUUID(), resume: false, permissionMode: "default", allowedTools: [], env: {}, spawnChild });
  const events: string[] = [];
  proc.on("exit", (c) => events.push(`exit ${c}`));
  proc.on("activity", (a) => { if (a.kind === "retry") events.push("retry"); });
  proc.send("hello");
  const first = children[0]!;
  first.onKill = () => {}; // the process has exited already: a kill finds nothing
  first.exitEvent(1); // its words still to come
  await flush();
  t.mock.timers.tick(500);
  proc.kill();
  first.err("Error: Session ID abc is already in use.\n");
  first.endStreams();
  await flush();
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(children.length, 1, "a kill is never followed by a corrective start");
  assert.equal(first.kills, 1);
  assert.deepEqual(events, ["exit 1"]);
});

test("claude: input closed before the refused start's exit: the corrective start gets the message once, its input closed, and ends after answering", async () => {
  const gates = new FakeGates(["exit"]);
  const w = claudeWorker("resume", { gates });
  try {
    w.h.send(w.l, "hello");
    const held = await arrival(gates, "exit");
    w.h.close(w.s.id);
    held.release();
    // The gate holds every exit: the corrective start's own, after its answer, too.
    const second = await arrival(gates, "exit");
    assert.deepEqual([second.process, second.detail], [2, "0"]);
    second.release();
    await until("the exit", () => w.events.some((e) => e.startsWith("exit")));
    assert.deepEqual(w.flags(), ["--resume", "--session-id"]);
    assert.deepEqual(w.received(), ["hello"]);
    assert.deepEqual(w.events, ["retry: Claude Code refused the start", "turnEnd true", "exit 0 by Nexus"]);
    assert.deepEqual(w.replies, ["ok"]);
    assert.equal(w.record()?.state, "exited");
    assert.equal(w.record()?.conversation_saved, true);
  } finally { gates.dispose(); }
});

test("claude: stopped before any output, with a next message sent before and one during the stop: the corrective start is interrupted, shows nothing of the stopped turn, then takes the held message once", async () => {
  const gates = new FakeGates(["refusal"]);
  const w = claudeWorker("resume", { gates });
  try {
    w.h.send(w.l, "FAKE-SLOW alpha");
    const held = await arrival(gates, "refusal");
    w.l.proc.send("beta", "next");
    assert.equal(w.l.proc.stop(), true);
    w.l.proc.send("gamma");
    held.release();
    await until("gamma's reply", () => w.replies.length > 0);
    await until("its turn's end", () => w.turns.length === 3);
    assert.deepEqual(w.flags(), ["--resume", "--session-id"]);
    assert.deepEqual(w.replies, ["ok"], "nothing of the stopped turns is shown");
    assert.deepEqual(w.turns.map((x) => `${x.ok} ${x.text}`), ["false stopped", "false stopped", "true ok"]);
    const got = w.received();
    assert.deepEqual(got.filter((x) => !x.startsWith("[control]")), ["FAKE-SLOW alpha", "beta (next)", "gamma"]);
    assert.ok(got.indexOf("[control] interrupt") > got.indexOf("beta (next)") && got.indexOf("[control] interrupt") < got.indexOf("gamma"), `the interrupt reached the corrective start before gamma: ${got.join(" | ")}`);
  } finally { w.h.shutdown(); gates.dispose(); }
});

// ---------------------------------------------------------------- Codex: a kill or a stop before the thread's answer (LC-F1)

for (const method of ["thread/resume", "thread/start"] as const) {
  test(`codex: shut down before the ${method} answer: no turn starts, one exit by Nexus, the recorded id kept`, async () => {
    const gates = new FakeGates([`answer:${method}`]);
    const w = codexWorker({ gates });
    try {
      w.h.send(w.l, "hello");
      const held = await arrival(gates, `answer:${method}`);
      w.h.shutdown();
      await until("the exit", () => w.events.some((e) => e.startsWith("exit")));
      held.release();
      const ends = () => w.events.filter((e) => e.startsWith("exit") || e.startsWith("turnEnd"));
      await holds("nothing after the exit", () => ends().length === 1, 200);
      assert.deepEqual(ends(), ["exit 1 by Nexus"]);
      if (method === "thread/start") assert.ok(w.events.some((e) => e.startsWith("retry: Codex has no saved thread")));
      assert.ok(!w.asked().includes("turn/start"));
      assert.deepEqual(w.received(), []);
      assert.equal(w.native(), OLD);
      assert.equal(w.record()?.state, "exited");
    } finally { gates.dispose(); }
  });

  test(`codex: stopped before the ${method} answer: the turn that then starts is interrupted before any reply shows, and the message sent during the stop runs once after it`, async () => {
    const gates = new FakeGates([`answer:${method}`]);
    const w = codexWorker({ gates });
    try {
      w.h.send(w.l, "FAKE-SLOW alpha");
      const held = await arrival(gates, `answer:${method}`);
      assert.equal(w.l.proc.stop(), true);
      w.l.proc.send("gamma");
      held.release();
      await until("gamma's turn's end", () => w.turns.length === 2);
      assert.deepEqual(w.replies, ["ok"], "nothing of the stopped turn is shown");
      assert.deepEqual(w.turns.map((x) => x.ok), [false, true]);
      assert.deepEqual(w.received(), ["FAKE-SLOW alpha", "[interrupt]", "gamma"]);
      assert.deepEqual(w.asked().filter((m) => m === "thread/start" || m === "turn/start"), ["thread/start", "turn/start", "turn/start"]);
      assert.notEqual(w.native(), OLD);
    } finally { w.h.shutdown(); gates.dispose(); }
  });
}

// ---------------------------------------------------------------- what was sent meanwhile, the settings, the usage (LC-F2)

for (const wrong of ["resume", "fresh"] as const) {
  const what = wrong === "resume" ? "a resume of a conversation never saved" : "a fresh start of a saved conversation";
  test(`claude, ${what}: a turn, a next and a queued message sent while the refusal is held reach the corrective start once each, in order and priority; same settings; usage from its own baseline`, async () => {
    const gates = new FakeGates(["refusal"]);
    const release = join(tmpdir(), `nexus-lcr4-release-${randomUUID()}`);
    const w = claudeWorker(wrong, { gates, env: { FAKE_COST: "1", FAKE_RELEASE: release } });
    try {
      w.h.send(w.l, "FAKE-HOLD MSG-1");
      const held = await arrival(gates, "refusal");
      w.l.proc.send("MSG-2", "next");
      w.l.proc.send("MSG-3");
      held.release();
      await until("MSG-1 at work in the corrective start", () => w.received().length === 3);
      writeFileSync(release, "");
      await until("both turns' ends", () => w.turns.length === 2);
      assert.deepEqual(w.flags(), wrong === "resume" ? ["--resume", "--session-id"] : ["--session-id", "--resume"]);
      assert.deepEqual(w.received(), ["FAKE-HOLD MSG-1", "MSG-2 (next)", "MSG-3"]);
      assert.deepEqual(w.replies, ["held reply", "ok"]);
      assert.equal(w.record()?.turns, 2);
      // The same start but for the session's flag: model, effort, briefing file, tools, permission mode, settings, cwd.
      const strip = (a: string[]) => a.filter((x) => x !== "--resume" && x !== "--session-id");
      assert.deepEqual(strip(w.launches[1]!.args), strip(w.launches[0]!.args));
      assert.equal(w.launches[1]!.cwd, w.launches[0]!.cwd);
      for (const flag of ["--model", "--effort", "--permission-mode", "--settings", "--disallowedTools", "--allowedTools"]) assert.ok(w.launches[1]!.args.includes(flag), flag);
      assert.deepEqual(lines(w.args).map((x) => x.briefing), ["BRIEFING-LCR4", "BRIEFING-LCR4"]);
      // Usage: the corrective start's own turns, 10 and 20 input tokens; a fresh process's cost counts from 0, a resumed
      // one's first turn has none (its running total starts with earlier turns); never the refused start's, never twice.
      assert.deepEqual(w.turns.map((x) => x.input), [10, 20]);
      assert.deepEqual(w.turns.map((x) => x.cost), wrong === "resume" ? [0.01, 0.02] : [undefined, 0.02]);
    } finally { writeFileSync(release, ""); w.h.shutdown(); gates.dispose(); }
  });
}

test("codex: three messages sent while the new thread starts reach it once each, in order; the thread's and each turn's settings kept; tokens per turn not doubled", async () => {
  const gates = new FakeGates(["answer:thread/start"]);
  const w = codexWorker({ gates });
  try {
    w.h.send(w.l, "MSG-1");
    const held = await arrival(gates, "answer:thread/start");
    w.l.proc.send("MSG-2", "next");
    w.l.proc.send("MSG-3");
    held.release();
    await until("three turns' ends", () => w.turns.length === 3);
    // Before the thread is ready every message waits as a turn of its own: a `next` too (no turn to steer yet).
    assert.deepEqual(w.received(), ["MSG-1", "MSG-2", "MSG-3"]);
    assert.deepEqual(w.turns.map((x) => x.ok), [true, true, true]);
    assert.equal(w.record()?.turns, 3);
    assert.deepEqual(w.asked(), ["thread/resume", "thread/start", "turn/start", "turn/start", "turn/start"]);
    const [resume, start, ...turnStarts] = lines(w.args);
    for (const k of ["model", "sandbox", "config", "instructions"]) assert.deepEqual(start![k], resume![k], k);
    assert.equal(start!.model, "fake-codex-m");
    assert.equal(start!.instructions, "BRIEFING-LCR4");
    for (const t of turnStarts) assert.deepEqual([t.effort, t.writableRoots, t.networkAccess], ["high", [w.root], false]);
    // Each turn's own uncached input (the fake's turn n: 100n and 120 input, 60n and 50 of them cached), from the new
    // thread's baseline: none counted twice, none of an earlier turn's.
    assert.deepEqual(w.turns.map((x) => x.input), [110, 150, 190]);
  } finally { w.h.shutdown(); gates.dispose(); }
});

test("claude: a late event of the refused process (its spawn, output, words, exit) changes nothing of the corrective start's record", async () => {
  const { children, spawnChild } = scriptedSpawn();
  const w = claudeWorker("resume", { spawnChild });
  const flush = async () => { for (let i = 0; i < 5; i++) await new Promise<void>((r) => setImmediate(r)); };
  try {
    w.h.send(w.l, "hello");
    const first = children[0]!;
    first.out({ type: "result", subtype: "error_during_execution", is_error: true, num_turns: 0, total_cost_usd: 0, modelUsage: {}, permission_denials: [] });
    first.err(`No conversation found with session ID: ${w.native}\n`);
    first.end(1);
    await until("the corrective start", () => children.length === 2);
    await flush();
    const second = children[1]!;
    assert.equal(w.record()?.pid, second.pid);
    assert.equal(w.record()?.conversation_saved, false);
    const before = JSON.stringify(w.record());
    const events = w.events.length;
    first.emit("spawn");
    first.emit("exit", 1, null);
    first.emit("close", 1, null);
    await flush();
    assert.equal(JSON.stringify(w.record()), before, "the record is the corrective start's");
    assert.equal(w.events.length, events, "no event of the old process reaches the role");
    assert.deepEqual(second.written, first.written, "the message went to the corrective start");
    second.out({ type: "system", subtype: "init", model: "m", session_id: "s" });
    second.out({ type: "result", subtype: "success", is_error: false, result: "ok", num_turns: 1, total_cost_usd: 0 });
    await until("its turn's end", () => w.turns.length === 1);
    assert.equal(w.record()?.pid, second.pid);
    assert.equal(w.record()?.conversation_saved, true);
  } finally { w.h.shutdown(); }
});
