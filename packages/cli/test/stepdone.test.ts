// `nexus step done` at a step's end (queue AS, nexus help commits): it warns, never refuses, when tracked files have
// uncommitted changes (the notes folder left out) or when HEAD moved since the step started and no commit is named;
// the warning is recorded on the step.done event. Against a temporary repository.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectStore, newId, updateSettings, type Event } from "@nexus/protocol";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "../bin/nexus.js");
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
  const done = (...extra: string[]) => {
    const env: NodeJS.ProcessEnv = { ...process.env, NEXUS_DIR: store.dir, NEXUS_SESSION: "w" };
    const out = execFileSync(process.execPath, [CLI, "step", "done", "Q1", "--summary", "s", ...extra], { cwd: root, env, encoding: "utf8", stdio: "pipe" });
    const last = store.readEvents("w").entries.filter((e) => e.type === "step.done").at(-1) as Extract<Event, { type: "step.done" }>;
    return { out, warning: last.warning };
  };
  return { root, git, done, start };
}

test("a clean tree with the commit named: no warning", () => {
  const x = setup();
  const r = x.done("--commit", x.start.slice(0, 7));
  assert.match(r.out, /^ok: step\.done Q\/Q1\s*$/);
  assert.equal(r.warning, undefined);
});

test("a dirty tracked file: the warning names it and says what to do; recorded on the event", () => {
  const x = setup();
  writeFileSync(join(x.root, "a.txt"), "changed\n");
  const r = x.done();
  assert.match(r.out, /^ok: step\.done Q\/Q1\nwarning: 1 tracked file has uncommitted changes: a\.txt\. Commit the step's own files \(by name\) and name the commit with --commit/);
  assert.match(r.warning!, /^1 tracked file has uncommitted changes: a\.txt\..*\(nexus help commits\)$/);
});

test("an untracked file and a change in the notes folder give no warning", () => {
  const x = setup();
  writeFileSync(join(x.root, "scratch.txt"), "untracked\n");
  writeFileSync(join(x.root, "docs/ideas/mining.md"), "# Mining\n\nThe user's own note.\n");
  writeFileSync(join(x.root, "docs/ideas/new.md"), "new\n");
  const r = x.done();
  assert.equal(r.warning, undefined, r.out);
});

test("HEAD moved since the step started and no --commit: the warning; with --commit: none", () => {
  const x = setup();
  writeFileSync(join(x.root, "b.txt"), "b\n");
  x.git("add", "b.txt"); x.git("commit", "-qm", "the step's work");
  const head = x.git("rev-parse", "HEAD");
  let r = x.done();
  assert.match(r.warning!, new RegExp(`HEAD moved since the step started \\(${x.start.slice(0, 7)} -> ${head.slice(0, 7)}\\) but no commit is named: run nexus step done again with --commit ${head.slice(0, 7)}`));
  r = x.done("--commit", head.slice(0, 7));
  assert.equal(r.warning, undefined);
});

test("outside a git repository: no check, no warning", () => {
  const root = mkdtempSync(join(tmpdir(), "nexus-stepdone-nogit-"));
  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  store.writeSession({ protocol: 1, id: "w", project: "p", role: "worker", runtime: "claude", cwd: root, launched_by: "nexus", created_at: new Date().toISOString(), queue: "Q" });
  store.writeQueue({ protocol: 1, id: "Q", title: "Queue", revision: 1, status: "approved", stop_conditions: [], checks: [], steps: [{ id: "Q1", title: "Step", goal: "", acceptance: [] }] });
  const env: NodeJS.ProcessEnv = { ...process.env, NEXUS_DIR: store.dir, NEXUS_SESSION: "w", GIT_CEILING_DIRECTORIES: dirname(root) };
  const out = execFileSync(process.execPath, [CLI, "step", "done", "Q1", "--summary", "s"], { cwd: root, env, encoding: "utf8", stdio: "pipe" });
  assert.doesNotMatch(out, /warning/);
});
