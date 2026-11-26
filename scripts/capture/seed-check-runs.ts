// A seed for the capture tool: the checks Nexus runs after a step's done (queue EC4), on real runs of the fake
// runtimes. Run by scripts/capture.ts as `node <this> <data dir>` with NEXUS_HOME set to the development
// instance's; it writes only there. Each project's queue starts by itself (a start due now) and its fake worker reports
// its first step done; the engine then runs the checks, which are npm scripts of the project's own package.json:
//   (default) "demo": its `npm test` runs for ten minutes, so the step reads "checks running"; "shop": its step ends a
//             moment later, and its checks wait for the machine behind demo's ("checks queued").
//   with FAKE_CHECK_FIX_MS set (600000: the fake worker's fix takes ten minutes, so the round stays at work): "demo"
//             alone, its `npm test` failing (two tests, in TAP), twice, so the worker gets check-fix round 1 of 3.
// Run the capture with NEXUS_TEST_LOCK naming a file of its own, so a full test run elsewhere on the machine does not
// hold the checks back (the coordinator waits for it).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ProjectStore, approveQueue, now, updateSettings, writeRegistry, type ProjectFile } from "@nexus/protocol";
import { requireTempHome } from "../temp-home.ts";

requireTempHome();

const dir = process.argv[2];
if (!dir) throw new Error("usage: node seed-check-runs.ts <data dir>");
const fix = !!process.env.FAKE_CHECK_FIX_MS;

const quick = "node -e \"setTimeout(() => {}, 300)\"";
const slow = "node -e \"setTimeout(() => {}, 600000)\"";
const failing = "node fail.js";
// Two failing tests in node:test's TAP form, as the engine reads their names.
const FAIL = `console.log("TAP version 13");
console.log("ok 1 - search > an empty search shows all steps");
console.log("not ok 2 - search > filters the steps by goal");
console.log("not ok 3 - keyboard > Escape clears the search");
console.log("# pass 1");
console.log("# fail 2");
process.exit(1);
`;

function project(id: string, name: string, queue: { id: string; title: string; steps: [string, string, string][] }, test: string): { id: string; root: string } {
  const root = join(dir!, id);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: id, private: true, scripts: { lint: quick, typecheck: quick, test } }, null, 2));
  writeFileSync(join(root, "fail.js"), FAIL);
  const st = ProjectStore.init(root, { id, name, root });
  updateSettings(st, { orchestrator: { notify: false } });
  st.updateProject((p) => ({ ...p, defaults: { ...p.defaults, checks: ["npm run lint"] } } as ProjectFile));
  st.writeQueue({
    protocol: 1, id: queue.id, title: queue.title, revision: 1, status: "proposed", stop_conditions: [], checks: ["npm run typecheck", "npm test"],
    steps: queue.steps.map(([sid, title, goal]) => ({ id: sid, title, goal, acceptance: [] })),
  });
  approveQueue(st, queue.id);
  st.writeStart(queue.id, { protocol: 1, at: now(), by: "user", revision: 1, created_at: now() });
  return { id, root };
}

const search = {
  id: "CK", title: "Search in the step list",
  steps: [
    ["CK1", "A search box over the steps", "FAKE: done"],
    ["CK2", "Keyboard", "FAKE: done"],
  ] as [string, string, string][],
};
const projects = [project("demo", "Demo app", search, fix ? failing : slow)];
if (!fix) {
  projects.push(project("shop", "Shop", {
    id: "PAY", title: "Card payments",
    steps: [["PAY1", "Pay by card at checkout", "FAKE: slow"], ["PAY2", "Refunds", "FAKE: done"]],
  }, quick));
}
writeRegistry({ protocol: 1, projects });
console.log(`seeded ${projects.map((p) => p.root).join(", ")}`);
