// A conversation's own model and effort (queue CM) against the fake runtimes: saving them starts no turn and cuts none
// short; the next turn runs on them in a new process that resumes the same native session, after the old process's
// turn, never beside it; a message sent meanwhile waits for that boundary. Inheritance from the project's conversation
// settings, going back to it, and the pair's check. No model is called.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { ActionError, ProjectStore, updateSettings, writeRegistry, type ConversationSettings } from "@nexus/protocol";
import type { LiveMessage } from "@nexus/protocol/live";
import { Engine } from "../src/engine.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import { Conversations } from "../src/conversations.ts";
import { ClaudeSession } from "../src/claude.ts";
import { CodexSession } from "../src/codex.ts";
import { listModels } from "../src/models.ts";
import type { AgentProcess } from "../src/agent.ts";
import type { AgentHostOptions, Launch } from "../src/agent-host.ts";
import { longReply } from "./fake-behaviour.ts";
import { spawnServer } from "./helpers.ts";
import { QUICK_ENGINE, WAIT_MS, LONGER, serverUp, until, until as waitUntil } from "./wait.ts";

const freePort = () => new Promise<number>((resolve) => {
  const s = createServer();
  s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); });
});

const here = dirname(fileURLToPath(import.meta.url));
process.env.NEXUS_CLAUDE = join(here, "fake-claude.ts");
process.env.NEXUS_CODEX = join(here, "fake-codex.ts");

type Runtime = "claude" | "codex";

/**
 * A project with conversations whose processes are watched: `overlap` is the most processes of one conversation seen
 * at a turn at once (sampled, and at every turn's start).
 */
function setup(o: { runtime?: Runtime; notes?: string; host?: AgentHostOptions } = {}) {
  const root = mkdtempSync(join(tmpdir(), "nexus-conv-settings-"));
  process.env.NEXUS_HOME = join(root, "home");
  process.env.FAKE_ARGS = join(root, "args.log");
  process.env.FAKE_LOG = join(root, "fake.log");
  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  store.updateProject((p) => ({ ...p, conversations: { ...p.conversations, runtime: o.runtime ?? "claude", ...(o.notes ? { notes_dir: o.notes } : {}) } }));
  const procs: AgentProcess[] = [];
  let overlap = 0;
  const look = () => { overlap = Math.max(overlap, procs.filter((p) => p.state === "working").length); };
  const spawn = (launch: Launch): AgentProcess => {
    const p = launch.runtime === "codex" ? new CodexSession(launch.options) : new ClaudeSession(launch.options);
    procs.push(p);
    p.on("activity", look); p.on("message", look);
    return p;
  };
  const sampler = setInterval(look, 2);
  const engine = new Engine(store, () => {}, QUICK_ENGINE);
  const orchestrator = new Orchestrator(store, engine, () => {});
  let conversations = new Conversations(store, orchestrator, () => {}, { spawn, ...o.host });
  const args = () => (existsSync(process.env.FAKE_ARGS!) ? readFileSync(process.env.FAKE_ARGS!, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, any>) : []);
  /** The processes started: Claude's command lines, Codex's thread starts and resumes. */
  const starts = () => args().filter((a) => a.argv || a.method === "thread/start" || a.method === "thread/resume");
  const heard = (): string[] => (existsSync(process.env.FAKE_LOG!) ? readFileSync(process.env.FAKE_LOG!, "utf8").split("\n").filter(Boolean).map((l) => (JSON.parse(l) as { text: string }).text) : []);
  const replies = (id: string) => store.readChat(id).entries.filter((e) => e.from === "partner" && e.kind === "message").map((e) => e.text);
  const settings = (id: string) => (conversations.head(id) as { settings: ConversationSettings }).settings;
  const until = (what: string, pred: () => boolean, ms = WAIT_MS) => waitUntil(what, pred, ms);
  const stop = () => { clearInterval(sampler); conversations.shutdown(); orchestrator.shutdown(); engine.shutdown(); };
  /** A new server's Conversations over the same project (after cutOff and shutdown). */
  const restart = () => { conversations = new Conversations(store, orchestrator, () => {}, { spawn, ...o.host }); return conversations; };
  return { root, store, orchestrator, get conversations() { return conversations; }, args, starts, heard, replies, settings, until, stop, restart, overlap: () => overlap, procs };
}

/** The model and effort a start (Claude's argv) or the last turn (Codex's turn/start) ran on. */
function ranOn(x: ReturnType<typeof setup>, runtime: Runtime, native?: string): { model?: string; effort?: string } {
  if (runtime === "claude") {
    // `native`: the conversation's own starts only (an orchestrator's, after a hand-over, starts too).
    const argv = x.starts().filter((a) => !native || (a.argv as string[]).includes(native)).at(-1)!.argv as string[];
    const val = (flag: string) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);
    return { model: val("--model"), effort: val("--effort") };
  }
  // Codex takes the model with its thread (start or resume), the effort with each turn.
  const turn = x.args().filter((a) => a.method === "turn/start").at(-1)!;
  return { model: x.starts().at(-1)!.model ?? undefined, effort: turn.effort ?? undefined };
}

/** The native session the last start resumed (Claude's --resume, Codex's thread/resume), or undefined: a fresh start. */
function resumed(x: ReturnType<typeof setup>, runtime: Runtime): string | undefined {
  const last = x.starts().at(-1)!;
  if (runtime === "claude") { const argv = last.argv as string[]; return argv.includes("--resume") ? argv[argv.indexOf("--resume") + 1] : undefined; }
  return last.method === "thread/resume" ? last.threadId as string : undefined;
}

for (const runtime of ["claude", "codex"] as const) {
  test(`${runtime}: a save during a reply lets it finish; a quick message waits for it and runs on the saved pair in the same session`, async () => {
    process.env.FAKE_CHAT_SLOW_MS = "1500";
    const x = setup({ runtime });
    try {
      const c = x.conversations.create({ title: "Mining", runtime });
      x.conversations.say(c.id, "Hello");
      await x.until("the first reply", () => x.replies(c.id).length === 1);
      const native = x.store.readSession(c.id).native_id;
      x.conversations.say(c.id, "FAKE-SLOW");
      await x.until("the slow turn at work", () => x.store.readChat(c.id).entries.some((e) => e.kind === "tool" && e.text.includes("FAKE-SLOW")), LONGER.step);
      assert.equal(x.starts().length, 1);

      x.conversations.update(c.id, { model: "fake-b", effort: "high" });
      assert.equal(x.starts().length, 1, "saving starts no process");
      assert.deepEqual(x.settings(c.id), {
        running: { model: null, effort: null },
        next: { model: "fake-b", effort: "high", model_from: "own", effort_from: "own" },
        changes: true,
        inherited: { model: null, effort: null, model_from: "runtime", effort_from: "runtime" },
      }, "the running pair and the next turn's, apart");
      x.conversations.say(c.id, "Quick one");
      assert.equal(x.conversations.head(c.id).state, "working");
      await x.until("both answered", () => x.replies(c.id).length === 3, LONGER.step);

      assert.equal(x.replies(c.id)[1], "slow reply", "the running reply finished, not cut short");
      assert.ok(!x.store.readChat(c.id).entries.some((e) => e.from === "nexus"), "no stop, no error");
      assert.equal(x.starts().length, 2, "one new process");
      assert.equal(x.overlap(), 1, "never two processes at a turn");
      assert.deepEqual(ranOn(x, runtime), { model: "fake-b", effort: "high" }, "the quick message's turn on the saved pair");
      assert.equal(resumed(x, runtime), native, "in the same native session");
      assert.ok(x.heard().filter((t) => t === "Quick one").length === 1, "the quick message reached a process once");
      assert.deepEqual(x.settings(c.id).running, { model: "fake-b", effort: "high" });
      assert.equal(x.settings(c.id).changes, false);
    } finally { delete process.env.FAKE_CHAT_SLOW_MS; x.stop(); }
  });
}

test("claude: saved twice and messaged twice during a reply: one new process, on the last saved pair, the messages in order", async () => {
  process.env.FAKE_CHAT_SLOW_MS = "1500";
  const x = setup();
  try {
    const c = x.conversations.create({ title: "Twice" });
    x.conversations.say(c.id, "FAKE-SLOW");
    await x.until("the slow turn at work", () => x.store.readChat(c.id).entries.some((e) => e.kind === "tool"), LONGER.step);
    x.conversations.update(c.id, { effort: "high" });
    x.conversations.say(c.id, "one");
    x.conversations.update(c.id, { model: "fake-c", effort: "low" });
    x.conversations.say(c.id, "two");
    await x.until("the slow reply and the waiting messages answered", () => x.replies(c.id).length >= 2 && x.conversations.idle(), LONGER.step);
    assert.equal(x.replies(c.id)[0], "slow reply");
    assert.equal(x.starts().length, 2, "one new process for both saves");
    assert.equal(x.overlap(), 1);
    assert.deepEqual(ranOn(x, "claude"), { model: "fake-c", effort: "low" }, "the last saved pair");
    const heard = x.heard();
    assert.ok(heard.indexOf("one") >= 0 && heard.indexOf("one") < heard.indexOf("two"), "the messages in the order sent");
  } finally { delete process.env.FAKE_CHAT_SLOW_MS; x.stop(); }
});

test("saving starts no turn: an empty conversation, an idle one; its next message runs on the saved pair", async () => {
  const x = setup();
  try {
    const c = x.conversations.create({ title: "Empty" });
    x.conversations.update(c.id, { effort: "max" });
    assert.equal(x.starts().length, 0, "no process for an empty conversation");
    assert.deepEqual(x.store.readChat(c.id).entries, [], "nothing in its chat");
    assert.equal(x.settings(c.id).running, null);
    x.conversations.say(c.id, "First");
    await x.until("the reply", () => x.replies(c.id).length === 1 && x.conversations.head(c.id).state === "idle");
    assert.equal(ranOn(x, "claude").effort, "max", "the first turn on the pair saved before it");

    x.conversations.update(c.id, { effort: "low" });
    assert.equal(x.starts().length, 1, "an idle process: no new one, no turn");
    assert.equal(x.replies(c.id).length, 1);
    assert.equal(x.settings(c.id).changes, true);
    x.conversations.say(c.id, "Second");
    await x.until("the second reply", () => x.replies(c.id).length === 2);
    assert.equal(x.starts().length, 2);
    assert.equal(ranOn(x, "claude").effort, "low");
    assert.equal(resumed(x, "claude"), c.native_id);
    assert.equal(x.overlap(), 1);
  } finally { x.stop(); }
});

test("inherited and own values: the project's settings fill what the conversation leaves, its own stay, defaults come back", () => {
  const x = setup();
  try {
    updateSettings(x.store, { conversations: { model: "proj-m", effort: "medium" } });
    const follows = x.conversations.create({ title: "Follows" });
    const own = x.conversations.create({ title: "Own", effort: "low" });
    const codex = x.conversations.create({ title: "Codex", runtime: "codex" });
    // An older conversation, written before model and effort existed in its file.
    const old = x.conversations.create({ title: "Old" });
    const { model: _m, effort: _e, ...bare } = x.store.readSession(old.id);
    x.store.writeSession(bare);

    assert.deepEqual(x.settings(follows.id).next, { model: "proj-m", effort: "medium", model_from: "project", effort_from: "project" });
    assert.deepEqual(x.settings(own.id).next, { model: "proj-m", effort: "low", model_from: "project", effort_from: "own" });
    assert.deepEqual(x.settings(codex.id).next, { model: null, effort: null, model_from: "runtime", effort_from: "runtime" }, "another runtime: its own defaults");
    assert.deepEqual(x.settings(old.id).next, x.settings(follows.id).next);
    const fromProject = { model: "proj-m", effort: "medium", model_from: "project", effort_from: "project" };
    assert.deepEqual(x.settings(own.id).inherited, fromProject, "what its own effort would go back to");
    assert.deepEqual(x.settings(codex.id).inherited, { model: null, effort: null, model_from: "runtime", effort_from: "runtime" }, "unknown runtime defaults");

    updateSettings(x.store, { conversations: { effort: "high" } });
    assert.equal(x.settings(follows.id).next.effort, "high", "a project change reaches what is inherited");
    assert.equal(x.settings(own.id).next.effort, "low", "not an own value");
    assert.equal(x.store.readSession(own.id).effort, "low");

    x.conversations.update(own.id, { model: "own-m", effort: null });
    assert.deepEqual(x.settings(own.id).next, { model: "own-m", effort: "high", model_from: "own", effort_from: "project" }, "the effort back to the project's");
    x.conversations.update(own.id, { model: "", effort: null });
    assert.deepEqual(x.settings(own.id).next, x.settings(follows.id).next, "both back to the defaults");
    const s = x.store.readSession(own.id);
    assert.ok(!("model" in s && s.model !== undefined) && !("effort" in s && s.effort !== undefined), "no own values left in its file");

    x.conversations.update(old.id, { model: "x" });
    assert.equal(x.store.readSession(follows.id).model, undefined, "another conversation unchanged");
    assert.equal(x.store.readProject().conversations.model, "proj-m", "the project's default unchanged");
    assert.equal(x.store.readProject().conversations.effort, "high");
  } finally { x.stop(); }
});

test("the pair is checked whole before anything is written: the runtime's levels, the model's, a bad value", async () => {
  const x = setup();
  // A Claude Code that names its models and their effort levels (models.ts asks it with `initialize`).
  const catalog = join(x.root, "claude-models.mjs");
  writeFileSync(catalog, `
import { writeSync } from "node:fs";
process.stdin.setEncoding("utf8");
process.stdin.on("data", () => {
  writeSync(1, JSON.stringify({ type: "control_response", response: { response: { models: [
    { value: "small", displayName: "Small", supportedEffortLevels: ["low", "medium"] },
    { value: "big", displayName: "Big", supportedEffortLevels: ["low", "medium", "high", "max"] },
  ] } } }) + "\\n");
  process.exit(0);
});
`);
  const bin = process.env.NEXUS_CLAUDE;
  process.env.NEXUS_CLAUDE = catalog;
  try { assert.equal((await listModels("claude")).length, 2); } finally { process.env.NEXUS_CLAUDE = bin; }
  try {
    updateSettings(x.store, { conversations: { effort: "high" } });
    const c = x.conversations.create({ title: "Pair", model: "big" });
    const before = JSON.stringify(x.store.readSession(c.id));
    const refused = (body: Record<string, unknown>, re: RegExp) => {
      assert.throws(() => x.conversations.update(c.id, body), (e: ActionError) => e.status === 400 && re.test(e.message), JSON.stringify(body));
      assert.equal(JSON.stringify(x.store.readSession(c.id)), before, "nothing written");
    };
    refused({ effort: "ultra" }, /Claude Code takes effort/);
    refused({ effort: "huge" }, /effort is one of/);
    refused({ model: 7 }, /model is a model's name/);
    refused({ model: "small", effort: "max" }, /Small takes effort low, medium/);
    refused({ model: "small" }, /Small takes effort low, medium/); // with the inherited high
    refused({ model: "small", title: "Renamed" }, /Small/);
    assert.throws(() => x.conversations.create({ title: "Bad", model: "small" }), /Small takes effort/, "a start is checked the same way");

    x.conversations.update(c.id, { model: "small", effort: "low" });
    assert.deepEqual(x.settings(c.id).next, { model: "small", effort: "low", model_from: "own", effort_from: "own" });
    x.conversations.update(c.id, { model: "unknown-model", effort: "max" });
    assert.equal(x.store.readSession(c.id).model, "unknown-model", "a model the catalog does not name: the runtime decides");
    assert.equal(x.starts().length, 0, "no check started a process");
  } finally { x.stop(); }
});

test("claude: a save while the process settles after a turn (KM4) starts no second process; the next turn runs on the saved pair", async () => {
  // FAKE_LATE_NEXT with a gate: the first turn's result waits for a message, which then runs as a late turn of its own
  // once the gate file exists. The moment it may start in is held open (lateTurnMs), so the save and the message after
  // it come while the process settles.
  const x = setup({ host: { lateTurnMs: 4 * LONGER.run } });
  const gate = join(x.root, "late-gate");
  process.env.FAKE_LATE_NEXT = "1";
  process.env.FAKE_LATE_GATE = gate;
  process.env.FAKE_CHAT_SLOW_MS = "300";
  try {
    const c = x.conversations.create({ title: "Settling" });
    x.conversations.say(c.id, "first");
    await x.until("the first reply, its turn still open", () => x.replies(c.id).length === 1);
    delete process.env.FAKE_LATE_NEXT; delete process.env.FAKE_LATE_GATE; // for the next process
    x.conversations.say(c.id, "FAKE-SLOW: second");
    const proc = x.procs[0]!;
    await x.until("the process settling", () => proc.state === "idle" && !!proc.settling, LONGER.step);
    x.conversations.update(c.id, { effort: "low" });
    x.conversations.say(c.id, "third");
    assert.equal(x.starts().length, 1, "nothing started while it settles");
    assert.ok(!x.conversations.idle(), "the waiting message keeps the conversations busy");
    writeFileSync(gate, "");
    await x.until("all three answered", () => x.replies(c.id).length === 3, LONGER.step);
    assert.equal(x.replies(c.id)[1], "slow reply", "the late turn ran in the process it was sent to");
    assert.equal(x.starts().length, 2);
    assert.equal(x.overlap(), 1);
    assert.equal(ranOn(x, "claude").effort, "low", "the turn after it on the saved pair");
    assert.equal(resumed(x, "claude"), c.native_id);
  } finally { delete process.env.FAKE_LATE_NEXT; delete process.env.FAKE_LATE_GATE; delete process.env.FAKE_CHAT_SLOW_MS; x.stop(); }
});

test("claude: a save while the process settles with no late turn: the message waits for the moment's end, then runs on the saved pair", async () => {
  process.env.FAKE_LATE_NEXT = "inside";
  const x = setup({ host: { lateTurnMs: 300 } });
  try {
    const c = x.conversations.create({ title: "Settled" });
    x.conversations.say(c.id, "first");
    await x.until("the first reply, its turn still open", () => x.replies(c.id).length === 1);
    delete process.env.FAKE_LATE_NEXT;
    x.conversations.say(c.id, "second");
    const proc = x.procs[0]!;
    await x.until("the process settling", () => proc.state === "idle" && !!proc.settling, LONGER.step);
    x.conversations.update(c.id, { effort: "max" });
    x.conversations.say(c.id, "third");
    await x.until("the third answered", () => x.replies(c.id).length === 2, LONGER.step);
    assert.equal(x.starts().length, 2);
    assert.equal(x.overlap(), 1);
    assert.equal(ranOn(x, "claude").effort, "max");
  } finally { delete process.env.FAKE_LATE_NEXT; x.stop(); }
});

test("claude: a hand-over asked before a save runs in the old process; one asked after it waits for the new one; neither is lost", async () => {
  process.env.FAKE_CHAT_SLOW_MS = "1200";
  const x = setup({ notes: "Dev/Notes" });
  const summaries = () => x.store.readChat(x.orchestrator.session()?.id ?? "-").entries.filter((e) => e.from === "user").length;
  try {
    const c = x.conversations.create({ title: "Hand" });
    x.conversations.say(c.id, "FAKE-SLOW");
    await x.until("the slow turn at work", () => x.store.readChat(c.id).entries.some((e) => e.kind === "tool"), LONGER.step);
    x.conversations.handoff(c.id);
    x.conversations.update(c.id, { effort: "low" });
    // A message after the save: the old process is to end after its turn, and the hand-over queued in it still runs.
    x.conversations.say(c.id, "After the save");
    await x.until("the first summary handed over", () => summaries() === 1, LONGER.step);
    assert.equal(x.replies(c.id).filter((r) => r === longReply("SUMMARY")).length, 1, "the summary, not mixed with the reply");
    assert.ok(x.replies(c.id).includes("slow reply"));
    const own = () => x.starts().filter((a) => (a.argv as string[]).includes(c.native_id!));
    await x.until("the message after the save answered", () => x.replies(c.id).length === 3 && x.conversations.idle(), LONGER.step);
    assert.deepEqual(x.replies(c.id).slice(0, 2), ["slow reply", longReply("SUMMARY")], "the reply, then the summary");
    assert.equal(own().length, 2, "the hand-over queued before the save ran in the old process; the message after it in a new one");
    assert.equal(ranOn(x, "claude", c.native_id!).effort, "low");

    x.conversations.say(c.id, "FAKE-SLOW again");
    await x.until("the next slow turn at work", () => x.store.readChat(c.id).entries.filter((e) => e.kind === "tool" && e.text.includes("FAKE-SLOW")).length === 2, LONGER.step);
    x.conversations.update(c.id, { effort: "high" });
    x.conversations.handoff(c.id);
    await x.until("the second summary handed over", () => summaries() === 2, LONGER.step);
    assert.equal(own().length, 3, "the first save's process, then the second's");
    assert.equal(ranOn(x, "claude", c.native_id!).effort, "high", "the hand-over's turn on the saved pair");
    assert.equal(x.overlap(), 1);
  } finally { delete process.env.FAKE_CHAT_SLOW_MS; x.stop(); }
});

for (const runtime of ["claude", "codex"] as const) {
  test(`${runtime}: Compact after a save runs on the saved pair in the same session; the talk goes on`, async () => {
    const x = setup({ runtime });
    try {
      const c = x.conversations.create({ title: "Compact", runtime });
      x.conversations.say(c.id, "Hello");
      await x.until("the reply", () => x.replies(c.id).length === 1 && x.conversations.head(c.id).state === "idle");
      const native = x.store.readSession(c.id).native_id;
      x.conversations.update(c.id, { effort: "low" });
      x.conversations.compact(c.id);
      await x.until("compacted", () => x.store.readChat(c.id).entries.some((e) => e.from === "nexus" && /compacted/.test(e.text)), LONGER.step);
      assert.equal(x.starts().length, 2);
      assert.equal(resumed(x, runtime), native);
      if (runtime === "claude") assert.equal(ranOn(x, runtime).effort, "low");
      x.conversations.say(c.id, "Go on");
      await x.until("the next reply", () => x.replies(c.id).length === 2);
      assert.equal(ranOn(x, runtime).effort, "low");
      assert.equal(x.starts().length, 2);
    } finally { x.stop(); }
  });
}

test("claude: a restart while a message waits for the new process: the next server answers it, on the saved pair", async () => {
  process.env.FAKE_CHAT_SLOW_MS = "20000";
  const x = setup();
  try {
    const c = x.conversations.create({ title: "Restart" });
    x.conversations.say(c.id, "FAKE-SLOW");
    await x.until("the slow turn at work", () => x.store.readChat(c.id).entries.some((e) => e.kind === "tool"), LONGER.step);
    x.conversations.update(c.id, { effort: "low" });
    x.conversations.say(c.id, "Waiting one");
    x.conversations.cutOff();
    assert.deepEqual(x.store.readRuntime(c.id)?.interrupted?.asked, ["FAKE-SLOW", "Waiting one"], "the record keeps the waiting message");
    x.conversations.shutdown();
    await x.until("the old process ended", () => !x.conversations.alive(), LONGER.processes);
    delete process.env.FAKE_CHAT_SLOW_MS;
    const next = x.restart();
    next.resumeCutOff();
    await x.until("the restarted turn's reply", () => x.replies(c.id).length === 1, LONGER.step);
    const notice = x.heard().at(-1)!;
    assert.ok(notice.includes("FAKE-SLOW") && notice.includes("Waiting one"), "the notice quotes both");
    assert.equal(ranOn(x, "claude").effort, "low");
    assert.equal(resumed(x, "claude"), c.native_id);
  } finally { delete process.env.FAKE_CHAT_SLOW_MS; x.stop(); }
});

test("a save reaches the dashboard in the live stream: the conversation's head carries the next turn's pair (a real server)", async () => {
  const root = mkdtempSync(join(tmpdir(), "nexus-conv-settings-live-")), home = join(root, "home");
  process.env.NEXUS_HOME = home;
  const store = ProjectStore.init(root, { id: "p", name: "Live", root });
  updateSettings(store, { orchestrator: { notify: false }, conversations: { effort: "medium" } });
  writeRegistry({ protocol: 1, projects: [{ id: "p", root }] });
  const port = await freePort(), url = `http://127.0.0.1:${port}`;
  const child = spawnServer({ NEXUS_HOME: home, NEXUS_DIR: store.dir, NEXUS_PORT: String(port), NEXUS_LOG: "",
    NEXUS_CLAUDE: join(here, "fake-claude.ts"), NEXUS_CODEX: join(here, "fake-codex.ts") });
  const messages: LiveMessage[] = [];
  let ws: WebSocket | undefined;
  try {
    await serverUp(`${url}/api/projects`);
    const call = async (method: string, path: string, body: object) => {
      const r = await fetch(`${url}/api/projects/p${path}`, { method, headers: { "content-type": "application/json", origin: url }, body: JSON.stringify(body) });
      return { status: r.status, body: await r.json() as { result?: { id: string }; error?: string } };
    };
    const created = await call("POST", "/conversations", { title: "Live" });
    const id = created.body.result!.id;
    ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    ws.addEventListener("message", (e) => messages.push(JSON.parse(String(e.data)) as LiveMessage));
    await until("the socket's hello", () => messages[0]?.type === "hello");
    const heads = () => messages.filter((m): m is Extract<LiveMessage, { type: "session" }> => m.type === "session" && m.session === id)
      .map((m) => (m.head as { settings: ConversationSettings }).settings);
    // The stream's first publication after the socket opened has nothing to diff against (the views read in full):
    // a rename makes it, so the save after it goes out as a delta with the conversation's head.
    assert.equal((await call("PATCH", `/conversations/${id}`, { title: "Live chat" })).status, 200);
    await until("the first publication", () => messages.some((m) => m.type === "state"), LONGER.step);

    assert.equal((await call("PATCH", `/conversations/${id}`, { model: "fake-b", effort: "high" })).status, 200);
    await until("the head with the saved pair", () => heads().some((s) => s.next.effort === "high"), LONGER.step);
    assert.deepEqual(heads().at(-1), {
      running: null, next: { model: "fake-b", effort: "high", model_from: "own", effort_from: "own" }, changes: false,
      inherited: { model: null, effort: "medium", model_from: "runtime", effort_from: "project" },
    });

    const refused = await call("PATCH", `/conversations/${id}`, { effort: "ultra" });
    assert.equal(refused.status, 400);
    assert.match(refused.body.error!, /Claude Code takes effort/);

    assert.equal((await call("PATCH", `/conversations/${id}`, { model: null, effort: null })).status, 200);
    await until("the head back on the defaults", () => heads().at(-1)?.next.effort_from === "project", LONGER.step);
    assert.deepEqual(heads().at(-1)!.next, { model: null, effort: "medium", model_from: "runtime", effort_from: "project" });
    assert.equal(store.readChat(id).entries.length, 0, "no turn");
  } finally {
    ws?.close();
    if (child.exitCode === null) { const gone = new Promise<void>((r) => child.once("exit", () => r())); child.kill(); await gone; }
  }
});

for (const runtime of ["claude", "codex"] as const) {
  test(`${runtime}: an idea chat saved before its first message runs that message on the saved pair with its idea context`, async () => {
    const x = setup({ runtime, notes: "notes" });
    try {
      mkdirSync(join(x.root, "notes"));
      writeFileSync(join(x.root, "notes/a.md"), "# Scoped idea\n**Summary:** Initial summary.\n## Decided\n### 2026-11-14\n- A decision.\n");
      const c = x.conversations.create({ idea: { file: "notes/a.md" }, request_id: "idea-pair" });
      x.conversations.update(c.id, { model: "fake-i", effort: "medium" });
      assert.equal(x.starts().length, 0);
      x.conversations.say(c.id, "About the idea");
      await x.until("the reply", () => x.replies(c.id).length === 1, LONGER.step);
      assert.deepEqual(ranOn(x, runtime), { model: "fake-i", effort: "medium" });
      assert.ok(x.heard().some((t) => t.includes("Initial summary") && t.includes("About the idea")), "the idea context went with it");
      assert.deepEqual(x.store.readSession(c.id).about?.idea?.file, "notes/a.md", "its topic link kept");
    } finally { x.stop(); }
  });
}
