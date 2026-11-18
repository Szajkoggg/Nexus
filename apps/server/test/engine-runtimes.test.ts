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
  // The project's own rules go on as they are: no PowerShell pair is made for them.
  store.updateProject((p) => ({ ...p, runtimes: { ...p.runtimes, claude: { ...p.runtimes.claude, allowed_tools: ["Edit", "Bash(npm test:*)"] } } }));
  try {
    engine.start("Q", { runtime: "claude", model: "sonnet", effort: "high" });
    await until("the run to finish", () => queue().run?.state === "finished", LONGER.run);
    const argv = (JSON.parse(readFileSync(process.env.FAKE_ARGS, "utf8").trim().split("\n")[0]!) as { argv: string[] }).argv;
    assert.equal(argv[argv.indexOf("--model") + 1], "sonnet");
    assert.equal(argv[argv.indexOf("--effort") + 1], "high");
    const allowed = argv.slice(argv.indexOf("--allowedTools") + 1);
    assert.deepEqual(allowed, ["Bash(nexus:*)", "PowerShell(nexus:*)", "Edit", "Bash(npm test:*)"], "the nexus CLI on both shell tools, then the project's rules unchanged");
    assert.ok(!allowed.some((t) => t.startsWith("WebSearch") || t.startsWith("WebFetch")) && !argv.includes("--settings"), "a worker's web tools are not the partners' setting's (queue WB)");
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
    // Two steps of its own and the integration step a queue with a worktree of its own ends with.
    assert.deepEqual(turns.map((c) => c.writableRoots?.map(mine)), [want, want, want], "every turn's sandbox policy carries them");
    const config = (start[0] as unknown as { config: Record<string, unknown> }).config;
    assert.deepEqual(Object.keys(config), ["sandbox_workspace_write.writable_roots", "features.apps", "features.plugins"], "a worker's thread keeps its web search default, without the user's plugins and apps (queue FX)");
  } finally { engine.shutdown(); delete process.env.FAKE_ARGS; }
});

/** A ULID (a session's, a queue's): it only identifies, its letters are random. (A UUID is hex: it spells none of these.) */
const ID = /\b[0-9A-HJKMNP-TV-Z]{26}\b/gi;
/** An absolute path, Windows or POSIX (also Claude Code's //c/... in rules): it only locates, under a random temporary folder. */
const PATH = /(?:[A-Za-z]:[\\/]|\/)[^\s,()"']*/g;
/**
 * What a Claude Code launch configures: its flags as they are, their values with the ids and paths in them masked, so
 * a check for a setting matches the flags and config keys, never "MCP" by chance in a session id (queue TT1).
 */
const launchSettings = (argv: string[]) => argv.map((a) => (a.startsWith("-") ? a : a.replace(PATH, "<path>").replace(ID, "<id>")));
/** What Claude Code's launch must not name: MCP servers, plugins, Codex's features. */
const runtimeSettings = (argv: string[]) => launchSettings(argv).filter((a) => /mcp|plugin|feature/i.test(a));

test("the check on Claude Code's launch ignores ids and paths but sees MCP, plugin and feature flags and keys", () => {
  const id = "01M7NG9MTY6R22946TMCPMEC5B"; // TM1's session: "MCP" in a ULID
  const plain = [
    "-p", "--session-id", "0b7c9e2a-4d1f-4dcb-8a3b-1c2d3e4f5a6b", "--resume", id,
    "--append-system-prompt-file", `C:\\Users\\u\\AppData\\Local\\Temp\\nexus-MCPx1\\.nexus\\sessions\\${id}\\briefing.md`,
    "--disallowedTools", "Edit(//c/users/u/temp/nexus-mcp9/.nexus/**),Write(/tmp/nexus-plugin/.nexus/**)",
    "--allowedTools", "Bash(nexus:*)", `Read(${id})`,
  ];
  assert.deepEqual(runtimeSettings(plain), []);
  const named = [
    ["--mcp-config", "x.json"],
    ["--strict-mcp-config"],
    ["--plugin-dir", "C:\\p"],
    ["--settings", '{"enabledPlugins":{"a":true}}'],
    ["-c", "mcp_servers.blender.enabled=false"],
    ["-c", "features.apps=false"],
  ];
  for (const extra of named) {
    assert.notDeepEqual(runtimeSettings([...plain, ...extra]), [], extra.join(" "));
  }
});

test("a Codex worker's thread starts without the user's MCP servers, plugins and apps, but those the project names; Claude Code's launch is as it was", async () => {
  const { store, engine, queue, until } = setup(["done", "done"]);
  process.env.FAKE_ARGS = join(dirname(process.env.FAKE_LOG!), "args.log");
  process.env.FAKE_CODEX_MCP = "node_repl,blender,odd.name";
  try {
    engine.start("Q", { runtime: "codex" });
    await until("the run to finish", () => queue().run?.state === "finished", LONGER.run);
    const calls = () => readFileSync(process.env.FAKE_ARGS!, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { method: string; config?: Record<string, unknown> | null });
    assert.ok(calls().some((c) => c.method === "config/read"), "the user's servers are read from Codex's own effective config");
    const off = { "features.apps": false, "features.plugins": false, "mcp_servers.node_repl.enabled": false, "mcp_servers.blender.enabled": false, 'mcp_servers."odd.name".enabled': false };
    const start = calls().find((c) => c.method === "thread/start")!;
    for (const [k, v] of Object.entries(off)) assert.equal(start.config![k], v, `${k} off by default`);

    // The project names blender: a new worker thread keeps it; the rest stay off.
    const p = store.readProject();
    store.writeProject({ ...p, runtimes: { ...p.runtimes, codex: { ...p.runtimes.codex, mcp_servers: ["blender"] } } });
    assert.deepEqual(store.readProject().runtimes.codex.mcp_servers, ["blender"]);
    writeFileSync(process.env.FAKE_ARGS!, "");
    store.writeQueue({ protocol: 1, id: "B", title: "Blender", revision: 1, status: "proposed", stop_conditions: [], checks: [], steps: [{ id: "B1", title: "One", goal: "FAKE: done", acceptance: [] }], approvals: [], history: [] });
    approveQueue(store, "B");
    engine.start("B", { runtime: "codex" });
    await until("B to finish", () => loadProjectState(store).queues.find((q) => q.id === "B")!.run?.state === "finished", LONGER.run);
    const kept = calls().find((c) => c.method === "thread/start" || c.method === "thread/resume")!.config!;
    assert.equal(kept["mcp_servers.blender.enabled"], undefined, "blender is left as the user's config has it");
    assert.equal(kept["mcp_servers.node_repl.enabled"], false);
    assert.equal(kept['mcp_servers."odd.name".enabled'], false);
    assert.equal(kept["features.apps"], false);
    assert.equal(kept["features.plugins"], false);

    // Claude Code: no config read, nothing of Codex's settings in its launch.
    writeFileSync(process.env.FAKE_ARGS!, "");
    store.writeQueue({ protocol: 1, id: "C", title: "Claude", revision: 1, status: "proposed", stop_conditions: [], checks: [], steps: [{ id: "C1", title: "One", goal: "FAKE: done", acceptance: [] }], approvals: [], history: [] });
    approveQueue(store, "C");
    engine.start("C", { runtime: "claude" });
    await until("C to finish", () => loadProjectState(store).queues.find((q) => q.id === "C")!.run?.state === "finished", LONGER.run);
    assert.ok(!readFileSync(process.env.FAKE_ARGS!, "utf8").includes("config/read"));
    const argv = readFileSync(process.env.FAKE_ARGS!, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { argv?: string[] }).filter((l) => l.argv).at(-1)!.argv!;
    assert.deepEqual(runtimeSettings(argv), [], "Claude Code's argv names nothing of it");
  } finally { engine.shutdown(); delete process.env.FAKE_ARGS; delete process.env.FAKE_CODEX_MCP; }
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
