// The integration step in the engine (docs/protocol/git.md, "The integration step"), against the fake runtimes and temporary
// git repositories: a queue with a worktree of its own ends with it (after the closing step, whatever `coding` says);
// its worker merges the current base into the queue's branch in the worktree. A clean merge is done; a conflict is
// resolved only when the project's resolve_conflicts allows it; one not resolved stops the queue for the user, whose
// Continue runs the step again; a revision's new step makes it run again at the end. The base itself never moves here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { INTEGRATION_CONDITION, ProjectStore, applyDraft, approveQueue, loadProjectState, routeAnswers, updateSettings, type StepDef } from "@nexus/protocol";
import { Engine } from "../src/engine.ts";
import { acceptReviews } from "./fake-reviewer.ts";
import { LONGER, holdWork, until as waitUntil } from "./wait.ts";

const here = dirname(fileURLToPath(import.meta.url));
process.env.NEXUS_CLAUDE = join(here, "fake-claude.ts");
process.env.NEXUS_CODEX = join(here, "fake-codex.ts");

const step = (id: string, behaviour: string): StepDef => ({ id, title: `Step ${id}`, goal: `FAKE: ${behaviour}`, acceptance: [] });
const G = ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false"];

function setup(steps: StepDef[], o: { coding?: boolean; resolve?: boolean } = {}) {
  const base = mkdtempSync(join(tmpdir(), "nexus-integrate-"));
  const temp = join(base, "temp");
  mkdirSync(temp);
  process.env.TEMP = temp; process.env.TMP = temp; process.env.TMPDIR = temp;
  const root = join(base, "project");
  mkdirSync(root);
  process.env.NEXUS_HOME = join(base, "home");
  process.env.FAKE_LOG = join(base, "fake.log");
  const git = (cwd: string, ...a: string[]) => execFileSync("git", [...G, ...a], { cwd, encoding: "utf8" }).trim();
  git(root, "init", "-q", "-b", "main");
  writeFileSync(join(root, ".gitignore"), ".nexus/\n");
  git(root, "add", "-A"); git(root, "commit", "-qm", "init");
  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  if (o.resolve) updateSettings(store, { defaults: { resolve_conflicts: true } });
  store.writeQueue({ protocol: 1, id: "Q", title: "Queue", revision: 1, status: "proposed", worktree: "auto", ...(o.coding ? { coding: true } : {}), stop_conditions: [], checks: [], steps });
  approveQueue(store, "Q");
  const engines: Engine[] = [];
  const engine = (): Engine => {
    const e: Engine = new Engine(store, () => { routeAnswers(store); acceptReviews(store); e.onChange(loadProjectState(store)); }, { retryBaseMs: 30, usageMarginMs: 100 });
    engines.push(e);
    return e;
  };
  const queue = () => loadProjectState(store).queues.find((q) => q.id === "Q")!;
  const received = () => (existsSync(process.env.FAKE_LOG!) ? readFileSync(process.env.FAKE_LOG!, "utf8").trim().split("\n") : [])
    .map((l) => JSON.parse(l) as { text: string; session: string | null });
  const openings = () => received().filter((r) => /(^|\n)\[Nexus\] Queue Q /.test(r.text)).map((r) => ({ ...r, step: /step (\S+) \(\d+ of \d+\)/.exec(r.text)![1]! }));
  const until = (what: string, pred: () => boolean, ms: number = LONGER.processes) =>
    waitUntil(what, pred, ms, () => `; run ${JSON.stringify(queue().run)}; ${queue().steps.map((s) => `${s.id}=${s.status}`).join(" ")}; ${queue().status_reason ?? ""}`);
  const wt = () => store.readQueue("Q").worktree!;
  /** `a` is an ancestor of (or the same commit as) `b` in the worktree. */
  const contains = (b: string, a: string) => { try { git(wt(), "merge-base", "--is-ancestor", a, b); return true; } catch { return false; } };
  /** A commit on main in the project's checkout, as other work reaching the base while the queue runs. */
  const onMain = (file: string, text: string) => { writeFileSync(join(root, file), text); git(root, "add", file); git(root, "commit", "-qm", `main: ${file}`); return git(root, "rev-parse", "HEAD"); };
  const stop = () => { for (const e of engines) e.shutdown(); };
  return { root, store, git, engine, queue, openings, until, wt, contains, onMain, stop };
}

test("a worktree queue without coding ends with the integration step: a clean merge of the moved base is done, and the base stays", async () => {
  const hold = holdWork();
  const x = setup([step("Q1", "commit"), step("Q2", "slow")]);
  try {
    x.engine().start("Q", { runtime: "claude" });
    assert.deepEqual(x.queue().steps.map((s) => s.id), ["Q1", "Q2", "Q.integrate"], "no closing step without coding; the integration step last");
    await x.until("Q2 at work", () => x.queue().steps[1]!.status === "running");
    const main = x.onMain("main.txt", "from main\n");
    hold.release();
    await x.until("the run finished", () => x.queue().run?.state === "finished");
    const q = x.queue();
    assert.deepEqual(q.steps.map((s) => `${s.id}=${s.status}`), ["Q1=done", "Q2=done", "Q.integrate=done"]);
    assert.equal(q.status, "done");
    assert.deepEqual(x.openings().map((o) => o.step), ["Q1", "Q2", "Q.integrate"]);

    const opening = x.openings().at(-1)!.text;
    assert.ok(opening.includes("step Q.integrate (3 of 3): Integration."), opening);
    assert.ok(opening.includes("This is the queue's integration step, kept by Nexus: it runs last, in the queue's worktree, on the queue's branch nexus/Q."), opening);
    assert.ok(opening.includes(`git merge --no-edit main (the base branch main is at ${main} now)`), opening);
    assert.ok(opening.includes("- A conflict: do not resolve it (the project's resolve_conflicts setting is off)"), "off by default");
    assert.ok(opening.includes(`--condition "${INTEGRATION_CONDITION}"`), opening);
    // The report is the last step's before the integration step (queue MI): the integration step's worker writes none.
    assert.ok(!opening.includes("This is the queue's last step"), opening);
    assert.ok(x.openings().find((o) => o.step === "Q2")!.text.includes("This is the queue's last step before its integration step"));
    assert.ok(q.report, "the queue has its report");

    // The merge is on the queue's branch, with both sides; main has not moved (the fast-forward is not this step's).
    const head = x.git(x.wt(), "rev-parse", "HEAD");
    assert.equal(q.steps.at(-1)!.commit, head);
    assert.ok(x.contains(head, main), "the branch contains main's new commit");
    assert.ok(existsSync(join(x.wt(), "Q1.txt")) && existsSync(join(x.wt(), "main.txt")));
    assert.equal(x.git(x.root, "rev-parse", "main"), main, "main stays where it was");
    assert.equal(x.store.readQueue("Q").integration, true, "marked when the worktree was made");
  } finally { hold.done(); x.stop(); }
});

test("a conflict is resolved when the project allows it, and the merge is reviewed and done", async () => {
  const hold = holdWork();
  const x = setup([step("Q1", "commit"), step("Q2", "slow")], { resolve: true });
  try {
    x.engine().start("Q", { runtime: "claude" });
    await x.until("Q2 at work", () => x.queue().steps[1]!.status === "running");
    const main = x.onMain("Q1.txt", "main's own Q1\n"); // the same file the queue's Q1 committed: a conflict
    hold.release();
    await x.until("the run finished", () => x.queue().run?.state === "finished");
    const q = x.queue();
    assert.equal(q.status, "done");
    const integ = q.steps.at(-1)!;
    assert.equal(integ.status, "done");
    assert.match(integ.summary!, /resolved Q1\.txt/);
    assert.ok(x.openings().at(-1)!.text.includes("- A conflict: resolve it (the project lets you: its resolve_conflicts setting is on)."));
    const head = x.git(x.wt(), "rev-parse", "HEAD");
    assert.ok(x.contains(head, main));
    assert.equal(readFileSync(join(x.wt(), "Q1.txt"), "utf8").trim(), "Q1", "resolved as the fake does: the queue's side");
    assert.equal(x.git(x.wt(), "status", "--porcelain"), "", "the worktree is clean");
  } finally { hold.done(); x.stop(); }
});

test("a conflict it cannot resolve stops the queue for the user, with the merge aborted; Continue runs the step again", async () => {
  const hold = holdWork();
  const x = setup([step("Q1", "commit"), step("Q2", "slow")], { resolve: true });
  const giveUp = join(dirname(process.env.FAKE_LOG!), "give-up");
  writeFileSync(giveUp, "");
  process.env.FAKE_INTEGRATE_GIVE_UP = giveUp;
  try {
    const e = x.engine();
    e.start("Q", { runtime: "claude" });
    await x.until("Q2 at work", () => x.queue().steps[1]!.status === "running");
    const main = x.onMain("Q1.txt", "main's own Q1\n");
    hold.release();
    await x.until("the queue stopped", () => x.queue().status === "stopped" && x.queue().run?.state === "halted");
    const q = x.queue();
    assert.equal(q.stop_step, "Q.integrate");
    assert.equal(q.stop?.condition, INTEGRATION_CONDITION);
    assert.match(q.stop!.reason, /conflict in Q1\.txt not resolved/);
    const head = x.git(x.wt(), "rev-parse", "HEAD");
    assert.ok(!x.contains(head, main), "nothing of the merge is left on the branch");
    assert.equal(x.git(x.wt(), "status", "--porcelain"), "", "the merge was aborted: the worktree is clean");
    assert.notEqual(q.run?.state, "finished", "the run waits");

    // The user goes on (here the worker may now resolve it): the step runs again and the queue is done.
    rmSync(giveUp);
    e.continueQueue("Q");
    await x.until("the run finished", () => x.queue().run?.state === "finished");
    assert.equal(x.queue().status, "done");
    assert.deepEqual(x.openings().map((o) => o.step), ["Q1", "Q2", "Q.integrate", "Q.integrate"]);
    assert.ok(x.contains(x.git(x.wt(), "rev-parse", "HEAD"), main));
  } finally { delete process.env.FAKE_INTEGRATE_GIVE_UP; hold.done(); x.stop(); }
});

test("with resolve_conflicts off, a conflict is not resolved: the merge is aborted and the queue stops", async () => {
  const hold = holdWork();
  const x = setup([step("Q1", "commit"), step("Q2", "slow")]);
  try {
    x.engine().start("Q", { runtime: "claude" });
    await x.until("Q2 at work", () => x.queue().steps[1]!.status === "running");
    const main = x.onMain("Q1.txt", "main's own Q1\n");
    hold.release();
    await x.until("the queue stopped", () => x.queue().status === "stopped" && x.queue().run?.state === "halted");
    const opening = x.openings().at(-1)!.text;
    assert.ok(opening.includes("- A conflict: do not resolve it (the project's resolve_conflicts setting is off). Abort the merge (git merge --abort)"), opening);
    assert.ok(!opening.includes("resolve it (the project lets you"), opening);
    assert.equal(x.queue().stop_step, "Q.integrate");
    assert.ok(!x.contains(x.git(x.wt(), "rev-parse", "HEAD"), main));
    assert.equal(readFileSync(join(x.wt(), "Q1.txt"), "utf8").trim(), "Q1", "the queue's file as it was");
    assert.equal(x.git(x.wt(), "status", "--porcelain"), "");
  } finally { hold.done(); x.stop(); }
});

// One test, not two (queue TT2): each wait below is one run to its end, which a split would keep as it is; and a second
// test starting from a finished first run would need that run's end made by hand (the worktree and its merge, the
// integration mark, the closing step's first stretch at work in the events, the finished run and its session), a copy
// of what the engine does, which this test checks. The two runs wait LONGER.closingRun instead.
test("after the closing step, and again at the end once a revision's new step has run", async () => {
  const x = setup([step("Q1", "done")], { coding: true });
  try {
    const e = x.engine();
    e.start("Q", { runtime: "claude" });
    await x.until("the first run finished", () => x.queue().run?.state === "finished" && x.queue().status === "done", LONGER.closingRun);
    assert.deepEqual(x.openings().map((o) => o.step), ["Q1", "Q.refactor", "Q.integrate"]);
    const first = x.queue().run!.started_at;

    applyDraft(x.store, { id: "Q", title: "Queue", stop_conditions: [], checks: [], steps: [step("Q1", "done"), step("Q2", "done")] });
    approveQueue(x.store, "Q");
    assert.equal(x.store.readQueue("Q").integration, true, "the revision keeps the mark");
    assert.deepEqual(x.queue().steps.map((s) => s.id), ["Q1", "Q2", "Q.refactor", "Q.integrate"]);
    assert.notEqual(x.queue().status, "done");
    e.start("Q", { runtime: "claude" });
    await x.until("the second run finished", () => x.queue().run?.started_at !== first && x.queue().run?.state === "finished", LONGER.closingRun);
    assert.deepEqual(x.openings().map((o) => o.step), ["Q1", "Q.refactor", "Q.integrate", "Q2", "Q.refactor", "Q.integrate"]);
    const q = x.queue();
    assert.equal(q.status, "done");
    assert.equal(q.steps.at(-1)!.segments.length, 2);
  } finally { x.stop(); }
});
