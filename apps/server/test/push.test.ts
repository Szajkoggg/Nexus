// Push on deploy (src/deploy.ts, Lifecycle.arrived): once a live instance's update is up, the deployed main goes to
// main's upstream, fast-forward only, without prompts, within a time limit; whatever happens to the push, the deploy
// stands. Against a temporary repository whose upstream is a temporary bare repository (or a local socket that never
// answers): never a real remote.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Lifecycle } from "../src/lifecycle.ts";
import { PUSH_TIMEOUT_MS, pushDeployed, runGit, writeDeploySettings, type GitRunner } from "../src/deploy.ts";

const G = ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "-c", "init.defaultBranch=main", "-c", "commit.gpgsign=false"];
const git = (cwd: string, ...args: string[]) => execFileSync("git", [...G, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/**
 * A bare "remote", a working repository whose main tracks it (commit A pushed), and commit B on main not yet pushed,
 * checked out detached as a live worktree is after an update to main.
 */
function setup(live = true) {
  const base = mkdtempSync(join(tmpdir(), "nexus-push-"));
  process.env.NEXUS_HOME = join(base, "home");
  const remote = join(base, "remote.git");
  git(base, "init", "-q", "--bare", "-b", "main", remote);
  const work = join(base, "work");
  mkdirSync(work);
  git(work, "init", "-q", "-b", "main");
  writeFileSync(join(work, "a.txt"), "A\n");
  git(work, "add", "-A"); git(work, "commit", "-q", "-m", "A");
  git(work, "remote", "add", "origin", remote);
  git(work, "push", "-q", "-u", "origin", "main");
  const a = git(work, "rev-parse", "HEAD");
  writeFileSync(join(work, "b.txt"), "B\n");
  git(work, "add", "-A"); git(work, "commit", "-q", "-m", "B: the deployed commit");
  const b = git(work, "rev-parse", "HEAD");
  if (live) git(work, "checkout", "-q", "--detach", "main");
  assert.equal(git(work, "remote", "get-url", "origin"), remote, "the upstream is the temporary bare repository");
  const remoteMain = () => git(remote, "rev-parse", "refs/heads/main");
  return { base, remote, work, a, b, remoteMain };
}

/** Records every git call (arguments and options) and runs it. */
function recorder() {
  const calls: { args: string[]; env: NodeJS.ProcessEnv; timeout: number }[] = [];
  const run: GitRunner = (root, args, opts) => { calls.push({ args, ...opts }); return runGit(root, args, opts); };
  return { calls, run };
}

/** What a successor does once it took over: arrived(), then the push. */
async function deploy(work: string, ref: string | undefined, run?: GitRunner) {
  const l = new Lifecycle(() => [], () => {}, { root: work, git: run });
  l.arrived({ commit: "new", subject: "the deployed commit" }, { pid: 1, commit: "old", subject: "old", at: "" }, { at: "", log: ["10:00:00 moving the live worktree"], ref });
  await l.pushing;
  return l.status;
}

test("a live deploy of main pushes exactly the deployed commit to main's upstream", async () => {
  const t = setup();
  const r = recorder();
  const s = await deploy(t.work, "main", r.run);
  assert.equal(t.remoteMain(), t.b, "the remote has the deployed commit");
  assert.equal(s.phase, "updated");
  assert.equal(s.push?.result, "pushed");
  assert.match(s.push!.text, new RegExp(`^${t.b.slice(0, 7)} is now origin/main$`));
  assert.ok(s.log.some((l) => /pushed: .* is now origin\/main/.test(l)), s.log.join("\n"));
});

test("the push runs without prompts, within 60 s, as a plain fast-forward push of the commit", async () => {
  const t = setup();
  const r = recorder();
  await deploy(t.work, "main", r.run);
  const push = r.calls.find((c) => c.args[0] === "push")!;
  assert.deepEqual(push.args, ["push", "origin", `${t.b}:refs/heads/main`], "the commit itself, to main; no --force, no +");
  assert.equal(push.env.GIT_TERMINAL_PROMPT, "0");
  assert.equal(push.env.GCM_INTERACTIVE, "never");
  assert.equal(push.timeout, 60_000);
  assert.equal(PUSH_TIMEOUT_MS, 60_000);
  for (const c of r.calls) assert.ok(!c.args.some((a) => a === "--force" || a === "-f" || a.startsWith("--force") || a.startsWith("+")), c.args.join(" "));
});

test("a rejected push leaves the deploy done and says why", async () => {
  const t = setup();
  // Someone else pushed meanwhile: the remote's main is no longer an ancestor of the deployed commit.
  const other = join(t.base, "other");
  git(t.base, "clone", "-q", t.remote, other);
  writeFileSync(join(other, "c.txt"), "C\n");
  git(other, "add", "-A"); git(other, "commit", "-q", "-m", "C: elsewhere");
  git(other, "push", "-q", "origin", "main");
  const c = t.remoteMain();
  const s = await deploy(t.work, "main");
  assert.equal(s.phase, "updated", "the deploy stands");
  assert.equal(s.push?.result, "failed");
  assert.match(s.push!.text, /^the remote rejected it \((fetch first|non-fast-forward)\): its main has commits the deployed one does not/);
  assert.ok(s.log.some((l) => /push failed: .*; the deploy stands/.test(l)), s.log.join("\n"));
  assert.equal(t.remoteMain(), c, "the remote is untouched: nothing forced");
});

test("with push on deploy off, nothing is pushed", async () => {
  const t = setup();
  writeDeploySettings({ push_on_deploy: false });
  const r = recorder();
  const s = await deploy(t.work, "main", r.run);
  assert.equal(s.push?.result, "skipped");
  assert.equal(s.push?.text, "push on deploy is off");
  assert.equal(r.calls.length, 0, "git was not even asked");
  assert.equal(t.remoteMain(), t.a);
});

test("a deployed ref other than main is not pushed, and the log says why", async () => {
  for (const ref of ["v2/cliffs", undefined]) {
    const t = setup();
    const r = recorder();
    const s = await deploy(t.work, ref, r.run);
    assert.equal(s.push?.result, "skipped");
    assert.equal(s.push?.text, ref ? `the deployed ref is ${ref}, not main` : "the deployed ref is not known");
    assert.ok(s.log.some((l) => /not pushed: the deployed ref/.test(l)));
    assert.equal(r.calls.length, 0);
    assert.equal(t.remoteMain(), t.a);
  }
});

test("a development checkout is never pushed; main without an upstream fails with the reason", async () => {
  const dev = setup(false);
  const s = await deploy(dev.work, "main");
  assert.equal(s.push?.result, "skipped");
  assert.match(s.push!.text, /not a live instance/);
  assert.equal(dev.remoteMain(), dev.a);

  const t = setup();
  git(t.work, "config", "--unset", "branch.main.remote");
  const u = await deploy(t.work, "main");
  assert.equal(u.push?.result, "failed");
  assert.match(u.push!.text, /no upstream remote/);
  assert.equal(u.phase, "updated");
});

test("a push that hangs counts as failed once the time limit is over", async () => {
  const t = setup();
  // A "remote" that accepts the connection and never answers.
  const sockets = new Set<Socket>();
  const silent = createServer((s) => { sockets.add(s); s.on("error", () => {}); });
  await new Promise<void>((r) => silent.listen(0, "127.0.0.1", () => r()));
  const port = (silent.address() as { port: number }).port;
  git(t.work, "remote", "set-url", "origin", `http://127.0.0.1:${port}/never.git`);
  try {
    const started = Date.now();
    const res = await pushDeployed({ root: t.work, ref: "main", live: true, settings: { push_on_deploy: true }, timeout: 2000 });
    assert.equal(res.result, "failed");
    assert.match(res.text, /no answer within 2 s/);
    assert.ok(Date.now() - started < 15_000, "it gave up at the limit");
  } finally {
    for (const s of sockets) s.destroy();
    silent.close();
  }
});
