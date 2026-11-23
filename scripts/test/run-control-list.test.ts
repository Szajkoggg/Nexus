// AGENTS.md's run-control list and the nexus-lifecycle template's lifecycle_code default name the same files, and
// each exists (scripts/run-control-list.ts). The check runs on a faulty example first, then on the real files.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { agentsRunControl, runControlDifferences, templateRunControl } from "../run-control-list.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (path: string): string => readFileSync(join(ROOT, path), "utf8");

const agents = (files: string) => `# Rules\n\n- **Tests**: \`other.ts\`.\n- **Run control and lifecycle code** (x):\n  in \`apps/server/src\`: ${files}.\n- **Load tool**: \`load.ts\`.\n`;
const template = (files: string) => `params:\n  - name: change\n    default: "x.ts"\n  - name: lifecycle_code\n    default: "the engine in apps/server/src: ${files}"\n`;

test("the lists are read from the item and the parameter only", () => {
  assert.deepEqual(agentsRunControl(agents("`engine.ts`, `worker-process.ts`")), ["engine.ts", "worker-process.ts"]);
  assert.deepEqual(templateRunControl(template("engine.ts, worker-process.ts")), ["engine.ts", "worker-process.ts"]);
});

test("a file only one list names is a difference", () => {
  const a = agentsRunControl(agents("`engine.ts`, `stopwork.ts`"));
  const t = templateRunControl(template("engine.ts, watchers.ts"));
  assert.deepEqual(runControlDifferences(a, t), [
    "stopwork.ts: in AGENTS.md, not in the nexus-lifecycle default",
    "watchers.ts: in the nexus-lifecycle default, not in AGENTS.md",
  ]);
  assert.deepEqual(runControlDifferences(a, [...a].reverse()), []);
});

test("AGENTS.md and the nexus-lifecycle default name the same run-control files, and each exists", () => {
  const a = agentsRunControl(read("AGENTS.md"));
  const t = templateRunControl(read("nexus-templates/nexus-lifecycle.yaml"));
  assert.deepEqual(runControlDifferences(a, t), []);
  assert.ok(a.length > 0);
  assert.deepEqual(a.filter((f) => !existsSync(join(ROOT, "apps/server/src", f))), []);
});
