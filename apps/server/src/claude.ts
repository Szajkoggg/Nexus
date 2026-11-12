// A Claude Code session run by Nexus: the unmodified `claude` binary in print mode, stream-json in and out, kept
// alive across turns. Signed in with the user's own subscription (no API key, no Agent SDK).
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";

export interface ClaudeOptions {
  cwd: string;
  /** Claude's own session id (a UUID). New sessions are created with it; existing ones resumed. */
  uuid: string;
  resume: boolean;
  model?: string;
  permissionMode: string;
  allowedTools: string[];
  appendSystemPrompt?: string;
  env: Record<string, string>;
}

export type Priority = "now" | "next" | "later";

/** Facts read from the stream, for the session's runtime record. */
export interface StreamFacts {
  model?: string;
  contextTokens?: number;
  contextWindow?: number;
  costUsd?: number;
  usage?: Record<string, { utilization: number; resets_at?: string; status?: string }>;
}

/** What the agent did, condensed for the dashboard. */
export interface ActivityItem { kind: "turn_start" | "text" | "tool" | "tool_error" | "turn_end" | "error"; text: string }

interface Events {
  activity: [ActivityItem];
  facts: [StreamFacts];
  turnEnd: [{ ok: boolean; text: string }];
  exit: [number | null];
}

export class ClaudeSession extends EventEmitter<Events> {
  readonly options: ClaudeOptions;
  private proc: ChildProcessWithoutNullStreams;
  private buffer = "";
  /** `working` from a sent turn (or a turn the CLI starts itself) until its result. */
  state: "working" | "idle" | "exited" = "idle";
  exitCode: number | null = null;
  readonly pid?: number;
  private lastStderr = "";

  constructor(options: ClaudeOptions) {
    super();
    this.options = options;
    const args = [
      "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
      options.resume ? "--resume" : "--session-id", options.uuid,
      "--permission-mode", options.permissionMode,
    ];
    if (options.model) args.push("--model", options.model);
    if (options.appendSystemPrompt) args.push("--append-system-prompt", options.appendSystemPrompt);
    if (options.allowedTools.length) args.push("--allowedTools", ...options.allowedTools); // variadic: keep last
    this.proc = spawn(process.env.NEXUS_CLAUDE ?? "claude", args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
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
        if (m.subtype === "init") {
          this.state = "working";
          this.emit("facts", { model: m.model });
          this.emit("activity", { kind: "turn_start", text: `turn started (${m.model})` });
        }
        return;
      case "assistant": {
        const u = m.message?.usage;
        if (u) this.emit("facts", { contextTokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) });
        if (m.parent_tool_use_id) return; // a subagent's message: its parent's tool call is what we show
        for (const c of m.message?.content ?? []) {
          if (c.type === "text" && c.text?.trim()) this.emit("activity", { kind: "text", text: clip(c.text, 600) });
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
        const ok = !m.is_error && m.subtype === "success";
        const text = typeof m.result === "string" ? m.result : m.subtype ?? "";
        this.emit("activity", { kind: "turn_end", text: ok ? `turn ended (${m.num_turns ?? "?"} model calls)` : `turn ended with an error: ${clip(text, 300)}` });
        this.emit("turnEnd", { ok, text });
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
