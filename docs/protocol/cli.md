# The `nexus` CLI

Part of [the protocol](../PROTOCOL.md).

## The `nexus` CLI

The only interface agents use. It finds its session from the `NEXUS_SESSION` and `NEXUS_DIR` environment variables
(set by Nexus when it launches a session; for a session started by hand `nexus attach` prints the id, to be given as
`NEXUS_SESSION` or as `--session <id>` to every command), validates the arguments against the protocol and appends one event.

`--queue <id>` names the queue whenever it is given, over the session's own queue (a worker's step id is looked up in it);
`nexus status` heeds it only in an orchestrator's or a thinking partner's session. A text argument given as `-`
(`ask`, `answer`, `note`, `context`) is read from standard input. A command that takes a subcommand and gets none runs the
first of its own: `ideas` runs `matches`; `metric`, `template` and `recurring` run `list`; `server` runs `status`.

```
nexus status                                   # the current queue, step, notes and unanswered questions, as text
nexus status [--all] [--queue <id>]            # in an orchestrator's (or partner's) session: the open queues, the finished ones only counted, the open questions, of the worker sessions the live ones, those of open queues and the 10 latest others (cards cut to 300 characters), Waiting for the user, then the machine's lines; --all: every queue (the finished ones named, with a skipped closing step's reason) and every session, cards whole (what a fresh orchestrator session starts from); --queue <id>: that queue (finished too), its sessions, its questions and what waits about it; an unknown queue is refused
nexus step start W3
nexus step progress W3 "Support graph built; probing fixtures" [--pct 40]
nexus review add W3 $TEMP/nexus-review/W3/sheet.png --label "Sheet, round 1" [--kind image|sheet|doc|data|link] [--round 2]   # copied into .nexus/queues/<q>/review/W3/
nexus review add W3 $TEMP/nexus-review/W3/cliff@1280.before.png --key cliff-lit@1280 --role before --label "Cliff, before"
nexus review add W3 $TEMP/nexus-review/W3/cliff@1280.png --key cliff-lit@1280 --role after --label "Cliff, lit"   # pairs by key
nexus review add W3 $TEMP/nexus-review/W3/lit.png --before $TEMP/nexus-review/W3/unlit.png --label "Lighting"   # older: no key
nexus help review                              # the standard for review material (nexus help: the topics)
nexus help summaries|context|questions|refusals|commits|tests   # the other standards
nexus check W3 "npm test" --ok --summary "548 passed" --duration 190   # the name exactly as "Checks for every step" lists it (another counts as not reported); how long it ran, in seconds: the metric check:npm test. Refused where Nexus runs the step's checks
nexus check W3 "npm test" --unrelated --evidence "it fails on main too"   # worker only: a check Nexus ran fails not because of your work: Nexus runs it on the queue's base commit (see "Checks run by Nexus")
nexus metric record bundle-kb 512 [--step W3]  # worker only: a value of a project metric for the step at work, with HEAD
nexus metric list                              # the project's metrics (any session)
nexus stats [--by model|effort|kind|activity|area|size|origin] [--project <id>] [--since <date>]   # see "Statistics"
nexus stats --reviews [--project <id>] [--since <date>]   # the reviews' quality on three levels (see "The review helper")
nexus stats --switches [--project <id>] [--since <date>]  # steps after a context switch against those without one (see "Context care")
nexus stats --flaky [--project <id>] [--since <date>]     # the flaky checks from the queues' checks.yaml, by failing test (below)
nexus step done W3 --summary "No floating body on any fixture" [--commit 1a2b3c] [--activities feature,test]   # warns at an unclean end; --activities: what was actually done (refused: a name on no list)
nexus decide W3 "Which layout?" --option A --option B [--recommend B] [--fix-option B] [--material layout@492]... [--for user|reviewer] [--why "..."] [--id D1]
                                               # one review decision of the step (review.decision; see "Review decisions" in review.md): the worker's before step done, the orchestrator's (with --queue) while it holds the review; ids D1, D2, … by themselves, --id declares one again (a new version)
nexus decide W3 --none "a refactoring: nothing is the user's" | --withdraw D2 --reason "..."   # the explicit none (review.decisions_none), or a decision off the list
nexus step failed W3 --reason "..."
nexus stop W3 --condition "user decision" --reason "..."   # the condition as the queue words it; the reason short (shown first)
nexus ask "Canyon joints: vertical only, or also inclined?" [--option ...] [--recommend <option>] [--can-continue] [--step W3]
                                               # the text, or - to read it from stdin; --recommend: one of the --option values, by text or number (1 = first)
nexus context "summary text" --topics rock,support --files Runtime/Core/Rock/a.cs,Runtime/Core/Rock/b.cs [--step W3]   # a comma list, not a glob (a shell expands it and the rest is lost); the text as the argument, or - to read it from stdin (... <<< "text"); its shape: nexus help context (beyond 2000 words it warns)
nexus report W --file <temp>/nexus-reports/<project>/W.md --summary "..." [--findings 3]   # copied to .nexus/queues/W/report.md; --findings: a maintenance queue's
nexus withdraw <qid> --reason "..."            # a question no longer needed (question.withdrawn); only an open one of this session's or of the one it took over from: an unknown, answered, withdrawn or another session's is refused
nexus log "Retrying the probe" [--level info|warn|error]   # a line into the session's own log
nexus template list | show <id>                # the queue templates in effect (see "Queue templates")
nexus recurring list                           # the recurring queues and their state (see "Recurring queues")
nexus static-analysis [status]                 # the stacks and static analysis Nexus sees, and the reminder's state (see "Static analysis reminder")
# any session
nexus ideas status                             # a summary (read only): per note and dated entry the reference (#<date> under the note's path), the effective decision (disposition; implementation: `queues done, not confirmed` when every linked queue is done and the user has not assessed it; `fully implemented (confirmed by the user <date>)`; `partially implemented (the user's assessment)`), the linked queues with their status, and the problems: stale (an invalid assessment), reference (a broken or missing one), conflict (note and decision differ), blocked / caveat (the linked work); then the user's decisions that name no entry
nexus ideas status agent-standards.md#2026-11-14   # one entry's effective status as JSON (entries, history, invalidations narrowed to it; revision); a note's path alone gives all its entries; the notes folder may be left out; an unknown date is refused with the note's dates
nexus ideas status --full                      # everything as JSON: effective dispositions, implementation assessments with every entry's snapshot (its text and its queues' evidence), conflicts and history (megabytes on a large project)
nexus ideas matches                            # the suggestions for matching earlier queues to the notes' entries, and the user's decisions (read only; deciding is the user's, in the dashboard)
nexus doc docs/DESIGN.md                       # a Markdown file's headings: one per line, indented by level, with its # marks and line number (read only; no session needed)
nexus doc docs/design/checks.md#Static analysis       # one section: from its heading to the next heading of the same or a higher level; named by the heading's text or its anchor (static-analysis), case ignored
nexus doc agent-standards.md#2026-11-14        # a dated entry: every heading that begins with the date (### 2026-11-14 and ### 2026-11-14 (later): …); the path from the working directory, else the project's root, else the notes folder (as nexus covers); a `#` line in a fenced code block (``` or ~~~) is no heading; an unknown section is refused (exit 2) with the file's sections and dates
# the orchestrator, a thinking partner, or a worker of a maintenance queue (its queue's maintenance: survey or fix_small)
nexus ideas propose add --queue N4 --ref deploy-timing.md#2026-11-14 --reason "N4 carries out this decision" --evidence "N4 description: …"   # an idea-link proposal (ideas.links_proposed); also remove, and replace with --to <note>.md#<date>; the notes folder may be left out; checked before it is written (the queue, the note and date, the link's state, the same proposal waiting already); nothing changes until the user accepts it in the dashboard; prints `proposed: 1 idea link(s), <event id>; …`
nexus ideas propose --file proposals.yaml [--reason "From the notes survey's report"]   # a batch, one event: a list of {op, queue, ref, to?, reason, evidence?}, or {reason, items: [...]}; one bad item refuses the whole batch. Accepting or declining is the user's only: nexus ideas accept|reject are refused for every role
# thinking partner only
nexus covers tags.md#2026-11-14 docs/ideas/plan.md#2026-11-15   # in a hand-over: the Decided entries it passes on (ideas.covered); the notes folder may be left out; each checked against the notes, a missing note or date refused with the note's dates
# review helper only (and nexus status, nexus help, nexus doc; every other command is refused a helper)
nexus review accept W W3 --note "what it checked"   # level 2 only; send-back as the orchestrator's (below); both only for its own step
nexus review pass-on W W3 --why criterion,doubt --findings "what it checked and what it could not"   # to the orchestrator; reasons: criterion, deviation, question, limit, doubt, level, decision, user_decision
nexus review decide W W3 D2 --choice keep --reason "..."   # a reviewer's decision only (the user's are refused a helper); no verdict
nexus review ask-user W W3 "the user's decisions: D1"   # level 2 only: the user's review decisions to the user, once every reviewer's one is answered
# orchestrator only
nexus queue draft <file.yaml|->                # a new queue, or a change to one: a new revision
nexus queue set <queue> [--step <step>] skipped|finished|cancelled|propose-lift [--continued-in <refs>] --reason "..."   # housekeeping (see "The orchestrator"); done, approving and lifting are the user's
nexus review accept <queue> <step> [--note "..."]   # the orchestrator's decision on a step waiting for its review (see "The orchestrator"); a review helper has accept (level 2) and send-back for its own step (below)
nexus review send-back <queue> <step> <what to fix>   # back to its worker
nexus review ask-user <queue> <step> <why>     # hand the review to the user
nexus review provisional <queue> <step> [--note "..."]   # level 3 (or 2 while the user is away): accept provisionally
nexus review decide <queue> <step> <decision> [--choice <option>] --reason "..."   # an answer (review.decided): a reviewer's decision; a user's only at level 3 (or 2 while away), provisionally; no acceptance
nexus run <queue> cancel-start --reason "..."   # takes a queue the orchestrator planned out of the plan
nexus plan propose <queue> [--after <queue>]... --reason "..."   # propose to the user a new list of predecessors that changes ones the user set (see "The plan")
nexus queue draft --template bugfix --set issue="..." --set area=engine [--id BF] [--maintenance survey|fix_small]   # writes .nexus/drafts/BF.yaml to complete and upload
nexus recurring set weekly --template maintenance [--set scope=...] (--every "mon 03:00" | --after-queues 5) [--maintenance survey|fix_small] [--reason ...]   # through the server; the user approves it
nexus static-analysis decline --reason "..."  # the user's no to the static-analysis template: no reminder for 90 days
nexus review audit W W2 agree|disagree --reason "..."   # an audit of the review helper's acceptance a notice gave it
nexus check decide W W3 accept|fix --reason "..."   # a disputed check Nexus could not run on the base (see "Checks run by Nexus")
nexus answer <qid> "..." [--escalate [--recommend <option>]] [--continue|--wait]
                                               # the text, or - to read it from stdin; --recommend only with --escalate: one of the question's options
nexus run <queue> start|pause|resume|stop --reason "..." [--use-session <id>] [--runtime claude|codex] [--model <m>] [--effort <e>] [--after <queue>... | --next | --at "YYYY-MM-DD HH:MM" | --at usage-reset]   # see "The orchestrator" and "The plan"
nexus tags propose --area <name> | --activity <prefix:name> [--reason ...]   # a proposal for the project's tag lists
nexus tags rename <old> <new> [--reason ...]    # the user accepts it (see "Tags"); `nexus tags` lists them (any session)
nexus metric define bundle-kb --unit KB [--show line|bar|number] [--target 400] [--warn-above 500 | --warn-below=-1]
                                               # a project metric, or a change to one (see "Project metrics")
# setup
nexus attach [--role worker|orchestrator] [--runtime claude|codex|external] [--queue <id>] [--title <text>]   # register a hand-started session (default: a worker, external: it sets up the session itself); a role other than worker or orchestrator, a runtime the protocol does not know, or an unknown --queue is refused
nexus project list                             # the registered projects
nexus project add <path> [--id] [--name]       # creates .nexus/ (self-ignoring), registers the project, prints the rules files' check;
                                               # a kept .nexus/ (a project removed from Nexus) brings it back under its id
nexus import <file.md> [--prefix X] [--dry-run] [--replace]   # one-time import of queues written as Markdown tables
nexus note <queue> <step> <text|-> [--from user|orchestrator]   # (- reads the text from stdin) writes the same note the dashboard's "Add note" does; the way for an agent or a script
nexus server status                            # the version, the steps running in each project, and an update in progress
nexus server perf                              # the server's measurements since its start: event loop delay, requests by route, measured operations, the latest blocks over 200 ms
nexus server away [on --until <8:00|ISO> | off]  # the user's away mode (refused from any agent session); no argument: its state
nexus server update --after <queue>[/<step>] [--ref <ref>]   # plan a deploy for after a step or queue of this project (the user, or an orchestrator the user asked)
nexus server update --at <HH:MM|"YYYY-MM-DD HH:MM"> [--deadline <time>] [--ref <ref>]   # plan a deploy for a time, with an optional deadline
nexus server cancel-plan                       # cancel the planned deploy (and the drain it started); same rule as `server update`
nexus server update [--now] [--ref <ref>]      # deploy now: let running steps finish (--now: stop them), move the live worktree to <ref> (default main), build, restart; every `server update` and `server cancel` form: only the user, or an orchestrator the user asked in the chat and then only that (AGENTS.md); workers and thinking partners are refused
nexus server cancel                            # give up waiting for a deploy; the held queues go on (same rule as `server update`)
```

A command line the CLI cannot take (an unknown option, an option without its value, a value the protocol does not know,
positional arguments beyond the command's own, such as an unquoted text or a list given as a glob, a text given as `-`
with an empty standard input, a file named that is not there, an unknown queue or session (one whose `queue.yaml` or
`session.yaml` is there but cannot be read is refused naming that file and why, not as unknown), a `--session` other than a set
`NEXUS_SESSION`, a `nexus check` name that is not one of the step's checks, which the message lists)
ends with `nexus: <what is wrong>` on stderr and exit code 2, as every refusal does, never with a stack trace. A
negative number reads as an option: a positional one goes after `--` (`nexus metric record delta -- -5`), an option's
with `=` (`--warn-below=-5`); the message says so.

`nexus stats --flaky` lists the checks Nexus ran that failed, then passed when run again (`flaky: true` in a queue's
`checks.yaml`, docs/protocol/checks.md, "Checks run by Nexus"), grouped by the test that failed on the first run (its
`failed_tests`); a first run whose failing tests are unknown counts under the check's name, marked "(the check; its
failing tests unknown)". Each group gives how many times, when last (the first run's start, UTC), which check, and the
queues and steps it happened in (`<queue>/<step>`, with `<project>/` in front when several projects are read), most
frequent first. `--since` counts only first runs from that date or time; `--project` reads one project (by default,
like `nexus stats`, every registered project and the one it runs in). It reads only.

`nexus status` prints each step of a queue on a line of its own (id, status, title); a step that names its own
runtime, model or effort ends with them, `[on Codex · gpt-6-luna · low effort]` (what it leaves out is the run's).
The orchestrator's overview adds the same after the step in its `steps:` line, where each step also shows its review
level, `W1 pending (level 2)`, with `, set by the user` for a level the user set.
A step with checks reported gets a line under it with the latest result of each check (a check run again replaces
its earlier result) and its time when it was given: `checks: npm test ok (3 min 10 s), npm run typecheck ok (12 s)`.
The dashboard shows each check's time on the step, and the orchestrator's review notice gives it with the check
(`npm test: ok, 3 min 10 s (548 passed)`); the statistics will read the times from the `check.result` events.
A queue with a planned start gets a line `planned start after A; now: <waiting>` (or `at <local time>`), ending in
`(it starts by itself)` when the plan came due and waits for its checkout or for the limit (`held`); the
orchestrator's overview shows a held schedule the same way (`its time came, now: <waiting>`).

`nexus status`, run by a session with a queue, prints that queue's undelivered notes and records them as read
(`note.read`): being shown to the agent is the delivery.
Without a session (or with one that has no queue) it lists the queues at work (running, waiting, stopped), then the
approved ones not running, each with its steps and, when it is not running, the run left behind (`run: halted at W3
(...)`). An orchestrator or a thinking partner gets the overview of every queue instead.

`nexus report <queue> --file <path> --summary <text>` copies the file into `.nexus/queues/<queue>/report.md` (the one
writer of that file; a path that is already that file is left as it is) and records `queue.report` naming the copy, so
the dashboard and the run digest read it there. Workers may not write under `.nexus` with their file tools
(`protect_nexus`), and a report left in a working tree would block the cleanup of a worktree, so the last step's
prompt asks for the report in the project's **folder for reports**, outside every working tree and repository:
`<system temporary directory>/nexus-reports/<project>/<queue>.md` (`reportFile`; a Codex worker gets that folder as a
writable root). Once copied, a source in that folder is removed; a source anywhere else is kept.

`nexus step done` checks the step's end by the `commits` standard and **warns, never refuses**: in the session's
working directory (when it is a git repository), tracked files with uncommitted changes (untracked files do not count,
nor the thinking partners' notes folder, `conversations.notes_dir`, since the main checkout also holds the user's own
notes), and a HEAD that moved since the step started (the round's `start` in `queues/<id>/git.yaml`) while no
`--commit` is given. The warning names the files or the commits and says what to do; it is printed after `ok:` and
recorded as `warning` on the `step.done` event (the session's own log). Nothing else changes: the step is done.
It **refuses** one thing (queue RVD): in a project with `review_decisions_since`, a step that has neither a review
decision nor the explicit none (`nexus decide <step> … | --none "<why>"`); the refusal says how, and nothing is
recorded. A later round keeps the list it has.

`nexus decide` and `nexus review decide` check what they write against the derivation's own rule before writing it
(`decisionRefusal`: the writer's role, the step's state and round, the decision's version, the rights at that time), so
what the derivation would ignore is refused with its reason instead. `nexus review accept` and `provisional` refuse an
acceptance the decisions hold (`gate`, the rule the derivation applies), naming the open decisions; nothing is written.
`nexus status` gives a step with decisions a line `review decisions: 2 decisions, 1 open (D1)` (a review with no list:
`none declared`), and the orchestrator's overview adds `(review decisions: …)` to a step in review.

`nexus help <topic>` prints one of Nexus's standards (needs no session or project, records nothing); `nexus help`
alone prints the commands and the topics, as do `nexus --help` and `nexus` without a command. The topics live in `packages/cli/src/help.ts`:

| Topic | The standard |
|---|---|
| `review` | Review material: formats, view keys, roles, pairing, rounds, captures, the process |
| `decisions` | A step's review decisions: what the worker declares before `nexus step done` (concrete choices bound to material, or an explicit none, never a hidden one), and who answers them (the review helper, the orchestrator, the user) |
| `summaries` | A step summary (`nexus step done --summary`) in four parts: what changed; how it was verified; what was left out or differs from the plan; what comes next, if anything |
| `context` | A context summary (`nexus context`) in six parts: where the work stands (the step, committed, not committed); the decisions and why, with the ways tried and dropped; the traps found; the important files and why; what comes next; what the orchestrator or the user asked for or promised. It leaves out what a fresh session's seed gives anyway (the queue, the steps' summaries, the briefing, `nexus status`); about 1,000 to 2,000 words at most: `nexus context` records a longer one and prints a warning (`CONTEXT_SUMMARY_WORDS`, 2000 words) |
| `questions` | A question (`nexus ask`) in three parts: what it blocks; the options; the asker's recommendation |
| `refusals` | A refused action: no workaround through another tool or command that reaches the same end; one retry in a simpler form at most; then report what was needed and why |
| `commits` | A clean working tree at every step's end: everything the step did committed (its own files only) and named with `nexus step done --commit`, so every commit belongs to one step |
| `tests` | Running tests while working: only the affected test files, stopping at the first failure (in Nexus's repository `npm run test:files -- <files>`); the whole suite once at the step's end, as the queue's checks (run by Nexus after `nexus step done` where the step's opening says so, else by the worker and reported with `nexus check`); a test that fails now and then is fixed at its cause, not run again until it passes |

The briefings carry these in a few lines each with the pointer: the worker's all seven; the orchestrator's the refusal
rule and the summary and question shapes as it reads them (and escalates in); the thinking partner's the refusal
rule.

Step states also include `stopped` (the step a `queue.stop` named, when it was not finished).

Output is short plain text so it reads well inside an agent's transcript. Exit code 0 on success, 2 on a protocol
violation (with the reason on stderr).
