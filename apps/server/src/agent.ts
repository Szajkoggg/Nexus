// What the engine and the orchestrator need from a running agent, whatever its runtime (Claude Code, Codex).
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { EventEmitter } from "node:events";
import { nexusHome } from "@nexus/protocol";
import { withoutHandover } from "./handover.ts";

export type Priority = "now" | "next" | "later";

/** Facts read from the runtime's stream, for the session's runtime record. */
export interface StreamFacts {
  model?: string;
  contextTokens?: number;
  contextWindow?: number;
  costUsd?: number;
  /** The subscription's windows, by name (Claude: five_hour, seven_day; Codex: codex_7d and the like). */
  usage?: Record<string, { utilization: number; resets_at?: string; status?: string }>;
  /** The runtime's own id for the session, once it is known (Codex assigns its thread id). */
  nativeId?: string;
  /**
   * The runtime has saved the session's conversation (true), or says it has none (false). Claude Code saves it when it
   * reads the session's first message (probed 2026-11-15): its first turn's start shows that, and the CLI's refusal of
   * a start names either case (docs/design/engine.md, "When Claude Code saves a conversation").
   */
  saved?: boolean;
  /** The process was replaced by a new one (a start Claude Code refused, tried again): its id. */
  pid?: number;
}

/** What the agent did, condensed for the dashboard. `retry`: the runtime retries a request by itself. */
export interface ActivityItem { kind: "turn_start" | "text" | "tool" | "tool_error" | "turn_end" | "error" | "retry"; text: string }

/**
 * Why a turn failed, read from the runtime's codes. `passing`: worth trying the turn again later (overloaded, a short
 * rate limit, the network). `lasting`: needs the user (authentication, an invalid request, a refusal, anything
 * unknown). `usage`: a subscription limit with a known reset time (`resetsAt`). See docs/design/engine.md, "Failures".
 */
/**
 * One turn's tokens, the same four for both runtimes. `input` is the input not read from the cache (Claude Code's
 * input_tokens; Codex's inputTokens less cachedInputTokens); `cacheRead` what was (cache_read_input_tokens;
 * cachedInputTokens); `cacheCreation` what was written to it (cache_creation_input_tokens; cacheWriteInputTokens);
 * `output` includes any thinking (output_tokens; outputTokens).
 */
export interface TurnTokens { input: number; output: number; cacheRead: number; cacheCreation: number }

export interface TurnFailure { kind: "passing" | "lasting" | "usage"; code: string; text: string; resetsAt?: string }

/**
 * An HTTP 403 page from Cloudflare (or a like edge in front of the API: a block or challenge of this request), which
 * the runtimes report as an authentication failure though no credential is wrong. It passes: the same request goes
 * through later. Seen on 2026-11-13 (queue N7, Claude Code): `authentication_failed`, "Failed to authenticate. API
 * Error: 403 Attention Required! | Cloudflare"; a resume went on fine. Both a 403 and the edge's mark must be there, so
 * a real credential failure (401, "Invalid API key", an expired token) stays lasting.
 */
export function edgeBlock(text: string): boolean {
  return /\b403\b/.test(text) && /cloudflare|attention required|cf-ray|just a moment\.\.\.|akamai/i.test(text);
}

/** The code of a failure that is an edge's 403 (see edgeBlock). */
export const EDGE_BLOCK = "edge_block_403";

/** An action the agent wanted but was refused, as the runtime reported it (see Refusal in the protocol). */
export interface RefusalItem { by: "permissions" | "nexus" | "auto_review"; tool: string; input: string; reason?: string; ref?: string }

/** A tool's input in short: its command, path or query, else its JSON, clipped. */
export function shortInput(input: unknown, max = 300): string {
  const o = (input ?? {}) as Record<string, unknown>;
  const key = ["command", "file_path", "path", "pattern", "url", "query", "description", "prompt"].find((k) => typeof o[k] === "string");
  const s = key ? String(o[key]) : typeof input === "string" ? input : JSON.stringify(input ?? "");
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? one.slice(0, max - 1) + "…" : one;
}

export interface AgentEvents {
  /** For the activity log: short forms (a text is clipped). */
  activity: [ActivityItem];
  /** A text the agent wrote, whole: what a chat shows. */
  message: [string];
  facts: [StreamFacts];
  /** An action the runtime (or Nexus for it) refused. */
  refusal: [RefusalItem];
  /** `ok` false with no failure: the turn was interrupted (Nexus asked for it). */
  /**
   * `tokens` and `costUsd`: this turn's alone (never a running total), when the runtime said; `costUsd` only where it
   * reports one (Claude Code), and not for the first turn of a resumed process (its running total starts with the
   * earlier turns'). `subagentTokens`: what its sub-agents used within the turn, apart from `tokens` (the main loop's);
   * Claude Code only, and not for the first turn of a resumed process (docs/design/usage.md, "Sub-agent tokens").
   */
  turnEnd: [{ ok: boolean; text: string; failure?: TurnFailure; tokens?: TurnTokens; subagentTokens?: TurnTokens; costUsd?: number }];
  /** The work the agent left running in the background changed (see AgentProcess.background); emitted on every change. */
  background: [readonly string[]];
  /**
   * The runtime compacted the conversation's context (AgentProcess.compact, or by itself): its tokens before and after,
   * where the runtime says (Claude Code's compact_boundary does; Codex's contextCompaction item does not).
   */
  compacted: [{ before?: number; after?: number }];
  /** The moment after a turn's end in which the runtime may still start a turn of its own is over (AgentProcess.settling). */
  settled: [];
  exit: [number | null];
}

export interface AgentProcess extends EventEmitter<AgentEvents> {
  /** `working` from a sent turn (or one the runtime starts by itself) until it ends. */
  state: "working" | "idle" | "exited";
  readonly pid?: number;
  /**
   * What the agent started that runs on outside its turns (a background command, a sub-agent), one short description
   * each; empty when nothing does. Read live from the runtime's stream (docs/design/engine.md, "Background work"): Claude Code's
   * background_tasks_changed; Codex's command items still open after their turn and its sub-agents not yet completed.
   * Optional: a stand-in without it has none.
   */
  readonly background?: readonly string[];
  /**
   * Idle, but the runtime may still start a turn of its own: messages were sent into the turn that just ended, and one
   * that reached the runtime after its turn was over runs as a turn after it (Claude Code), with nothing in the stream
   * to say which it was until that turn starts. `settled` is emitted when the moment is over without one. Optional: a
   * stand-in without it never settles.
   */
  readonly settling?: boolean;
  /**
   * Its process has exited and `exit` is not emitted yet: the runtime's last output is still being read (Codex reads
   * stdout up to EXIT_DRAIN_MS after the exit event, so that a turn's end the process wrote comes before its exit).
   * `state` is still what the last line left (`idle` after a drained turn's end), but nothing can reach the process:
   * `send` and `compact` throw. A caller about to send treats it as gone; what its exit decides (a crash's retry)
   * waits for `exit` (queue CXD; docs/design/runtimes.md, "The window between a Codex exit and its handling").
   * Optional: a runtime without such a window never has it.
   */
  readonly exiting?: boolean;
  /** No priority: a new turn (after the running one). `next`: into the running turn. `now`: interrupt it. */
  send(text: string, priority?: Priority): void;
  /**
   * Stop the running turn (the user's stop button; decided 2026-11-14, queue CH4): a pure interrupt through the
   * runtime's own control, not a message. Nothing the turn writes after this is emitted (no `message`, no tool
   * activity), the process stays and goes idle, and messages sent into the turn that the runtime had not taken in go in
   * with the next turn. False when no turn runs.
   */
  stop(): boolean;
  /** End the session after the running turn. */
  close(): void;
  /** Another model or effort from the next turn on, where the runtime takes them per turn (Codex). */
  retune?(model?: string, effort?: string): void;
  /**
   * Compact the conversation's context now, through the runtime's own compaction (decided 2026-11-15, queue CC3): a
   * turn of its own, which ends as any turn does and emits `compacted` once done. False when a turn runs. Absent: the
   * runtime cannot (see COMPACTS).
   */
  compact?(): boolean;
  kill(): void;
  /** Worker-only boundary barrier: end descendants while preserving the runtime for the next step. */
  cleanup?(): Promise<void>;
}

/** A message can reach the process: it has not exited, nor is it exiting (AgentProcess.exiting; queue CXD). */
export function reachable(proc: AgentProcess): boolean {
  return proc.state !== "exited" && !proc.exiting;
}

/**
 * Which runtimes compact a conversation on request (probed 2026-11-15 with small models, queue CC3): Claude Code 2.1.323
 * takes "/compact" as a user message on its stream-json input; Codex 0.167.2 has thread/compact/start. A runtime
 * without it gets no Compact action.
 */
export const COMPACTS: Readonly<Record<"claude" | "codex", boolean>> = { claude: true, codex: true };

/** Everything both runtimes are started with. */
export interface AgentOptions {
  /** Only AgentHost sets this, for worker sessions. */
  ownProcesses?: boolean;
  cwd: string;
  model?: string;
  /** low, medium, high, xhigh (and max for Claude Code). */
  effort?: string;
  /** Instructions added to the runtime's own system prompt. */
  instructions?: string;
  env: Record<string, string>;
}

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "../../../packages/cli/bin/nexus.js");

/**
 * A `nexus` command that works from any shell an agent uses: a .cmd for cmd and PowerShell (npm's .ps1 shim is blocked
 * where scripts are disabled) and a POSIX script for Git Bash. Their directory goes first on the agents' PATH.
 */
function ensureShims(): string {
  const bin = join(nexusHome(), "bin");
  mkdirSync(bin, { recursive: true });
  const node = process.execPath;
  writeFileSync(join(bin, "nexus.cmd"), `@"${node}" "${CLI}" %*\r\n`, "utf8");
  writeFileSync(join(bin, "nexus"), `#!/bin/sh\nexec "${node.replaceAll("\\", "/")}" "${CLI.replaceAll("\\", "/")}" "$@"\n`, { encoding: "utf8", mode: 0o755 });
  return bin;
}

/**
 * The environment for an agent's process: ours, the session's variables, and the shims first on the PATH. Never
 * NEXUS_HANDOVER (main.ts already removes it from ours; this is the second guard): a test server an agent starts
 * would take the folder for its own.
 */
export function agentEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env = withoutHandover({ ...process.env, ...extra });
  const key = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  const sep = process.platform === "win32" ? ";" : ":";
  env[key] = `${ensureShims()}${sep}${env[key] ?? ""}`;
  return env;
}
