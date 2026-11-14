// The queue report at the end of a run: the last-step prompt names a file in the project's folder for reports, in the
// system's temporary directory (outside the working tree and any repository), and a worker kept out of .nexus
// (protect_nexus, the default) still ends with the report in the queue's folder, through nexus report, which removes
// the source. A worktree queue then leaves a clean worktree, and its cleanup succeeds.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectStore, approveQueue, loadProjectState, normPath, reportFile, routeAnswers, type StepDef } from "@nexus/protocol";
import { Engine } from "../src/engine.ts";
import { cleanUp } from "../src/mergeback.ts";
import { acceptReviews } from "./fake-reviewer.ts";
import { WAIT_MS, POLL_MS, LONGER, sleep } from "./wait.ts";

const here = dirname(fileURLToPath(import.meta.url));
process.env.NEXUS_CLAUDE = join(here, "fake-claude.ts");
process.env.NEXUS_CODEX = join(here, "fake-codex.ts");

function setup(o: { git?: boolean } = {}) {
  const base = mkdtempSync(join(tmpdir(), "nexus-report-"));
  // A temporary directory of this test's own (the worker inherits it), so tests side by side share no report file.
  const temp = join(base, "temp");
  mkdirSync(temp);
  process.env.TEMP = temp; process.env.TMP = temp; process.env.TMPDIR = temp;
  const root = join(base, "project");
  mkdirSync(root);
  process.env.NEXUS_HOME = join(base, "home");
  process.env.FAKE_LOG = join(base, "fake.log");
  process.env.FAKE_ARGS = join(base, "args.log");
  if (o.git) {
    const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...a], { cwd: root, stdio: "ignore" });
    git("init", "-q", "-b", "main"); writeFileSync(join(root, ".gitignore"), ".nexus/\n"); writeFileSync(join(root, "a.txt"), "a\n");
    git("add", "-A"); git("commit", "-qm", "init");
  }
  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  const step = (id: string): StepDef => ({ id, title: `Step ${id}`, goal: "FAKE: done", acceptance: [] });
  store.writeQueue({ protocol: 1, id: "Q", title: "Queue", revision: 1, status: "proposed", stop_conditions: [], checks: [], steps: [step("Q1"), step("Q2")], ...(o.git ? { worktree: "auto" } : {}) });
  approveQueue(store, "Q");
  const engine: Engine = new Engine(store, () => { routeAnswers(store); acceptReviews(store); engine.onChange(loadProjectState(store)); });
  const queue = () => loadProjectState(store).queues.find((q) => q.id === "Q")!;
  // The run takes two steps and a report: about eight node processes (the fake worker, each nexus call), each started
  // in a second here but in two to four under load, where a step took 14 s (scripts/load-tests.mjs, 12 busy cores
  // and 6 copies, queue FU4). The wait is for that work, not for a hang: a named longer wait (wait.ts).
  const finished = async () => {
    for (const t = Date.now(); queue().run?.state !== "finished";) {
      if (Date.now() - t > LONGER.processes) assert.fail(`timed out; run ${JSON.stringify(queue().run)}`);
      await sleep(POLL_MS);
    }
  };
  const prompts = () => readFileSync(process.env.FAKE_LOG!, "utf8").trim().split("\n").map((l) => (JSON.parse(l) as { text: string }).text);
  return { base, temp, root, store, engine, queue, finished, prompts };
}

test("the report is written outside the working tree, copied into the queue's folder, and its source removed", async () => {
  const x = setup();
  assert.equal(x.store.readProject().defaults.protect_nexus, true);
  try {
    x.engine.start("Q", { runtime: "claude" });
    await x.finished();
    const argv = readFileSync(process.env.FAKE_ARGS!, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { argv?: string[] })[0]!.argv!;
    assert.ok(argv.some((a) => a.includes("Write(//") && a.includes(".nexus/**")), "the worker may not write under .nexus");

    const file = reportFile("p", "Q");
    assert.equal(file, join(x.temp, "nexus-reports", "p", "Q.md").replaceAll("\\", "/"), "<temp>/nexus-reports/<project>/<queue>.md");
    assert.ok(!normPath(file).toLowerCase().startsWith(normPath(x.root).toLowerCase() + "/"), "outside the working tree");
    const line = x.prompts().find((t) => /step Q2 \(2 of 2\)/.test(t))!.split("\n").find((l) => l.startsWith("This is the queue's last step"))!;
    assert.ok(line.includes(`to ${file} (a folder for reports outside the working tree and any repository: never write it into the working tree, it would block the cleanup of a worktree) and register it with \`nexus report Q --file ${file} --summary "…"\`, which copies it into the queue's folder and removes it from there.`), line);
    assert.ok(!x.prompts().find((t) => /step Q1 \(1 of 2\)/.test(t))!.includes("last step"), "only the last step asks for the report");

    const target = join(x.store.queueDir("Q"), "report.md");
    assert.match(readFileSync(target, "utf8"), /fake report of the whole queue/);
    assert.equal(x.queue().report?.path, normPath(target));
    assert.ok(!existsSync(file), "the source in the folder for reports is removed");
    assert.ok(!existsSync(join(x.root, "tmp")), "nothing written into the working tree");
  } finally { x.engine.shutdown(); }
});

test("a worktree queue ends with a clean worktree, and its cleanup succeeds", async () => {
  const x = setup({ git: true });
  try {
    x.engine.start("Q", { runtime: "claude" });
    await x.finished();
    // The run is finished when its last step is; its process then ends. Windows does not remove a folder a process
    // still runs in ("Permission denied"), so the cleanup, as the user's would, comes after the exit (queue FU4).
    const session = x.queue().run!.session;
    for (const t = Date.now(); x.store.readRuntime(session)?.state !== "exited";) {
      if (Date.now() - t > WAIT_MS) assert.fail("the worker's process did not exit");
      await sleep(POLL_MS);
    }
    const wt = x.store.readQueue("Q").worktree!;
    assert.ok(existsSync(wt));
    assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: wt, encoding: "utf8" }).trim(), "", "a clean worktree");
    assert.ok(existsSync(join(x.store.queueDir("Q"), "report.md")));
    assert.equal(x.queue().status, "done");
    assert.match(cleanUp(x.store, "Q"), /is removed and branch nexus\/Q deleted/);
    assert.ok(!existsSync(wt));
  } finally { x.engine.shutdown(); }
});
