// The commands the agents' texts give, against the CLI (queue ACF): every `nexus <command> …` in the rendered prompt
// goldens (apps/server/test/golden: the briefings, step openings, seeds, every notice of prompts.ts, the helper's
// packets), in the help topics (help.ts) and in AGENTS.md names a command and subcommand the CLI has, only flags of that
// command, each one the parser knows, and the options the command cannot go without. A text that shows only part of a
// command on purpose marks it with a standalone … (`nexus run <queue> start --after …`): its required options are
// not asked for. The command, subcommand and flags are checked as protocol-cli.test.ts checks docs/protocol/cli.md
// (cli-usage.ts); what is required comes from REQUIRED below, written by hand from main.ts's checks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HELP_TOPICS } from "../src/help.ts";
import { LITERAL, check, flags, head, helpText, readHelp, tokens, type Cli } from "./cli-usage.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "../../..");
const GOLDEN = join(ROOT, "apps/server/test/golden");

/**
 * The options a command refuses to go without (main.ts: `need(o.…)` and the checks beside it), by the command's words:
 * `step done` matches a line whose words include done after step, `check --unrelated` one of nexus check with that flag.
 * Options that are one of several (`tags propose --area | --activity`) are not listed.
 */
const REQUIRED: { command: string; needs: string[] }[] = [
  { command: "run", needs: ["--reason"] },
  { command: "step done", needs: ["--summary"] },
  { command: "step failed", needs: ["--reason"] },
  { command: "stop", needs: ["--condition", "--reason"] },
  { command: "withdraw", needs: ["--reason"] },
  { command: "check decide", needs: ["--reason"] },
  { command: "check --unrelated", needs: ["--evidence"] },
  { command: "review audit", needs: ["--reason"] },
  { command: "review pass-on", needs: ["--why", "--findings"] },
  { command: "queue set", needs: ["--reason"] },
  { command: "plan propose", needs: ["--reason"] },
  { command: "static-analysis decline", needs: ["--reason"] },
  { command: "report", needs: ["--file", "--summary"] },
  { command: "recurring set", needs: ["--template"] },
];

/** Words after `nexus` in the texts' prose that are no command (`nexus and git commands`), with why. */
const NOT_COMMANDS = new Map<string, string>([
  ["and", "\"run nexus and git commands with nothing before the command name\": the two tools, in the briefings"],
  ["is", "\"nexus is your only way to act\": the orchestrator's briefing on Codex"],
]);

// ---------------------------------------------------------------- reading the texts

/** A `nexus …` command found in a text: where, the command as written, and whether it sat in backticks. */
interface Found { line: number; cmd: string; quoted: boolean }

const ELLIPSIS = "…";
/** A token that ends a command in prose: an opening parenthesis, or one ending in punctuation (not `...` or `…`). */
const endsProse = (t: string) => t === "(" || t === ")" || (/[,;:.)`]$/.test(t) && !/(\.\.\.|…)$/.test(t));

/** The `nexus` commands of a text: in backticks to the closing one, in prose to the first token that ends it. */
function commandsIn(text: string): Found[] {
  const out: Found[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    for (const m of line.matchAll(/(^|[\s`("'>])nexus (?=[a-z])/g)) {
      const at = (m.index ?? 0) + m[1]!.length;
      if (m[1] === "`") {
        const close = line.indexOf("`", at);
        out.push({ line: i + 1, cmd: line.slice(at, close < 0 ? undefined : close).trim(), quoted: true });
        continue;
      }
      const kept: string[] = [];
      let depth = 0;
      for (const t of tokens(line.slice(at), true)) {
        if (t === "[") depth++;
        if (t === "]") depth--;
        if (depth <= 0 && endsProse(t)) {
          const bare = t.replace(/[,;:.)`]+$/, "");
          if (bare && bare !== "(") kept.push(bare);
          break;
        }
        if (t.startsWith("`")) break;
        kept.push(t);
      }
      out.push({ line: i + 1, cmd: kept.join(" "), quoted: false });
    }
  });
  return out;
}

// ---------------------------------------------------------------- checking a command

/** The option names the parser knows, read from main.ts's `commandLine({ … })` call. */
function parserOptions(main: string): Set<string> {
  const start = main.indexOf("= commandLine({");
  assert.ok(start >= 0, "main.ts parses its command line with commandLine({ … })");
  const block = main.slice(start, main.indexOf("\n});", start));
  return new Set([...block.matchAll(/(?:^|[\s{,])"?([a-z][a-z-]*)"?: \{ type:/g)].map((m) => `--${m[1]}`));
}

/** The entries of REQUIRED a command's literal words (or a flag it uses) match. */
function requiredFor(cmd: string): typeof REQUIRED {
  const h = head(cmd);
  const words = new Set(h.slice(1).flatMap((w) => w.split("|")));
  const used = flags(cmd);
  return REQUIRED.filter((r) => {
    const [name, ...rest] = r.command.split(" ");
    return h[0] === name && rest.every((p) => (p.startsWith("--") ? used.has(p) : words.has(p)));
  });
}

/**
 * Whether the command is given to be run, not only named: it has a word after its literal ones (an id, a placeholder)
 * or a flag with a value. `after your nexus step done` names one, and so does `name it with nexus step done --commit`
 * (an option of it); `nexus step done <step> --summary "…"` gives one.
 */
function givesOne(cmd: string): boolean {
  if (head(cmd).slice(1).some((w) => !LITERAL.test(w))) return true;
  const t = tokens(cmd);
  return t.some((x, i) => /^--[a-z]/.test(x) && !x.includes("=") ? i + 1 < t.length && !/^(--|\[|\]|\||\()/.test(t[i + 1]!) : /^--[a-z][\w-]*=/.test(x));
}

/**
 * check() of a command, a word of alternatives (`list|show`) that no usage has as such taken one by one: each
 * alternative must fit, with what follows the word or alone (`nexus template list|show <id>`: list, show <id>).
 */
function checkEach(cli: Cli, cmd: string): string[] {
  const problems = check(cli, cmd);
  if (!problems.length) return problems;
  const t = tokens(cmd);
  const at = t.findIndex((x, i) => i > 1 && LITERAL.test(x) && x.includes("|"));
  if (at < 0) return problems;
  const fits = (alt: string) => !checkEach(cli, [...t.slice(0, at), alt, ...t.slice(at + 1)].join(" ")).length || !check(cli, [...t.slice(0, at), alt].join(" ")).length;
  const each = t[at]!.split("|").filter((alt) => !fits(alt));
  return each.length ? problems : [];
}

/**
 * The problems of one command: those of check() (command, subcommand, flags of the command), a flag the parser does
 * not know, and a required option missing (not in an excerpt). A standalone … ends what is checked (`nexus server …`).
 * In prose, trailing words the command does not take are the sentence going on (`nexus tags lists the names`).
 */
function problemsOf(cli: Cli, parser: ReadonlySet<string>, found: Pick<Found, "cmd" | "quoted">): string[] {
  const all = tokens(found.cmd, !found.quoted);
  const excerpt = all.includes(ELLIPSIS);
  let cmd = excerpt ? all.slice(0, all.indexOf(ELLIPSIS)).join(" ") : found.cmd;
  const name = head(cmd)[0] ?? "";
  if (!found.quoted && NOT_COMMANDS.has(name)) return [];
  let problems = checkEach(cli, cmd);
  // An excerpt cut short before its subcommand (`nexus server …`) names the command only.
  if (excerpt && problems.every((p) => p.includes(" needs "))) problems = [];
  if (problems.length && !found.quoted) {
    const t = tokens(cmd, true);
    for (let n = t.length - 1; n >= 2 && problems.length; n--) {
      if (!/^[A-Za-z][a-z'-]*$/.test(t[n]!)) break;
      const shorter = t.slice(0, n).join(" ");
      if (!checkEach(cli, shorter).length) { cmd = shorter; problems = []; }
    }
  }
  for (const f of flags(cmd)) if (!parser.has(f)) problems.push(`${f} is not an option of the CLI's parser`);
  if (!excerpt && givesOne(cmd)) {
    const used = flags(cmd);
    for (const r of requiredFor(cmd)) for (const need of r.needs) if (!used.has(need)) problems.push(`${need} is missing: nexus ${r.command} refuses to go without it`);
  }
  return problems;
}

// ---------------------------------------------------------------- the texts

const cli = readHelp(helpText());
const parser = parserOptions(readFileSync(join(ROOT, "packages/cli/src/main.ts"), "utf8"));

function texts(): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of readdirSync(GOLDEN).filter((x) => x.endsWith(".txt")).sort()) out.set(`apps/server/test/golden/${f}`, readFileSync(join(GOLDEN, f), "utf8"));
  for (const [topic, { text }] of Object.entries(HELP_TOPICS)) out.set(`nexus help ${topic}`, text);
  out.set("AGENTS.md", readFileSync(join(ROOT, "AGENTS.md"), "utf8"));
  return out;
}

/** Every problem of every command in the texts, as `<source>:<line>: <command>` and its problems. */
function textProblems(sources: ReadonlyMap<string, string>): { problems: string[]; checked: number } {
  const problems: string[] = [];
  let checked = 0;
  for (const [source, text] of sources) {
    for (const f of commandsIn(text)) {
      checked++;
      const p = problemsOf(cli, parser, f);
      if (p.length) problems.push(`${source}:${f.line}: ${f.cmd}\n    ${p.join("\n    ")}`);
    }
  }
  return { problems, checked };
}

// ---------------------------------------------------------------- the tests

test("the parser knows every flag nexus help names", () => {
  assert.ok(parser.has("--reason") && parser.has("--can-continue") && parser.has("--warn-below"), [...parser].join(" "));
  const named = new Set([...cli.global, ...cli.usages.flatMap((u) => [...u.flags])]);
  assert.deepEqual([...named].filter((f) => !parser.has(f) && f !== "--help"), []);
});

test("the commands are found in backticks and in prose, and a prose sentence ends them", () => {
  const text = [
    "Report with `nexus step done <step> --summary \"...\"` (see help).",
    "send the step back with nexus review send-back QN N1 \"what to fix\" (keep the user's words); then",
    "after your nexus step done, and nexus tags lists the names.",
  ].join("\n");
  assert.deepEqual(commandsIn(text), [
    { line: 1, cmd: "nexus step done <step> --summary \"...\"", quoted: true },
    { line: 2, cmd: "nexus review send-back QN N1 \"what to fix\"", quoted: false },
    { line: 3, cmd: "nexus step done", quoted: false },
    { line: 3, cmd: "nexus tags lists the names", quoted: false },
  ]);
});

test("a nexus run without --reason and a flag the CLI does not have fail, and say why; an excerpt marked … passes", () => {
  const run = problemsOf(cli, parser, { cmd: "nexus run QB resume", quoted: false });
  assert.deepEqual(run, ["--reason is missing: nexus run refuses to go without it"]);
  const bogus = problemsOf(cli, parser, { cmd: "nexus step done A1 --summary \"x\" --bogus", quoted: true });
  assert.deepEqual(bogus, ["--bogus is not a flag of \"nexus step done <step> --summary <text> [--commit <sha>] [--activities a,b]\"", "--bogus is not an option of the CLI's parser"]);
  assert.deepEqual(problemsOf(cli, parser, { cmd: "nexus run <queue> start --after …", quoted: false }), []);
  assert.deepEqual(problemsOf(cli, parser, { cmd: "nexus check A1 lint --unrelated", quoted: true }), ["--evidence is missing: nexus check --unrelated refuses to go without it"]);
  // Named, not given: no required option asked for; prose going on after a command is no argument.
  assert.deepEqual(problemsOf(cli, parser, { cmd: "nexus step done", quoted: false }), []);
  assert.deepEqual(problemsOf(cli, parser, { cmd: "nexus status shows them", quoted: false }), []);
  // A subcommand that does not exist still fails in prose.
  assert.notDeepEqual(problemsOf(cli, parser, { cmd: "nexus step begin S1", quoted: false }), []);
});

test("every nexus command in the prompt goldens, the help topics and AGENTS.md is one the CLI takes as written", (t) => {
  const { problems, checked } = textProblems(texts());
  assert.deepEqual(problems, [], `commands the CLI would refuse or misread:\n${problems.join("\n")}`);
  assert.ok(checked > 300, `${checked} commands checked`);
  t.diagnostic(`${checked} commands checked`);
});
