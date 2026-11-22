// A clock step between the server and its agents (docs/design/state.md, "Clock steps"; queue FL): the stop-at-once and the
// stopped-work tests run again with the test process's clock (the engine's) 5 s and 240 s behind the system clock, as
// after a forward NTP step that V8 sees up to a minute late, and 60 s ahead, as after a backward step. Their children
// (the CLI, the fake runtimes, git) keep the system clock. Each must pass as it does without a step: the interrupted
// stretch ends, the stopped step's commits are its own, Keep/Discard is asked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const FILES = ["stop-at-once.test.ts", "stopwork.test.ts"].map((f) => join(here, f));

function run(lag: number): Promise<{ code: number | null; out: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env, CLOCK_LAG_MS: String(lag) };
  delete env.NEXUS_HANDOVER; delete env.NEXUS_DIR; delete env.NEXUS_SESSION;
  // One process for the test files (no isolation), so the lag is the engine's and not its children's.
  const p = spawn(process.execPath, ["--import", pathToFileURL(join(here, "clock-lag.mjs")).href, "--test", "--test-isolation=none", ...FILES], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let out = "";
  p.stdout.on("data", (d: Buffer) => { out += d.toString(); });
  p.stderr.on("data", (d: Buffer) => { out += d.toString(); });
  return new Promise((resolve) => p.on("close", (code) => resolve({ code, out })));
}

test("stop at once and a stopped step's work hold with the engine's clock 5 s and 240 s behind, and 60 s ahead", async () => {
  const lags = [5_000, 240_000, -60_000];
  const results = await Promise.all(lags.map(run));
  results.forEach((r, i) => {
    const failed = r.out.split("\n").filter((l) => /^\s*(not ok|✖)/.test(l)).slice(0, 10).join("\n");
    assert.equal(r.code, 0, `clock ${lags[i]! > 0 ? `${lags[i]} ms behind` : `${-lags[i]!} ms ahead`}:\n${failed}\n${r.out.slice(-3000)}`);
  });
});
