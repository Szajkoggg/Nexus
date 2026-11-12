// What the engine and the orchestrator need from a running agent, whatever its runtime (Claude Code, Codex).
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { EventEmitter } from "node:events";
import { nexusHome } from "@nexus/protocol";

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
}

/** What the agent did, condensed for the dashboard. `retry`: the runtime retries a request by itself. */
export interface ActivityItem { kind: "turn_start" | "text" | "tool" | "tool_error" | "turn_end" | "error" | "retry"; text: string }

/**
 * Why a turn failed, read from the runtime's codes. `passing`: worth trying the turn again later (overloaded, a short
 * rate limit, the network). `lasting`: needs the user (authentication, an invalid request, a refusal, anything
 * unknown). `usage`: a subscription limit with a known reset time (`resetsAt`). See DESIGN.md, "Failures".
 */
export interface TurnFailure { kind: "passing" | "lasting" | "usage"; code: string; text: string; resetsAt?: string }

export interface AgentEvents {
  /** For the activity log: short forms (a text is clipped). */
  activity: [ActivityItem];
  /** A text the agent wrote, whole: what a chat shows. */
  message: [string];
  facts: [StreamFacts];
  /** `ok` false with no failure: the turn was interrupted (Nexus asked for it). */
  turnEnd: [{ ok: boolean; text: string; failure?: TurnFailure }];
  exit: [number | null];
}

export interface AgentProcess extends EventEmitter<AgentEvents> {
  /** `working` from a sent turn (or one the runtime starts by itself) until it ends. */
  state: "working" | "idle" | "exited";
  readonly pid?: number;
  /** No priority: a new turn (after the running one). `next`: into the running turn. `now`: interrupt it. */
  send(text: string, priority?: Priority): void;
  /** End the session after the running turn. */
  close(): void;
  kill(): void;
}

/** Everything both runtimes are started with. */
export interface AgentOptions {
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
export function ensureShims(): string {
  const bin = join(nexusHome(), "bin");
  mkdirSync(bin, { recursive: true });
  const node = process.execPath;
  writeFileSync(join(bin, "nexus.cmd"), `@"${node}" "${CLI}" %*\r\n`, "utf8");
  writeFileSync(join(bin, "nexus"), `#!/bin/sh\nexec "${node.replaceAll("\\", "/")}" "${CLI.replaceAll("\\", "/")}" "$@"\n`, { encoding: "utf8", mode: 0o755 });
  return bin;
}

/** The environment for an agent's process: ours, the session's variables, and the shims first on the PATH. */
export function agentEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  const key = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  const sep = process.platform === "win32" ? ";" : ":";
  env[key] = `${ensureShims()}${sep}${env[key] ?? ""}`;
  return env;
}
