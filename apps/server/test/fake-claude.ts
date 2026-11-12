// A stand-in for `claude -p --input-format stream-json --output-format stream-json`, for testing without a model.
// What it does is in fake-behaviour.ts.
import { record, recordArgs, respond, type Fake, type FakeFailure } from "./fake-behaviour.ts";

recordArgs({ argv: process.argv.slice(2) });

const out = (m: unknown) => process.stdout.write(JSON.stringify(m) + "\n");
const fake: Fake = {};
let busy = false;
const queue: string[] = [];

async function turn(text: string): Promise<void> {
  out({ type: "system", subtype: "init", model: "fake-model", session_id: "fake" });
  const reply = await respond(fake, text, (command) =>
    out({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command } }] }, parent_tool_use_id: null }));
  if (typeof reply !== "string") return "exit" in reply ? exitOnSignal() : fail(reply.fail);
  out({ type: "assistant", message: { content: [{ type: "text", text: reply }], usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 90 } }, parent_tool_use_id: null });
  out({ type: "result", subtype: "success", is_error: false, result: reply, num_turns: 1, total_cost_usd: 0, modelUsage: { fake: { contextWindow: 1000 } } });
}

/**
 * A failed turn as Claude Code writes it (Agent SDK sdk.d.ts: SDKAPIRetryMessage, SDKAssistantMessage.error,
 * SDKRateLimitEvent, SDKResultSuccess with is_error and api_error_status): the CLI's own retries, a synthetic
 * assistant message naming the error, and a result marked as an error.
 */
/** Ends the process as a signal would, before the turn's result: the CLI killed, or closing by itself. */
function exitOnSignal(): void { process.kill(process.pid, "SIGTERM"); }

function fail(kind: FakeFailure): void {
  if (kind === "crash") process.exit(3);
  const error = { overloaded: "overloaded", network: "unknown", auth: "authentication_failed", limit: "rate_limit" }[kind];
  const status = { overloaded: 529, network: null, auth: 401, limit: 429 }[kind];
  const text = { overloaded: "API Error: Repeated 529 Overloaded errors", network: "API Error: Connection error.", auth: "Invalid API key - Please run /login", limit: "Claude AI usage limit reached" }[kind];
  if (kind === "overloaded" || kind === "network") out({ type: "system", subtype: "api_retry", attempt: 1, max_retries: 10, retry_delay_ms: 500, error_status: status, error, uuid: "u", session_id: "fake" });
  if (kind === "limit") out({ type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "five_hour", resetsAt: Math.ceil((Date.now() + Number(process.env.FAKE_RESET_MS ?? 1500)) / 1000) }, uuid: "u", session_id: "fake" });
  out({ type: "assistant", message: { content: [{ type: "text", text }] }, error, parent_tool_use_id: null });
  out({ type: "result", subtype: "success", is_error: true, api_error_status: status, result: text, num_turns: 1, total_cost_usd: 0, modelUsage: {}, terminal_reason: "api_error" });
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
