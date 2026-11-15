// Compact in the Ideas conversations (queue CC3) against the fake runtimes: the runtime compacts the conversation in a
// turn of its own (Claude Code: "/compact" on its input; Codex: thread/compact/start), the chat gets a Nexus line, and
// the conversation goes on in the same session. A runtime that cannot compact offers no Compact.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ActionError, ProjectStore } from "@nexus/protocol";
import { Engine } from "../src/engine.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import { COMPACTED, Conversations } from "../src/conversations.ts";
import { WAIT_MS, until as waitUntil } from "./wait.ts";

const here = dirname(fileURLToPath(import.meta.url));
process.env.NEXUS_CLAUDE = join(here, "fake-claude.ts");
process.env.NEXUS_CODEX = join(here, "fake-codex.ts");

function setup(compacts?: (runtime: "claude" | "codex") => boolean) {
  const root = mkdtempSync(join(tmpdir(), "nexus-compact-"));
  process.env.NEXUS_HOME = join(root, "home");
  process.env.FAKE_LOG = join(root, "fake.log");
  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  const engine = new Engine(store, () => {});
  const orchestrator = new Orchestrator(store, engine, () => {});
  const conversations = new Conversations(store, orchestrator, () => {}, compacts ? { compacts } : {});
  /** What reached the fake partner (FAKE_LOG). */
  const heard = (): string[] => (existsSync(process.env.FAKE_LOG!) ? readFileSync(process.env.FAKE_LOG!, "utf8").split("\n").filter(Boolean).map((l) => (JSON.parse(l) as { text: string }).text) : []);
  const until = (what: string, pred: () => boolean, ms = WAIT_MS) => waitUntil(what, pred, ms);
  const stop = () => { conversations.shutdown(); orchestrator.shutdown(); engine.shutdown(); delete process.env.FAKE_LOG; };
  return { store, conversations, heard, until, stop };
}

for (const runtime of ["claude", "codex"] as const) {
  test(`${runtime}: Compact compacts the conversation in its session; the chat gets a line, and the talk goes on`, async () => {
    const x = setup();
    try {
      const c = x.conversations.create({ title: "Mining", runtime });
      assert.equal(x.conversations.view(c.id).compact, true, "its runtime compacts: Compact is offered");
      assert.throws(() => x.conversations.compact(c.id), (e: ActionError) => e.status === 409 && /nothing to compact yet/.test(e.message));
      x.conversations.say(c.id, "Let us think about mining.");
      await x.until("the reply", () => x.conversations.view(c.id).chat.some((m) => m.from === "partner"));
      await x.until("the turn's end", () => x.conversations.view(c.id).state === "idle");
      const native = x.store.readSession(c.id).native_id;

      x.conversations.compact(c.id);
      await x.until("the compacted line", () => x.conversations.view(c.id).chat.some((m) => m.from === "nexus" && m.text.startsWith(COMPACTED)));
      const line = x.conversations.view(c.id).chat.find((m) => m.from === "nexus" && m.text.startsWith(COMPACTED))!.text;
      // Claude Code says the tokens before and after; Codex does not.
      assert.equal(line, runtime === "claude" ? `${COMPACTED}: 100 tokens of context became 30` : `${COMPACTED}.`);
      assert.ok(x.heard().includes(runtime === "claude" ? "/compact" : "[compact]"), "the runtime's own compaction was asked for");
      await x.until("idle again", () => x.conversations.view(c.id).state === "idle");
      if (runtime === "claude") assert.equal(x.store.readRuntime(c.id)?.context_tokens, 30, "the context fill after the compaction");
      assert.ok(!x.conversations.view(c.id).chat.some((m) => m.kind === "error"), "no error line");
      assert.equal(x.conversations.view(c.id).chat.filter((m) => m.from === "partner").length, 1, "the compaction writes no reply");

      // The conversation goes on in the same session.
      x.conversations.say(c.id, "And the water?");
      await x.until("the next reply", () => x.conversations.view(c.id).chat.filter((m) => m.from === "partner").length === 2);
      assert.equal(x.store.readSession(c.id).native_id, native);
    } finally { x.stop(); }
  });
}

test("Compact is refused while the partner answers", async () => {
  process.env.FAKE_CHAT_SLOW_MS = "2000";
  const x = setup();
  try {
    const c = x.conversations.create({ title: "Slow" });
    x.conversations.say(c.id, "Hello");
    await x.until("the reply", () => x.conversations.view(c.id).chat.some((m) => m.from === "partner"));
    await x.until("idle", () => x.conversations.view(c.id).state === "idle");
    x.conversations.say(c.id, "FAKE-SLOW");
    await x.until("at work", () => x.conversations.view(c.id).state === "working");
    assert.throws(() => x.conversations.compact(c.id), (e: ActionError) => e.status === 409 && /answering/.test(e.message));
    assert.ok(!x.heard().includes("/compact"));
  } finally { x.stop(); delete process.env.FAKE_CHAT_SLOW_MS; }
});

test("a runtime that cannot compact offers no Compact, and a request is refused", async () => {
  const x = setup((r) => r === "claude");
  try {
    const c = x.conversations.create({ title: "Look", runtime: "codex" });
    x.conversations.say(c.id, "Hello");
    await x.until("the reply", () => x.conversations.view(c.id).chat.some((m) => m.from === "partner"));
    assert.equal(x.conversations.view(c.id).compact, false);
    assert.throws(() => x.conversations.compact(c.id), (e: ActionError) => e.status === 409 && /cannot be compacted/.test(e.message));
    assert.ok(!x.heard().includes("[compact]"));
    assert.equal(x.conversations.view(x.conversations.create({ title: "Other" }).id).compact, true, "a Claude one still does");
  } finally { x.stop(); }
});
