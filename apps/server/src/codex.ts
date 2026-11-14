// A Codex session run by Nexus: `codex app-server` over stdio (JSON-RPC, one JSON object per line), one thread per
// session, signed in with the user's own ChatGPT login. The app-server is marked experimental: the methods used here
// (initialize, thread/start, thread/resume, turn/start, turn/steer, turn/interrupt) were checked against Codex CLI
// 0.167.2 with `codex app-server generate-ts`.
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { join, relative, resolve, isAbsolute } from "node:path";
import { EDGE_BLOCK, agentEnv, edgeBlock, shortInput, type AgentEvents, type RefusalItem, type TurnTokens, type AgentOptions, type AgentProcess, type Priority, type TurnFailure } from "./agent.ts";

export interface CodexOptions extends AgentOptions {
  /** The thread to resume; a new thread is started without one. */
  threadId?: string | null;
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
  approvalPolicy: "never" | "on-request" | "untrusted";
  /** Who decides requests to leave the sandbox: `auto_review` lets Codex's reviewer decide them by risk. */
  approvalsReviewer?: "user" | "auto_review" | "guardian_subagent";
  /**
   * Directories the sandbox may write besides the working directory: for a worktree, the project's .nexus and the
   * worktree's git paths (gitWritableRoots).
   */
  writableRoots: string[];
}

type Json = Record<string, any>;

/** CodexErrorInfo values worth trying again: overloaded, the server's own error, the network, a short rate limit. */
const CODEX_PASSING = new Set([
  "serverOverloaded", "internalServerError", "rateLimitExceeded", "httpConnectionFailed", "responseStreamConnectionFailed",
  "responseStreamDisconnected", "responseTooManyFailedAttempts",
]);

/**
 * Tells a failed turn's reason from its TurnError (`turn.error` of `turn/completed` with status `failed`). The shapes
 * are from `codex app-server generate-ts` of Codex 0.167.2: TurnError { message, codexErrorInfo, additionalDetails },
 * CodexErrorInfo a string or a one-key object (`{ httpConnectionFailed: { httpStatusCode } }`). A usage limit is a
 * `usage` failure when the last rate limits name a window that is full and when it resets; otherwise it is waited out
 * like a short rate limit.
 */
export function classifyCodexError(error: Json | null | undefined, resetsAt?: string): TurnFailure {
  const info = error?.codexErrorInfo;
  const code = typeof info === "string" ? info : info && typeof info === "object" ? Object.keys(info)[0] ?? "unknown" : "unknown";
  const full = String(error?.message ?? "the turn failed") + (error?.additionalDetails ? ` (${error.additionalDetails})` : "");
  const text = clip(full, 300);
  if (code === "usageLimitExceeded") return resetsAt && Date.parse(resetsAt) > Date.now() ? { kind: "usage", code, text, resetsAt } : { kind: "passing", code, text };
  if (CODEX_PASSING.has(code)) return { kind: "passing", code, text };
  // An edge's 403 page, however Codex codes it (no sample yet; "unauthorized" or "other" are the likely codes): it
  // passes. As a connection failure with httpStatusCode 403 it is passing already, by its code.
  if (edgeBlock(full)) return { kind: "passing", code: EDGE_BLOCK, text };
  return { kind: "lasting", code, text };
}

/**
 * What a sandboxed Codex needs to commit in a git worktree whose git directory lies outside it: the worktree's own git
 * directory (index, HEAD) and the repository's objects, refs and logs; nothing else of the repository's .git (not its
 * config or hooks). Empty for anything but a linked worktree (`git worktree add`) whose git directory lies outside
 * it. Checked live with Codex 0.167.2 on Windows: without these the commit fails on `index.lock`; with them it commits
 * without an escalation request.
 */
export function gitWritableRoots(cwd: string): string[] {
  let gitDir: string, common: string;
  try {
    const out = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    [gitDir, common] = out.trim().split(/\r?\n/).map((p) => resolve(p)) as [string, string];
  } catch { return []; }
  const rel = relative(resolve(cwd), gitDir);
  if (!rel || (!rel.startsWith("..") && !isAbsolute(rel))) return []; // the git directory is inside the working directory
  if (!common || gitDir === common) return []; // not a linked worktree: nothing probed, nothing given
  return [gitDir, ...["objects", "refs", "logs"].map((d) => join(common, d)).filter((d) => existsSync(d))];
}

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
  private queue: string[] = [];
  /**
   * Messages steered into the running turn that Codex has not recorded yet (no userMessage item for them): an
   * interrupt drops them (seen with Codex 0.167.2), so a stop carries them into the next turn.
   */
  private steered: string[] = [];
  /** A stop in progress (stop()): the turn's texts are not emitted; messages sent meanwhile wait in `afterStop`. */
  private stopping = false;
  private afterStop: string[] = [];
  /** Messages of a stopped turn it never took in: they go in with the next turn. */
  private carry: string[] = [];
  private lastStderr = "";
  /** What started items were about (their command or files), by item id: a declined item's request does not say. */
  private items = new Map<string, { tool: string; input: string }>();
  /** Refusals already reported, by item (or review) id: a declined request ends as a declined item too. */
  private refused = new Set<string>();
  /** What the thread started with (its model and effort): what a retune back to "the default" names. */
  private base: { model?: string; effort?: string } = {};
  /** Set by retune: every turn names its model and effort (Codex keeps a turn's override for later turns). */
  private turnValues?: { model?: string; effort?: string };
  /**
   * The thread's running token total (tokenUsage.total) as last reported, and its value when the running turn began:
   * a turn's tokens are the difference. A resumed thread's total starts with earlier turns this process never saw;
   * then the turn's `last` figures (one per model request) are summed instead.
   */
  private threadTotal: Json | undefined;
  private turnStartTotal: Json | undefined;
  private turnLast: Json[] = [];
  /** The last rate-limit windows: when a full one resets. */
  private limits: { usedPercent: number; resetsAt?: string }[] = [];

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
    // A write to a process that is exiting (killed, crashed) fails with EPIPE: its exit is handled, the write is moot.
    this.proc.stdin.on("error", () => {});
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
    if (this.stopping) { this.afterStop.push(text); return; }
    if (!this.threadId) { this.queue.push(text); this.state = "working"; return; } // the thread is still starting
    if (this.state === "idle") { this.startTurn(this.withCarry(text)); return; }
    if (priority === "next" && this.turnId) {
      this.steered.push(text);
      void this.request("turn/steer", { threadId: this.threadId, expectedTurnId: this.turnId, input: input(text) })
        .catch(() => { this.unsteer(text); this.queue.push(text); }); // the turn ended meanwhile: it becomes the next turn
      return;
    }
    if (priority === "now" && this.turnId) {
      this.queue.unshift(text);
      void this.request("turn/interrupt", { threadId: this.threadId, turnId: this.turnId }).catch(() => {});
      return;
    }
    this.queue.push(text);
  }

  /**
   * Stops the running turn with turn/interrupt. Messages steered into it that Codex had not recorded, and those
   * waiting for it to end, go in with the next turn (`carry`); one sent during the stop starts that turn at once.
   */
  stop(): boolean {
    if (this.state !== "working") return false;
    if (this.stopping) return true;
    this.stopping = true;
    if (this.turnId) void this.request("turn/interrupt", { threadId: this.threadId, turnId: this.turnId }).catch(() => {});
    return true;
  }

  /** A message with what a stopped turn left behind before it, as one input. */
  private withCarry(text: string): string {
    const all = [...this.carry, text];
    this.carry = [];
    return all.join("\n\n");
  }

  private unsteer(text: string): void {
    const i = this.steered.indexOf(text);
    if (i >= 0) this.steered.splice(i, 1);
  }

  /**
   * Another model or effort from the next turn on: Codex takes both per turn (turn/start, "for this turn and
   * subsequent turns"). One left out goes back to what the thread started with.
   */
  retune(model?: string, effort?: string): void {
    this.turnValues = { model: model ?? this.base.model, effort: effort ?? this.base.effort };
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
        // The thread's own sandbox settings carry the roots too; every turn also sends them in its sandbox policy.
        ...(o.sandbox === "workspace-write" && o.writableRoots.length ? { config: { "sandbox_workspace_write.writable_roots": o.writableRoots } } : {}),
      };
      const r = o.threadId
        ? await this.request("thread/resume", { threadId: o.threadId, ...common, excludeTurns: true })
        : await this.request("thread/start", common);
      this.threadId = r.thread.id as string;
      this.base = { model: (r.model as string | undefined) ?? o.model, effort: (r.reasoningEffort as string | null | undefined) ?? o.effort };
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
    const effort = this.turnValues ? this.turnValues.effort : o.effort;
    const model = this.turnValues?.model;
    void this.request("turn/start", {
      threadId: this.threadId, input: input(text), ...(sandboxPolicy ? { sandboxPolicy } : {}), ...(effort ? { effort } : {}), ...(model ? { model } : {}),
    })
      .then((r) => {
        this.turnId = r.turn?.id ?? this.turnId;
        // Stopped before the turn had an id: interrupted as soon as it has one.
        if (this.stopping && this.turnId && this.state === "working") void this.request("turn/interrupt", { threadId: this.threadId, turnId: this.turnId }).catch(() => {});
      })
      .catch((err) => {
        this.emit("activity", { kind: "error", text: `turn/start: ${(err as Error).message}` });
        this.state = "idle";
        this.emit("turnEnd", { ok: false, text: (err as Error).message, failure: { kind: "lasting", code: "turnStartRejected", text: clip((err as Error).message, 300) } });
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

  /** With approval policy `never` none should come; anything that does is declined and recorded as a refusal. */
  private serverRequest(m: Json): void {
    this.emit("activity", { kind: "tool_error", text: `Codex asked for ${m.method}; declined (Nexus runs unattended)` });
    const r = requestedAction(m.method, m.params ?? {}, this.items);
    this.refuse({ by: "nexus", ...r });
    const decision = /requestApproval$/.test(m.method) ? { result: { decision: "decline" } } : { error: { code: -32601, message: "not supported by Nexus" } };
    this.proc.stdin.write(JSON.stringify({ id: m.id, ...decision }) + "\n");
  }

  private notification(method: string, p: Json): void {
    switch (method) {
      case "turn/started":
        this.state = "working";
        this.turnId = p.turn?.id;
        this.turnStartTotal = this.threadTotal ?? (this.options.threadId ? undefined : {});
        this.turnLast = [];
        this.emit("activity", { kind: "turn_start", text: "turn started (codex)" });
        return;
      case "turn/completed": {
        const status = p.turn?.status as string;
        const ok = status === "completed";
        // Interrupted: Nexus asked for it (turn/interrupt). Anything else that is not completed is a failure.
        const failure = ok || status === "interrupted" ? undefined : classifyCodexError(p.turn?.error, this.fullWindowResets());
        this.turnId = undefined;
        this.state = "idle";
        const stopped = this.stopping;
        this.emit("activity", { kind: "turn_end", text: stopped ? "turn stopped by the user" : ok ? "turn ended" : failure ? `turn failed (${failure.kind}, ${failure.code}): ${failure.text}` : `turn ${status}` });
        const tokens = this.turnStartTotal !== undefined && this.threadTotal
          ? codexTokens(this.threadTotal, this.turnStartTotal)
          : this.turnLast.length ? this.turnLast.map((l) => codexTokens(l, {})).reduce(addTokens) : undefined;
        this.turnStartTotal = undefined;
        this.turnLast = [];
        if (stopped) {
          // What the stopped turn never took in goes in with the next turn; a message sent during the stop starts it.
          this.stopping = false;
          this.carry.push(...this.steered, ...this.queue);
          this.steered = [];
          this.queue = [];
          this.emit("turnEnd", { ok: false, text: "stopped", tokens });
          const after = this.afterStop;
          this.afterStop = [];
          if (after.length && this.state === "idle") this.startTurn(this.withCarry(after.join("\n\n")));
          return;
        }
        this.steered = [];
        this.emit("turnEnd", { ok, text: status, failure, tokens });
        const next = this.queue.shift();
        if (next !== undefined && this.state === "idle") this.startTurn(next);
        return;
      }
      case "item/started": {
        const it = p.item ?? {};
        const what = itemAction(it);
        if (what && it.id) this.items.set(it.id, what);
        if (it.type === "commandExecution") this.emit("activity", { kind: "tool", text: `Shell: ${clip(unwrap(it.command), 300)}` });
        if (it.type === "mcpToolCall") this.emit("activity", { kind: "tool", text: `MCP ${it.server}.${it.tool}` });
        if (it.type === "webSearch") this.emit("activity", { kind: "tool", text: `Web search: ${it.query ?? ""}` });
        return;
      }
      case "item/completed": {
        const it = p.item ?? {};
        // Declined without a request Nexus saw or a review it heard of (a refusal by Codex itself).
        if (it.status === "declined") this.refuse({ by: "auto_review", ...(itemAction(it) ?? { tool: it.type ?? "item", input: "" }), ref: it.id });
        if (it.id) this.items.delete(it.id);
        // A steered message Codex took into the turn: it is in the thread now, whatever happens to the turn.
        if (it.type === "userMessage") { const text = (it.content ?? []).find((c: Json) => c.type === "text")?.text; if (typeof text === "string") this.unsteer(text); }
        if (this.stopping) return; // what a stopped turn still writes is not shown
        if (it.type === "agentMessage" && it.text?.trim()) {
          this.emit("activity", { kind: "text", text: clip(it.text, 600) });
          this.emit("message", it.text);
        }
        if (it.type === "fileChange") this.emit("activity", { kind: "tool", text: `Edit: ${(it.changes ?? []).map((c: Json) => c.path).join(", ")}` });
        if (it.type === "commandExecution" && it.status === "failed") {
          this.emit("activity", { kind: "tool_error", text: clip(`exit ${it.exitCode}: ${it.aggregatedOutput ?? ""}`, 400) });
        }
        return;
      }
      case "thread/tokenUsage/updated": {
        const u = p.tokenUsage;
        if (u?.total) this.threadTotal = u.total;
        if (u?.last) this.turnLast.push(u.last);
        if (u) this.emit("facts", { contextTokens: u.last?.inputTokens, contextWindow: u.modelContextWindow ?? undefined });
        return;
      }
      case "item/autoApprovalReview/completed": {
        // [UNSTABLE in the schema] The auto reviewer's verdict on a request; denied or timed out is a refusal.
        const status = p.review?.status;
        if (status === "denied" || status === "timedOut") {
          this.refuse({ by: "auto_review", ...reviewedAction(p.action ?? {}), reason: clip(p.review?.rationale ?? (status === "timedOut" ? "the review timed out" : "denied"), 300), ref: p.targetItemId ?? p.reviewId });
        }
        return;
      }
      case "account/rateLimits/updated":
        this.rateLimits(p.rateLimits);
        return;
      case "error":
        // willRetry: Codex retries by itself; recorded, not counted against Nexus's own retries.
        if (p.willRetry) this.emit("activity", { kind: "retry", text: clip(`Codex retries a request: ${p.error?.message ?? "error"}`, 400) });
        else this.emit("activity", { kind: "error", text: clip(p.error?.message ?? "error", 400) });
        return;
      default:
        return;
    }
  }

  private rateLimits(r: Json | undefined): void {
    if (!r) return;
    const usage: Record<string, { utilization: number; resets_at?: string }> = {};
    this.limits = [];
    for (const w of [r.primary, r.secondary]) {
      if (!w) continue;
      this.limits.push({ usedPercent: w.usedPercent ?? 0, resetsAt: w.resetsAt ? new Date(w.resetsAt * 1000).toISOString() : undefined });
      usage[`codex_${duration(w.windowDurationMins)}`] = {
        utilization: (w.usedPercent ?? 0) / 100,
        resets_at: w.resetsAt ? new Date(w.resetsAt * 1000).toISOString() : undefined,
      };
    }
    if (Object.keys(usage).length) this.emit("facts", { usage });
  }

  /** Reports a refusal once per item: a request or a review first, the declined item after it. */
  private refuse(r: RefusalItem): void {
    if (r.ref) { if (this.refused.has(r.ref)) return; this.refused.add(r.ref); }
    this.emit("refusal", r);
  }

  /** When the latest full window (100 % used) resets, if the rate limits said so. */
  private fullWindowResets(): string | undefined {
    return this.limits.filter((w) => w.usedPercent >= 100 && w.resetsAt).map((w) => w.resetsAt!).sort().at(-1);
  }
}

/** What an item does, in short: a command or the files of a change. */
function itemAction(it: Json): { tool: string; input: string } | undefined {
  if (it.type === "commandExecution") return { tool: "command", input: clip(unwrap(it.command), 300) };
  if (it.type === "fileChange") return { tool: "file_change", input: clip((it.changes ?? []).map((c: Json) => c.path).join(", "), 300) };
  if (it.type === "mcpToolCall") return { tool: "mcp", input: `${it.server}.${it.tool}` };
  return undefined;
}

/**
 * What an approval request asked for (ServerRequest of generate-ts, Codex 0.167.2): the v2 requests
 * item/commandExecution|fileChange|permissions/requestApproval and the older execCommandApproval and
 * applyPatchApproval. Anything else Codex asks (user input, an MCP elicitation) is named by its method.
 */
function requestedAction(method: string, p: Json, items: Map<string, { tool: string; input: string }>): Omit<RefusalItem, "by"> {
  const known = p.itemId ? items.get(p.itemId) : undefined;
  const reason = p.reason ? clip(String(p.reason), 300) : undefined;
  const ref = p.itemId ?? p.callId ?? p.approvalId ?? undefined;
  switch (method) {
    case "item/commandExecution/requestApproval": return { tool: "command", input: p.command ? clip(unwrap(p.command), 300) : known?.input ?? "", reason, ref };
    case "item/fileChange/requestApproval": return { tool: "file_change", input: known?.input ?? p.grantRoot ?? "", reason, ref };
    case "item/permissions/requestApproval": return { tool: "permissions", input: shortInput(p.permissions), reason, ref };
    case "execCommandApproval": return { tool: "command", input: clip(unwrap(p.command), 300), reason, ref };
    case "applyPatchApproval": return { tool: "file_change", input: clip(Object.keys(p.fileChanges ?? {}).join(", "), 300), reason, ref };
    default: return { tool: method, input: shortInput(p.message ?? p.questions ?? ""), ref };
  }
}

/** What the auto reviewer judged (GuardianApprovalReviewAction). */
function reviewedAction(a: Json): { tool: string; input: string } {
  switch (a.type) {
    case "command": return { tool: "command", input: clip(unwrap(a.command), 300) };
    case "execve": return { tool: "command", input: clip([a.program, ...(a.argv ?? []).slice(1)].join(" "), 300) };
    case "applyPatch": return { tool: "file_change", input: clip((a.files ?? []).join(", "), 300) };
    case "networkAccess": return { tool: "network", input: `${a.host}${a.port ? `:${a.port}` : ""}` };
    case "mcpToolCall": return { tool: "mcp", input: `${a.server}.${a.toolName}` };
    case "requestPermissions": return { tool: "permissions", input: shortInput(a.permissions) };
    case "writeStdin": return { tool: "stdin", input: clip(String(a.stdin ?? ""), 300) };
    default: return { tool: String(a.type ?? "action"), input: shortInput(a) };
  }
}

/**
 * Codex's token breakdown (TokenUsageBreakdown: inputTokens including cachedInputTokens, cacheWriteInputTokens,
 * outputTokens including reasoningOutputTokens) as the four figures, less a baseline (an earlier running total).
 */
export function codexTokens(now: Json, before: Json): TurnTokens {
  const d = (k: string) => Math.max(0, (Number(now[k]) || 0) - (Number(before[k]) || 0));
  return { input: Math.max(0, d("inputTokens") - d("cachedInputTokens")), output: d("outputTokens"), cacheRead: d("cachedInputTokens"), cacheCreation: d("cacheWriteInputTokens") };
}
const addTokens = (a: TurnTokens, b: TurnTokens): TurnTokens => ({ input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheCreation: a.cacheCreation + b.cacheCreation });

/**
 * A message's input items: its text, and each picture uploaded for a chat message (a line that is the absolute path of
 * a file under a `.nexus/uploads/` folder, PROTOCOL.md "Uploads") as a `localImage` item beside it. Codex does not
 * open a picture from a path in the text (probed live, Codex 0.167.2 with gpt-6-luna, a partner's sandbox: "I can't
 * access that image path"); given the item, it sees the picture. The path stays in the text, so the chat and Claude
 * read the same message.
 */
export function input(text: string): Json[] {
  return [{ type: "text", text, text_elements: [] }, ...uploadedPictures(text).map((path) => ({ type: "localImage", path }))];
}

// \x5c is the backslash: Windows paths come with either separator.
const UPLOAD_LINE = /^(?:[A-Za-z]:[\x5c/]|\/).*[\x5c/]\.nexus[\x5c/]uploads[\x5c/][^\x5c/]+\.(?:png|jpe?g|webp|gif)$/i;

/** The pictures a message carries: its lines that are an uploaded picture's absolute path, of files that exist, once each. */
export function uploadedPictures(text: string): string[] {
  const paths = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => UPLOAD_LINE.test(l) && existsSync(l));
  return [...new Set(paths)];
}
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const duration = (mins?: number | null) => (!mins ? "window" : mins % 1440 === 0 ? `${mins / 1440}d` : mins % 60 === 0 ? `${mins / 60}h` : `${mins}m`);

/** Codex shows a command with its shell wrapper: `"…powershell.exe" -Command '…'`. The dashboard wants the command. */
function unwrap(command: unknown): string {
  const c = Array.isArray(command) ? command.join(" ") : String(command ?? "");
  const m = /-Command\s+'([\s\S]*)'\s*$/.exec(c) ?? /-Command\s+"([\s\S]*)"\s*$/.exec(c) ?? /-c\s+'([\s\S]*)'\s*$/.exec(c);
  return (m ? m[1]! : c).replace(/\s+/g, " ").trim();
}
