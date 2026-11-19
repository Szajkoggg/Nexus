# The orchestrator

Part of [the protocol](../PROTOCOL.md).

## The orchestrator

`project.yaml` holds `orchestrator: { runtime, session, model?, effort?, fallback?, notify, context_threshold_tokens }` (`context_threshold_tokens`: see
"The orchestrator's context care"). It runs on `orchestrator.runtime`: `codex` starts it on Codex, any other value
on Claude Code. On Claude Code the orchestrator is a session
launched in the project's checkout with `--permission-mode dontAsk`, allowed only `Read`, `Grep`, `Glob`, `Agent`,
`nexus` and read-only git commands (`git log`, `git status`, `git diff`, `git show`, `git branch`, `git worktree list`)
on both shell tools (`Bash(nexus:*)` and `PowerShell(nexus:*)`, and so on), and `Write(.nexus/drafts/**)` and
`Edit(.nexus/drafts/**)`, and with
`NotebookEdit` and `MultiEdit` disallowed: anything else, writes outside `.nexus/drafts/` included, is refused without
a prompt. (`Write` and `Edit` are not disallowed: a disallow rule would beat the drafts rules.) Its briefing
(appended system prompt) explains its role, the commands and the queue YAML.

On Codex (queue OC, decided by the user 2026-11-16) it is a `codex app-server` thread in the project's checkout, its
briefing the thread's developer instructions, kept to its drafts by a **permission profile** instead of the older
sandbox settings: `thread/start` sends no `sandbox`, its `config` has `default_permissions: "nexus_orchestrator"`,
`permissions.nexus_orchestrator.extends: ":read-only"` and `permissions.nexus_orchestrator.filesystem` granting
`write` on exactly two paths (absolute, with forward slashes): `<.nexus>/drafts` and
`<.nexus>/sessions/<its session>/events.jsonl`, the one file the `nexus` CLI writes for it (Codex sandboxes every
command, the CLI's too). No turn sends a `sandboxPolicy`. So it reads everything and can write neither the project's
root, nor its own `session.yaml` (its role) or inbox, nor any other `.nexus` file, nor the user's (`away.yaml` lives
in NEXUS_HOME); the internet is closed to it (this machine's own addresses are not: DESIGN.md, "An orchestrator on
Codex can be kept to its drafts"). Before its process starts the server creates its `events.jsonl` empty, if missing,
and the `.nexus/drafts` folder: the sandbox grants paths as they are when it starts, and cannot make them. A resumed
thread (`thread/resume`) is sent the same `config` and no `sandbox`, and keeps the profile (probed). Approval policy `never`; web search `disabled`; the user's MCP servers,
plugins and apps off, every one (see ["How the engine runs a Codex session"](runtimes.md#how-the-engine-runs-a-codex-session)). It has no helpers (Claude Code's
subagents): its briefing has it do their work itself. Its thread id is the session's `native_id` once Codex gives it.

The runtime is chosen when a session starts. When `orchestrator.runtime` names another runtime than the current
session's, the next message or notice (between turns: a message sent while a turn runs goes into it, on the old
runtime) starts a fresh session on the new one, since a conversation cannot move between the two: the fresh session
`continues` the old one (which gets `continued_by`), so the dashboard shows the old chat above the new one; a Nexus
line in each chat says so; the old session's unread messages are carried over (`delivered.jsonl`, `via: carried`);
and its first message says what happened and gives `nexus status` and the carried messages. A fresh session of the
context care starts on the active runtime then, too.

**Automatic usage fallback (OC4).** `orchestrator.runtime`, `model` and `effort` are the primary settings.
`orchestrator.fallback` is one optional object `{ runtime: claude | codex, model?, effort? }`, not a chain. Model and
effort omitted mean the runtime's defaults. It is global with a project override as one whole value: absent follows
global, the project's own `null` disables it. Global `null` clears it. Replacing it does not retain the old runtime's
model or effort. Unknown runtimes/keys and unsupported effort values are rejected. Both the global settings API and
`PATCH /api/projects/:id/settings` accept it; `own` and `follow` accept `orchestrator.fallback`.

Between turns, `overThreshold` checks the primary against `defaults.usage_pause_threshold`. If full and the fallback
is free, Nexus selects the fallback. The server keeps `session.yaml.orchestrator_fallback` with `settings` (the JSON
signature of the primary and fallback), `until` (the primary's latest full-window reset), `reason` and `target`
(`runtime`, optional `model`/`effort`). It survives a restart and context care. Lower usage readings do not switch it
back before `until`; a later full-window reset extends it. After that reset, once the primary is free, it returns.
Changing routing settings causes a fresh selection. The primary settings themselves are never overwritten. A timer
wakes at the earliest relevant reset, including when the fallback is free and no notice is waiting.

A runtime change links sessions with `continues`/`continued_by` and uses the most recent `context.summary` in that
lineage, written to `.nexus/orchestrator/summary.md`, plus the current briefing and `nexus status`. It does not ask a
full runtime to spend another turn writing a summary. No summary available: the chat explicitly says so. The seed
is a durable inbox message (`runtime-seed-<session>`), including the old session's unread non-notice messages; they
are marked delivered there with `via: carried`. Notices are regenerated for the new session, using lineage-wide
delivery keys to avoid repetition. With a fallback configured, user messages arriving while the active runtime is
full wait as `say-<id>` inbox messages too. If the fallback also fills, those messages, answers, notes and notices
wait; there is no third runtime. The Codex permission profile is identical for primary and fallback. A Nexus chat
line records both the switch (window, utilization, threshold and reset time) and the return.

The user clarified OC4: two models of one runtime share the same measured quota, so a same-runtime fallback is
allowed in settings but waits on that quota; it does not bypass the threshold or change the active model. Ordinary
same-runtime model changes resume the same session. Without a fallback the existing notification wait and direct
user-message behaviour remain.

- `.nexus/drafts/<queue>.yaml` holds the orchestrator's queue drafts; the orchestrator is its only writer. It writes a
  draft there, uploads it with `nexus queue draft .nexus/drafts/<queue>.yaml` (relative to the project's root, its
  working directory), and keeps the file to edit for later revisions. The server reads only the path it is given.
  The briefing tells it to run `nexus` and git commands with nothing before the command name: `cd …`, a pipe or an
  option before the subcommand (`git -C <path> show`) does not match the rules and is refused, on Bash and PowerShell
  alike. A command that needs only the previous one's success may be chained with it in one call, in the shell's own
  form (`a && b` in Bash, `a; if ($?) { b }` in PowerShell, which has no `&&`; on Codex the same for its shell), short
  enough that the error shows which part failed; independent commands go as separate calls. Under `dontAsk` every
  part of a chain must match a rule, and Claude Code refuses the PowerShell form even then: a refused chain is run as
  its commands, one each (the one retry). The briefings also say how to read: independent reads as parallel tool calls
  (never two builds or test runs at once), a part of a file (Grep with context and a limit, Read with a range; on
  Codex `rg` and a line range) rather than all of it, and a one-off script only by exception and only to read. The
  workers' and the thinking partners' briefings say the same.

- `nexus queue draft <file|->` sends a queue definition (YAML) as `queue.drafted`. The server writes it: a new queue
  becomes `proposed` (or `draft`); a change to an existing queue's steps, checks or stop conditions makes a new
  revision, which needs the user's approval again. A revision changes only what has not started (see "A revision
  changes only what has not started" under `queue.yaml`); a refused draft prints the reason.
- `nexus run <queue> start|pause|resume|stop --reason … [--use-session <id>] [--runtime claude|codex] [--model <m>] [--effort <e>] [--after <queue>... | --next | --at <time>]`
  sends `session.request`; `start --after A [--after C]` puts the queue into the plan, to start when A (and C) are
  done; `start --next` puts it in with none before it (see ["The plan"](planning.md#the-plan)); `start --at "YYYY-MM-DD HH:MM"` (this
  machine's local time; sent as ISO 8601 in `start_at`) or `--at usage-reset` plans it for a time (a schedule);
  `nexus run <queue> cancel-start --reason …` takes it out of the plan (not a queue the user put in).
- `nexus plan propose <queue> [--after <queue>]... --reason …` sends `plan.proposed`: a proposal to the user that
  changes dependencies the user set (see ["The plan"](planning.md#the-plan)).
- `nexus tags propose --area <name> | --activity <prefix:name> [--reason …]` and `nexus tags rename <old> <new>
  [--reason …]` send `tags.proposed` and wait for the server's result; `nexus tags` (any session) prints Nexus's lists
  and the project's, with the renames and the proposals waiting. `nexus tags accept|decline` is refused: the
  decision is the user's (see ["Tags"](stats.md#tags)).
  Starting an unapproved revision is refused.
- `nexus review accept <queue> <step> [--note <text>]`, `nexus review send-back <queue> <step> <what to fix>` and
  `nexus review ask-user <queue> <step> <why>` write `review.accepted` (the note as its `text`), `review.sent_back`
  and `review.asked_user`; `nexus review provisional <queue> <step> [--note <text>]` writes `review.provisional`
  (refused for a step not at review level 3). The CLI refuses them from any session but an orchestrator, and for a
  step that is not waiting for the orchestrator's review. The orchestrator's overview marks a step accepted
  provisionally: waiting for the user's confirmation, confirmed, or with the fix the user asked. `send-back` waits for the server's result and prints it ("sent back to its
  worker as round N", or that the step goes to the user beyond the limit).
- `nexus queue set <queue> [--step <step>] skipped|finished|cancelled|propose-lift --reason …` sends `status.set`
  and prints the server's result: housekeeping (see ["Housekeeping by the orchestrator"](queues.md#queueyaml) under `queue.yaml`). A worker
  session is refused by the CLI.
- With `notify` on, the server tells the orchestrator (starting it if needed) when a worker asks a question, when the
  user approves a revision of a queue ("Queue X revision N approved.", with the instruction to start it, or to resume
  its paused or halted run, also one of an older revision, if the plan puts it next; a running run, or one waiting for the approval, continues by itself: nothing to start), when the user withdraws an approval, when the user lifts a stop with Continue ("The user lifted the stop of queue X with Continue (the stop was: …); its run goes on.", told once), when a run reaches a
  requested pause ("Run of X paused after step S.": a pause asked for by the user or the orchestrator, not a stop now,
  nor the pause of a server restart or of an update), when a step waits for its review ("Step S of queue X is done and
  waits for your review: <summary>", with the step's goal, acceptance, the checks reported this round and those of the
  queue not reported, the review material of the round, the commits, and the commands: accept, send back, ask the
  user, and at review level 3 also `nexus review provisional`; key
  `notify:review:<queue>:<step>:<finished_at>`, once per round and session, also for a step that entered review before
  the session started, so a reset orchestrator is told; a step waiting for it starts an orchestrator that has no
  session), and when a run halts or finishes. Whatever `notify` says, like a rejection, it is told the user's Fix it on
  a step it accepted provisionally (key `notify:fix:<event id>`; "The user asked a fix of step S of queue X, which you
  accepted provisionally: …", with the instruction to draft a revision with a step that fixes it). The chat shows only the fact;
  the instruction goes to the orchestrator alone. Each notice is told once, recorded in `applied.jsonl` (`notify:…`
  keys; approvals and withdrawals by their position in the queue's `approvals` and `withdrawals`, so approving a
  withdrawn revision again is told again). Nothing older than the orchestrator session is told, except a step waiting
  for its review.
- Nothing is held back across a restart. While an update drains, notices wait. Every server, once active, runs one
  pass over every project, as after a change: plain starts, successors after their hand-over, and a predecessor that
  took the port back after a rollback. The same pass runs whenever an update settles: it is up and its push done, it
  failed, or it was cancelled. So what came up meanwhile is told right then, and it starts the orchestrator's turn.
- The orchestrator session that ran `nexus server update` (`update.by`) is told the outcome once, even with `notify`
  off. After the restart: "Nexus was updated as asked: <commit> "<subject>" is up (was <commit>).", with the push
  result. If it failed, before the hand-over or by a rollback: "The Nexus update you ran failed: <reason>. Still
  running: <commit> "<subject>"; the queues it held (…) go on.". The keys are `notify:update:<id>:updated` and
  `notify:update:<id>:failed`, and the successor knows the id and the asker from `predecessor.json`. An update the
  user started tells no orchestrator about itself.
- **What changed for agents.** A commit that changes something agents rely on carries `Agents: <what changed>` in
  its message (a line, possibly wrapped onto the following lines up to a blank line or a trailer).
  - **Collecting:** at a successful deploy (not a rollback), the successor collects these lines from `from..to` with
    local `git log`, and records them in `deploy-changes.jsonl`. Nothing is collected, and the update log says why,
    when `from` is missing (a predecessor older than this), unknown, or not an ancestor of `to`, or when there are
    no lines.
  - **Who gets them:** every project's orchestrator session that is older than the deploy, once, with the key
    `deploy-changes:<to>` in its `applied.jsonl`. A session started after the deploy gets nothing.
  - **When:** with `notify` on, as a notice, which starts its turn. With `notify` off, held: they go in front of the
    next message it gets (the user's, or its update outcome), without waking it, and the key is recorded only then.
    Several held deploys go in together, oldest first.
  - **How:** the orchestrator that ran the update gets them in the same message as its outcome. The user's chat
    never shows them.


### Stopping a chat agent's turn

The stop button of a chat (`POST …/orchestrator/stop`, `POST …/conversations/:cid/stop`; decided by the user on
2026-11-14, queue CH4) is a pure interrupt through the runtime's own control, not a message asking the agent to stop.
The chat gets a Nexus notice "Stopped." at that point; nothing the turn writes after it reaches the chat (texts, tool
calls); the process stays and goes idle; the turn's record in `turns.jsonl` says `interrupted`. Messages the user sent
during the turn that the agent had not taken in go in with the next turn:

- **Claude Code**: the `control_request` `{ subtype: "interrupt" }` on its stream-json input. Claude Code 2.1.323
  answers at once, still writes the text the model had begun, ends the turn with a result `error_during_execution`
  (`terminal_reason: aborted_streaming`), and then runs the `next` messages it had not read as a turn of its own. Nexus
  shows none of it and interrupts that turn as it starts, so those messages are in the conversation before the next
  one. Messages sent while a stop settles wait and go as new turns after it (a stop with unread messages settles 1.5 s
  after the stopped turn's result, or after the result of the turn the CLI started).
- **Codex**: `turn/interrupt`. Codex 0.167.2 drops a message steered into the turn (`turn/steer`) that it had not
  taken in yet (taken in: an `item/completed` of type `userMessage` with its text); Nexus carries such messages, and
  those waiting for the turn to end, into the next turn's message, before its text. A message sent during the stop
  starts that turn at once.

Both were probed live with small models (haiku, gpt-6-luna) on 2026-11-14; the fakes behave so (fake-claude.ts,
fake-codex.ts).

## The orchestrator's context care

The orchestrator is not compacted: it goes on in a fresh session started from a summary it writes on purpose (decided
by the user on 2026-11-15; DESIGN.md, "The orchestrator's context care"). `orchestrator.context_threshold_tokens` (global
with a project override, default 500000) is the number of context tokens (`context_tokens` in its `runtime.json`)
beyond which this happens, at most 80 % of its model's context window (`context_window`). (Before queue CT it was a
share of the window, `orchestrator.context_threshold`; reading ignores that key, unconverted.)

1. **The request.** When the server looks at a change (`Orchestrator.onChange`) and the orchestrator's process is idle
   (between turns) with its context beyond the threshold, it asks once, with a turn: "[Nexus] Your context holds N tokens
   (the threshold is T tokens): Nexus goes on with you in a fresh orchestrator session … Write that summary now with `nexus
   context …`: the decisions made with the user and why, the open items, the plan …, and what you promised the user
   … Then end your turn". It records `context:asked` in the session's `applied.jsonl` (the fill as its `message`), and
   the chat shows a Nexus line. Never while a turn runs; not while the orchestrator's runtime is beyond the usage
   threshold; not while an update drains. Without a known context window, nothing happens.
2. **Meanwhile** nothing else reaches the session: notices and the user's notes wait for the fresh session, and a
   message the user sends shows in the chat and waits in the session's inbox (`say-<id>`, a `message` from the user).
3. **The switch**, once that turn is over (or the process has ended): the summary is the session's latest
   `context.summary` at or after the request. If there is one, the server writes `.nexus/orchestrator/summary.md`
   (replaced whole: a heading, which session wrote it when and at what fill, which session started from it, the text,
   its topics and files). It writes the new `session.yaml` (`continues`) and sets `continued_by` on the old one, marks
   the old session's unread inbox entries (not held notices) `carried` in its `delivered.jsonl`, closes the old process
   and points `orchestrator.session` at the new session. The old chat gets "The orchestrator goes on in a fresh session
   (<id>).", the new one a line that says whether it starts from the summary or, without one, from its current briefing
   and `nexus status` only.
4. **The fresh session's first message**: who it is and why (the old fill); the summary (text, topics, files) or the
   line that there was none; that its briefing (the system prompt, the current one) holds over the summary and the files
   are the truth; the messages carried over (`formatInbox`); and the project's state as `nexus status` shows it in an
   orchestrator's session with --all (`orchestratorOverview` in the protocol's `overview.ts`, which the CLI prints too: every queue and session).
5. **Afterwards** the fresh session is told what no session of its line was told, since the first of them (the
   `notify:…` keys of every session it continues); deploy changes only those after its own start. A fresh session
   whose context is beyond the threshold at the end of its first turn is not switched again (`context:first`): another
   would be no emptier.
