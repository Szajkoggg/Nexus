// The orchestrator on Codex (queue OC) against the fake `codex app-server` and the fake `claude`: it runs on the
// runtime its settings name, in the permission profile the user chose (OC1: it reads everything, writes only its
// drafts and its own events.jsonl), without the user's own Codex tools; a draft and an answer go through the nexus
// CLI; a runtime switch starts a fresh session, and the earlier chat stays readable.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectStore, approveQueue, loadProjectState, routeAnswers } from "@nexus/protocol";
import { Engine } from "../src/engine.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import { acceptReviews } from "./fake-reviewer.ts";
import { QUICK_ENGINE, WAIT_MS, until as waitUntil, LONGER } from "./wait.ts";

const here = dirname(fileURLToPath(import.meta.url));
process.env.NEXUS_CLAUDE = join(here, "fake-claude.ts");
process.env.NEXUS_CODEX = join(here, "fake-codex.ts");

const QUEUE = `id: R
title: Planned in the chat
stop_conditions:
  - Something outside the repository would change.
steps:
  - id: R1
    title: Ask first
    goal: "FAKE: ask"
    acceptance: [The question is answered]
`;

/** What a fake recorded at its start (FAKE_ARGS): Claude Code's argv, or a Codex app-server request. */
type Args = { argv?: string[]; method?: string; sandbox?: string; approvalPolicy?: string; cwd?: string; config?: Record<string, unknown> | null; instructions?: string | null; writableRoots?: string[] | null; networkAccess?: boolean | null };

function setup(runtime: "claude" | "codex") {
  const root = mkdtempSync(join(tmpdir(), "nexus-orch-codex-"));
  process.env.NEXUS_HOME = join(root, "home");
  process.env.FAKE_REVIEW_ACCEPT = "1";
  process.env.FAKE_ARGS = join(root, "args.log");
  delete process.env.FAKE_LOG;
  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  setRuntime(store, runtime);
  const engine: Engine = new Engine(store, () => tick(), QUICK_ENGINE);
  const orchestrator = new Orchestrator(store, engine, () => tick());
  // Stands in for the server's file watcher.
  function tick() { routeAnswers(store); acceptReviews(store); orchestrator.onChange(loadProjectState(store)); engine.onChange(loadProjectState(store)); }
  const timer = setInterval(tick, 150);
  const state = () => loadProjectState(store);
  const until = (what: string, pred: () => boolean, ms = WAIT_MS) => waitUntil(what, pred, ms, () => `; chat: ${JSON.stringify(orchestrator.view().chat.slice(-4))}`);
  const args = (): Args[] => (existsSync(process.env.FAKE_ARGS!) ? readFileSync(process.env.FAKE_ARGS!, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Args) : []);
  const replies = () => orchestrator.view().chat.filter((c) => c.from === "orchestrator" && c.kind !== "tool").length;
  const stop = () => {
    clearInterval(timer); engine.shutdown(); orchestrator.shutdown();
    for (const k of ["FAKE_ARGS", "FAKE_CODEX_MCP", "FAKE_REVIEW_ACCEPT"]) delete process.env[k];
  };
  return { root, store, engine, orchestrator, state, until, args, replies, stop };
}

/** The project's orchestrator setting (it has an orchestrator section: its own settings apply). */
function setRuntime(store: ProjectStore, runtime: "claude" | "codex"): void {
  const p = store.readProject();
  store.writeProject({ ...p, orchestrator: { notify: true, session: null, ...p.orchestrator, runtime } });
}

test("with orchestrator.runtime codex the orchestrator runs on Codex, in the profile the user chose and without the user's own tools", async () => {
  const { root, store, orchestrator, until, args, replies, stop } = setup("codex");
  process.env.FAKE_CODEX_MCP = "node_repl,blender"; // the user's MCP servers, as config/read names them
  try {
    orchestrator.say("Hello");
    await until("its reply", () => replies() > 0, LONGER.step);
    const s = orchestrator.session()!;
    assert.equal(s.runtime, "codex");
    const lines = args();
    assert.ok(!lines.some((l) => l.argv), "no Claude Code process");
    const start = lines.find((l) => l.method === "thread/start")!;
    assert.ok(start, "a Codex thread");
    assert.equal(start.cwd, root, "its working directory is the project's root, which its sandbox keeps read-only");
    assert.equal(start.approvalPolicy, "never");
    assert.equal(start.sandbox, undefined, "no older sandbox setting: it would win over the profile");
    const nexus = store.dir.replaceAll("\\", "/");
    assert.deepEqual(start.config, {
      default_permissions: "nexus_orchestrator",
      "permissions.nexus_orchestrator.extends": ":read-only",
      "permissions.nexus_orchestrator.filesystem": { [`${nexus}/drafts`]: "write", [`${nexus}/sessions/${s.id}/events.jsonl`]: "write" },
      web_search: "disabled",
      // The user's MCP servers, plugins and apps are off without exception (queue FX): a server runs outside the
      // sandbox and reaches the Nexus API. runtimes.codex.mcp_servers is the workers' only.
      "features.apps": false, "features.plugins": false, "mcp_servers.node_repl.enabled": false, "mcp_servers.blender.enabled": false,
    }, "only the drafts and its own event log are writable: not its session.yaml, its inbox, or anything of the user's");
    assert.ok(lines.some((l) => l.method === "config/read"), "the user's config read for its MCP servers");
    const turn = lines.find((l) => l.method === "turn/start")!;
    assert.equal(turn.writableRoots, null, "a turn sends no sandbox policy either");
    assert.match(start.instructions ?? "", /^You are the orchestrator of the project "P"/);
    assert.match(start.instructions ?? "", /No helpers: on Codex you have no subagents/);
    assert.doesNotMatch(start.instructions ?? "", /queue-reviewer|run-digest|question-triage|Agent tool/);
    assert.ok(existsSync(join(store.sessionDir(s.id), "events.jsonl")), "the file its sandbox grants exists before the sandbox starts");
    assert.ok(existsSync(join(store.dir, "drafts")), "so does the drafts folder: the sandbox cannot make it (probed, OC2)");
  } finally { stop(); }
});

test("on Codex, a resumed thread (a restarted server) gets the same permission profile, and no older sandbox setting", async () => {
  const { store, engine, orchestrator, until, args, replies, stop } = setup("codex");
  try {
    orchestrator.say("Hello");
    await until("its reply", () => replies() > 0, LONGER.step);
    await until("the thread id recorded", () => !!orchestrator.session()?.native_id);
    const s = orchestrator.session()!;
    const started = args().find((l) => l.method === "thread/start")!;
    orchestrator.shutdown();
    await until("its process ended", () => !orchestrator.alive());

    const again = new Orchestrator(store, engine, () => {});
    try {
      again.say("Hello again");
      await until("the thread resumed", () => args().some((l) => l.method === "thread/resume"), LONGER.step);
      const resumed = args().find((l) => l.method === "thread/resume")! as Args & { threadId?: string };
      assert.equal(resumed.threadId, s.native_id);
      assert.equal(again.session()!.id, s.id, "the same session");
      assert.equal(resumed.sandbox, undefined);
      assert.deepEqual(resumed.config, started.config, "the profile (and every tool off) again");
    } finally { again.shutdown(); }
  } finally { stop(); }
});

test("on Codex, a draft and an answer to a worker go through the nexus CLI", async () => {
  const { store, orchestrator, state, until, stop } = setup("codex");
  try {
    orchestrator.say(`FAKE-DRAFT:\n${QUEUE}`);
    await until("the drafted queue", () => state().queues.some((q) => q.id === "R"), LONGER.step);
    assert.equal(state().queues.find((q) => q.id === "R")!.status, "proposed");
    assert.ok(state().sessions.find((x) => x.id === orchestrator.session()!.id)!.runtime === "codex");
    // Sent at once, while the draft's turn may still run: steered into it, or (the steer refused after the turn ended)
    // its own next turn. Once it waited for a message after it (found with this test).
    approveQueue(store, "R", "Go.");
    orchestrator.say(`FAKE-NEXUS: ["run","R","start","--reason","approved"]`);
    await until("the worker's question answered", () => state().questions.some((q) => q.queue === "R" && q.state === "answered"), LONGER.run);
    const answer = state().questions.find((q) => q.queue === "R")!.answers[0]!;
    assert.equal(answer.by, "orchestrator");
    assert.equal(answer.text, "fake answer");
    assert.equal(answer.session, orchestrator.session()!.id);
  } finally { stop(); }
});

test("switching the runtime starts a fresh session on the new one; the earlier chat stays readable; back to Claude runs on Claude", async () => {
  const { store, orchestrator, until, args, replies, stop } = setup("claude");
  try {
    orchestrator.say("Hello on Claude");
    await until("Claude's reply", () => replies() > 0, LONGER.step);
    const first = orchestrator.session()!;
    assert.equal(first.runtime, "claude");
    assert.ok(args()[0]!.argv, "Claude Code's process");

    await until("the Claude session idle", () => orchestrator.idle(), LONGER.step);
    setRuntime(store, "codex");
    orchestrator.say("Hello on Codex");
    await until("a Codex thread", () => args().some((l) => l.method === "thread/start"), LONGER.step);
    const second = orchestrator.session()!;
    assert.notEqual(second.id, first.id, "a fresh session");
    assert.equal(second.runtime, "codex");
    assert.equal(second.continues, first.id);
    assert.equal(store.readSession(first.id).continued_by, second.id);
    await until("Codex's reply", () => orchestrator.view().chat.some((c) => c.from === "orchestrator" && c.kind !== "tool"), LONGER.step);
    const view = orchestrator.view();
    assert.deepEqual(view.earlier.map((b) => b.session), [first.id], "the earlier session's chat is shown above");
    assert.ok(view.earlier[0]!.chat.some((c) => c.from === "user" && c.text === "Hello on Claude"));
    assert.ok(view.earlier[0]!.chat.some((c) => c.from === "nexus" && /goes on on Codex in a fresh session/.test(c.text)));
    assert.ok(view.chat.some((c) => c.from === "nexus" && /you switched it from Claude Code/.test(c.text)));
    assert.ok(view.chat.some((c) => c.from === "user" && c.text === "Hello on Codex"));

    // Between turns: a message sent while a turn runs goes into that turn, on the old runtime; the switch comes with the next.
    await until("the Codex session idle", () => orchestrator.idle(), LONGER.step);
    setRuntime(store, "claude");
    const before = args().filter((l) => l.argv).length;
    orchestrator.say("Back on Claude");
    await until("a Claude Code process again", () => args().filter((l) => l.argv).length > before, LONGER.step);
    const third = orchestrator.session()!;
    assert.equal(third.runtime, "claude");
    assert.equal(third.continues, second.id);
    assert.deepEqual(orchestrator.view().earlier.map((b) => b.session), [first.id, second.id]);
  } finally { stop(); }
});

test("the orchestrator's effort goes by its runtime: Claude Code refuses ultra, Codex takes it", () => {
  const { store, orchestrator, stop } = setup("claude");
  try {
    assert.throws(() => orchestrator.settings("", "ultra"), /Claude Code takes effort low, medium, high, xhigh, max/);
    setRuntime(store, "codex");
    orchestrator.settings("gpt-6-luna", "ultra");
    assert.equal(store.readProject().orchestrator?.effort, "ultra");
  } finally { stop(); }
});
