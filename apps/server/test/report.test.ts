// The queue report at the end of a run: the last-step prompt names a path outside .nexus, and a worker kept out of
// .nexus (protect_nexus, the default) still ends with the report in the queue's folder, through nexus report.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectStore, approveQueue, loadProjectState, normPath, routeAnswers, type StepDef } from "@nexus/protocol";
import { Engine } from "../src/engine.ts";

const here = dirname(fileURLToPath(import.meta.url));
process.env.NEXUS_CLAUDE = join(here, "fake-claude.ts");
process.env.NEXUS_CODEX = join(here, "fake-codex.ts");

test("a worker kept out of .nexus writes the report elsewhere; nexus report puts it in the queue's folder", async () => {
  const root = mkdtempSync(join(tmpdir(), "nexus-report-"));
  process.env.NEXUS_HOME = join(root, "home");
  process.env.FAKE_LOG = join(root, "fake.log");
  process.env.FAKE_ARGS = join(root, "args.log");
  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  assert.equal(store.readProject().defaults.protect_nexus, true);
  const step = (id: string): StepDef => ({ id, title: `Step ${id}`, goal: "FAKE: done", acceptance: [] });
  store.writeQueue({ protocol: 1, id: "Q", title: "Queue", revision: 1, status: "proposed", stop_conditions: [], checks: [], steps: [step("Q1"), step("Q2")] });
  approveQueue(store, "Q");
  const engine: Engine = new Engine(store, () => { routeAnswers(store); engine.onChange(loadProjectState(store)); });
  const queue = () => loadProjectState(store).queues.find((q) => q.id === "Q")!;
  try {
    engine.start("Q", { runtime: "claude" });
    for (const t = Date.now(); queue().run?.state !== "finished";) {
      if (Date.now() - t > 20_000) assert.fail(`timed out; run ${JSON.stringify(queue().run)}`);
      await new Promise((r) => setTimeout(r, 100));
    }
    const argv = readFileSync(process.env.FAKE_ARGS!, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { argv?: string[] })[0]!.argv!;
    assert.ok(argv.some((a) => a.includes("Write(//") && a.includes(".nexus/**")), "the worker may not write under .nexus");

    const prompts = readFileSync(process.env.FAKE_LOG!, "utf8").trim().split("\n").map((l) => (JSON.parse(l) as { text: string }).text);
    const last = prompts.find((t) => /step Q2 \(2 of 2\)/.test(t))!;
    const line = last.split("\n").find((l) => l.startsWith("This is the queue's last step"))!;
    assert.match(line, /to tmp\/reports\/Q\.md in your working directory \(or any path outside \.nexus\) and register it with `nexus report Q --file tmp\/reports\/Q\.md --summary "…"`, which copies it into the queue's folder\./);
    assert.ok(!prompts.find((t) => /step Q1 \(1 of 2\)/.test(t))!.includes("last step"), "only the last step asks for the report");

    const target = join(store.queueDir("Q"), "report.md");
    assert.ok(existsSync(target), "the report is in the queue's folder");
    assert.match(readFileSync(target, "utf8"), /fake report of the whole queue/);
    assert.ok(existsSync(join(root, "tmp/reports/Q.md")), "written where the prompt said");
    assert.equal(queue().report?.path, normPath(target));
    assert.equal(queue().report?.summary, "fake report of Q");
  } finally { engine.shutdown(); }
});
