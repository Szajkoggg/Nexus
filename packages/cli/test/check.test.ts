// `nexus check ... --duration <seconds>` (queue TS): the time is recorded on the check's result and shows in
// `nexus status`; a duration that is no number of seconds is refused before anything is written.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectStore, loadProjectState, newId, type Event } from "@nexus/protocol";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "../bin/nexus.js");

function setup() {
  const root = mkdtempSync(join(tmpdir(), "nexus-cli-check-"));
  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  store.writeSession({ protocol: 1, id: "w", project: "p", role: "worker", runtime: "claude", cwd: root, launched_by: "nexus", created_at: new Date().toISOString(), queue: "Q" });
  store.writeQueue({ protocol: 1, id: "Q", title: "Queue", revision: 1, status: "approved", stop_conditions: [], checks: [], steps: [{ id: "Q1", title: "Step", goal: "", acceptance: [] }] });
  store.appendEvent({ v: 1, id: newId(), at: new Date().toISOString(), session: "w", type: "step.started", queue: "Q", step: "Q1" } as Event);
  const env: NodeJS.ProcessEnv = { ...process.env, NEXUS_DIR: store.dir, NEXUS_SESSION: "w" };
  const nexus = (...a: string[]) => execFileSync(process.execPath, [CLI, ...a], { cwd: root, env, encoding: "utf8", stdio: "pipe" });
  const checks = () => store.readEvents("w").entries.filter((e): e is Extract<Event, { type: "check.result" }> => e.type === "check.result");
  return { store, nexus, checks };
}

test("--duration is recorded in seconds on the check's result and on the step", () => {
  const x = setup();
  assert.match(x.nexus("check", "Q1", "typecheck", "--ok", "--duration", "12.5"), /^ok: check\.result Q\/Q1/);
  x.nexus("check", "Q1", "test", "--fail", "--summary", "3 failed", "--duration", "190");
  x.nexus("check", "Q1", "lint", "--ok");
  assert.deepEqual(x.checks().map((c) => [c.name, c.ok, c.duration]), [["typecheck", true, 12.5], ["test", false, 190], ["lint", true, undefined]]);
  const step = loadProjectState(x.store).queues[0]!.steps[0]!;
  assert.deepEqual(step.checks.map((c) => c.duration), [12.5, 190, undefined]);
});

test("nexus status shows each check's latest result with its time under the step", () => {
  const x = setup();
  x.nexus("check", "Q1", "test", "--fail", "--duration", "190");
  x.nexus("check", "Q1", "typecheck", "--ok", "--duration", "12");
  x.nexus("check", "Q1", "test", "--ok", "--duration", "185");
  const out = x.nexus("status");
  assert.match(out, /^ {2}Q1 {4}running {2}Step\n {8}checks: test ok \(3 min 5 s\), typecheck ok \(12 s\)$/m);
});

test("a duration that is no number of seconds is refused, and nothing is written", () => {
  const x = setup();
  for (const bad of ["12s", "-1", "", "abc", "Infinity"]) {
    assert.throws(() => x.nexus("check", "Q1", "test", "--ok", `--duration=${bad}`), (e: { stderr?: string }) => /--duration takes the check's time in seconds/.test(e.stderr ?? ""), bad);
  }
  assert.equal(x.checks().length, 0);
});
