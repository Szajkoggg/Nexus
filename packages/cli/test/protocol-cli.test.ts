// The `nexus` lines of docs/protocol/cli.md's "The `nexus` CLI" block against the CLI itself (queue DOC): every command and
// subcommand there exists, and every flag a line uses belongs to that command. What the CLI knows is read from
// `nexus help` (cli-usage.ts), as help.test.ts does: main.ts runs when it is loaded, so it is not imported.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { check, helpText, readHelp, splitTopLevel, stripComment, tokens, type Cli } from "./cli-usage.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROTOCOL = join(HERE, "../../../docs/protocol/cli.md");

/** Lines of the block allowed not to match the CLI, by their command, with the reason. None today. */
const EXCEPTIONS: { line: RegExp; reason: string }[] = [];

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

const cli = readHelp(await helpText());

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
    "nexus context --topics rock,support --files Runtime/Core/Rock/a.cs,Runtime/Core/Rock/b.cs <<< \"summary --not-a-flag\"",
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
