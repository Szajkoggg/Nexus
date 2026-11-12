// A stand-in for `claude -p --input-format stream-json --output-format stream-json`, for testing without a model.
// What it does is in fake-behaviour.ts.
import { record, respond, type Fake } from "./fake-behaviour.ts";

const out = (m: unknown) => process.stdout.write(JSON.stringify(m) + "\n");
const fake: Fake = {};
let busy = false;
const queue: string[] = [];

async function turn(text: string): Promise<void> {
  out({ type: "system", subtype: "init", model: "fake-model", session_id: "fake" });
  const reply = await respond(fake, text, (command) =>
    out({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command } }] }, parent_tool_use_id: null }));
  out({ type: "assistant", message: { content: [{ type: "text", text: reply }], usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 90 } }, parent_tool_use_id: null });
  out({ type: "result", subtype: "success", is_error: false, result: reply, num_turns: 1, total_cost_usd: 0, modelUsage: { fake: { contextWindow: 1000 } } });
}

async function pump(): Promise<void> {
  if (busy) return;
  busy = true;
  while (queue.length) await turn(queue.shift()!);
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
    record(msg.message.content, msg.priority ?? null, busy);
    // A "next" message during a turn is read inside it (as Claude Code does); anything else is a turn of its own.
    if (msg.priority === "next" && busy) continue;
    queue.push(msg.message.content);
    void pump();
  }
});
process.stdin.on("end", () => { const wait = () => (busy ? setTimeout(wait, 50) : process.exit(0)); wait(); });
