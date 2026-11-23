// Idea conversations/direct handoffs against both fake runtimes. No real model or registered project.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectStore, changeIdeaStatus, ideaStatuses, loadProjectState, previewIdeaHandoff, retryIdeaHandoff, sendIdeaHandoff } from "@nexus/protocol";
import { Conversations } from "../src/conversations.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import { Engine } from "../src/engine.ts";
import { QUICK_ENGINE, until, LONGER } from "./wait.ts";

const here = dirname(fileURLToPath(import.meta.url));
process.env.NEXUS_CLAUDE = join(here, "fake-claude.ts");
process.env.NEXUS_CODEX = join(here, "fake-codex.ts");
const TEXT = "# Scoped idea\n**Summary:** Initial summary.\n## Decided\n### 2026-11-14\n- Exact first decision.\n### 2026-11-15\n- Different date content.\n## Open\n- Still a question?\n## Ideas\n- Maybe something later.\n";
function setup(runtime: "claude" | "codex") {
  const root = mkdtempSync(join(tmpdir(), "nexus-idea-chat-"));
  process.env.NEXUS_HOME = join(root, "home"); process.env.FAKE_LOG = join(root, "fake.log");
  delete process.env.FAKE_ARGS;
  const store = ProjectStore.init(root, { id: "p", name: "P", root, orchestrator: { runtime, notify: false } });
  store.updateProject((p) => ({ ...p, conversations: { ...p.conversations, runtime, notes_dir: "notes" } }));
  mkdirSync(join(root, "notes")); const note = join(root, "notes/a.md"); writeFileSync(note, TEXT);
  const engine = new Engine(store, () => {}, QUICK_ENGINE), orchestrator = new Orchestrator(store, engine, () => {});
  const conversations = new Conversations(store, orchestrator, () => {});
  const received = () => (existsSync(process.env.FAKE_LOG!) ? readFileSync(process.env.FAKE_LOG!, "utf8").trim().split("\n") : []).map((l) => JSON.parse(l) as { text: string });
  const stop = async () => {
    conversations.shutdown(); orchestrator.shutdown(); engine.shutdown();
    await until("owned runtimes to exit", () => !conversations.alive() && !orchestrator.alive() && !engine.alive(), LONGER.processes);
    rmSync(root, { recursive: true, force: true });
  };
  return { root, store, note, engine, orchestrator, conversations, received, stop };
}

for (const runtime of ["claude", "codex"] as const) {
  test(`${runtime}: whole-note chat includes every date, current state and links, and refreshes any changed decision`, async () => {
    const f = setup(runtime);
    try {
      f.store.writeQueue({ protocol: 1, id: "Q", title: "Earlier work", revision: 1, status: "done", source: ["notes/a.md#2026-11-14"],
        steps: [{ id: "Q1", title: "Work", goal: "Outcome", acceptance: [], status: "done" }], approvals: [], history: [], checks: [], stop_conditions: [] });
      changeIdeaStatus(f.store, { request_id: "drop-fixture", revision: ideaStatuses(f.store, loadProjectState(f.store)).revision,
        operation: "drop", ref: "notes/a.md#2026-11-15", reason: "Synthetic user decision" });
      const c = f.conversations.create({ idea: { file: "notes/a.md" }, request_id: "whole-note" });
      assert.deepEqual(c.about?.idea, { file: "notes/a.md" });
      assert.equal(f.received().length, 0); assert.equal(f.store.readRuntime(c.id), undefined);
      f.conversations.say(c.id, "Discuss the whole idea");
      await until("whole-note reply", () => f.conversations.view(c.id).state === "idle", LONGER.step);
      const first = f.received().find((m) => m.text.includes("Discuss the whole idea"))!.text;
      for (const text of ["Scope: whole note", "Initial summary", "2026-11-14", "2026-11-15", "Exact first decision", "Different date content", "Still a question?", "Maybe something later"])
        assert(first.includes(text), text);
      assert.match(first, /"disposition": "dropped"/); assert.match(first, /"queue": "Q"/);
      writeFileSync(f.note, TEXT.replace("Exact first decision", "Changed older decision"));
      f.conversations.say(c.id, "Discuss the updated idea");
      await until("updated whole-note reply", () => f.conversations.view(c.id).state === "idle", LONGER.step);
      const next = f.received().find((m) => m.text.includes("Discuss the updated idea"))!.text;
      assert.match(next, /context changed/); assert.match(next, /Changed older decision/); assert.match(next, /Different date content/);
    } finally { await f.stop(); }
  });

  test(`${runtime}: idea chat creation is idempotent and model-free; first request and changed context keep exact dates and own settings`, async () => {
    const f = setup(runtime);
    try {
      const body = { idea: { file: "notes/a.md", date: "2026-11-14" }, request_id: "create", model: "own-model", effort: "high" };
      const c = f.conversations.create(body);
      assert.equal(f.conversations.create(body).id, c.id);
      assert.notEqual(f.conversations.create({ ...body, request_id: "new-click" }).id, c.id);
      assert.throws(() => f.conversations.create({ ...body, idea: { file: "notes/a.md" } }), /already names/);
      assert.equal(f.received().length, 0); assert.equal(f.conversations.view(c.id).state, "exited");
      f.conversations.say(c.id, "First actual question");
      await until("first scoped reply", () => f.conversations.view(c.id).state === "idle", LONGER.step);
      const first = f.received().find((m) => m.text.includes("First actual question"))!.text;
      assert.match(first, /notes\/a.md#2026-11-14/); assert.match(first, /Exact first decision/);
      assert.doesNotMatch(first, /Different date content/); assert.match(first, /Not decided — Open/); assert.match(first, /Maybe something later/);
      assert.equal(f.store.readChat(c.id).entries.find((m) => m.from === "user")!.text, "First actual question");
      writeFileSync(f.note, TEXT.replace("Initial summary", "Fresh summary").replace("Exact first decision", "Updated first decision"));
      f.conversations.say(c.id, "Second actual question");
      await until("second scoped reply", () => f.conversations.view(c.id).state === "idle", LONGER.step);
      const second = f.received().find((m) => m.text.includes("Second actual question"))!.text;
      assert.match(second, /context changed/); assert.match(second, /Fresh summary/); assert.match(second, /Updated first decision/);
      assert.equal(f.store.readSession(c.id).model, "own-model"); assert.equal(f.store.readSession(c.id).effort, "high");
      f.conversations.update(c.id, { archived: true });
      assert.throws(() => f.conversations.say(c.id, "Archived request"), /archived/);
      assert(f.conversations.view(c.id).chat.length > 0);
      f.conversations.update(c.id, { archived: false }); rmSync(f.note);
      assert.match(f.conversations.view(c.id).idea_context_error!, /missing/);
      const count = f.store.readChat(c.id).entries.length;
      assert.throws(() => f.conversations.say(c.id, "Missing request"), /missing/);
      assert.equal(f.store.readChat(c.id).entries.length, count);
      assert.throws(() => f.conversations.create({ idea: { file: "notes/gone.md" }, request_id: "missing" }), /missing/);
      assert.throws(() => f.conversations.handoff(c.id), /preview/);
      assert.deepEqual(f.store.queueIds(), []);
    } finally { await f.stop(); }
  });

  test(`${runtime}: direct handoff beside a running idea chat is scoped, durable and idempotent across restart`, async () => {
    const f = setup(runtime); process.env.FAKE_CHAT_SLOW_MS = "2500";
    let restarted: Orchestrator | undefined;
    try {
      const c = f.conversations.create({ idea: { file: "notes/a.md" }, request_id: "chat" });
      f.conversations.say(c.id, "FAKE-SLOW unrelated chat discussion");
      await until("partner is working", () => f.conversations.view(c.id).chat.some((x) => x.kind === "tool" && x.text.includes("FAKE-SLOW")), LONGER.step);
      const selection = { file: "notes/a.md", dates: ["2026-11-14"], purpose: "plan", instruction: "Review before proposing work" };
      const preview = previewIdeaHandoff(f.store, selection);
      const request = { request_id: "direct", revision: preview.revision, selection };
      const delivered = sendIdeaHandoff(f.store, request, (id, text) => f.orchestrator.enqueueIdea(id, text));
      assert.equal(delivered.state, "delivered"); assert.equal(delivered.payload, preview.payload);
      assert.doesNotMatch(delivered.payload, /unrelated chat discussion|Different date content/);
      assert.equal(f.store.readChat(delivered.delivery!.session).entries.filter((e) => e.message_id === "idea-direct").length, 1);
      f.orchestrator.onChange(loadProjectState(f.store));
      await until("orchestrator gets exact payload", () => f.received().some((m) => m.text.includes(preview.payload)), LONGER.step);
      await until("ordinary partner reply", () => f.conversations.view(c.id).chat.some((m) => m.from === "partner" && m.text === "slow reply"), LONGER.step);
      assert(!f.store.readChat(c.id).entries.some((e) => e.text.includes("SUMMARY")));
      f.orchestrator.shutdown(); await until("old orchestrator exits", () => !f.orchestrator.alive(), LONGER.processes);
      restarted = new Orchestrator(f.store, f.engine, () => {});
      const deliver = (id: string, text: string) => restarted!.enqueueIdea(id, text);
      assert.deepEqual(sendIdeaHandoff(f.store, request, deliver), delivered);
      // Simulate a crash after inbox/chat append but before the handoff file records delivery.
      const persisted = f.store.readIdeaHandoffs();
      f.store.writeIdeaHandoffs({ ...persisted, records: persisted.records.map((r) => ({ ...r, state: "pending", delivery: undefined })) });
      const recovered = retryIdeaHandoff(f.store, "direct", deliver);
      assert.deepEqual(recovered.delivery, delivered.delivery);
      assert.equal(f.store.readInbox(delivered.delivery!.session).entries.filter((e) => e.id === "idea-direct").length, 1);
      assert.equal(f.store.readChat(delivered.delivery!.session).entries.filter((e) => e.message_id === "idea-direct").length, 1);
      assert.equal(readFileSync(f.note, "utf8"), TEXT); assert.deepEqual(f.store.queueIds(), []);
      assert(!existsSync(join(f.store.dir, "plan.yaml")));
    } finally {
      restarted?.shutdown();
      await until("restarted orchestrator exits", () => !restarted?.alive(), LONGER.processes);
      delete process.env.FAKE_CHAT_SLOW_MS; await f.stop();
    }
  });
}
