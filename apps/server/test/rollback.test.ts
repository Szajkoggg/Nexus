// An update whose successor does not come up rolls back (src/lifecycle.ts): the successor is stopped, a live worktree
// goes back to the commit it came from (reinstalled, rebuilt), the server takes the port again and the held queues
// run again. Against a temporary git repository standing in for the live worktree, a stand-in successor
// (fake-successor.ts), npm stubbed, and the queue engine on the fake `claude`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectStore, approveQueue, loadProjectState, routeAnswers, type StepDef } from "@nexus/protocol";
import { Engine } from "../src/engine.ts";
import { isAlive } from "../src/handover.ts";
import { Lifecycle } from "../src/lifecycle.ts";
import { acceptReviews } from "./fake-reviewer.ts";
import { until, LONGER, WORK_MS } from "./wait.ts";

const here = dirname(fileURLToPath(import.meta.url));
process.env.NEXUS_CLAUDE = join(here, "fake-claude.ts");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A git repository standing in for this server's checkout: commit A (where it runs) and branch `next` one commit
 * on, with changed dependencies. `live`: on a detached HEAD at A, like the live worktree; else on branch `dev`.
 */
function repo(base: string, live: boolean) {
  const root = join(base, "checkout");
  mkdirSync(root, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.invalid", ...args], { cwd: root, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "dev");
  writeFileSync(join(root, "package-lock.json"), '{ "lock": 1 }\n');
  git("add", "-A"); git("commit", "-q", "-m", "A: where it runs");
  const a = git("rev-parse", "HEAD");
  git("checkout", "-q", "-b", "next");
  writeFileSync(join(root, "package-lock.json"), '{ "lock": 2 }\n');
  git("commit", "-q", "-am", "B: the update");
  git("checkout", "-q", "dev");
  if (live) git("checkout", "-q", "--detach", a);
  return { root, git, a, short: a.slice(0, 7) };
}

/** A project with queue Q running (first step slow), a Lifecycle around its engine, and everything recorded. */
async function setup(opts: { live: boolean; successor: "crash" | "never"; timeoutMs?: number }) {
  const base = mkdtempSync(join(tmpdir(), "nexus-rollback-"));
  process.env.NEXUS_HOME = join(base, "home");
  process.env.FAKE_SLOW_MS = WORK_MS;
  process.env.FAKE_SUCCESSOR = opts.successor;
  process.env.FAKE_LIFE_MS = "60000";
  const r = repo(base, opts.live);
  const root = join(base, "project");
  mkdirSync(root, { recursive: true });
  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  const steps: StepDef[] = ["slow", "done"].map((b, i) => ({ id: `Q${i + 1}`, title: `Step ${i + 1}`, goal: `FAKE: ${b}`, acceptance: [] }));
  store.writeQueue({ protocol: 1, id: "Q", title: "Queue", revision: 1, status: "proposed", stop_conditions: [], checks: [], steps, approvals: [], history: [] });
  approveQueue(store, "Q");

  const onChange = () => { routeAnswers(store); acceptReviews(store); engine.onChange(loadProjectState(store)); };
  let engine = new Engine(store, onChange);
  const npm: string[][] = [];
  const notified: string[] = [];
  let exited = false;
  const lifecycle = new Lifecycle(() => [{
    id: "p", idle: () => engine.idle(), drain: (now) => engine.drainForUpdate(now), cancel: () => engine.cancelDrain(), shutdown: () => engine.shutdown(),
  }], () => {}, {
    root: r.root,
    successor: [process.execPath, join(here, "fake-successor.ts")],
    timeoutMs: opts.timeoutMs ?? 15_000,
    npm: async (_root, ...args) => { npm.push(args); },
    release: async () => { engine.shutdown(); await until("the agent to exit", () => !engine.alive()); },
    reacquire: async () => { engine = new Engine(store, onChange); }, // as main.ts: new engines recover the held runs
    notify: (text) => notified.push(text),
    exit: () => { exited = true; },
  });
  const queue = () => loadProjectState(store).queues.find((q) => q.id === "Q")!;
  const stop = () => { engine.shutdown(); for (const k of ["FAKE_SLOW_MS", "FAKE_SUCCESSOR", "FAKE_LIFE_MS"]) delete process.env[k]; };
  engine.start("Q");
  await until("the first step to run", () => queue().steps[0]!.status === "running", LONGER.step);
  return { r, store, lifecycle, queue, npm, notified, exited: () => exited, stop };
}

const failed = (l: Lifecycle) => () => l.status.phase === "failed";
const show = (l: Lifecycle) => () => `; status: ${JSON.stringify(l.status, null, 1)}`;

test("a successor that crashes at start: the live worktree goes back, is reinstalled and rebuilt, and the held queue runs again", async () => {
  const t = await setup({ live: true, successor: "crash" });
  try {
    t.lifecycle.start({ ref: "next" });
    assert.deepEqual(t.lifecycle.status.held, ["p/Q"]);
    await until("the rollback", failed(t.lifecycle), LONGER.processes, show(t.lifecycle));
    const s = t.lifecycle.status;
    assert.match(s.error!, new RegExp(`the successor exited \\(1\\) before it was ready; rolled back to ${t.r.short}$`));
    assert.equal(t.r.git("rev-parse", "HEAD"), t.r.a, "the worktree is back on the commit it came from");
    const handover = join(process.env.NEXUS_HOME!, "handover");
    const pred = JSON.parse(readFileSync(join(handover, readdirSync(handover)[0]!, "predecessor.json"), "utf8")) as { commit: string; subject: string };
    assert.deepEqual([pred.commit, pred.subject], [t.r.short, "A: where it runs"], "the predecessor names the commit it ran, not the one it moved to");
    assert.equal(t.r.git("rev-parse", "--abbrev-ref", "HEAD"), "HEAD", "still detached");
    assert.deepEqual(t.npm.map((a) => a[0]), ["install", "run", "install", "run"], "installed and built for the update, then again for the rollback");
    assert.ok(s.log.some((l) => /moving the live worktree back to/.test(l)));
    assert.equal(t.exited(), false, "this server goes on");
    assert.equal(t.notified.length, 1);
    assert.match(t.notified[0]!, new RegExp(`Update failed: .*rolled back to ${t.r.short}`));
    await until("the held queue to finish", () => t.queue().run?.state === "finished", LONGER.processes, () => `; run: ${JSON.stringify(t.queue().run)}`);
    assert.deepEqual(t.queue().steps.map((x) => x.status), ["done", "done"]);
  } finally { t.stop(); }
});

test("a successor that never signals is stopped after the time limit, and the update rolls back", async () => {
  const t = await setup({ live: true, successor: "never", timeoutMs: 2500 });
  try {
    t.lifecycle.start({ ref: "next" });
    await until("the rollback", failed(t.lifecycle), LONGER.processes, show(t.lifecycle));
    const s = t.lifecycle.status;
    assert.match(s.error!, new RegExp(`no ready signal within 3 s; rolled back to ${t.r.short}$`));
    const pid = Number(/stopped the successor \(pid (\d+)\)/.exec(s.log.join("\n"))?.[1]);
    assert.ok(pid > 0, "it stopped the successor");
    assert.equal(isAlive(pid), false, "the successor no longer runs");
    assert.equal(t.r.git("rev-parse", "HEAD"), t.r.a);
    await until("the held queue to finish", () => t.queue().run?.state === "finished", LONGER.processes);
  } finally { t.stop(); }
});

test("in a development checkout nothing is moved: the server simply goes on", async () => {
  const t = await setup({ live: false, successor: "crash" });
  try {
    t.lifecycle.start({ ref: "next" });
    await until("the rollback", failed(t.lifecycle), LONGER.processes, show(t.lifecycle));
    assert.match(t.lifecycle.status.error!, /this server goes on \(a development checkout is not moved\)$/);
    assert.equal(t.r.git("rev-parse", "--abbrev-ref", "HEAD"), "dev", "still on its branch");
    assert.equal(t.r.git("rev-parse", "HEAD"), t.r.a);
    assert.deepEqual(t.npm.map((a) => a[0]), ["run"], "built once for the update; nothing to roll back");
    await until("the held queue to finish", () => t.queue().run?.state === "finished", LONGER.processes);
  } finally { t.stop(); }
});
