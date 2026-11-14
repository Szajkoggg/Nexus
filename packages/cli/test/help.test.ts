// `nexus help <topic>` for the agent standards (queue AS): summaries, questions, refusals, commits. No session or
// project needed; nothing recorded.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "../bin/nexus.js");
const cwd = mkdtempSync(join(tmpdir(), "nexus-help-")); // no .nexus here
const env: NodeJS.ProcessEnv = { ...process.env };
delete env.NEXUS_SESSION; delete env.NEXUS_DIR;
const nexus = (...args: string[]) => execFileSync(process.execPath, [CLI, ...args], { cwd, env, encoding: "utf8", stdio: "pipe" });

test("nexus help lists the standards' topics", () => {
  const list = nexus("help");
  for (const t of ["review", "summaries", "questions", "refusals", "commits", "tests"]) assert.match(list, new RegExp(`^  ${t} +[a-z]`, "m"), t);
});

test("summaries: the four parts, in order, with an example", () => {
  const t = nexus("help", "summaries");
  const parts = ["1. What changed", "2. How it was verified", "3. What was left out or differs from the plan", "4. What comes next, if anything"];
  assert.deepEqual(parts.map((p) => t.indexOf(p)).every((i, k, a) => i >= 0 && (k === 0 || i > a[k - 1]!)), true, "all four, in order");
  assert.match(t, /--commit/);
  assert.match(t, /Example:\n {2}nexus step done/);
});

test("questions: what it blocks, the options, the recommendation", () => {
  const t = nexus("help", "questions");
  for (const p of ["1. What it blocks", "2. The options", "3. Your recommendation", "--option", "--can-continue"]) assert.ok(t.includes(p), p);
  assert.match(t, /Example:\n {2}nexus ask/);
});

test("refusals: no workaround, one simpler retry, then report", () => {
  const t = nexus("help", "refusals");
  assert.match(t, /Do not work around it through another tool or a different command that reaches the same end/);
  assert.match(t, /PowerShell command after a Bash command was refused/);
  assert.match(t, /retry once in a simpler form/);
  assert.match(t, /Otherwise report what you needed and why/);
});

test("commits: a clean tree at every step's end, the commit named, only the step's own files", () => {
  const t = nexus("help", "commits");
  assert.match(t, /Every commit belongs to exactly one step/);
  assert.match(t, /nexus step done <step> --commit <sha>/);
  assert.match(t, /Leave the working tree clean at the step's end/);
  assert.match(t, /never commit changes you did not make/);
});

test("tests: only the affected files while working, stopping at the first failure; the whole suite at the end", () => {
  const t = nexus("help", "tests");
  assert.match(t, /run only the tests that cover what you changed, and stop at the first failure/);
  assert.match(t, /The whole suite runs once, at the step's end,\nas the queue's checks/);
  assert.match(t, /npm run test:files -- <test file>\.\.\./);
  assert.match(t, /A test that fails only now and then is not run again until it passes/);
});
