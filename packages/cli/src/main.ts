// The `nexus` command. Agents report through it; the user (or Nexus itself) also uses it for setup.
// Every agent-side command validates its input and appends one event to the session's own log.
import { errorText, formatIssues } from "@nexus/protocol/errors";
import { readFileSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import YAML from "yaml";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { parseArgs, type ParseArgsOptionsConfig } from "node:util";
import { execFileSync } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  Event, isOpenQuestion, runGoing, orchestratorOverview, planLines, stopLines, switchLines, ProjectStore, checksLine, findNexusDir, inReportFolder, loadProjectState, stepView, stepValuesText, newId, normPath, now, readRegistry, writeRegistry,
  PICTURE_ROLES, REVIEW_HELP, checkPicture, levelNow, pictureSize, recommendedOption, stepDefs,
  NEXUS_ACTIVITIES, TAG_KINDS, TAG_ORIGINS, TAG_SIZES, tagIssues, tagProposalText, tagsText,
  STAT_DIMENSIONS, flakyReport, flakyText, readTurns, sinceTime, statDimension, statsReport, statsText, stepStats,
  CHECK_METRIC, isCheckMetric, metricDef, metricDefText, metricRequestIssues, metricValueText,
  lacksStaticAnalysis, projectStaticAnalysis, staticReminderDue,
  TemplateError, fillTemplate, filledTemplateYaml, parseEvery, MaintenanceMode, readTemplates, templateDirs, templateQueueId, unusableTemplate, type MergedTemplates,
  NoteMeta, Role, Runtime, type PictureRole, type ReviewItem, type SessionFile,
  noteRefIssue, parseNoteRef, readNotes, ideaMatches, ideaLinks, ideaStatuses, reportSourceHash,
  capacityLines, latestCheckSet, stepChecks, readCapacity, reviewStats, reviewStatsText, switchReport, switchReportText, helperAbout, helperText, NEXUS_PASS_ON, PassOnReason, isUnreadableFile, sessionLine,
  decisionRefusal, decisionsCount, gate, helperHandOverRefusal, reviewRound, type DecisionEventInput,
  IdeaLinkProposalItem, PROPOSER_REFUSAL, proposalIssues, proposerOf,
} from "@nexus/protocol";
import { checkRules, describeRules } from "@nexus/protocol/rules";
import { importMarkdownQueues } from "./import-md.ts";
import { ideaStatusFor, ideaStatusSummary, noteOf } from "./ideas-summary.ts";
import { docHeadings, headingsText, pickHeadings, sectionOptions, sectionText } from "./doc.ts";
import { CONTEXT_SUMMARY_WORDS, HELP_TOPICS, topicList } from "./help.ts";

const HELP = `nexus — report to and manage Nexus (protocol 1)

Agent commands (session from NEXUS_SESSION or --session; a --session other than a set NEXUS_SESSION is refused;
a review helper's session runs only nexus status, nexus help, nexus doc and its nexus review accept|send-back|pass-on|decide|ask-user):
  nexus status [--all] [--queue <id>]           current queue, step, notes and open questions (without a
                                                session: the queues at work, then the approved ones not running).
                                                An orchestrator's or a thinking partner's: the open queues, the finished ones counted, the
                                                live worker sessions, those of open queues and the 10 latest others
                                                (cards cut short), what waits for the user, the machine; --all: every
                                                queue and session, cards whole (to choose an older session to
                                                continue); --queue: one queue, its sessions and what waits about it
  nexus step start <step>
  nexus step progress <step> <text> [--pct N]
  nexus step done <step> --summary <text> [--commit <sha>] [--activities a,b]   (what you actually did: nexus tags)
  nexus step failed <step> --reason <text>
  nexus review add <step> <path|url>... [--label <text>] [--kind image|sheet|doc|data|link] [--round N]
                    [--key <view@width> --role before|mockup|after|variant-a|variant-b|result]   (one picture; pairs by key)
                    [--before <path>]   (older material without a key: the "before" of one picture)
                    Files are copied into .nexus/queues/<queue>/review/<step>/ (write them outside the working tree).
                    Read nexus help review before preparing review material.
  nexus check <step> <name> --ok|--fail [--summary <text>] [--duration <seconds>]   (how long the check ran; it is
                    the metric check:<name>); refused for a check Nexus runs itself (its step's opening says so), and for a
                    name that is not one of the step's checks as its opening lists them (the refusal names them)
  nexus check <step> <name> --unrelated --evidence <text>   (worker only) a check Nexus ran fails, not because of your
                    work: Nexus runs it on the queue's base commit (end your turn without nexus step done)
  nexus check decide <queue> <step> accept|fix --reason <text>   (orchestrator only) a disputed failure Nexus could not
                    run on the base: accept (the step goes to its review) or fix (a check-fix round)
  nexus metric record <name> <value> [--step <step>]   (worker only) a value of one of the project's metrics, for your
                    step at work, with the HEAD commit; a negative value goes after --: nexus metric record delta -- -5
  nexus metric list                   the project's metrics: unit, how shown, target, warning threshold
  nexus stats [--project <id>] [--since <date>] [--by model|effort|kind|activity|area|size|origin] [--reviews] [--switches] [--flaky]
                                      how steps went, by group: steps, accepted in the first round, average rounds,
                                      stops and failures, median working time, estimated use of the usage windows
                                      (default: every registered project and the one it runs in, by model); --reviews instead: the reviews'
                                      quality (the user's signals, send-backs, the review helper's passed-on share,
                                      the audit); --switches instead: the steps after a context switch
                                      against those that went on in the same session; --flaky instead: the
                                      checks Nexus ran that failed, then passed, from the queues' checks.yaml, by
                                      failing test (the check's name when unknown): how often, in which queues and
                                      steps, when last, which check
  nexus stop <step> --condition <text> --reason <text>   the condition met, as the queue words it; the reason, short
  nexus ask <text|-> [--step <step>] [--option <text>]... [--recommend <option>] [--can-continue]
  nexus decide <step> <question|-> --option <text> --option <text>... [--recommend <option>] [--fix-option <option>]...
                    [--material <view key|path>]... [--for user|reviewer] [--why <text>] [--id <Dn>]
  nexus decide <step> --none <why> | --withdraw <Dn> --reason <text>
                    the step's review decisions (worker: every one before nexus step done, which refuses a step with
                    neither decisions nor --none; the orchestrator, with --queue: while it holds the review); a worker
                    proposes and recommends, it never answers (nexus help decisions)
  nexus withdraw <qid> --reason <text>   an open question of this session's (or of the one it took over from); an
                    unknown, answered, withdrawn or another session's question is refused
  nexus context <text|-> [--topics a,b] [--files a,b] [--step <step>]
  nexus report <queue> --file <path> --summary <text> [--findings <n>]   (a maintenance queue: how many findings)
  nexus covers <file>.md#<YYYY-MM-DD>...   (thinking partner only) in a hand-over, before the summary: the Decided
                    entries of the notes it passes on (the notes folder may be left out: tags.md#2026-11-14)
  nexus ideas matches                 the suggestions for matching earlier queues to the notes' entries, and the
                                      user's decisions (deciding is the user's, in the dashboard)
  nexus ideas status [<file>.md[#<date>]] [--full]   (read only) a summary: per note and entry the reference, the
                                      effective decision, the linked queues and the problems (stale, broken reference,
                                      conflict, unfinished work); with a reference: that entry's (or note's) full JSON;
                                      --full: everything as JSON (large: every entry's text and evidence). The notes
                                      folder may be left out; an entry's text: nexus doc <file>.md#<date>
  nexus ideas propose add|remove|replace --queue <Q> --ref <file>.md#<date> [--to <file>.md#<date>] --reason <text>
                    [--evidence <text>]...   (orchestrator, thinking partner, or a maintenance queue's worker)
                                      propose an idea link: add a queue's link to a Decided entry, remove a wrong one,
                                      or replace its target (--to); nothing changes until the user accepts it in the
                                      dashboard (Ideas, Manage links); the notes folder may be left out
  nexus ideas propose --file <proposals.yaml> [--reason <text>]   (orchestrator, thinking partner, or a maintenance
                    queue's worker) the same, a batch in one: a list of {op, queue, ref, to, reason, evidence}, or
                                      {reason, items: [...]}; --reason: the batch's
  nexus doc <file.md>[#<section>]     (any session; read only) a Markdown file's headings, with their levels and lines;
                                      with #<section>: that one section (to the next heading of its level or higher),
                                      named by its heading or its anchor, or a date (tags.md#2026-11-14: that dated
                                      entry); the notes folder may be left out; an unknown section lists the sections
  nexus log <text> [--level info|warn|error]
  nexus answer <qid> <text|-> [--escalate [--recommend <option>]] [--continue|--wait]     (orchestrator only)
  nexus queue draft <file.yaml|->                                 (orchestrator only) create or change a queue
  nexus queue draft --template <id> [--set name=value]... [--id <queue-id>] [--maintenance survey|fix_small]
                                      (orchestrator only) write a draft from a template into .nexus/drafts/<queue-id>.yaml
                                      (refused when a parameter without a default is missing); complete it, then upload
                                      it as above
  nexus recurring set <id> --template <id> [--set name=value]... (--every "<when>" | --after-queues <n>)
                    [--maintenance survey|fix_small] [--reason <text>]
                                      (orchestrator only) a recurring queue: the template made into a queue and started
                                      at each time, while the user's standing approval holds; <when> is "daily HH:MM",
                                      "<mon..sun> HH:MM" or "monthly <day> HH:MM" (local time); --after-queues: after
                                      every n queues of the project done (recurring runs not counted); --maintenance:
                                      this project's mode for a maintenance template. Any set takes the standing
                                      approval away: the user approves it again (only the user approves, pauses or
                                      removes one, in the dashboard)
  nexus static-analysis [status]      whether Nexus sees static analysis in the project (a linter config or lint script,
                                      .NET or Unity analyzers), and the monthly reminder's state
  nexus static-analysis decline --reason <text>   (orchestrator only) the user said no to the static-analysis
                                      template: the server notes it, and the reminder rests for 90 days
  nexus recurring list                the recurring queues: template, schedule, state, next and last run
  nexus template list                 the templates in effect: Nexus's, the user's global ones (<NEXUS_HOME>/templates/)
                                      and the project's (nexus-templates/ in its repository); a project's replaces a
                                      global one of the same id, a global one Nexus's
  nexus template show <id>            a template's parameters and its YAML
  nexus review accept <queue> <step> [--note <text>]             (orchestrator, or the step's review helper at level 2)
                                      a step waiting for your review
  nexus review send-back <queue> <step> <what to fix>             (orchestrator, or the step's review helper) back to its worker
  nexus review audit <queue> <step> agree|disagree --reason <text>   (orchestrator only) an audit of the review
                                      helper's acceptance a notice gave you; a disagreement does not reopen the step
  nexus review pass-on <queue> <step> --why <reasons> --findings <text>   (the step's review helper only) to the
                                      orchestrator; reasons: criterion, deviation, question, limit, doubt, level,
                                      decision, user_decision
  nexus review decide <queue> <step> <decision> [--choice <option>] --reason <text>   (orchestrator, or the step's review
                                      helper) an answer to a review decision, no acceptance: the helper a reviewer's
                                      decision; the orchestrator a reviewer's, a user's only at level 3 or 2 while the
                                      user is away, provisionally
  nexus review ask-user <queue> <step> <why>                      (orchestrator, or the step's review helper at level 2
                                      for the user's review decisions, once the reviewer's are answered) hand the review
                                      to the user
  nexus review provisional <queue> <step> [--note <text>]        (orchestrator only) a step at review level 3 (or at
                                      level 2 while the user is away): accept provisionally; the run goes on, the
                                      user confirms it or asks a fix on their return
  nexus queue set <queue> [--step <step>] skipped|finished|cancelled|propose-lift [--continued-in <refs>] --reason <text>
                                      (orchestrator only) housekeeping: skip a pending, stopped or failed step; close a
                                      halted run of a queue whose steps are all done or skipped; cancel a queue that is
                                      not running; propose that the user lift a stop. Done, approving and lifting are the
                                      user's. --continued-in FL4,FL5 (steps, QX/QX2, queues) with skipped: the step's own
                                      work is done and went on there, or they did it; also on a step skipped already
  nexus run <queue> start|pause|resume|stop --reason <text> [--use-session <id>] [--runtime claude|codex] [--model <m>] [--effort <e>] [--after <queue>]... | --next | --at "YYYY-MM-DD HH:MM" | --at usage-reset   (orchestrator only; start --after: into the plan, when those queues are done (one --after for each); --next: into the plan with none before it; --at: at that local time, or when the runtime's usage window resets)
  nexus run <queue> cancel-start --reason <text>   (orchestrator only: takes the queue out of the plan; not one the user put in)
  nexus plan propose <queue> [--after <queue>]... --reason <text>   (orchestrator only) propose to the user a new list of
                                      predecessors that changes dependencies the user set; the user accepts or declines
  nexus tags                          the tags a step may carry: Nexus's kinds, activities, origins and sizes, the
                                      project's areas and own activities, renames, and proposals waiting for the user
  nexus tags propose --area <name> | --activity <prefix:name> [--reason <text>]   (orchestrator only) propose a new
                                      area or project activity; the user accepts it, and only then may a draft use it
  nexus tags rename <old> <new> [--reason <text>]   (orchestrator only) propose renaming an area or a project
                                      activity; once the user accepts, the old name reads as the new one everywhere
  nexus metric define <name> --unit <unit> [--show line|bar|number] [--target <value>] [--warn-above|--warn-below <value>]
                                      (orchestrator only) name what the project measures, or change it (the whole
                                      definition: what you leave out is gone); workers record its values. A check's
                                      time is check:<its name> (in seconds) without a definition: define it for a
                                      target or a threshold. A value beyond the threshold is marked and told to you.
                                      A negative number: --warn-below=-5
  (--queue <id> names the queue whenever it is given, over the session's own; nexus status heeds it only in an orchestrator's or a thinking partner's session.
   A text given as - is read from standard input: ask, answer, note, context; an empty one is refused. Positional
   arguments beyond a command's own are refused (quote a text with spaces; give a list comma-separated, not as a glob).
   A file named that is not there, and an unknown queue, are refused by name. A command that takes a subcommand and gets none runs the first of its own: ideas matches, metric list, template list, recurring list, server status)

Help:
  nexus help [<topic>]                 Nexus's standards; topics: ${Object.keys(HELP_TOPICS).join(", ")}

Setup:
  nexus project add <path> [--id <id>] [--name <text>]
  nexus project list
  nexus import <file.md> [--prefix <text>] [--dry-run] [--replace]
  nexus attach [--role worker|orchestrator] [--runtime claude|codex|external] [--queue <id>] [--title <text>]
  nexus note <queue> <step> <text|-> [--from user|orchestrator]

The server (NEXUS_PORT, default 4317):
  nexus server status                 version, the steps running in each project, and an update in progress
  nexus server perf                   the server's measurements of itself since its start: event loop delay, the
                                      requests by route, the measured operations, the latest blocks over 200 ms
  (every server update and cancel form is the user's, or an orchestrator the user asked in the chat; workers and thinking partners are refused)
  nexus server update [--now] [--ref <commit|branch>]
                                      let running steps finish (or stop them with --now), move the live worktree to
                                      <ref> (default main), build, restart; queues held for it go on by themselves
  nexus server update --after <queue>[/<step>] [--ref <commit|branch>]
                                      plan the update for when the step is in (done, or accepted after its review;
                                      its queue opens no next step until after the restart) or the queue is done (a
                                      queue of this project); one plan at a time
  nexus server update --at <HH:MM|"YYYY-MM-DD HH:MM"> [--deadline <time>] [--ref <commit|branch>]
                                      plan the update for a time: from then no new step starts and it waits for the
                                      running ones; at the deadline it interrupts them (they continue after the restart)
  nexus server cancel                 give up waiting; the held queues go on
  nexus server cancel-plan            cancel the planned update (and the drain it started, if any)
  nexus server away [on --until <8:00|ISO time> | off]
                                      the user's away mode (global): level-2 steps are reviewed as level 3 until then;
                                      only the user switches it (refused from any agent session)
`;

/**
 * The command line, parsed; a line parseArgs refuses ends as a usage error ("nexus: ...", exit code 2), never with a
 * stack trace. A negative number reads as an option to parseArgs, so its message says how to give one.
 */
function commandLine<const T extends ParseArgsOptionsConfig>(argv: string[], options: T) {
  try { return parseArgs({ args: argv, allowPositionals: true, options }); } catch (e) {
    throw new UsageError(parseErrorText(errorText(e)));
  }
}

/** parseArgs's message, said for the command line's writer: how to give a negative value, which option is unknown. */
function parseErrorText(message: string): string {
  const unknown = /^Unknown option '([^']+)'/.exec(message)?.[1];
  if (unknown !== undefined && /^-[\d.]/.test(unknown)) {
    return `${unknown} reads as an option: a negative value goes after -- (nexus metric record delta -- ${unknown}), or an option's as --option=${unknown}`;
  }
  const ambiguous = /^Option '([^' ]+)[^']*' argument is ambiguous/.exec(message)?.[1];
  if (ambiguous !== undefined) return `${ambiguous} has no value, or one starting with -: a negative value goes as ${ambiguous}=-5`;
  if (unknown !== undefined) return `unknown option ${unknown} (nexus --help)`;
  return message.replace(/\s*\n\s*/g, " ");
}

const parseLine = (argv: string[]) => commandLine(argv, {
    session: { type: "string" }, queue: { type: "string" }, step: { type: "string" },
    summary: { type: "string" }, commit: { type: "string" }, reason: { type: "string" }, until: { type: "string" },
    condition: { type: "string" }, pct: { type: "string" }, label: { type: "string" },
    kind: { type: "string" }, round: { type: "string" }, duration: { type: "string" }, ok: { type: "boolean" }, fail: { type: "boolean" },
    option: { type: "string", multiple: true }, "can-continue": { type: "boolean" }, recommend: { type: "string" },
    "use-session": { type: "string" }, model: { type: "string" }, effort: { type: "string" }, after: { type: "string", multiple: true }, next: { type: "boolean" }, at: { type: "string" }, deadline: { type: "string" },
    topics: { type: "string" }, files: { type: "string" }, file: { type: "string" }, level: { type: "string" },
    escalate: { type: "boolean" }, continue: { type: "boolean" }, wait: { type: "boolean" },
    unrelated: { type: "boolean" }, evidence: { type: "string", multiple: true }, to: { type: "string" },
    id: { type: "string" }, name: { type: "string" }, prefix: { type: "string" },
    "dry-run": { type: "boolean" }, replace: { type: "boolean" },
    role: { type: "string" }, runtime: { type: "string" }, title: { type: "string" }, from: { type: "string" },
    area: { type: "string" }, activity: { type: "string" }, activities: { type: "string" },
    project: { type: "string" }, since: { type: "string" }, by: { type: "string" },
    unit: { type: "string" }, show: { type: "string" }, target: { type: "string" }, "warn-above": { type: "string" }, "warn-below": { type: "string" },
    set: { type: "string", multiple: true }, template: { type: "string" }, every: { type: "string" }, "after-queues": { type: "string" },
    maintenance: { type: "string" }, findings: { type: "string" }, why: { type: "string" }, "continued-in": { type: "string" },
    none: { type: "string" }, withdraw: { type: "string" }, choice: { type: "string" }, for: { type: "string" },
    material: { type: "string", multiple: true }, "fix-option": { type: "string", multiple: true },
    help: { type: "boolean", short: "h" }, full: { type: "boolean" }, all: { type: "boolean" }, reviews: { type: "boolean" }, switches: { type: "boolean" }, flaky: { type: "boolean" }, key: { type: "string" }, note: { type: "string" }, before: { type: "string" }, now: { type: "boolean" }, ref: { type: "string" },
});

/** Where a call's output goes: process.stdout and process.stderr, or a test's collector. */
interface CliOutput { write(text: string): unknown }

/** What one call of the CLI runs with: its environment, working directory, output and standard input. */
export interface CliIo {
  env: NodeJS.ProcessEnv;
  cwd: string;
  stdout: CliOutput;
  stderr: CliOutput;
  /** Standard input, read when a text is given as `-` (bin/nexus.js: the process's); none: empty. */
  stdin?: () => string;
}

/**
 * One call: its command line and what it runs with. Kept per call (AsyncLocalStorage), not per process: several
 * sessions' calls may run in one process at once (the tests' fake runtimes), each with its own environment.
 */
interface Call extends CliIo { o: ReturnType<typeof parseLine>["values"]; args: string[] }
const calls = new AsyncLocalStorage<Call>();
function call(): Call {
  const c = calls.getStore();
  if (!c) throw new Error("nexus: the CLI's commands run inside run()");
  return c;
}
/** The call's options and positional arguments. */
const o = () => call().o;
const args = () => call().args;
/** The call's environment (NEXUS_DIR, NEXUS_SESSION, NEXUS_HOME, NEXUS_PORT, ...), never this process's. */
const env = () => call().env;
/** The call's working directory: relative paths on its command line are read from it. */
const workDir = () => call().cwd;
/** A line to the call's stdout, or its stderr. */
const say = (text: string) => { call().stdout.write(`${text}\n`); };
const warn = (text: string) => { call().stderr.write(`${text}\n`); };
/** A path from the command line, absolute (forward slashes), read from the call's working directory. */
const pathArg = (p: string) => normPath(p, workDir());

/** What nexus, nexus --help and nexus help print: the commands, then the help topics. */
const fullHelp = () => `${HELP}\n${topicList()}`;

class UsageError extends Error {}
/**
 * A queue's or session's file, read: a missing one is `unknown` ("unknown queue W"); one that is there but cannot be
 * read is refused naming the file (the store's UnreadableFileError: docs/design/state.md, "Missing and unreadable
 * files"), not taken for unknown (queue LKF). Both are usage errors (exit code 2, no stack trace).
 */
function known<T>(read: () => T, unknown: string): T {
  try { return read(); } catch (e) { throw new UsageError(isUnreadableFile(e) ? e.message : unknown); }
}
/** The roles a session attached by hand may have (`nexus attach --role`). */
const ATTACH_ROLES = ["worker", "orchestrator"] as const;
/** A file named on the command line (resolved with pathArg), read; one that is not there is a usage error naming it (H4), not a stack trace. */
function readArgFile(file: string): string {
  if (!existsSync(file) || !statSync(file).isFile()) throw new UsageError(`no such file: ${file}`);
  return readFileSync(file, "utf8");
}
/** A recommendation checked against the question's options (its text or number), as the option's text. */
const recommendation = (options: readonly string[] | undefined, given: string): string => {
  try { return recommendedOption(options, given); } catch (e) { throw new UsageError(errorText(e)); }
};
/** A value the protocol knows only some of: refused, naming them, when it is none of them. */
const oneOf = <T extends string>(option: string, values: readonly T[], given: string): T => {
  if (!(values as readonly string[]).includes(given)) throw new UsageError(`${option} is one of ${values.join(", ")}, not "${given}"`);
  return given as T;
};
const need = <T>(v: T | undefined, what: string): T => {
  if (v === undefined || v === "") throw new UsageError(`missing ${what}`);
  return v;
};

/** The call's project folder: its NEXUS_DIR, else the one found from its working directory; null when none. */
function nexusDir(): string | null {
  const dir = env().NEXUS_DIR;
  return dir ? pathArg(dir) : findNexusDir(workDir(), env());
}

function store(): ProjectStore {
  const dir = nexusDir();
  if (!dir) throw new UsageError("no .nexus directory found here (set NEXUS_DIR, or run `nexus project add`)");
  return new ProjectStore(dir, undefined, env());
}

/**
 * The call's session: --session, else NEXUS_SESSION. A --session other than a set NEXUS_SESSION is refused (S7): a
 * session writes only its own log, with its own role's rights. Without NEXUS_SESSION (a shell of the user's, a session
 * attached by hand) --session names it, as always.
 */
function sessionId(): string | undefined {
  const given = o().session; const set = env().NEXUS_SESSION;
  if (given && set && given !== set) {
    throw new UsageError(`--session ${given} is not this session (NEXUS_SESSION is ${set}): a session writes only its own log; leave --session out`);
  }
  return given ?? set;
}

/**
 * Refuses positional arguments beyond the `n` a command takes (H6): a text with spaces left unquoted, or a list given as
 * a shell glob (`--files src/*`, which the shell expands into several arguments), would otherwise lose its rest.
 */
function noMore(n: number, usage: string): void {
  const extra = args().slice(n);
  if (!extra.length) return;
  throw new UsageError(`${usage} takes no more arguments, not ${extra.map((x) => `"${x}"`).join(" ")}: quote a text with spaces as one argument, and give a list comma-separated (--files a.ts,b.ts), not as a glob`);
}

/**
 * The session and those it took over from (context care: `continues`), whose questions are its own too; `sessions`:
 * the derived state's. The id of a predecessor that is not there, or cannot be read, still counts (the session names
 * it); what came before an unreadable one is unknown: `unknownBefore` is its error, naming the file.
 */
function ownLine(st: ProjectStore, s: SessionFile, sessions?: readonly SessionFile[]): { ids: Set<string>; unknownBefore?: string } {
  let unknownBefore: string | undefined;
  const line = sessionLine(st, s, (_id, e) => { unknownBefore = errorText(e); }, sessions);
  const ids = new Set(line.map((x) => x.id));
  const last = line[line.length - 1]!.continues;
  if (last) ids.add(last);
  return { ids, unknownBefore };
}

function session(st: ProjectStore): SessionFile {
  const id = need(sessionId(), "session (NEXUS_SESSION or --session; `nexus attach` creates one)");
  const s = known(() => st.readSession(id), `unknown session ${id}`);
  // What this call writes is stamped after what its session wrote and was told, and after what the server had seen
  // when it handed the agent its work (docs/design/state.md, "Clock steps"): reading them takes their times up.
  st.readEvents(id); st.readInbox(id); st.observeClock();
  return s;
}

/** The queue a step belongs to: --queue, else the session's queue, else the only queue with that step. */
function queueFor(st: ProjectStore, s: SessionFile, step?: string): string {
  const given = o().queue;
  if (given) return given;
  if (s.queue) return s.queue;
  if (step) {
    const owners = st.queueIds().filter((q) => stepDefs(st.readQueue(q)).some((x) => x.id === step));
    if (owners.length === 1) return owners[0]!;
    if (owners.length > 1) throw new UsageError(`step ${step} is in several queues (${owners.join(", ")}): add --queue`);
  }
  throw new UsageError("no queue: add --queue");
}

/**
 * The queue a question or a context summary belongs to, if one is found: none when queueFor finds none (a session
 * without a queue, no step given), but an unreadable queue.yaml met on the way is refused naming it (CHC1), not taken
 * for "no queue".
 */
function queueIfAny(st: ProjectStore, s: SessionFile, step?: string): string | undefined {
  try { return queueFor(st, s, step); } catch (e) {
    if (e instanceof UsageError) return undefined;
    if (isUnreadableFile(e)) throw new UsageError(e.message);
    throw e;
  }
}

function checkStep(st: ProjectStore, queue: string, step: string): void {
  const q = known(() => st.readQueue(queue), `unknown queue ${queue}`);
  const steps = stepDefs(q); // with the closing refactoring step, when the queue has one
  if (!steps.some((x) => x.id === step)) throw new UsageError(`queue ${queue} has no step ${step} (has ${steps.map((x) => x.id).join(", ")})`);
}

function emit(st: ProjectStore, s: SessionFile, body: Record<string, unknown>): Event {
  const r = Event.safeParse({ v: 1, id: newId(), at: now(), session: s.id, ...body });
  if (!r.success) throw new UsageError(formatIssues(r.error, "event"));
  st.appendEvent(r.data);
  return r.data;
}

/**
 * `nexus check <step> <name> --unrelated --evidence`: the worker says a check Nexus ran fails not because of its work;
 * Nexus runs it on the queue's base commit (check.disputed). Only in a check-fix round, for a check that failed.
 */
function checkUnrelated(): void {
  const st = store(); const s = session(st);
  if (s.role !== "worker") throw new UsageError("only a worker disputes a failed check of its own step (the orchestrator decides a disputed one: nexus check decide)");
  const step = need(args()[1], "<step>"); const name = need(args()[2], "<name>");
  const evidence = o().evidence?.join("\n").trim();
  if (!evidence) throw new UsageError("--evidence says what shows the failure is not your work's (for example: it fails on the base too)");
  const queue = queueFor(st, s, step);
  checkStep(st, queue, step);
  const q = loadProjectState(st).queues.find((x) => x.id === queue);
  const view = q?.steps.find((x) => x.id === step);
  const set = q && view && latestCheckSet(q, view);
  if (view?.checks_by !== "nexus" || view.status !== "running" || !set || set.state !== "failed") {
    throw new UsageError(`step ${step} has no failed checks of Nexus's to dispute now (it is ${view?.status ?? "unknown"}): --unrelated is for a check-fix round`);
  }
  const failed = set.checks.filter((c) => c.ok === false).map((c) => c.name);
  if (!failed.includes(name)) throw new UsageError(`"${name}" is not one of the checks that failed (${failed.map((n) => `"${n}"`).join(", ")})`);
  if (set.dispute) throw new UsageError(`a failure of this round was disputed already (${set.dispute.name}); fix what fails`);
  emit(st, s, { type: "check.disputed", queue, step, name, evidence });
  say(`ok: check.disputed ${queue}/${step}: Nexus runs "${name}" on the queue's base commit; end your turn now, without nexus step done`);
}

/** `nexus check decide <queue> <step> accept|fix --reason`: the orchestrator's decision on a disputed failure (check.decided). */
function checkDecide(): void {
  const st = store(); const s = session(st);
  if (s.role !== "orchestrator") throw new UsageError("only the orchestrator decides a disputed check");
  const queue = need(args()[2], "<queue>"); const step = need(args()[3], "<step>"); const verdict = need(args()[4], "accept|fix");
  if (verdict !== "accept" && verdict !== "fix") throw new UsageError(`the decision is accept or fix, not ${verdict}`);
  const reason = o().reason?.trim();
  if (!reason) throw new UsageError("--reason says why (it is recorded with the decision)");
  checkStep(st, queue, step);
  const view = loadProjectState(st).queues.find((q) => q.id === queue)?.steps.find((x) => x.id === step);
  if (view?.checking?.phase !== "decision") throw new UsageError(`step ${queue}/${step} has no disputed check waiting for your decision`);
  emit(st, s, { type: "check.decided", queue, step, verdict, reason });
  say(`ok: check.decided ${queue}/${step}: ${verdict}`);
}

function stepEvent(type: string, step: string | undefined, extra: (s: SessionFile) => Record<string, unknown> = () => ({})): void {
  const st = store(); const s = session(st);
  step = need(step, "<step>");
  const queue = queueFor(st, s, step);
  checkStep(st, queue, step);
  emit(st, s, { type, queue, step, ...extra(s) });
  say(`ok: ${type} ${queue}/${step}`);
}

/** "YYYY-MM-DD HH:MM" in this machine's local time, as ISO 8601. */
function localTime(text: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/.exec(text.trim());
  if (!m) throw new UsageError(`--at takes "YYYY-MM-DD HH:MM" (local time) or usage-reset, not ${text}`);
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  if (d.getMonth() !== Number(m[2]) - 1 || d.getDate() !== Number(m[3]) || d.getHours() !== Number(m[4])) throw new UsageError(`no such time: ${text}`);
  return d.toISOString();
}

function orchestrator(st: ProjectStore): SessionFile {
  const s = session(st);
  if (s.role !== "orchestrator") throw new UsageError("only an orchestrator session may do this");
  return s;
}

/**
 * The server carries out an orchestrator's request when it sees the event; this waits for its result. It reads once
 * more at the deadline: an answer written during the last pause (queue CWA) is the answer, not "has not answered".
 * `sleep` is a test's seam.
 */
export async function waitApplied(
  st: ProjectStore, session: string, event: string,
  o: { ms?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<{ ok: boolean; message: string } | undefined> {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const read = () => st.readApplied(session).entries.find((x) => x.event === event);
  const until = Date.now() + (o.ms ?? 15_000);
  while (Date.now() < until) {
    const a = read();
    if (a) return a;
    await sleep(150);
  }
  return read();
}

/**
 * The orchestrator's decision on a step waiting for its review: accept, send back, hand it to the user, or (review
 * level 3) accept it provisionally.
 */
async function reviewDecision(action: "accept" | "send-back" | "ask-user" | "provisional"): Promise<void> {
  const st = store(); const s = session(st);
  // A review helper accepts and sends back the step it was started for; the rest is the orchestrator's (queue RH).
  // At level 2 it also hands the user's review decisions to the user (ask-user), once the reviewer's are answered (queue RVD).
  if (s.role === "helper" && action !== "accept" && action !== "send-back" && action !== "ask-user") throw new UsageError(`a review helper does not ${action}: accept, send back, or pass it on (nexus review pass-on)`);
  if (s.role !== "helper" && s.role !== "orchestrator") throw new UsageError("only an orchestrator session may do this");
  const queue = need(args()[2], "<queue>"); const step = need(args()[3], "<step>");
  checkStep(st, queue, step);
  const state = loadProjectState(st);
  const view = stepView(state, queue, step);
  const q = state.queues.find((x) => x.id === queue)!;
  if (view.status !== "review") throw new UsageError(`step ${queue}/${step} is not waiting for review (it is ${view.status})`);
  if (view.review_with !== "orchestrator") throw new UsageError(`step ${queue}/${step} waits for the user's review, not yours`);
  if (s.role === "helper") {
    helperStep(state, s, queue, step);
    if (action === "accept" && view.level !== 2) throw new UsageError(`step ${queue}/${step} is at review level ${view.level}: its judgement is the orchestrator's. Send it back if a criterion you can check fails, else pass it on: nexus review pass-on ${queue} ${step} --why level --findings "..."`);
    if (action === "ask-user") {
      if (view.level !== 2) throw new UsageError(`step ${queue}/${step} is at review level ${view.level}: pass the user's decisions on to the orchestrator (nexus review pass-on ${queue} ${step} --why user_decision --findings "...")`);
      const why = helperHandOverRefusal(view, reviewRound(q, view));
      if (why) throw new UsageError(`${why}: a review helper hands a step to the user only for the user's review decisions, once every reviewer's decision is answered (else pass it on)`);
    }
  }
  // Every acceptance waits for the step's decisions: the same rule the derivation applies (decisionGate).
  const decided = (acceptor: "orchestrator" | "helper" | "provisional") => {
    const held = gate(q, view, acceptor, state.project);
    if (held) throw new UsageError(`step ${queue}/${step} cannot be accepted yet: ${held}. Answer what is yours (nexus review decide ${queue} ${step} <decision> --choice "…" --reason "…"), hand the user's decisions over (nexus review ask-user), or send it back`);
  };
  if (action === "accept") {
    decided(s.role === "helper" ? "helper" : "orchestrator");
    emit(st, s, { type: "review.accepted", queue, step, text: o().note?.trim() || undefined });
    say(`ok: ${queue}/${step} accepted; the run goes on`);
    return;
  }
  if (action === "provisional") {
    if (levelNow(view.level, state.away) !== 3) throw new UsageError(`step ${queue}/${step} is at review level ${view.level}${view.level === 2 ? " and away mode is off" : ""}: a provisional acceptance is for level 3 (or 2 while the user is away). Accept it, send it back, or hand it to the user`);
    decided("provisional");
    emit(st, s, { type: "review.provisional", queue, step, text: o().note?.trim() || undefined });
    say(`ok: ${queue}/${step} accepted provisionally; the run goes on, and the step waits in the user's return batch`);
    return;
  }
  const text = need(args().slice(4).join(" ").trim(), action === "send-back" ? "<what to fix>" : "<why>");
  const e = emit(st, s, { type: action === "send-back" ? "review.sent_back" : "review.asked_user", queue, step, text });
  // The server carries out a send-back (the worker's inbox, or the user beyond the limit); this waits for its result.
  if (action === "send-back") report(await waitApplied(st, s.id, e.id));
  else say(`ok: ${queue}/${step} waits for the user's review`);
}

/** A review helper decides only the step and round it was started for, while that review is still its own. */
function helperStep(state: ReturnType<typeof loadProjectState>, s: SessionFile, queue: string, step: string): void {
  const a = helperAbout(s);
  if (!a || a.queue !== queue || a.step !== step) throw new UsageError(`you were started to review ${a ? `${a.queue}/${a.step}` : "no step"}, not ${queue}/${step}`);
  const view = stepView(state, queue, step);
  if (view.helper?.session !== s.id || view.helper.state !== "running") throw new UsageError(`the review of ${queue}/${step} is no longer yours (${view.helper?.state === "passed_on" ? "it was passed on" : "another review round or reviewer has it"})`);
}

/**
 * `nexus review pass-on <queue> <step> --why <reasons> --findings <text>`: a review helper passes the step it reviews on
 * to the orchestrator (review.passed_on), with why and what it found (docs/protocol/review.md, "The review helper").
 */
function passOn(): void {
  const st = store(); const s = session(st);
  if (s.role !== "helper") throw new UsageError("only a review helper passes a step on (the orchestrator decides it: nexus review accept|send-back|ask-user|provisional)");
  const queue = need(args()[2], "<queue>"); const step = need(args()[3], "<step>");
  checkStep(st, queue, step);
  const state = loadProjectState(st);
  const view = stepView(state, queue, step);
  if (view.status !== "review" || view.review_with !== "orchestrator") throw new UsageError(`step ${queue}/${step} is not waiting for the orchestrator's review`);
  helperStep(state, s, queue, step);
  const given = list(o().why);
  const helperReasons = PassOnReason.options.filter((r) => !NEXUS_PASS_ON.has(r));
  const bad = given.filter((r) => !helperReasons.includes(r as PassOnReason));
  if (!given.length || bad.length) throw new UsageError(`--why takes one or more of ${helperReasons.join(", ")}, comma-separated${bad.length ? ` (not ${bad.join(", ")})` : ""}`);
  const findings = need(o().findings?.trim(), "--findings: what you checked and what you could not");
  emit(st, s, { type: "review.passed_on", queue, step, round: helperAbout(s)!.round, reasons: [...new Set(given)], text: findings });
  say(`ok: ${queue}/${step} passed on to the orchestrator; end your turn now`);
}

/** Writes a review decision event after the derivation's own check (decisionRefusal): what it would ignore is refused. */
function decisionEmit(st: ProjectStore, s: SessionFile, input: DecisionEventInput): Event {
  const refused = decisionRefusal(loadProjectState(st), s, input);
  if (refused) throw new UsageError(refused);
  return emit(st, s, input);
}

/**
 * `nexus decide <step> "<question>" --option … --option … [--recommend …] [--fix-option …] [--material …]… [--for
 * user|reviewer] [--why …] [--id Dn]`, `nexus decide <step> --none "<why>"`, `nexus decide <step> --withdraw Dn --reason
 * …`: the step's decision list (docs/protocol/review.md, "Review decisions"). The step's worker while it works, the
 * orchestrator (with --queue) while it holds the review; a worker proposes, it never answers.
 */
function decideList(): void {
  const st = store(); const s = session(st);
  if (s.role !== "worker" && s.role !== "orchestrator") throw new UsageError("only the step's worker (before nexus step done) or the orchestrator holding its review writes a decision list");
  const step = need(args()[1], "<step>");
  const queue = queueFor(st, s, step);
  checkStep(st, queue, step);
  noMore(3, "nexus decide <step> \"<question>\"");
  const view = stepView(loadProjectState(st), queue, step);
  const none = o().none?.trim(); const withdraw = o().withdraw?.trim();
  if (none !== undefined || withdraw !== undefined) {
    if (args()[2] !== undefined || o().option?.length) throw new UsageError("--none and --withdraw go without a question and options");
    if (none !== undefined && withdraw !== undefined) throw new UsageError("--none or --withdraw, not both");
  }
  if (none !== undefined) {
    if (!none) throw new UsageError("--none says why nothing in the step is to be decided (nothing is the user's to choose, nothing deviates from the plan)");
    decisionEmit(st, s, { type: "review.decisions_none", queue, step, text: readText(none) });
    say(`ok: ${queue}/${step} has no review decisions`);
    return;
  }
  if (withdraw !== undefined) {
    const old = view.decisions.items.find((x) => x.id === withdraw);
    if (!old) throw new UsageError(`step ${queue}/${step} has no decision ${withdraw}`);
    const reason = need(o().reason?.trim(), "--reason: why it is not a decision");
    decisionEmit(st, s, { type: "review.decision", queue, step, decision: old.id, text: old.text, options: old.options, for: old.for, withdrawn: reason });
    say(`ok: decision ${old.id} of ${queue}/${step} withdrawn`);
    return;
  }
  const text = readText(need(args()[2], "\"<question>\" (or --none \"<why>\")").trim());
  const labels = (o().option ?? []).map((x) => x.trim()).filter(Boolean);
  if (labels.length < 2) throw new UsageError("a decision has two or more options, one --option each (an answer may still choose none of them, with words)");
  if (new Set(labels).size !== labels.length) throw new UsageError("an option is given twice");
  const fix = (o()["fix-option"] ?? []).map((x) => x.trim());
  const unknown = [o().recommend, ...fix].filter((x): x is string => x !== undefined && !labels.includes(x));
  if (unknown.length) throw new UsageError(`--recommend and --fix-option name one of the options (${labels.map((x) => `"${x}"`).join(", ")}), not ${unknown.map((x) => `"${x}"`).join(", ")}`);
  const whose = o().for ?? "user";
  if (whose !== "user" && whose !== "reviewer") throw new UsageError(`--for is user (the user's judgement: the look, the feel, the scope) or reviewer (decidable from the step's evidence), not ${whose}`);
  let id = o().id?.trim();
  if (id !== undefined && !view.decisions.items.some((x) => x.id === id)) throw new UsageError(`step ${queue}/${step} has no decision ${id}: a new decision gets its id by itself (leave --id out)`);
  id ??= `D${view.decisions.items.length + 1}`;
  const material = (o().material ?? []).map((x) => x.trim()).filter(Boolean);
  decisionEmit(st, s, {
    type: "review.decision", queue, step, decision: id, text, options: labels.map((label) => (fix.includes(label) ? { label, effect: "fix" as const } : { label })),
    for: whose, ...(o().recommend ? { recommended: o().recommend } : {}), ...(material.length ? { material } : {}), ...(o().why?.trim() ? { why: o().why!.trim() } : {}),
  });
  const version = view.decisions.items.find((x) => x.id === id)?.version;
  say(`ok: decision ${id} of ${queue}/${step}${version ? ` (version ${version + 1}: its earlier answers no longer count)` : ""}, ${whose === "user" ? "the user's" : "a reviewer's"}`);
}

/**
 * `nexus review decide <queue> <step> <decision> [--choice <option>] --reason <why>`: a reviewer's answer to one review
 * decision (review.decided), by the rights at its time: the review helper a reviewer's decision; the orchestrator a
 * reviewer's, and a user's only at level 3 (2 while away), provisionally. An answer is no acceptance and wakes nobody.
 */
function reviewDecide(): void {
  const st = store(); const s = session(st);
  if (s.role !== "orchestrator" && s.role !== "helper") throw new UsageError(`only the review helper or the orchestrator answers a review decision here (the user in the dashboard)${s.role === "worker" ? "; a worker proposes decisions (nexus decide), it never answers them" : ""}`);
  const queue = need(args()[2], "<queue>"); const step = need(args()[3], "<step>"); const id = need(args()[4], "<decision> (D1, D2, …)");
  noMore(5, "nexus review decide <queue> <step> <decision>");
  checkStep(st, queue, step);
  const state = loadProjectState(st);
  const q = state.queues.find((x) => x.id === queue)!;
  const view = stepView(state, queue, step);
  if (s.role === "helper") helperStep(state, s, queue, step);
  const d = view.decisions.items.find((x) => x.id === id);
  if (!d) throw new UsageError(`step ${queue}/${step} has no decision ${id}${view.decisions.items.length ? ` (it has ${view.decisions.items.map((x) => x.id).join(", ")})` : ""}`);
  const choice = o().choice?.trim();
  const reason = need(o().reason?.trim(), "--reason: why (the user and the next worker read it)");
  decisionEmit(st, s, { type: "review.decided", queue, step, decision: d.id, version: d.version, round: reviewRound(q, view), ...(choice ? { choice } : {}), text: reason });
  say(`ok: ${d.id} of ${queue}/${step} answered${choice ? ` "${choice}"` : ""}${d.for === "user" ? " provisionally (the user confirms it)" : ""}; this is no acceptance: decide the review as before`);
}

/**
 * `nexus review audit <queue> <step> agree|disagree --reason <text>`: the orchestrator's audit of a review helper's
 * acceptance it was given in a notice (review.audited; docs/protocol/review.md, "The review helper"). It does not reopen the step.
 */
function reviewAudit(): void {
  const st = store(); const s = orchestrator(st);
  const queue = need(args()[2], "<queue>"); const step = need(args()[3], "<step>"); const verdict = need(args()[4], "agree|disagree");
  if (verdict !== "agree" && verdict !== "disagree") throw new UsageError(`the verdict is agree or disagree, not ${verdict}`);
  const reason = o().reason?.trim();
  if (!reason) throw new UsageError("--reason says why (it is recorded with the audit)");
  checkStep(st, queue, step);
  const view = stepView(loadProjectState(st), queue, step);
  const a = view.accepted;
  if (a?.by !== "helper") throw new UsageError(`step ${queue}/${step} was not accepted by the review helper`);
  if (view.audit) throw new UsageError(`step ${queue}/${step} was audited already (${view.audit.verdict})`);
  const key = `notify:audit:${a.event}`;
  // The notice may have gone to an earlier orchestrator session; an unreadable session.yaml is told, not passed over
  // in silence (CHC2): the notice could be in it.
  const orchestrators = st.sessionsOf("orchestrator", (_id, e) => warn(`nexus: warning: ${errorText(e)}; whether the audit was given to that session is not known`));
  const given = orchestrators.some((x) => st.readApplied(x.id).entries.some((a) => a.event === key));
  if (!given) throw new UsageError(`no audit of step ${queue}/${step} was given to you: Nexus picks the acceptances to audit and names them in a notice`);
  emit(st, s, { type: "review.audited", queue, step, accepted: a.event, verdict, text: reason });
  say(`ok: audit of ${queue}/${step} recorded (${verdict})${verdict === "disagree" ? "; the step stays accepted: if its work needs a fix, draft it as a revision" : ""}`);
}

/**
 * A review helper's session runs only what reads and its own review commands (H15): the CLI refuses it every other
 * command, so a helper reports a refusal in its verdict instead of asking or writing anything else. A call outside a
 * project, or with a session the project does not have (a NEXUS_SESSION inherited into a test project), passes; a
 * session.yaml that is there but cannot be read is refused naming it (CHC1): it could be a helper's. What a helper may
 * run passes before the session is read, so an unreadable one still has nexus help and nexus status.
 */
function helperGate(cmd: string): void {
  const sid = sessionId();
  if (!sid) return;
  if (cmd === "status" || cmd === "help" || cmd === "doc" || (cmd === "review" && ["accept", "send-back", "pass-on", "decide", "ask-user"].includes(args()[1] ?? ""))) return;
  let role: string | undefined;
  try { role = store().readSession(sid).role; } catch (e) {
    if (isUnreadableFile(e)) throw new UsageError(e.message);
    return;
  }
  if (role !== "helper") return;
  throw new UsageError(`a review helper only reads and decides its review (nexus status, nexus help, nexus doc, nexus review accept|send-back|pass-on|decide|ask-user), not nexus ${[cmd, args()[1]].filter(Boolean).join(" ")}; pass the step on with --why doubt, naming what you could not do`);
}

function report(r: { ok: boolean; message: string } | undefined): void {
  if (!r) { say("sent; the Nexus server has not answered yet (is it running?). Check later with `nexus status`."); return; }
  if (!r.ok) throw new UsageError(r.message);
  say(`ok: ${r.message}`);
}

const list = (v?: string) => (v ? v.split(",").map((x) => x.trim()).filter(Boolean) : []);
const stdin = () => call().stdin?.() ?? "";
/** A text argument; `-` reads it from standard input, which must not be empty (H2: nothing records an empty text). */
const readText = (v: string) => {
  if (v !== "-") return v;
  const text = stdin().trim();
  if (!text) throw new UsageError("- reads the text from standard input, and it was empty: pipe the text in, or give it as the argument");
  return text;
};

/** git's output in `cwd`, trimmed; undefined when git fails (not a repository, no git). */
function gitOut(cwd: string, gitArgs: string[]): string | undefined {
  try { return execFileSync("git", gitArgs, { cwd, env: env(), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { return undefined; }
}

/** The HEAD of the session's checkout (its working directory); undefined outside a git repository. */
const headCommit = (s: SessionFile) => gitOut(s.cwd || workDir(), ["rev-parse", "HEAD"]) || undefined;

/**
 * What a number on the command line may be: a whole number (`integer`), within `min` and `max` (inclusive), never
 * stricter than the event's schema takes; `takes` words the refusal where the bounds alone do not say what it is.
 */
interface NumberRule { integer?: boolean; min?: number; max?: number; takes?: string }

/** The refusal's "takes …" part: what the rule accepts, with an example where no bound says it. */
function numberTakes({ integer, min, max, takes }: NumberRule): string {
  if (takes) return takes;
  const kind = integer ? "a whole number" : "a number";
  if (min !== undefined && max !== undefined) return `${kind} from ${min} to ${max}`;
  if (min !== undefined) return `${kind} of ${min} or more`;
  if (max !== undefined) return `${kind} of ${max} or less`;
  return `${kind} (for example ${integer ? "3 or -2" : "12, 3.5 or -2"})`;
}

/**
 * A number given on the command line (`what` names it in the refusal); undefined when not given. Every numeric
 * option goes through here, so a wrong value is refused alike: `<what> takes <…>, not "<value>"`, exit code 2.
 */
function numberArg(v: string | undefined, what: string, rule: NumberRule = {}): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  const ok = v.trim() !== "" && Number.isFinite(n) && (!rule.integer || Number.isInteger(n))
    && (rule.min === undefined || n >= rule.min) && (rule.max === undefined || n <= rule.max);
  if (!ok) throw new UsageError(`${what} takes ${numberTakes(rule)}, not "${v}"`);
  return n;
}

/** `nexus metric define`: the orchestrator's definition, checked here first, then carried out by the server. */
async function metricDefine(): Promise<void> {
  const st = store(); const s = orchestrator(st);
  const req = {
    name: need(args()[2], "<name>"), unit: o().unit, show: o().show,
    target: numberArg(o().target, "--target"), warn_above: numberArg(o()["warn-above"], "--warn-above"), warn_below: numberArg(o()["warn-below"], "--warn-below"),
  };
  const issues = metricRequestIssues(req);
  if (issues.length) throw new UsageError(issues.join("; "));
  const e = emit(st, s, { type: "metric.defined", ...req });
  report(await waitApplied(st, s.id, e.id));
}

/**
 * `nexus metric record`: a worker's value of one of the project's metrics, for its step at work (or --step), with the
 * metric's unit and the HEAD of its checkout. A check's time is not recorded by hand: nexus check --duration gives it.
 */
function metricRecord(): void {
  const st = store(); const s = session(st);
  if (s.role !== "worker") throw new UsageError("only a worker records a metric's value, for the step it works on (an orchestrator defines metrics: nexus metric define)");
  const name = need(args()[2], "<name>").trim();
  const value = numberArg(need(args()[3], "<value>"), "<value>")!;
  if (isCheckMetric(name)) throw new UsageError(`a check's time (${CHECK_METRIC}<name>) is recorded by nexus check <step> <name> --ok|--fail --duration <seconds>`);
  const metrics = st.readMetrics();
  const def = metricDef(metrics, name);
  if (!def) {
    const known = metrics.metrics.map((m) => m.name);
    throw new UsageError(`the project has no metric ${name} (${known.length ? `it has ${known.join(", ")}` : "it has none yet"}); the orchestrator defines metrics with nexus metric define`);
  }
  let step = o().step;
  let queue: string;
  if (step) { queue = queueFor(st, s, step); checkStep(st, queue, step); }
  else {
    const at = loadProjectState(st).queues.flatMap((q) => q.steps.filter((x) => x.status === "running" && x.session === s.id).map((x) => ({ queue: q.id, step: x.id })));
    if (at.length !== 1) throw new UsageError(at.length ? `several of your steps are at work (${at.map((x) => `${x.queue}/${x.step}`).join(", ")}): add --step` : "none of your steps is at work: add --step <step>");
    ({ queue, step } = at[0]!);
  }
  const commit = headCommit(s);
  emit(st, s, { type: "metric.recorded", queue, step, name, value, unit: def.unit, commit });
  say(`ok: ${name} = ${metricValueText(value, def.unit)} for ${queue}/${step}${commit ? ` at ${commit.slice(0, 7)}` : ""}`);
}

/**
 * The step's end in its checkout (the session's working directory), by Nexus's standard (nexus help commits): tracked
 * files with uncommitted changes (the thinking partners' notes folder left out: the main checkout also holds the
 * user's own notes), and a HEAD that moved since the step started (queues/<id>/git.yaml) while no commit is named.
 * Undefined when all is well, or when the checkout is not a git repository.
 */
function stepEndWarning(st: ProjectStore, s: SessionFile, queue: string, step: string, commit: string | undefined): string | undefined {
  const cwd = s.cwd || workDir();
  if (gitOut(cwd, ["rev-parse", "--is-inside-work-tree"]) !== "true") return undefined;
  const notes = st.readProject().conversations.notes_dir;
  const status = gitOut(cwd, ["status", "--porcelain", "--untracked-files=no", "--", ".", ...(notes ? [`:(exclude)${notes}`] : [])]);
  const dirty = (status ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => l.replace(/^\S+\s+/, ""));
  const out: string[] = [];
  if (dirty.length) {
    out.push(`${dirty.length} tracked file${dirty.length === 1 ? " has" : "s have"} uncommitted changes: ${dirty.slice(0, 10).join(", ")}${dirty.length > 10 ? ", …" : ""}. Commit the step's own files (by name) and name the commit with --commit; changes that are not the step's, leave and say so in the summary.`);
  }
  const start = st.readGit(queue)?.steps[step]?.at(-1)?.start;
  const now = gitOut(cwd, ["rev-parse", "HEAD"]);
  if (!commit && start && now && now !== start) {
    out.push(`HEAD moved since the step started (${start.slice(0, 7)} -> ${now.slice(0, 7)}) but no commit is named: run nexus step done again with --commit ${now.slice(0, 7)} (the step's last commit).`);
  }
  return out.length ? `${out.join(" ")} (nexus help commits)` : undefined;
}

/** nexus step done: records the outcome; warns (never refuses) about an unclean end, and records the warning. */
function stepDone(stepArg: string | undefined): void {
  const st = store(); const s = session(st);
  const step = need(stepArg, "<step>");
  const queue = queueFor(st, s, step);
  checkStep(st, queue, step);
  const summary = need(o().summary, "--summary");
  // What the worker actually did, from the same lists a draft uses: refused before anything is recorded.
  const activities = o().activities === undefined ? undefined : list(o().activities);
  if (activities) {
    if (!activities.length) throw new UsageError("--activities takes a comma-separated list, e.g. --activities feature,test");
    const issues = tagIssues({ activities }, st.readTags());
    if (issues.length) throw new UsageError(`${issues.join("; ")} (nexus tags lists the activities)`);
  }
  // The step's review decisions, or the explicit none, before it ends (queue RVD; the user's decision D3: every step).
  const state = loadProjectState(st);
  const view = stepView(state, queue, step);
  if (state.project.review_decisions_since && !view.decisions.items.length && !view.decisions.none) {
    throw new UsageError(`Record the review's decisions first: nexus decide ${step} "<question>" --option "…" --option "…" [--recommend "…"] [--material <key|path>] [--for user|reviewer] for each, or nexus decide ${step} --none "<why>" when nothing in the step is the user's to choose and nothing deviates from the plan (nexus help decisions)`);
  }
  const warning = stepEndWarning(st, s, queue, step, o().commit);
  emit(st, s, { type: "step.done", queue, step, summary, commit: o().commit, ...(activities ? { activities } : {}), ...(warning ? { warning } : {}) });
  say(`ok: step.done ${queue}/${step}`);
  if (warning) say(`warning: ${warning}`);
}

function gitBranch(cwd: string): string | null {
  try { return execFileSync("git", ["branch", "--show-current"], { cwd, env: env(), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null; }
  catch { return null; }
}

// ---------------------------------------------------------------- commands

/** Talks to the running server; only `nexus server` does, everything else is files. */
async function server(method: "GET" | "POST", path: string, body?: unknown): Promise<Record<string, any>> {
  const url = `http://127.0.0.1:${env().NEXUS_PORT ?? 4317}${path}`;
  let r: Response;
  try { r = await fetch(url, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }); }
  catch { throw new UsageError(`no Nexus server answers at ${url}`); }
  const j = (await r.json().catch(() => ({}))) as Record<string, any>;
  if (!r.ok) throw new UsageError(j.error ?? `${r.status} ${r.statusText}`);
  return j;
}

/** A time as the user reads it, on this machine: "2026-11-15 06:00". */
const shownTime = (iso: string) => new Date(iso).toLocaleString("sv-SE").slice(0, 16);

function printAway(a: { on: boolean; until?: string } | undefined): void {
  say(a?.on ? `away mode: on until ${shownTime(a.until!)} (level-2 steps are reviewed as level 3)` : "away mode: off");
}

function printPlan(p: Record<string, any> | null | undefined): void {
  if (!p) { say("planned update: none"); return; }
  const what = p.after ? `after ${p.after.step ? `step ${p.after.queue}/${p.after.step}` : `queue ${p.after.queue}`} of project ${p.after.project}`
    : `at ${shownTime(p.at)}${p.deadline ? `, deadline ${shownTime(p.deadline)}` : ""}`;
  say(`planned update: ${what}${p.ref ? ` (ref ${p.ref})` : ""}${p.started ? "; started" : p.waiting ? `; waiting: ${p.waiting}` : ""}`);
  if (p.warning) say(`  warning: ${p.warning}`);
}

function printUpdate(u: Record<string, any>): void {
  say(`update: ${u.phase}${u.held?.length ? `; holding ${u.held.join(", ")}` : ""}${u.waiting?.length ? `; waiting for ${u.waiting.join(", ")}` : ""}`);
  for (const l of u.log ?? []) say(`  ${l}`);
  if (u.error) say(`  error: ${u.error}`);
}

interface PerfDelay { mean_ms: number; p50_ms: number; p99_ms: number; max_ms: number }
/** `nexus server perf`: GET /api/server/perf (docs/protocol/api.md, "Server API"), the longest first. */
type PerfReport = { since: string; block_ms: number; loop: PerfDelay; loop_window: PerfDelay & { since: string }; routes: { route: string; count: number; total_ms: number; mean_ms: number; max_ms: number; sync_max_ms: number; slow: number }[]; spans: { what: string; count: number; total_ms: number; mean_ms: number; max_ms: number }[]; blocks: { at: string; ms: number; during: { what: string; ms: number }[] }[]; sections?: { what: string; count: number; mean_ms: number; max_ms: number; git_calls: number; git_ms: number; git: { what: string; count: number }[] }[] };
function printPerf(p: PerfReport): void {
  // A server from before queue SV answers this path with its dashboard page, not with measurements.
  if (!p?.loop) throw new UsageError("this Nexus server does not measure itself yet (it predates nexus server perf); it does after an update");
  const d = (x: PerfDelay) => `p50 ${x.p50_ms} ms, p99 ${x.p99_ms} ms, max ${x.max_ms} ms`;
  say(`measured since ${p.since}`);
  say(`event loop delay: ${d(p.loop)}; since ${p.loop_window.since}: ${d(p.loop_window)}`);
  say("requests by total time (count, mean, max, longest synchronous part, slow over the block limit):");
  for (const r of p.routes.slice(0, 15)) say(`  ${r.route}  ${r.count}x  mean ${r.mean_ms} ms  max ${r.max_ms} ms  sync ${r.sync_max_ms} ms  slow ${r.slow}`);
  say("measured operations by total time (count, mean, max):");
  for (const s of p.spans.slice(0, 15)) say(`  ${s.what}  ${s.count}x  mean ${s.mean_ms} ms  max ${s.max_ms} ms`);
  // A server from before queue GB has no sections.
  if (p.sections?.length) say("measured sections (count, mean, max, synchronous git calls within them):");
  for (const s of p.sections ?? []) say(`  ${s.what}  ${s.count}x  mean ${s.mean_ms} ms  max ${s.max_ms} ms  git ${s.git_calls}x ${s.git_ms} ms${s.git.length ? ` (${s.git.map((g) => `${g.what} ${g.count}`).join(", ")})` : ""}`);
  say(`blocks over ${p.block_ms} ms: ${p.blocks.length ? "" : "none"}`);
  for (const b of p.blocks.slice(0, 10)) say(`  ${b.at}  ${b.ms} ms: ${b.during.map((s) => `${s.what} ${Math.round(s.ms)} ms`).join("; ") || "nothing measured"}`);
}

const commands: Record<string, () => void | Promise<void>> = {
  async server() {
    const sub = args()[1] ?? "status";
    if (sub === "status") {
      const s = await server("GET", "/api/server");
      say(`Nexus ${s.commit} "${s.subject}" from ${s.root} (${s.live ? "live worktree" : `development checkout, branch ${s.branch}`})`);
      // What an update would wait for (or interrupt with --now).
      const running = (s.running ?? []) as { project: string; name: string; steps: { queue: string; step: string; title: string; session: string | null }[] }[];
      if (!running.length) say("running steps: none");
      for (const p of running) {
        say(`running steps in ${p.name} (${p.project}):`);
        for (const x of p.steps) say(`  ${x.queue}/${x.step} ${x.title}${x.session ? `  (session ${x.session})` : ""}`);
      }
      printPlan(s.plan);
      return printUpdate(s.update);
    }
    if (sub === "perf") return printPerf((await server("GET", "/api/server/perf")) as PerfReport);
    let by: { project: string; session: string } | undefined;
    if (sub === "update" || sub === "cancel" || sub === "cancel-plan") {
      // Restarting Nexus restarts every agent's runtime: the user's call, which an orchestrator may carry out when
      // asked. A worker or a thinking partner never may (they run on the very server they would restart).
      const sid = sessionId();
      if (sid) {
        let role: string | undefined;
        let project: string | undefined;
        const what = sub === "cancel-plan" ? "cancel a planned update of" : o().after?.length || o().at !== undefined ? "plan an update of" : sub;
        try { const st = store(); role = st.readSession(sid).role; project = st.readProject().id; } catch (e) {
          // An unreadable session.yaml or project.yaml is refused as before, but named (CHC1), not "not a session".
          if (isUnreadableFile(e)) throw new UsageError(`only the user or an orchestrator may ${what} the Nexus server, and ${e.message}`);
          role = undefined;
        }
        if (role !== "orchestrator") throw new UsageError(`only the user or an orchestrator may ${what} the Nexus server, not a ${role ?? "session"}`);
        // The orchestrator that asks is told the outcome after the restart (or if the update fails).
        if (project) by = { project, session: sid };
      }
    }
    if (sub === "update" && o().at !== undefined) {
      if (o().now || o().after?.length) throw new UsageError("--at goes alone: not with --now or --after");
      const r = await server("POST", "/api/server/plan", { at: need(o().at, "--at <HH:MM|\"YYYY-MM-DD HH:MM\">"), deadline: o().deadline, ref: o().ref, by });
      say(`ok: ${r.text}`);
      return;
    }
    if (o().deadline !== undefined) throw new UsageError("--deadline goes with --at");
    if (sub === "update" && o().after?.length) {
      if (o().now) throw new UsageError("--now goes with an update at once, not with --after");
      const after = o().after ?? [];
      if (after.length > 1) throw new UsageError("--after goes once with an update: one queue or step");
      const [queue, step, more] = need(after[0], "--after <queue>[/<step>]").split("/");
      if (!queue || more !== undefined || step === "") throw new UsageError("--after <queue>[/<step>], e.g. --after PD or --after PD/PD1");
      // The queue is one of this project's: the orchestrator's own, or the one of the directory this runs in.
      let project: string | undefined;
      try { project = store().readProject().id; } catch (e) {
        if (isUnreadableFile(e)) throw new UsageError(e.message); // there, but unreadable: not "no .nexus/" (CHC1)
        project = undefined;
      }
      if (!project) throw new UsageError("run it in a Nexus project (no .nexus/ found here): --after names a queue of that project");
      const r = await server("POST", "/api/server/plan", { after: { project, queue, step }, ref: o().ref, by });
      say(`ok: ${r.text}`);
      if (r.plan?.warning) say(`warning: ${r.plan.warning}`);
      if (r.plan?.started) printUpdate(r.update);
      return;
    }
    if (sub === "update") return printUpdate(await server("POST", "/api/server/update", { now: !!o().now, ref: o().ref, by }));
    if (sub === "cancel-plan") { say(`ok: ${(await server("POST", "/api/server/cancel-plan", { by })).text}`); return; }
    if (sub === "cancel") return printUpdate(await server("POST", "/api/server/cancel"));
    if (sub === "away") {
      const what = args()[2];
      if (what === undefined) return printAway((await server("GET", "/api/server")).away);
      // Away mode is the user's: no agent switches it, the orchestrator included.
      const sid = sessionId();
      if (sid) throw new UsageError("only the user switches away mode (in the dashboard, or with nexus server away outside an agent session)");
      if (what === "on") return printAway((await server("POST", "/api/server/away", { until: need(o().until, "--until <8:00|ISO time>") })).away);
      if (what === "off") return printAway((await server("POST", "/api/server/away", { until: null })).away);
      throw new UsageError("nexus server away [on --until <8:00|ISO time> | off]");
    }
    throw new UsageError("nexus server status|perf|update|cancel|cancel-plan|away");
  },

  status() {
    const st = store();
    const state = loadProjectState(st);
    const sid = sessionId();
    const s = sid ? state.sessions.find((x) => x.id === sid) : undefined;
    say(`project ${state.project.name} (${state.project.id})`);
    // An orchestrator's (and a partner's) overview: short by default, everything with --all, one queue with --queue
    // (queue ND); the machine's lines under it, as in every other session's status.
    if (s?.role === "orchestrator" || s?.role === "conversation") {
      if (o().queue !== undefined && !state.queues.some((q) => q.id === o().queue)) throw new UsageError(`unknown queue ${o().queue}`);
      const machine = capacityLines(readCapacity(env()), new Date());
      say(orchestratorOverview(state, { all: !!o().all, queue: o().queue }));
      if (machine.length) say(`\n${machine.join("\n")}`);
      return;
    }
    if (s) say(`session ${s.id}: ${s.role}, ${s.runtime}, queue ${s.queue ?? "-"}`);
    // Without a queue of its own: the queues at work, then the approved ones not running (ready to start or resume).
    const queues = s?.queue ? state.queues.filter((q) => q.id === s.queue) : [
      ...state.queues.filter((q) => ["running", "waiting", "stopped"].includes(q.status)),
      ...state.queues.filter((q) => ["approved", "paused"].includes(q.status)),
    ];
    for (const q of queues) {
      say(`\nqueue ${q.id} [${q.status}] ${q.title}${q.approved ? "" : ` (needs approval: revision ${q.revision})`}`);
      if (q.status_reason) say(`  why: ${q.status_reason.slice(0, 300)}`);
      for (const line of stopLines(q)) say(line);
      // A run that is not going shows too, also under a queue still "running" in the derivation (one the user stopped).
      if (q.run && (q.status !== "running" || !runGoing(q.run))) {
        const why = q.run.reason ? ` (${q.run.reason.replace(/\s+/g, " ").slice(0, 200)})` : "";
        say(`  run: ${q.run.state}${q.run.step ? ` at ${q.run.step}` : ""}${why}`);
      }
      // Its place in the plan, and why it has not started (also: waiting for its checkout or for a place under the limit).
      for (const line of planLines(q)) say(line);
      for (const line of switchLines(q)) say(line);
      for (const step of q.steps) {
        const unread = step.notes.filter((n) => !n.read_at && n.to !== "orchestrator");
        const own = stepValuesText(step);
        const status = step.continued ? `${step.status} → ${step.continued.in.join(", ")}` : step.status;
        say(`  ${step.id.padEnd(5)} ${status.padEnd(8)} ${step.title}${helperText(step)}${own ? `  [on ${own}]` : ""}${unread.length ? `  (${unread.length} unread note${unread.length > 1 ? "s" : ""})` : ""}`);
        const tags = tagsText(step.tags);
        if (tags) say(`        tags: ${tags}`);
        // The checks Nexus runs: where they are, and a fix round apart from the review rounds.
        const c = step.checking;
        if (c?.unrunnable) say(`        checks by Nexus: cannot run (the run halted): ${c.unrunnable.replace(/\s+/g, " ").slice(0, 300)}`);
        else if (c) say(`        checks by Nexus: ${c.phase === "queued" ? "waiting for the machine" : c.phase === "running" ? `running${c.check ? ` ${c.check}` : ""}` : c.phase === "base" ? `running ${c.check ?? "the disputed check"} on the queue's base commit` : "a disputed failure waits for the orchestrator's decision"} since ${shownTime(c.since)}`);
        else if (step.status === "running" && step.check_fix) say(`        check-fix round ${step.check_fix} of ${state.project.defaults.check_fix_limit}${step.check_limit ? " (beyond the limit)" : ""}`);
        const checks = checksLine(step.checks);
        if (checks) say(`        checks: ${checks}`);
        // The step's review decisions (queue RVD): how many, which are open; a review without a list says so.
        const decisions = decisionsCount(step.decisions, reviewRound(q, step));
        if (decisions) say(`        review decisions: ${decisions}`);
        else if (step.status === "review" && step.decision_list === "missing") say("        review decisions: none declared (the reviewer declares them, or none, before accepting)");
      }
      const open = q.questions.filter(isOpenQuestion);
      for (const x of open) say(`  question ${x.qid} [${x.state}]: ${x.text}`);
    }
    // The workstation's heavy slot, across projects (the server's capacity.yaml): what runs, what waits and behind what.
    const machine = capacityLines(readCapacity(env()), new Date());
    if (machine.length) say(`\n${machine.join("\n")}`);
    // The session's inbox: messages and answers not yet seen. Shown here is delivered, so each is recorded as read.
    for (const m of s?.inbox.filter((x) => !x.read_at) ?? []) {
      if (m.type === "answer") {
        const q = state.questions.find((x) => x.qid === m.qid);
        const how = m.continue === true ? " (go on)" : m.continue === false ? " (wait before going on)" : "";
        say(`\nanswer from the ${m.from} to ${m.qid}${q ? ` ("${q.text}")` : ""}${how}:\n${m.text}`);
      } else if (m.type === "message") {
        say(`\nmessage from the ${m.from}${m.step ? ` about ${m.queue}/${m.step}` : ""} (${m.at}):\n${m.text}`);
      } else if (m.type === "check_failed") {
        say(`\n${m.queue}/${m.step}: the checks Nexus ran failed (check-fix round ${m.fix}):\n${m.text}`);
      } else if (m.type === "send_back") {
        say(`\n${m.queue}/${m.step} sent back by the ${m.from === "helper" ? "review helper" : m.from} (round ${m.round}):\n${m.text}${m.from === "user" ? "\n(The user's words win over the step's acceptance criteria where they conflict.)" : ""}`);
      } else {
        say(`\nSTOP requested by the ${m.from}${m.text ? `: ${m.text}` : ""}. Finish the current action, then stop and report.`);
      }
      st.appendEvent({ v: 1, id: newId(), at: now(), session: s!.id, type: "message.read", message: m.id });
    }
    if (s?.queue) {
      const q = state.queues.find((x) => x.id === s.queue);
      for (const step of q?.steps ?? []) for (const n of step.notes.filter((x) => !x.read_at && x.to !== "orchestrator")) {
        say(`\nnote ${n.id} for ${step.id} from ${n.from} (${n.at}):\n${n.body}`);
        // Shown to the session's agent: that is the delivery, so it is recorded as read.
        st.appendEvent({ v: 1, id: newId(), at: now(), session: s.id, type: "note.read", note: n.id });
      }
    }
    if (state.warnings.length) say(`\n${state.warnings.length} warning(s); first: ${state.warnings[0]}`);
  },

  decide() { return decideList(); },

  step() {
    const sub = args()[1];
    if (sub === "start" || sub === "done" || sub === "failed") noMore(3, `nexus step ${sub} <step>`);
    if (sub === "progress") noMore(4, "nexus step progress <step> <text>");
    if (sub === "start") return stepEvent("step.started", args()[2]);
    if (sub === "progress") return stepEvent("step.progress", args()[2], () => ({ text: need(args()[3], "<text>"), pct: numberArg(o().pct || undefined, "--pct", { min: 0, max: 100 }) }));
    if (sub === "done") return stepDone(args()[2]);
    if (sub === "failed") return stepEvent("step.failed", args()[2], () => ({ reason: need(o().reason, "--reason") }));
    throw new UsageError("nexus step start|progress|done|failed <step>");
  },

  review() {
    const sub = args()[1];
    if (sub === "accept" || sub === "send-back" || sub === "ask-user" || sub === "provisional") return reviewDecision(sub);
    if (args()[1] === "pass-on") return passOn();
    if (args()[1] === "audit") return reviewAudit();
    if (args()[1] === "decide") return reviewDecide();
    if (args()[1] !== "add") throw new UsageError("nexus review add <step> <path|url>... (orchestrators: nexus review accept|send-back|ask-user|provisional|decide <queue> <step>)");
    const st = store(); const s = session(st);
    const step = need(args()[2], "<step>");
    const queue = queueFor(st, s, step);
    checkStep(st, queue, step);
    const targets = args().slice(3);
    if (!targets.length) throw new UsageError("missing <path|url>");
    if (o().key !== undefined || o().role !== undefined) return reviewAddKeyed(st, s, queue, step, targets);
    let beforeFile: string | undefined;
    const beforeArg = o().before;
    if (beforeArg !== undefined) {
      if (targets.length !== 1 || /^https?:\/\//.test(targets[0]!)) throw new UsageError("--before goes with exactly one picture (a file)");
      beforeFile = reviewFile(beforeArg);
    }
    // Files first checked, then copied: a missing one refuses the whole command before anything is written.
    const files = targets.map((t) => (/^https?:\/\//.test(t) ? undefined : reviewFile(t)));
    const before = beforeFile && reviewCopy(st, queue, step, beforeFile);
    const items: ReviewItem[] = targets.map((t, i) => {
      const src = files[i];
      if (!src) return { url: t, label: o().label, kind: (o().kind as ReviewItem["kind"]) ?? "link" };
      return { path: reviewCopy(st, queue, step, src), label: o().label ?? basename(src), kind: (o().kind as ReviewItem["kind"]) ?? guessKind(src), before };
    });
    emit(st, s, { type: "review.added", queue, step, items, round: numberArg(o().round || undefined, "--round", { integer: true }) });
    const copied = items.filter((x) => x.path).length;
    say(`ok: ${items.length} review item(s) for ${queue}/${step}${copied ? ` (${copied === 1 ? "the file is" : "the files are"} copied to ${normPath(st.reviewDir(queue, step))})` : ""}`);
  },

  help() {
    const topic = args()[1];
    if (!topic) { say(fullHelp()); return; }
    const t = HELP_TOPICS[topic];
    if (!t) throw new UsageError(`no help topic "${topic}" (topics: ${Object.keys(HELP_TOPICS).join(", ")})`);
    say(t.text);
  },

  check() {
    if (args()[1] === "decide") return checkDecide();
    if (o().unrelated) return checkUnrelated();
    if (o().ok === o().fail) throw new UsageError("give exactly one of --ok or --fail");
    const name = need(args()[2], "<name>");
    // A check Nexus runs itself after the step's done is not the worker's to report (docs/protocol/checks.md, "Checks run by Nexus").
    const st = store(); const step = need(args()[1], "<step>");
    const queue = queueFor(st, session(st), step);
    if (st.readChecks(queue)?.steps[step]?.by === "nexus") {
      throw new UsageError(`Nexus runs the checks of step ${step} itself after your nexus step done, and sends you their output only if one fails; do not report them. A failure that is not your work's: nexus check ${step} "<name>" --unrelated --evidence "<what shows it>"`);
    }
    noMore(3, "nexus check <step> <name>");
    // W4: a check reported under another name than its step lists counts as not reported; refused, naming them.
    const known = stepChecks(st.readRun(queue)?.checks ?? st.readProject().defaults.checks, st.readQueue(queue).checks);
    if (!known.includes(name)) {
      throw new UsageError(known.length
        ? `"${name}" is not one of step ${step}'s checks; report each under its name exactly as listed: ${known.map((c) => `"${c}"`).join(", ")}`
        : `step ${step} has no checks to report`);
    }
    const duration = numberArg(o().duration, "--duration", { min: 0, takes: "the check's time in seconds (for example 12 or 3.5)" });
    stepEvent("check.result", args()[1], (s) => ({ name, ok: !!o().ok, summary: o().summary, duration, commit: headCommit(s) }));
  },

  stop() {
    noMore(2, "nexus stop <step>");
    stepEvent("queue.stop", args()[1], () => ({ condition: need(o().condition, "--condition"), reason: need(o().reason, "--reason") }));
  },

  ask() {
    noMore(2, "nexus ask <text|->");
    const st = store(); const s = session(st);
    const text = readText(need(args()[1], "<text>"));
    const step = o().step;
    const queue = queueIfAny(st, s, step);
    if (queue && step) checkStep(st, queue, step);
    const recommend = o().recommend;
    const recommended = recommend === undefined ? undefined : recommendation(o().option, recommend);
    const qid = newId();
    emit(st, s, { type: "question.asked", queue, step, qid, text, options: o().option, recommended, can_continue: !!o()["can-continue"] });
    say(`ok: question ${qid} sent to the orchestrator.${o()["can-continue"] ? " Independent work may finish in this turn." : " Record any other needed questions, then end this turn."} Further work waits for every question of this step to be answered (nexus status shows them).`);
  },

  withdraw() {
    const st = store(); const s = session(st);
    noMore(2, "nexus withdraw <qid>");
    const qid = need(args()[1], "<qid>");
    const reason = need(o().reason, "--reason");
    // W2: only an open question of this session (or of the one it took over from) is withdrawn; anything else would
    // say ok and change nothing, the question still holding its step.
    const state = loadProjectState(st);
    const q = state.questions.find((x) => x.qid === qid);
    if (!q) throw new UsageError(`no question ${qid} in this project (nexus status shows your open questions and their qids)`);
    const own = ownLine(st, s, state.sessions);
    if (!own.ids.has(q.session)) {
      // Past an unreadable predecessor the line is unknown: the question may be this session's own (CHC2).
      if (own.unknownBefore) throw new UsageError(`question ${qid} is not of this session's line as far as it can be read: ${own.unknownBefore}; repair the file, or ask the orchestrator to withdraw it`);
      throw new UsageError(`question ${qid} is another session's (${q.session}); a session withdraws only its own questions`);
    }
    if (q.state === "answered" || q.state === "withdrawn") throw new UsageError(`question ${qid} is ${q.state} already: nothing to withdraw`);
    emit(st, s, { type: "question.withdrawn", qid, reason });
    say("ok: question withdrawn");
  },

  context() {
    noMore(2, "nexus context <text|->");
    const st = store(); const s = session(st);
    const text = readText(need(args()[1], "<text|->"));
    const queue = queueIfAny(st, s, o().step);
    emit(st, s, { type: "context.summary", queue, step: o().step, text, topics: list(o().topics), files: list(o().files) });
    // The standard's length (nexus help context): recorded anyway, with a word to shorten the next one.
    const words = text.split(/\s+/).filter(Boolean).length;
    say(words > CONTEXT_SUMMARY_WORDS
      ? `ok: context summary recorded; warning: it is ${words} words, longer than the standard's ${CONTEXT_SUMMARY_WORDS} (nexus help context): keep what only you know, leave out what the queue, the steps' summaries and nexus status say`
      : "ok: context summary recorded");
  },

  report() {
    const st = store(); const s = session(st);
    const queue = need(args()[1], "<queue>");
    const file = pathArg(need(o().file, "--file"));
    if (!existsSync(file)) throw new UsageError(`no such file: ${file}`);
    const summary = need(o().summary, "--summary");
    const findings = numberArg(o().findings, "--findings", { integer: true, min: 0, takes: "a whole number of findings (0 or more)" });
    known(() => st.readQueue(queue), `unknown queue ${queue}`);
    // The report lives in the queue's folder, where the dashboard and the run digest read it. Workers may not write
    // under .nexus with their file tools, so they write it anywhere and this command (its only writer) copies it in.
    const target = normPath(join(st.queueDir(queue), "report.md"));
    const same = process.platform === "win32" ? target.toLowerCase() === file.toLowerCase() : target === file;
    const content = readFileSync(file);
    if (!same) writeFileSync(target, content);
    emit(st, s, { type: "queue.report", queue, path: target, summary, findings, source_hash: reportSourceHash(content) });
    // A source in the project's folder for reports (outside every working tree) is removed once copied; one anywhere
    // else is the worker's or the user's, and stays.
    const removed = !same && inReportFolder(st.readProject().id, file, env());
    if (removed) rmSync(file, { force: true });
    say(`ok: report for queue ${queue} in ${target}${same ? "" : ` (copied from ${file}${removed ? ", which is removed" : ""})`}`);
  },

  /**
   * `nexus ideas matches`: the suggestions for matching the project's earlier queues (whose source names no note) to
   * the notes' entries, and the user's decisions; read only. Deciding is the user's, in the dashboard.
   */
  ideas() {
    const sub = args()[1] ?? "matches";
    if (sub === "accept" || sub === "reject") throw new UsageError("accepting or rejecting a match of a queue to a note, or an agent's link proposal, is the user's, in the dashboard (Ideas: To match, Manage links)");
    if (sub === "propose") { ideasPropose(); return; }
    if (sub !== "matches" && sub !== "status") throw new UsageError("nexus ideas matches | status | propose (user decisions are dashboard-only)");
    const st = store();
    if (sub === "status") { ideasStatus(st); return; }
    const items = ideaMatches(st, loadProjectState(st)).items;
    const open = items.filter((m) => !m.decision);
    say(`${items.length} suggestion(s) for ${new Set(items.map((m) => m.queue)).size} queue(s); ${open.length} wait for the user`);
    for (const m of items) say([m.queue, m.ref, m.kind, ...(m.decision ? [m.decision.accepted ? "accepted" : "rejected"] : [])].join("\t"));
    const links = ideaLinks(st, loadProjectState(st));
    say(`Relationship origins (${links.history.length} correction action(s)):`);
    for (const r of links.items) say([r.queue, r.ref, r.origin, r.state, r.effective ? "effective" : "inactive", ...r.diagnostics].join("\t"));
  },

  /**
   * `nexus covers <ref>...` (a thinking partner, in a hand-over): the note entries its hand-over passes on, recorded
   * among its own events (ideas.covered); the ideas overview reads them as handed over. Each is checked against the
   * notes as they are now; a reference may leave out the notes folder (tags.md#2026-11-14).
   */
  covers() {
    const st = store(); const s = session(st);
    if (s.role !== "conversation") throw new UsageError("only a thinking partner (a conversation) records what its hand-over covers");
    const given = args().slice(1);
    if (!given.length) throw new UsageError("nexus covers <file>.md#<YYYY-MM-DD>... (the Decided entries this hand-over passes on)");
    const p = st.readProject();
    const dir = p.conversations.notes_dir;
    const notes = readNotes(p.root, dir);
    // A reference without the notes folder (tags.md#2026-11-14) gets it.
    const inFolder = (r: string) => (dir && !r.startsWith(`${dir}/`) && parseNoteRef(`${dir}/${r}`) ? `${dir}/${r}` : r);
    const refs = [...new Set(given.map((r) => inFolder(r.replaceAll("\\", "/"))))];
    const issues = refs.flatMap((r) => noteRefIssue(r, dir, notes) ?? []);
    if (issues.length) throw new UsageError(issues.join("; "));
    emit(st, s, { type: "ideas.covered", refs });
    say(`ok: this hand-over covers ${refs.join(", ")}`);
  },

  /**
   * `nexus doc <file.md>[#<section>]` (any session, or none; read only): the file's headings, or one section of it
   * (docs/protocol/cli.md, "The `nexus` CLI"). The notes folder may be left out, as with nexus covers.
   */
  doc() {
    const given = need(args()[1], "<file.md>[#<section>] (nexus doc docs/DESIGN.md, nexus doc tags.md#2026-11-14)");
    const at = given.indexOf("#");
    const path = at < 0 ? given : given.slice(0, at);
    const name = at < 0 ? undefined : given.slice(at + 1);
    const file = docFile(need(path, "<file.md> before the #"));
    const lines = readFileSync(file, "utf8").split("\n");
    const hs = docHeadings(lines);
    if (name === undefined) { say(hs.length ? headingsText(hs) : `${normPath(file)} has no headings`); return; }
    if (!name.trim()) throw new UsageError(`no section named after the # (${sectionOptions(hs)})`);
    let picked;
    try { picked = pickHeadings(hs, name); } catch (e) { throw new UsageError(`${path}: ${errorText(e)}`); }
    if (!picked.length) throw new UsageError(`${path} has no section "${name}" (${sectionOptions(hs)})`);
    // A picked heading inside a section already printed (a dated entry under another of its date) is not printed twice.
    let until = 0;
    const parts: string[] = [];
    for (const h of picked) {
      if (h.line <= until) continue;
      const text = sectionText(lines, hs, h);
      parts.push(text);
      until = h.line + text.split("\n").length - 1;
    }
    say(parts.join("\n\n"));
  },

  log() {
    noMore(2, "nexus log <text>");
    const st = store(); const s = session(st);
    emit(st, s, { type: "log", level: (o().level ?? "info") as "info", text: need(args()[1], "<text>") });
    say("ok");
  },

  async queue() {
    if (args()[1] === "set") {
      const st = store(); const s = orchestrator(st);
      const queue = need(args()[2], "<queue>");
      const to = need(args()[3], "skipped|finished|cancelled|propose-lift");
      // The server checks it against the queue's state and gives the reason when it refuses.
      const continued = list(o()["continued-in"]);
      if (o()["continued-in"] !== undefined && !continued.length) throw new UsageError("--continued-in names where the step's work went on: FL4,FL5 (steps), QX/QX2, QX");
      const e = emit(st, s, { type: "status.set", queue, step: o().step, to, reason: need(o().reason, "--reason"), ...(continued.length ? { continued_in: continued } : {}) });
      report(await waitApplied(st, s.id, e.id));
      return;
    }
    if (args()[1] !== "draft") throw new UsageError("nexus queue draft <file.yaml|-> | nexus queue set <queue> [--step <step>] <status> --reason <text>");
    if (o().template !== undefined) { draftFromTemplate(); return; }
    if (o().set?.length) throw new UsageError("--set goes with --template");
    const st = store(); const s = orchestrator(st);
    const src = need(args()[2], "<file.yaml|->");
    const text = src === "-" ? stdin() : readArgFile(pathArg(src));
    let definition: unknown;
    try { definition = YAML.parse(text); } catch (e) { throw new UsageError(`not valid YAML: ${errorText(e)}`); }
    const id = (definition as { id?: unknown } | null)?.id;
    if (typeof id !== "string") throw new UsageError("the queue needs an id");
    const e = emit(st, s, { type: "queue.drafted", queue: id, definition });
    report(await waitApplied(st, s.id, e.id));
  },

  /**
   * `nexus recurring set` (the orchestrator; the server checks and writes .nexus/recurring/<id>.yaml) and `nexus
   * recurring list`. Approving, pausing and removing are the user's, in the dashboard.
   */
  async recurring() {
    const sub = args()[1] ?? "list";
    if (["approve", "pause", "resume", "remove"].includes(sub)) throw new UsageError(`${sub === "approve" ? "approving" : sub === "remove" ? "removing" : "pausing or resuming"} a recurring queue is the user's, in the dashboard`);
    if (sub === "list") {
      const st = store();
      const list = loadProjectState(st).recurring;
      if (!list.length) say("no recurring queues");
      for (const r of list) {
        const status = r.status === "needs_approval" ? "waits for the user's approval" : r.status === "waiting_previous" ? `waits for its previous run ${r.last?.queue} to close` : r.status === "broken" ? `cannot run: ${r.problem}` : r.status;
        const next = r.next_at && r.status !== "broken" && r.status !== "paused" ? `; next ${r.next_at}` : "";
        const last = r.last ? `; last ${r.last.queue}${r.last.caught_up ? ` (made up for ${r.last.caught_up}, missed while Nexus was not running)` : ""}` : "";
        const skipped = r.skipped ? `; at ${r.skipped.due} no run: ${r.skipped.reason}` : "";
        const schedule = r.every ?? `after ${r.after_queues} queues (${r.counted ?? 0} counted)`;
        const mode = r.maintenance ? `, maintenance ${r.maintenance}` : "";
        say(`${r.id}: template ${r.template}${Object.keys(r.params).length ? ` (${Object.entries(r.params).map(([k, v]) => `${k}=${v}`).join(", ")})` : ""}, ${schedule}${mode}; ${status}${next}${last}${skipped}`);
      }
      return;
    }
    if (sub !== "set") throw new UsageError("nexus recurring set <id> --template <id> [--set name=value]... (--every \"<when>\" | --after-queues <n>) [--maintenance survey|fix_small] [--reason <text>] | nexus recurring list");
    const st = store(); const s = orchestrator(st);
    if ((o().every === undefined) === (o()["after-queues"] === undefined)) throw new UsageError("give --every \"daily HH:MM\" | \"<mon..sun> HH:MM\" | \"monthly <day> HH:MM\", or --after-queues <n>: one of them");
    const every = o().every;
    if (every !== undefined) { try { parseEvery(every); } catch (e) { throw new UsageError(errorText(e)); } }
    const afterQueues = numberArg(o()["after-queues"], "--after-queues", { integer: true, min: 1, max: 1000 });
    const e = emit(st, s, {
      type: "recurring.set", recurring: need(args()[2], "<id>"), template: need(o().template, "--template <id>"), params: setValues(),
      every: o().every, after_queues: afterQueues, maintenance: maintenanceMode(), reason: o().reason?.trim() || undefined,
    });
    report(await waitApplied(st, s.id, e.id));
  },

  /**
   * `nexus static-analysis [status]` (reads the project and the server's note) and `nexus static-analysis decline`
   * (the orchestrator; the server notes the user's no in .nexus/static-analysis.yaml).
   */
  async "static-analysis"() {
    const sub = args()[1] ?? "status";
    const st = store();
    if (sub === "status") {
      const a = projectStaticAnalysis(st.readProject().root);
      const note = st.readStaticAnalysisNote();
      say(`stacks: ${a.stacks.length ? a.stacks.join(", ") : "none Nexus knows (no reminder)"}`);
      say(a.found.length ? `static analysis: ${a.found.join("; ")}` : "static analysis: none found");
      if (note.reminded_at) say(`last reminder: ${note.reminded_at}`);
      if (note.declined) say(`declined: ${note.declined.at} (${note.declined.reason})`);
      const due = staticReminderDue(note); // 0: neither a reminder nor a no noted yet
      if (lacksStaticAnalysis(a)) say(`next reminder: ${due ? new Date(due).toISOString() : "when the server next looks"}`);
      return;
    }
    if (sub !== "decline") throw new UsageError("nexus static-analysis [status] | nexus static-analysis decline --reason <text>");
    const s = orchestrator(st);
    const e = emit(st, s, { type: "static_analysis.declined", reason: need(o().reason?.trim() || undefined, "--reason") });
    report(await waitApplied(st, s.id, e.id));
  },

  /** `nexus template list|show`: the templates of the three layers (@nexus/protocol templates.ts). Reads only. */
  template() {
    const sub = args()[1] ?? "list";
    const merged = templatesHere();
    if (sub === "list") {
      const { templates, problems } = merged;
      if (!templates.length) say("no templates");
      for (const t of templates) {
        const params = t.params.map((p) => (p.default === undefined ? p.name : `[${p.name}]`)).join(" ");
        say(`${t.id} (${t.layer}${t.replaces.length ? `, over ${t.replaces.join(" and ")}` : ""}): ${t.title}${params ? ` (params: ${params})` : ""}`);
      }
      for (const p of problems) say(`not used: ${p.path} (${p.layer}): ${p.problem}`);
      return;
    }
    if (sub !== "show") throw new UsageError("nexus template list | nexus template show <id>");
    const t = template(merged, need(args()[2], "<id>"));
    say(`${t.id}: ${t.title} (${t.layer}: ${t.path}${t.replaces.length ? `; replaces the ${t.replaces.join(" and ")} one` : ""})`);
    if (t.description) say(t.description);
    say(`parameters: {{id}} is the queue's id (--id)${t.params.length ? "" : "; no others"}`);
    for (const p of t.params) say(`  ${p.name}: ${p.description}${p.default === undefined ? " (required)" : ` (default: ${p.default})`}`);
    say("");
    say(readFileSync(t.path, "utf8").trimEnd());
  },

  async run() {
    const st = store(); const s = orchestrator(st);
    const queue = need(args()[1], "<queue>");
    const action = need(args()[2], "start|pause|resume|stop|cancel-start");
    if (!["start", "pause", "resume", "stop", "cancel-start"].includes(action)) throw new UsageError("the action is start, pause, resume, stop or cancel-start");
    if ((o().after?.length || o().next || o().at) && action !== "start") throw new UsageError("--after, --next and --at go with start");
    if ((o().after?.length || o().next) && o().at) throw new UsageError("give --after (or --next) or --at, not both");
    if (o().after?.length && o().next) throw new UsageError("--next is for a queue with no queue before it: not with --after");
    const at = o().at;
    const startAt = at === undefined ? undefined : at === "usage-reset" ? at : localTime(at);
    const e = emit(st, s, {
      type: "session.request", action: action === "cancel-start" ? "cancel_start" : action, queue, use_session: o()["use-session"],
      model: o().model, effort: o().effort, runtime: o().runtime, after: o().after?.length ? o().after : undefined, next: o().next || undefined,
      start_at: startAt, reason: need(o().reason, "--reason"),
    });
    report(await waitApplied(st, s.id, e.id));
  },

  async plan() {
    if (args()[1] !== "propose") throw new UsageError("nexus plan propose <queue> [--after <queue>]... --reason <text>");
    const st = store(); const s = orchestrator(st);
    const queue = need(args()[2], "<queue>");
    const e = emit(st, s, { type: "plan.proposed", queue, after: o().after ?? [], reason: need(o().reason, "--reason") });
    report(await waitApplied(st, s.id, e.id));
  },

  async tags() {
    const sub = args()[1] ?? "list";
    if (sub === "accept" || sub === "decline") throw new UsageError("accepting or declining a tag proposal is the user's, in the dashboard");
    if (sub === "list") {
      const st = store();
      const t = st.readTags();
      say(`Nexus's kinds (exactly one per step, the dominant one): ${TAG_KINDS.join(", ")}`);
      say(`Nexus's activities: ${NEXUS_ACTIVITIES.join(", ")}`);
      say(`origins: ${TAG_ORIGINS.join(", ")}; sizes: ${TAG_SIZES.join(", ")}`);
      say(`the project's areas: ${t.areas.map((x) => x.name).join(", ") || "none yet"}`);
      say(`the project's own activities${t.prefix ? ` (prefix ${t.prefix})` : ""}: ${t.activities.map((x) => x.name).join(", ") || "none yet"}`);
      for (const r of t.renames) say(`renamed: ${r.from} reads as ${r.to} (${r.at})`);
      for (const p of t.proposals) say(`waiting for the user: ${tagProposalText(p, t)}${p.reason ? ` (${p.reason.replace(/\s+/g, " ").slice(0, 200)})` : ""}`);
      return;
    }
    const st = store(); const s = orchestrator(st);
    const reason = o().reason?.trim() || undefined;
    let body: Record<string, unknown>;
    if (sub === "propose") {
      if ((o().area === undefined) === (o().activity === undefined)) throw new UsageError("nexus tags propose --area <name> | --activity <prefix:name> [--reason <text>]: one of them");
      body = o().area !== undefined ? { area: need(o().area, "--area") } : { activity: need(o().activity, "--activity") };
    } else if (sub === "rename") {
      body = { rename: { from: need(args()[2], "<old>"), to: need(args()[3], "<new>") } };
    } else throw new UsageError("nexus tags [list] | nexus tags propose --area <name> | --activity <prefix:name> [--reason <text>] | nexus tags rename <old> <new> [--reason <text>]");
    const e = emit(st, s, { type: "tags.proposed", ...body, reason });
    report(await waitApplied(st, s.id, e.id));
  },

  /**
   * `nexus stats`: the statistics (@nexus/protocol stats.ts) from the files: the registered projects (and the one this
   * runs in, if it is not registered) and <NEXUS_HOME>/turns.jsonl. Reads only.
   */
  stats() {
    const by = o().reviews ? "model" : statDimension(o().by);
    if (!by) throw new UsageError(`--by is one of ${STAT_DIMENSIONS.join(", ")}, not ${o().by}`);
    const sinceArg = o().since;
    const since = sinceArg === undefined ? undefined : sinceTime(sinceArg);
    if (o().since !== undefined && !since) throw new UsageError(`--since takes a date (2026-11-14) or a time, not "${o().since}"`);
    const stores = new Map<string, ProjectStore>();
    for (const p of readRegistry(env()).projects) stores.set(p.id, ProjectStore.forRoot(p.root, env()));
    try { const here = store(); const id = here.readProject().id; if (!stores.has(id)) stores.set(id, here); } catch { /* not in a project */ }
    const project = o().project;
    if (project && !stores.has(project)) throw new UsageError(`unknown project ${o().project} (nexus project list shows them)`);
    const states = [...stores].filter(([id]) => !o().project || id === o().project).flatMap(([id, st]) => {
      try { return [loadProjectState(st)]; } catch (e) { warn(`nexus: project ${id} left out: ${errorText(e)}`); return []; }
    });
    // --reviews: the reviews' quality on three levels (queue RH), instead of the steps by a dimension.
    if (o().reviews) return say(reviewStatsText(reviewStats(states, { project: o().project, since })));
    // --flaky: the checks that failed, then passed on the second run, by test (queue NKR).
    if (o().flaky) {
      const sources = [...stores].filter(([id]) => !project || id === project).flatMap(([id, st]) =>
        st.queueIds().flatMap((queue) => {
          try { const checks = st.readChecks(queue); return checks ? [{ project: id, queue, checks }] : []; }
          catch (e) { warn(`nexus: ${id}/${queue}/checks.yaml left out: ${errorText(e)}`); return []; }
        }));
      return say(flakyText(flakyReport(sources, since), sinceArg));
    }
    // --switches: the steps after context care's switch against those that went on in the same session (queue CT).
    if (o().switches) return say(switchReportText(switchReport(stepStats(states, []), { project: o().project, since })));
    say(statsText(statsReport(stepStats(states, readTurns(env()).entries), { by, project: o().project, since })));
  },

  metric() {
    const sub = args()[1] ?? "list";
    if (sub === "define") return metricDefine();
    if (sub === "record") return metricRecord();
    if (sub !== "list") throw new UsageError("nexus metric list | nexus metric record <name> <value> [--step <step>] | nexus metric define <name> --unit <unit> [--show line|bar|number] [--target <value>] [--warn-above|--warn-below <value>]");
    const defs = store().readMetrics().metrics;
    say(defs.length ? `the project's metrics:\n${defs.map((d) => `  ${metricDefText(d)}`).join("\n")}` : "the project has no metrics yet (the orchestrator defines them with nexus metric define)");
    say(`every check's time is a metric too: ${CHECK_METRIC}<the check's name> (s), from nexus check --duration`);
  },

  answer() {
    const st = store(); const s = session(st);
    if (s.role !== "orchestrator") throw new UsageError("only an orchestrator session may answer questions");
    if (o().continue && o().wait) throw new UsageError("give at most one of --continue or --wait");
    noMore(3, "nexus answer <qid> <text|->");
    const qid = need(args()[1], "<qid>");
    let recommended: string | undefined;
    const recommend = o().recommend;
    if (recommend !== undefined) {
      if (!o().escalate) throw new UsageError("--recommend goes with --escalate: it is your recommendation to the user");
      const q = loadProjectState(st).questions.find((x) => x.qid === qid);
      if (!q) throw new UsageError(`no question ${qid} in this project`);
      recommended = recommendation(q.options, recommend);
    }
    emit(st, s, {
      type: "answer.given", qid, text: readText(need(args()[2], "<text>")),
      escalate: o().escalate, continue: o().continue ? true : o().wait ? false : undefined, recommended,
    });
    say(o().escalate ? "ok: escalated to the user" : "ok: answered");
  },

  project() {
    const sub = args()[1];
    if (sub === "list") {
      for (const p of readRegistry(env()).projects) say(`${p.id.padEnd(16)} ${p.root}`);
      return;
    }
    if (sub !== "add") throw new UsageError("nexus project add <path> | nexus project list");
    const root = pathArg(need(args()[2], "<path>"));
    if (!existsSync(root)) throw new UsageError(`no such directory: ${root}`);
    // A project removed from Nexus with its .nexus folder kept comes back under the id it had.
    const kept = ProjectStore.forRoot(root, env());
    const keptId = existsSync(kept.projectFile) ? kept.readStoredProject().id : undefined;
    const id = o().id ?? keptId ?? basename(root).toLowerCase().replace(/[^a-z0-9-]+/g, "-");
    const st = ProjectStore.init(root, { id, name: o().name ?? basename(root), root }, env());
    const reg = readRegistry(env());
    if (!reg.projects.some((p) => p.id === id)) { reg.projects.push({ id, root }); writeRegistry(reg, env()); }
    say(`ok: project ${id} at ${root}\n    ${st.dir}`);
    // Whether both runtimes would see the project's rules (AGENTS.md, pulled into CLAUDE.md); the fix is the user's, in the dashboard.
    const text = (name: string) => { try { return readFileSync(join(root, name), "utf8"); } catch { return undefined; } };
    say(describeRules(checkRules({ agents: text("AGENTS.md"), claude: text("CLAUDE.md") })));
  },

  import() {
    const st = store();
    const file = pathArg(need(args()[1], "<file.md>"));
    const result = importMarkdownQueues(readArgFile(file), { source: file, prefix: o().prefix, now: now() });
    const existing = new Set(st.queueIds());
    for (const q of result.queues) {
      const clash = existing.has(q.id);
      say(`${clash && !o().replace ? "skip " : o()["dry-run"] ? "would " : ""}queue ${q.id} [${q.status}] ${q.title}: ${q.steps.map((s) => `${s.id}=${s.status ?? "pending"}`).join(" ")}${clash && !o().replace ? " (exists; --replace to overwrite)" : ""}`);
      if (!o()["dry-run"] && (!clash || o().replace)) st.writeQueue(q);
    }
    for (const s of result.skipped) say(`  not a queue: "${s.heading}" (${s.reason})`);
    if (result.defaultStopConditions.length) {
      const p = st.readProject();
      if (!p.defaults.stop_conditions.length) {
        say(`${o()["dry-run"] ? "would set" : "set"} ${result.defaultStopConditions.length} project-wide stop conditions`);
        if (!o()["dry-run"]) st.updateProject((x) => ({ ...x, defaults: { ...x.defaults, stop_conditions: result.defaultStopConditions } }));
      }
    }
  },

  attach() {
    const st = store();
    const project = st.readProject();
    // H3/S8: a hand-attached session is a worker or an orchestrator; the other roles are Nexus's own sessions, and
    // the loader grants events by role (a "user" session could write the user's decisions).
    const role = oneOf("--role", ATTACH_ROLES, o().role ?? "worker");
    const runtime = oneOf("--runtime", Runtime.options, o().runtime ?? "external");
    const queue = o().queue;
    if (queue && !st.queueIds().includes(queue)) throw new UsageError(`unknown queue ${queue} (nexus status lists the queues)`);
    const cwd = pathArg(workDir());
    const s: SessionFile = {
      protocol: 1, id: newId(), project: project.id, role, runtime, native_id: null, title: o().title,
      cwd, branch: gitBranch(cwd), queue: o().queue ?? null, launched_by: "external", created_at: now(), forked_from: null,
    };
    st.writeSession(s);
    say(`ok: session ${s.id}\nPass --session ${s.id} to every nexus command, or set NEXUS_SESSION=${s.id}.`);
  },

  note() {
    noMore(4, "nexus note <queue> <step> <text|->");
    const st = store();
    const queue = need(args()[1], "<queue>"); const step = need(args()[2], "<step>");
    checkStep(st, queue, step);
    const file = st.writeNote(queue, { id: newId(), step, from: oneOf("--from", NoteMeta.shape.from.options, o().from ?? "user"), at: now() }, readText(need(args()[3], "<text>")));
    say(`ok: note ${resolve(workDir(), file)}`);
  },
};

/**
 * `nexus review add <step> <picture> --key KEY --role ROLE`: one picture with its view key and role. Its pixel size is
 * read from the file; a wrong pair (no counterpart of its key, other pixel dimensions) is refused with the reason and
 * the pointer to `nexus help review`, and nothing is recorded. Recorded in the given round, else the step's current one.
 */
function reviewAddKeyed(st: ProjectStore, s: SessionFile, queue: string, step: string, targets: string[]): void {
  const key = need(o().key, `--key (it goes with --role). ${REVIEW_HELP}`);
  const role = need(o().role, `--role (it goes with --key: ${PICTURE_ROLES.join(", ")}). ${REVIEW_HELP}`) as PictureRole;
  if (!PICTURE_ROLES.includes(role)) throw new UsageError(`--role is one of ${PICTURE_ROLES.join(", ")}, not "${role}". ${REVIEW_HELP}`);
  if (o().before !== undefined) throw new UsageError(`--before is for pictures without a key; a keyed picture pairs by its key. ${REVIEW_HELP}`);
  if (targets.length !== 1 || /^https?:\/\//.test(targets[0]!)) throw new UsageError(`--key and --role go with exactly one picture (a file). ${REVIEW_HELP}`);
  const src = reviewFile(targets[0]!);
  const kind = (o().kind as ReviewItem["kind"]) ?? guessKind(src);
  if (kind !== "image" && kind !== "sheet") throw new UsageError(`a keyed picture is an image or a sheet, not ${kind ?? "this kind of file"}. ${REVIEW_HELP}`);
  const size = pictureSize(readFileSync(src));
  if (!size) throw new UsageError(`cannot read the pixel size of ${src}: a keyed picture is a PNG, JPEG, GIF or WebP file. ${REVIEW_HELP}`);
  const view = loadProjectState(st).queues.find((q) => q.id === queue)?.steps.find((x) => x.id === step);
  const items = view?.review_items ?? [];
  // The step's current round: the one its latest delivered send-back opened, else the first.
  const round = numberArg(o().round || undefined, "--round", { integer: true }) ?? view?.sent_back.filter((x) => x.delivered).at(-1)?.round ?? 1;
  // Checked against the source, copied only when it is accepted: a refused picture leaves nothing behind.
  const check = checkPicture(items, { path: src, key, role, round, size }, `${queue}/${step}`);
  if (!check.ok) throw new UsageError(check.message);
  const path = reviewCopy(st, queue, step, src);
  const item: ReviewItem = { path, label: o().label ?? basename(src), kind, key, role, size };
  emit(st, s, { type: "review.added", queue, step, items: [item], round });
  const c = check.counterpart;
  const paired = !c ? (role === "after" || role === "variant-b" ? "" : role === "result" ? ", stands alone" : ", waits for its pair")
    : c.compare === "round" ? `, compared with the ${c.item.role} of round ${c.item.round} (${c.item.path})`
    : `, compared with ${c.compare === "variant" ? "variant-a" : `its ${c.compare}`} (${c.item.path})`;
  say(`ok: ${key} ${role}, ${size.width}×${size.height} px, round ${round}, for ${queue}/${step}${paired}`);
}

/** A review file as given: it exists and is a file (a folder is not review material). */
function reviewFile(p: string): string {
  const file = pathArg(p);
  if (!existsSync(file)) throw new UsageError(`no such file: ${file}`);
  if (!statSync(file).isFile()) throw new UsageError(`not a file: ${file} (add the files in it one by one)`);
  return file;
}

const samePath = (a: string, b: string) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);

/**
 * Copies a review file into the step's folder in the queue's folder (ProjectStore.reviewDir), as nexus report copies
 * the report: this command is the only writer there, so a worker kept out of .nexus can still add material, the
 * dashboard serves it, and it outlasts the working tree (whose cleanup untracked files would block). Returns the
 * copy's path. A file already in the folder is taken as it is; the same content under the same name is not copied
 * twice; another file of the name gets "-2", "-3", … before its extension (an earlier round's picture stays as it was).
 */
function reviewCopy(st: ProjectStore, queue: string, step: string, file: string): string {
  const dir = normPath(st.reviewDir(queue, step));
  if (file.length > dir.length && samePath(file.slice(0, dir.length + 1), `${dir}/`)) return file;
  mkdirSync(dir, { recursive: true });
  const data = readFileSync(file);
  const ext = extname(file), stem = basename(file, ext);
  for (let i = 1; ; i++) {
    const target = `${dir}/${i === 1 ? stem : `${stem}-${i}`}${ext}`;
    if (!existsSync(target)) { writeFileSync(target, data); return target; }
    if (statSync(target).isFile() && readFileSync(target).equals(data)) return target;
  }
}

/** The templates in effect here: with the project's when run inside one, else Nexus's and the user's only. */
function templatesHere(): MergedTemplates {
  const dir = nexusDir();
  return readTemplates(dir ? dirname(dir) : undefined, templateDirs(env()));
}

/** The template in effect with this id; refused, saying why, when there is none. */
function template({ templates, problems }: MergedTemplates, id: string): MergedTemplates["templates"][number] {
  const t = templates.find((x) => x.id === id);
  if (t) return t;
  const bad = unusableTemplate(problems, id);
  throw new UsageError(bad.length ? `template ${id} cannot be used: ${bad.map((p) => `${p.path}: ${p.problem}`).join("; ")}` : `no template ${id} (nexus template list)`);
}

/** --maintenance survey|fix_small, checked. */
function maintenanceMode(): MaintenanceMode | undefined {
  if (o().maintenance === undefined) return undefined;
  const mode = MaintenanceMode.safeParse(o().maintenance);
  if (!mode.success) throw new UsageError(`--maintenance is survey or fix_small, not ${o().maintenance}`);
  return mode.data;
}

/** The --set name=value pairs, by name; refused: one without a name or "=", or a name given twice. */
function setValues(): Record<string, string> {
  const given: Record<string, string> = {};
  for (const pair of o().set ?? []) {
    const eq = pair.indexOf("=");
    if (eq < 1) throw new UsageError(`--set takes name=value, not "${pair}"`);
    const name = pair.slice(0, eq).trim();
    if (name in given) throw new UsageError(`--set ${name} given twice`);
    given[name] = pair.slice(eq + 1);
  }
  return given;
}

/**
 * `nexus queue draft --template`: fills the template and writes the result into .nexus/drafts/<queue>.yaml, the file
 * the orchestrator completes and uploads with `nexus queue draft`. It writes no event: the draft path checks the rest.
 * Refused: a missing or unknown parameter, a queue id that exists already, or a draft file of that name.
 */
function draftFromTemplate(): void {
  if (args()[2] !== undefined) throw new UsageError("nexus queue draft --template <id> [--set name=value]... [--id <queue-id>]: no file with --template");
  const st = store(); orchestrator(st);
  const t = template(templatesHere(), need(o().template, "--template <id>"));
  const given = setValues();
  const ids = new Set(st.queueIds().map((x) => x.toLowerCase()));
  const draftFile = (id: string) => join(st.dir, "drafts", `${id}.yaml`);
  const id = o().id ?? templateQueueId(t, (x) => ids.has(x.toLowerCase()) || existsSync(draftFile(x)));
  if (ids.has(id.toLowerCase())) throw new UsageError(`queue ${id} exists already: give another --id (a revision of it is drafted from its own file)`);
  const file = draftFile(id);
  if (existsSync(file)) throw new UsageError(`${normPath(file)} exists already: give another --id, or remove that draft first`);
  let queue: Record<string, unknown>;
  try { queue = fillTemplate(t, given, id, { maintenance: maintenanceMode() }); } catch (e) {
    if (e instanceof TemplateError) throw new UsageError(e.message);
    throw e;
  }
  const shown = `.nexus/drafts/${id}.yaml`;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, filledTemplateYaml(t, queue, shown), "utf8");
  say(`ok: draft ${shown} from template ${t.id} (${t.layer}); complete it, then: nexus queue draft ${shown}`);
}

/**
 * `nexus ideas status [<ref>] [--full]`: by default a short summary (per note and entry: the reference, the effective
 * decision, the linked queues, the problems); with a reference (a note's entry, or a whole note; the notes folder may
 * be left out) the JSON of its entries; with --full the whole JSON, every entry's snapshot included.
 */
function ideasStatus(st: ProjectStore): void {
  const statuses = ideaStatuses(st, loadProjectState(st));
  const given = args()[2]?.replaceAll("\\", "/");
  if (given !== undefined) {
    if (o().full) throw new UsageError("give either a reference or --full");
    const dir = st.readProject().conversations.notes_dir;
    const ref = dir && !given.startsWith(`${dir}/`) ? `${dir}/${given}` : given;
    const narrowed = ideaStatusFor(statuses, ref);
    if (!narrowed.entries.length) {
      const note = noteOf(ref);
      const dates = statuses.entries.filter((e) => noteOf(e.ref) === note).map((e) => e.ref.slice(note.length + 1));
      throw new UsageError(dates.length ? `${note} has no Decided entry ${ref.slice(note.length)} (its dates: ${dates.join(", ")})` : `no note ${note} with Decided entries (nexus ideas status lists them)`);
    }
    say(JSON.stringify(narrowed, null, 2));
    return;
  }
  say(o().full ? JSON.stringify(statuses, null, 2) : ideaStatusSummary(statuses));
}

/**
 * `nexus ideas propose` (the orchestrator, a thinking partner, a maintenance queue's worker): idea-link proposals, one
 * from the command line or a batch from a file, checked as far as the CLI can (the queue, the entries, the link's
 * state, the same proposal waiting already) and written as one `ideas.links_proposed` event of the session's own. The
 * server takes it in (idea-proposals.ts); nothing changes until the user accepts. Accepting is not a command.
 */
function ideasPropose(): void {
  const st = store(); const s = session(st);
  if (!proposerOf(st, s)) throw new UsageError(PROPOSER_REFUSAL);
  const dir = st.readProject().conversations.notes_dir;
  // A reference without the notes folder (tags.md#2026-11-14) gets it, as with nexus covers.
  const inFolder = (r: unknown) => {
    if (typeof r !== "string") return r;
    const x = r.replaceAll("\\", "/");
    return dir && !x.startsWith(`${dir}/`) && parseNoteRef(`${dir}/${x}`) ? `${dir}/${x}` : x;
  };
  let raw: unknown[];
  let reason = o().reason?.trim() || undefined;
  if (o().file !== undefined) {
    noMore(2, "nexus ideas propose --file");
    if (o().queue !== undefined || o().ref !== undefined || o().to !== undefined || o().evidence !== undefined) throw new UsageError("--file holds the items: give their queue, ref, to and evidence there");
    const path = pathArg(o().file!);
    if (!existsSync(path)) throw new UsageError(`no such file: ${path}`);
    let doc: unknown;
    try { doc = YAML.parse(readFileSync(path, "utf8")); } catch (e) { throw new UsageError(`${path} is not YAML: ${errorText(e)}`); }
    const batch = Array.isArray(doc) ? { items: doc } : (doc ?? {}) as { reason?: unknown; items?: unknown };
    if (!Array.isArray(batch.items) || !batch.items.length) throw new UsageError(`${path}: a list of proposals ({op, queue, ref, to, reason, evidence}), or {reason, items: [...]}`);
    if (batch.reason !== undefined && reason !== undefined) throw new UsageError("the batch's reason is given twice: in the file and as --reason");
    if (typeof batch.reason === "string" && batch.reason.trim()) reason = batch.reason.trim();
    raw = batch.items;
  } else {
    const op = args()[2];
    if (op !== "add" && op !== "remove" && op !== "replace") throw new UsageError("nexus ideas propose add|remove|replace --queue <Q> --ref <file>.md#<date> [--to <file>.md#<date>] --reason <text> [--evidence <text>]... | nexus ideas propose --file <proposals.yaml>");
    noMore(3, `nexus ideas propose ${op}`);
    raw = [{ op, queue: need(o().queue, "--queue <queue>"), ref: need(o().ref, "--ref <file>.md#<date>"), ...(o().to !== undefined ? { to: o().to } : {}),
      reason: need(reason, "--reason (why, shown to the user)"), ...(o().evidence?.length ? { evidence: o().evidence } : {}) }];
    reason = undefined;
  }
  const items = raw.map((x, i) => {
    const item = x && typeof x === "object" ? { ...(x as Record<string, unknown>) } : x;
    if (item && typeof item === "object") { const r = item as Record<string, unknown>; r.ref = inFolder(r.ref); if (r.to !== undefined) r.to = inFolder(r.to); }
    const parsed = IdeaLinkProposalItem.safeParse(item);
    if (!parsed.success) throw new UsageError(`proposal ${i + 1}: ${formatIssues(parsed.error, "proposal")}`);
    return parsed.data;
  });
  const issues = proposalIssues(st, loadProjectState(st), items);
  if (issues.length) throw new UsageError(`nothing proposed: ${issues.join("; ")}`);
  const e = emit(st, s, { type: "ideas.links_proposed", ...(reason ? { reason } : {}), items });
  say(`proposed: ${items.length} idea link(s), ${e.id}; nothing changes until the user accepts (Ideas → Manage links)`);
}

/**
 * The file `nexus doc` reads: an absolute path as given; otherwise the first that exists of the path from the working
 * directory, from the project's root, and in the project's notes folder (tags.md for docs/ideas/tags.md).
 */
function docFile(path: string): string {
  const p = path.replaceAll("\\", "/");
  if (isAbsolute(p)) {
    if (!existsSync(p)) throw new UsageError(`no such file: ${p}`);
    return p;
  }
  const tried = [resolve(workDir(), p)];
  const dir = nexusDir();
  if (dir) {
    try {
      const project = new ProjectStore(dir, undefined, env()).readProject();
      tried.push(join(project.root, p));
      const notes = project.conversations.notes_dir;
      if (notes && !p.startsWith(`${notes}/`)) tried.push(join(project.root, notes, p));
    } catch { /* no project here: the working directory only */ }
  }
  const found = tried.find((f) => existsSync(f) && statSync(f).isFile());
  if (!found) throw new UsageError(`no such file: ${p} (looked at ${[...new Set(tried.map((f) => normPath(f)))].join(", ")})`);
  return found;
}

function guessKind(p: string): ReviewItem["kind"] {
  if (/\.(png|jpe?g|gif|webp|svg)$/i.test(p)) return /sheet/i.test(p) ? "sheet" : "image";
  if (/\.(md|html?|pdf|txt)$/i.test(p)) return "doc";
  if (/\.(json|csv|ya?ml|log)$/i.test(p)) return "data";
  return undefined;
}

/**
 * Runs one `nexus` command line (without "nexus") and returns its exit code: 0, 2 for a usage error (one "nexus: ..."
 * line on stderr), 1 for anything else (its stack on stderr). It never exits the process: bin/nexus.js does, with the
 * code; the tests call it in their own process.
 */
export async function run(argv: readonly string[], io: CliIo): Promise<number> {
  try {
    const { values, positionals } = parseLine([...argv]);
    return await calls.run({ ...io, o: values, args: positionals }, async () => {
      const cmd = args()[0];
      // nexus, nexus --help and nexus help print the same: the commands and the help topics.
      if (!cmd || o().help) { say(fullHelp()); return 0; }
      const command = commands[cmd];
      if (!command) throw new UsageError(`unknown command "${cmd}" (nexus --help)`);
      helperGate(cmd);
      await command();
      return 0;
    });
  } catch (e) {
    if (e instanceof UsageError) { io.stderr.write(`nexus: ${e.message}\n`); return 2; }
    io.stderr.write(`${(e as Error)?.stack ?? String(e)}\n`);
    return 1;
  }
}
