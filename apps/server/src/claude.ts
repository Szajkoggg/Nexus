// A Claude Code session run by Nexus: the unmodified `claude` binary in print mode, stream-json in and out, kept
// alive across turns. Signed in with the user's own subscription (no API key, no Agent SDK).
import { spawnRuntimeChild, type RuntimeChild } from "./worker-process.ts";
import { EventEmitter } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { EDGE_BLOCK, agentEnv, edgeBlock, shortInput, type AgentEvents, type AgentProcess, type Priority, type StreamFacts, type TurnFailure, type TurnTokens } from "./agent.ts";

export type { Priority };

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

/**
 * How long after a turn's end a turn the CLI starts by itself, for `next` messages it had not read in the turn, may
 * still begin: it follows within milliseconds (seen live after a stop, settleStop); this leaves room for a busy machine.
 */
const LATE_TURN_MS = 1500;
const CLAUDE_PASSING = new Set(["overloaded", "server_error", "rate_limit", "connection"]);

/**
 * Tells a failed turn's reason from its result and what the turn showed before it. The shapes are the Agent SDK's
 * (sdk.d.ts of @anthropic-ai/claude-agent-sdk 0.3.323, matching Claude Code 2.1.323): `result.is_error`,
 * `api_error_status`, `subtype`, `terminal_reason`, `stop_reason`; the assistant message's `error`; `api_retry` and
 * `rate_limit_event` system messages. Undefined for a success, and for a turn Nexus interrupted.
 */
export function classifyClaudeResult(m: Record<string, any>, signs: ClaudeTurnSigns): TurnFailure | undefined {
  const full = String(typeof m.result === "string" && m.result ? m.result : (m.errors ?? []).join("; ") || m.subtype || "error");
  const text = clip(full, 300);
  if (signs.refusal || m.stop_reason === "refusal") return { kind: "lasting", code: "refusal", text };
  if (!m.is_error && m.subtype === "success") return undefined;
  if (m.terminal_reason === "aborted_streaming" || m.terminal_reason === "aborted_tools") return undefined; // interrupted
  let code = signs.apiError ?? httpCode(m.api_error_status) ?? (m.subtype && m.subtype !== "success" ? String(m.subtype) : "unknown");
  if ((code === "unknown" || code === "server_error") && signs.connectionRetry) code = "connection";
  if (code === "rate_limit" && signs.resetsAt && Date.parse(signs.resetsAt) > Date.now()) return { kind: "usage", code, text, resetsAt: signs.resetsAt };
  if (CLAUDE_PASSING.has(code)) return { kind: "passing", code, text };
  // An edge's 403 page reported as an authentication failure (or another lasting code): no credential is wrong.
  if (edgeBlock(full)) return { kind: "passing", code: EDGE_BLOCK, text };
  return { kind: "lasting", code, text };
}

/** A result's usage (one turn's, the main agent loop's) as the four figures, or undefined without one. */
function claudeTurnTokens(u: Record<string, any> | undefined): TurnTokens | undefined {
  if (!u || typeof u !== "object") return undefined;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return { input: n(u.input_tokens), output: n(u.output_tokens), cacheRead: n(u.cache_read_input_tokens), cacheCreation: n(u.cache_creation_input_tokens) };
}

/**
 * result.modelUsage summed over its models: the process's running total of every model call, its sub-agents' included
 * (probed 2026-11-15: it grows across turns, like total_cost_usd, while result.usage is the main loop's turn alone).
 * Undefined when the result carries no token counts.
 */
function claudeModelTotals(mu: unknown): TurnTokens | undefined {
  if (!mu || typeof mu !== "object") return undefined;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  let any = false;
  const t: TurnTokens = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
  for (const m of Object.values(mu as Record<string, Record<string, unknown>>)) {
    const f = [n(m?.inputTokens), n(m?.outputTokens), n(m?.cacheReadInputTokens), n(m?.cacheCreationInputTokens)];
    if (f.every((x) => x === undefined)) continue;
    any = true;
    t.input += f[0] ?? 0; t.output += f[1] ?? 0; t.cacheRead += f[2] ?? 0; t.cacheCreation += f[3] ?? 0;
  }
  return any ? t : undefined;
}

/**
 * A turn's sub-agent tokens: what the process's running total grew by since the previous result, less the main
 * loop's turn (each figure at least 0). Undefined without both, or without the previous total.
 */
function subagentTokens(total: TurnTokens | undefined, before: TurnTokens | undefined, turn: TurnTokens | undefined): TurnTokens | undefined {
  if (!total || !before || !turn) return undefined;
  const d = (k: keyof TurnTokens) => Math.max(0, total[k] - before[k] - turn[k]);
  return { input: d("input"), output: d("output"), cacheRead: d("cacheRead"), cacheCreation: d("cacheCreation") };
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
  /** Only AgentHost sets this, for worker sessions. */
  ownProcesses?: boolean;
  /**
   * Only AgentHost sets this: the session's role. Its process then runs in a job of its own on Windows, so the server
   * can tell its connections from the user's (worker-process.ts agentOwning; docs/design/security.md).
   */
  agentRole?: string;
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
  /** The session's briefing, appended to Claude Code's system prompt. */
  appendSystemPrompt?: string;
  /**
   * Where the briefing is written for the CLI to read (--append-system-prompt-file), anew at each start: AgentHost
   * gives the session's own file. Not on the command line, which Windows limits to 32,767 characters in all (docs/design/engine.md,
   * "The orchestrator's briefing and the command line").
   */
  briefingFile?: string;
  /** More settings for the session (--settings, as JSON): a thinking partner's WebFetch guard hook. */
  settings?: string;
  /**
   * How long after a turn's end a turn of the CLI's own may still begin (LATE_TURN_MS by default): the settling and a
   * stop's settle last that long. Tests that start the late turn themselves, after Nexus looked, hold it open.
   */
  lateTurnMs?: number;
  env: Record<string, string>;
}

export class ClaudeSession extends EventEmitter<AgentEvents> implements AgentProcess {
  readonly options: ClaudeOptions;
  private proc!: RuntimeChild;
  /** The CLI's arguments after the session flag (`--resume` or `--session-id` and the id, which startProcess adds). */
  private readonly args: string[];
  /** Whether the running process resumes the session (`--resume`): options.resume, unless a refused start was retried. */
  private resume: boolean;
  private buffer = "";
  /** `working` from a sent turn (or a turn the CLI starts itself) until its result. */
  state: "working" | "idle" | "exited" = "idle";
  exitCode: number | null = null;
  get pid(): number | undefined { return this.proc.pid; }
  private lastStderr = "";
  private signs: ClaudeTurnSigns = {};
  /**
   * total_cost_usd of the previous result: the CLI reports a running total for the process (a resumed one starts
   * from the total its transcript saved, unknown here), so a turn's cost is the difference.
   */
  private costSoFar: number | undefined;
  /** result.modelUsage's sum at the previous result (claudeModelTotals): unknown, like costSoFar, in a resumed process. */
  private modelSoFar: TurnTokens | undefined;
  /** Tool calls of the running turn, by tool_use_id: a permission_denied message names the call, not its input. */
  private calls = new Map<string, { name: string; input: unknown }>();
  /** Refused tool calls already reported, by tool_use_id: the result's permission_denials repeat the messages. */
  private refused = new Set<string>();
  /**
   * A stop in progress (stop()): the turn's texts and tool calls are not emitted; a turn the CLI starts by itself
   * meanwhile is interrupted too; the user's messages wait in `held` until it settles.
   */
  private stopping = false;
  private held: string[] = [];
  private settle?: NodeJS.Timeout;
  private stops = 0;
  /** Messages sent into the running turn (`next`) since its start. */
  private nextInTurn = 0;
  /** While settling (AgentProcess.settling): ends the moment after a turn that had `next` messages sent into it. */
  private late?: NodeJS.Timeout;
  /**
   * The background work the CLI reports running (system background_tasks_changed: its whole list each time, seen with
   * Claude Code 2.1.323: a Bash command or a sub-agent started with run_in_background). When it ends, the CLI starts a
   * turn by itself with the task's notification.
   */
  background: readonly string[] = [];
  /**
   * A fresh session whose conversation is not saved yet: Claude Code saves it as it reads the first message, and
   * writes nothing before (probed 2026-11-15), so the first turn's start says it is saved (facts `saved`).
   */
  private unsaved = false;
  /** The CLI refused the start, naming whether the session has a saved conversation (savedFromRefusal): told once. */
  private refusalTold = false;
  /**
   * What was written to the process's input while it wrote nothing (until its first output): a start the CLI refused
   * (savedFromRefusal) is tried once more with it (exited). Undefined once the process wrote something.
   */
  private written: string[] | undefined = [];
  /** A refused `--resume`'s error result, its first output: held until its exit says whether the start is retried. */
  private early?: Record<string, any>;
  /** A refused start was tried again (once per ClaudeSession). */
  private retried = false;
  /** Ended by kill(): a refusal then is not retried. */
  private killed = false;
  /** close() was called: a retried process gets its input closed too. */
  private inputClosed = false;

  constructor(options: ClaudeOptions) {
    super();
    this.options = options;
    this.resume = options.resume;
    const args = ["--permission-mode", options.permissionMode];
    if (options.model) args.push("--model", options.model);
    if (options.effort) args.push("--effort", options.effort);
    if (options.appendSystemPrompt) {
      if (!options.briefingFile) throw new Error("a briefing needs a file to go in (ClaudeOptions.briefingFile)");
      mkdirSync(dirname(options.briefingFile), { recursive: true });
      writeFileSync(options.briefingFile, options.appendSystemPrompt, "utf8");
      args.push("--append-system-prompt-file", options.briefingFile);
    }
    if (options.agentsFile) args.push("--agents", options.agentsFile);
    if (options.settings) args.push("--settings", options.settings);
    if (options.disallowedTools?.length) args.push("--disallowedTools", options.disallowedTools.join(","));
    if (options.allowedTools.length) args.push("--allowedTools", ...options.allowedTools); // variadic: keep last
    this.args = args;
    this.startProcess();
  }

  /** Starts the CLI on the session, resuming it or not (`resume`); only the latest process's events count. */
  private startProcess(): void {
    const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", this.resume ? "--resume" : "--session-id", this.options.uuid, ...this.args];
    // NEXUS_CLAUDE replaces the binary (tests use a fake written in TypeScript or JavaScript, run by this Node).
    const bin = process.env.NEXUS_CLAUDE ?? "claude";
    const script = /\.(m?[jt]s)$/.test(bin);
    const child = spawnRuntimeChild(script ? process.execPath : bin, script ? [bin, ...args] : args, {
      cwd: this.options.cwd,
      env: agentEnv(this.options.env),
      owned: this.options.ownProcesses,
      agent: this.options.agentRole,
    });
    this.proc = child;
    child.on("spawn", () => { if (child === this.proc && child.pid) this.emit("facts", { pid: child.pid }); });
    this.buffer = "";
    this.lastStderr = "";
    this.refusalTold = false;
    this.unsaved = !this.resume;
    this.costSoFar = this.resume ? undefined : 0;
    this.modelSoFar = this.resume ? undefined : { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
    // A write to a process that is exiting (killed, crashed) fails with EPIPE: its exit is handled, the write is moot.
    child.stdin.on("error", () => {});
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d: string) => { if (child === this.proc) this.read(d); });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d: string) => {
      if (child !== this.proc) return;
      this.lastStderr = (this.lastStderr + d).slice(-2000);
      // A refused start names whether the session has a saved conversation; its words may come after the exit event.
      const saved = this.refusalTold ? undefined : savedFromRefusal(this.lastStderr);
      if (saved !== undefined) { this.refusalTold = true; this.emit("facts", { saved }); }
    });
    child.on("error", (err) => {
      if (child === this.proc) this.emit("activity", { kind: "error", text: `could not start claude: ${err.message}` });
    });
    child.on("exit", (code) => {
      if (child !== this.proc) return;
      if (!code || !this.mayRetry()) { this.exited(code); return; }
      // A start the CLI may have refused: its words on stderr may come after the exit event (a moment at most).
      let done = false;
      const settle = () => { if (!done) { done = true; clearTimeout(timer); this.exited(code); } };
      const timer = setTimeout(settle, 1000);
      if (child.stderr.readableEnded) settle(); else child.stderr.once("end", settle);
    });
  }

  /** A refused start may be tried again: once, while the process wrote nothing, unless Nexus ended it. */
  private mayRetry(): boolean { return !this.retried && !this.killed && this.written !== undefined; }

  /**
   * The process exited. A start Claude Code refused, naming the session's conversation (`--resume` of one it never
   * saved, `--session-id` of one it did: savedFromRefusal), is tried once more the other way with what was written to
   * it (the step's turn, a message), so the session neither stops nor loses its message (queue RN); the record was
   * corrected meanwhile (facts `saved`). A second refusal ends the process as any exit does.
   */
  private exited(code: number | null): void {
    const saved = code ? savedFromRefusal(this.lastStderr) : undefined;
    if (saved !== undefined && this.mayRetry()) { this.startAgain(saved); return; }
    const early = this.early;
    this.early = undefined;
    if (early) this.handle(early);
    this.state = "exited";
    this.background = [];
    clearTimeout(this.settle);
    this.stopSettling();
    this.exitCode = code;
    if (code && this.lastStderr.trim()) this.emit("activity", { kind: "error", text: this.lastStderr.trim().slice(-500) });
    this.emit("exit", code);
  }

  /** Starts the refused session again, resuming it if it has a saved conversation, and writes its input again. */
  private startAgain(saved: boolean): void {
    this.retried = true;
    this.resume = saved;
    const lines = this.written!;
    this.written = [];
    this.early = undefined;
    this.emit("activity", { kind: "retry", text: `Claude Code refused the start (${clip(this.lastStderr.trim(), 200)}); started again, ${saved ? "resuming the saved conversation" : "afresh"}` });
    this.startProcess();
    this.emit("facts", { pid: this.proc.pid });
    for (const l of lines) this.write(l);
    if (this.inputClosed) this.proc.stdin.end();
  }

  /** Writes a line to the process's input, kept while the start may still be refused (`written`). */
  private write(line: string): void {
    this.written?.push(line);
    this.proc.stdin.write(line);
  }

  /**
   * Sends a user message. Without a priority it is a new turn (queued after the current one if one runs);
   * `next` is read during the running turn after its current tool calls; `now` interrupts the turn.
   */
  send(text: string, priority?: Priority): void {
    if (this.state === "exited") throw new Error("the session's process has exited");
    if (this.stopping) { this.held.push(text); return; }
    if (priority === "next" && this.state === "working") this.nextInTurn++;
    const msg = { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, ...(priority ? { priority } : {}) };
    this.write(JSON.stringify(msg) + "\n");
    if (priority !== "next" || this.state === "idle") { this.state = "working"; this.stopSettling(); }
  }

  /**
   * Compacts the conversation: "/compact" as a user message, which Claude Code 2.1.323 runs as a turn of its own
   * (probed 2026-11-15): a status "compacting", a compact_boundary with the tokens before and after, the summary as a
   * replayed user message, and a result with no text.
   */
  compact(): boolean {
    if (this.state !== "idle") return false;
    this.send("/compact");
    return true;
  }

  /**
   * Stops the running turn with the CLI's interrupt control request. The CLI still writes what the model had begun
   * (seen with Claude Code 2.1.323: a partial assistant text after the control response), and it runs the `next`
   * messages it had not read as a turn of its own right after the interrupted one; that turn is interrupted as it
   * starts, so its messages are in the conversation and go in with the next turn, and nothing of either is emitted.
   */
  stop(): boolean {
    if (this.state !== "working") return false;
    if (!this.stopping) { this.stopping = true; this.interrupt(); }
    return true;
  }

  private interrupt(): void {
    this.write(JSON.stringify({ type: "control_request", request_id: `nexus-stop-${++this.stops}`, request: { subtype: "interrupt" } }) + "\n");
  }

  /**
   * After a stopped turn's result: a turn the CLI starts by itself for unread `next` messages follows within
   * milliseconds (seen live), so with such messages the stop waits a moment (and for that turn's own result) before it
   * lets the held messages go as new turns.
   */
  private settleStop(): void {
    clearTimeout(this.settle);
    const wait = this.nextInTurn ? this.lateTurnMs : 0;
    this.nextInTurn = 0;
    // Decided after this loop turn's I/O, as startSettling's end (queue LH): a stalled loop runs the timer first.
    const settle = setTimeout(() => setImmediate(() => {
      if (this.settle !== settle) return; // cleared, or another stop's since
      if (this.state !== "idle") return; // a turn of the CLI's own runs (it is being interrupted): its result settles
      this.stopping = false;
      const held = this.held;
      this.held = [];
      for (const t of held) this.send(t);
    }), wait);
    this.settle = settle;
  }

  private get lateTurnMs(): number { return this.options.lateTurnMs ?? LATE_TURN_MS; }

  /** See AgentProcess.settling. */
  get settling(): boolean { return this.late !== undefined; }

  /**
   * After a turn that had `next` messages sent into it: one written to the CLI just as its turn ended (before Nexus read
   * the result) was not read in it and runs as a turn of its own, which starts within milliseconds (as after a stop,
   * settleStop, seen live); nothing in the stream tells such a turn from one that read them all. Until that turn starts
   * or LATE_TURN_MS pass, the process is settling (queue OF: a summary request sent in that moment, as if between turns).
   */
  private startSettling(): void {
    this.stopSettling();
    // The moment's end is decided after this loop turn's I/O (setImmediate runs after the poll phase): after a stall of
    // the server's loop longer than the moment, the expired timer runs before the output that came meanwhile, and a late
    // turn the CLI started in time would be taken for none (queue LH; a side finding of queue CI3A). Its start stops the
    // settling (stopSettling clears `late`), so the deferred end finds it gone.
    const late = setTimeout(() => setImmediate(() => {
      if (this.late !== late) return;
      this.late = undefined;
      if (this.state === "idle") this.emit("settled");
    }), this.lateTurnMs);
    this.late = late;
  }

  private stopSettling(): void {
    clearTimeout(this.late);
    this.late = undefined;
  }

  /** Ends the session after the running turn: closing stdin lets the CLI finish and exit. */
  close(): void { this.inputClosed = true; if (this.state !== "exited") this.proc.stdin.end(); }

  kill(): void { this.killed = true; if (this.state !== "exited") this.proc.kill(); }

  async cleanup(): Promise<void> { await this.proc.cleanup?.(); this.background = []; }

  /** Reports a refused tool call once (the message and the result's list both name it). */
  private refuse(id: string | undefined, tool: string, input: unknown, reason?: string): void {
    if (id) { if (this.refused.has(id)) return; this.refused.add(id); }
    this.emit("refusal", { by: "permissions", tool, input: input === undefined ? "" : shortInput(input), reason: reason ? clip(String(reason), 300) : undefined, ref: id });
  }

  private read(chunk: string): void {
    this.buffer += chunk;
    let i: number;
    while ((i = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, i).trim();
      this.buffer = this.buffer.slice(i + 1);
      if (!line) continue;
      let m: Record<string, any>;
      try { m = JSON.parse(line); } catch { continue; }
      if (this.written) {
        // The process's first output. A resumed one whose first output is an error result was refused (no
        // conversation): the result waits for the exit, which tells whether the start is tried again.
        if (this.resume && !this.retried && m.type === "result" && m.is_error) { this.early = m; continue; }
        this.written = undefined;
      }
      this.handle(m);
    }
  }

  private handle(m: Record<string, any>): void {
    if (this.unsaved && ((m.type === "system" && m.subtype === "init") || m.type === "assistant" || m.type === "result")) {
      this.unsaved = false;
      this.emit("facts", { saved: true });
    }
    switch (m.type) {
      case "system":
        if (m.subtype === "api_retry") {
          // The CLI retries by itself: recorded, not counted against Nexus's own retries.
          this.signs.connectionRetry = m.error_status === null || m.error_status === undefined;
          this.emit("activity", { kind: "retry", text: `Claude Code retries a request (${m.attempt} of ${m.max_retries}, in ${Math.round((m.retry_delay_ms ?? 0) / 1000)} s): ${m.error ?? "error"}${m.error_status ? ` (${m.error_status})` : ""}` });
        }
        if (m.subtype === "model_refusal_no_fallback") this.signs.refusal = true;
        if (m.subtype === "compact_boundary") {
          const md = (m.compact_metadata ?? {}) as { pre_tokens?: number; post_tokens?: number };
          if (typeof md.post_tokens === "number") this.emit("facts", { contextTokens: md.post_tokens });
          this.emit("activity", { kind: "text", text: `context compacted${md.pre_tokens && md.post_tokens ? ` (${md.pre_tokens} to ${md.post_tokens} tokens)` : ""}` });
          this.emit("compacted", { before: md.pre_tokens, after: md.post_tokens });
        }
        if (m.subtype === "permission_denied") {
          const call = this.calls.get(m.tool_use_id);
          this.refuse(m.tool_use_id, m.tool_name ?? call?.name ?? "tool", call?.input, m.decision_reason || m.message || m.decision_reason_type);
        }
        if (m.subtype === "background_tasks_changed" && Array.isArray(m.tasks)) {
          this.background = (m.tasks as { description?: string; task_type?: string; task_id?: string }[])
            .map((t) => clip(String(t.description || t.task_type || t.task_id || "background task"), 120));
          this.emit("background", this.background);
        }
        if (m.subtype === "init") {
          this.signs = {};
          this.state = "working";
          this.stopSettling();
          // A turn the CLI starts by itself while a stop settles (unread messages of the stopped turn): stopped too.
          if (this.stopping) { clearTimeout(this.settle); this.settle = undefined; this.interrupt(); }
          this.emit("facts", { model: m.model });
          this.emit("activity", { kind: "turn_start", text: `turn started (${m.model})` });
        }
        return;
      case "assistant": {
        if (m.error && !m.parent_tool_use_id) this.signs.apiError = String(m.error);
        for (const c of m.message?.content ?? []) if (c.type === "tool_use" && c.id) this.calls.set(c.id, { name: c.name, input: c.input });
        if (m.parent_tool_use_id) return; // a subagent's message: its parent's tool call is what we show; its context is its own
        const u = m.message?.usage;
        if (u) this.emit("facts", { contextTokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) });
        if (this.stopping) return; // what a stopped turn still writes is not shown
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
        // Settling before anything is emitted: the turn's end is acted on as it is emitted.
        if (!this.stopping && this.nextInTurn) this.startSettling();
        const models = Object.values((m.modelUsage ?? {}) as Record<string, { contextWindow?: number }>);
        this.emit("facts", { contextWindow: models.find((x) => x.contextWindow)?.contextWindow, costUsd: m.total_cost_usd });
        // The authoritative list: anything the messages did not report (a hook's or a path rule's denial, for one).
        for (const d of (m.permission_denials ?? []) as { tool_name: string; tool_use_id: string; tool_input: unknown }[]) this.refuse(d.tool_use_id, d.tool_name, d.tool_input);
        this.calls.clear();
        const failure = classifyClaudeResult(m, this.signs);
        this.signs = {};
        const ok = !failure && !m.is_error && m.subtype === "success";
        const text = typeof m.result === "string" ? m.result : m.subtype ?? "";
        this.emit("activity", { kind: "turn_end", text: this.stopping ? "turn stopped by the user" : ok ? `turn ended (${m.num_turns ?? "?"} model calls)` : failure ? `turn failed (${failure.kind}, ${failure.code}): ${failure.text}` : `turn ended early: ${clip(text, 300)}` });
        // result.usage is this turn's (checked live: it does not grow across turns); total_cost_usd runs on.
        const total = typeof m.total_cost_usd === "number" ? m.total_cost_usd : undefined;
        const costUsd = total !== undefined && this.costSoFar !== undefined ? Math.max(0, Math.round((total - this.costSoFar) * 1e9) / 1e9) : undefined; // to a nano-dollar: no float residue
        if (total !== undefined) this.costSoFar = total;
        // Sub-agents' tokens: in modelUsage's running total, not in result.usage (docs/design/usage.md, "Sub-agent tokens").
        const tokens = claudeTurnTokens(m.usage);
        const modelTotal = claudeModelTotals(m.modelUsage);
        const sub = subagentTokens(modelTotal, this.modelSoFar, tokens);
        if (modelTotal) this.modelSoFar = modelTotal;
        const stopped = this.stopping;
        this.emit("turnEnd", stopped ? { ok: false, text: "stopped", tokens, subagentTokens: sub, costUsd } : { ok, text, failure, tokens, subagentTokens: sub, costUsd });
        if (stopped) this.settleStop(); else this.nextInTurn = 0;
        return;
      }
      default:
        return;
    }
  }
}

/**
 * A path in Claude Code's permission rule form for an absolute path: `//` and the path with forward slashes; on
 * Windows the drive letter as the first segment (`C:\\x\\y` is `//c/x/y`), as Claude Code normalizes Windows paths
 * to that form before matching.
 */
function claudeAbsolutePath(path: string): string {
  const p = path.replaceAll("\\", "/").replace(/\/+$/, "");
  const drive = /^([A-Za-z]):(\/.*)?$/.exec(p);
  return drive ? `//${drive[1]!.toLowerCase()}${drive[2] ?? ""}` : `/${p.startsWith("/") ? p : `/${p}`}`;
}

/** The deny rules that keep a worker's file tools out of the project's .nexus folder (its absolute path). */
export function nexusDenyRules(nexusDir: string): string[] {
  const p = claudeAbsolutePath(nexusDir);
  return [`Edit(${p}/**)`, `Write(${p}/**)`];
}

/**
 * What Claude Code's refusal of a start says of the session's conversation (2.1.323, probed 2026-11-15): `--resume` of
 * an id it never saved exits 1 with "No conversation found with session ID: <id>" (none: false); `--session-id` of a
 * saved one with "Error: Session ID <id> is already in use." (there is one: true). Anything else: undefined.
 */
function savedFromRefusal(stderr: string): boolean | undefined {
  if (/No conversation found with session ID/i.test(stderr)) return false;
  if (/Session ID \S+ is already in use/i.test(stderr)) return true;
  return undefined;
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

function describeTool(name: string, input: Record<string, any> = {}): string {
  const first = (...keys: string[]) => keys.map((k) => input[k]).find((v) => typeof v === "string") as string | undefined;
  const detail = first("command", "file_path", "path", "pattern", "url", "description", "prompt", "query") ?? "";
  return clip(`${name}${detail ? `: ${detail.replace(/\s+/g, " ")}` : ""}`, 300);
}
