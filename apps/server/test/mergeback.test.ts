// Merge back and clean up a finished worktree queue (src/mergeback.ts), against temporary repositories: local git
// only, no remote at all.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectStore, newId, now } from "@nexus/protocol";
import { recordBase } from "../src/gitinfo.ts";
import { cleanUp, mergeBack, worktreeLeft } from "../src/mergeback.ts";
import { cliOut } from "../../../packages/cli/test/run-cli.ts";

const G = ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "-c", "init.defaultBranch=main", "-c", "commit.gpgsign=false"];
const git = (cwd: string, ...args: string[]) => execFileSync("git", [...G, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function setup(o: { done?: boolean } = {}) {
  const base = mkdtempSync(join(tmpdir(), "nexus-merge-"));
  process.env.NEXUS_HOME = join(base, "home");
  const root = join(base, "project");
  mkdirSync(root);
  git(root, "init", "-q", "-b", "main");
  // The repository's own identity, as a user's has: the server's merge commit needs one.
  git(root, "config", "user.name", "test"); git(root, "config", "user.email", "test@example.invalid"); git(root, "config", "commit.gpgsign", "false");
  writeFileSync(join(root, ".gitignore"), ".nexus/\n");
  const commit = (cwd: string, file: string, text: string) => { writeFileSync(join(cwd, file), text); git(cwd, "add", "-A"); git(cwd, "commit", "-q", "-m", `${file}: ${text.trim()}`); return git(cwd, "rev-parse", "HEAD"); };
  commit(root, "a.txt", "one\n");
  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  const wt = join(base, "project.worktrees", "Q");
  const q = { protocol: 1 as const, id: "Q", title: "Queue", revision: 1, status: (o.done === false ? "approved" : "done") as "done", stop_conditions: [], checks: [], approvals: [], history: [],
    worktree: "auto", branch: "nexus/Q", steps: [{ id: "Q1", title: "Step 1", goal: "", acceptance: [], status: (o.done === false ? "pending" : "done") as "done" }] };
  store.writeQueue(q);
  recordBase(store, store.readQueue("Q"), root); // as the engine does before making the worktree
  git(root, "worktree", "add", "-q", "-b", "nexus/Q", wt, "main");
  store.writeQueue({ ...store.readQueue("Q"), worktree: wt.replaceAll("\\", "/") });
  const head = (cwd = root) => git(cwd, "rev-parse", "HEAD");
  return { base, root, store, wt, commit, head };
}

test("a clean merge: a fast-forward when possible, else a merge commit; recorded", () => {
  const x = setup();
  assert.equal(x.store.readGit("Q")!.base!.ref, "main");
  assert.equal(x.store.readGit("Q")!.base!.branch, true);
  const tip = x.commit(x.wt, "b.txt", "work\n");
  assert.match(mergeBack(x.store, "Q"), /nexus\/Q merged into main .*\(fast-forward\)/);
  assert.equal(x.head(), tip);
  assert.equal(x.store.readGit("Q")!.merged!.fast_forward, true);
  assert.match(mergeBack(x.store, "Q"), /already merged/);

  const y = setup();
  y.commit(y.wt, "b.txt", "work\n");
  y.commit(y.root, "c.txt", "elsewhere\n");
  assert.match(mergeBack(y.store, "Q"), /merge commit [0-9a-f]{7}/);
  assert.equal(git(y.root, "rev-list", "--parents", "-n", "1", "HEAD").split(" ").length, 3, "two parents");
  assert.equal(y.store.readGit("Q")!.merged!.fast_forward, false);
  assert.equal(git(y.root, "status", "--porcelain", "--untracked-files=no"), "");
});

test("a conflict is aborted and nothing is left half-done", () => {
  const x = setup();
  x.commit(x.wt, "a.txt", "theirs\n");
  const before = x.commit(x.root, "a.txt", "ours\n");
  assert.throws(() => mergeBack(x.store, "Q"), /conflicts in a\.txt; it was aborted, nothing changed/);
  assert.equal(x.head(), before);
  assert.equal(git(x.root, "status", "--porcelain", "--untracked-files=no"), "");
  assert.throws(() => git(x.root, "rev-parse", "-q", "--verify", "MERGE_HEAD"));
  assert.equal(x.store.readGit("Q")!.merged, undefined);
});

test("the merge is refused when the base is busy: uncommitted changes, a run there, or checked out nowhere", () => {
  const x = setup();
  x.commit(x.wt, "b.txt", "work\n");
  writeFileSync(join(x.root, "a.txt"), "edited, not committed\n");
  assert.throws(() => mergeBack(x.store, "Q"), /has uncommitted changes/);
  git(x.root, "checkout", "--", "a.txt");

  // Another queue running in the project's own checkout, where main is.
  x.store.writeQueue({ protocol: 1, id: "R", title: "Running", revision: 1, status: "approved", stop_conditions: [], checks: [], approvals: [], history: [], steps: [{ id: "R1", title: "One", goal: "", acceptance: [] }] });
  x.store.writeRun("R", { protocol: 1, session: newId(), state: "running", started_at: now(), updated_at: now() });
  assert.throws(() => mergeBack(x.store, "Q"), /queue R is running in/);
  x.store.writeRun("R", { ...x.store.readRun("R")!, state: "paused" });

  git(x.root, "checkout", "-q", "--detach");
  assert.throws(() => mergeBack(x.store, "Q"), /main is not checked out in any worktree \(or only detached\)/);
  git(x.root, "checkout", "-q", "main");
  // This server's own live worktree (detached, as the live instance runs) is never a target either.
  assert.match(mergeBack(x.store, "Q", x.root), /merged into main/, "a checkout on a branch is not a live worktree");
});

test("only a finished worktree queue; cleanup refuses uncommitted changes and an unmerged branch, then removes with -d", () => {
  const n = setup({ done: false });
  assert.throws(() => mergeBack(n.store, "Q"), /is not finished/);
  assert.throws(() => cleanUp(n.store, "Q"), /is not finished/);

  const x = setup();
  x.commit(x.wt, "b.txt", "work\n");
  writeFileSync(join(x.wt, "scratch.txt"), "untracked\n");
  assert.throws(() => cleanUp(x.store, "Q"), /has uncommitted changes \(1 file: \?\? scratch\.txt\): commit or discard them first; nothing was removed/);
  // The refusal names what blocks it, e.g. a report left in the worktree.
  mkdirSync(join(x.wt, "tmp/reports"), { recursive: true });
  writeFileSync(join(x.wt, "tmp/reports/Q.md"), "a report left behind\n");
  writeFileSync(join(x.wt, "b.txt"), "changed\n");
  assert.throws(() => cleanUp(x.store, "Q"), /\(3 files: M b\.txt, \?\? scratch\.txt, \?\? tmp\/\): commit or discard/);
  rmSync(join(x.wt, "tmp"), { recursive: true }); git(x.wt, "checkout", "--", "b.txt");
  assert.ok(existsSync(x.wt));
  git(x.wt, "add", "scratch.txt"); git(x.wt, "commit", "-q", "-m", "scratch");
  assert.throws(() => cleanUp(x.store, "Q"), /nexus\/Q is not merged into main: merge it first; nothing was removed/);
  assert.ok(existsSync(x.wt));
  assert.ok(git(x.root, "branch", "--list", "nexus/Q"));

  mergeBack(x.store, "Q");
  assert.match(cleanUp(x.store, "Q"), /is removed and branch nexus\/Q deleted/);
  assert.ok(!existsSync(x.wt));
  assert.equal(git(x.root, "branch", "--list", "nexus/Q"), "");
  assert.ok(x.store.readGit("Q")!.cleaned);
  assert.match(cleanUp(x.store, "Q"), /cleaned up already/);
});

test("the orchestrator and workers have no way to merge or clean up", async () => {
  const x = setup();
  for (const role of ["orchestrator", "worker"] as const) {
    const id = `s-${role}`;
    x.store.writeSession({ protocol: 1, id, project: "p", role, runtime: "external", cwd: x.root, launched_by: "external", created_at: now() });
    for (const cmd of [["queue", "merge", "Q"], ["queue", "cleanup", "Q"], ["merge", "Q"], ["cleanup", "Q"]]) {
      await assert.rejects(async () => cliOut([...cmd], { env: { ...process.env, NEXUS_SESSION: id, NEXUS_DIR: x.store.dir } }), /unknown command|usage|nexus/i, `${role}: nexus ${cmd.join(" ")}`);
    }
  }
  assert.equal(x.store.readGit("Q")!.merged, undefined);
  assert.ok(existsSync(x.wt));
  // The HTTP routes are the dashboard's only: test/guard.test.ts refuses every write route without its Origin.
});

/** Reproduce the PT order deterministically: .git goes, some files go, then deletion fails. */
function interrupted(prune = false) {
  const x = setup();
  const tip = x.commit(x.wt, "b.txt", "merged work\n");
  mergeBack(x.store, "Q");
  assert.throws(() => cleanUp(x.store, "Q", { retries: 0, unlink: () => {
    unlinkSync(join(x.wt, ".git"));
    unlinkSync(join(x.wt, "b.txt"));
    if (prune) git(x.root, "worktree", "prune", "--expire=now");
    throw Object.assign(new Error("EPERM: injected partial deletion"), { code: "EPERM" });
  } }), /EPERM: injected/);
  assert.ok(x.store.readGit("Q")!.cleanup_proof, "proof reached disk before any deletion");
  assert.ok(existsSync(join(x.wt, "a.txt")));
  assert.throws(() => worktreeLeft(x.wt), /cannot read the state/, "the old retry's status check cannot recover");
  return { ...x, tip };
}

for (const prune of [false, true]) test(`partial deletion resumes from disk with registration ${prune ? "gone" : "remaining"}`, () => {
  const x = interrupted(prune);
  const restarted = new ProjectStore(x.store.dir);
  assert.match(cleanUp(restarted, "Q"), /is removed/);
  assert.equal(x.head(), x.tip, "the merged commit is untouched");
  assert.equal(git(x.root, "show", "HEAD:b.txt"), "merged work");
  assert.equal(existsSync(x.wt), false);
  assert.equal(git(x.root, "branch", "--list", "nexus/Q"), "");
  assert.equal(restarted.readGit("Q")!.cleanup_proof, undefined);
  assert.match(cleanUp(restarted, "Q"), /cleaned up already/);
});

for (const change of ["new file", "modified file", "replaced file", "replaced directory", "junction", "ignored file"] as const) {
  test(`retry preserves ${change} and refuses before deleting any remainder`, () => {
    const x = interrupted(true);
    const saved = readFileSync(join(x.wt, ".gitignore"), "utf8");
    switch (change) {
      case "new file": writeFileSync(join(x.wt, "foreign.txt"), "keep me"); break;
      case "modified file": writeFileSync(join(x.wt, "a.txt"), "foreign edit"); break;
      case "replaced file": renameSync(join(x.wt, "a.txt"), join(x.base, "old-a.txt")); writeFileSync(join(x.wt, "a.txt"), "one\n"); break;
      case "replaced directory": renameSync(x.wt, `${x.wt}-saved`); mkdirSync(x.wt); writeFileSync(join(x.wt, ".gitignore"), saved); break;
      case "junction": renameSync(x.wt, `${x.wt}-saved`); symlinkSync(`${x.wt}-saved`, x.wt, "junction"); break;
      case "ignored file": mkdirSync(join(x.wt, ".nexus")); writeFileSync(join(x.wt, ".nexus", "foreign.txt"), "keep me"); break;
    }
    assert.throws(() => cleanUp(new ProjectStore(x.store.dir), "Q"), /cleanup evidence.*(changed|replaced)/);
    assert.equal(readFileSync(join(x.wt, ".gitignore"), "utf8"), saved, "even unchanged files remain on refusal");
    assert.ok(git(x.root, "branch", "--list", "nexus/Q"));
    assert.equal(x.head(), x.tip);
  });
}

test("a legacy PT/WK remainder has an actionable refusal and can be preserved elsewhere before retry", () => {
  const x = setup();
  mergeBack(x.store, "Q");
  const original = readFileSync(join(x.wt, "a.txt"), "utf8");
  unlinkSync(join(x.wt, ".git"));
  git(x.root, "worktree", "prune", "--expire=now");
  assert.throws(() => cleanUp(x.store, "Q"), /no pre-deletion identity\/content manifest was saved.*Preserve the remaining folder/);
  assert.equal(readFileSync(join(x.wt, "a.txt"), "utf8"), original);
  renameSync(x.wt, `${x.wt}-preserved`);
  assert.match(cleanUp(x.store, "Q"), /is removed/);
  assert.equal(readFileSync(join(`${x.wt}-preserved`, "a.txt"), "utf8"), original);
});

test("a readable foreign repository at the queue path is not a clean worktree", () => {
  const x = setup();
  mergeBack(x.store, "Q");
  renameSync(x.wt, `${x.wt}-saved`);
  mkdirSync(x.wt);
  git(x.wt, "init", "-q", "-b", "main");
  x.commit(x.wt, "private.txt", "foreign repository");
  assert.throws(() => cleanUp(x.store, "Q"), /readable registered worktree/);
  assert.ok(existsSync(join(x.wt, "private.txt")));
});

test("missing folder with a stale registration is pruned before branch deletion", () => {
  const x = setup();
  mergeBack(x.store, "Q");
  rmSync(x.wt, { recursive: true });
  assert.match(cleanUp(x.store, "Q"), /is removed/);
  assert.equal(git(x.root, "branch", "--list", "nexus/Q"), "");
  assert.match(cleanUp(x.store, "Q"), /cleaned up already/);
});

test("cleanup removes only its registration and leaves an unrelated missing worktree registered", () => {
  const x = setup();
  const other = join(x.base, "other");
  git(x.root, "worktree", "add", "-q", "-b", "other", other, "main");
  rmSync(other, { recursive: true });
  mergeBack(x.store, "Q");
  cleanUp(x.store, "Q");
  assert.match(git(x.root, "worktree", "list", "--porcelain"), /branch refs\/heads\/other/);
});

test("an existing ignored junction is unlinked without traversing the foreign target", () => {
  const x = setup();
  const outside = join(x.base, "foreign");
  mkdirSync(outside);
  writeFileSync(join(outside, "keep.txt"), "foreign");
  symlinkSync(outside, join(x.wt, ".nexus"), "junction");
  mergeBack(x.store, "Q");
  cleanUp(x.store, "Q");
  assert.equal(readFileSync(join(outside, "keep.txt"), "utf8"), "foreign");
});

test("a changed ignored file from the initial snapshot is protected on retry", () => {
  const x = setup();
  mkdirSync(join(x.wt, ".nexus"));
  const file = join(x.wt, ".nexus", "ignored.txt");
  writeFileSync(file, "original ignored content");
  mergeBack(x.store, "Q");
  assert.throws(() => cleanUp(x.store, "Q", { unlink: () => { throw new Error("EPERM: injected"); } }), /EPERM/);
  writeFileSync(file, "foreign edit after cleanup began");
  assert.throws(() => cleanUp(x.store, "Q"), /new, modified or replaced/);
  assert.equal(readFileSync(file, "utf8"), "foreign edit after cleanup began");
});

test("switching the registered worktree to another branch invalidates pending cleanup", () => {
  const x = setup();
  mergeBack(x.store, "Q");
  assert.throws(() => cleanUp(x.store, "Q", { unlink: () => { throw new Error("injected interruption"); } }), /injected/);
  git(x.wt, "checkout", "-q", "-b", "foreign");
  assert.throws(() => cleanUp(x.store, "Q"), /registered worktree now belongs to another branch/);
  assert.ok(existsSync(join(x.wt, "a.txt")));
});

test("interruption before branch deletion resumes; interruption after deletion can finish recording", () => {
  const x = setup();
  mergeBack(x.store, "Q");
  const lock = join(x.root, ".git", "refs", "heads", "nexus", "Q.lock");
  writeFileSync(lock, "injected branch lock");
  assert.throws(() => cleanUp(x.store, "Q"), /cannot lock ref|could not remove/);
  assert.equal(existsSync(x.wt), false);
  assert.ok(x.store.readGit("Q")!.cleanup_proof);
  unlinkSync(lock);
  git(x.root, "branch", "-d", "nexus/Q"); // crash after branch -d but before cleaned is written
  assert.match(cleanUp(new ProjectStore(x.store.dir), "Q"), /is removed/);
  assert.ok(x.store.readGit("Q")!.cleaned);
});

test("a changed branch or a base that lost the merged commit keeps the remainder", () => {
  for (const ref of ["refs/heads/nexus/Q", "refs/heads/main"]) {
    const x = interrupted(true);
    git(x.root, "update-ref", ref, `${x.tip}~1`);
    assert.throws(() => cleanUp(x.store, "Q"), /branch no longer matches|not merged/);
    assert.ok(existsSync(join(x.wt, "a.txt")));
  }
});

test("a new ignored file arriving during removal is never recursively deleted", () => {
  const x = setup();
  mergeBack(x.store, "Q");
  let inserted = false;
  assert.throws(() => cleanUp(x.store, "Q", { retries: 0, unlink: (path) => {
    unlinkSync(path);
    if (!inserted) { inserted = true; mkdirSync(join(x.wt, ".nexus")); writeFileSync(join(x.wt, ".nexus", "foreign.txt"), "keep"); }
  } }), /ENOTEMPTY|not empty/);
  assert.equal(readFileSync(join(x.wt, ".nexus", "foreign.txt"), "utf8"), "keep");
  assert.throws(() => cleanUp(x.store, "Q"), /new, modified or replaced/);
});

test("a transient Windows removal lock is retried with evidence rechecked", () => {
  const x = setup();
  mergeBack(x.store, "Q");
  let attempts = 0;
  cleanUp(x.store, "Q", { unlink: (path) => {
    if (++attempts === 1) throw Object.assign(new Error("injected busy file"), { code: "EBUSY" });
    unlinkSync(path);
  } });
  assert.ok(attempts > 1);
  assert.equal(existsSync(x.wt), false);
});

test("a path-only queue can retry completed cleanup without touching a recreated folder or branch", () => {
  const x = setup();
  x.store.writeQueue({ ...x.store.readQueue("Q"), branch: undefined });
  cleanUp(x.store, "Q");
  mkdirSync(x.wt);
  writeFileSync(join(x.wt, "foreign.txt"), "new work");
  git(x.root, "branch", "nexus/Q", "main");
  assert.match(cleanUp(new ProjectStore(x.store.dir), "Q"), /cleaned up already/);
  assert.equal(readFileSync(join(x.wt, "foreign.txt"), "utf8"), "new work");
  assert.ok(git(x.root, "branch", "--list", "nexus/Q"));
});
