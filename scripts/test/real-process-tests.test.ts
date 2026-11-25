// Every test file that starts the fake runtimes, a server, the CLI or test files as processes is on the list of real
// process tests with why, or runs the fake runtimes in its own process (scripts/real-process-tests.ts, queue IPR). The
// check runs on a faulty example first, then on the repository's test files.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { listFindings, processStarts, usesInProcessRuntime } from "../real-process-tests.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const TEST_DIRS = ["apps", "packages", "scripts"];

/** The repository's test files (`*.test.ts`), with paths relative to the root and forward slashes. */
function testFiles(): { path: string; text: string }[] {
  const files: { path: string; text: string }[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === "dist" || e.name.startsWith(".")) continue;
      const path = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(path);
      else if (e.name.endsWith(".test.ts")) files.push({ path, text: readFileSync(join(ROOT, path), "utf8") });
    }
  };
  for (const d of TEST_DIRS) walk(d);
  return files;
}

test("what a test file's code names tells how it starts processes; comments and imports do not count", () => {
  assert.deepEqual(processStarts(`process.env.NEXUS_CLAUDE = join(here, "fake-claude.ts");`), ["a fake runtime as a process"]);
  assert.deepEqual(processStarts(`const child = spawnServer({ NEXUS_PORT: "1" });`), ["a server"]);
  assert.deepEqual(processStarts(`execFileSync(process.execPath, [join(ROOT, "packages/cli/bin/nexus.js"), "status"]);`), ["the CLI as a process"]);
  assert.deepEqual(processStarts(`spawn(process.execPath, ["--test", file]);`), ["test files in a Node process of their own"]);
  assert.deepEqual(processStarts(`const r = await runSetup(command, cwd, { limitMs: 10 });`), ["a command's process tree (on Windows in a job host)"]);
  assert.deepEqual(processStarts(`// the fake (fake-claude.ts) answers\n/* spawnServer("x") */\nimport { PARTIAL } from "./fake-claude.ts";\nconst m = await import("./fake-codex.ts");`), []);
  assert.ok(usesInProcessRuntime(`new Engine(store, tick, { spawn: inProcessRuntime() });`));
  assert.ok(usesInProcessRuntime(`new CodexSession({ cwd, env: {}, spawnChild: inProcessCodex });`));
  assert.ok(!usesInProcessRuntime(`// inProcessRuntime() is not used here`));
});

test("a process-starting file must be listed or run the fakes in its own process; a listed file must start one", () => {
  const files = [
    { path: "t/a.test.ts", text: `process.env.NEXUS_CLAUDE = join(here, "fake-claude.ts");` },
    { path: "t/b.test.ts", text: `process.env.NEXUS_CLAUDE = join(here, "fake-claude.ts");\nnew Engine(store, tick, { spawn: inProcessRuntime() });` },
    { path: "t/c.test.ts", text: `const child = spawnServer();` },
    { path: "t/d.test.ts", text: `new Engine(store, tick, FAST);` },
  ];
  assert.deepEqual(listFindings(files, { "t/c.test.ts": "starts a server", "t/d.test.ts": "was real once", "t/gone.test.ts": "removed" }), [
    "t/a.test.ts: starts a fake runtime as a process; list it in scripts/real-process-tests.ts with why, or use inProcessRuntime()",
    "t/d.test.ts: listed, but starts no process: take it off the list",
    "t/gone.test.ts: listed, but no such test file",
  ]);
});

test("the repository's process-starting test files are on the list or run the fakes in their own process", () => {
  const files = testFiles();
  assert.ok(files.length > 100, `test files found: ${files.length}`);
  assert.deepEqual(listFindings(files), []);
});
