// `nexus review add <step> <after> --before <path>`: the picture names the "before" it is compared with.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectStore, loadProjectState, normPath, now } from "@nexus/protocol";
import { cliOut } from "./run-cli.ts";


test("--before records the before of one picture; it needs exactly one existing file", async () => {
  const root = mkdtempSync(join(tmpdir(), "nexus-before-"));
  const st = ProjectStore.init(root, { id: "p", name: "P", root });
  st.writeQueue({ protocol: 1, id: "Q", title: "Queue", revision: 1, status: "approved", stop_conditions: [], checks: [], approvals: [], history: [],
    steps: [{ id: "Q1", title: "One", goal: "", acceptance: [] }] });
  st.writeSession({ protocol: 1, id: "w", project: "p", role: "worker", runtime: "external", queue: "Q", cwd: root, launched_by: "external", created_at: now() });
  const after = join(root, "after.png"); const before = join(root, "before.png");
  writeFileSync(after, "a"); writeFileSync(before, "b");
  const nexus = async (...args: string[]) => await cliOut([...args], { cwd: root, env: { ...process.env, NEXUS_SESSION: "w", NEXUS_DIR: st.dir } });

  assert.match(await nexus("review", "add", "Q1", "after.png", "--before", "before.png", "--label", "Cliff"), /1 review item/);
  const item = loadProjectState(st).queues[0]!.steps[0]!.review_items[0]!;
  // Both are copied into the step's review folder (see review-copy.test.ts), and the item names the copies.
  const dir = st.reviewDir("Q", "Q1");
  assert.deepEqual([item.path, item.before, item.label], [normPath(join(dir, "after.png")), normPath(join(dir, "before.png")), "Cliff"]);

  await assert.rejects(async () => await nexus("review", "add", "Q1", "after.png", "before.png", "--before", "before.png"), /--before goes with exactly one picture/);
  await assert.rejects(async () => await nexus("review", "add", "Q1", "after.png", "--before", "missing.png"), /no such file/);
  assert.equal(loadProjectState(st).queues[0]!.steps[0]!.review_items.length, 1, "nothing added when refused");
});
