// A git read that does not answer is never an empty result (queue CI13): the stopped step's commits read past a short
// time limit are "unreadable" with why, and the lift is refused with nothing recorded, never let through without Keep
// or Discard. The slow git is made so: `git log` checks each commit's signature (log.showSignature) with a gpg program
// that sleeps; `git status` runs an fsmonitor hook that sleeps. Only git runs here: no server, no runtime.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectStore, approveQueue, loadProjectState, newId } from "@nexus/protocol";
import { gitRead, noAnswer, stepCommits } from "../src/gitinfo.ts";
import { decideStoppedWork, readStoppedWork } from "../src/stopwork.ts";

const G = ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "-c", "init.defaultBranch=main", "-c", "commit.gpgsign=false"];
const git = (cwd: string, args: string[]) => execFileSync("git", [...G, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
/**
 * The sleep of the slow git's helper, far past the reads' limit; the limit itself leaves a git that is not slowed room
 * to answer on a machine busy with the full suite (an unslowed read took over 1 s there).
 */
const SLEEP_S = 20;
const LIMIT = { timeout: 5000 };
const script = (dir: string, name: string, body: string) => {
  writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
  return join(dir, name).replaceAll("\\", "/");
};

/** A queue stopped at Q1, whose round in git.yaml holds one signed commit of its own (`Q1 work`). */
function setup(o: { start?: string } = {}) {
  const base = mkdtempSync(join(tmpdir(), "nexus-git-unreadable-"));
  process.env.NEXUS_HOME = join(base, "home");
  const root = join(base, "project");
  const tools = join(base, "tools");
  mkdirSync(root); mkdirSync(tools);
  git(root, ["init", "-q", "-b", "main"]);
  writeFileSync(join(root, ".gitignore"), ".nexus/\n");
  git(root, ["add", "-A"]); git(root, ["commit", "-q", "-m", "start"]);
  const start = git(root, ["rev-parse", "HEAD"]);
  // A signature git accepts at commit time; checking it later is the slow part.
  const sign = script(tools, "sign.sh", "cat >/dev/null\necho '[GNUPG:] SIG_CREATED D 1 8 00 0 0' >&2\nprintf -- '-----BEGIN PGP SIGNATURE-----\\n\\nAAAA\\n-----END PGP SIGNATURE-----\\n'");
  writeFileSync(join(root, "work.txt"), "the step's work\n");
  git(root, ["add", "work.txt"]);
  git(root, ["-c", `gpg.program=${sign}`, "commit", "-q", "-S", "-m", "Q1 work"]);
  const end = git(root, ["rev-parse", "HEAD"]);
  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  store.writeQueue({ protocol: 1, id: "Q", title: "Queue", revision: 1, status: "proposed", stop_conditions: [], checks: [], approvals: [], history: [],
    steps: [{ id: "Q1", title: "Step 1", goal: "", acceptance: [] }, { id: "Q2", title: "Step 2", goal: "", acceptance: [] }] });
  approveQueue(store, "Q");
  const at = (ms: number) => new Date(Date.now() + ms).toISOString();
  store.writeSession({ protocol: 1, id: "S1", project: "p", role: "worker", runtime: "external", cwd: root, launched_by: "external", created_at: at(-60_000) });
  store.appendEvent({ v: 1, id: newId(), at: at(-30_000), session: "S1", type: "step.started", queue: "Q", step: "Q1" });
  store.appendEvent({ v: 1, id: newId(), at: at(-20_000), session: "S1", type: "queue.stop", queue: "Q", step: "Q1", condition: "c", reason: "r" });
  const from = o.start ?? start;
  store.writeGit("Q", { protocol: 1, steps: { Q1: [{ session: "S1", start: from, end, started_at: at(-30_000), ended_at: at(-20_000), turns: [{ start: from, end }] }] } });
  const queue = () => loadProjectState(store).queues.find((q) => q.id === "Q")!;
  assert.equal(queue().status, "stopped");
  return { root, tools, store, queue, end };
}

test("a step's commits that git does not read in time are unreadable, not none: the lift is refused and nothing is recorded", async () => {
  const x = setup();
  git(x.root, ["config", "log.showSignature", "true"]);
  git(x.root, ["config", "gpg.program", script(x.tools, "slow-gpg.sh", `sleep ${SLEEP_S}\nexit 1`)]);

  const t0 = Date.now();
  const left = (await readStoppedWork(x.store, "Q", LIMIT))!;
  assert.ok(Date.now() - t0 < SLEEP_S * 1000, `the read gave up at its limit (${Date.now() - t0} ms)`);
  assert.deepEqual(left.commits, [], "nothing was read");
  assert.match(left.unreadable?.commits ?? "", /^git did not answer within 5 s$/, "and that is said, not an empty list");
  assert.equal(left.unreadable?.uncommitted, undefined, "the status answered");
  const view = (await stepCommits(x.store, x.queue(), "Q1", LIMIT))!;
  assert.match(view.unreadable ?? "", /did not answer within 5 s/, "the step's commits view says so too");

  for (const choice of [undefined, "keep", "discard"]) {
    assert.throws(() => decideStoppedWork(x.store, "Q", choice, "user_continue", left),
      (e: Error & { status?: number }) => /the commits of step Q1 cannot be read \(git did not answer within 5 s\); nothing was recorded: try again/.test(e.message) && e.status === 409);
  }
  assert.equal(x.queue().changes.length, 0, "nothing recorded");
  assert.equal(x.queue().status, "stopped", "the stop stays");

  // Once git checks no signature it answers: the commit is the step's, and the lift asks Keep or Discard.
  git(x.root, ["config", "--unset", "log.showSignature"]);
  const read = (await readStoppedWork(x.store, "Q"))!;
  assert.deepEqual([read.commits.map((c) => c.subject), read.unreadable], [["Q1 work"], undefined]);
  assert.throws(() => decideStoppedWork(x.store, "Q", undefined, "user_continue", read), /step Q1 left 1 commit of its own: choose Keep or Discard/);
});

test("a status that git does not answer in time is unreadable; the step's commits still decide the lift", async () => {
  const x = setup();
  git(x.root, ["config", "core.fsmonitor", script(x.tools, "slow-hook.sh", `sleep ${SLEEP_S}\nexit 1`)]);
  git(x.root, ["config", "core.fsmonitorHookVersion", "2"]);
  writeFileSync(join(x.root, "scratch.txt"), "left by someone\n");

  const left = (await readStoppedWork(x.store, "Q", LIMIT))!;
  assert.deepEqual(left.uncommitted, []);
  assert.match(left.unreadable?.uncommitted ?? "", /did not answer within 5 s/);
  assert.equal(left.unreadable?.commits, undefined);
  assert.deepEqual(left.commits.map((c) => c.subject), ["Q1 work"]);
  assert.throws(() => decideStoppedWork(x.store, "Q", undefined, "user_continue", left), /choose Keep or Discard/);
  assert.deepEqual(decideStoppedWork(x.store, "Q", "keep", "user_continue", left), { proceed: true });
});

test("a round whose start commit is gone has no commits, as before: git answered, and that is no unreadable read", async () => {
  const x = setup({ start: "0123456789abcdef0123456789abcdef01234567" });
  const left = (await readStoppedWork(x.store, "Q"))!;
  assert.deepEqual([left.commits, left.unreadable], [[], undefined]);
  assert.deepEqual(decideStoppedWork(x.store, "Q", undefined, "user_continue", left), { proceed: true });
});

test("gitRead: an exit code is git's answer; a time limit is no answer, with why", async () => {
  const x = setup();
  const no = await gitRead(x.root, ["rev-parse", "--verify", "--quiet", "refs/heads/nope"]);
  assert.deepEqual([no.ok, !no.ok && no.code, noAnswer(no)], [false, 1, false]);
  git(x.root, ["config", "core.fsmonitor", script(x.tools, "slow-hook.sh", `sleep ${SLEEP_S}\nexit 1`)]);
  git(x.root, ["config", "core.fsmonitorHookVersion", "2"]);
  const slow = await gitRead(x.root, ["status", "--porcelain"], LIMIT);
  assert.ok(noAnswer(slow) && slow.reason === "git did not answer within 5 s", JSON.stringify(slow));
  const gone = await gitRead(join(x.root, "not-there"), ["status"]);
  assert.deepEqual([!gone.ok && gone.code, noAnswer(gone)], [128, false], "a folder that is not there is a no, not a git that did not answer");
});
