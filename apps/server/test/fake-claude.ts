// A stand-in for `claude -p --input-format stream-json --output-format stream-json`, for testing the engine without
// a model. It reads user messages from stdin and answers with the stream messages the engine reads. What it does in a
// step turn is written in the step's goal as "FAKE: <behaviour>":
//   done   report the step done              ask     ask a blocking question, then end the turn
//   noop   end the turn without an outcome   stop    report a stop condition
//   fail   report the step failed            slow    work for FAKE_SLOW_MS (default 1500), then done
// An answer ("[Nexus] Answer …") makes it report the current step done.
// As an orchestrator (any other message): "FAKE-DRAFT:" followed by YAML drafts that queue; "FAKE-NEXUS: [args]"
// runs `nexus` with those arguments; a "[Nexus] A worker asked … (qid X; …" notice is answered with "fake answer". Every message it receives is appended to
// FAKE_LOG (one JSON line: text and priority), so tests can see what reached the agent and how.
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "../../../packages/cli/bin/nexus.js");
const log = process.env.FAKE_LOG;
const out = (m: unknown) => process.stdout.write(JSON.stringify(m) + "\n");
const nexus = (...args: string[]) => execFileSync(process.execPath, [CLI, ...args], { env: process.env, stdio: "ignore" });
const nexusOut = (args: string[], input?: string): string => {
  try { return execFileSync(process.execPath, [CLI, ...args], { env: process.env, input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim(); }
  catch (e) { return `nexus failed: ${String((e as { stderr?: string }).stderr ?? e).trim()}`; }
};

let step: string | undefined;
let busy = false;
const queue: { text: string; priority?: string }[] = [];

function turnEnd(text: string): void {
  out({ type: "assistant", message: { content: [{ type: "text", text }], usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 90 } }, parent_tool_use_id: null });
  out({ type: "result", subtype: "success", is_error: false, result: text, num_turns: 1, total_cost_usd: 0, modelUsage: { fake: { contextWindow: 1000 } } });
}

async function turn(text: string): Promise<void> {
  out({ type: "system", subtype: "init", model: "fake-model", session_id: "fake" });
  const m = /step (\S+) \(\d+ of \d+\)/.exec(text);
  if (text.startsWith("[Nexus] Queue") && m) {
    step = m[1]!;
    const behaviour = /FAKE: (\w+)/.exec(text)?.[1] ?? "done";
    nexus("step", "start", step);
    out({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: `nexus step start ${step}` } }] }, parent_tool_use_id: null });
    if (behaviour === "slow") await new Promise((r) => setTimeout(r, Number(process.env.FAKE_SLOW_MS ?? 1500)));
    if (behaviour === "done" || behaviour === "slow") nexus("step", "done", step, "--summary", `fake finished ${step}`);
    if (behaviour === "fail") nexus("step", "failed", step, "--reason", "fake failure");
    if (behaviour === "stop") nexus("stop", step, "--condition", "fake condition", "--reason", "fake stop");
    if (behaviour === "ask") nexus("ask", "Which way?", "--step", step);
    return turnEnd(`step ${step}: ${behaviour}`);
  }
  if (text.startsWith("[Nexus] Answer") && step) {
    nexus("step", "done", step, "--summary", `fake finished ${step} after an answer`);
    return turnEnd("answered");
  }
  const draft = /FAKE-DRAFT:\s*\n([\s\S]*)$/.exec(text);
  if (draft) return turnEnd(nexusOut(["queue", "draft", "-"], draft[1]));
  const run = /FAKE-NEXUS: (\[.*\])/.exec(text);
  if (run) return turnEnd(nexusOut(JSON.parse(run[1]!) as string[]));
  const asked = /A worker asked[\s\S]*?\(qid (\S+);/.exec(text);
  if (asked) return turnEnd(nexusOut(["answer", asked[1]!, "fake answer", "--continue"]));
  turnEnd("ok"); // a nudge, a message sent while idle, anything else
}

async function pump(): Promise<void> {
  if (busy) return;
  busy = true;
  while (queue.length) await turn(queue.shift()!.text);
  busy = false;
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d: string) => {
  buffer += d;
  let i: number;
  while ((i = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line) as { message: { content: string }; priority?: string };
    if (log) appendFileSync(log, JSON.stringify({ text: msg.message.content, priority: msg.priority ?? null, busy }) + "\n");
    // A "next" message during a turn is read inside it (as Claude Code does); anything else is a turn of its own.
    if (msg.priority === "next" && busy) continue;
    queue.push({ text: msg.message.content, priority: msg.priority });
    void pump();
  }
});
process.stdin.on("end", () => { const wait = () => (busy ? setTimeout(wait, 50) : process.exit(0)); wait(); });
