// `nexus help <topic>` for the agent standards (queue AS): summaries, questions, refusals, commits. No session or
// project needed; nothing recorded.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliOut } from "./run-cli.ts";

const cwd = mkdtempSync(join(tmpdir(), "nexus-help-")); // no .nexus here
const env: NodeJS.ProcessEnv = { ...process.env };
delete env.NEXUS_SESSION; delete env.NEXUS_DIR;
const nexus = async (...args: string[]) => await cliOut([...args], { cwd, env });

test("nexus help only reads: it writes nothing, so a thinking partner may run it (a Codex one in its read-only sandbox)", async () => {
  const home = join(mkdtempSync(join(tmpdir(), "nexus-help-home-")), "home");
  const run = async (...args: string[]) => await cliOut([...args], { cwd, env: { ...env, NEXUS_HOME: home } });
  assert.match(await run("help"), /Topics \(nexus help <topic>\):/);
  await run("help", "review");
  assert.equal(existsSync(home), false, "nothing written to NEXUS_HOME");
  assert.deepEqual(readdirSync(cwd), [], "nothing written where it ran");
});

test("nexus help lists the standards' topics", async () => {
  const list = await nexus("help");
  for (const t of ["review", "summaries", "context", "questions", "refusals", "commits", "tests"]) assert.match(list, new RegExp(`^  ${t} +[a-z]`, "m"), t);
});

test("summaries: the four parts, in order, with an example", async () => {
  const t = await nexus("help", "summaries");
  const parts = ["1. What changed", "2. How it was verified", "3. What was left out or differs from the plan", "4. What comes next, if anything"];
  assert.deepEqual(parts.map((p) => t.indexOf(p)).every((i, k, a) => i >= 0 && (k === 0 || i > a[k - 1]!)), true, "all four, in order");
  assert.match(t, /--commit/);
  assert.match(t, /Example:\n {2}nexus step done/);
});

test("context: the six parts, in order, the length and an example", async () => {
  const t = await nexus("help", "context");
  const parts = ["1. Where the work stands", "2. The decisions and why", "3. The traps found", "4. The important files", "5. What comes next", "6. What the orchestrator or the user asked for or promised"];
  assert.deepEqual(parts.map((p) => t.indexOf(p)).every((i, k, a) => i >= 0 && (k === 0 || i > a[k - 1]!)), true, "all six, in order");
  assert.match(t, /1,000 to 2,000 words/);
  assert.match(t, /Example:\n {2}nexus context/);
});

test("questions: what it blocks, the options, the recommendation", async () => {
  const t = await nexus("help", "questions");
  for (const p of ["1. What it blocks", "2. The options", "3. Your recommendation", "--option", "--can-continue"]) assert.ok(t.includes(p), p);
  assert.match(t, /Example:\n {2}nexus ask/);
});

test("refusals: no workaround, one simpler retry, then report", async () => {
  const t = await nexus("help", "refusals");
  assert.match(t, /Do not work around it through another tool or a different command that reaches the same end/);
  assert.match(t, /PowerShell command after a Bash command was refused/);
  assert.match(t, /retry once in a simpler form/);
  assert.match(t, /Otherwise report what you needed and why/);
});

test("commits: a clean tree at every step's end, the commit named, only the step's own files", async () => {
  const t = await nexus("help", "commits");
  assert.match(t, /Every commit belongs to exactly one step/);
  assert.match(t, /nexus step done <step> --summary "\.\.\." --commit <sha>/);
  assert.match(t, /Leave the working tree clean at the step's end/);
  assert.match(t, /never commit changes you did not make/);
});

test("tests: only the affected files while working, stopping at the first failure; the whole suite at the end", async () => {
  const t = await nexus("help", "tests");
  assert.match(t, /run only the tests that cover what you changed, and stop at the first failure/);
  assert.match(t, /The whole suite runs once, at the step's end, as the queue's\s+checks, and who runs them depends/);
  assert.match(t, /Where it says Nexus runs the checks: do not run the whole suite and do not report it/);
  assert.match(t, /Where it does not .*: you run the checks at the step's end and report\s+each with nexus check/);
  assert.match(t, /npm run test:files -- <test file>\.\.\./);
  assert.match(t, /A test that fails only now and then is not run again until it passes/);
});
