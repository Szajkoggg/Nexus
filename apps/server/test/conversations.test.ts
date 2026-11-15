// Conversations against the fake runtimes: what a thinking partner may do, and handing it to the orchestrator.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectStore, loadProjectState, updateSettings } from "@nexus/protocol";
import { Engine } from "../src/engine.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import { CODEX_WEB_SEARCH, Conversations } from "../src/conversations.ts";
import { CodexSession, webSearchText } from "../src/codex.ts";
import type { AgentEvents, AgentProcess } from "../src/agent.ts";
import { longReply } from "./fake-behaviour.ts";
import { WAIT_MS, until as waitUntil, LONGER } from "./wait.ts";

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
  const until = (what: string, pred: () => boolean, ms = WAIT_MS) => waitUntil(what, pred, ms);
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
    assert.deepEqual(allowed, [
      "Read", "Grep", "Glob",
      ...["nexus status", "nexus help", "git log", "git status", "git diff", "git show"].flatMap((p) => [`Bash(${p}:*)`, `PowerShell(${p}:*)`]),
      "Edit(Dev/Concepts/Gameplay/**)", "WebSearch",
    ], "nexus status and nexus help (to read about Nexus) and git's reading commands on Bash and PowerShell, writes only to the notes folder: no run can start, nothing else is writable");
    assert.equal(argv[argv.indexOf("--disallowedTools") + 1], "NotebookEdit,WebFetch", "no .nexus deny rules for a partner (those are the workers'); at the default web level no page fetching");
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
    const start = b.args().find((x) => x.method === "thread/start")!;
    assert.equal(start.sandbox, "read-only");
    // Codex takes no allow rules: its commands run in the sandbox, which reads everywhere, and nexus help only reads
    // (packages/cli/test/help.test.ts), so the briefing's pointer to it holds there too.
    assert.match(String(start.instructions), /Read about Nexus itself with `nexus help`/);
  } finally { b.stop(); }
});

test("handing a conversation to the orchestrator puts the partner's summary into the orchestrator's chat", async () => {
  const { conversations, orchestrator, until, stop } = setup("Dev/Notes");
  try {
    const c = conversations.create({ title: "Mining and defense" });
    conversations.handoff(c.id);
    await until("the summary in the orchestrator's chat", () => orchestrator.view().chat.some((x) => x.from === "user" && x.text.includes("SUMMARY")), LONGER.step);
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
      await until("the summary in the orchestrator's chat", () => orchestrator.view().chat.some((x) => x.from === "user"), LONGER.step);
      const sent = chatFile(store, orchestrator.session()!.id).filter((x) => x.from === "user").map((x) => x.text);
      assert.deepEqual(sent, [`[From the conversation "Long"]\n\n${summary}`], "the orchestrator gets the summary whole");
      assert.ok(chatFile(store, c.id).some((x) => x.from === "partner" && x.text === summary), "the partner's chat shows it whole too");
    } finally { stop(); }
  });
}

for (const runtime of ["claude", "codex"] as const) {
  test(`a ${runtime} hand-over asked while the partner is still at a turn waits for it, and hands over the summary`, async () => {
    process.env.FAKE_CHAT_SLOW_MS = "2500";
    const { store, conversations, orchestrator, until, stop } = setup("Dev/Notes");
    try {
      const c = conversations.create({ title: "Busy", runtime });
      conversations.say(c.id, "FAKE-SLOW");
      await until("the partner at work", () => chatFile(store, c.id).some((x) => x.kind === "tool" && x.text.includes("FAKE-SLOW")), LONGER.step);
      conversations.handoff(c.id);
      await until("the summary in the orchestrator's chat", () => orchestrator.view().chat.some((x) => x.from === "user"), LONGER.step);
      const sent = chatFile(store, orchestrator.session()!.id).filter((x) => x.from === "user").map((x) => x.text);
      assert.deepEqual(sent, [`[From the conversation "Busy"]

${longReply("SUMMARY")}`], "the summary, not the running turn's reply");
      assert.ok(chatFile(store, c.id).some((x) => x.from === "partner" && x.kind === "message" && x.text === "slow reply"), "the running turn's reply stays the partner's");
    } finally { stop(); delete process.env.FAKE_CHAT_SLOW_MS; }
  });
}

test("a turn's end that comes after the shutdown arms no idle timer: a stopped Nexus is not kept alive", () => {
  const root = mkdtempSync(join(tmpdir(), "nexus-conv-idle-"));
  process.env.NEXUS_HOME = join(root, "home");
  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  /** A stand-in partner process: what is sent is dropped; the test ends its turn. */
  class Stand extends EventEmitter<AgentEvents> implements AgentProcess {
    state: AgentProcess["state"] = "idle";
    readonly pid = 4242;
    send(): void { this.state = "working"; }
    stop(): boolean { return false; }
    close(): void { this.state = "exited"; }
    kill(): void { this.state = "exited"; }
  }
  const stands: Stand[] = [];
  const engine = new Engine(store, () => {});
  const orchestrator = new Orchestrator(store, engine, () => {});
  const conversations = new Conversations(store, orchestrator, () => {}, { spawn: () => { const p = new Stand(); stands.push(p); return p; } });
  const timeouts = () => process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
  try {
    const c = conversations.create({ title: "Idle" });
    conversations.say(c.id, "Hello");
    const before = timeouts();
    conversations.shutdown();
    stands[0]!.state = "idle";
    stands[0]!.emit("turnEnd", { ok: true, text: "late" });
    assert.ok(timeouts() <= before, "no timer armed after the shutdown");
  } finally { conversations.shutdown(); orchestrator.shutdown(); engine.shutdown(); }
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

test("the hand-over instruction keeps to this conversation's topics and asks for the dates of the decisions", async () => {
  const { root, conversations, orchestrator, until, stop } = setup("Dev/Notes");
  process.env.FAKE_LOG = join(root, "fake.log");
  try {
    const c = conversations.create({ title: "Mining" });
    conversations.handoff(c.id);
    await until("the summary in the orchestrator's chat", () => orchestrator.view().chat.some((x) => x.from === "user" && x.text.includes("SUMMARY")), LONGER.step);
    const sent = readFileSync(process.env.FAKE_LOG!, "utf8").trim().split("\n").map((l) => (JSON.parse(l) as { text: string }).text)
      .find((t) => t.startsWith("[Nexus] The user hands this conversation to the orchestrator"))!;
    assert.ok(sent.includes("Summarize only the topics discussed in this conversation, unless the user asked you to include others."), "the scope rule");
    assert.ok(sent.includes("another topic in the notes folder, even a related one, is not part of this hand-over: name its file at most, as 'see also', without its content."));
    assert.ok(sent.includes("In every notes file only the Decided section holds decisions. Name the dates of the Decided entries you cover."), "the dates rule");
    assert.ok(sent.includes("what was decided (only what the user decided), the open questions, the work you propose"), "the rest unchanged");
    assert.ok(sent.endsWith("Reply with the summary only."));
  } finally { stop(); delete process.env.FAKE_LOG; }
});

// ---------------------------------------------------------------- the web (queue WB)

/** The tools a Claude partner's process was started with: allowed, denied, and its --settings (or undefined). */
function claudeTools(argv: string[]) {
  return {
    allowed: argv.slice(argv.indexOf("--allowedTools") + 1),
    denied: argv[argv.indexOf("--disallowedTools") + 1]!.split(","),
    settings: argv.includes("--settings") ? JSON.parse(argv[argv.indexOf("--settings") + 1]!) as { hooks: { PreToolUse: { matcher: string; hooks: { command: string }[] }[] } } : undefined,
  };
}

for (const web of ["off", "search", "fetch"] as const) {
  test(`a Claude partner at web level ${web} gets its tools and deny rules; local and internal hosts are always refused`, async () => {
    const { store, conversations, args, until, stop } = setup("Dev/Notes");
    updateSettings(store, { conversations: { web } });
    try {
      const c = conversations.create({ title: "Web" });
      conversations.say(c.id, "Hello");
      await until("the reply", () => conversations.view(c.id).chat.some((x) => x.from === "partner"));
      const t = claudeTools(args()[0]!.argv as string[]);
      assert.ok(t.allowed.includes("Edit(Dev/Notes/**)") && t.allowed.includes("Read"), "the partner's other tools stay");
      assert.equal(t.allowed.includes("WebSearch"), web !== "off");
      assert.equal(t.allowed.includes("WebFetch"), web === "fetch");
      if (web === "off") assert.deepEqual(t.denied, ["NotebookEdit", "WebSearch", "WebFetch"]);
      if (web === "search") assert.deepEqual(t.denied, ["NotebookEdit", "WebFetch"]);
      if (web === "fetch") {
        for (const host of ["localhost", "*.localhost", "127.0.0.1", "0.0.0.0", "[::1]", "*.ts.net", "*.local", hostname().toLowerCase()]) {
          assert.ok(t.denied.includes(`WebFetch(domain:${host})`), `WebFetch of ${host} is denied`);
        }
        assert.ok(!t.denied.includes("WebFetch"), "pages may be read");
        const hook = t.settings!.hooks.PreToolUse[0]!;
        assert.equal(hook.matcher, "WebFetch");
        assert.match(hook.hooks[0]!.command, /^"[^"]+" "[^"]+\/apps\/server\/src\/web-guard\.ts"$/, "the guard hook runs web-guard.ts with this Node");
      } else assert.equal(t.settings, undefined, "no guard hook without page fetching");
    } finally { stop(); }
  });

  test(`a Codex partner at web level ${web} gets its search mode, without the user's own tools, and no network in its sandbox`, async () => {
    const { store, conversations, args, until, stop } = setup("Dev/Notes");
    updateSettings(store, { conversations: { web } });
    process.env.FAKE_CODEX_MCP = "node_repl,blender,odd.name";
    try {
      const c = conversations.create({ title: "Web", runtime: "codex" });
      conversations.say(c.id, "Hello");
      await until("the reply", () => conversations.view(c.id).chat.some((x) => x.from === "partner"));
      const start = args().find((x) => x.method === "thread/start")!;
      assert.deepEqual(start.config, {
        web_search: { off: "disabled", search: "cached", fetch: "live" }[web],
        "features.apps": false, "features.plugins": false,
        "mcp_servers.node_repl.enabled": false, "mcp_servers.blender.enabled": false, 'mcp_servers."odd.name".enabled': false,
      });
      assert.equal(CODEX_WEB_SEARCH[web], start.config.web_search);
      assert.ok(args().some((x) => x.method === "config/read"), "the user's servers are read from Codex's own effective config");
      const turn = args().find((x) => x.method === "turn/start")!;
      assert.equal(turn.networkAccess, false, "the sandbox's network stays off");
    } finally { stop(); delete process.env.FAKE_CODEX_MCP; }
  });
}

test("a Codex thread's config overrides go beside its writable roots, not instead of them", async () => {
  const root = mkdtempSync(join(tmpdir(), "nexus-conv-roots-"));
  process.env.FAKE_ARGS = join(root, "args.log");
  const extra = join(root, "extra");
  const s = new CodexSession({ cwd: root, env: {}, sandbox: "workspace-write", approvalPolicy: "never", writableRoots: [extra], config: { web_search: "cached" }, withoutUserTools: true });
  try {
    s.send("Hello");
    await waitUntil("the turn", () => existsSync(process.env.FAKE_ARGS!) && readFileSync(process.env.FAKE_ARGS!, "utf8").includes("turn/start"), WAIT_MS);
    const calls = readFileSync(process.env.FAKE_ARGS!, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, any>);
    const start = calls.find((c) => c.method === "thread/start")!;
    assert.deepEqual(start.config, { "sandbox_workspace_write.writable_roots": [extra], web_search: "cached", "features.apps": false, "features.plugins": false });
    assert.deepEqual(calls.find((c) => c.method === "turn/start")!.writableRoots, [extra]);
  } finally { s.kill(); delete process.env.FAKE_ARGS; }
});

test("a changed web level starts a new process for the partner's next message, which resumes the conversation", async () => {
  const { store, conversations, args, until, stop } = setup("Dev/Notes");
  try {
    const c = conversations.create({ title: "Web" });
    conversations.say(c.id, "Hello");
    await until("the reply", () => conversations.view(c.id).chat.filter((x) => x.from === "partner").length === 1);
    conversations.say(c.id, "Again");
    await until("the second reply", () => conversations.view(c.id).chat.filter((x) => x.from === "partner").length === 2);
    assert.equal(args().filter((x) => x.argv).length, 1, "the same settings: the same process");
    updateSettings(store, { conversations: { web: "fetch" } });
    conversations.say(c.id, "Now with pages");
    await until("the third reply", () => conversations.view(c.id).chat.filter((x) => x.from === "partner").length === 3);
    const starts = args().filter((x) => x.argv).map((x) => x.argv as string[]);
    assert.equal(starts.length, 2, "a new process");
    assert.ok(starts[1]!.includes("--resume"), "it resumes the conversation");
    assert.ok(claudeTools(starts[1]!).allowed.includes("WebFetch"));
  } finally { stop(); }
});

test("a Codex web search shows in the chat with what it did: its query, the page it opened, what it looked for", () => {
  assert.equal(webSearchText({ type: "webSearch", query: "", action: { type: "search", query: "node lts", queries: null } }), "Web search: node lts");
  assert.equal(webSearchText({ type: "webSearch", action: { type: "search", query: null, queries: ["a", "b"] } }), "Web search: a; b");
  assert.equal(webSearchText({ type: "webSearch", action: { type: "openPage", url: "https://nodejs.org/en" } }), "Web page: https://nodejs.org/en");
  assert.equal(webSearchText({ type: "webSearch", action: { type: "findInPage", url: "https://x.test/", pattern: "LTS" } }), "Find in page: LTS (https://x.test/)");
  assert.equal(webSearchText({ type: "webSearch", query: "old shape" }), "Web search: old shape");
});
