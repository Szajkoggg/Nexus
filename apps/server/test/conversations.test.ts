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
