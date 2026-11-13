// Merge back and clean up a finished worktree queue (src/mergeback.ts), against temporary repositories: local git
// only, no remote at all.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectStore, newId, now } from "@nexus/protocol";
import { recordBase } from "../src/gitinfo.ts";
import { cleanUp, mergeBack } from "../src/mergeback.ts";

const G = ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "-c", "init.defaultBranch=main", "-c", "commit.gpgsign=false"];
const git = (cwd: string, ...args: string[]) => execFileSync("git", [...G, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const CLI = join(dirname(fileURLToPath(import.meta.url)), "../../../packages/cli/bin/nexus.js");

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
  assert.throws(() => cleanUp(x.store, "Q"), /cleaned up already/);
});

test("the orchestrator and workers have no way to merge or clean up", () => {
  const x = setup();
  for (const role of ["orchestrator", "worker"] as const) {
    const id = `s-${role}`;
    x.store.writeSession({ protocol: 1, id, project: "p", role, runtime: "external", cwd: x.root, launched_by: "external", created_at: now() });
    for (const cmd of [["queue", "merge", "Q"], ["queue", "cleanup", "Q"], ["merge", "Q"], ["cleanup", "Q"]]) {
      assert.throws(() => execFileSync(process.execPath, [CLI, ...cmd], { env: { ...process.env, NEXUS_SESSION: id, NEXUS_DIR: x.store.dir }, stdio: "pipe" }), /unknown command|usage|nexus/i, `${role}: nexus ${cmd.join(" ")}`);
    }
  }
  assert.equal(x.store.readGit("Q")!.merged, undefined);
  assert.ok(existsSync(x.wt));
  // The HTTP routes are the dashboard's only: test/guard.test.ts refuses every write route without its Origin.
});
