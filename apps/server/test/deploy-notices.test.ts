// Deploying from the orchestrator chat (N4.2): the orchestrator that ran `nexus server update` is told the outcome
// once, after the restart or when the update fails; an update started from the dashboard tells no orchestrator about
// itself; and nothing that came up while an update drained or restarted is lost: right after the restart every
// project's orchestrator is told, and starts a turn without the user writing. Real server processes (successors taking
// over through hand-over files written here) and the orchestrator on the fake `claude`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ProjectStore, approveQueue, loadProjectState, newId, now, writeRegistry, type SessionFile, type StepDef,
} from "@nexus/protocol";
import { Engine } from "../src/engine.ts";
import { Lifecycle } from "../src/lifecycle.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import { serverEnv, spawnServer } from "./helpers.ts";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, "..", "..", "..");
const CLI = join(REPO, "packages", "cli", "bin", "nexus.js");
process.env.NEXUS_CLAUDE = join(here, "fake-claude.ts");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(what: string, pred: () => boolean, ms = 30_000, detail = () => ""): Promise<void> {
  const t = Date.now();
  while (!pred()) { if (Date.now() - t > ms) assert.fail(`timed out waiting for ${what}${detail()}`); await sleep(100); }
}
const freePort = () => new Promise<number>((resolve) => {
  const s = createServer();
  s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); });
});
const steps = (...ids: string[]): StepDef[] => ids.map((id) => ({ id, title: `Step ${id}`, goal: "FAKE: done", acceptance: [] }));

/** A registered project with an orchestrator session (its process not running, as after a restart). */
function project(base: string, id: string) {
  const root = join(base, id);
  mkdirSync(root, { recursive: true });
  const store = ProjectStore.init(root, { id, name: id.toUpperCase(), root });
  return { id, root, store };
}
function addOrchestrator(store: ProjectStore): string {
  const p = store.readProject();
  const s: SessionFile = {
    protocol: 1, id: newId(), project: p.id, role: "orchestrator", runtime: "claude", native_id: randomUUID(),
    title: "Orchestrator", cwd: p.root, launched_by: "nexus", created_at: now(),
  };
  store.writeSession(s);
  store.writeProject({ ...p, orchestrator: { runtime: "claude", notify: true, session: s.id } });
  return s.id;
}

/** What the fake orchestrators received (FAKE_LOG): the text, and whether it opened a turn. */
function received(log: string) {
  return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { text: string; priority: string | null; busy: boolean }) : [];
}

/** The files a predecessor leaves for its successor; written whole up front, so the successor takes over at once. */
function handover(home: string, update: { id: string; by?: { project: string; session: string } }): string {
  const dir = join(home, "handover", update.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "predecessor.json"), JSON.stringify({ pid: process.pid, commit: "old1234", subject: "the old version", at: now(), update }));
  writeFileSync(join(dir, "released.json"), JSON.stringify({ at: now(), log: ["10:00:00 moving the live worktree"], ref: "main" }));
  return dir;
}

function server(home: string, port: number, extra: Record<string, string>) {
  let out = "";
  const child: ChildProcess = spawnServer({ NEXUS_HOME: home, NEXUS_PORT: String(port), NEXUS_LOG: "", ...extra }, ["ignore", "pipe", "pipe"]);
  child.stdout!.on("data", (d) => { out += d; });
  child.stderr!.on("data", (d) => { out += d; });
  return { child, out: () => out, stop: () => { child.kill(); return new Promise((r) => (child.exitCode !== null ? r(null) : child.on("exit", r))); } };
}

async function serverInfo(port: number): Promise<any> {
  try { return await (await fetch(`http://127.0.0.1:${port}/api/server`)).json(); } catch { return undefined; }
}
/** The successor took over and its update settled (its push, here never made from a development checkout, is done). */
async function settled(port: number, s: { out: () => string }) {
  let info: any;
  await until("the update to settle", () => { void serverInfo(port).then((i) => { info = i; }); return !!info?.update?.push; }, 30_000, () => `; output: ${s.out()}`);
  return info;
}

const head = () => execFileSync("git", ["log", "-1", "--format=%h"], { cwd: REPO, encoding: "utf8" }).trim();

// ---------------------------------------------------------------- the update's own outcome

test("the orchestrator that ran the update is told once, after the restart, which version is up", async () => {
  const base = mkdtempSync(join(tmpdir(), "nexus-deploy-"));
  const home = join(base, "home");
  process.env.NEXUS_HOME = home;
  const p = project(base, "p");
  const session = addOrchestrator(p.store);
  writeRegistry({ protocol: 1, projects: [{ id: "p", root: p.root }] });
  const log = join(base, "fake.log");
  const dir = handover(home, { id: "U1", by: { project: "p", session } });
  const port = await freePort();
  let s = server(home, port, { NEXUS_HANDOVER: dir, FAKE_LOG: log });
  const told = () => received(log).filter((m) => m.text.startsWith("[Nexus] Nexus was updated as asked"));
  try {
    await settled(port, s);
    await until("the outcome to reach the orchestrator", () => told().length > 0, 30_000, () => `; output: ${s.out()}`);
    const m = told()[0]!;
    assert.match(m.text, new RegExp(`^\\[Nexus\\] Nexus was updated as asked: ${head()} ".*" is up \\(was old1234\\)\\. Not pushed: not a live instance`));
    assert.equal(m.priority, null, "it starts a turn of its own");
    const chat = p.store.readChat(session).entries;
    assert.ok(chat.some((c) => c.from === "nexus" && /Nexus was updated as asked/.test(c.text)), "the user sees it in the chat");
    assert.ok(p.store.readApplied(session).entries.some((a) => a.event === "notify:update:U1:updated"), "the key is recorded");

    // A restart that takes the same hand-over again does not tell it twice.
    await s.stop();
    s = server(home, port, { NEXUS_HANDOVER: dir, FAKE_LOG: log });
    await settled(port, s);
    await sleep(2500);
    assert.equal(told().length, 1, "told once across the restart");
  } finally { await s.stop(); }
});

test("an update started from the dashboard tells no orchestrator about the update", async () => {
  const base = mkdtempSync(join(tmpdir(), "nexus-deploy-"));
  const home = join(base, "home");
  process.env.NEXUS_HOME = home;
  const p = project(base, "p");
  const session = addOrchestrator(p.store);
  writeRegistry({ protocol: 1, projects: [{ id: "p", root: p.root }] });
  const log = join(base, "fake.log");
  const dir = handover(home, { id: "U2" }); // no `by`: the user started it
  const port = await freePort();
  const s = server(home, port, { NEXUS_HANDOVER: dir, FAKE_LOG: log });
  try {
    const info = await settled(port, s);
    assert.equal(info.update.phase, "updated");
    await sleep(2500);
    assert.equal(received(log).filter((m) => /Nexus was updated|update you ran/.test(m.text)).length, 0);
    assert.ok(!p.store.readApplied(session).entries.some((a) => a.event.startsWith("notify:update:")));
  } finally { await s.stop(); }
});

test("a failed update tells the orchestrator that ran it why, and what still runs, once", async () => {
  const base = mkdtempSync(join(tmpdir(), "nexus-deploy-"));
  process.env.NEXUS_HOME = join(base, "home");
  process.env.FAKE_SUCCESSOR = "crash";
  const log = join(base, "fake.log");
  process.env.FAKE_LOG = log;
  // The checkout the server runs from: a live worktree at A, with branch next one commit on.
  const repo = join(base, "checkout");
  mkdirSync(repo);
  const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...a], { cwd: repo, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "dev");
  writeFileSync(join(repo, "a.txt"), "A\n"); git("add", "-A"); git("commit", "-q", "-m", "A: where it runs");
  const a = git("rev-parse", "--short=7", "HEAD");
  git("checkout", "-q", "-b", "next"); writeFileSync(join(repo, "b.txt"), "B\n"); git("add", "-A"); git("commit", "-q", "-m", "B");
  git("checkout", "-q", "--detach", "dev");

  const p = project(base, "p");
  const session = addOrchestrator(p.store);
  const engine = new Engine(p.store, () => {});
  // Wired as main.ts wires it: the orchestrator reads the lifecycle's notice; a settled update runs its notices.
  let lifecycle!: Lifecycle;
  const orchestrator = new Orchestrator(p.store, engine, () => {}, { update: () => lifecycle.notice() });
  const onChange = () => orchestrator.onChange(loadProjectState(p.store));
  lifecycle = new Lifecycle(() => [{ id: "p", idle: () => true, drain: () => [], cancel: () => {}, shutdown: () => {} }], () => {}, {
    root: repo, successor: [process.execPath, join(here, "fake-successor.ts")], timeoutMs: 15_000,
    npm: async () => {}, exit: () => assert.fail("it must not exit"), settled: onChange,
  });
  const told = () => received(log).filter((m) => m.text.startsWith("[Nexus] The Nexus update you ran failed"));
  try {
    lifecycle.start({ ref: "next", by: { project: "p", session } });
    await until("the outcome to reach the orchestrator", () => told().length > 0, 30_000, () => `; status: ${JSON.stringify(lifecycle.status)}`);
    assert.match(told()[0]!.text, new RegExp(`failed: the successor exited \\(1\\) before it was ready; rolled back to ${a}\\. Still running: ${a} "A: where it runs"`));
    onChange(); onChange();
    await sleep(500);
    assert.equal(told().length, 1, "once");
  } finally { orchestrator.shutdown(); engine.shutdown(); delete process.env.FAKE_SUCCESSOR; delete process.env.FAKE_LOG; }
});

// ---------------------------------------------------------------- nothing lost across an update (the N3 case)

test("notices that came up while an update drained reach every project's orchestrator right after the restart, once each, in a turn of its own", async () => {
  const base = mkdtempSync(join(tmpdir(), "nexus-deploy-"));
  const home = join(base, "home");
  process.env.NEXUS_HOME = home;
  const log = join(base, "fake.log");
  const projects = ["p1", "p2"].map((id) => {
    const p = project(base, id);
    const q = `Q${id.slice(1)}`, r = `R${id.slice(1)}`;
    for (const x of [q, r]) p.store.writeQueue({ protocol: 1, id: x, title: `Queue ${x}`, revision: 1, status: "proposed", stop_conditions: [], checks: [], steps: steps(`${x}1`), approvals: [], history: [] });
    approveQueue(p.store, q); // before the orchestrator's session: not news to it
    return { ...p, q, r };
  });
  await sleep(20);
  for (const p of projects) {
    (p as typeof p & { session: string }).session = addOrchestrator(p.store);
    await sleep(20);
    // While the predecessor drained: its queue finished, and the user approved another one.
    const at = now();
    p.store.writeRun(p.q, { protocol: 1, session: newId(), state: "finished", step: `${p.q}1`, started_at: at, updated_at: at, ended_at: at });
    approveQueue(p.store, p.r);
  }
  writeRegistry({ protocol: 1, projects: projects.map((p) => ({ id: p.id, root: p.root })) });
  const dir = handover(home, { id: "U3" }); // the user's update: only the held notices go out
  const port = await freePort();
  const s = server(home, port, { NEXUS_HANDOVER: dir, FAKE_LOG: log });
  try {
    for (const p of projects) {
      const finished = `[Nexus] Queue ${p.q} finished.`;
      const approved = `[Nexus] Queue ${p.r} revision 1 approved.`;
      await until(`both notices in ${p.id}`, () => {
        const texts = received(log).map((m) => m.text);
        return texts.some((t) => t.startsWith(finished)) && texts.some((t) => t.startsWith(approved));
      }, 30_000, () => `; received: ${JSON.stringify(received(log).map((m) => m.text.slice(0, 60)))}; output: ${s.out()}`);
    }
    await sleep(2500); // later passes (changes, the settled update) must not tell them again
    const msgs = received(log);
    for (const p of projects) {
      const mine = msgs.filter((m) => m.text.startsWith(`[Nexus] Queue ${p.q} finished.`) || m.text.startsWith(`[Nexus] Queue ${p.r} revision 1 approved.`));
      assert.equal(mine.length, 2, `${p.id}: each once`);
      assert.ok(!msgs.some((m) => m.text.startsWith(`[Nexus] Queue ${p.q} revision`)), `${p.id}: the approval from before the session is not news`);
      const session = (p as typeof p & { session: string }).session;
      assert.ok(mine.some((m) => m.priority === null && !m.busy), `${p.id}: a turn started by itself`);
      assert.ok(!p.store.readChat(session).entries.some((c) => c.from === "user"), `${p.id}: without the user writing`);
      assert.ok(p.store.readActivity(session).entries.some((a) => a.kind === "turn_start"), `${p.id}: the orchestrator worked`);
    }
  } finally { await s.stop(); }
});

// ---------------------------------------------------------------- nexus server status

test("nexus server status lists the running steps per project", async () => {
  const base = mkdtempSync(join(tmpdir(), "nexus-deploy-"));
  const home = join(base, "home");
  process.env.NEXUS_HOME = home;
  const ps = ["p1", "p2", "p3"].map((id) => project(base, id));
  for (const [i, p] of ps.entries()) {
    if (i === 2) continue; // p3 runs nothing
    p.store.writeQueue({ protocol: 1, id: "Q", title: "Queue", revision: 1, status: "proposed", stop_conditions: [], checks: [], steps: steps("Q1", "Q2"), approvals: [], history: [] });
    approveQueue(p.store, "Q");
    const w: SessionFile = { protocol: 1, id: newId(), project: p.id, role: "worker", runtime: "external", queue: "Q", cwd: p.root, launched_by: "external", created_at: now() };
    p.store.writeSession(w);
    p.store.appendEvent({ v: 1, id: newId(), at: now(), session: w.id, type: "step.started", queue: "Q", step: i === 0 ? "Q1" : "Q2" });
  }
  writeRegistry({ protocol: 1, projects: ps.map((p) => ({ id: p.id, root: p.root })) });
  const port = await freePort();
  const s = server(home, port, {});
  try {
    await until("the server", () => s.out().includes("Nexus server on"), 30_000, () => s.out());
    const out = execFileSync(process.execPath, [CLI, "server", "status"], {
      env: { ...serverEnv({ NEXUS_HOME: home, NEXUS_PORT: String(port) }), NEXUS_SESSION: "", NEXUS_DIR: "" }, encoding: "utf8",
    });
    assert.match(out, /running steps in P1 \(p1\):\n {2}Q\/Q1 Step Q1/);
    assert.match(out, /running steps in P2 \(p2\):\n {2}Q\/Q2 Step Q2/);
    assert.doesNotMatch(out, /\(p3\)/, "a project with nothing running is not listed");
  } finally { await s.stop(); }
});
