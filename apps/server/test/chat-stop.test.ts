// The stop button against the fake runtimes, for each chat agent there is: the orchestrator (Claude Code; it runs on
// no other runtime) and a thinking partner on Claude Code and on Codex. Decided 2026-11-14 (queue CH4): the stop is a
// pure interrupt (Claude's interrupt control, Codex's turn/interrupt), not a message asking to stop; no text from the
// stopped turn is added after it, the chat shows "stopped", the process goes idle, and user messages sent during the
// turn and not yet delivered go in with the next turn. The fakes interrupt as the runtimes were probed to (fake-claude.ts,
// fake-codex.ts): Claude Code still writes a partial text and runs its unread messages as a turn of their own; Codex
// drops a steered message it had not taken in.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ActionError, ProjectStore, readTurns, type ChatEntry } from "@nexus/protocol";
import { Engine } from "../src/engine.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import { Conversations } from "../src/conversations.ts";
import { STOPPED } from "../src/chats.ts";
import { PARTIAL } from "./fake-behaviour.ts";

const here = dirname(fileURLToPath(import.meta.url));
process.env.NEXUS_CLAUDE = join(here, "fake-claude.ts");
process.env.NEXUS_CODEX = join(here, "fake-codex.ts");
process.env.FAKE_CHAT_SLOW_MS = "8000";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A chat with its agent, whichever role: what the test does with it. */
interface Chat { say(text: string): void; stop(): void; view(): { state: string; chat: ChatEntry[] } }

function setup() {
  const root = mkdtempSync(join(tmpdir(), "nexus-stop-"));
  process.env.NEXUS_HOME = join(root, "home");
  process.env.FAKE_LOG = join(root, "fake.log");
  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  const engine = new Engine(store, () => {});
  const orchestrator = new Orchestrator(store, engine, () => {});
  const conversations = new Conversations(store, orchestrator, () => {});
  const log = () => (existsSync(process.env.FAKE_LOG!) ? readFileSync(process.env.FAKE_LOG!, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { text: string; priority: string | null; busy: boolean }) : []);
  const until = async (what: string, pred: () => boolean, ms = 20_000) => {
    const t = Date.now();
    while (!pred()) { if (Date.now() - t > ms) assert.fail(`timed out waiting for ${what}; fake log: ${JSON.stringify(log().slice(-6))}`); await sleep(50); }
  };
  const close = () => { conversations.shutdown(); orchestrator.shutdown(); engine.shutdown(); };
  return { store, orchestrator, conversations, log, until, close };
}

/**
 * The scenario every chat agent goes through: a slow turn, a message sent into it, the stop; then the next message is
 * answered, and the agent had the message sent during the stopped turn.
 */
async function stopScenario(s: ReturnType<typeof setup>, chat: Chat, agent: "orchestrator" | "partner") {
  chat.say("Work on this: FAKE-SLOW");
  await s.until("the slow turn to run", () => chat.view().state === "working" && s.log().some((x) => x.text.includes("FAKE-SLOW")));
  await sleep(300);
  chat.say("While you work: remember BANANA");
  await s.until("the message to reach the running turn", () => s.log().some((x) => x.text.includes("remember BANANA")));
  chat.stop();
  const stoppedAt = chat.view().chat.length;
  assert.equal(chat.view().chat.at(-1)!.text, STOPPED, "the chat says it stopped");
  await s.until("the agent to be idle", () => chat.view().state === "idle");
  // Long enough for Claude Code's turn of unread messages, and for a slow turn that was not stopped to end.
  await sleep(2500);
  const v = chat.view();
  assert.equal(v.state, "idle", "the process stays, idle");
  assert.ok(s.log().some((x) => /\[(control\] )?interrupt\]?/.test(x.text)), "a pure interrupt reached the runtime");
  assert.ok(!s.log().some((x) => /stop/i.test(x.text) && !x.text.includes("interrupt")), "no message asking it to stop");
  const after = v.chat.slice(stoppedAt);
  assert.deepEqual(after, [], `nothing was added after the stop: ${JSON.stringify(after)}`);
  assert.ok(!v.chat.some((c) => c.text === PARTIAL || c.text === "slow reply"), "no text of the stopped turn");
  assert.ok(!v.chat.some((c) => c.from === "nexus" && c.kind === "error"), "the stop is no error");

  chat.say("FAKE-HISTORY");
  await s.until("the next message to be answered", () => chat.view().chat.some((c) => c.from === agent && c.text.startsWith("history:")));
  const reply = chat.view().chat.find((c) => c.from === agent && c.text.startsWith("history:"))!.text;
  assert.match(reply, /remember BANANA/, "the message sent during the stopped turn went in with the next turn");
  assert.match(reply, /FAKE-HISTORY/);
  assert.equal(reply.match(/remember BANANA/g)!.length, 1, "once");
  await s.until("idle again", () => chat.view().state === "idle");
  const turns = readTurns().entries;
  assert.ok(turns.some((t) => t.outcome === "interrupted"), "the turn record says interrupted");
}

test("the orchestrator (Claude Code) stops at once, idles, and takes the message sent during the turn into the next one", async () => {
  const s = setup();
  try {
    const o = s.orchestrator;
    await stopScenario(s, { say: (t) => o.say(t), stop: () => o.stop(), view: () => o.view() }, "orchestrator");
  } finally { s.close(); }
});

test("a thinking partner on Claude Code stops the same way", async () => {
  const s = setup();
  try {
    const c = s.conversations.create({ title: "Stop", runtime: "claude" });
    const cv = s.conversations;
    await stopScenario(s, { say: (t) => cv.say(c.id, t), stop: () => cv.stop(c.id), view: () => cv.view(c.id) }, "partner");
  } finally { s.close(); }
});

test("a thinking partner on Codex stops the same way; a steered message it never took in is carried", async () => {
  const s = setup();
  try {
    const c = s.conversations.create({ title: "Stop", runtime: "codex" });
    const cv = s.conversations;
    await stopScenario(s, { say: (t) => cv.say(c.id, t), stop: () => cv.stop(c.id), view: () => cv.view(c.id) }, "partner");
    // Carried, not steered again: the next turn's own message holds it.
    const next = s.log().find((x) => x.text.includes("FAKE-HISTORY"))!;
    assert.match(next.text, /remember BANANA[\s\S]*FAKE-HISTORY/);
    assert.equal(next.priority, null);
  } finally { s.close(); }
});

test("a stop with nothing running is refused, and changes nothing", async () => {
  const s = setup();
  try {
    assert.throws(() => s.orchestrator.stop(), (e) => e instanceof ActionError && e.status === 409);
    const c = s.conversations.create({ title: "Idle" });
    assert.throws(() => s.conversations.stop(c.id), (e) => e instanceof ActionError && e.status === 409);
    s.conversations.say(c.id, "Hello");
    await s.until("the reply", () => s.conversations.view(c.id).chat.some((x) => x.from === "partner"));
    await s.until("idle", () => s.conversations.view(c.id).state === "idle");
    assert.throws(() => s.conversations.stop(c.id), (e) => e instanceof ActionError && e.status === 409);
    assert.ok(!s.conversations.view(c.id).chat.some((x) => x.text === STOPPED));
  } finally { s.close(); }
});
