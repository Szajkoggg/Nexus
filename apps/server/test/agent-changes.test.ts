// What changed for agents, told at a deploy (N4.3): the Agents: lines of the deployed commits reach every project's
// orchestrator session older than the deploy, once; with notices on they start its turn, with them off they wait for
// its next turn; the user's chat shows none of it. A temporary repository stands in for the live worktree; the
// orchestrators run on the fake `claude`; wired as main.ts wires them (news from lifecycle.notice and
// deploy-changes.jsonl; a settled update runs every project's notices).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectStore, loadProjectState, newId, now, type SessionFile } from "@nexus/protocol";
import { Engine } from "../src/engine.ts";
import { Lifecycle } from "../src/lifecycle.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import { deployChangesFile, parseAgentLines, readDeployChanges } from "../src/deploy.ts";

const here = dirname(fileURLToPath(import.meta.url));
process.env.NEXUS_CLAUDE = join(here, "fake-claude.ts");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(what: string, pred: () => boolean, ms = 20_000, detail = () => ""): Promise<void> {
  const t = Date.now();
  while (!pred()) { if (Date.now() - t > ms) assert.fail(`timed out waiting for ${what}${detail()}`); await sleep(100); }
}

const B_LINE = "nexus queue draft takes a file";
const D_LINE = "the orchestrator uploads drafts from files (.nexus/drafts/), not heredocs";

/**
 * A live worktree's repository: A (the old version), B with an Agents: line, C without, D with a wrapped one; and
 * branch side, off A, which D does not contain. Detached at D, as after the deploy.
 */
function repo(base: string) {
  const root = join(base, "checkout");
  mkdirSync(root);
  const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...a], { cwd: root, encoding: "utf8" }).trim();
  const commit = (file: string, message: string) => { writeFileSync(join(root, file), file); git("add", "-A"); git("commit", "-q", "-m", message); return git("rev-parse", "HEAD"); };
  git("init", "-q", "-b", "main");
  const a = commit("a", "A: the old version");
  const b = commit("b", `B: drafts from a file\n\nWhy it changed.\n\nAgents: ${B_LINE}\n\nCo-Authored-By: Someone <x@example.invalid>`);
  const c = commit("c", "C: the dashboard only\n\nNothing an agent relies on.");
  const d = commit("d", "D: no heredocs\n\nAgents: the orchestrator uploads drafts from files\n  (.nexus/drafts/), not heredocs\nCo-Authored-By: Someone <x@example.invalid>");
  git("checkout", "-q", "-b", "side", a);
  const side = commit("s", "S: elsewhere\n\nAgents: never deployed");
  git("checkout", "-q", "--detach", d);
  return { root, git, a, b, c, d, side };
}

/** Projects with orchestrator sessions, each with its Engine and Orchestrator, and the Lifecycle around them. */
function setup(opts: { projects: { id: string; notify?: boolean; orchestrator?: boolean }[] }) {
  const base = mkdtempSync(join(tmpdir(), "nexus-changes-"));
  process.env.NEXUS_HOME = join(base, "home");
  const log = join(base, "fake.log");
  process.env.FAKE_LOG = log;
  const r = repo(base);
  let lifecycle!: Lifecycle;
  const projects = opts.projects.map((o) => {
    const root = join(base, o.id);
    mkdirSync(root);
    const store = ProjectStore.init(root, { id: o.id, name: o.id.toUpperCase(), root });
    const session = o.orchestrator === false ? undefined : addOrchestrator(store, o.notify ?? true);
    const engine = new Engine(store, () => {});
    const make = () => new Orchestrator(store, engine, () => {}, { update: () => lifecycle.notice(), changes: readDeployChanges });
    return { id: o.id, store, engine, session, orchestrator: make(), make };
  });
  const onChange = () => { for (const p of projects) p.orchestrator.onChange(loadProjectState(p.store)); };
  lifecycle = new Lifecycle(() => projects.map((p) => ({ id: p.id, idle: () => true, drain: () => [], cancel: () => {}, shutdown: () => {} })), () => {}, {
    root: r.root, successor: [process.execPath, join(here, "fake-successor.ts")], timeoutMs: 15_000,
    npm: async () => {}, exit: () => {}, settled: onChange,
  });
  /** A successful deploy from `from` to the commit checked out now, as a successor sees it once it took over. */
  const deploy = async (from: string | undefined, by?: { project: string; session: string }) => {
    const to = r.git("rev-parse", "HEAD");
    lifecycle.arrived({ commit: to.slice(0, 7), subject: "new" }, { pid: 1, commit: "old", subject: "old", at: now(), update: { id: newId(), by, from, to } }, { at: now(), log: [] });
    await lifecycle.pushing;
  };
  const received = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { text: string; priority: string | null; busy: boolean }) : []);
  const changesMsgs = () => received().filter((m) => m.text.includes("What changed for agents"));
  const stop = () => { for (const p of projects) { p.orchestrator.shutdown(); p.engine.shutdown(); } delete process.env.FAKE_LOG; };
  return { base, r, projects, lifecycle, deploy, received, changesMsgs, onChange, stop };
}

function addOrchestrator(store: ProjectStore, notify = true): string {
  const p = store.readProject();
  const s: SessionFile = {
    protocol: 1, id: newId(), project: p.id, role: "orchestrator", runtime: "claude", native_id: randomUUID(),
    title: "Orchestrator", cwd: p.root, launched_by: "nexus", created_at: now(),
  };
  store.writeSession(s);
  store.writeProject({ ...p, orchestrator: { runtime: "claude", notify, session: s.id } });
  return s.id;
}
const keys = (store: ProjectStore, session: string) => store.readApplied(session).entries.map((a) => a.event).filter((k) => k.startsWith("deploy-changes:"));
const chatMentions = (store: ProjectStore, session: string) => store.readChat(session).entries.filter((c) => /changed for agents|Agents:|uploads drafts/.test(c.text));

test("Agents: lines are read whole, wrapped lines joined, trailers left out", () => {
  assert.deepEqual(parseAgentLines(`S\n\nAgents: one\n\nAgents: two\n  continued\nCo-Authored-By: x\nAgents:\n`), ["one", "two continued"]);
  assert.deepEqual(parseAgentLines("S\n\nBody that mentions Agents: in the middle"), []);
});

test("a deploy's Agents: lines reach every project's orchestrator once, start its turn, and never the user's chat", async () => {
  const t = setup({ projects: [{ id: "p1" }, { id: "p2" }] });
  try {
    await t.deploy(t.r.a);
    await until("both orchestrators told", () => t.changesMsgs().length === 2, 20_000, () => `; log: ${t.lifecycle.status.log.join(" | ")}`);
    for (const m of t.changesMsgs()) {
      assert.ok(m.text.startsWith(`[Nexus] Nexus was deployed (${t.r.a.slice(0, 7)}..${t.r.d.slice(0, 7)})`), m.text);
      assert.ok(m.text.indexOf(B_LINE) > 0 && m.text.indexOf(B_LINE) < m.text.indexOf(D_LINE), "both lines, oldest first, the wrapped one joined");
      assert.ok(!m.text.includes("never deployed"), "nothing from outside the range");
      assert.equal(m.priority, null, "it starts a turn");
    }
    for (const p of t.projects) {
      assert.deepEqual(keys(p.store, p.session!), [`deploy-changes:${t.r.d}`]);
      assert.deepEqual(chatMentions(p.store, p.session!), [], "no chat line for the user");
    }
    assert.ok(t.lifecycle.status.log.some((l) => /2 changes for agents in .*; every project's orchestrator is told/.test(l)));

    // A restart repeats nothing: new orchestrators on the same files, and the same deploy taken over again.
    for (const p of t.projects) { p.orchestrator.shutdown(); p.orchestrator = p.make(); }
    t.onChange();
    await t.deploy(t.r.a);
    await sleep(1000);
    assert.equal(t.changesMsgs().length, 2);
    assert.equal(readDeployChanges().length, 1, "recorded once");
  } finally { t.stop(); }
});

test("with notices off the changes wait for the orchestrator's next turn, without waking it; two deploys arrive once each, in order", async () => {
  const t = setup({ projects: [{ id: "p", notify: false }] });
  const p = t.projects[0]!;
  try {
    t.r.git("checkout", "-q", "--detach", t.r.c);
    await t.deploy(t.r.a);          // A..C: B's line
    t.r.git("checkout", "-q", "--detach", t.r.d);
    await t.deploy(t.r.c);          // C..D: D's line
    t.onChange();
    await sleep(1000);
    assert.equal(t.received().length, 0, "not woken");
    assert.deepEqual(keys(p.store, p.session!), [], "held, so not recorded as told");

    p.orchestrator.say("What is next?");
    await until("the user's turn", () => t.received().length > 0);
    const first = t.received()[0]!;
    const i1 = first.text.indexOf(`(${t.r.a.slice(0, 7)}..${t.r.c.slice(0, 7)})`), i2 = first.text.indexOf(`(${t.r.c.slice(0, 7)}..${t.r.d.slice(0, 7)})`);
    assert.ok(first.text.startsWith("[Nexus] Nexus was deployed") && i1 >= 0 && i2 > i1, "both deploys, in order");
    assert.ok(first.text.indexOf(B_LINE) < first.text.indexOf(D_LINE));
    assert.ok(first.text.endsWith("\n\nWhat is next?"), "then the user's message, in the same turn");
    assert.deepEqual(keys(p.store, p.session!), [`deploy-changes:${t.r.c}`, `deploy-changes:${t.r.d}`]);
    const chat = p.store.readChat(p.session!).entries;
    assert.deepEqual(chat.filter((c) => c.from !== "orchestrator").map((c) => `${c.from}: ${c.text}`), ["user: What is next?"], "the chat shows the user's message as written, and no notice");
    assert.deepEqual(chatMentions(p.store, p.session!), []);

    p.orchestrator.say("And then?");
    await until("the second turn", () => t.received().length >= 2);
    assert.equal(t.changesMsgs().length, 1, "once each");
  } finally { t.stop(); }
});

test("nothing is sent without Agents: lines, after a rollback, or without a usable old commit", async () => {
  const t = setup({ projects: [{ id: "p" }] });
  try {
    t.r.git("checkout", "-q", "--detach", t.r.c);
    await t.deploy(t.r.b);          // B..C: no lines
    assert.ok(t.lifecycle.status.log.some((l) => /no Agents: lines in .*; nothing to tell the orchestrators/.test(l)));
    await t.deploy(undefined);      // a hand-over from a server older than N4
    assert.ok(t.lifecycle.status.log.some((l) => /no changes for agents sent: the predecessor did not record the commit it ran/.test(l)));
    await t.deploy(t.r.side);       // not an ancestor
    assert.ok(t.lifecycle.status.log.some((l) => new RegExp(`no changes for agents sent: the old commit ${t.r.side.slice(0, 7)} is not an ancestor`).test(l)));
    await t.deploy("0123456789abcdef0123456789abcdef01234567"); // unknown here
    assert.ok(t.lifecycle.status.log.some((l) => /is not in this repository/.test(l)));

    // A rollback: the successor crashes, the worktree goes back. Not a deploy, so nothing is collected.
    process.env.FAKE_SUCCESSOR = "crash";
    t.lifecycle.start({ ref: "side" });
    await until("the rollback", () => t.lifecycle.status.phase === "failed", 20_000, () => `; ${JSON.stringify(t.lifecycle.status)}`);
    await sleep(500);
    assert.ok(!existsSync(deployChangesFile()), "nothing recorded");
    assert.equal(t.changesMsgs().length, 0);
  } finally { delete process.env.FAKE_SUCCESSOR; t.stop(); }
});

test("an orchestrator session started after the deploy gets nothing", async () => {
  const t = setup({ projects: [{ id: "p", orchestrator: false }] });
  const p = t.projects[0]!;
  try {
    await t.deploy(t.r.a);
    assert.equal(readDeployChanges().length, 1);
    await sleep(20);
    p.session = addOrchestrator(p.store);  // has the new briefing already
    t.onChange();
    p.orchestrator.say("Hello");
    await until("its turn", () => t.received().length > 0);
    assert.equal(t.received()[0]!.text, "Hello");
    assert.equal(t.changesMsgs().length, 0);
  } finally { t.stop(); }
});

test("the orchestrator that ran the update gets its outcome and the changes in one message", async () => {
  const t = setup({ projects: [{ id: "p1" }, { id: "p2" }] });
  const [p1, p2] = t.projects as [typeof t.projects[0], typeof t.projects[0]];
  try {
    await t.deploy(t.r.a, { project: "p1", session: p1.session! });
    await until("both told", () => t.changesMsgs().length === 2);
    await sleep(500);
    const combined = t.received().filter((m) => m.text.includes("Nexus was updated as asked"));
    assert.equal(combined.length, 1, "one message to the one that asked");
    assert.ok(combined[0]!.text.includes("What changed for agents") && combined[0]!.text.includes(D_LINE));
    assert.equal(t.changesMsgs().length, 2, "and the other project gets the changes alone");
    assert.deepEqual(keys(p1.store, p1.session!), [`deploy-changes:${t.r.d}`]);
    assert.deepEqual(keys(p2.store, p2.session!), [`deploy-changes:${t.r.d}`]);
    // The user sees the outcome line in the asker's chat, never the changes.
    assert.ok(p1.store.readChat(p1.session!).entries.some((c) => c.from === "nexus" && /Nexus was updated as asked/.test(c.text)));
    assert.deepEqual(chatMentions(p1.store, p1.session!), []);
    assert.deepEqual(chatMentions(p2.store, p2.session!), []);
  } finally { t.stop(); }
});
