// A thinking partner's conversation across a restart (queue LCR: LC-F4, the rest of LC-F5, LC-F9), through the real
// Conversations and AgentHost paths with the fakes in this process. Each "server" is the engine, the orchestrator and
// the conversations made on a new store of the same files, as main.ts makes them (the engine's recovery first, then
// resumeCutOff). The fakes keep a minimal history per saved conversation and a receipt for each effect a turn completes
// (fake-behaviour.ts: openConversation, takenIn, "FAKE-EFFECT: <key>"), so a test counts what was processed, not only
// which id was started.
//
// - LC-F4: a partner's first turn an update cut off (cutOff, shutdown) goes on after the restart (resumeCutOff) once:
//   unsaved Claude and Codex, saved Claude whose record wrongly says unsaved, saved Codex, and a hand-over.
// - LC-F5: the runtime record a partner is started with (absent, legacy without the mark, false, true, truncated JSON, a
//   wrong-typed mark) behind a saved and an unsaved conversation: how it starts, that its id stays, what readRuntime
//   makes of a broken record (undefined, a warning, set aside as runtime.json.corrupt at the next write).
// - LC-F9: what a saved conversation held (a sentinel, an effect done) is there after a normal resume, a legacy record
//   and a false mark corrected to a resume, and the effect is not done again; an unsaved Codex thread's fallback holds
//   only the input that waited.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ProjectStore, type RuntimeFile, type SessionFile } from "@nexus/protocol";
import { RESTARTED } from "../src/chats.ts";
import { Conversations } from "../src/conversations.ts";
import { Engine } from "../src/engine.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import { fakeEffects, fakeHistory, fakeSaved, fakeStarts } from "./fake-behaviour.ts";
import { inProcessRuntime } from "./in-process-runtime.ts";
import { tempDir } from "./temp-dirs.ts";
import { QUICK_ENGINE, holds, until } from "./wait.ts";

/** A project in a temporary folder, the fakes recording their starts and what they read. */
function world() {
  const root = tempDir("nexus-partner-");
  process.env.NEXUS_HOME = join(root, "home");
  process.env.FAKE_LOG = join(root, "fake.log");
  process.env.FAKE_ARGS = join(root, "args.log");
  ProjectStore.init(root, { id: "p", name: "P", root });
  return root;
}

/** A server on the project's files: a new store, the engine (its recovery), the orchestrator, the conversations. */
function server(root: string) {
  const store = ProjectStore.forRoot(root);
  const spawn = inProcessRuntime();
  const engine = new Engine(store, () => {}, { spawn, ...QUICK_ENGINE });
  const orchestrator = new Orchestrator(store, engine, () => {}, {}, { spawn });
  const conversations = new Conversations(store, orchestrator, () => {}, { spawn });
  const shutdown = () => { conversations.shutdown(); orchestrator.shutdown(); engine.shutdown(); };
  return { store, engine, orchestrator, conversations, shutdown };
}
type Server = ReturnType<typeof server>;

/** What the fakes read (FAKE_LOG), with the session each was read in. */
function read(): { text: string; session: string | null }[] {
  const f = process.env.FAKE_LOG!;
  return existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { text: string; session: string | null }) : [];
}

const receipts = (key: string) => fakeEffects().filter((r) => r.key === key);
const chatOf = (x: Server, id: string) => x.conversations.view(id).chat;
const replies = (x: Server, id: string) => chatOf(x, id).filter((c) => c.from === "partner" && c.kind === "message");

function clean(servers: (Server | undefined)[]): void {
  for (const s of servers) s?.shutdown();
  delete process.env.FAKE_ARGS;
  delete process.env.FAKE_START_MS;
  delete process.env.FAKE_TURN_START_MS;
  delete process.env.FAKE_CHAT_SLOW_MS;
}

/** The update's side: cuts the partners' turns off, shuts down, waits for the partner's process to exit. */
async function update(x: Server, id: string): Promise<void> {
  x.conversations.cutOff();
  x.shutdown();
  await until("the partner's process to exit", () => x.store.readRuntime(id)?.state === "exited");
}

// ---------------------------------------------------------------- LC-F4: a cut-off first turn after the restart

/** A uniquely tagged question: its effect is counted by receipt, and its reply lists what the partner holds. */
const question = (key: string) => `Q-LCR6 ${key}: what should we plan first? FAKE-EFFECT: ${key} FAKE-HISTORY`;

/** After the restart: one RESTARTED line, the cut-off mark cleared, one partner in the project. */
function afterRestart(x: Server, c: SessionFile): void {
  assert.equal(chatOf(x, c.id).filter((e) => e.text === RESTARTED).length, 1, "one restart line");
  assert.equal(x.store.readRuntime(c.id)?.interrupted, undefined, "the cut-off mark cleared");
  assert.deepEqual(x.conversations.list().map((s) => s.id), [c.id], "the same conversation, no other");
  assert.ok(!chatOf(x, c.id).some((e) => e.kind === "error"), "no error");
}

for (const runtime of ["claude", "codex"] as const) {
  test(`${runtime} partner, unsaved first turn cut off by an update: after the restart the question reaches ${runtime === "claude" ? "a fresh start of the same session" : "a new thread (the old one has no rollout)"} once, with nothing before it, and is answered in the same conversation`, async () => {
    const root = world();
    let first: Server | undefined, next: Server | undefined;
    try {
      // Its process never takes the question in: Claude never reads, Codex never starts the turn (the thread unsaved).
      if (runtime === "claude") process.env.FAKE_START_MS = "60000"; else process.env.FAKE_TURN_START_MS = "60000";
      first = server(root);
      const c = first.conversations.create({ title: "Plans", runtime });
      const key = `unsaved-${runtime}`;
      first.conversations.say(c.id, question(key));
      await until("the process to start", () => runtime === "claude" ? fakeStarts().length === 1 : !!first!.store.readSession(c.id).native_id);
      const old = first.store.readSession(c.id).native_id!;
      await update(first, c.id);
      assert.deepEqual(first.store.readRuntime(c.id)?.interrupted?.asked, [question(key)], "the record keeps the question");
      assert.equal(fakeSaved(old, runtime), false);
      delete process.env.FAKE_START_MS;
      delete process.env.FAKE_TURN_START_MS;
      next = server(root);
      next.conversations.resumeCutOff();
      const n = next;
      await until("the answer", () => replies(n, c.id).length === 1);
      afterRestart(n, c);
      const native = n.store.readSession(c.id).native_id!;
      if (runtime === "claude") {
        assert.equal(native, old);
        assert.deepEqual(fakeStarts(), [["--session-id", old], ["--session-id", old]], "afresh, the same id");
      } else {
        assert.notEqual(native, old, "the session names the new thread");
        assert.deepEqual(fakeStarts(), [["thread/start"], ["thread/resume", old], ["thread/start"]]);
      }
      assert.equal(read().filter((m) => m.text.includes(key)).length, 1, "the question read once");
      assert.equal(receipts(key).length, 1, "processed once");
      // The new conversation holds the restart's notice quoting the question, nothing invented before it.
      const held = fakeHistory(native, runtime);
      assert.equal(held.length, 1);
      assert.match(held[0]!, /^\[Nexus\] The server restarted while you were answering this message:\n> Q-LCR6/);
      assert.equal(replies(n, c.id)[0]!.text, `history: ${held[0]}`);
      await holds("nothing more", () => replies(n, c.id).length === 1 && receipts(key).length === 1, 300);
    } finally { clean([first, next]); }
  });
}

test("claude partner, saved first turn cut off by an update, its record wrongly saying unsaved: the fresh start is refused and corrected to a resume; the question is answered once more with the conversation's history", async () => {
  const root = world();
  let first: Server | undefined, next: Server | undefined;
  try {
    process.env.FAKE_CHAT_SLOW_MS = "60000";
    first = server(root);
    const f = first;
    const c = f.conversations.create({ title: "Plans", runtime: "claude" });
    const key = "saved-false-claude";
    f.conversations.say(c.id, `FAKE-SLOW ${question(key)}`);
    await until("the turn at work", () => chatOf(f, c.id).some((e) => e.kind === "tool"));
    const native = f.store.readSession(c.id).native_id!;
    assert.equal(fakeSaved(native, "claude"), true);
    await update(f, c.id);
    assert.equal(receipts(key).length, 0, "the cut-off turn completed nothing");
    f.store.writeRuntime(c.id, { ...f.store.readRuntime(c.id)!, conversation_saved: false });
    process.env.FAKE_CHAT_SLOW_MS = "1";
    next = server(root);
    next.conversations.resumeCutOff();
    const n = next;
    await until("the answer", () => replies(n, c.id).length === 1);
    afterRestart(n, c);
    assert.deepEqual(fakeStarts(), [["--session-id", native], ["--session-id", native], ["--resume", native]]);
    assert.equal(n.store.readSession(c.id).native_id, native);
    assert.equal(n.store.readRuntime(c.id)?.conversation_saved, true);
    // Read before the cut and once in the restart's notice; completed once.
    assert.equal(read().filter((m) => m.text.includes(key)).length, 2);
    assert.equal(receipts(key).length, 1);
    const held = fakeHistory(native, "claude");
    assert.equal(held.length, 2, "the question before the cut, the notice after it");
    assert.match(held[0]!, /^FAKE-SLOW Q-LCR6 saved-false-claude/);
    assert.match(held[1]!, /^\[Nexus\] The server restarted/);
  } finally { clean([first, next]); }
});

test("codex partner, saved first turn cut off by an update: the same thread is resumed and the question is answered once more, with the thread's history", async () => {
  const root = world();
  let first: Server | undefined, next: Server | undefined;
  try {
    process.env.FAKE_CHAT_SLOW_MS = "60000";
    first = server(root);
    const f = first;
    const c = f.conversations.create({ title: "Plans", runtime: "codex" });
    const key = "saved-codex";
    f.conversations.say(c.id, `FAKE-SLOW ${question(key)}`);
    await until("the turn at work", () => chatOf(f, c.id).some((e) => e.kind === "tool"));
    const thread = f.store.readSession(c.id).native_id!;
    assert.equal(fakeSaved(thread, "codex"), true);
    await update(f, c.id);
    assert.equal(receipts(key).length, 0);
    process.env.FAKE_CHAT_SLOW_MS = "1";
    next = server(root);
    next.conversations.resumeCutOff();
    const n = next;
    await until("the answer", () => replies(n, c.id).length === 1);
    afterRestart(n, c);
    assert.deepEqual(fakeStarts(), [["thread/start"], ["thread/resume", thread]]);
    assert.equal(n.store.readSession(c.id).native_id, thread);
    assert.equal(read().filter((m) => m.text.includes(key)).length, 2, "before the cut and in the notice");
    assert.equal(receipts(key).length, 1);
    const held = fakeHistory(thread, "codex");
    assert.equal(held.length, 2);
    assert.match(held[1]!, /^\[Nexus\] The server restarted/);
  } finally { clean([first, next]); }
});

test("claude partner, a hand-over its unsaved process never read, cut off by an update: after the restart the hand-over's turn runs once and its summary reaches the orchestrator's chat once", async () => {
  const root = world();
  let first: Server | undefined, next: Server | undefined;
  try {
    process.env.FAKE_START_MS = "60000";
    first = server(root);
    const c = first.conversations.create({ title: "Plans", runtime: "claude" });
    first.conversations.handoff(c.id);
    await until("the process to start", () => fakeStarts().length === 1);
    await update(first, c.id);
    assert.equal(first.store.readRuntime(c.id)?.interrupted?.handoff, true, "the record keeps that it was the hand-over");
    delete process.env.FAKE_START_MS;
    next = server(root);
    next.conversations.resumeCutOff();
    const n = next;
    const handed = () => chatOf(n, c.id).filter((e) => e.text === "The summary went to the orchestrator's chat.");
    await until("the summary handed over", () => handed().length === 1);
    afterRestart(n, c);
    const native = n.store.readSession(c.id).native_id!;
    assert.deepEqual(fakeStarts().slice(0, 2), [["--session-id", native], ["--session-id", native]]);
    assert.equal(read().filter((m) => m.session === c.id && m.text.includes("hands this conversation to the orchestrator")).length, 1, "the instruction read once");
    const orch = n.store.readProject().orchestrator!.session!;
    await until("the orchestrator's reply", () => n.orchestrator.view().chat.some((e) => e.from === "orchestrator" && e.text === "ok"));
    const told = n.store.readChat(orch).entries.filter((e) => e.from === "user" && e.text.startsWith('[From the conversation "Plans"]'));
    assert.equal(told.length, 1, "the summary once in the orchestrator's chat");
    assert.match(told[0]!.text, /SUMMARY/);
    await holds("nothing more", () => handed().length === 1 && n.store.readChat(orch).entries.filter((e) => e.text.startsWith("[From the conversation")).length === 1, 300);
  } finally { clean([first, next]); }
});

// ---------------------------------------------------------------- LC-F5 and LC-F9: the record a partner starts with

type Variant = "absent" | "legacy" | "false" | "true" | "truncated" | "wrong-type";
const VARIANTS: Variant[] = ["absent", "legacy", "false", "true", "truncated", "wrong-type"];

/** Writes the session's runtime.json as `v` (absent: removed). Returns the broken text it wrote, if any. */
function recordAs(store: ProjectStore, id: string, v: Variant): string | undefined {
  const file = join(store.sessionDir(id), "runtime.json");
  const base: RuntimeFile = { state: "exited", turns: 0, updated_at: new Date().toISOString() };
  if (v === "absent") { rmSync(file, { force: true }); return undefined; }
  if (v === "legacy") { store.writeRuntime(id, base); return undefined; }
  if (v === "false" || v === "true") { store.writeRuntime(id, { ...base, conversation_saved: v === "true" }); return undefined; }
  const text = v === "truncated" ? '{"state":"exited","turns":0,"conversation_sa' : JSON.stringify({ ...base, conversation_saved: "yes" });
  writeFileSync(file, text);
  return text;
}

/** How a Claude start goes from each record: [flags] after the server's restart, behind a saved or an unsaved conversation. */
const EXPECTED: Record<Variant, { saved: string[]; unsaved: string[] }> = {
  // readRuntime gives undefined: the session starts afresh (AgentHost.start), corrected when the runtime saved it.
  absent: { saved: ["--session-id", "--resume"], unsaved: ["--session-id"] },
  // No mark (written before queue RN): taken as saved, corrected when it was not.
  legacy: { saved: ["--resume"], unsaved: ["--resume", "--session-id"] },
  false: { saved: ["--session-id", "--resume"], unsaved: ["--session-id"] },
  true: { saved: ["--resume"], unsaved: ["--resume", "--session-id"] },
  truncated: { saved: ["--session-id", "--resume"], unsaved: ["--session-id"] },
  "wrong-type": { saved: ["--session-id", "--resume"], unsaved: ["--session-id"] },
};

for (const saved of [true, false]) {
  for (const v of VARIANTS) {
    test(`claude partner, ${saved ? "saved" : "unsaved"} conversation, record ${v}: ${EXPECTED[v][saved ? "saved" : "unsaved"].join(" then ")}; the same id${saved ? ", its sentinel kept and its effect not done again" : ", nothing before the new message"}${v === "truncated" || v === "wrong-type" ? "; the broken record is read as none, with a warning, and set aside" : ""}`, async () => {
      const root = world();
      let first: Server | undefined, next: Server | undefined;
      const warned: string[] = [];
      const warn = console.warn;
      try {
        first = server(root);
        const f = first;
        const c = f.conversations.create({ title: "Record", runtime: "claude" });
        const native = f.store.readSession(c.id).native_id!;
        const effect = `once-${v}`;
        if (saved) {
          // A first turn that saved the conversation, kept a sentinel and completed an effect.
          f.conversations.say(c.id, `SENTINEL-${v} remember this. FAKE-EFFECT: ${effect}`);
          await until("the first answer", () => replies(f, c.id).length === 1);
          assert.equal(receipts(effect).length, 1);
          f.shutdown();
          await until("the process to exit", () => f.store.readRuntime(c.id)?.state === "exited");
        } else f.shutdown(); // never started: nothing saved
        const before = fakeStarts().length;
        const broken = recordAs(f.store, c.id, v);
        console.warn = (...a: unknown[]) => { warned.push(a.join(" ")); };
        next = server(root);
        const n = next;
        n.conversations.say(c.id, "go on: FAKE-HISTORY");
        await until("the answer", () => replies(n, c.id).some((r) => r.text.startsWith("history:")));
        console.warn = warn;
        assert.deepEqual(fakeStarts().slice(before).map((x) => x[0]), EXPECTED[v][saved ? "saved" : "unsaved"]);
        assert.ok(fakeStarts().slice(before).every((x) => x[1] === native), "every start names the session's id");
        assert.equal(n.store.readSession(c.id).native_id, native, "the id kept");
        // A legacy record resumed as it was taken (saved) gets no mark: the runtime said nothing new. Every other ends saying saved.
        assert.equal(n.store.readRuntime(c.id)?.conversation_saved, saved && v === "legacy" ? undefined : true, "the record's mark now");
        const reply = replies(n, c.id).find((r) => r.text.startsWith("history:"))!.text;
        if (saved) {
          assert.equal(reply, `history: SENTINEL-${v} remember this. FAKE-EFFECT: ${effect} | go on: FAKE-HISTORY`, "the conversation's history, then the new message");
          assert.equal(receipts(effect).length, 1, "the effect not done again");
        } else assert.equal(reply, "history: go on: FAKE-HISTORY", "a new conversation: nothing invented before it");
        assert.ok(!chatOf(n, c.id).some((e) => e.kind === "error"), "no error in the chat");
        const corrupt = join(n.store.sessionDir(c.id), "runtime.json.corrupt");
        if (broken !== undefined) {
          assert.ok(warned.some((w) => w.includes("runtime.json") && w.includes("going on as if it were missing")), `a warning names the file: ${warned.join(" / ")}`);
          assert.equal(readFileSync(corrupt, "utf8"), broken, "set aside as it was, at the next write");
        } else {
          assert.ok(!existsSync(corrupt));
          assert.ok(!warned.some((w) => w.includes("runtime.json")));
        }
      } finally { console.warn = warn; clean([first, next]); }
    });
  }
}

test("codex partner, saved thread, a truncated record: the record plays no part in Codex's start; the same thread is resumed with its history, and the broken record is set aside", async () => {
  const root = world();
  let first: Server | undefined, next: Server | undefined;
  const warn = console.warn;
  try {
    first = server(root);
    const f = first;
    const c = f.conversations.create({ title: "Record", runtime: "codex" });
    f.conversations.say(c.id, "SENTINEL-codex remember this. FAKE-EFFECT: once-codex");
    await until("the first answer", () => replies(f, c.id).length === 1);
    const thread = f.store.readSession(c.id).native_id!;
    f.shutdown();
    await until("the process to exit", () => f.store.readRuntime(c.id)?.state === "exited");
    const broken = recordAs(f.store, c.id, "truncated")!;
    console.warn = () => {};
    next = server(root);
    const n = next;
    n.conversations.say(c.id, "go on: FAKE-HISTORY");
    await until("the answer", () => replies(n, c.id).some((r) => r.text.startsWith("history:")));
    console.warn = warn;
    assert.deepEqual(fakeStarts(), [["thread/start"], ["thread/resume", thread]]);
    assert.equal(n.store.readSession(c.id).native_id, thread);
    assert.equal(replies(n, c.id).find((r) => r.text.startsWith("history:"))!.text, "history: SENTINEL-codex remember this. FAKE-EFFECT: once-codex | go on: FAKE-HISTORY");
    assert.equal(receipts("once-codex").length, 1);
    assert.equal(readFileSync(join(n.store.sessionDir(c.id), "runtime.json.corrupt"), "utf8"), broken);
  } finally { console.warn = warn; clean([first, next]); }
});
