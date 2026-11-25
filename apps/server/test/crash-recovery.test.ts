// Recovery after a server that died without a word (queue LCR, LC-F3). A server process of the test's own
// (crash-server.ts) runs the engine or the orchestrator until a fake is held at a start-up checkpoint, and is killed
// there by its handle: no drain, no cut-off, no shutdown. The next server is built in the test on a new store of the
// same files, reading only what the dead one left on disk (through the model, as every read). Today's contract
// (engine.ts, recoverAfterRestart; docs/design/updates.md): after a plain restart a running worker's run is paused ("the
// Nexus server restarted; resume to continue"), only a run an update held (resume_after_restart) goes on by itself; a
// chat turn goes on only from the mark an update's cut-off left (resumeCutOff). After the user's Resume each case is
// compared with the same queue run without a crash: the steps, how often each opened, the turns.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ProjectStore, loadProjectState, readTurns } from "@nexus/protocol";
import type { Engine } from "../src/engine.ts";
import { RESTARTED } from "../src/chats.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import { crashAt, endCrashServers } from "./crash-server.ts";
import { fakeSaved, fakeStarts } from "./fake-behaviour.ts";
import { restart, setup } from "./engine-setup.ts";
import { inProcessRuntime } from "./in-process-runtime.ts";
import { tempDir } from "./temp-dirs.ts";
import { LONGER, holds, until } from "./wait.ts";

const PLAIN_RESTART = "the Nexus server restarted; resume to continue";

after(async () => { assert.equal(await endCrashServers(), 0, "every server the tests started was ended by its test"); });

/** A two-step queue Q in a temporary project, its fake recording its starts; nothing started. */
function project(behaviours = ["done", "done"]) {
  const x = setup(behaviours);
  x.engine.shutdown(); // the setup's engine is not the server under test: it starts nothing
  process.env.FAKE_ARGS = join(dirname(process.env.FAKE_LOG!), "args.log");
  return x;
}

/** What a run leaves that a crash and its recovery must not change: the steps, how often each opened, the turns. */
function outcome(store: ProjectStore, session: string) {
  const q = loadProjectState(store).queues.find((x) => x.id === "Q")!;
  const received = existsSync(process.env.FAKE_LOG!) ? readFileSync(process.env.FAKE_LOG!, "utf8").trim().split("\n").map((l) => (JSON.parse(l) as { text: string }).text) : [];
  const turns = readTurns(store.env).entries.filter((t) => t.session === session);
  return {
    run: q.run?.state,
    retries: q.run?.retries,
    steps: q.steps.map((s) => `${s.id}=${s.status}`),
    opened: q.steps.map((s) => received.filter((t) => t.includes(`step ${s.id} (`)).length),
    received: received.length,
    recordTurns: store.readRuntime(session)?.turns,
    turns: turns.map((t) => t.outcome),
  };
}

const controls = new Map<string, ReturnType<typeof outcome>>();
/**
 * The same queue run without a crash, once per runtime: what every recovery is compared with. It makes a project of its
 * own (NEXUS_HOME, FAKE_LOG): a test asks for it before its own project().
 */
async function control(runtime: "claude" | "codex") {
  const known = controls.get(runtime);
  if (known) return known;
  const x = setup(["done", "done"]);
  try {
    x.engine.start("Q", { runtime });
    await x.until("the control run to finish", () => x.queue().run?.state === "finished", LONGER.run);
    const o = outcome(x.store, x.queue().run!.session);
    assert.deepEqual([o.steps, o.opened, o.recordTurns, o.turns], [["Q1=done", "Q2=done"], [1, 1], 2, ["ok", "ok"]], "the control itself");
    controls.set(runtime, o);
    return o;
  } finally { x.engine.shutdown(); }
}

/** The next server on the dead one's files: a new store, a new engine; asserts today's plain-restart pause. */
async function nextServer(root: string, session: string) {
  const store = ProjectStore.forRoot(root);
  const next = restart(store);
  const run = () => loadProjectState(store).queues.find((q) => q.id === "Q")!.run;
  assert.equal(run()?.state, "paused", "a plain restart pauses the run");
  assert.equal(run()?.reason, PLAIN_RESTART);
  assert.equal(run()?.resume_after_restart, undefined);
  assert.equal(store.readRuntime(session)?.state, "exited", "the dead server's process is recorded gone");
  assert.equal(store.readRuntime(session)?.pid, undefined, "it had no process id the next server could end");
  return { store, next, run };
}

function clean(engines: (Engine | undefined)[]): void {
  for (const e of engines) e?.shutdown();
  delete process.env.FAKE_ARGS;
  delete process.env.FAKE_START_MS;
  delete process.env.FAKE_TURN_START_MS;
}

// ---------------------------------------------------------------- one crash at a start-up checkpoint

test("claude worker: the server dies as the process starts, before its first read: the next server pauses the run; Resume starts afresh in the same session once, and the steps run as without the crash", async () => {
  const base = await control("claude");
  const x = project();
  let next: Engine | undefined;
  try {
    const root = dirname(x.store.dir);
    const { held, pid, exit } = await crashAt({ root, does: "start", runtime: "claude", point: "first-read" }, () => {
      const session = x.queue().run!.session;
      assert.equal(x.store.readRuntime(session)?.conversation_saved, false);
      assert.equal(x.store.readRuntime(session)?.state, "idle");
    });
    assert.equal(held.process, 1);
    assert.deepEqual(exit, { code: null, signal: "SIGTERM" }, "killed where it stood, no exit of its own");
    assert.ok(pid > 0 && pid !== process.pid);
    const session = x.queue().run!.session;
    const native = x.store.readSession(session).native_id!;
    assert.equal(fakeSaved(native, "claude"), false, "nothing saved");
    const n = await nextServer(root, session);
    next = n.next;
    await holds("paused, no start", () => n.run()?.state === "paused" && fakeStarts().length === 1, 300);
    next.resume("Q");
    await until("the run to finish", () => n.run()?.state === "finished", LONGER.run);
    assert.deepEqual(fakeStarts(), [["--session-id", native], ["--session-id", native]], "the same session, afresh");
    assert.equal(n.store.readSession(session).native_id, native);
    assert.deepEqual(outcome(n.store, session), base);
  } finally { clean([next]); }
});

test("claude worker: the server dies after the conversation was saved, before the first output: Resume's fresh start is refused once and corrected to a resume of it, and the steps run as without the crash", async () => {
  const base = await control("claude");
  const x = project();
  let next: Engine | undefined;
  try {
    const root = dirname(x.store.dir);
    await crashAt({ root, does: "start", runtime: "claude", point: "save" }, () => {
      const session = x.queue().run!.session;
      assert.equal(fakeSaved(x.store.readSession(session).native_id!, "claude"), true, "the runtime saved it");
      assert.equal(x.store.readRuntime(session)?.conversation_saved, false, "Nexus never heard so");
    });
    const session = x.queue().run!.session;
    const native = x.store.readSession(session).native_id!;
    assert.equal(x.received().length, 0, "the step's message was not taken in");
    const n = await nextServer(root, session);
    next = n.next;
    assert.equal(n.store.readRuntime(session)?.conversation_saved, false, "the mark the dead server left");
    next.resume("Q");
    await until("the run to finish", () => n.run()?.state === "finished", LONGER.run);
    assert.deepEqual(fakeStarts(), [["--session-id", native], ["--session-id", native], ["--resume", native]]);
    assert.equal(n.store.readRuntime(session)?.conversation_saved, true);
    assert.deepEqual(outcome(n.store, session), base);
  } finally { clean([next]); }
});

test("codex worker: the server dies after the new thread's id was kept, before its first turn: Resume's resume finds no rollout and goes on in one new thread, and the steps run as without the crash", async () => {
  const base = await control("codex");
  const x = project();
  let next: Engine | undefined;
  try {
    const root = dirname(x.store.dir);
    await crashAt({ root, does: "start", runtime: "codex", point: "answer:turn/start" }, () => {
      const session = x.queue().run!.session;
      const thread = x.store.readSession(session).native_id;
      assert.ok(thread, "the thread's id kept before the turn");
      assert.equal(fakeSaved(thread, "codex"), false, "its rollout not written");
    });
    const session = x.queue().run!.session;
    const first = x.store.readSession(session).native_id!;
    assert.deepEqual(fakeStarts(), [["thread/start"]]);
    const n = await nextServer(root, session);
    next = n.next;
    await holds("paused, no start", () => n.run()?.state === "paused" && fakeStarts().length === 1, 300);
    next.resume("Q");
    await until("the run to finish", () => n.run()?.state === "finished", LONGER.run);
    assert.deepEqual(fakeStarts(), [["thread/start"], ["thread/resume", first], ["thread/start"]]);
    const second = n.store.readSession(session).native_id!;
    assert.notEqual(second, first, "the session names the new thread");
    assert.equal(fakeSaved(second, "codex"), true);
    assert.deepEqual(outcome(n.store, session), base);
  } finally { clean([next]); }
});

// ---------------------------------------------------------------- an update's restart, then a crash during its correction

/**
 * A worker run an update held (drainForUpdate, then an orderly shutdown) before its process read anything: the run marked
 * to go on by itself (resume_after_restart). Claude: its record then says saved though nothing was (as LCR4's
 * correcting()), so the next server's resume is refused and corrected. Codex: its thread was started, its first turn
 * never, so the next server's thread/resume finds no rollout and starts a new thread.
 */
async function heldForUpdate(runtime: "claude" | "codex") {
  const x = setup(["done", "done"]);
  process.env.FAKE_ARGS = join(dirname(process.env.FAKE_LOG!), "args.log");
  if (runtime === "claude") process.env.FAKE_START_MS = "60000"; else process.env.FAKE_TURN_START_MS = "60000";
  x.engine.start("Q", { runtime });
  const session = x.queue().run!.session;
  await x.until("the first start", () => fakeStarts().length === 1 && (runtime === "claude" || !!x.store.readSession(session).native_id));
  x.engine.drainForUpdate(true);
  await x.until("the process to exit", () => x.store.readRuntime(session)?.state === "exited");
  x.engine.shutdown();
  delete process.env.FAKE_START_MS;
  delete process.env.FAKE_TURN_START_MS;
  if (runtime === "claude") x.store.writeRuntime(session, { ...x.store.readRuntime(session)!, conversation_saved: true });
  assert.equal(x.queue().run?.resume_after_restart, true, "held for the update");
  return { ...x, session, root: dirname(x.store.dir), first: x.store.readSession(session).native_id! };
}

test("claude worker, twice interrupted: the update's restart corrects its wrong mark and the server dies after the corrected mark, before the replacement's output; the next server pauses, and Resume corrects once more and runs the steps as without the crashes", async () => {
  const base = await control("claude");
  let next: Engine | undefined;
  try {
    const x = await heldForUpdate("claude");
    const native = x.first;
    // The dying server resumes the held run by itself: --resume refused (nothing saved), corrected to a fresh start,
    // which takes the step's message in (and saves the conversation) and is held before it answers.
    const { held } = await crashAt({ root: x.root, does: "restart", point: "save", process: 2 }, () => {
      assert.equal(x.store.readRuntime(x.session)?.conversation_saved, false, "the corrected mark is on disk");
      assert.equal(fakeSaved(native, "claude"), true, "the replacement saved the conversation");
      assert.equal(x.queue().run?.resume_after_restart, undefined, "the held run was taken up");
    });
    assert.equal(held.process, 2, "the replacement, not the refused start");
    // The correction's "retry" activity began the step's turn (AgentHost: the first thing streamed after the last turn),
    // so the dead server left it open in the record (queue CK); the next server records it as interrupted.
    assert.deepEqual(x.store.readRuntime(x.session)?.turn_open, { started_at: x.store.readRuntime(x.session)!.turn_open!.started_at, queue: "Q", step: "Q1" });
    assert.deepEqual(fakeStarts(), [["--session-id", native], ["--resume", native], ["--session-id", native]]);
    assert.equal(x.received().length, 0, "nothing was taken in as read");
    const n = await nextServer(x.root, x.session);
    next = n.next;
    await holds("paused, no start", () => n.run()?.state === "paused" && fakeStarts().length === 3, 300);
    next.resume("Q");
    await until("the run to finish", () => n.run()?.state === "finished", LONGER.run);
    // The mark says unsaved, the runtime saved it: refused once, corrected to a resume.
    assert.deepEqual(fakeStarts().slice(3), [["--session-id", native], ["--resume", native]]);
    assert.equal(n.store.readSession(x.session).native_id, native);
    assert.equal(n.store.readRuntime(x.session)?.conversation_saved, true);
    // As without the crashes, but for the turn the crash cut off: recorded once, as interrupted, by the next server.
    assert.deepEqual(outcome(n.store, x.session), { ...base, turns: ["interrupted", ...base.turns] });
  } finally { clean([next]); }
});

for (const when of ["before", "after"] as const) {
  test(`codex worker, twice interrupted: the update's restart finds no rollout and the server dies ${when} the new thread's id is kept; the next server pauses, and Resume goes on in one more new thread and runs the steps as without the crashes`, async () => {
    const base = await control("codex");
    let next: Engine | undefined;
    try {
      const x = await heldForUpdate("codex");
      const first = x.first;
      assert.equal(fakeSaved(first, "codex"), false);
      // before: held as the fake takes the new thread's start (its answer not given); after: held at its first turn.
      assert.deepEqual(readTurns(x.store.env).entries, [], "the update's orderly drain recorded no turn");
      await crashAt({ root: x.root, does: "restart", point: when === "before" ? "answer:thread/start" : "answer:turn/start" }, () => {
        assert.equal(x.queue().run?.resume_after_restart, undefined, "the held run was taken up");
        // The fallback's "retry" activity ("started a new thread") began the step's turn: left open in the record.
        assert.equal(x.store.readRuntime(x.session)?.turn_open?.step, "Q1");
        assert.ok(x.store.readActivity(x.session).entries.some((a) => a.kind === "retry" && a.text.includes(`no saved thread ${first}`)));
      });
      const kept = x.store.readSession(x.session).native_id!;
      if (when === "before") {
        assert.equal(kept, first, "the old id stays until the new thread's start is answered");
        assert.deepEqual(fakeStarts(), [["thread/start"], ["thread/resume", first]]);
      } else {
        assert.notEqual(kept, first, "the new thread's id kept before its turn");
        assert.equal(fakeSaved(kept, "codex"), false, "its rollout not written");
        assert.deepEqual(fakeStarts(), [["thread/start"], ["thread/resume", first], ["thread/start"]]);
      }
      const before = fakeStarts().length;
      const n = await nextServer(x.root, x.session);
      next = n.next;
      await holds("paused, no start", () => n.run()?.state === "paused" && fakeStarts().length === before, 300);
      next.resume("Q");
      await until("the run to finish", () => n.run()?.state === "finished", LONGER.run);
      assert.deepEqual(fakeStarts().slice(before), [["thread/resume", kept], ["thread/start"]], "the kept id resumed, no rollout, one new thread");
      const last = n.store.readSession(x.session).native_id!;
      assert.ok(last !== first && last !== kept);
      assert.equal(fakeSaved(last, "codex"), true);
      // As without the crashes, but for the turn the crash cut off: recorded once, as interrupted, by the next server.
      assert.deepEqual(outcome(n.store, x.session), { ...base, turns: ["interrupted", ...base.turns] });
    } finally { clean([next]); }
  });
}

// ---------------------------------------------------------------- the orchestrator's chat

/**
 * An orchestrator whose first message an update cut off before its process read it (as conversation-saved.test.ts's
 * "the orchestrator: a message its process had not read when the server stopped reaches the fresh process"): the
 * session's record keeps the message (`interrupted`) for the next server.
 */
async function cutOffUnread(text: string) {
  const root = tempDir("nexus-crash-chat-");
  process.env.NEXUS_HOME = join(root, "home");
  process.env.FAKE_LOG = join(root, "fake.log");
  process.env.FAKE_ARGS = join(root, "args.log");
  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  const engine = { draining: false, onChange() {}, shutdown() {} } as unknown as Engine;
  const orchestrator = (s: ProjectStore) => new Orchestrator(s, engine, () => {}, {}, { spawn: inProcessRuntime() });
  process.env.FAKE_START_MS = "60000"; // the process never reads the message
  const first = orchestrator(store);
  first.say(text);
  await until("the process to start", () => fakeStarts().length === 1);
  first.cutOff();
  first.shutdown();
  const session = store.readProject().orchestrator!.session!;
  await until("the process to exit", () => store.readRuntime(session)?.state === "exited");
  delete process.env.FAKE_START_MS;
  assert.deepEqual(store.readRuntime(session)?.interrupted?.asked, [text]);
  const received = () => existsSync(process.env.FAKE_LOG!) ? readFileSync(process.env.FAKE_LOG!, "utf8").trim().split("\n").map((l) => (JSON.parse(l) as { text: string }).text) : [];
  return { root, store, session, orchestrator, received, native: store.readSession(session).native_id! };
}

test("the orchestrator, control: the message an update cut off before it was read reaches the next server's fresh process once and is answered", async () => {
  const x = await cutOffUnread("PLAN-LCR5: plan the layout");
  const next = x.orchestrator(ProjectStore.forRoot(x.root));
  try {
    next.resumeCutOff();
    await until("the reply", () => next.view().chat.some((c) => c.from === "orchestrator" && c.text === "ok"));
    assert.equal(x.received().filter((t) => t.includes("PLAN-LCR5")).length, 1);
    assert.deepEqual(fakeStarts(), [["--session-id", x.native], ["--session-id", x.native]]);
    assert.equal(x.store.readRuntime(x.session)?.interrupted, undefined);
  } finally { next.shutdown(); clean([]); }
});

test("the orchestrator, twice interrupted: the next server takes up the cut-off message and dies before its fresh process reads it; the server after it does not send it again (a plain crash replays no chat turn): the message stays in the chat, no error, and the user's next message is answered in the same session", async () => {
  const x = await cutOffUnread("PLAN-LCR5: plan the layout");
  let engine: Engine | undefined;
  let next: Orchestrator | undefined;
  try {
    await crashAt({ root: x.root, does: "chat", point: "first-read" }, () => {
      assert.equal(x.store.readRuntime(x.session)?.interrupted, undefined, "the cut-off mark was taken up");
      const chat = x.store.readChat(x.session).entries;
      assert.deepEqual(chat.map((c) => [c.from, c.text]), [["user", "PLAN-LCR5: plan the layout"], ["nexus", RESTARTED]]);
    });
    assert.deepEqual(fakeStarts(), [["--session-id", x.native], ["--session-id", x.native]]);
    assert.deepEqual(x.received(), [], "no process read the message");
    // The next server, as main.ts starts one: the engine's recovery, then the chats' resumeCutOff.
    const store = ProjectStore.forRoot(x.root);
    engine = restart(store);
    assert.equal(store.readRuntime(x.session)?.state, "exited");
    next = x.orchestrator(store);
    next.resumeCutOff();
    const o = next;
    await holds("no start, nothing sent again", () => fakeStarts().length === 2 && x.received().length === 0 && !o.alive(), 300);
    const chat = () => o.view().chat;
    assert.deepEqual(chat().filter((c) => c.from === "user").map((c) => c.text), ["PLAN-LCR5: plan the layout"], "the message stays in the chat");
    assert.equal(chat().filter((c) => c.text === RESTARTED).length, 1, "one restart line, the cut-off's");
    assert.ok(!chat().some((c) => c.from === "orchestrator" || c.kind === "error"), "no reply, no error");
    assert.ok(!readTurns(store.env).entries.some((t) => t.session === x.session), "no turn began, none recorded");
    // The user asks again: the same session, afresh (nothing was saved), answered once.
    o.say("PLAN-LCR5 again: plan the layout");
    await until("the reply", () => chat().some((c) => c.from === "orchestrator" && c.text === "ok"));
    assert.deepEqual(fakeStarts(), [["--session-id", x.native], ["--session-id", x.native], ["--session-id", x.native]]);
    assert.deepEqual(x.received().filter((t) => t.includes("PLAN-LCR5")).length, 1);
    assert.equal(store.readSession(x.session).native_id, x.native);
  } finally { next?.shutdown(); clean([engine]); }
});
