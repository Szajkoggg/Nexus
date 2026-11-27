// A survey run in a worktree of its own (docs/protocol/git.md, "Cleaning up a survey's worktree"), against the fake runtimes and
// temporary git repositories: it works in its worktree and has no integration step (it leaves no commit, so nothing goes
// back to main); once done, Nexus removes its worktree and branch, whatever merge_back says, only when the worktree is
// clean. Untracked files left keep it, and the user is told what is left (a "cleanup" item); a stopped or failed survey
// keeps its worktree, as evidence; a commit stops it, as in the project's checkout. The same template in fix_small mode
// ends with the integration step, as any worktree queue.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ProjectStore, applyDraft, approveQueue, fillTemplate, loadProjectState, parseTemplate, routeAnswers, updateSettings, type QueueView,
} from "@nexus/protocol";
import { Engine, SURVEY_CONDITION } from "../src/engine.ts";
import { Merger } from "../src/merger.ts";
import { cleanUp } from "../src/mergeback.ts";
import { acceptReviews } from "./fake-reviewer.ts";
import { QUICK_ENGINE, LONGER, sleep, until as waitUntil } from "./wait.ts";
import { inProcessRuntime } from "./in-process-runtime.ts";

/** The system's temporary folder, read once: each project sets TEMP to a folder of its own (the report's folder). */
const TMP = tmpdir();
const G = ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false"];

/** A maintenance template whose survey step does what `what` says to the fake, with a fixing step for fix_small. */
const TEMPLATE = `template:
  id: care
  title: Care
maintenance: survey
worktree: auto
params:
  - name: what
    description: what the fake does
    default: done
title: "Care: {{what}}"
steps:
  - id: "{{id}}1"
    title: Survey
    goal: "FAKE: {{what}}"
    size: S
  - id: "{{id}}2"
    maintenance: fix_small
    title: Fix
    goal: "FAKE: done"
    size: S
`;

/** `left.on`: the Merger's processesLeft answers `left.value` instead of the engine's, and counts its asks. */
function setup(o: { mergeBack?: boolean; left?: { on: boolean; value?: string; asks: number } } = {}) {
  const base = mkdtempSync(join(TMP, "nexus-survey-wt-"));
  const temp = join(base, "temp");
  mkdirSync(temp);
  process.env.TEMP = temp; process.env.TMP = temp; process.env.TMPDIR = temp;
  const root = join(base, "project");
  mkdirSync(root);
  process.env.NEXUS_HOME = join(base, "home");
  process.env.FAKE_LOG = join(base, "fake.log");
  process.env.FAKE_REVIEW_ACCEPT = "1";
  const git = (cwd: string, ...a: string[]) => execFileSync("git", [...G, ...a], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git(root, "init", "-q", "-b", "main");
  writeFileSync(join(root, ".gitignore"), ".nexus/\n");
  git(root, "add", "-A"); git(root, "commit", "-qm", "init");
  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  if (o.mergeBack) updateSettings(store, { defaults: { merge_back: true } });
  const template = parseTemplate(TEMPLATE, "project", join(root, "care.yaml"));
  /** A queue from the template, approved: `what` for its survey step, in the mode given (the template's: survey). */
  const queue = (id: string, what: string, maintenance?: "survey" | "fix_small") => {
    assert.match(applyDraft(store, fillTemplate(template, { what }, id, { maintenance })), /created as proposed/);
    approveQueue(store, id);
  };
  const reviews = { accept: true };
  const left = o.left;
  const merger = new Merger(store, {
    start: (id) => void engine.start(id), release: (id, why) => engine.releaseHold(id, why), busy: () => false, serverRoot: join(base, "elsewhere"),
    ...(left ? { processesLeft: (q: string) => { if (!left.on) return engine.queueProcessesLeft(q); left.asks++; return left.value; } } : {}),
  });
  const tick = () => { routeAnswers(store); if (reviews.accept) acceptReviews(store); const s = loadProjectState(store); engine.onChange(s); merger.onChange(s); };
  const engine: Engine = new Engine(store, tick, { spawn: inProcessRuntime(), ...QUICK_ENGINE, retryBaseMs: 30, startupMs: 20 });
  const timer = setInterval(tick, 150);
  const view = (id: string): QueueView => loadProjectState(store).queues.find((x) => x.id === id)!;
  const until = (what: string, id: string, pred: (q: QueueView) => boolean, ms: number = LONGER.processes) =>
    waitUntil(what, () => pred(view(id)), ms, () => `; ${id}: ${view(id).status}, run ${JSON.stringify(view(id).run)}; ${view(id).steps.map((s) => `${s.id}=${s.status}`).join(" ")}; git ${JSON.stringify(store.readGit(id))}`);
  const branchExists = (branch: string) => { try { git(root, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`); return true; } catch { return false; } };
  const stop = () => { clearInterval(timer); merger.shutdown(); engine.shutdown(); };
  /**
   * After stop: the next server's engine and Merger on the same files (as engine-setup's restart, with the Merger beside
   * it), the processes asked of the engine itself; `stop` ends them. The engine's recovery runs as at a start.
   */
  const next = () => {
    const m = new Merger(store, {
      start: (id) => void e.start(id), release: (id, why) => e.releaseHold(id, why), busy: () => false, serverRoot: join(base, "elsewhere"),
    });
    const t = () => { routeAnswers(store); if (reviews.accept) acceptReviews(store); const st = loadProjectState(store); e.onChange(st); m.onChange(st); };
    const e: Engine = new Engine(store, t, { spawn: inProcessRuntime(), ...QUICK_ENGINE, retryBaseMs: 30, startupMs: 20 });
    const tm = setInterval(t, 150);
    return { engine: e, merger: m, stop: () => { clearInterval(tm); m.shutdown(); e.shutdown(); } };
  };
  return { base, root, store, git, queue, engine, reviews, view, until, branchExists, stop, next };
}

test("a survey run in a worktree of its own works there, has no integration step, and its worktree and branch go once it is done, merge_back off or on", async () => {
  for (const mergeBack of [false, true]) {
    const x = setup({ mergeBack });
    try {
      x.queue("SV", "done");
      x.engine.start("SV", { runtime: "claude" });
      assert.deepEqual(x.view("SV").steps.map((s) => s.id), ["SV1"], "no integration step, no closing step");
      const wt = x.store.readQueue("SV").worktree!;
      assert.notEqual(wt, "auto");
      assert.ok(existsSync(wt), "its worktree was made");
      await x.until("the worktree cleaned up", "SV", (q) => !!q.git?.cleaned);
      const q = x.view("SV");
      assert.equal(q.status, "done");
      // It worked in its worktree: the worker's session ran there.
      const workers = loadProjectState(x.store).sessions.filter((s) => s.role === "worker" && s.queue === "SV");
      assert.ok(workers.length > 0 && workers.every((s) => s.cwd.replaceAll("\\", "/").toLowerCase() === wt.replaceAll("\\", "/").toLowerCase()), JSON.stringify(workers.map((s) => s.cwd)));
      assert.equal(existsSync(wt), false, "the worktree is removed");
      assert.equal(x.branchExists("nexus/SV"), false, "its branch is deleted");
      assert.deepEqual([q.git?.cleaned?.branch, q.git?.merged, q.git?.merge, q.git?.cleanup], ["nexus/SV", undefined, undefined, undefined], "nothing merged back, nothing waits");
      assert.deepEqual(loadProjectState(x.store).attention.filter((a) => a.queue === "SV"), [], `merge_back ${mergeBack}: nothing waits for the user`);
    } finally { x.stop(); }
  }
});

test("a done survey's cleanup waits while its worker processes live: the reason recorded as its wait, looked at again, and it goes once they have ended (survey LC3 F3 a)", async () => {
  const left = { on: true, value: "" as string | undefined, asks: 0 };
  const x = setup({ left });
  try {
    x.queue("SV", "done");
    x.engine.start("SV", { runtime: "claude" });
    const wt = x.store.readQueue("SV").worktree!;
    await x.until("SV done", "SV", (q) => q.status === "done" && q.run?.state === "finished");
    await waitUntil("two asks about its processes", () => left.asks >= 2, LONGER.processes);
    assert.ok(existsSync(wt), "the worktree stays while they live");
    assert.equal(x.store.readGit("SV")?.cleanup, undefined, "nothing recorded while they were only now asked to end");
    left.value = "queue SV's cleanup waits for its worker process to end (session s)";
    await x.until("the wait recorded", "SV", (q) => q.git?.cleanup?.waiting.reason === left.value);
    assert.equal(x.store.readGit("SV")!.cleanup!.waiting.processes, true, "a wait for the processes: Nexus looks again");
    assert.ok(loadProjectState(x.store).attention.some((a) => a.kind === "cleanup" && a.queue === "SV" && a.text === left.value), "the waiting list shows it");
    const asks = left.asks;
    await waitUntil("looked at again", () => left.asks > asks, LONGER.processes);
    left.value = undefined;
    await x.until("the worktree cleaned up", "SV", (q) => !!q.git?.cleaned);
    assert.equal(existsSync(wt), false);
    assert.equal(x.store.readGit("SV")!.cleanup, undefined, "the wait is gone");
  } finally { x.stop(); }
});

// Survey LC4 finding 5 (queue LCG): the recorded wait for the processes (processes: true) across a restart. The next
// server's Merger looks again by itself: the processes are gone (the old server's ended with it, their records marked
// exited by the recovery), so the worktree goes, git.cleaned is set and the wait is gone, without the user's Clean up.
test("a done survey's cleanup waiting for its worker processes, then a restart: the next engine and Merger clean it up by themselves, the wait gone", async () => {
  const left = { on: true, value: "queue SV's cleanup waits for its worker process to end (session s)" as string | undefined, asks: 0 };
  const x = setup({ left });
  let n: ReturnType<typeof x.next> | undefined;
  try {
    x.queue("SV", "done");
    x.engine.start("SV", { runtime: "claude" });
    const wt = x.store.readQueue("SV").worktree!;
    await x.until("the wait recorded", "SV", (q) => q.status === "done" && q.git?.cleanup?.waiting.reason === left.value);
    assert.equal(x.store.readGit("SV")!.cleanup!.waiting.processes, true, "a wait for the processes");
    x.stop();
    assert.ok(existsSync(wt), "the worktree is still there when the server stops");
    assert.equal(x.store.readGit("SV")!.cleanup!.waiting.processes, true, "and the wait is recorded");
    n = x.next();
    await x.until("the worktree cleaned up by the next server", "SV", (q) => !!q.git?.cleaned);
    assert.equal(existsSync(wt), false, "the worktree is removed");
    assert.equal(x.store.readGit("SV")!.cleanup, undefined, "the wait is gone");
    assert.equal(x.branchExists("nexus/SV"), false, "its branch is deleted");
    assert.deepEqual(loadProjectState(x.store).attention.filter((a) => a.queue === "SV"), [], "nothing waits for the user");
  } finally { x.stop(); n?.stop(); }
});

test("untracked files left in a survey's worktree keep it, and the user is told what is left; their Clean up removes it afterwards", async () => {
  const x = setup();
  try {
    x.queue("SV", "untracked");
    x.engine.start("SV", { runtime: "claude" });
    await x.until("the cleanup to wait", "SV", (q) => !!q.git?.cleanup);
    const wt = x.store.readQueue("SV").worktree!;
    const q = x.view("SV");
    assert.equal(q.status, "done");
    assert.ok(existsSync(join(wt, "SV1-left.txt")), "the worktree stays, with what was left in it");
    assert.ok(x.branchExists("nexus/SV"));
    assert.deepEqual(q.git?.cleanup?.waiting.files, ["?? SV1-left.txt"]);
    assert.equal(q.git?.cleaned, undefined);
    const items = loadProjectState(x.store).attention.filter((a) => a.queue === "SV");
    assert.deepEqual(items.map((a) => a.kind), ["cleanup"], "one item, not a merge back");
    assert.match(items[0]!.text, /^survey run SV is done, but its worktree stays: 1 file: \?\? SV1-left\.txt left in it; look at them, then clean up \(/);
    // Nexus does not try again by itself.
    await sleep(600);
    assert.ok(existsSync(wt));
    // The user looked and deleted the file: their Clean up goes, and the item is gone.
    rmSync(join(wt, "SV1-left.txt"));
    assert.match(cleanUp(x.store, "SV"), /is removed and branch nexus\/SV deleted/);
    assert.equal(existsSync(wt), false);
    const after = x.view("SV");
    assert.equal(after.git?.cleanup, undefined);
    assert.deepEqual(loadProjectState(x.store).attention.filter((a) => a.queue === "SV"), []);
  } finally { x.stop(); }
});

test("a stopped or failed survey keeps its worktree, as evidence", async () => {
  const x = setup();
  try {
    x.queue("ST", "stop");
    x.engine.start("ST", { runtime: "claude" });
    await x.until("ST to stop", "ST", (q) => q.status === "stopped" && q.run?.state === "halted");
    x.queue("FA", "fail");
    x.engine.start("FA", { runtime: "claude" });
    await x.until("FA's step to fail", "FA", (q) => q.steps[0]!.status === "failed" && !!q.run && q.run.state !== "running");
    await sleep(600);
    for (const id of ["ST", "FA"]) {
      assert.ok(existsSync(x.store.readQueue(id).worktree!), `${id}: the worktree stays`);
      assert.ok(x.branchExists(`nexus/${id}`), id);
      assert.deepEqual([x.view(id).git?.cleaned, x.view(id).git?.cleanup], [undefined, undefined], id);
    }
  } finally { x.stop(); }
});

test("a survey that commits in its worktree is stopped there, and its worktree stays", async () => {
  const x = setup();
  try {
    // The step is checked when it reports its end, before its review: here nobody reviews it meanwhile.
    x.reviews.accept = false;
    x.queue("CM", "commit");
    x.engine.start("CM", { runtime: "claude" });
    await x.until("CM to stop", "CM", (q) => q.status === "stopped");
    const q = x.view("CM");
    assert.equal(q.stop?.condition, SURVEY_CONDITION);
    assert.match(q.stop?.reason ?? "", /^the survey run left 1 commit since step CM1 began$/);
    const wt = x.store.readQueue("CM").worktree!;
    assert.equal(x.git(wt, "log", "-1", "--format=%s"), "CM1 work", "the commit is in the worktree's branch");
    assert.equal(x.git(x.root, "log", "-1", "--format=%s"), "init", "not in the project's checkout");
    await x.until("CM's run to halt", "CM", (v) => v.run?.state === "halted");
    await sleep(600);
    assert.ok(existsSync(wt), "the worktree stays");
    assert.equal(x.view("CM").git?.cleaned, undefined);
  } finally { x.stop(); }
});

test("the same template in fix_small mode ends with the integration step, and nothing removes its worktree with merge_back off", async () => {
  const x = setup();
  try {
    x.queue("FX", "done", "fix_small");
    x.engine.start("FX", { runtime: "claude" });
    assert.deepEqual(x.view("FX").steps.map((s) => s.id), ["FX1", "FX2", "FX.integrate"]);
    await x.until("FX to finish", "FX", (q) => q.run?.state === "finished");
    await sleep(600);
    const q = x.view("FX");
    assert.deepEqual(q.steps.map((s) => `${s.id}=${s.status}`), ["FX1=done", "FX2=done", "FX.integrate=done"]);
    assert.ok(existsSync(x.store.readQueue("FX").worktree!), "the user merges back and cleans up");
    assert.deepEqual([q.git?.cleaned, q.git?.cleanup], [undefined, undefined]);
  } finally { x.stop(); }
});
