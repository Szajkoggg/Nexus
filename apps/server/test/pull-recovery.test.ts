// recoverPull (integration.ts) on what a server leaves at a step boundary's merge of the base (queue LF, F4; queue LH,
// the LS survey's findings 1 and 2): a real repository and worktree, no engine.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectStore, now } from "@nexus/protocol";
import { recoverPull } from "../src/integration.ts";

const G = ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false"];

function setup() {
  const base = mkdtempSync(join(tmpdir(), "nexus-pull-"));
  const root = join(base, "repo"), wt = join(base, "wt");
  process.env.NEXUS_HOME = join(base, "home");
  const git = (cwd: string, ...a: string[]) => execFileSync("git", [...G, ...a], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  execFileSync("git", ["init", "-q", "-b", "main", root]);
  writeFileSync(join(root, ".gitignore"), ".nexus/\n");
  writeFileSync(join(root, "package-lock.json"), "{}\n");
  git(root, "add", "-A"); git(root, "commit", "-qm", "init");
  git(root, "worktree", "add", "-q", "-b", "nexus/Q", wt);
  writeFileSync(join(wt, "q.txt"), "the queue's\n");
  git(wt, "add", "q.txt"); git(wt, "commit", "-qm", "queue");
  writeFileSync(join(root, "package-lock.json"), "{ \"lockfileVersion\": 3 }\n");
  git(root, "add", "package-lock.json"); git(root, "commit", "-qm", "main: lockfile");
  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  const from = git(wt, "rev-parse", "HEAD"), sha = git(root, "rev-parse", "main");
  store.writeGit("Q", {
    protocol: 1, steps: {},
    setup: { command: "npm ci", at: now(), done_at: now(), sha: from, reason: "first setup" },
    pulling: { at: now(), before: "Q2", base: "main", sha, from },
  });
  const q = { id: "Q", worktree: wt, integration: true as const };
  const mergeHead = () => existsSync(join(git(wt, "rev-parse", "--absolute-git-dir"), "MERGE_HEAD"));
  return { store, git, wt, q, from, sha, mergeHead };
}

test("a server that ended after the boundary's merge commit, before git.yaml: the pull is recorded and the setup marked to run again (queue LH, finding 1)", () => {
  const x = setup();
  x.git(x.wt, "merge", "--no-edit", x.sha); // the merge made; its record never written
  const to = x.git(x.wt, "rev-parse", "HEAD");
  assert.equal(recoverPull(x.store, x.q), undefined, "nothing halts the run");
  const g = x.store.readGit("Q")!;
  assert.equal(g.pulling, undefined, "the intent is finished");
  assert.deepEqual(g.pulls?.map((p) => [p.before, p.base, p.sha, p.from, p.to, p.setup]), [["Q2", "main", x.sha, x.from, to, true]], "the pull as pullBase records it");
  assert.equal(g.setup?.done_at, undefined, "the setup runs again before Q2: the merge changed the lockfile");
  assert.match(g.setup!.reason!, /package-lock\.json changed \(the merge of main\)/);
});

test("a HEAD that is no merge of the recorded intent: the intent goes, no pull is invented (queue LH, finding 1)", () => {
  const x = setup();
  writeFileSync(join(x.wt, "other.txt"), "x\n");
  x.git(x.wt, "add", "other.txt"); x.git(x.wt, "commit", "-qm", "another commit"); // HEAD moved, but not by the merge
  assert.equal(recoverPull(x.store, x.q), undefined);
  const g = x.store.readGit("Q")!;
  assert.equal(g.pulling, undefined);
  assert.equal(g.pulls, undefined);
  assert.ok(g.setup?.done_at, "the setup left as it was");
});

test("a half-done merge whose abort fails keeps its intent: the halt after Resume still names it as Nexus's (queue LH, finding 2)", () => {
  const x = setup();
  x.git(x.wt, "merge", "--no-commit", "--no-ff", x.sha);
  assert.ok(x.mergeHead());
  // The abort fails: another git process holds the worktree's index.
  const lock = join(x.git(x.wt, "rev-parse", "--absolute-git-dir"), "index.lock");
  writeFileSync(lock, "");
  const first = recoverPull(x.store, x.q);
  assert.match(first ?? "", /a server left half done .+ could not be aborted/);
  assert.ok(x.store.readGit("Q")!.pulling, "the intent is kept while the merge is still there");
  const again = recoverPull(x.store, x.q); // Resume, the lock still held
  assert.match(again ?? "", /could not be aborted/, "still Nexus's merge, not one 'that Nexus did not start'");
  unlinkSync(lock);
  assert.equal(recoverPull(x.store, x.q), undefined, "the lock gone: aborted now");
  assert.ok(!x.mergeHead());
  assert.equal(x.store.readGit("Q")!.pulling, undefined);
});
