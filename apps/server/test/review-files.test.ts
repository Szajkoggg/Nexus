// Review material in the queue's folder: a worker kept out of .nexus (protect_nexus, the default) writes its files
// outside the working tree and adds them with nexus review add, which copies them into
// .nexus/queues/<queue>/review/<step>/ (the CLI writes, not the worker's file tools). A worktree queue then leaves a
// clean worktree, its cleanup succeeds, and the copies outlast it. The dashboard serves the copies, and material added
// before (paths in the working tree) as it did.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectStore, approveQueue, loadProjectState, newId, normPath, now, routeAnswers, writeRegistry, type StepDef } from "@nexus/protocol";
import { Engine } from "../src/engine.ts";
import { cleanUp } from "../src/mergeback.ts";
import { spawnServer } from "./helpers.ts";
import { acceptReviews } from "./fake-reviewer.ts";

const here = dirname(fileURLToPath(import.meta.url));
process.env.NEXUS_CLAUDE = join(here, "fake-claude.ts");
process.env.NEXUS_CODEX = join(here, "fake-codex.ts");
const CLI = join(here, "../../../packages/cli/bin/nexus.js");

function setup() {
  const base = mkdtempSync(join(tmpdir(), "nexus-review-files-"));
  // A temporary directory of this test's own (the worker inherits it): where the worker writes its review files.
  const temp = join(base, "temp");
  mkdirSync(temp);
  process.env.TEMP = temp; process.env.TMP = temp; process.env.TMPDIR = temp;
  const root = join(base, "project");
  mkdirSync(root);
  process.env.NEXUS_HOME = join(base, "home");
  process.env.FAKE_LOG = join(base, "fake.log");
  process.env.FAKE_ARGS = join(base, "args.log");
  const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...a], { cwd: root, stdio: "ignore" });
  git("init", "-q", "-b", "main"); writeFileSync(join(root, ".gitignore"), ".nexus/\n"); writeFileSync(join(root, "a.txt"), "a\n");
  git("add", "-A"); git("commit", "-qm", "init");
  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  const steps: StepDef[] = [{ id: "R1", title: "With review material", goal: "FAKE: review", acceptance: [] }];
  store.writeQueue({ protocol: 1, id: "Q", title: "Queue", revision: 1, status: "proposed", stop_conditions: [], checks: [], steps, worktree: "auto" });
  approveQueue(store, "Q");
  return { base, temp, root, store };
}

test("a protected worker's review files are copied into the queue's folder; the worktree stays clean and is cleaned up", async () => {
  const { temp, root, store } = setup();
  assert.equal(store.readProject().defaults.protect_nexus, true);
  const engine: Engine = new Engine(store, () => { routeAnswers(store); acceptReviews(store); engine.onChange(loadProjectState(store)); });
  const queue = () => loadProjectState(store).queues.find((q) => q.id === "Q")!;
  try {
    engine.start("Q", { runtime: "claude" });
    for (const t = Date.now(); queue().run?.state !== "finished";) {
      if (Date.now() - t > 60_000) assert.fail(`timed out; run ${JSON.stringify(queue().run)}`); // as report.test.ts: the work, under load
      await new Promise((r) => setTimeout(r, 100));
    }
    const argv = readFileSync(process.env.FAKE_ARGS!, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { argv?: string[] })[0]!.argv!;
    assert.ok(argv.some((a) => a.includes("Write(//") && a.includes(".nexus/**")), "the worker's file tools may not write under .nexus");

    const dir = normPath(store.reviewDir("Q", "R1"));
    const items = queue().steps[0]!.review_items;
    assert.deepEqual(items.map((x) => [x.path, x.key ?? null, x.role ?? null]), [
      [`${dir}/r1-shot@492.png`, "r1-shot@492", "result"],
      [`${dir}/notes.md`, null, null],
    ]);
    for (const x of items) assert.ok(existsSync(x.path!), x.path);
    assert.ok(existsSync(join(temp, "nexus-review", "R1", "notes.md")), "the source stays where the worker wrote it");

    // As in report.test.ts: the cleanup comes after the worker's process has exited (Windows keeps its folder).
    for (const t = Date.now(); store.readRuntime(queue().run!.session)?.state !== "exited";) {
      if (Date.now() - t > 20_000) assert.fail("the worker's process did not exit");
      await new Promise((r) => setTimeout(r, 100));
    }
    const wt = store.readQueue("Q").worktree!;
    assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: wt, encoding: "utf8" }).trim(), "", "a clean worktree");
    assert.match(cleanUp(store, "Q"), /is removed and branch nexus\/Q deleted/);
    assert.ok(!existsSync(wt));
    for (const x of items) assert.ok(existsSync(x.path!), "the copies outlast the worktree");
    assert.ok(!existsSync(join(root, "tmp")), "nothing written into the project's working tree");
  } finally { engine.shutdown(); }
});

const freePort = () => new Promise<number>((resolve) => {
  const s = createServer();
  s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); });
});

test("the dashboard serves a copy in the queue's folder and material added before, in the working tree", async () => {
  const base = mkdtempSync(join(tmpdir(), "nexus-review-serve-"));
  process.env.NEXUS_HOME = join(base, "home");
  const root = join(base, "project"), outside = join(base, "temp");
  mkdirSync(join(root, "tmp", "review"), { recursive: true }); mkdirSync(outside);
  const st = ProjectStore.init(root, { id: "p", name: "P", root });
  st.writeQueue({ protocol: 1, id: "Q", title: "Queue", revision: 1, status: "approved", stop_conditions: [], checks: [], approvals: [], history: [],
    steps: [{ id: "R1", title: "One", goal: "", acceptance: [] }] });
  st.writeSession({ protocol: 1, id: "w", project: "p", role: "worker", runtime: "external", queue: "Q", cwd: root, launched_by: "external", created_at: now() });
  // Added before: an event that names a file in the working tree, as the CLI recorded it then.
  writeFileSync(join(root, "tmp", "review", "old.md"), "# Old material\n");
  st.appendEvent({ v: 1, id: newId(), at: now(), session: "w", type: "review.added", queue: "Q", step: "R1", items: [{ path: normPath(join(root, "tmp", "review", "old.md")), label: "old", kind: "doc" }] });
  // Added now: copied by the CLI.
  writeFileSync(join(outside, "new.md"), "# New material\n");
  execFileSync(process.execPath, [CLI, "review", "add", "R1", join(outside, "new.md")], { cwd: root, env: { ...process.env, NEXUS_SESSION: "w", NEXUS_DIR: st.dir }, stdio: "pipe" });
  const items = loadProjectState(st).queues[0]!.steps[0]!.review_items;
  assert.deepEqual(items.map((x) => x.path), [normPath(join(root, "tmp", "review", "old.md")), normPath(join(st.reviewDir("Q", "R1"), "new.md"))]);

  writeRegistry({ protocol: 1, projects: [{ id: "p", root }] });
  const port = await freePort();
  const child = spawnServer({ NEXUS_PORT: String(port), NEXUS_LOG: "" });
  const url = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; i < 100; i++) { try { if ((await fetch(url + "/api/projects")).ok) break; } catch { /* not up yet */ } await new Promise((r) => setTimeout(r, 100)); }
    const file = (path: string) => fetch(`${url}/api/projects/p/file?path=${encodeURIComponent(path)}`);
    for (const [path, text] of [[items[0]!.path!, "# Old material\n"], [items[1]!.path!, "# New material\n"]] as const) {
      const res = await file(path);
      assert.equal(res.status, 200, path);
      assert.equal(await res.text(), text);
    }
  } finally { child.kill(); }
});
