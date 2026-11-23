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
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ProjectStore, applyDraft, approveQueue, fillTemplate, loadProjectState, parseTemplate, routeAnswers, updateSettings, type QueueView,
} from "@nexus/protocol";
import { Engine, SURVEY_CONDITION } from "../src/engine.ts";
import { Merger } from "../src/merger.ts";
import { cleanUp } from "../src/mergeback.ts";
import { acceptReviews } from "./fake-reviewer.ts";
import { QUICK_ENGINE, LONGER, sleep, until as waitUntil } from "./wait.ts";

const here = dirname(fileURLToPath(import.meta.url));
process.env.NEXUS_CLAUDE = join(here, "fake-claude.ts");
process.env.NEXUS_CODEX = join(here, "fake-codex.ts");

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

function setup(o: { mergeBack?: boolean } = {}) {
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
  const merger = new Merger(store, { start: (id) => void engine.start(id), release: (id, why) => engine.releaseHold(id, why), busy: () => false, serverRoot: join(base, "elsewhere") });
  const tick = () => { routeAnswers(store); if (reviews.accept) acceptReviews(store); const s = loadProjectState(store); engine.onChange(s); merger.onChange(s); };
  const engine: Engine = new Engine(store, tick, { ...QUICK_ENGINE, retryBaseMs: 30, startupMs: 20 });
  const timer = setInterval(tick, 150);
  const view = (id: string): QueueView => loadProjectState(store).queues.find((x) => x.id === id)!;
  const until = (what: string, id: string, pred: (q: QueueView) => boolean, ms: number = LONGER.processes) =>
    waitUntil(what, () => pred(view(id)), ms, () => `; ${id}: ${view(id).status}, run ${JSON.stringify(view(id).run)}; ${view(id).steps.map((s) => `${s.id}=${s.status}`).join(" ")}; git ${JSON.stringify(store.readGit(id))}`);
  const branchExists = (branch: string) => { try { git(root, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`); return true; } catch { return false; } };
  const stop = () => { clearInterval(timer); merger.shutdown(); engine.shutdown(); };
  return { base, root, store, git, queue, engine, reviews, view, until, branchExists, stop };
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
