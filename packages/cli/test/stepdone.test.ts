// `nexus step done` at a step's end (queue AS, nexus help commits): it warns, never refuses, when tracked files have
// uncommitted changes (the notes folder left out) or when HEAD moved since the step started and no commit is named;
// the warning is recorded on the step.done event. Against a temporary repository.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ProjectStore, loadProjectState, newId, updateSettings, type Event } from "@nexus/protocol";
import { cliOut } from "./run-cli.ts";

const G = ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false"];

function setup() {
  const root = mkdtempSync(join(tmpdir(), "nexus-stepdone-"));
  const git = (...a: string[]) => execFileSync("git", [...G, ...a], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q", "-b", "main");
  writeFileSync(join(root, ".gitignore"), ".nexus/\n");
  writeFileSync(join(root, "a.txt"), "a\n");
  mkdirSync(join(root, "docs/ideas"), { recursive: true });
  writeFileSync(join(root, "docs/ideas/mining.md"), "# Mining\n");
  git("add", "-A"); git("commit", "-qm", "init");
  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  updateSettings(store, { conversations: { notes_dir: "docs/ideas" } });
  store.writeSession({ protocol: 1, id: "w", project: "p", role: "worker", runtime: "claude", cwd: root, launched_by: "nexus", created_at: new Date().toISOString(), queue: "Q" });
  store.writeQueue({ protocol: 1, id: "Q", title: "Queue", revision: 1, status: "approved", stop_conditions: [], checks: [], steps: [{ id: "Q1", title: "Step", goal: "", acceptance: [] }] });
  // The step's start, as the engine records it.
  const start = git("rev-parse", "HEAD");
  store.writeGit("Q", { protocol: 1, steps: { Q1: [{ session: "w", start, started_at: new Date().toISOString() }] } });
  store.appendEvent({ v: 1, id: newId(), at: new Date().toISOString(), session: "w", type: "step.started", queue: "Q", step: "Q1" } as Event);
  const done = async (...extra: string[]) => {
    const env: NodeJS.ProcessEnv = { ...process.env, NEXUS_DIR: store.dir, NEXUS_SESSION: "w" };
    const out = await cliOut(["step", "done", "Q1", "--summary", "s", ...extra], { cwd: root, env });
    const last = store.readEvents("w").entries.filter((e) => e.type === "step.done").at(-1) as Extract<Event, { type: "step.done" }>;
    return { out, warning: last.warning };
  };
  return { root, git, done, start, store };
}

test("a clean tree with the commit named: no warning", async () => {
  const x = setup();
  const r = await x.done("--commit", x.start.slice(0, 7));
  assert.match(r.out, /^ok: step\.done Q\/Q1\s*$/);
  assert.equal(r.warning, undefined);
});

test("a dirty tracked file: the warning names it and says what to do; recorded on the event", async () => {
  const x = setup();
  writeFileSync(join(x.root, "a.txt"), "changed\n");
  const r = await x.done();
  assert.match(r.out, /^ok: step\.done Q\/Q1\nwarning: 1 tracked file has uncommitted changes: a\.txt\. Commit the step's own files \(by name\) and name the commit with --commit/);
  assert.match(r.warning!, /^1 tracked file has uncommitted changes: a\.txt\..*\(nexus help commits\)$/);
});

test("an untracked file and a change in the notes folder give no warning", async () => {
  const x = setup();
  writeFileSync(join(x.root, "scratch.txt"), "untracked\n");
  writeFileSync(join(x.root, "docs/ideas/mining.md"), "# Mining\n\nThe user's own note.\n");
  writeFileSync(join(x.root, "docs/ideas/new.md"), "new\n");
  const r = await x.done();
  assert.equal(r.warning, undefined, r.out);
});

test("HEAD moved since the step started and no --commit: the warning; with --commit: none", async () => {
  const x = setup();
  writeFileSync(join(x.root, "b.txt"), "b\n");
  x.git("add", "b.txt"); x.git("commit", "-qm", "the step's work");
  const head = x.git("rev-parse", "HEAD");
  let r = await x.done();
  assert.match(r.warning!, new RegExp(`HEAD moved since the step started \\(${x.start.slice(0, 7)} -> ${head.slice(0, 7)}\\) but no commit is named: run nexus step done again with --commit ${head.slice(0, 7)}`));
  r = await x.done("--commit", head.slice(0, 7));
  assert.equal(r.warning, undefined);
});

test("outside a git repository: no check, no warning", async () => {
  const root = mkdtempSync(join(tmpdir(), "nexus-stepdone-nogit-"));
  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  store.writeSession({ protocol: 1, id: "w", project: "p", role: "worker", runtime: "claude", cwd: root, launched_by: "nexus", created_at: new Date().toISOString(), queue: "Q" });
  store.writeQueue({ protocol: 1, id: "Q", title: "Queue", revision: 1, status: "approved", stop_conditions: [], checks: [], steps: [{ id: "Q1", title: "Step", goal: "", acceptance: [] }] });
  const env: NodeJS.ProcessEnv = { ...process.env, NEXUS_DIR: store.dir, NEXUS_SESSION: "w", GIT_CEILING_DIRECTORIES: dirname(root) };
  const out = await cliOut(["step", "done", "Q1", "--summary", "s"], { cwd: root, env });
  assert.doesNotMatch(out, /warning/);
});

test("--activities: what the worker did, from the lists; an unknown name is refused and nothing is recorded", async () => {
  const x = setup();
  x.store.writeTags({ ...x.store.readTags(), prefix: "p", activities: [{ name: "p:terrain", at: new Date().toISOString() }] });
  const err = await (async () => { try { await x.done("--commit", x.start.slice(0, 7), "--activities", "feature,frobnicate"); } catch (e) { return String((e as { stderr?: string }).stderr); } return ""; })();
  assert.match(err, /activity frobnicate is not one of Nexus's activities .*\(nexus tags lists the activities\)/);
  assert.equal(x.store.readEvents("w").entries.filter((e) => e.type === "step.done").length, 0, "refused before anything is recorded");
  const pending = await (async () => { try { await x.done("--activities", "p:rivers"); } catch (e) { return String((e as { stderr?: string }).stderr); } return ""; })();
  assert.match(pending, /activity p:rivers is not in the project's list/);
  await x.done("--commit", x.start.slice(0, 7), "--activities", "feature, p:terrain");
  const last = x.store.readEvents("w").entries.filter((e) => e.type === "step.done").at(-1) as Extract<Event, { type: "step.done" }>;
  assert.deepEqual(last.activities, ["feature", "p:terrain"]);
  assert.deepEqual(loadProjectState(x.store).queues[0]!.steps[0]!.observed_activities, ["feature", "p:terrain"]);
});

test("nexus context records a summary of any length, and warns when it is longer than the standard's 2,000 words", async () => {
  const { root, store } = setup();
  const env: NodeJS.ProcessEnv = { ...process.env, NEXUS_DIR: store.dir, NEXUS_SESSION: "w" };
  const context = async (text: string) => (await cliOut(["context", text, "--step", "Q1", "--topics", "t"], { cwd: root, env })).trim();
  assert.equal(await context("Where: Q1 done. ".repeat(10)), "ok: context summary recorded");
  const long = "word ".repeat(2001);
  const out = await context(long);
  assert.match(out, /^ok: context summary recorded; warning: it is 2001 words, longer than the standard's 2000 \(nexus help context\)/);
  const summaries = store.readEvents("w").entries.filter((e) => e.type === "context.summary");
  assert.equal(summaries.length, 2, "both recorded");
  assert.ok((summaries[1] as Extract<Event, { type: "context.summary" }>).text.trim() === long.trim(), "the long one whole");
});
