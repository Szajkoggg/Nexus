// Each turn's tokens and cost, as the adapters report them on turnEnd: per turn, never the runtime's running totals.
// Claude Code: result.usage is the turn's, total_cost_usd runs on. Codex: tokenUsage.total runs on, `last` is one
// model request's. Against the fakes, which report them as the real runtimes do (checked live; see DESIGN.md).
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentEvents, AgentProcess, TurnTokens } from "../src/agent.ts";
import { ClaudeSession } from "../src/claude.ts";
import { CodexSession } from "../src/codex.ts";

const here = dirname(fileURLToPath(import.meta.url));
process.env.NEXUS_CLAUDE = join(here, "fake-claude.ts");
process.env.NEXUS_CODEX = join(here, "fake-codex.ts");
const cwd = mkdtempSync(join(tmpdir(), "nexus-turn-usage-"));
process.env.NEXUS_HOME = join(cwd, "home");
delete process.env.FAKE_LOG;
process.env.FAKE_COST = "1";

type End = AgentEvents["turnEnd"][0];
/** Sends the messages one turn after another and returns each turn's end. */
async function turns(proc: AgentProcess, messages: string[]): Promise<End[]> {
  const ends: End[] = [];
  for (const m of messages) {
    const ended = new Promise<End>((r) => proc.once("turnEnd", r));
    proc.send(m);
    ends.push(await ended);
  }
  proc.kill();
  return ends;
}
const t = (input: number, output: number, cacheRead: number, cacheCreation: number): TurnTokens => ({ input, output, cacheRead, cacheCreation });

test("Claude Code: two turns in one session report each turn's tokens and cost, not the running totals", async () => {
  const claude = (resume: boolean) => new ClaudeSession({ cwd, uuid: randomUUID(), resume, permissionMode: "dontAsk", allowedTools: [], env: {} });
  const ends = await turns(claude(false), ["hello", "again"]);
  assert.deepEqual(ends.map((e) => e.tokens), [t(10, 5, 100, 1), t(20, 10, 200, 2)], "the second turn's own, not 30/15/300/3");
  assert.deepEqual(ends.map((e) => e.costUsd), [0.01, 0.02], "the difference of the running total_cost_usd (0.01, 0.03)");

  // A resumed process: its running total starts with turns it never saw, so its first turn's cost is unknown; the
  // tokens are still the turn's.
  const resumed = await turns(claude(true), ["hello", "again"]);
  assert.deepEqual(resumed.map((e) => e.tokens), [t(10, 5, 100, 1), t(20, 10, 200, 2)]);
  assert.deepEqual(resumed.map((e) => e.costUsd), [undefined, 0.02]);
});

test("Codex: two turns in one thread report each turn's tokens (the running total's difference), and no cost", async () => {
  const codex = (threadId?: string) => new CodexSession({ cwd, env: {}, threadId, sandbox: "read-only", approvalPolicy: "never", writableRoots: [] });
  // Turn n: 100n input (60n cached) and 3n output, then 120 input (50 cached) and 2n output (fake-codex.ts).
  const ends = await turns(codex(), ["hello", "again"]);
  assert.deepEqual(ends.map((e) => e.tokens), [t(40 + 70, 5, 60 + 50, 0), t(80 + 70, 10, 120 + 50, 0)], "the second turn's own, not the thread's total");
  assert.deepEqual(ends.map((e) => e.costUsd), [undefined, undefined], "Codex reports no cost");

  // A resumed thread: the running total starts with turns this process never saw, so the turn's `last` figures are
  // summed instead (both requests of the turn, not only the last one).
  const resumed = await turns(codex("thread-resumed"), ["hello", "again"]);
  assert.deepEqual(resumed.map((e) => e.tokens), [t(110, 5, 110, 0), t(150, 10, 170, 0)]);
});
