// The refs read from the .git files (src/gitfiles.ts) against real repositories: whatever the files say must be what
// git says (rev-parse of HEAD, MERGE_HEAD and a branch, branch --show-current), in a main checkout, in a worktree of
// its own, with packed refs, a symbolic and a detached HEAD, and a branch without a commit; where the files cannot
// tell, the reader says so and git is asked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { branchFromFiles, refFromFiles } from "../src/gitfiles.ts";
import { revParse } from "../src/gitinfo.ts";

const G = ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "-c", "init.defaultBranch=main", "-c", "commit.gpgsign=false"];
const git = (cwd: string, args: string[]) => execFileSync("git", [...G, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
/** What git itself says: the output, or undefined when it fails. */
const gitSays = (cwd: string, args: string[]) => { try { return git(cwd, args); } catch { return undefined; } };

function repo(t: { after: (fn: () => void) => void }) {
  const base = mkdtempSync(join(tmpdir(), "nexus-gitfiles-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, "project");
  mkdirSync(root);
  git(root, ["init", "-q", "-b", "main"]);
  let n = 0;
  const commit = (cwd: string) => { writeFileSync(join(cwd, `f${n}.txt`), `${n++}\n`); git(cwd, ["add", "-A"]); git(cwd, ["commit", "-q", "-m", `c${n}`]); return git(cwd, ["rev-parse", "HEAD"]); };
  return { base, root, commit };
}

/** The files answer every name, and as git does. */
function sameAsGit(cwd: string, names: string[]) {
  for (const name of names) {
    const files = refFromFiles(cwd, name);
    assert.ok(files, `the files could not tell ${name} in ${cwd}`);
    assert.equal(files.sha ?? undefined, gitSays(cwd, ["rev-parse", "-q", "--verify", name]), name);
    assert.equal(revParse(cwd, name), gitSays(cwd, ["rev-parse", "-q", "--verify", name]), `revParse ${name}`);
  }
  const branch = branchFromFiles(cwd);
  assert.ok(branch, `the files could not tell the branch in ${cwd}`);
  assert.equal(branch.branch, gitSays(cwd, ["branch", "--show-current"]) || null, "the branch");
}

test("a main checkout: a symbolic HEAD, a loose branch, a missing ref", (t) => {
  const { root, commit } = repo(t);
  commit(root);
  git(root, ["branch", "other"]);
  commit(root);
  sameAsGit(root, ["HEAD", "refs/heads/main", "refs/heads/other", "refs/heads/none", "MERGE_HEAD"]);
  assert.equal(refFromFiles(root, "HEAD")?.sha, git(root, ["rev-parse", "HEAD"]));
});

test("a branch without a commit yet: no HEAD, and the branch's name", (t) => {
  const { root } = repo(t);
  sameAsGit(root, ["HEAD", "refs/heads/main"]);
  assert.deepEqual(refFromFiles(root, "HEAD"), { sha: null });
  assert.deepEqual(branchFromFiles(root), { branch: "main" });
});

test("packed refs: a packed branch, a loose one over its packed value, an annotated tag", (t) => {
  const { root, commit } = repo(t);
  const first = commit(root);
  git(root, ["branch", "packed"]);
  git(root, ["tag", "-a", "v1", "-m", "v1"]);
  git(root, ["pack-refs", "--all"]);
  commit(root); // main moves on: loose again, over its packed line
  sameAsGit(root, ["HEAD", "refs/heads/main", "refs/heads/packed", "refs/tags/v1"]);
  assert.equal(refFromFiles(root, "refs/heads/packed")?.sha, first);
  // The tag's own object, not the commit it points at: as rev-parse gives it.
  assert.notEqual(refFromFiles(root, "refs/tags/v1")?.sha, first);
});

test("a detached HEAD", (t) => {
  const { root, commit } = repo(t);
  const first = commit(root);
  commit(root);
  git(root, ["checkout", "-q", "--detach", first]);
  sameAsGit(root, ["HEAD", "refs/heads/main"]);
  assert.deepEqual(branchFromFiles(root), { branch: null });
});

test("a worktree of its own: its own HEAD, the shared branches, packed or loose", (t) => {
  const { base, root, commit } = repo(t);
  commit(root);
  const wt = join(base, "wt");
  git(root, ["worktree", "add", "-q", "-b", "nexus/Q", wt]);
  const own = commit(wt);
  git(root, ["pack-refs", "--all"]);
  commit(root);
  sameAsGit(wt, ["HEAD", "refs/heads/main", "refs/heads/nexus/Q", "MERGE_HEAD"]);
  sameAsGit(root, ["HEAD", "refs/heads/nexus/Q"]);
  assert.equal(refFromFiles(wt, "HEAD")?.sha, own);
  assert.deepEqual(branchFromFiles(wt), { branch: "nexus/Q" });
  // Detached in the worktree: the main checkout's HEAD is untouched.
  git(wt, ["checkout", "-q", "--detach", "HEAD~1"]);
  sameAsGit(wt, ["HEAD"]);
  sameAsGit(root, ["HEAD"]);
});

test("a worktree made with relative paths (git 2.48 and later)", (t) => {
  const { base, root, commit } = repo(t);
  commit(root);
  const wt = join(base, "rel");
  if (gitSays(root, ["worktree", "add", "-q", "--relative-paths", "-b", "rel", wt]) === undefined) return t.skip("this git has no --relative-paths");
  commit(wt);
  sameAsGit(wt, ["HEAD", "refs/heads/main", "refs/heads/rel"]);
});

test("a merge under way in a worktree: MERGE_HEAD from its own folder", (t) => {
  const { base, root, commit } = repo(t);
  commit(root);
  const wt = join(base, "wt");
  git(root, ["worktree", "add", "-q", "-b", "nexus/Q", wt]);
  commit(wt);
  const theirs = commit(root);
  git(wt, ["merge", "--no-commit", "--no-ff", "main"]);
  sameAsGit(wt, ["MERGE_HEAD", "HEAD"]);
  assert.equal(refFromFiles(wt, "MERGE_HEAD")?.sha, theirs);
  assert.deepEqual(refFromFiles(root, "MERGE_HEAD"), { sha: null });
});

test("where the files cannot tell, git is asked", (t) => {
  const { base, root, commit } = repo(t);
  const sha = commit(root);
  // No .git in the folder itself: git would look in the folders above.
  const sub = join(root, "sub");
  mkdirSync(sub);
  assert.equal(refFromFiles(sub, "HEAD"), undefined);
  assert.equal(revParse(sub, "HEAD"), sha);
  // Not a full ref name.
  assert.equal(refFromFiles(root, "main"), undefined);
  assert.equal(refFromFiles(root, "refs/heads/../HEAD"), undefined);
  // Not a repository at all: neither tells.
  const none = join(base, "none");
  mkdirSync(none);
  assert.equal(refFromFiles(none, "HEAD"), undefined);
  assert.equal(revParse(none, "HEAD"), undefined);
  // A ref file that says something unexpected.
  writeFileSync(join(root, ".git", "refs", "heads", "odd"), "not a sha\n");
  assert.equal(refFromFiles(root, "refs/heads/odd"), undefined);
  // GIT_DIR moves the repository: only git knows where.
  process.env.GIT_DIR = join(root, ".git");
  t.after(() => { delete process.env.GIT_DIR; });
  assert.equal(refFromFiles(root, "HEAD"), undefined);
});
