// The work a stopped step left, and the user's Keep or Discard where the stop is lifted (src/stopwork.ts,
// leftBehind in src/gitinfo.ts), against the fake runtimes and a temporary repository with no remote.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectStore, applyDraft, approveQueue, loadProjectState, newId, routeAnswers, updateSettings } from "@nexus/protocol";
import { Engine } from "../src/engine.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import { leftBehind, recordStepEnd, recordStepStart, UNCOMMITTED_NOTE } from "../src/gitinfo.ts";
import { decideStoppedWork } from "../src/stopwork.ts";

process.env.NEXUS_CLAUDE = join(dirname(fileURLToPath(import.meta.url)), "fake-claude.ts");
const G = ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "-c", "init.defaultBranch=main", "-c", "commit.gpgsign=false"];
const git = (cwd: string, args: string[], env: Record<string, string> = {}) =>
  execFileSync("git", [...G, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } }).trim();

function setup(goals: string[]) {
  const base = mkdtempSync(join(tmpdir(), "nexus-stopwork-"));
  process.env.NEXUS_HOME = join(base, "home");
  process.env.FAKE_LOG = join(base, "fake.log");
  process.env.FAKE_ARGS = join(base, "args.log");
  const root = join(base, "project");
  mkdirSync(root);
  git(root, ["init", "-q", "-b", "main"]);
  writeFileSync(join(root, ".gitignore"), ".nexus/\n");
  git(root, ["add", "-A"]); git(root, ["commit", "-q", "-m", "start"]);
  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  store.writeQueue({ protocol: 1, id: "Q", title: "Queue", revision: 1, status: "proposed", stop_conditions: [], checks: [], approvals: [], history: [],
    steps: goals.map((g, i) => ({ id: `Q${i + 1}`, title: `Step ${i + 1}`, goal: `FAKE: ${g}`, acceptance: [] })) });
  approveQueue(store, "Q");
  let orchestrator: Orchestrator;
  const engine: Engine = new Engine(store, () => tick());
  orchestrator = new Orchestrator(store, engine, () => tick());
  function tick() { routeAnswers(store); orchestrator.onChange(loadProjectState(store)); engine.onChange(loadProjectState(store)); }
  const timer = setInterval(tick, 150);
  const queue = () => loadProjectState(store).queues[0]!;
  const until = async (what: string, pred: () => boolean, ms = 30_000) => {
    const t = Date.now();
    while (!pred()) {
      if (Date.now() - t > ms) assert.fail(`timed out waiting for ${what}; queue ${queue().status}, run ${JSON.stringify(queue().run)}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  const delivered = () => existsSync(process.env.FAKE_LOG!)
    ? readFileSync(process.env.FAKE_LOG!, "utf8").split("\n").filter(Boolean).map((l) => (JSON.parse(l) as { text: string }).text) : [];
  /** Runs the queue until its first step stopped and that turn's end was recorded. */
  const stopped = async () => {
    engine.start("Q");
    await until("the stop", () => queue().status === "stopped" && store.readGit("Q")?.steps.Q1?.[0]?.end !== undefined && engine.idle());
  };
  const stop = () => { clearInterval(timer); engine.shutdown(); orchestrator.shutdown(); delete process.env.FAKE_ARGS; };
  return { base, root, store, engine, orchestrator, queue, until, delivered, stopped, stop };
}

test("a stopped step with commits needs Keep or Discard; Keep records it and lifts; uncommitted changes are listed with the label", async () => {
  const x = setup(["commitstop", "done"]);
  try {
    await x.stopped();
    writeFileSync(join(x.root, "scratch.txt"), "left by someone\n");
    const left = leftBehind(x.store, x.queue())!;
    assert.equal(left.step, "Q1");
    assert.deepEqual(left.commits.map((c) => c.subject), ["Q1 work"]);
    assert.deepEqual(left.uncommitted, [{ status: "??", path: "scratch.txt" }]);
    assert.equal(left.uncommitted_note, UNCOMMITTED_NOTE);
    assert.equal(UNCOMMITTED_NOTE, "in the checkout, not necessarily this step's");

    assert.throws(() => decideStoppedWork(x.store, "Q", undefined, "user_continue"), /step Q1 left 1 commit of its own: choose Keep or Discard/);
    assert.throws(() => decideStoppedWork(x.store, "Q", "maybe", "user_continue"), /work is keep or discard/);
    assert.equal(x.queue().changes.length, 0, "nothing recorded");
    assert.deepEqual(decideStoppedWork(x.store, "Q", "keep", "user_continue"), { proceed: true });
    const kept = x.queue().changes.at(-1)!;
    assert.deepEqual([kept.kind, kept.by, kept.step, kept.to, kept.commits], ["work", "user_continue", "Q1", "kept", [left.commits[0]!.sha]]);
    x.engine.continueQueue("Q");
    await x.until("the run to go on", () => x.queue().status !== "stopped" && x.queue().changes.some((c) => c.kind === "lift"));
    assert.ok(git(x.root, ["log", "--format=%s", "-n", "5"]).split(/\r?\n/).includes("Q1 work"), "the commit stays");
  } finally { x.stop(); }
});

test("Discard records it, keeps the stop and tells the orchestrator once; approving the revert revision lifts without asking", async () => {
  const x = setup(["commitstop", "done"]);
  try {
    updateSettings(x.store, { orchestrator: { notify: false } });
    await x.stopped();
    const sha = leftBehind(x.store, x.queue())!.commits[0]!.sha;
    const d = decideStoppedWork(x.store, "Q", "discard", "user_continue");
    assert.equal(d.proceed, false);
    assert.match((d as { message: string }).message, /the stop stays; the orchestrator drafts a revision that reverts its 1 commit/);
    assert.equal(x.queue().status, "stopped");
    assert.deepEqual([x.queue().changes.at(-1)!.to, x.queue().changes.at(-1)!.commits], ["discarded", [sha]]);

    await x.until("the orchestrator told", () => x.delivered().some((t) => t.startsWith("[Nexus] The user chose to discard the work of stopped step Q1 of queue Q.")));
    const told = x.delivered().find((t) => t.startsWith("[Nexus] The user chose to discard"))!;
    assert.ok(told.includes(`- ${sha}`), "with the commits");
    assert.match(told, /git revert of these commits only/);
    assert.match(told, /never cleans, resets or deletes files it cannot attribute/);
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(x.delivered().filter((t) => t.startsWith("[Nexus] The user chose to discard")).length, 1, "once");

    // The orchestrator's revert revision; approving it asks nothing and lifts the stop.
    applyDraft(x.store, { id: "Q", title: "Queue", steps: [
      { id: "Q1", title: "Step 1", goal: "FAKE: commitstop" }, { id: "Q1r", title: "Revert Q1", goal: "FAKE: done" }, { id: "Q2", title: "Step 2", goal: "FAKE: done" },
    ] });
    assert.deepEqual(decideStoppedWork(x.store, "Q", undefined, "user_approval"), { proceed: true });
    approveQueue(x.store, "Q");
    assert.notEqual(x.queue().status, "stopped");
    assert.equal(x.queue().changes.filter((c) => c.kind === "work").length, 1, "no second choice recorded");
  } finally { x.stop(); }
});

test("no commits of its own: nothing is asked", async () => {
  const x = setup(["stop", "done"]);
  try {
    await x.stopped();
    assert.deepEqual(leftBehind(x.store, x.queue())!.commits, []);
    assert.deepEqual(decideStoppedWork(x.store, "Q", undefined, "user_continue"), { proceed: true });
    assert.equal(x.queue().changes.length, 0);
  } finally { x.stop(); }
});

test("foreign commits are not listed among a stopped step's work", () => {
  const base = mkdtempSync(join(tmpdir(), "nexus-stopwork-"));
  process.env.NEXUS_HOME = join(base, "home");
  const root = join(base, "project");
  mkdirSync(root);
  git(root, ["init", "-q", "-b", "main"]);
  writeFileSync(join(root, ".gitignore"), ".nexus/\n");
  git(root, ["add", "-A"]); git(root, ["commit", "-q", "-m", "start"]);
  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  store.writeQueue({ protocol: 1, id: "Q", title: "Queue", revision: 1, status: "approved", stop_conditions: [], checks: [], approvals: [], history: [],
    steps: [{ id: "Q1", title: "Step 1", goal: "", acceptance: [] }] });
  const now = Date.now();
  const at = (ms: number) => new Date(now + ms);
  const commit = (name: string, when: Date) => {
    writeFileSync(join(root, name), name);
    const env = { GIT_COMMITTER_DATE: when.toISOString(), GIT_AUTHOR_DATE: when.toISOString() };
    git(root, ["add", "-A"], env); git(root, ["commit", "-q", "-m", name], env);
  };
  const w = "S1";
  store.writeSession({ protocol: 1, id: w, project: "p", role: "worker", runtime: "external", cwd: root, launched_by: "external", created_at: at(-120_000).toISOString() });
  recordStepStart(store, "Q", "Q1", w);
  store.appendActivity(w, { at: at(-60_000).toISOString(), kind: "turn_start", text: "turn started", queue: "Q", step: "Q1" });
  commit("mine.txt", at(-40_000));
  store.appendEvent({ v: 1, id: newId(), at: at(-35_000).toISOString(), session: w, type: "step.started", queue: "Q", step: "Q1" });
  store.appendEvent({ v: 1, id: newId(), at: at(-30_000).toISOString(), session: w, type: "queue.stop", queue: "Q", step: "Q1", condition: "c", reason: "r" });
  store.appendActivity(w, { at: at(-25_000).toISOString(), kind: "turn_end", text: "turn ended", queue: "Q", step: "Q1" });
  commit("theirs.txt", at(-10_000)); // the user's, after the turn
  recordStepEnd(store, "Q", "Q1");
  const q = loadProjectState(store).queues[0]!;
  assert.equal(q.status, "stopped");
  assert.deepEqual(leftBehind(store, q)!.commits.map((c) => c.subject), ["mine.txt"]);
});

test("the worker briefing asks to commit and leave the tree clean before stopping; the orchestrator's says how to revert", async () => {
  const x = setup(["done"]);
  try {
    x.orchestrator.say("Hello");
    x.engine.start("Q");
    await x.until("both started", () => existsSync(process.env.FAKE_ARGS!) && readFileSync(process.env.FAKE_ARGS!, "utf8").trim().split("\n").length >= 2);
    const prompts = readFileSync(process.env.FAKE_ARGS!, "utf8").trim().split("\n").map((l) => (JSON.parse(l) as { argv?: string[] }).argv ?? [])
      .map((a) => a[a.indexOf("--append-system-prompt") + 1] ?? "");
    const worker = prompts.find((p) => p.startsWith("You are a worker session"))!;
    const orchestrator = prompts.find((p) => p.startsWith("You are the orchestrator"))!;
    assert.match(worker, /Before you stop \(nexus stop, or a stop condition you meet\): commit what is in a consistent state/);
    assert.match(worker, /leave the working tree clean \(no uncommitted changes\)/);
    assert.match(orchestrator, /draft a revision whose first pending step reverts exactly those commits with git revert, nothing else/);
    assert.match(orchestrator, /never cleans, resets or deletes files it cannot attribute to those commits/);
    assert.match(orchestrator, /ask the user about them instead/);
  } finally { x.stop(); }
});
