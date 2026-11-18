// The model list (src/models.ts; queue CR): a runtime that exits after its first message must neither end the server
// nor hold the list for the 20 s a silent runtime is given: the fixed list stands in at once. The list is asked in a
// process of its own, as the server asks it, so an unhandled error event shows as that process's crash. The fake
// runtimes are small scripts in a temporary folder, no model.
//
// The live crash (2026-11-18): Codex answered `initialize` and exited; the server, busy, read the answer only after
// the process was gone but before it had seen the exit, and the `initialized` and `model/list` the answer prompts
// failed with EPIPE, an error event of the process's input that nobody listened to. The asking process repeats that
// order on purpose: it stays busy until the fake has exited, so the answer is read after the exit every time.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const MODELS = pathToFileURL(join(import.meta.dirname, "../src/models.ts")).href;
const dir = mkdtempSync(join(tmpdir(), "nexus-models-"));

// Reads the first message, does `answer` with it, writes the file FAKE_EXITED names and exits.
const exitAfterFirst = (answer: string) => `
import { writeFileSync, writeSync } from "node:fs";
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  buffer += d;
  const i = buffer.indexOf("\\n");
  if (i < 0) return;
  const m = JSON.parse(buffer.slice(0, i));
  ${answer}
  writeFileSync(process.env.FAKE_EXITED, "");
  process.exit(0);
});
`;
// Codex answers `initialize`; Claude Code exits without an answer.
const fakeCodex = join(dir, "codex-exits.mjs");
writeFileSync(fakeCodex, exitAfterFirst(`writeSync(1, JSON.stringify({ id: m.id, result: { userAgent: "dying" } }) + "\\n");`));
const fakeClaude = join(dir, "claude-exits.mjs");
writeFileSync(fakeClaude, exitAfterFirst(""));

/** Asks both runtimes' lists `times` times in a process of its own; its exit code, output and how long it took. */
function askInProcess(times: number): Promise<{ code: number | null; out: string; err: string; ms: number }> {
  const script = `
import { existsSync } from "node:fs";
import { join } from "node:path";
const { listModels } = await import(${JSON.stringify(MODELS)});
/** Asks the list, busy (its event loop held) until the fake has exited and a moment after. */
async function busyAsk(runtime, n) {
  process.env.FAKE_EXITED = join(${JSON.stringify(dir)}, runtime + "-exited-" + n);
  const asked = listModels(runtime);
  const until = Date.now() + 30000;
  while (!existsSync(process.env.FAKE_EXITED) && Date.now() < until) { /* busy */ }
  const after = Date.now() + 300;
  while (Date.now() < after) { /* the process ends meanwhile */ }
  return asked;
}
const lists = [];
for (let i = 0; i < ${times}; i++) lists.push({ codex: await busyAsk("codex", i), claude: await busyAsk("claude", i) });
// A late error event (a write failing after the answer) would come within a moment.
await new Promise((r) => setTimeout(r, 300));
console.log(JSON.stringify(lists));
`;
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, NEXUS_CODEX: fakeCodex, NEXUS_CLAUDE: fakeClaude }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    let out = "", err = "";
    child.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { err += d.toString(); });
    child.on("close", (code) => resolve({ code, out, err, ms: Date.now() - started }));
  });
}

test("a runtime that exits after its first message gives the fixed model list, at once, and the server lives on", async () => {
  const times = 2;
  const r = await askInProcess(times);
  assert.equal(r.code, 0, `the asking process ended with an error: ${r.err}`);
  assert.doesNotMatch(r.err, /EPIPE|uncaught/i);
  const lists = JSON.parse(r.out) as { codex: { value: string }[]; claude: { value: string }[] }[];
  assert.equal(lists.length, times);
  for (const l of lists) {
    assert.deepEqual(l.codex, [], "Codex's fixed list (none)");
    assert.deepEqual(l.claude.map((m) => m.value), ["opus", "sonnet", "haiku"], "Claude's fixed list");
  }
  // Each answer comes with the exit, not after the 20 s a silent runtime is given (four asks).
  assert.ok(r.ms < 30_000, `took ${r.ms} ms`);
});
