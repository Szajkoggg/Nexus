// Refused actions (sessions/<id>/refusals.jsonl), as the dashboard groups them and the allow rule it suggests. Pure
// and free of Node: the dashboard imports this module directly (`@nexus/protocol/refusals`).
import type { Refusal } from "./schemas.ts";

/** Tools whose input is a shell command: grouped and allowed by the command's first words. */
const SHELL = new Set(["Bash", "PowerShell", "command"]);

/**
 * A command's first words, the part an allow rule names: the program, and its subcommand when the second word reads
 * like one ("git push", "npm run", but "rm" for "rm -rf build", "node" for "node scripts/x.js").
 */
export function commandPrefix(command: string): string {
  const words = command.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "";
  return words[1] && /^[a-z][\w:-]*$/i.test(words[1]) ? `${words[0]} ${words[1]}` : words[0]!;
}

/** The kind a refusal is grouped under: its tool, and for a shell command the command's first words. */
export function refusalKind(r: Pick<Refusal, "runtime" | "tool" | "input">): { key: string; label: string } {
  const prefix = SHELL.has(r.tool) ? commandPrefix(r.input) : "";
  return { key: `${r.runtime}/${r.tool}/${prefix}`, label: prefix ? `${r.tool}: ${prefix}` : r.tool };
}

export interface RefusalGroup {
  key: string;
  label: string;
  runtime: Refusal["runtime"];
  tool: string;
  count: number;
  /** The newest refusal of the group. */
  latest: Refusal;
}

/** Refusals by kind, the most recent group first. */
export function groupRefusals(list: readonly Refusal[]): RefusalGroup[] {
  const groups = new Map<string, RefusalGroup>();
  for (const r of list) {
    const k = refusalKind(r);
    const g = groups.get(k.key);
    if (!g) groups.set(k.key, { key: k.key, label: k.label, runtime: r.runtime, tool: r.tool, count: 1, latest: r });
    else { g.count++; if (r.at > g.latest.at) g.latest = r; }
  }
  return [...groups.values()].sort((a, b) => b.latest.at.localeCompare(a.latest.at));
}

/**
 * The allow rule a Claude Code refusal suggests, in Claude Code's permission rule syntax: `Bash(git push:*)` for a
 * command, `Write(<path>)` for a file tool, `WebFetch(domain:<host>)` for a fetch, else the tool's name. Undefined
 * for Codex, whose own configuration Nexus does not write. The user edits it before it is saved.
 */
export function suggestAllowRule(r: Pick<Refusal, "runtime" | "tool" | "input">): string | undefined {
  if (r.runtime !== "claude") return undefined;
  const input = r.input.trim();
  if (SHELL.has(r.tool)) return input ? `${r.tool}(${commandPrefix(input)}:*)` : r.tool;
  if (["Read", "Write", "Edit", "MultiEdit", "NotebookEdit"].includes(r.tool) && input) return `${r.tool}(${input})`;
  if (r.tool === "WebFetch" && input) {
    try { return `WebFetch(domain:${new URL(input).hostname})`; } catch { return r.tool; }
  }
  return r.tool;
}

/** A rule as Claude Code reads it: a tool name, optionally with a specifier in parentheses, on one line. */
export function validAllowRule(rule: string): boolean {
  return rule.length <= 300 && /^[A-Za-z_][\w-]*(\(.+\))?$/.test(rule) && !/[\r\n]/.test(rule);
}
