// A stand-in for `claude -p --input-format stream-json --output-format stream-json`, for testing without a model.
// What it does is in fake-behaviour.ts.
import { existsSync, readFileSync } from "node:fs";
import {
  BACKGROUND_NOTICE, PARTIAL, actOnRead, contextTokens, contextWindow, fakeSaved, interrupt, onBackgroundEnd, record, recordArgs, respond, saveFakeConversation, type Background, type Fake, type FakeFailure,
} from "./fake-behaviour.ts";

// The briefing as the CLI reads it at its start (--append-system-prompt-file): the file is rewritten at the next start.
const argv = process.argv.slice(2);
/** The value after a flag on the command line, if the flag is there. */
const flag = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const briefingFile = flag("--append-system-prompt-file");
recordArgs({ argv, briefing: briefingFile && existsSync(briefingFile) ? readFileSync(briefingFile, "utf8") : null });

const out = (m: unknown) => process.stdout.write(JSON.stringify(m) + "\n");

// The session's conversation, as Claude Code 2.1.323 keeps it (probed 2026-11-15): `--resume` of an id it never saved
// writes an error result and "No conversation found with session ID: <id>" and exits 1; `--session-id` of a saved one
// writes only "Error: Session ID <id> is already in use." and exits 1. A new session is saved when its first message
// is read (save, below).
const resumeId = flag("--resume");
const newId = flag("--session-id");
// FAKE_REFUSE: every start is refused so, whatever was saved (a test of a second refusal).
const always = !!process.env.FAKE_REFUSE;
const refusal = resumeId && (always || !fakeSaved(resumeId)) ? `No conversation found with session ID: ${resumeId}`
  : newId && (always || fakeSaved(newId)) ? `Error: Session ID ${newId} is already in use.` : undefined;
if (refusal) {
  if (resumeId) out({ type: "result", subtype: "error_during_execution", is_error: true, num_turns: 0, total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, modelUsage: {}, permission_denials: [] });
  process.stderr.write(`${refusal}\n`, () => process.exit(1));
}
let saved = !newId;
const save = () => { if (!saved) { saved = true; saveFakeConversation(newId!); } };
const fake: Fake = { history: [] };
let busy = false;
/** `next` messages sent during the running turn, not read yet: read at its end, or run as a turn after an interrupt. */
let unread: string[] = [];
/** Turns so far, and the running total_cost_usd the CLI reports (the process's, not the turn's). */
let turns = 0;
let totalCost = 0;
/** The running totals of every model call in the process, sub-agents' included, as result.modelUsage reports them. */
const totals = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
const queue: string[] = [];

async function turn(text: string): Promise<void> {
  out({ type: "system", subtype: "init", model: "fake-model", session_id: "fake" });
  if (text === "/compact") return compact();
  fake.history!.push(text);
  const denials: unknown[] = [];
  const first = await respond(fake, text, (command) =>
    out({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command } }] }, parent_tool_use_id: null }), () => refused(denials));
  if (typeof first !== "string") return "exit" in first ? exitOnSignal() : "interrupted" in first ? interrupted() : fail(first.fail);
  // What came in during the turn was read inside it (and a command in it is acted on).
  fake.history!.push(...unread);
  const reply = actOnRead(unread, first);
  unread = [];
  out({ type: "assistant", message: { content: [{ type: "text", text: reply }], usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: contextTokens(contextWindow(1000), 100) - 10 } }, parent_tool_use_id: null });
  // FAKE_LATE_NEXT: the process's first turn writes its result only once a message comes in after its reply, and that
  // message, come too late to be read in the turn, runs as a turn of its own after it (as Claude Code runs a `next`
  // message that reached it as its turn ended): Nexus sent it into a turn whose result it had not read yet (queue OF).
  if (process.env.FAKE_LATE_NEXT && turns === 0) {
    for (const t = Date.now(); !unread.length && Date.now() - t < 300_000;) await new Promise((r) => setTimeout(r, 20));
    queue.unshift(...unread);
    unread = [];
  }
  // As Claude Code reports them (checked live): result.usage is this turn's, total_cost_usd runs on. Turn n of the
  // process: 10n input, 5n output, n cache-creation, 100n cache-read tokens, and, with FAKE_COST set, $0.01·n (other
  // tests' records expect a cost of 0).
  const n = ++turns;
  if (process.env.FAKE_COST) totalCost = Math.round((totalCost + 0.01 * n) * 1e6) / 1e6;
  const usage = { input_tokens: 10 * n, output_tokens: 5 * n, cache_creation_input_tokens: n, cache_read_input_tokens: 100 * n };
  // FAKE_USAGE: the 5-hour window's utilization (0 to 1) this turn reports, as Claude Code's rate_limit_event does.
  if (process.env.FAKE_USAGE) {
    const resetsAt = Math.ceil(Date.now() / 1000) + 3600;
    out({ type: "rate_limit_event", rate_limit_info: { status: "allowed", unifiedWindows: { five_hour: { utilization: Number(process.env.FAKE_USAGE), resetsAt, status: "allowed" }, seven_day: { utilization: 0.2, resetsAt: resetsAt + 86400, status: "allowed" } } }, uuid: "u", session_id: "fake" });
  }
  const bg = fake.background;
  fake.background = undefined;
  if (bg) startBackground(bg);
  // A sub-agent's tokens (probed 2026-11-15): its own messages carry parent_tool_use_id; result.usage leaves them out,
  // and modelUsage, the process's running total, has them.
  const sub = fake.subagent ? { input_tokens: 2, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 500 } : undefined;
  fake.subagent = undefined;
  if (sub) out({ type: "assistant", message: { content: [{ type: "text", text: "sub-agent answer" }], usage: sub }, parent_tool_use_id: "toolu_fake_agent" });
  totals.inputTokens += usage.input_tokens + (sub?.input_tokens ?? 0);
  totals.outputTokens += usage.output_tokens + (sub?.output_tokens ?? 0);
  totals.cacheReadInputTokens += usage.cache_read_input_tokens + (sub?.cache_read_input_tokens ?? 0);
  totals.cacheCreationInputTokens += usage.cache_creation_input_tokens + (sub?.cache_creation_input_tokens ?? 0);
  out({ type: "result", subtype: "success", is_error: false, result: reply, num_turns: 1, total_cost_usd: totalCost, usage, modelUsage: { fake: { contextWindow: contextWindow(1000), ...totals } }, permission_denials: denials });
}

/**
 * Background work as Claude Code 2.1.323 reports it (probed 2026-11-14): background_tasks_changed with the whole list
 * and task_started when it starts; at its end task_updated, task_notification, background_tasks_changed with what is
 * left, and a turn the CLI starts by itself (system init) with the notification.
 */
let tasks: { task_id: string; task_type: string; description: string }[] = [];
function startBackground(bg: Background): void {
  const task = { task_id: `task-${tasks.length + 1}`, task_type: bg.kind === "agent" ? "local_agent" : "local_bash", description: bg.kind === "agent" ? "fake sub-agent" : "fake background command" };
  tasks = [...tasks, task];
  out({ type: "system", subtype: "background_tasks_changed", tasks, uuid: "u", session_id: "fake" });
  out({ type: "system", subtype: "task_started", task_id: task.task_id, description: task.description, is_backgrounded: true, task_type: task.task_type, uuid: "u", session_id: "fake" });
  onBackgroundEnd(bg, () => {
    tasks = tasks.filter((t) => t !== task);
    out({ type: "system", subtype: "task_updated", task_id: task.task_id, patch: { status: "completed" }, uuid: "u", session_id: "fake" });
    out({ type: "system", subtype: "task_notification", task_id: task.task_id, status: "completed", summary: `${task.description} completed`, uuid: "u", session_id: "fake" });
    out({ type: "system", subtype: "background_tasks_changed", tasks, uuid: "u", session_id: "fake" });
    queue.push(`${BACKGROUND_NOTICE} ${task.description} completed`);
    void pump();
  });
}

/**
 * Refused tool calls as Claude Code writes them (Agent SDK sdk.d.ts: SDKPermissionDeniedMessage, and
 * SDKPermissionDenial in the result's permission_denials, the authoritative list): a Bash call denied with a message,
 * and a Write denied only in the result's list (as a path rule's denial is).
 */
function refused(denials: unknown[]): void {
  const bash = { command: "git push origin main" }, write = { file_path: "C:/Users/x/.ssh/config", content: "Host *" };
  out({ type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_bash", name: "Bash", input: bash }] }, parent_tool_use_id: null });
  out({ type: "system", subtype: "permission_denied", tool_name: "Bash", tool_use_id: "toolu_bash", decision_reason_type: "mode", decision_reason: "Bash(git push:*) is not allowed in this mode", message: "Permission to use Bash has been denied.", uuid: "u", session_id: "fake" });
  out({ type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_write", name: "Write", input: write }] }, parent_tool_use_id: null });
  denials.push({ tool_name: "Bash", tool_use_id: "toolu_bash", tool_input: bash }, { tool_name: "Write", tool_use_id: "toolu_write", tool_input: write });
}

/**
 * A failed turn as Claude Code writes it (Agent SDK sdk.d.ts: SDKAPIRetryMessage, SDKAssistantMessage.error,
 * SDKRateLimitEvent, SDKResultSuccess with is_error and api_error_status): the CLI's own retries, a synthetic
 * assistant message naming the error, and a result marked as an error.
 */
/**
 * An interrupted turn as Claude Code 2.1.323 writes it (probed 2026-11-14): the text the model had begun, the
 * "[Request interrupted by user]" user message, a result with error_during_execution and terminal_reason
 * aborted_streaming; then the `next` messages it had not read run as a turn of their own.
 */
function interrupted(): void {
  out({ type: "assistant", message: { content: [{ type: "text", text: PARTIAL }] }, parent_tool_use_id: null });
  out({ type: "user", message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] }, parent_tool_use_id: null });
  out({ type: "result", subtype: "error_during_execution", is_error: true, result: "", num_turns: 1, total_cost_usd: totalCost, terminal_reason: "aborted_streaming", modelUsage: {}, permission_denials: [] });
  queue.unshift(...unread);
  unread = [];
}

/**
 * "/compact" as Claude Code 2.1.323 runs it (probed 2026-11-15): a status, a compact_boundary with the tokens before
 * and after, the summary replayed as a user message, the command's output, and a result with no text.
 */
function compact(): void {
  out({ type: "system", subtype: "status", status: "compacting", session_id: "fake" });
  out({ type: "system", subtype: "compact_boundary", session_id: "fake", compact_metadata: { trigger: "manual", pre_tokens: contextTokens(contextWindow(1000), 100), post_tokens: 30 } });
  out({ type: "user", message: { role: "user", content: "This session is being continued from a previous conversation. Summary: fake." }, isReplay: true, parent_tool_use_id: null });
  out({ type: "user", message: { role: "user", content: "<local-command-stdout>Compacted </local-command-stdout>" }, isReplay: true, parent_tool_use_id: null });
  out({ type: "result", subtype: "success", is_error: false, result: "", num_turns: 0, total_cost_usd: totalCost, usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, modelUsage: { fake: { contextWindow: contextWindow(1000), ...totals } }, permission_denials: [] });
}

/** Ends the process as a signal would, before the turn's result: the CLI killed, or closing by itself. */
function exitOnSignal(): void { process.kill(process.pid, "SIGTERM"); }

function fail(kind: FakeFailure): void {
  if (kind === "crash") process.exit(3);
  // cloudflare: the shape queue N7 met on 2026-11-13 (the assistant's error and the result's text as Claude Code wrote them).
  const error = { overloaded: "overloaded", network: "unknown", auth: "authentication_failed", limit: "rate_limit", cloudflare: "authentication_failed" }[kind];
  const status = { overloaded: 529, network: null, auth: 401, limit: 429, cloudflare: 403 }[kind];
  const text = { overloaded: "API Error: Repeated 529 Overloaded errors", network: "API Error: Connection error.", auth: "Invalid API key - Please run /login", limit: "Claude AI usage limit reached", cloudflare: "Failed to authenticate. API Error: 403 Attention Required! | Cloudflare" }[kind];
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
function read(d: string): void {
  buffer += d;
  let i: number;
  while ((i = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line) as { type?: string; request_id?: string; request?: { subtype?: string }; message: { content: string }; priority?: string };
    // The interrupt control request (a stop): answered at once, like Claude Code, whether a turn runs or not.
    if (msg.type === "control_request") {
      record(`[control] ${msg.request?.subtype}`, null, busy);
      if (msg.request?.subtype === "interrupt") interrupt();
      out({ type: "control_response", response: { subtype: "success", request_id: msg.request_id, response: { still_queued: [] } } });
      continue;
    }
    // The conversation is saved as its first message is read, before the turn starts.
    save();
    record(msg.message.content, msg.priority ?? null, busy);
    // A "next" message during a turn is read inside it (as Claude Code does); anything else is a turn of its own.
    if (msg.priority === "next" && busy) { unread.push(msg.message.content); continue; }
    queue.push(msg.message.content);
    void pump();
  }
}

function listen(): void {
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", read);
  // FAKE_EXIT_DELAY_MS: the process lingers that long after its input closed (a CLI flushing its transcript).
  process.stdin.on("end", () => { const wait = () => (busy ? setTimeout(wait, 50) : setTimeout(() => process.exit(0), Number(process.env.FAKE_EXIT_DELAY_MS ?? 0))); wait(); });
}

// FAKE_START_MS: the input is read only after that long, as Claude Code reads it once it has started.
if (!refusal) {
  if (process.env.FAKE_START_MS) setTimeout(listen, Number(process.env.FAKE_START_MS));
  else listen();
}
