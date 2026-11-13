// Conversations against the fake runtimes: what a thinking partner may do, and handing it to the orchestrator.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectStore, loadProjectState, updateSettings } from "@nexus/protocol";
import { Engine } from "../src/engine.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import { Conversations } from "../src/conversations.ts";
import { longReply } from "./fake-behaviour.ts";

const here = dirname(fileURLToPath(import.meta.url));
process.env.NEXUS_CLAUDE = join(here, "fake-claude.ts");
process.env.NEXUS_CODEX = join(here, "fake-codex.ts");

function setup(notes?: string) {
  const root = mkdtempSync(join(tmpdir(), "nexus-conv-"));
  process.env.NEXUS_HOME = join(root, "home");
  process.env.FAKE_ARGS = join(root, "args.log");
  delete process.env.FAKE_LOG;
  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  if (notes) updateSettings(store, { conversations: { notes_dir: notes } });
  const engine = new Engine(store, () => {});
  const orchestrator = new Orchestrator(store, engine, () => {});
  const conversations = new Conversations(store, orchestrator, () => {});
  const args = () => (existsSync(process.env.FAKE_ARGS!) ? readFileSync(process.env.FAKE_ARGS!, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, any>) : []);
  const until = async (what: string, pred: () => boolean, ms = 20_000) => {
    const t = Date.now();
    while (!pred()) { if (Date.now() - t > ms) assert.fail(`timed out waiting for ${what}`); await new Promise((r) => setTimeout(r, 100)); }
  };
  const stop = () => { conversations.shutdown(); orchestrator.shutdown(); engine.shutdown(); };
  return { root, store, orchestrator, conversations, args, until, stop };
}

test("a Claude partner asks nothing and may write only in the notes folder", async () => {
  const { conversations, args, until, stop } = setup("Dev/Concepts/Gameplay");
  try {
    const c = conversations.create({ title: "Mining", effort: "high" });
    conversations.say(c.id, "Let us think about mining.");
    await until("the reply", () => conversations.view(c.id).chat.some((x) => x.from === "partner"));
    const argv = args()[0]!.argv as string[];
    assert.equal(argv[argv.indexOf("--permission-mode") + 1], "dontAsk");
    assert.equal(argv[argv.indexOf("--effort") + 1], "high");
    const allowed = argv.slice(argv.indexOf("--allowedTools") + 1);
    assert.ok(allowed.includes("Edit(Dev/Concepts/Gameplay/**)"), "writes go to the notes folder");
    assert.ok(!allowed.some((t) => t === "Edit" || t === "Write" || t.startsWith("Bash(nexus run") || t === "Bash(nexus:*)"), "nothing else is writable, no run can start");
    assert.equal(argv[argv.indexOf("--disallowedTools") + 1], "NotebookEdit", "unchanged: no .nexus deny rules for a partner (those are the workers')");
    assert.equal(loadProjectState(conversations["store"]).sessions.find((s) => s.id === c.id)?.role, "conversation");
  } finally { stop(); }
});

test("a Codex partner works in the notes folder's sandbox, or reads only without one", async () => {
  const a = setup("Dev/Notes");
  try {
    const c = a.conversations.create({ title: "Look", runtime: "codex" });
    a.conversations.say(c.id, "Hello");
    await a.until("the reply", () => a.conversations.view(c.id).chat.some((x) => x.from === "partner"));
    const start = a.args().find((x) => x.method === "thread/start")!;
    assert.equal(start.sandbox, "workspace-write");
    assert.equal(start.approvalPolicy, "never");
    assert.match(String(start.cwd).replaceAll("\\", "/"), /Dev\/Notes$/);
    assert.ok(existsSync(join(a.root, "Dev/Notes")), "the notes folder is created");
  } finally { a.stop(); }
  const b = setup();
  try {
    const c = b.conversations.create({ title: "Look", runtime: "codex" });
    b.conversations.say(c.id, "Hello");
    await b.until("the reply", () => b.conversations.view(c.id).chat.some((x) => x.from === "partner"));
    assert.equal(b.args().find((x) => x.method === "thread/start")!.sandbox, "read-only");
  } finally { b.stop(); }
});

test("handing a conversation to the orchestrator puts the partner's summary into the orchestrator's chat", async () => {
  const { conversations, orchestrator, until, stop } = setup("Dev/Notes");
  try {
    const c = conversations.create({ title: "Mining and defense" });
    conversations.handoff(c.id);
    await until("the summary in the orchestrator's chat", () => orchestrator.view().chat.some((x) => x.from === "user" && x.text.includes("SUMMARY")));
    const sent = orchestrator.view().chat.find((x) => x.from === "user")!.text;
    assert.match(sent, /^\[From the conversation "Mining and defense"\]/);
    await until("the confirmation", () => conversations.view(c.id).chat.some((x) => x.from === "nexus" && /went to the orchestrator/.test(x.text)));
  } finally { stop(); }
});

/** The entries of a session's chat.jsonl, read from the file itself. */
function chatFile(store: ProjectStore, session: string): { from: string; kind?: string; text: string }[] {
  return readFileSync(join(store.sessionDir(session), "chat.jsonl"), "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
}

for (const runtime of ["claude", "codex"] as const) {
  test(`a ${runtime} partner's long reply and hand-over summary reach the chats whole`, async () => {
    const { store, conversations, orchestrator, until, stop } = setup("Dev/Notes");
    try {
      const c = conversations.create({ title: "Long", runtime });
      const reply = longReply("Reply");
      assert.ok(reply.length >= 3000);
      conversations.say(c.id, "FAKE-LONG");
      await until("the long reply", () => conversations.view(c.id).chat.some((x) => x.from === "partner" && x.kind === "message"));
      const got = chatFile(store, c.id).filter((x) => x.from === "partner" && x.kind === "message");
      assert.deepEqual(got.map((x) => x.text), [reply], "the partner's chat has the reply byte for byte");

      const summary = longReply("SUMMARY");
      assert.ok(summary.length > 600);
      conversations.handoff(c.id);
      await until("the summary in the orchestrator's chat", () => orchestrator.view().chat.some((x) => x.from === "user"));
      const sent = chatFile(store, orchestrator.session()!.id).filter((x) => x.from === "user").map((x) => x.text);
      assert.deepEqual(sent, [`[From the conversation "Long"]\n\n${summary}`], "the orchestrator gets the summary whole");
      assert.ok(chatFile(store, c.id).some((x) => x.from === "partner" && x.text === summary), "the partner's chat shows it whole too");
    } finally { stop(); }
  });
}

test("the notes folder must lie inside the project", () => {
  const { store, stop } = setup();
  try {
    for (const bad of ["../outside", "C:/Windows", "/etc", "Dev/../../x"]) {
      assert.throws(() => updateSettings(store, { conversations: { notes_dir: bad } }), /inside the project/, bad);
    }
    updateSettings(store, { conversations: { notes_dir: String.raw`.\Dev\Concepts\Gameplay\ `.trim() } });
    assert.equal(store.readProject().conversations.notes_dir, "Dev/Concepts/Gameplay");
  } finally { stop(); }
});

test("the hand-over instruction keeps to this conversation's topics and asks for the dates of the decisions", async () => {
  const { root, conversations, orchestrator, until, stop } = setup("Dev/Notes");
  process.env.FAKE_LOG = join(root, "fake.log");
  try {
    const c = conversations.create({ title: "Mining" });
    conversations.handoff(c.id);
    await until("the summary in the orchestrator's chat", () => orchestrator.view().chat.some((x) => x.from === "user" && x.text.includes("SUMMARY")));
    const sent = readFileSync(process.env.FAKE_LOG!, "utf8").trim().split("\n").map((l) => (JSON.parse(l) as { text: string }).text)
      .find((t) => t.startsWith("[Nexus] The user hands this conversation to the orchestrator"))!;
    assert.ok(sent.includes("Summarize only the topics discussed in this conversation, unless the user asked you to include others."), "the scope rule");
    assert.ok(sent.includes("another topic in the notes folder, even a related one, is not part of this hand-over: name its file at most, as 'see also', without its content."));
    assert.ok(sent.includes("In every notes file only the Decided section holds decisions. Name the dates of the Decided entries you cover."), "the dates rule");
    assert.ok(sent.includes("what was decided (only what the user decided), the open questions, the work you propose"), "the rest unchanged");
    assert.ok(sent.endsWith("Reply with the summary only."));
  } finally { stop(); delete process.env.FAKE_LOG; }
});
