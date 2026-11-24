// What the CLI knows, read from `nexus help` (main.ts's run(), in this process), and
// the check of one command line against it: its command, subcommand and flags (queue DOC). Shared by protocol-cli.test.ts
// (the lines of docs/protocol/cli.md) and instruction-commands.test.ts (the commands the agents' texts give).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliOut } from "./run-cli.ts";

/** The text of `nexus help`, run without a session or a project. */
export async function helpText(): Promise<string> {
  const cwd = mkdtempSync(join(tmpdir(), "nexus-cli-usage-")); // no .nexus here
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.NEXUS_SESSION; delete env.NEXUS_DIR;
  return cliOut(["help"], { cwd, env });
}

// ---------------------------------------------------------------- reading lines

/**
 * Splits a command line into tokens: a quoted string is one token, and so is a placeholder of several words
 * (`<what to fix>`); brackets are tokens of their own. `prose`: an apostrophe is a letter (`the queue's state`), no quote.
 */
export function tokens(s: string, prose = false): string[] {
  const out: string[] = [];
  const re = prose
    ? /"[^"]*"|<[^<>\s][^<>]* [^<>]*>|[[\]()]|[^\s[\]()"]+(?:"[^"]*"[^\s[\]()"]*)*/g
    : /"[^"]*"|'[^']*'|<[^<>\s][^<>]* [^<>]*>|[[\]()]|[^\s[\]()"']+(?:"[^"]*"[^\s[\]()"']*)*/g;
  for (const m of s.matchAll(re)) out.push(m[0]);
  return out;
}

/** The line without its comment: a `#` after whitespace, outside quotes (`tags.md#2026-11-14` is no comment). */
export function stripComment(s: string): string {
  let quote: string | undefined;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quote) { if (c === quote) quote = undefined; continue; }
    if (c === '"' || c === "'") quote = c;
    else if (c === "#" && (i === 0 || /\s/.test(s[i - 1]!))) return s.slice(0, i).trimEnd();
  }
  return s.trimEnd();
}

/** Splits on ` | ` outside brackets, parentheses and quotes. */
export function splitTopLevel(s: string): string[] {
  const parts: string[] = [];
  let depth = 0, quote: string | undefined, from = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quote) { if (c === quote) quote = undefined; continue; }
    if (c === '"' || c === "'") quote = c;
    else if (c === "[" || c === "(") depth++;
    else if (c === "]" || c === ")") depth--;
    else if (c === "|" && depth === 0 && s[i - 1] === " " && s[i + 1] === " ") { parts.push(s.slice(from, i).trim()); from = i + 1; }
  }
  parts.push(s.slice(from).trim());
  return parts;
}

/** A word of a usage or a line (`run`, `start|pause`); anything else (`<step>`, `W3`, `"..."`) stands for a value. */
export const LITERAL = /^[a-z][a-z0-9-]*(\|[a-z][a-z0-9-]*)*$/;
const isPlaceholder = (t: string) => !LITERAL.test(t);

/**
 * The positional head of a command line: the tokens after `nexus` up to the first flag, bracket, parenthesis or
 * here-string (`<<<`).
 */
export function head(cmd: string): string[] {
  const out: string[] = [];
  for (const t of tokens(cmd).slice(1)) {
    if (t.startsWith("-") || t === "[" || t === "(" || t === "<<<" || t === "|") break;
    out.push(t);
  }
  return out;
}

/** The flags a line names (`--name`, also `--name=value`), quoted text left out. */
export function flags(s: string): Set<string> {
  const plain = s.replace(/"[^"]*"|'[^']*'/g, '""');
  return new Set([...plain.matchAll(/(?<![\w-])--([a-z][a-z0-9-]*)/g)].map((m) => `--${m[1]}`));
}

// ---------------------------------------------------------------- what the CLI knows

interface Usage { text: string; head: string[]; flags: Set<string> }
export interface Cli { usages: Usage[]; global: Set<string>; topics: Set<string> }

export function readHelp(help: string): Cli {
  const usages: Usage[] = [];
  const global = new Set<string>();
  const topics = new Set<string>();
  let current: Usage | undefined, inTopics = false;
  for (const line of help.split(/\r?\n/)) {
    const indent = line.length - line.trimStart().length;
    if (/^Topics \(nexus help <topic>\):/.test(line)) { inTopics = true; current = undefined; continue; }
    if (inTopics) { const m = /^ {2}([a-z]+) {2,}/.exec(line); if (m) topics.add(m[1]!); continue; }
    if (/^ {2}nexus /.test(line)) {
      const text = line.trim().replace(/ {3,}.*$/, ""); // a description after the usage, three spaces on
      current = { text, head: head(text), flags: flags(line) };
      usages.push(current);
    } else if (current && indent > 2) {
      for (const f of flags(line)) current.flags.add(f); // a continuation: more of the same command
    } else {
      current = undefined;
      for (const f of flags(line)) global.add(f); // a heading or a note for all: `--session`, `--queue`
    }
  }
  return { usages, global, topics };
}

// ---------------------------------------------------------------- checking a line

/** Why a usage does not fit a command line's head, or undefined when it fits. */
function headMismatch(u: Usage, h: string[]): string | undefined {
  const lastLiteral = u.head.reduce((n, t, i) => (isPlaceholder(t) ? n : i), -1);
  if (h.length <= lastLiteral) return `"${u.text}" needs "${u.head.slice(0, lastLiteral + 1).join(" ")}"`;
  for (let i = 0; i < Math.min(h.length, u.head.length); i++) {
    const want = u.head[i]!, got = h[i]!;
    if (isPlaceholder(want)) continue;
    if (isPlaceholder(got)) return `"${got}" where "${u.text}" has ${want}`;
    const allowed = new Set(want.split("|"));
    const bad = got.split("|").filter((a) => !allowed.has(a));
    if (bad.length) return `${bad.join(", ")} where "${u.text}" has ${want}`;
  }
  const rest = u.text.slice(u.text.indexOf(u.head.at(-1) ?? "nexus"));
  // A placeholder that is a flag's value (`[--queue <id>]`) is not a positional argument the usage takes.
  const takesMore = (u.head.length > 0 && isPlaceholder(u.head.at(-1)!)) || /</.test(rest.replace(/--[\w-]+ <[^>]*>/g, ""));
  if (h.length > u.head.length && !takesMore) return `"${u.text}" takes no "${h.slice(u.head.length).join(" ")}"`;
  return undefined;
}

/** The problems of one command (one alternative of a doc line); empty when it matches a usage of the CLI. */
export function check(cli: Cli, cmd: string): string[] {
  if (!cmd.startsWith("nexus ")) return [`not a nexus command, nor a comment or a continuation`];
  const h = head(cmd);
  const name = h[0];
  if (!name) return ["no command"];
  const candidates = cli.usages.filter((u) => u.head[0] === name);
  if (!candidates.length) return [`unknown command "nexus ${name}"`];
  const used = flags(cmd);
  // Reported when nothing fits: the usage whose head fits with the fewest problems, else the first head that does not fit.
  let fewest: string[] | undefined, mismatch: string | undefined;
  for (const u of candidates) {
    const why = headMismatch(u, h);
    if (why) { mismatch ??= why; continue; }
    const problems = [...used].filter((f) => !u.flags.has(f) && !cli.global.has(f)).map((f) => `${f} is not a flag of "${u.text}"`);
    if (name === "help") {
      for (const t of h.slice(1).flatMap((x) => x.split("|"))) if (!t.startsWith("<") && !cli.topics.has(t)) problems.push(`"${t}" is not a help topic`);
    }
    if (!problems.length) return [];
    if (!fewest || problems.length < fewest.length) fewest = problems;
  }
  return fewest ?? [mismatch ?? `no usage of "nexus ${name}" fits`];
}
