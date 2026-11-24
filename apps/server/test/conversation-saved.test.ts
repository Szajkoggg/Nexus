// Resuming only a conversation Claude Code saved (queue RN): Claude Code saves a session's conversation when it reads
// the session's first message, so a process that ended before that left nothing to resume, and `--resume` then fails
// with "No conversation found" (the failure after a deploy). The fake keeps what it saved across its processes and
// refuses as Claude Code does (fake-claude.ts); FAKE_START_MS holds its first read, so a test can end it before.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ProjectStore, newId, now, type RuntimeFile, type SessionFile } from "@nexus/protocol";
import { AgentHost, ROLE_RECORDS, type HostHandlers, type Launch } from "../src/agent-host.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import type { Engine } from "../src/engine.ts";
import { RESTARTED } from "../src/chats.ts";
import { saveFakeConversation } from "./fake-behaviour.ts";
import { restart, setup, REAL_PROCESSES } from "./engine-setup.ts";
import { LONGER, holdWork, sleep, until } from "./wait.ts";

// The fake runtimes as processes of their own (scripts/real-process-tests.ts).
process.env.NEXUS_CLAUDE = fileURLToPath(new URL("./fake-claude.ts", import.meta.url));
process.env.NEXUS_CODEX = fileURLToPath(new URL("./fake-codex.ts", import.meta.url));

/** The fake's starts (FAKE_ARGS), each as its flag and the id: ["--session-id", id] or ["--resume", id]. */
function starts(): string[][] {
  const f = process.env.FAKE_ARGS!;
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8").trim().split("\n").map((l) => (JSON.parse(l) as { argv: string[] }).argv).map((a) => {
    const i = a.findIndex((x) => x === "--session-id" || x === "--resume");
    return [a[i]!, a[i + 1]!];
  });
}

/** Ends a test's own environment settings. */
function clean(): void { delete process.env.FAKE_START_MS; delete process.env.FAKE_ARGS; }

/** Has the fake record its starts (FAKE_ARGS) beside its log, in the test's temporary folder. */
function recordStarts(): void { process.env.FAKE_ARGS = join(dirname(process.env.FAKE_LOG!), "args.log"); }

/** The messages the fake took in (FAKE_LOG), in order. */
function received(): string[] {
  const f = process.env.FAKE_LOG!;
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8").trim().split("\n").map((l) => (JSON.parse(l) as { text: string }).text);
}

// ---------------------------------------------------------------- the worker

test("a worker whose process ended before it saved the conversation starts afresh after the restart, and its step runs", async () => {
  const { store, engine, queue, until: wait } = setup(["done", "done"], REAL_PROCESSES);
  recordStarts();
  process.env.FAKE_START_MS = "60000"; // the process never reads its first message
  let next: Engine | undefined;
  try {
    engine.start("Q");
    const session = queue().run!.session;
    await wait("the process to start", () => starts().length === 1 && store.readRuntime(session)?.pid !== undefined);
    engine.drainForUpdate(true); // a deploy: the process is ended before it read the step
    await wait("the process to exit", () => store.readRuntime(session)?.state === "exited");
    engine.shutdown();
    delete process.env.FAKE_START_MS;
    next = restart(store, REAL_PROCESSES);
    await wait("the run to finish", () => queue().run?.state === "finished", LONGER.run);
    const native = store.readSession(session).native_id!;
    assert.deepEqual(starts(), [["--session-id", native], ["--session-id", native]], "the same id, started afresh");
    assert.deepEqual(queue().steps.map((s) => s.status), ["done", "done"]);
    assert.equal(queue().run?.retries, undefined, "no failed turn on the way");
    assert.equal(store.readRuntime(session)?.conversation_saved, true);
    assert.ok(!store.readActivity(session).entries.some((a) => /No conversation found/.test(a.text)));
  } finally { engine.shutdown(); next?.shutdown(); clean(); }
});

test("a worker stopped during its first turn, after the conversation was saved, resumes it without an error", async () => {
  const work = holdWork();
  const { store, engine, queue, until: wait } = setup(["slow", "done"], REAL_PROCESSES);
  recordStarts();
  let next: Engine | undefined;
  try {
    engine.start("Q");
    await wait("the step to run", () => queue().steps[0]!.status === "running", LONGER.step);
    const session = queue().run!.session;
    assert.equal(store.readRuntime(session)?.conversation_saved, true, "saved once the first message was read");
    assert.equal(store.readRuntime(session)?.turns, 0, "in its first turn");
    engine.drainForUpdate(true);
    await wait("the process to exit", () => store.readRuntime(session)?.state === "exited");
    engine.shutdown();
    work.release();
    next = restart(store, REAL_PROCESSES);
    await wait("the run to finish", () => queue().run?.state === "finished", LONGER.run);
    const native = store.readSession(session).native_id!;
    assert.deepEqual(starts(), [["--session-id", native], ["--resume", native]], "the saved conversation goes on");
    assert.equal(queue().run?.retries, undefined);
    assert.ok(!store.readActivity(session).entries.some((a) => a.kind === "error"), "no error on the way");
  } finally { engine.shutdown(); next?.shutdown(); work.done(); clean(); }
});

// ---------------------------------------------------------------- every role, on AgentHost

function hostSetup() {
  const root = mkdtempSync(join(tmpdir(), "nexus-saved-"));
  process.env.NEXUS_HOME = join(root, "home");
  process.env.FAKE_LOG = join(root, "fake.log");
  process.env.FAKE_ARGS = join(root, "args.log");
  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  const s: SessionFile = { protocol: 1, id: newId(), project: "p", role: "conversation", runtime: "claude", title: "S", native_id: randomUUID(), cwd: root, launched_by: "nexus", created_at: now() };
  store.writeSession(s);
  return { root, store, s };
}

/**
 * A server's AgentHost for the role, starting the session's process with the fake (the real ClaudeSession); its
 * replies are kept, or `handlers` get the process's events instead.
 */
function host(store: ProjectStore, s: SessionFile, role: keyof typeof ROLE_RECORDS, handlers?: HostHandlers) {
  const h = new AgentHost(store, ROLE_RECORDS[role]);
  const replies: string[] = [];
  const launch = (resume: boolean): Launch => ({ runtime: "claude", options: { cwd: s.cwd, uuid: s.native_id!, resume, permissionMode: "dontAsk", allowedTools: [], env: h.env(s.id) } });
  const l = h.start(s, launch, {}, () => handlers ?? { message: (t) => replies.push(t) });
  return { h, l, replies };
}

for (const role of Object.keys(ROLE_RECORDS) as (keyof typeof ROLE_RECORDS)[]) {
  test(`${role}: a session whose process ended before it saved anything starts afresh with the same id, and its message is answered`, async () => {
    const { store, s } = hostSetup();
    process.env.FAKE_START_MS = "60000";
    let second: ReturnType<typeof host> | undefined;
    const first = host(store, s, role);
    try {
      first.h.send(first.l, "the first message");
      await until("the process to start", () => starts().length === 1);
      assert.equal(store.readRuntime(s.id)?.conversation_saved, false);
      first.h.shutdown(); // the server stops
      await until("the process to exit", () => store.readRuntime(s.id)?.state === "exited");
      delete process.env.FAKE_START_MS;
      second = host(store, s, role); // the next server
      second.h.send(second.l, "the first message, again");
      await until("the reply", () => second!.replies.includes("ok"));
      assert.deepEqual(starts(), [["--session-id", s.native_id], ["--session-id", s.native_id]]);
      assert.equal(store.readRuntime(s.id)?.conversation_saved, true);
    } finally { first.h.shutdown(); second?.h.shutdown(); clean(); }
  });
}

test("a session with a saved conversation is resumed after a restart", async () => {
  const { store, s } = hostSetup();
  let second: ReturnType<typeof host> | undefined;
  const first = host(store, s, "orchestrator");
  try {
    first.h.send(first.l, "hello");
    await until("the reply", () => first.replies.includes("ok"));
    first.h.shutdown();
    await until("the process to exit", () => store.readRuntime(s.id)?.state === "exited");
    second = host(store, s, "orchestrator");
    second.h.send(second.l, "hello again");
    await until("the reply", () => second!.replies.includes("ok"));
    assert.deepEqual(starts(), [["--session-id", s.native_id], ["--resume", s.native_id]]);
  } finally { first.h.shutdown(); second?.h.shutdown(); clean(); }
});

test("a runtime record written before the mark (none) is taken as a saved conversation and resumed", async () => {
  const { store, s } = hostSetup();
  saveFakeConversation(s.native_id!); // the conversation the earlier server's process saved
  store.writeRuntime(s.id, { state: "exited", turns: 4, model: "fake-model", updated_at: now() });
  const h = host(store, s, "worker");
  try {
    h.h.send(h.l, "hello");
    await until("the reply", () => h.replies.includes("ok"));
    assert.deepEqual(starts(), [["--resume", s.native_id]]);
    assert.equal(store.readRuntime(s.id)?.conversation_saved, undefined, "a resumed session's record is left as it was");
  } finally { h.h.shutdown(); clean(); }
});

// ---------------------------------------------------------------- a start Claude Code refuses: tried once more

test("a refused start is tried once more the other way, with its message: none found starts afresh, already in use resumes", async () => {
  const { store, s } = hostSetup();
  // A record from before the mark whose process never saved anything (the sessions stuck before RN).
  store.writeRuntime(s.id, { state: "exited", turns: 0, updated_at: now() });
  const a = host(store, s, "conversation");
  try {
    a.h.send(a.l, "hello");
    await until("the reply", () => a.replies.includes("ok"));
    assert.equal(store.readRuntime(s.id)?.conversation_saved, true, "corrected, then saved by the new process");
    assert.equal(store.readRuntime(s.id)?.pid, a.l.proc.pid, "the record names the new process");
  } finally { a.h.shutdown(); }
  // A record that says unsaved while the conversation was saved (a process ended between its read and its output).
  store.writeRuntime(s.id, { ...store.readRuntime(s.id)!, state: "exited", conversation_saved: false });
  const b = host(store, s, "conversation");
  try {
    b.h.send(b.l, "hello again");
    await until("the reply", () => b.replies.includes("ok"));
    assert.equal(store.readRuntime(s.id)?.conversation_saved, true);
    assert.deepEqual(starts().map(([flag]) => flag), ["--resume", "--session-id", "--session-id", "--resume"]);
    assert.deepEqual(received(), ["hello", "hello again"], "each message reached the agent once");
  } finally { b.h.shutdown(); clean(); }
});

test("a start refused a second time is not tried again: the process exits as before", async () => {
  const { store, s } = hostSetup();
  store.writeRuntime(s.id, { state: "exited", turns: 0, updated_at: now() });
  process.env.FAKE_REFUSE = "1";
  const exits: (number | null)[] = [];
  const { h, l } = host(store, s, "orchestrator", { exit: (code) => exits.push(code) });
  try {
    h.send(l, "hello");
    await until("the exit", () => exits.length === 1);
    await sleep(1500); // no third start comes
    assert.deepEqual(starts().map(([flag]) => flag), ["--resume", "--session-id"]);
    assert.deepEqual(exits, [1]);
  } finally { h.shutdown(); delete process.env.FAKE_REFUSE; clean(); }
});

/** A worker's session after a step that saved its conversation, or not (FAKE_START_MS), with its record changed. */
async function workerRecord(saved: boolean, edit: (r: RuntimeFile) => RuntimeFile) {
  const x = setup(saved ? ["slow", "done"] : ["done", "done"], REAL_PROCESSES);
  recordStarts();
  if (!saved) process.env.FAKE_START_MS = "60000";
  x.engine.start("Q");
  const session = x.queue().run!.session;
  if (saved) await x.until("the step to run", () => x.queue().steps[0]!.status === "running", LONGER.step);
  else await x.until("the process to start", () => starts().length === 1 && x.store.readRuntime(session)?.pid !== undefined);
  x.engine.drainForUpdate(true);
  await x.until("the process to exit", () => x.store.readRuntime(session)?.state === "exited");
  x.engine.shutdown();
  delete process.env.FAKE_START_MS;
  x.store.writeRuntime(session, edit(x.store.readRuntime(session)!));
  return { ...x, session };
}

for (const saved of [false, true]) {
  test(`a worker whose record ${saved ? "says unsaved though its conversation was saved" : "has no mark though nothing was saved"}: the refused start is tried again, and the run goes on`, async () => {
    const work = holdWork();
    const x = await workerRecord(saved, (r) => {
      const { conversation_saved: _c, ...old } = r;
      return saved ? { ...r, conversation_saved: false } : old; // a record from before RN has no mark
    });
    let next: Engine | undefined;
    try {
      work.release();
      next = restart(x.store, REAL_PROCESSES);
      await x.until("the run to finish", () => x.queue().run?.state === "finished", LONGER.run);
      const native = x.store.readSession(x.session).native_id!;
      assert.deepEqual(starts(), saved
        ? [["--session-id", native], ["--session-id", native], ["--resume", native]]
        : [["--session-id", native], ["--resume", native], ["--session-id", native]]);
      assert.deepEqual(x.queue().steps.map((st) => st.status), ["done", "done"]);
      assert.equal(x.queue().run?.retries, undefined, "no failed turn: the engine never saw the refusal");
      assert.equal(x.store.readRuntime(x.session)?.conversation_saved, true);
    } finally { x.engine.shutdown(); next?.shutdown(); work.done(); clean(); }
  });
}

// ---------------------------------------------------------------- the orchestrator, with its message cut off

/** An orchestrator's project in a temporary folder, the fake recording its starts, and an engine it needs not. */
function orchestratorSetup() {
  const root = mkdtempSync(join(tmpdir(), "nexus-saved-orch-"));
  process.env.NEXUS_HOME = join(root, "home");
  process.env.FAKE_LOG = join(root, "fake.log");
  process.env.FAKE_ARGS = join(root, "args.log");
  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  const engine = { draining: false, onChange() {}, shutdown() {} } as unknown as Engine;
  return { store, engine };
}

test("the orchestrator: a message its process had not read when the server stopped reaches the fresh process", async () => {
  process.env.FAKE_START_MS = "60000";
  const { store, engine } = orchestratorSetup();
  const first = new Orchestrator(store, engine, () => {});
  let next: Orchestrator | undefined;
  try {
    first.say("Plan the layout, please.");
    await until("the process to start", () => starts().length === 1);
    first.cutOff(); // an update's hand-over: the turn is cut off, its message kept
    first.shutdown();
    const s = store.readProject().orchestrator!.session!;
    await until("the process to exit", () => store.readRuntime(s)?.state === "exited");
    delete process.env.FAKE_START_MS;
    next = new Orchestrator(store, engine, () => {});
    next.resumeCutOff();
    await until("the message to reach the agent", () => received().some((t) => t.includes("Plan the layout, please.")));
    await until("the reply", () => next!.view().chat.some((c) => c.from === "orchestrator" && c.text === "ok"));
    const native = store.readSession(s).native_id!;
    assert.deepEqual(starts(), [["--session-id", native], ["--session-id", native]]);
    assert.ok(next.view().chat.some((c) => c.text === RESTARTED));
    assert.ok(!next.view().chat.some((c) => c.kind === "error"), "no error in the chat");
  } finally { first.shutdown(); next?.shutdown(); clean(); }
});

for (const saved of [false, true]) {
  test(`the orchestrator whose record ${saved ? "says unsaved though its conversation was saved" : "has no mark though nothing was saved"}: its cut-off message reaches the agent after one more start`, async () => {
    // Unsaved: the process never reads the message. Saved: it reads it (and saves) and works on until the cut.
    if (saved) process.env.FAKE_CHAT_SLOW_MS = "60000"; else process.env.FAKE_START_MS = "60000";
    const { store, engine } = orchestratorSetup();
    const first = new Orchestrator(store, engine, () => {});
    let next: Orchestrator | undefined;
    try {
      first.say(saved ? "FAKE-SLOW plan the layout" : "Plan the layout, please.");
      const s = () => store.readProject().orchestrator!.session!;
      if (saved) await until("the turn at work", () => first.view().chat.some((c) => c.kind === "tool"));
      else await until("the process to start", () => starts().length === 1);
      first.cutOff();
      first.shutdown();
      await until("the process to exit", () => store.readRuntime(s())?.state === "exited");
      delete process.env.FAKE_START_MS;
      process.env.FAKE_CHAT_SLOW_MS = "50";
      const { conversation_saved: _c, ...old } = store.readRuntime(s())!;
      store.writeRuntime(s(), saved ? { ...old, conversation_saved: false } : old);
      next = new Orchestrator(store, engine, () => {});
      next.resumeCutOff();
      await until("the reply", () => next!.view().chat.some((c) => c.from === "orchestrator" && (c.text === "ok" || c.text === "slow reply")));
      const native = store.readSession(s()).native_id!;
      assert.deepEqual(starts(), saved
        ? [["--session-id", native], ["--session-id", native], ["--resume", native]]
        : [["--session-id", native], ["--resume", native], ["--session-id", native]]);
      const original = saved ? "FAKE-SLOW plan the layout" : "Plan the layout, please.";
      assert.equal(received().filter((t) => t.includes(original)).length, saved ? 2 : 1, "once after the restart (and, saved, once before the cut)");
    } finally { first.shutdown(); next?.shutdown(); clean(); delete process.env.FAKE_CHAT_SLOW_MS; }
  });
}

// ---------------------------------------------------------------- Codex (queue RN, step RN2)
// Codex saves a thread when its first turn starts, not at thread/start: a process ended between the two leaves a
// thread id with nothing behind it, and thread/resume fails with "no rollout found". FAKE_TURN_START_MS holds the
// fake's turn/start, so a test can end the process there.

/** The fake Codex's thread calls (FAKE_ARGS): ["thread/start"] or ["thread/resume", id]. */
function threadCalls(): string[][] {
  const f = process.env.FAKE_ARGS!;
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { method?: string; threadId?: string })
    .filter((c) => c.method === "thread/start" || c.method === "thread/resume")
    .map((c) => (c.method === "thread/resume" ? [c.method, c.threadId!] : [c.method!]));
}

test("codex: a worker whose process ended before its thread was saved goes on in a new thread after the restart, and its step runs", async () => {
  const { store, engine, queue, until: wait } = setup(["done", "done"], REAL_PROCESSES);
  recordStarts();
  process.env.FAKE_TURN_START_MS = "60000"; // the thread is started, its first turn never
  let next: Engine | undefined;
  try {
    engine.start("Q", { runtime: "codex" });
    const session = queue().run!.session;
    await wait("the thread to start", () => !!store.readSession(session).native_id && threadCalls().length === 1);
    const unsaved = store.readSession(session).native_id!;
    engine.drainForUpdate(true); // held for the restart; the process, waiting for its turn, ends with the server
    engine.shutdown();
    await wait("the process to exit", () => store.readRuntime(session)?.state === "exited");
    delete process.env.FAKE_TURN_START_MS;
    next = restart(store, REAL_PROCESSES);
    await wait("the run to finish", () => queue().run?.state === "finished", LONGER.run);
    assert.deepEqual(threadCalls(), [["thread/start"], ["thread/resume", unsaved], ["thread/start"]], "resume refused, a new thread instead");
    assert.notEqual(store.readSession(session).native_id, unsaved, "the session names its new thread");
    assert.deepEqual(queue().steps.map((s) => s.status), ["done", "done"]);
    assert.equal(queue().run?.retries, undefined, "no failed turn on the way");
  } finally { engine.shutdown(); next?.shutdown(); delete process.env.FAKE_TURN_START_MS; clean(); }
});

test("codex: a worker whose thread was saved (stopped in its first turn) resumes the same thread after the restart", async () => {
  const work = holdWork();
  const { store, engine, queue, until: wait } = setup(["slow", "done"], REAL_PROCESSES);
  recordStarts();
  let next: Engine | undefined;
  try {
    engine.start("Q", { runtime: "codex" });
    await wait("the step to run", () => queue().steps[0]!.status === "running", LONGER.step);
    const session = queue().run!.session;
    const thread = store.readSession(session).native_id!;
    engine.drainForUpdate(true);
    await wait("the process to exit", () => store.readRuntime(session)?.state === "exited");
    engine.shutdown();
    work.release();
    next = restart(store, REAL_PROCESSES);
    await wait("the run to finish", () => queue().run?.state === "finished", LONGER.run);
    assert.deepEqual(threadCalls(), [["thread/start"], ["thread/resume", thread]]);
    assert.equal(store.readSession(session).native_id, thread);
    assert.equal(queue().run?.retries, undefined);
    assert.ok(!store.readActivity(session).entries.some((a) => a.kind === "error"), "no error on the way");
  } finally { engine.shutdown(); next?.shutdown(); work.done(); clean(); }
});

test("codex: a session from before RN (its record as then written) resumes its saved thread", async () => {
  const { store, s: claudeSession } = hostSetup();
  const thread = randomUUID();
  saveFakeConversation(thread, "codex"); // the thread the earlier server's process saved
  const s: SessionFile = { ...claudeSession, runtime: "codex", native_id: thread };
  store.writeSession(s);
  store.writeRuntime(s.id, { state: "exited", turns: 0, updated_at: now() });
  const h = new AgentHost(store, ROLE_RECORDS.conversation);
  const replies: string[] = [];
  const launch = (): Launch => ({ runtime: "codex", options: { cwd: s.cwd, env: h.env(s.id), threadId: store.readSession(s.id).native_id, sandbox: "read-only", approvalPolicy: "never", writableRoots: [] } });
  const l = h.start(s, launch, {}, () => ({ message: (t) => replies.push(t) }));
  try {
    h.send(l, "hello");
    await until("the reply", () => replies.includes("ok"));
    assert.deepEqual(threadCalls(), [["thread/resume", thread]]);
    assert.equal(store.readSession(s.id).native_id, thread);
  } finally { h.shutdown(); clean(); }
});
