// `nexus report`: the report is copied into the queue's folder (report.md, written only by this command) and the
// event names that copy, wherever the worker wrote it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectStore, loadProjectState, normPath } from "@nexus/protocol";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "../bin/nexus.js");

function setup() {
  const root = mkdtempSync(join(tmpdir(), "nexus-cli-report-"));
  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  store.writeSession({ protocol: 1, id: "w", project: "p", role: "worker", runtime: "claude", cwd: root, launched_by: "nexus", created_at: new Date().toISOString(), queue: "Q" });
  store.writeQueue({ protocol: 1, id: "Q", title: "Queue", revision: 1, status: "approved", stop_conditions: [], checks: [], steps: [{ id: "Q1", title: "Step", goal: "", acceptance: [] }] });
  const report = (...args: string[]) => {
    const env: NodeJS.ProcessEnv = { ...process.env, NEXUS_DIR: store.dir, NEXUS_SESSION: "w" };
    return execFileSync(process.execPath, [CLI, "report", ...args], { env, encoding: "utf8", cwd: root, stdio: "pipe" });
  };
  return { root, store, report, target: join(store.queueDir("Q"), "report.md") };
}

test("a report written outside .nexus is copied into the queue's folder, and the event names the copy", () => {
  const { root, store, report, target } = setup();
  mkdirSync(join(root, "tmp/reports"), { recursive: true });
  writeFileSync(join(root, "tmp/reports/Q.md"), "# Queue Q report\n\nAll done.\n");
  assert.match(report("Q", "--file", "tmp/reports/Q.md", "--summary", "all done"), /ok: report for queue Q in .*report\.md \(copied from .*tmp\/reports\/Q\.md\)/);
  assert.equal(readFileSync(target, "utf8"), "# Queue Q report\n\nAll done.\n");
  const q = loadProjectState(store).queues.find((x) => x.id === "Q")!;
  assert.equal(q.report?.path, normPath(target));
  assert.equal(q.report?.summary, "all done");

  // A later report replaces it.
  writeFileSync(join(root, "tmp/reports/Q.md"), "second\n");
  report("Q", "--file", "tmp/reports/Q.md", "--summary", "again");
  assert.equal(readFileSync(target, "utf8"), "second\n");
});

test("a report already in the queue's folder still works; an unknown queue or a missing file is refused", () => {
  const { root, store, report, target } = setup();
  writeFileSync(target, "written in place\n");
  assert.doesNotMatch(report("Q", "--file", target, "--summary", "in place"), /copied/);
  assert.equal(readFileSync(target, "utf8"), "written in place\n");
  assert.equal(loadProjectState(store).queues[0]!.report?.path, normPath(target));

  writeFileSync(join(root, "r.md"), "x\n");
  assert.throws(() => report("X", "--file", "r.md", "--summary", "s"), /unknown queue X/);
  assert.throws(() => report("Q", "--file", "missing.md", "--summary", "s"), /no such file/);
  assert.ok(!existsSync(join(store.dir, "queues", "X")));
});
