// The engine starts each runtime with the step's model and effort, Claude Code's deny rules on .nexus, and Codex's
// writable git roots (split from engine.test.ts, queue TS2).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ProjectStore, addNote, answerAsUser, approveQueue, loadProjectState, reportFolder, routeAnswers, runTimes, sendMessage, setStepLevel, type StepDef,
} from "@nexus/protocol";
import { Engine, RETRY_LIMIT, type EngineOptions } from "../src/engine.ts";
import { acceptReviews } from "./fake-reviewer.ts";
import { WAIT_MS, until as waitUntil, LONGER, holdWork } from "./wait.ts";
import { FAST, WINDOW, activityOf, fixtureRun, here, restart, setup } from "./engine-setup.ts";
test("model and effort reach Claude Code as flags, and are kept on the session", async () => {
  const { store, engine, queue, until } = setup(["done"]);
  process.env.FAKE_ARGS = join(dirname(process.env.FAKE_LOG!), "args.log");
  try {
    engine.start("Q", { runtime: "claude", model: "sonnet", effort: "high" });
    await until("the run to finish", () => queue().run?.state === "finished", LONGER.run);
    const argv = (JSON.parse(readFileSync(process.env.FAKE_ARGS, "utf8").trim().split("\n")[0]!) as { argv: string[] }).argv;
    assert.equal(argv[argv.indexOf("--model") + 1], "sonnet");
    assert.equal(argv[argv.indexOf("--effort") + 1], "high");
    const s = loadProjectState(store).sessions.find((x) => x.id === queue().run!.session)!;
    assert.deepEqual([s.model, s.effort], ["sonnet", "high"]);
  } finally { engine.shutdown(); delete process.env.FAKE_ARGS; }
});

test("a Claude worker's file tools may not write under the project's .nexus: deny rules on its absolute path, also from a worktree; none when the setting is off", async () => {
  const argvOf = (store: ProjectStore) => {
    const lines = readFileSync(process.env.FAKE_ARGS!, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { argv?: string[] });
    return lines.filter((l) => l.argv).at(-1)!.argv!;
  };
  const denied = (argv: string[]) => (argv.includes("--disallowedTools") ? argv[argv.indexOf("--disallowedTools") + 1]!.split(",") : []);
  const posix = (dir: string) => `//${dir.replaceAll("\\", "/").replace(/^([A-Za-z]):/, (_m, d: string) => d.toLowerCase())}`.replace(/^\/\/\//, "//");

  // In the project's own checkout.
  let x = setup(["done"]);
  process.env.FAKE_ARGS = join(dirname(process.env.FAKE_LOG!), "args.log");
  try {
    x.engine.start("Q", { runtime: "claude" });
    await x.until("the run to finish", () => x.queue().run?.state === "finished", LONGER.run);
    const p = posix(x.store.dir);
    assert.ok(/^\/\/[a-z]\/|^\/\//.test(p));
    assert.deepEqual(denied(argvOf(x.store)), [`Edit(${p}/**)`, `Write(${p}/**)`]);
    assert.ok(argvOf(x.store).slice(argvOf(x.store).indexOf("--allowedTools") + 1).includes("Bash(nexus:*)"), "the nexus CLI stays allowed");
  } finally { x.engine.shutdown(); }

  // In a queue's own worktree, whose .nexus is the main checkout's: the rules name that one.
  x = setup(["done"]);
  process.env.FAKE_ARGS = join(dirname(process.env.FAKE_LOG!), "args.log");
  const root = x.store.readProject().root;
  const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...a], { cwd: root, stdio: "ignore" });
  git("init", "-q", "-b", "main"); writeFileSync(join(root, "a.txt"), "a\n"); git("add", "a.txt"); git("commit", "-qm", "init");
  x.store.writeQueue({ ...x.store.readQueue("Q"), worktree: "auto" });
  try {
    x.engine.start("Q", { runtime: "claude" });
    await x.until("the run to finish", () => x.queue().run?.state === "finished", LONGER.run);
    const wt = x.store.readQueue("Q").worktree!;
    assert.ok(!normalize(wt).toLowerCase().startsWith(normalize(root).toLowerCase() + "\\.nexus"));
    assert.deepEqual(denied(argvOf(x.store)), [`Edit(${posix(x.store.dir)}/**)`, `Write(${posix(x.store.dir)}/**)`]);
  } finally { x.engine.shutdown(); }

  // The setting off.
  x = setup(["done"]);
  process.env.FAKE_ARGS = join(dirname(process.env.FAKE_LOG!), "args.log");
  const pf = x.store.readProject();
  x.store.writeProject({ ...pf, defaults: { ...pf.defaults, protect_nexus: false } });
  try {
    x.engine.start("Q", { runtime: "claude" });
    await x.until("the run to finish", () => x.queue().run?.state === "finished", LONGER.run);
    assert.deepEqual(denied(argvOf(x.store)), []);
  } finally { x.engine.shutdown(); delete process.env.FAKE_ARGS; }
});

test("Codex gets the effort on every turn and the project's reviewer when the thread starts; Claude Code refuses ultra", async () => {
  const { store, engine, queue, until } = setup(["done", "done"]);
  process.env.FAKE_ARGS = join(dirname(process.env.FAKE_LOG!), "args.log");
  const p = store.readProject();
  store.writeProject({ ...p, runtimes: { ...p.runtimes, codex: { ...p.runtimes.codex, effort: "medium", approval_policy: "on-request", approvals_reviewer: "auto_review" } } });
  try {
    assert.throws(() => engine.start("Q", { runtime: "claude", effort: "ultra" }), /Claude Code takes effort/);
    engine.start("Q", { runtime: "codex" });
    await until("the run to finish", () => queue().run?.state === "finished", LONGER.run);
    const calls = readFileSync(process.env.FAKE_ARGS, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    assert.deepEqual(calls.filter((c) => c.method === "thread/start").map((c) => [c.approvalPolicy, c.approvalsReviewer]), [["on-request", "auto_review"]]);
    assert.deepEqual(calls.filter((c) => c.method === "turn/start").map((c) => c.effort), ["medium", "medium"]);
  } finally { engine.shutdown(); delete process.env.FAKE_ARGS; }
});

test("Codex in a queue's own worktree may write the worktree's git paths, and no more of the repository's .git", async () => {
  const { store, engine, queue, until } = setup(["done", "done"]);
  process.env.FAKE_ARGS = join(dirname(process.env.FAKE_LOG!), "args.log");
  const root = store.readProject().root;
  const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...a], { cwd: root, stdio: "ignore" });
  git("init", "-q", "-b", "main"); writeFileSync(join(root, "a.txt"), "a\n"); git("add", "a.txt"); git("commit", "-qm", "init");
  store.writeQueue({ ...store.readQueue("Q"), worktree: "auto" });
  try {
    engine.start("Q", { runtime: "codex" });
    await until("the run to finish", () => queue().run?.state === "finished", LONGER.run);
    const wt = store.readQueue("Q").worktree!;
    const gitDir = join(root, ".git"), mine = (p: string) => normalize(p).toLowerCase();
    const want = [store.dir, join(gitDir, "worktrees", "Q"), join(gitDir, "objects"), join(gitDir, "refs"), join(gitDir, "logs"), reportFolder("p")].map(mine);
    const calls = readFileSync(process.env.FAKE_ARGS, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { method: string; writableRoots: string[] | null; cwd?: string });
    const start = calls.filter((c) => c.method === "thread/start"), turns = calls.filter((c) => c.method === "turn/start");
    assert.equal(mine(start[0]!.cwd!), mine(wt));
    assert.deepEqual(start.map((c) => c.writableRoots?.map(mine)), [want], "the thread's sandbox config carries the roots");
    assert.deepEqual(turns.map((c) => c.writableRoots?.map(mine)), [want, want], "every turn's sandbox policy carries them");
  } finally { engine.shutdown(); delete process.env.FAKE_ARGS; }
});

test("Codex in the project's own checkout gets no git roots (its .git lies inside it), only the folder for reports", async () => {
  const { store, engine, queue, until } = setup(["done"]);
  process.env.FAKE_ARGS = join(dirname(process.env.FAKE_LOG!), "args.log");
  execFileSync("git", ["init", "-q"], { cwd: store.readProject().root, stdio: "ignore" });
  try {
    engine.start("Q", { runtime: "codex" });
    await until("the run to finish", () => queue().run?.state === "finished", LONGER.run);
    const calls = readFileSync(process.env.FAKE_ARGS, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { method: string; writableRoots: string[] | null });
    // Only the folder for reports (outside the checkout, where the last step's report is written).
    const mine = (p: string) => normalize(p).toLowerCase();
    assert.deepEqual(calls.filter((c) => c.method === "turn/start").map((c) => c.writableRoots?.map(mine)), [[mine(reportFolder("p"))]]);
    assert.deepEqual(calls.find((c) => c.method === "thread/start")!.writableRoots?.map(mine), [mine(reportFolder("p"))]);
  } finally { engine.shutdown(); delete process.env.FAKE_ARGS; }
});
