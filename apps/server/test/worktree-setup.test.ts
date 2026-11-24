// The project's worktree setup command (defaults.worktree_setup, queue PW1): run once in each new worktree Nexus makes
// for a queue, before its first step opens; a failure is tried once more, then halts the run with the reason (queue
// CK), and it runs again when the run goes on. A stand-in command (a small Node script) instead of a real install; the fake runtimes do the steps.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approveQueue, updateSettings, type ProjectStore } from "@nexus/protocol";
import { LONGER } from "./wait.ts";
import { setup } from "./engine-setup.ts";

/** A git repository at the project's root, a stand-in setup command, and the project's setting naming it. */
function withSetup(store: ProjectStore) {
  const root = store.readProject().root;
  const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...a], { cwd: root, stdio: "ignore" });
  git("init", "-q", "-b", "main"); writeFileSync(join(root, "a.txt"), "a\n"); git("add", "a.txt"); git("commit", "-qm", "init");
  const dir = mkdtempSync(join(tmpdir(), "nexus-setup-"));
  const script = join(dir, "setup.cjs"), log = join(dir, "setup.log"), fail = join(dir, "fail");
  writeFileSync(script, `const fs = require("fs"), path = require("path");
fs.appendFileSync(path.join(__dirname, "setup.log"), process.cwd() + "\\n");
const fail = path.join(__dirname, "fail");
if (fs.existsSync(fail)) {
  // An empty file: it fails every time; a number: it fails that many times more.
  const left = fs.readFileSync(fail, "utf8").trim();
  if (left) { if (Number(left) <= 1) fs.rmSync(fail); else fs.writeFileSync(fail, String(Number(left) - 1)); }
  console.log("installing"); console.error("boom: no network"); process.exit(3);
}
`);
  updateSettings(store, { defaults: { worktree_setup: `node "${script}"` } });
  const runs = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((l) => l.trim().replaceAll("\\", "/").toLowerCase()) : []);
  return { runs, fail, dir };
}

const lower = (p: string) => p.replaceAll("\\", "/").toLowerCase();

test("the setup command runs once in each new worktree, before its first step, and not in the project's checkout", async () => {
  const { store, engine, queue, until } = setup(["done", "done"]);
  const s = withSetup(store);
  store.writeQueue({ ...store.readQueue("Q"), worktree: "auto" });
  try {
    engine.start("Q", { runtime: "claude" });
    await until("Q to finish", () => queue().run?.state === "finished", LONGER.run);
    const wt = store.readQueue("Q").worktree!;
    assert.deepEqual(s.runs(), [lower(wt)], "once, in the queue's worktree, though the run went through two steps");
    const g = store.readGit("Q")!;
    assert.ok(g.setup?.done_at, "recorded as done");
    assert.ok(g.setup!.done_at! <= g.steps.Q1![0]!.started_at, "before the first step opened");

    // Another queue with a worktree of its own: its new worktree gets the command too.
    store.writeQueue({ protocol: 1, id: "R", title: "R", revision: 1, status: "proposed", stop_conditions: [], checks: [], approvals: [], history: [], worktree: "auto",
      steps: [{ id: "R1", title: "Step 1", goal: "FAKE: done", acceptance: [] }] });
    approveQueue(store, "R");
    engine.start("R", { runtime: "claude" });
    await until("R to finish", () => store.readRun("R")?.state === "finished", LONGER.run);
    assert.deepEqual(s.runs(), [lower(wt), lower(store.readQueue("R").worktree!)]);

    // A queue in the project's own checkout makes no worktree: nothing to set up.
    store.writeQueue({ protocol: 1, id: "P", title: "P", revision: 1, status: "proposed", stop_conditions: [], checks: [], approvals: [], history: [],
      steps: [{ id: "P1", title: "Step 1", goal: "FAKE: done", acceptance: [] }] });
    approveQueue(store, "P");
    engine.start("P", { runtime: "claude" });
    await until("P to finish", () => store.readRun("P")?.state === "finished", LONGER.run);
    assert.equal(s.runs().length, 2);
    assert.equal(store.readGit("P")?.setup, undefined);
  } finally { engine.shutdown(); rmSync(s.dir, { recursive: true, force: true }); }
});

test("a failing setup command is tried once more, then halts the run with the reason before any step; going on runs it again (queue CK)", async () => {
  const { store, engine, queue, until, received } = setup(["done"]);
  const s = withSetup(store);
  writeFileSync(s.fail, "");
  store.writeQueue({ ...store.readQueue("Q"), worktree: "auto" });
  try {
    engine.start("Q", { runtime: "claude" });
    await until("the run to halt", () => queue().run?.state === "halted", LONGER.run);
    const reason = queue().run!.reason!;
    assert.match(reason, /^the worktree setup command \(node ".*setup\.cjs"\) failed twice: exit code 3; its output ends: /);
    assert.match(reason, /boom: no network/);
    assert.equal(queue().steps[0]!.status, "pending", "no step opened");
    assert.deepEqual(received(), [], "the worker got no turn");
    const g = store.readGit("Q")!;
    assert.equal(g.setup?.done_at, undefined);
    assert.match(g.setup!.failed!.reason, /exit code 3/);
    const wt = lower(store.readQueue("Q").worktree!);
    assert.deepEqual(s.runs(), [wt, wt], "tried once more before the halt");

    // The cause is fixed; going on runs the command again in the same worktree, then the step.
    rmSync(s.fail);
    engine.resume("Q");
    await until("the run to finish", () => queue().run?.state === "finished", LONGER.run);
    assert.deepEqual(s.runs(), [wt, wt, wt]);
    assert.ok(store.readGit("Q")!.setup!.done_at);
  } finally { engine.shutdown(); rmSync(s.dir, { recursive: true, force: true }); }
});

test("a setup command failing once passes on its second try: the run goes on without a halt (queue CK)", async () => {
  const { store, engine, queue, until } = setup(["done"]);
  const s = withSetup(store);
  writeFileSync(s.fail, "1");
  store.writeQueue({ ...store.readQueue("Q"), worktree: "auto" });
  try {
    engine.start("Q", { runtime: "claude" });
    await until("the run to finish", () => queue().run?.state === "finished", LONGER.run);
    const wt = lower(store.readQueue("Q").worktree!);
    assert.deepEqual(s.runs(), [wt, wt], "once more after the failure");
    assert.ok(store.readGit("Q")!.setup!.done_at);
    assert.equal(queue().run!.reason, undefined, "no halt");
  } finally { engine.shutdown(); rmSync(s.dir, { recursive: true, force: true }); }
});
