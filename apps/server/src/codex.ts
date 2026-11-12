// A Codex session run by Nexus: `codex app-server` over stdio (JSON-RPC, one JSON object per line), one thread per
// session, signed in with the user's own ChatGPT login. The app-server is marked experimental: the methods used here
// (initialize, thread/start, thread/resume, turn/start, turn/steer, turn/interrupt) were checked against Codex CLI
// 0.167.2 with `codex app-server generate-ts`.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { agentEnv, type AgentEvents, type AgentOptions, type AgentProcess, type Priority } from "./agent.ts";

export interface CodexOptions extends AgentOptions {
  /** The thread to resume; a new thread is started without one. */
  threadId?: string | null;
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
  approvalPolicy: "never" | "on-request" | "untrusted";
  /** Who decides requests to leave the sandbox: `auto_review` lets Codex's reviewer decide them by risk. */
  approvalsReviewer?: "user" | "auto_review" | "guardian_subagent";
  /** Directories the sandbox may write besides the working directory (the project's .nexus, for a worktree). */
  writableRoots: string[];
}

type Json = Record<string, any>;

export class CodexSession extends EventEmitter<AgentEvents> implements AgentProcess {
  state: "working" | "idle" | "exited" = "idle";
  readonly pid?: number;
  private readonly options: CodexOptions;
  private proc: ChildProcessWithoutNullStreams;
  private buffer = "";
  private nextId = 0;
  private readonly pending = new Map<number, { resolve: (v: Json) => void; reject: (e: Error) => void; method: string }>();
  private threadId?: string;
  private turnId?: string;
  /** Messages waiting for the running turn to end (or for the thread to be ready). */
  private readonly queue: string[] = [];
  private lastStderr = "";

  constructor(options: CodexOptions) {
    super();
    this.options = options;
    const bin = process.env.NEXUS_CODEX ?? "codex";
    const script = /\.(m?[jt]s)$/.test(bin);
    const args = ["app-server"];
    this.proc = spawn(script ? process.execPath : bin, script ? [bin, ...args] : args, {
      cwd: options.cwd, env: agentEnv(options.env), stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    });
    this.pid = this.proc.pid;
    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (d: string) => this.read(d));
    this.proc.stderr.setEncoding("utf8");
    this.proc.stderr.on("data", (d: string) => { this.lastStderr = (this.lastStderr + d).slice(-2000); });
    this.proc.on("error", (err) => this.emit("activity", { kind: "error", text: `could not start codex: ${err.message}` }));
    this.proc.on("exit", (code) => {
      this.state = "exited";
      for (const p of this.pending.values()) p.reject(new Error("codex exited"));
      if (code && this.lastStderr.trim()) this.emit("activity", { kind: "error", text: this.lastStderr.trim().slice(-500) });
      this.emit("exit", code);
    });
    void this.open();
  }

  send(text: string, priority?: Priority): void {
    if (this.state === "exited") throw new Error("the session's process has exited");
    if (!this.threadId) { this.queue.push(text); this.state = "working"; return; } // the thread is still starting
    if (this.state === "idle") { this.startTurn(text); return; }
    if (priority === "next" && this.turnId) {
      void this.request("turn/steer", { threadId: this.threadId, expectedTurnId: this.turnId, input: input(text) })
        .catch(() => this.queue.push(text));                     // the turn ended meanwhile: it becomes the next turn
      return;
    }
    if (priority === "now" && this.turnId) {
      this.queue.unshift(text);
      void this.request("turn/interrupt", { threadId: this.threadId, turnId: this.turnId }).catch(() => {});
      return;
    }
    this.queue.push(text);
  }

  close(): void {
    const end = () => { if (this.state !== "exited") this.proc.stdin.end(); };
    if (this.state === "working") this.once("turnEnd", end); else end();
  }

  kill(): void { if (this.state !== "exited") this.proc.kill(); }

  // ---------------------------------------------------------------- protocol

  private async open(): Promise<void> {
    try {
      await this.request("initialize", { clientInfo: { name: "nexus", title: "Nexus", version: "0.1.0" }, capabilities: { experimentalApi: true, requestAttestation: false } });
      this.notify("initialized", {});
      const o = this.options;
      const common = {
        cwd: o.cwd, model: o.model ?? null, sandbox: o.sandbox, approvalPolicy: o.approvalPolicy,
        ...(o.approvalsReviewer ? { approvalsReviewer: o.approvalsReviewer } : {}),
        developerInstructions: o.instructions ?? null,
      };
      const r = o.threadId
        ? await this.request("thread/resume", { threadId: o.threadId, ...common, excludeTurns: true })
        : await this.request("thread/start", common);
      this.threadId = r.thread.id as string;
      this.emit("facts", { nativeId: this.threadId, model: r.model });
      void this.request("account/rateLimits/read", {}).then((x) => this.rateLimits(x.rateLimits), () => {});
      const first = this.queue.shift();
      if (first !== undefined) this.startTurn(first); else this.state = "idle";
    } catch (err) {
      this.emit("activity", { kind: "error", text: `codex: ${(err as Error).message}` });
      this.kill();
    }
  }

  private startTurn(text: string): void {
    this.state = "working";
    const o = this.options;
    const sandboxPolicy = o.sandbox === "workspace-write"
      ? { type: "workspaceWrite", writableRoots: o.writableRoots, networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false }
      : undefined;
    void this.request("turn/start", {
      threadId: this.threadId, input: input(text), ...(sandboxPolicy ? { sandboxPolicy } : {}), ...(o.effort ? { effort: o.effort } : {}),
    })
      .then((r) => { this.turnId = r.turn?.id ?? this.turnId; })
      .catch((err) => {
        this.emit("activity", { kind: "error", text: `turn/start: ${(err as Error).message}` });
        this.state = "idle";
        this.emit("turnEnd", { ok: false, text: (err as Error).message });
      });
  }

  private request(method: string, params: Json): Promise<Json> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.proc.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }

  private notify(method: string, params: Json): void { this.proc.stdin.write(JSON.stringify({ method, params }) + "\n"); }

  private read(chunk: string): void {
    this.buffer += chunk;
    let i: number;
    while ((i = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, i).trim();
      this.buffer = this.buffer.slice(i + 1);
      if (!line) continue;
      let m: Json;
      try { m = JSON.parse(line); } catch { continue; }
      if (m.id !== undefined && !m.method) {
        const p = this.pending.get(m.id);
        if (!p) continue;
        this.pending.delete(m.id);
        if (m.error) p.reject(new Error(`${p.method}: ${m.error.message ?? JSON.stringify(m.error)}`)); else p.resolve(m.result ?? {});
      } else if (m.id !== undefined && m.method) {
        this.serverRequest(m);
      } else if (m.method) {
        this.notification(m.method, m.params ?? {});
      }
    }
  }

  /** With approval policy `never` none should come; anything that does is declined and recorded. */
  private serverRequest(m: Json): void {
    this.emit("activity", { kind: "tool_error", text: `Codex asked for ${m.method}; declined (Nexus runs unattended)` });
    const decision = /requestApproval$/.test(m.method) ? { result: { decision: "decline" } } : { error: { code: -32601, message: "not supported by Nexus" } };
    this.proc.stdin.write(JSON.stringify({ id: m.id, ...decision }) + "\n");
  }

  private notification(method: string, p: Json): void {
    switch (method) {
      case "turn/started":
        this.state = "working";
        this.turnId = p.turn?.id;
        this.emit("activity", { kind: "turn_start", text: "turn started (codex)" });
        return;
      case "turn/completed": {
        const status = p.turn?.status as string;
        const ok = status === "completed";
        this.turnId = undefined;
        this.state = "idle";
        this.emit("activity", { kind: "turn_end", text: ok ? "turn ended" : `turn ${status}${p.turn?.error?.message ? `: ${clip(p.turn.error.message, 300)}` : ""}` });
        this.emit("turnEnd", { ok, text: status });
        const next = this.queue.shift();
        if (next !== undefined && this.state === "idle") this.startTurn(next);
        return;
      }
      case "item/started": {
        const it = p.item ?? {};
        if (it.type === "commandExecution") this.emit("activity", { kind: "tool", text: `Shell: ${clip(unwrap(it.command), 300)}` });
        if (it.type === "mcpToolCall") this.emit("activity", { kind: "tool", text: `MCP ${it.server}.${it.tool}` });
        if (it.type === "webSearch") this.emit("activity", { kind: "tool", text: `Web search: ${it.query ?? ""}` });
        return;
      }
      case "item/completed": {
        const it = p.item ?? {};
        if (it.type === "agentMessage" && it.text?.trim()) this.emit("activity", { kind: "text", text: clip(it.text, 600) });
        if (it.type === "fileChange") this.emit("activity", { kind: "tool", text: `Edit: ${(it.changes ?? []).map((c: Json) => c.path).join(", ")}` });
        if (it.type === "commandExecution" && it.status === "failed") {
          this.emit("activity", { kind: "tool_error", text: clip(`exit ${it.exitCode}: ${it.aggregatedOutput ?? ""}`, 400) });
        }
        return;
      }
      case "thread/tokenUsage/updated": {
        const u = p.tokenUsage;
        if (u) this.emit("facts", { contextTokens: u.last?.inputTokens, contextWindow: u.modelContextWindow ?? undefined });
        return;
      }
      case "account/rateLimits/updated":
        this.rateLimits(p.rateLimits);
        return;
      case "error":
        if (!p.willRetry) this.emit("activity", { kind: "error", text: clip(p.error?.message ?? "error", 400) });
        return;
      default:
        return;
    }
  }

  private rateLimits(r: Json | undefined): void {
    if (!r) return;
    const usage: Record<string, { utilization: number; resets_at?: string }> = {};
    for (const w of [r.primary, r.secondary]) {
      if (!w) continue;
      usage[`codex_${duration(w.windowDurationMins)}`] = {
        utilization: (w.usedPercent ?? 0) / 100,
        resets_at: w.resetsAt ? new Date(w.resetsAt * 1000).toISOString() : undefined,
      };
    }
    if (Object.keys(usage).length) this.emit("facts", { usage });
  }
}

const input = (text: string) => [{ type: "text", text, text_elements: [] }];
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const duration = (mins?: number | null) => (!mins ? "window" : mins % 1440 === 0 ? `${mins / 1440}d` : mins % 60 === 0 ? `${mins / 60}h` : `${mins}m`);

/** Codex shows a command with its shell wrapper: `"…powershell.exe" -Command '…'`. The dashboard wants the command. */
function unwrap(command: unknown): string {
  const c = Array.isArray(command) ? command.join(" ") : String(command ?? "");
  const m = /-Command\s+'([\s\S]*)'\s*$/.exec(c) ?? /-Command\s+"([\s\S]*)"\s*$/.exec(c) ?? /-c\s+'([\s\S]*)'\s*$/.exec(c);
  return (m ? m[1]! : c).replace(/\s+/g, " ").trim();
}
