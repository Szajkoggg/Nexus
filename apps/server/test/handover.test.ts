// Handing the server over after an update (src/handover.ts, main.ts): the predecessor goes only after its successor
// proved it is up, and a successor touches nothing until the predecessor has let go. Real server processes on a
// free port against the fake `claude`; a stand-in successor (fake-successor.ts) for the predecessor's side.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectStore, approveQueue, loadProjectState, routeAnswers, writeRegistry, type StepDef } from "@nexus/protocol";
import { Engine } from "../src/engine.ts";
import { handOver, refuseHandoverDir, takeHandoverEnv, withoutHandover } from "../src/handover.ts";
import { agentEnv } from "../src/agent.ts";
import { MAIN, serverEnv, spawnServer } from "./helpers.ts";

const here = dirname(fileURLToPath(import.meta.url));
process.env.NEXUS_CLAUDE = join(here, "fake-claude.ts");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(what: string, pred: () => boolean, ms = 30_000, detail = () => ""): Promise<void> {
  const t = Date.now();
  while (!pred()) { if (Date.now() - t > ms) assert.fail(`timed out waiting for ${what}${detail()}`); await sleep(100); }
}

function freePort(): Promise<number> {
  return new Promise((resolve) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); }); });
}

/**
 * A Nexus home with one project whose queue Q an update held after its first step: exactly the files a drained
 * predecessor leaves behind (run paused, resume_after_restart set).
 */
async function heldProject() {
  const base = mkdtempSync(join(tmpdir(), "nexus-handover-"));
  const home = join(base, "home");
  process.env.NEXUS_HOME = home;
  process.env.FAKE_SLOW_MS = "300";
  const root = join(base, "project");
  mkdirSync(root, { recursive: true });
  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  const steps: StepDef[] = ["slow", "done"].map((b, i) => ({ id: `Q${i + 1}`, title: `Step ${i + 1}`, goal: `FAKE: ${b}`, acceptance: [] }));
  store.writeQueue({ protocol: 1, id: "Q", title: "Queue", revision: 1, status: "proposed", stop_conditions: [], checks: [], steps, approvals: [], history: [] });
  approveQueue(store, "Q");
  const engine: Engine = new Engine(store, () => { routeAnswers(store); engine.onChange(loadProjectState(store)); });
  engine.start("Q");
  await until("the first step to run", () => loadProjectState(store).queues[0]!.steps[0]!.status === "running");
  engine.drainForUpdate(false);
  await until("the hold", () => store.readRun("Q")?.state === "paused" && engine.idle());
  engine.shutdown();
  await until("the agent to exit", () => !engine.alive());
  delete process.env.FAKE_SLOW_MS;
  writeRegistry({ protocol: 1, projects: [{ id: "p", root }] });
  const run = store.readRun("Q")!;
  assert.equal(run.resume_after_restart, true);
  const session = run.session;
  const files = () => ({
    run: readFileSync(join(store.dir, "queues", "Q", "run.yaml"), "utf8"),
    runtime: readFileSync(join(store.sessionDir(session), "runtime.json"), "utf8"),
  });
  return { base, home, root, store, files };
}

/** A real server process. */
function server(home: string, port: number, env: Record<string, string> = {}) {
  const fakeArgs = join(home, "..", `server-${port}-args.log`);
  let out = "";
  // Without NEXUS_HANDOVER from this process (helpers.ts); a test that needs one passes it in `env`.
  const child: ChildProcess = spawnServer({ NEXUS_HOME: home, NEXUS_PORT: String(port), FAKE_ARGS: fakeArgs, NEXUS_LOG: "", ...env }, ["ignore", "pipe", "pipe"]);
  child.stdout!.on("data", (d) => { out += d; });
  child.stderr!.on("data", (d) => { out += d; });
  let code: number | null | undefined;
  child.on("exit", (c) => { code = c; });
  const records = () => (existsSync(fakeArgs) ? readFileSync(fakeArgs, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { argv?: string[]; handover: string | null }) : []);
  return {
    child, out: () => out, exitCode: () => code, startedAgent: () => existsSync(fakeArgs), records,
    stop: () => { if (code === undefined) child.kill(); },
  };
}

function handoverDir(home: string, predecessorPid: number): string {
  const dir = join(home, "handover", "test");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "predecessor.json"), JSON.stringify({ pid: predecessorPid, commit: "old1234", subject: "the old version", at: new Date().toISOString() }));
  return dir;
}

// ---------------------------------------------------------------- the predecessor's side

test("the predecessor frees the port first, and goes only after its successor signals ready", async () => {
  const base = mkdtempSync(join(tmpdir(), "nexus-handover-"));
  process.env.NEXUS_HOME = join(base, "home");
  const succLog = join(base, "successor.log");
  const order: string[] = [];
  const notes: string[] = [];
  const result = await handOver({
    command: [process.execPath, join(here, "fake-successor.ts")], cwd: base,
    env: { ...process.env, FAKE_SUCCESSOR: "ready", FAKE_READY_MS: "800", FAKE_SUCCESSOR_LOG: succLog },
    version: { commit: "old1234", subject: "the old version" },
    release: async () => { order.push("released"); },
    note: (t) => notes.push(t), log: () => ["10:00:00 an earlier line of the update", ...notes], ref: "main",
    timeoutMs: 15_000,
  });
  order.push("exits"); // what Lifecycle.restart does next
  const exitAt = Date.now();
  assert.equal(result.outcome, "ready");
  assert.deepEqual(order, ["released", "exits"]);
  await until("the successor to be released", () => existsSync(succLog));
  const seen = JSON.parse(readFileSync(succLog, "utf8").trim()) as { readyAt: number; released: { log: string[]; ref?: string } | null; predecessorAliveAtReady: boolean };
  assert.ok(exitAt >= seen.readyAt, "the predecessor exits only after the ready signal");
  assert.equal(seen.predecessorAliveAtReady, true, "it was still alive when the successor became ready");
  assert.ok(seen.released?.log.includes("10:00:00 an earlier line of the update"), "the update's log goes to the successor");
  assert.equal(seen.released?.ref, "main", "and what it deployed, for the push on deploy");
  assert.ok(notes.some((n) => /successor fake-new is up/.test(n)));
});

test("a successor that never signals makes the predecessor report the time-out; one that fails, the failure", async () => {
  const base = mkdtempSync(join(tmpdir(), "nexus-handover-"));
  process.env.NEXUS_HOME = join(base, "home");
  for (const [behaviour, expected, pattern] of [
    ["never", "timeout", /no ready signal within 2 s/],
    ["fail", "failed", /failed its smoke check: fake smoke check failure/],
  ] as const) {
    const notes: string[] = [];
    const t = Date.now();
    const result = await handOver({
      command: [process.execPath, join(here, "fake-successor.ts")], cwd: base,
      env: { ...process.env, FAKE_SUCCESSOR: behaviour, FAKE_LIFE_MS: "4000" },
      version: { commit: "old1234", subject: "old" }, release: async () => {}, note: (n) => notes.push(n), log: () => notes,
      timeoutMs: 2000,
    });
    assert.equal(result.outcome, expected, behaviour);
    assert.ok(notes.some((n) => pattern.test(n)), `${behaviour}: ${notes.join(" | ")}`);
    if (behaviour === "never") assert.ok(Date.now() - t >= 2000, "it waited the time limit");
    const dirs = readdirSync(join(base, "home", "handover"));
    assert.ok(dirs.every((d) => !existsSync(join(base, "home", "handover", d, "released.json"))), "nothing is released");
  }
});

// ---------------------------------------------------------------- the successor's side

test("a successor that fails its smoke check sends no ready signal, resumes nothing and starts no session", async () => {
  const { base, home, files } = await heldProject();
  // A second registered project whose state does not load.
  const broken = join(base, "broken");
  mkdirSync(join(broken, ".nexus"), { recursive: true });
  writeFileSync(join(broken, ".nexus", "project.yaml"), "protocol: 1\nid: [this is not a project\n");
  writeRegistry({ protocol: 1, projects: [{ id: "p", root: join(base, "project") }, { id: "b", root: broken }] });
  const before = files();
  const dir = handoverDir(home, process.pid);
  const s = server(home, await freePort(), { NEXUS_HANDOVER: dir });
  try {
    await until("the successor to exit", () => s.exitCode() !== undefined, 30_000, () => `; output: ${s.out()}`);
    assert.equal(s.exitCode(), 1);
    assert.ok(!existsSync(join(dir, "ready.json")), "no ready signal");
    assert.match(JSON.parse(readFileSync(join(dir, "failed.json"), "utf8")).reason, /project b .* does not load/);
    assert.deepEqual(files(), before, "the held run and its session are untouched (resume_after_restart still set)");
    assert.ok(!s.startedAgent(), "no session was started");
  } finally { s.stop(); }
});

test("a successor waits, read-only, until the predecessor hands over; then it resumes the held queue and says which version is up", async () => {
  const { home, store, files } = await heldProject();
  const before = files();
  const dir = handoverDir(home, process.pid); // this test is the predecessor: alive, and it has stopped writing
  const port = await freePort();
  const s = server(home, port, { NEXUS_HANDOVER: dir });
  try {
    await until("the ready signal", () => existsSync(join(dir, "ready.json")), 30_000, () => `; output: ${s.out()}`);
    const ready = JSON.parse(readFileSync(join(dir, "ready.json"), "utf8")) as { pid: number; commit: string };
    assert.equal(ready.pid, s.child.pid);
    const projects = await fetch(`http://127.0.0.1:${port}/api/projects`);
    assert.equal(projects.status, 503, "no project is served before the hand-over");
    await sleep(2500); // longer than a resume's delay after recovery
    assert.deepEqual(files(), before, "nothing written under .nexus/ before the hand-over");
    assert.ok(!s.startedAgent(), "no session started before the hand-over");

    writeFileSync(join(dir, "released.json"), JSON.stringify({ at: new Date().toISOString(), log: ["10:00:00 moving the live worktree"] }));
    await until("the resumed queue to finish", () => store.readRun("Q")?.state === "finished", 30_000, () => `; run: ${JSON.stringify(store.readRun("Q"))}; output: ${s.out()}`);
    const info = await (await fetch(`http://127.0.0.1:${port}/api/server`)).json() as { commit: string; update: { phase: string; log: string[] } };
    assert.equal(info.update.phase, "updated");
    assert.equal(info.update.log[0], "10:00:00 moving the live worktree", "the predecessor's lines come first");
    assert.ok(info.update.log.some((l) => new RegExp(`up: ${info.commit} .*\\(was old1234\\); the predecessor handed over`).test(l)), info.update.log.join("\n"));
    // Then the push on deploy: never from a development checkout (this test runs from one), and here no ref was given.
    let push: { result: string; text: string } | undefined;
    for (const t = Date.now(); !push && Date.now() - t < 10_000; await sleep(200)) {
      push = ((await (await fetch(`http://127.0.0.1:${port}/api/server`)).json()) as { update: { push?: { result: string; text: string } } }).update.push;
    }
    assert.equal(push?.result, "skipped", JSON.stringify(push));
  } finally { s.stop(); }
});

test("a successor whose predecessor exits without handing over takes over all the same", async () => {
  const { home, store } = await heldProject();
  const gone = spawn(process.execPath, ["-e", ""]);
  await new Promise((r) => gone.on("exit", r));
  const dir = handoverDir(home, gone.pid!); // a predecessor that is no longer running
  const s = server(home, await freePort(), { NEXUS_HANDOVER: dir });
  try {
    await until("the resumed queue to finish", () => store.readRun("Q")?.state === "finished", 30_000, () => `; output: ${s.out()}`);
    assert.match(s.out(), /exited without handing over/);
  } finally { s.stop(); }
});

// ---------------------------------------------------------------- starts as before

test("a start with no predecessor comes up and resumes the held queue as before", async () => {
  const { home, store } = await heldProject();
  const s = server(home, await freePort());
  try {
    await until("the resumed queue to finish", () => store.readRun("Q")?.state === "finished", 30_000, () => `; output: ${s.out()}`);
  } finally { s.stop(); }
});

test("a start by an old-style predecessor (no hand-over, the port freed as it exits) comes up and resumes as before", async () => {
  const { home, store } = await heldProject();
  const port = await freePort();
  const old: Server = createServer();
  await new Promise<void>((r) => old.listen(port, "127.0.0.1", () => r()));
  const s = server(home, port, { NEXUS_WAIT_PORT: "60" });
  try {
    await sleep(1500);
    await new Promise<void>((r) => old.close(() => r())); // the old server exits
    await until("the resumed queue to finish", () => store.readRun("Q")?.state === "finished", 30_000, () => `; output: ${s.out()}`);
    assert.match(s.out(), new RegExp(`Nexus server on http://127.0.0.1:${port}`));
  } finally { s.stop(); if (old.listening) old.close(); }
});

// ---------------------------------------------------------------- NEXUS_HANDOVER is consumed once

test("NEXUS_HANDOVER is taken once and removed; agents' environments never have it; only this home's folders pass", () => {
  const env: NodeJS.ProcessEnv = { NEXUS_HANDOVER: "x", Nexus_Handover: "y", PATH: "p" };
  assert.equal(takeHandoverEnv(env), "x");
  assert.deepEqual(Object.keys(env), ["PATH"], "every spelling is gone");
  assert.equal(takeHandoverEnv(env), undefined, "read once");
  assert.deepEqual(Object.keys(withoutHandover({ nexus_handover: "z", A: "1" })), ["A"]);

  const saved = process.env.NEXUS_HANDOVER;
  process.env.NEXUS_HANDOVER = "C:/somewhere/handover/x";
  try { assert.equal(agentEnv({ NEXUS_SESSION: "s" }).NEXUS_HANDOVER, undefined, "the second guard"); }
  finally { if (saved === undefined) delete process.env.NEXUS_HANDOVER; else process.env.NEXUS_HANDOVER = saved; }

  const base = mkdtempSync(join(tmpdir(), "nexus-handover-"));
  const savedHome = process.env.NEXUS_HOME;
  try {
    for (const home of [join(base, "home"), join(base, "home") + sep]) {
      process.env.NEXUS_HOME = home;
      assert.equal(refuseHandoverDir(join(base, "home", "handover", "01ABC")), undefined, `inside (${home})`);
      assert.equal(refuseHandoverDir(join(base, "home", "handover", "01ABC") + sep), undefined, "a trailing separator");
      assert.match(refuseHandoverDir(join(base, "home", "handover"))!, /is not under/, "the folder itself is not a hand-over");
      assert.match(refuseHandoverDir(join(base, "home", "handover-other", "01ABC"))!, /is not under/, "a sibling with the same prefix");
      assert.match(refuseHandoverDir(join(base, "home", "handover", "..", "elsewhere"))!, /is not under/, "resolved before comparing");
      assert.match(refuseHandoverDir(join(base, "elsewhere", "handover", "01ABC"))!, /is not under/);
      if (process.platform === "win32") assert.equal(refuseHandoverDir(join(base, "HOME", "HANDOVER", "01ABC")), undefined, "case-insensitive on Windows");
    }
  } finally { if (savedHome === undefined) delete process.env.NEXUS_HOME; else process.env.NEXUS_HOME = savedHome; }
});

test("after taking over, the server's own environment and its agents' have no NEXUS_HANDOVER", async () => {
  const { home, store } = await heldProject();
  const dir = handoverDir(home, process.pid);
  const port = await freePort();
  const s = server(home, port, { NEXUS_HANDOVER: dir });
  try {
    await until("the ready signal", () => existsSync(join(dir, "ready.json")), 30_000, () => `; output: ${s.out()}`);
    writeFileSync(join(dir, "released.json"), JSON.stringify({ at: new Date().toISOString(), log: [] }));
    await until("the resumed queue to finish", () => store.readRun("Q")?.state === "finished", 30_000, () => `; output: ${s.out()}`);
    // The model list is asked from a runtime started with the server's own environment, not an agent's.
    const ask = new AbortController();
    void fetch(`http://127.0.0.1:${port}/api/models/claude`, { signal: ask.signal }).catch(() => {});
    const own = () => s.records().find((r) => r.argv && !r.argv.includes("--session-id") && !r.argv.includes("--resume"));
    await until("the runtime started with the server's environment", () => !!own(), 30_000, () => `; records: ${JSON.stringify(s.records())}`);
    ask.abort();
    const agents = s.records().filter((r) => r !== own());
    assert.ok(agents.length > 0, "an agent was started for the resumed queue");
    assert.deepEqual(agents.map((r) => r.handover), agents.map(() => null), "no agent inherited it");
    assert.equal(own()!.handover, null, "the server removed it from its own environment");
  } finally { s.stop(); }
});

test("a server given a hand-over folder outside its NEXUS_HOME writes nothing there and exits non-zero with the reason", async () => {
  const { base, home, files } = await heldProject();
  const before = files();
  const foreign = join(base, "elsewhere", "handover", "01FOREIGN"); // like the live instance's folder seen from a test home
  mkdirSync(foreign, { recursive: true });
  writeFileSync(join(foreign, "predecessor.json"), JSON.stringify({ pid: process.pid, commit: "live123", subject: "the live one", at: new Date().toISOString() }));
  const listing = () => readdirSync(foreign).map((f) => `${f}:${readFileSync(join(foreign, f), "utf8")}`);
  const was = listing();
  const port = await freePort();
  const s = server(home, port, { NEXUS_HANDOVER: foreign });
  try {
    await until("the server to exit", () => s.exitCode() !== undefined, 30_000, () => `; output: ${s.out()}`);
    assert.notEqual(s.exitCode(), 0);
    assert.match(s.out(), /refusing to take over: the hand-over folder .*01FOREIGN is not under .*handover; exiting without starting/);
    assert.deepEqual(listing(), was, "nothing written in the foreign folder");
    assert.deepEqual(files(), before, "the held run is untouched");
    assert.ok(!s.startedAgent(), "no agent started");
    assert.ok(!existsSync(join(home, "auth.json")), "it did not start at all");
    await fetch(`http://127.0.0.1:${port}/api/server`).then(() => assert.fail("it must not listen"), () => {});
  } finally { s.stop(); }
});

for (const trailing of [false, true]) {
  test(`a real hand-over to main.ts reaches ready (NEXUS_HOME ${trailing ? "with" : "without"} a trailing separator)`, async () => {
    const base = mkdtempSync(join(tmpdir(), "nexus-handover-"));
    const home = join(base, "home") + (trailing ? sep : "");
    const savedHome = process.env.NEXUS_HOME;
    process.env.NEXUS_HOME = home;
    let pid: number | undefined;
    try {
      const port = await freePort();
      const notes: string[] = [];
      const result = await handOver({
        command: [process.execPath, MAIN], cwd: join(here, "..", "..", ".."),
        env: serverEnv({ NEXUS_HOME: home, NEXUS_PORT: String(port), NEXUS_LOG: "" }),
        version: { commit: "old1234", subject: "the old version" },
        release: async () => {}, note: (n) => notes.push(n), log: () => notes,
        timeoutMs: 30_000,
      });
      pid = result.pid;
      assert.equal(result.outcome, "ready", notes.join(" | "));
      let phase = "";
      for (const t = Date.now(); phase !== "updated" && Date.now() - t < 15_000; await sleep(200)) {
        phase = ((await (await fetch(`http://127.0.0.1:${port}/api/server`)).json()) as { update: { phase: string } }).update.phase;
      }
      assert.equal(phase, "updated", "released, it took over");
    } finally {
      if (pid) try { process.kill(pid); } catch { /* gone */ }
      if (savedHome === undefined) delete process.env.NEXUS_HOME; else process.env.NEXUS_HOME = savedHome;
    }
  });
}
