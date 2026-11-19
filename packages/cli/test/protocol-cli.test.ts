// The `nexus` lines of docs/protocol/cli.md's "The `nexus` CLI" block against the CLI itself (queue DOC): every command and
// subcommand there exists, and every flag a line uses belongs to that command. What the CLI knows is read from
// `nexus help` (bin/nexus.js), as help.test.ts does: main.ts runs when it is loaded, so it is not imported.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "../bin/nexus.js");
const PROTOCOL = join(HERE, "../../../docs/protocol/cli.md");

/** Lines of the block allowed not to match the CLI, by their command, with the reason. None today. */
const EXCEPTIONS: { line: RegExp; reason: string }[] = [];

// ---------------------------------------------------------------- reading lines

/** Splits a command line into tokens: a quoted string is one token, brackets are tokens of their own. */
function tokens(s: string): string[] {
  const out: string[] = [];
  const re = /"[^"]*"|'[^']*'|[[\]()]|[^\s[\]()"']+(?:"[^"]*"[^\s[\]()"']*)*/g;
  for (const m of s.matchAll(re)) out.push(m[0]);
  return out;
}

/** The line without its comment: a `#` after whitespace, outside quotes (`tags.md#2026-11-14` is no comment). */
function stripComment(s: string): string {
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
function splitTopLevel(s: string): string[] {
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
const LITERAL = /^[a-z][a-z0-9-]*(\|[a-z][a-z0-9-]*)*$/;
const isPlaceholder = (t: string) => !LITERAL.test(t);

/**
 * The positional head of a command line: the tokens after `nexus` up to the first flag, bracket, parenthesis or
 * here-string (`<<<`).
 */
function head(cmd: string): string[] {
  const out: string[] = [];
  for (const t of tokens(cmd).slice(1)) {
    if (t.startsWith("-") || t === "[" || t === "(" || t === "<<<" || t === "|") break;
    out.push(t);
  }
  return out;
}

/** The flags a line names (`--name`, also `--name=value`), quoted text left out. */
function flags(s: string): Set<string> {
  const plain = s.replace(/"[^"]*"|'[^']*'/g, '""');
  return new Set([...plain.matchAll(/(?<![\w-])--([a-z][a-z0-9-]*)/g)].map((m) => `--${m[1]}`));
}

// ---------------------------------------------------------------- what the CLI knows

interface Usage { text: string; head: string[]; flags: Set<string> }
interface Cli { usages: Usage[]; global: Set<string>; topics: Set<string> }

function readHelp(help: string): Cli {
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
function check(cli: Cli, cmd: string): string[] {
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
      for (const t of h.slice(1).flatMap((x) => x.split("|"))) if (!cli.topics.has(t)) problems.push(`"${t}" is not a help topic`);
    }
    if (!problems.length) return [];
    if (!fewest || problems.length < fewest.length) fewest = problems;
  }
  return fewest ?? [mismatch ?? `no usage of "nexus ${name}" fits`];
}

/** The fenced block under "## The `nexus` CLI". */
function cliBlock(markdown: string): string[] {
  const lines = markdown.split(/\r?\n/);
  const at = lines.findIndex((l) => l === "## The `nexus` CLI");
  assert.ok(at >= 0, 'protocol/cli.md has a section "The `nexus` CLI"');
  const open = lines.findIndex((l, i) => i > at && l.startsWith("```"));
  const close = lines.findIndex((l, i) => i > open && l.startsWith("```"));
  assert.ok(open > at && close > open, "the section has a fenced block");
  return lines.slice(open + 1, close);
}

interface Result { checked: number; nexusLines: number; failures: string[]; excepted: string[] }

/** Checks every `nexus` line of a block; an indented line that is not a comment continues the line before it. */
function checkBlock(cli: Cli, block: string[]): Result {
  const commands: string[] = [];
  for (const raw of block) {
    const line = stripComment(raw);
    if (!line.trim()) continue; // blank, a comment, a role heading (`# orchestrator only`)
    if (raw.startsWith("nexus ")) commands.push(line);
    else if (/^\s/.test(raw) && commands.length) commands[commands.length - 1] += " " + line.trim();
    else commands.push(line); // anything else at the margin is checked, and fails as an unknown command
  }
  const res: Result = { checked: 0, nexusLines: block.filter((l) => l.startsWith("nexus ")).length, failures: [], excepted: [] };
  for (const cmd of commands) {
    const exception = EXCEPTIONS.find((e) => e.line.test(cmd));
    if (exception) { res.excepted.push(`${cmd}: ${exception.reason}`); continue; }
    // `nexus template list | show <id>`: an alternative that starts with a word is another subcommand of the same command
    const [first, ...alts] = splitTopLevel(cmd);
    const name = tokens(first!)[1] ?? "";
    const variants = [first!];
    for (const a of alts) {
      if (/^[a-z]/.test(a)) variants.push(`nexus ${name} ${a}`);
      else variants[variants.length - 1] += ` | ${a}`;
    }
    const problems = variants.flatMap((v) => check(cli, v));
    if (problems.length) res.failures.push(`${cmd}\n    ${problems.join("\n    ")}`);
    if (cmd.startsWith("nexus ")) res.checked++;
  }
  return res;
}

// ---------------------------------------------------------------- the tests

const cwd = mkdtempSync(join(tmpdir(), "nexus-protocol-cli-")); // no .nexus here
const env: NodeJS.ProcessEnv = { ...process.env };
delete env.NEXUS_SESSION; delete env.NEXUS_DIR;
const cli = readHelp(execFileSync(process.execPath, [CLI, "help"], { cwd, env, encoding: "utf8", stdio: "pipe" }));

test("nexus help is read: its usages, the flags of all commands and the topics", () => {
  assert.ok(cli.usages.length > 40, `${cli.usages.length} usages`);
  assert.ok(cli.global.has("--session") && cli.global.has("--queue"), [...cli.global].join(", "));
  assert.ok(cli.topics.has("review") && cli.topics.has("tests"), [...cli.topics].join(", "));
  const run = cli.usages.find((u) => u.head[0] === "run" && u.head[2] === "start|pause|resume|stop");
  assert.ok(run?.flags.has("--use-session") && run.flags.has("--at"), "nexus run start: its flags");
  const review = cli.usages.find((u) => u.head.join(" ") === "review add <step> <path|url>...");
  assert.ok(review?.flags.has("--role") && review.flags.has("--before"), "nexus review add: flags of its continuation lines");
});

test("every nexus line of protocol/cli.md's CLI block names a command, subcommand and flags the CLI has", () => {
  const res = checkBlock(cli, cliBlock(readFileSync(PROTOCOL, "utf8")));
  assert.deepEqual(res.failures, [], `lines that do not match nexus help:\n${res.failures.join("\n")}`);
  assert.deepEqual(res.excepted, [], `lines excepted:\n${res.excepted.join("\n")}`);
  assert.equal(res.checked, res.nexusLines, "every line starting with `nexus ` is checked");
  assert.ok(res.checked > 40, `${res.checked} lines checked`);
});

test("the check handles the block's harder lines: comments, role headings, continuations, alternatives, here-strings", () => {
  const block = [
    "nexus help summaries|questions|tests   # the standards",
    "# orchestrator only",
    "nexus template list | show <id>                # comment with --nonsense in it",
    "nexus tags propose --area <name> | --activity <prefix:name> [--reason ...]",
    "nexus run <queue> start|pause --reason \"...\" [--after <queue>... | --next | --at \"YYYY-MM-DD HH:MM\"]",
    "nexus metric define bundle-kb --unit KB [--warn-above 500 | --warn-below=-1]",
    "nexus context --topics rock,support --files Runtime/Core/Rock/* <<< \"summary --not-a-flag\"",
    "nexus covers tags.md#2026-11-14 docs/ideas/plan.md#2026-11-15",
    "nexus static-analysis [status]",
    "nexus answer <qid> \"...\" [--escalate [--recommend <option>]] [--continue|--wait]",
    "                                               # --recommend only with --escalate",
    "nexus step done W3 --summary \"x\"",
    "    --commit 1a2b3c",
  ];
  const res = checkBlock(cli, block);
  assert.deepEqual(res.failures, []);
  assert.equal(res.checked, 10);
  assert.equal(res.nexusLines, 10);
});

test("a line with a command, subcommand, flag or help topic the CLI does not have fails, and says why", () => {
  const cases: [string, RegExp][] = [
    ['nexus propose-change W --file patch.yaml --reason "..."', /unknown command "nexus propose-change"/],
    ["nexus session start|resume|fork|pause|stop ...", /unknown command "nexus session"/],
    ["nexus queue draft --file queue.yaml", /--file is not a flag of "nexus queue draft/],
    ["nexus run <queue> start|fork --reason x", /fork where "nexus run <queue> start\|pause\|resume\|stop/],
    ["nexus template list | drop <id>", /drop where "nexus template/],
    ["nexus step done W3 --summary x --bogus", /--bogus is not a flag/],
    ["nexus help summaries|nonsense", /"nonsense" is not a help topic/],
    ["nexus status extra", /takes no "extra"/],
  ];
  for (const [line, why] of cases) {
    const res = checkBlock(cli, [line]);
    assert.equal(res.failures.length, 1, line);
    assert.match(res.failures[0]!, why, line);
  }
  const outside = checkBlock(cli, ["nexsu status"]);
  assert.equal(outside.failures.length, 1, "a line at the margin that is not a comment is checked too");
});
