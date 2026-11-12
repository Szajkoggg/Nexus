// A Claude Code session run by Nexus: the unmodified `claude` binary in print mode, stream-json in and out, kept
// alive across turns. Signed in with the user's own subscription (no API key, no Agent SDK).
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { agentEnv, type ActivityItem, type AgentEvents, type AgentProcess, type Priority, type StreamFacts, type TurnFailure } from "./agent.ts";

export type { ActivityItem, Priority, StreamFacts };

/** What a turn showed about an error before its result: read when the result says the turn failed. */
export interface ClaudeTurnSigns {
  /** The `error` of a (synthetic) assistant message: SDKAssistantMessageError. */
  apiError?: string;
  /** The last `api_retry` was for a connection error (no HTTP status). */
  connectionRetry?: boolean;
  /** A `rate_limit_event` rejected the request and said when the window resets. */
  resetsAt?: string;
  /** A `model_refusal_no_fallback` came. */
  refusal?: boolean;
}

const CLAUDE_PASSING = new Set(["overloaded", "server_error", "rate_limit", "connection"]);

/**
 * Tells a failed turn's reason from its result and what the turn showed before it. The shapes are the Agent SDK's
 * (sdk.d.ts of @anthropic-ai/claude-agent-sdk 0.3.323, matching Claude Code 2.1.323): `result.is_error`,
 * `api_error_status`, `subtype`, `terminal_reason`, `stop_reason`; the assistant message's `error`; `api_retry` and
 * `rate_limit_event` system messages. Undefined for a success, and for a turn Nexus interrupted.
 */
export function classifyClaudeResult(m: Record<string, any>, signs: ClaudeTurnSigns): TurnFailure | undefined {
  const text = clip(String(typeof m.result === "string" && m.result ? m.result : (m.errors ?? []).join("; ") || m.subtype || "error"), 300);
  if (signs.refusal || m.stop_reason === "refusal") return { kind: "lasting", code: "refusal", text };
  if (!m.is_error && m.subtype === "success") return undefined;
  if (m.terminal_reason === "aborted_streaming" || m.terminal_reason === "aborted_tools") return undefined; // interrupted
  let code = signs.apiError ?? httpCode(m.api_error_status) ?? (m.subtype && m.subtype !== "success" ? String(m.subtype) : "unknown");
  if ((code === "unknown" || code === "server_error") && signs.connectionRetry) code = "connection";
  if (code === "rate_limit" && signs.resetsAt && Date.parse(signs.resetsAt) > Date.now()) return { kind: "usage", code, text, resetsAt: signs.resetsAt };
  return { kind: CLAUDE_PASSING.has(code) ? "passing" : "lasting", code, text };
}

function httpCode(status: unknown): string | undefined {
  if (typeof status !== "number") return undefined;
  if (status === 529) return "overloaded";
  if (status === 429) return "rate_limit";
  if (status === 401 || status === 403) return "authentication_failed";
  if (status === 404) return "model_not_found";
  if (status >= 500) return "server_error";
  if (status >= 400) return "invalid_request";
  return undefined;
}

export interface ClaudeOptions {
  cwd: string;
  /** Claude's own session id (a UUID). New sessions are created with it; existing ones resumed. */
  uuid: string;
  resume: boolean;
  model?: string;
  effort?: string;
  permissionMode: string;
  allowedTools: string[];
  disallowedTools?: string[];
  /** A file of subagent definitions (--agents). */
  agentsFile?: string;
  appendSystemPrompt?: string;
  env: Record<string, string>;
}

export class ClaudeSession extends EventEmitter<AgentEvents> implements AgentProcess {
  readonly options: ClaudeOptions;
  private proc: ChildProcessWithoutNullStreams;
  private buffer = "";
  /** `working` from a sent turn (or a turn the CLI starts itself) until its result. */
  state: "working" | "idle" | "exited" = "idle";
  exitCode: number | null = null;
  readonly pid?: number;
  private lastStderr = "";
  private signs: ClaudeTurnSigns = {};

  constructor(options: ClaudeOptions) {
    super();
    this.options = options;
    const args = [
      "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
      options.resume ? "--resume" : "--session-id", options.uuid,
      "--permission-mode", options.permissionMode,
    ];
    if (options.model) args.push("--model", options.model);
    if (options.effort) args.push("--effort", options.effort);
    if (options.appendSystemPrompt) args.push("--append-system-prompt", options.appendSystemPrompt);
    if (options.agentsFile) args.push("--agents", options.agentsFile);
    if (options.disallowedTools?.length) args.push("--disallowedTools", options.disallowedTools.join(","));
    if (options.allowedTools.length) args.push("--allowedTools", ...options.allowedTools); // variadic: keep last
    // NEXUS_CLAUDE replaces the binary (tests use a fake written in TypeScript or JavaScript, run by this Node).
    const bin = process.env.NEXUS_CLAUDE ?? "claude";
    const script = /\.(m?[jt]s)$/.test(bin);
    this.proc = spawn(script ? process.execPath : bin, script ? [bin, ...args] : args, {
      cwd: options.cwd,
      env: agentEnv(options.env),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.pid = this.proc.pid;
    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (d: string) => this.read(d));
    this.proc.stderr.setEncoding("utf8");
    this.proc.stderr.on("data", (d: string) => { this.lastStderr = (this.lastStderr + d).slice(-2000); });
    this.proc.on("error", (err) => {
      this.emit("activity", { kind: "error", text: `could not start claude: ${err.message}` });
    });
    this.proc.on("exit", (code) => {
      this.state = "exited";
      this.exitCode = code;
      if (code && this.lastStderr.trim()) this.emit("activity", { kind: "error", text: this.lastStderr.trim().slice(-500) });
      this.emit("exit", code);
    });
  }

  /**
   * Sends a user message. Without a priority it is a new turn (queued after the current one if one runs);
   * `next` is read during the running turn after its current tool calls; `now` interrupts the turn.
   */
  send(text: string, priority?: Priority): void {
    if (this.state === "exited") throw new Error("the session's process has exited");
    const msg = { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, ...(priority ? { priority } : {}) };
    this.proc.stdin.write(JSON.stringify(msg) + "\n");
    if (priority !== "next" || this.state === "idle") this.state = "working";
  }

  /** Ends the session after the running turn: closing stdin lets the CLI finish and exit. */
  close(): void { if (this.state !== "exited") this.proc.stdin.end(); }

  kill(): void { if (this.state !== "exited") this.proc.kill(); }

  private read(chunk: string): void {
    this.buffer += chunk;
    let i: number;
    while ((i = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, i).trim();
      this.buffer = this.buffer.slice(i + 1);
      if (!line) continue;
      let m: Record<string, any>;
      try { m = JSON.parse(line); } catch { continue; }
      this.handle(m);
    }
  }

  private handle(m: Record<string, any>): void {
    switch (m.type) {
      case "system":
        if (m.subtype === "api_retry") {
          // The CLI retries by itself: recorded, not counted against Nexus's own retries.
          this.signs.connectionRetry = m.error_status === null || m.error_status === undefined;
          this.emit("activity", { kind: "retry", text: `Claude Code retries a request (${m.attempt} of ${m.max_retries}, in ${Math.round((m.retry_delay_ms ?? 0) / 1000)} s): ${m.error ?? "error"}${m.error_status ? ` (${m.error_status})` : ""}` });
        }
        if (m.subtype === "model_refusal_no_fallback") this.signs.refusal = true;
        if (m.subtype === "init") {
          this.signs = {};
          this.state = "working";
          this.emit("facts", { model: m.model });
          this.emit("activity", { kind: "turn_start", text: `turn started (${m.model})` });
        }
        return;
      case "assistant": {
        if (m.error && !m.parent_tool_use_id) this.signs.apiError = String(m.error);
        const u = m.message?.usage;
        if (u) this.emit("facts", { contextTokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) });
        if (m.parent_tool_use_id) return; // a subagent's message: its parent's tool call is what we show
        for (const c of m.message?.content ?? []) {
          if (c.type === "text" && c.text?.trim()) {
            this.emit("activity", { kind: "text", text: clip(c.text, 600) });
            this.emit("message", c.text);
          }
          if (c.type === "tool_use") this.emit("activity", { kind: "tool", text: describeTool(c.name, c.input) });
        }
        return;
      }
      case "user": {
        if (m.parent_tool_use_id) return;
        const content = m.message?.content;
        if (!Array.isArray(content)) return;
        for (const c of content) {
          if (c.type === "tool_result" && c.is_error) {
            const text = typeof c.content === "string" ? c.content : JSON.stringify(c.content);
            this.emit("activity", { kind: "tool_error", text: clip(text, 400) });
          }
        }
        return;
      }
      case "rate_limit_event": {
        const info = m.rate_limit_info;
        if (info?.status === "rejected" && info.resetsAt) this.signs.resetsAt = new Date(info.resetsAt * 1000).toISOString();
        const w = m.rate_limit_info?.unifiedWindows as Record<string, { utilization: number; resetsAt?: number; status?: string }> | undefined;
        if (w) {
          const usage: StreamFacts["usage"] = {};
          for (const [name, x] of Object.entries(w)) {
            usage[name] = { utilization: x.utilization, resets_at: x.resetsAt ? new Date(x.resetsAt * 1000).toISOString() : undefined, status: x.status };
          }
          this.emit("facts", { usage });
        }
        return;
      }
      case "result": {
        this.state = "idle";
        const models = Object.values((m.modelUsage ?? {}) as Record<string, { contextWindow?: number }>);
        this.emit("facts", { contextWindow: models.find((x) => x.contextWindow)?.contextWindow, costUsd: m.total_cost_usd });
        const failure = classifyClaudeResult(m, this.signs);
        this.signs = {};
        const ok = !failure && !m.is_error && m.subtype === "success";
        const text = typeof m.result === "string" ? m.result : m.subtype ?? "";
        this.emit("activity", { kind: "turn_end", text: ok ? `turn ended (${m.num_turns ?? "?"} model calls)` : failure ? `turn failed (${failure.kind}, ${failure.code}): ${failure.text}` : `turn ended early: ${clip(text, 300)}` });
        this.emit("turnEnd", { ok, text, failure });
        return;
      }
      default:
        return;
    }
  }
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

function describeTool(name: string, input: Record<string, any> = {}): string {
  const first = (...keys: string[]) => keys.map((k) => input[k]).find((v) => typeof v === "string") as string | undefined;
  const detail = first("command", "file_path", "path", "pattern", "url", "description", "prompt", "query") ?? "";
  return clip(`${name}${detail ? `: ${detail.replace(/\s+/g, " ")}` : ""}`, 300);
}
