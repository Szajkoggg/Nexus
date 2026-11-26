# Sessions, events and the step turn

Part of [the protocol](../PROTOCOL.md).

## Events: `sessions/<id>/events.jsonl`

Every line:

```json
{"v":1,"id":"01JD...","at":"2026-11-12T10:05:00Z","session":"01JD...","type":"step.started","queue":"W","step":"W3", ...}
```

**Times and order.** Clocks step (an NTP sync, a correction), and a long-lived process may see it late (V8 on Windows
re-reads the system time once a minute), so the server, a `nexus` call and git may disagree for a while
(docs/DESIGN.md, ["Clock steps"](../design/state.md#clock-steps-ordering-by-what-was-seen-not-by-the-wall-clock-queue-fl-plan-fl4)). Two rules keep the order of what happened:

- *A writer never stamps a time earlier than one it has read.* A record's `at` is the wall clock raised to the latest
  `at` the writing process has read in another writer's log (events, inbox, applied) or stamped itself. A time more
  than 15 minutes ahead of the writer's wall clock is not taken up. The server keeps `.nexus/clock.json`
  (`{"protocol":1,"at":"…"}`, its latest time; one writer: the server), written before it hands an agent anything to
  act on; a `nexus` call reads it, and its session's events and inbox, before it writes. A missing file is no error.
- *A reader keeps each log in the order it was written* (one writer per log). Logs merged into one order (the
  sessions' events; the queues' `changes` among them) are sorted by an effective time, each line's `at` raised to the
  previous line's effective time in the same log, then by id (by code unit). Logs written without a clock step sort
  as by (`at`, `id`); one written across a backward step keeps its order. The `at` shown stays as written.

| Type | Fields | Meaning |
|---|---|---|
| `step.started` | `queue`, `step` | The worker begins the step |
| `step.progress` | `queue`, `step`, `text`, `pct?` | A short status line for the dashboard |
| `step.interrupted` | `queue`, `step`, `text` | User only: Stop at once interrupted the worker and paused its run. Closes the current work segment and records the explanation on the timeline; leaves the step without an outcome so Resume can reopen it in the same session. Written by the server to the user's session, never by the worker |
| `review.added` | `queue`, `step`, `items: [{path or url, label, kind?, before?, key?, role?, size?}]`, `round?` | Review material, `kind` = image, sheet, doc, data, link; `before`: the path of the picture this one is compared with; `key` (a view key), `role` (before, mockup, after, variant-a, variant-b, result) and `size` (`width`, `height` in pixels): a keyed picture, always with its `round` (see ["Review pictures"](review.md#review-pictures)) |
| `review.marked` | `queue`, `step`, `path`, `accepted` | User only: a review picture marked accepted (or the mark taken back). A mark only: it does not accept the step |
| `review.commented` | `queue`, `step`, `path`, `text`, `to` (`send_back`, `note`, `orchestrator`), `note_step?` | User only: a comment on a review picture, and where it went (see ["Review pictures"](review.md#review-pictures)) |
| `check.result` | `queue`, `step`, `name`, `ok`, `summary?`, `duration?`, `commit?` | One check's outcome; `duration`: how long it ran, in seconds (optional, non-negative), which is also the metric `check:<name>`; `commit`: the HEAD of the session's checkout when it was reported (see ["Project metrics"](stats.md#project-metrics)). For a step whose checks Nexus runs, the CLI refuses it (see ["Checks run by Nexus"](checks.md#checks-run-by-nexus)) |
| `check.disputed` | `queue`, `step`, `name`, `evidence` | Worker only: a check Nexus ran fails not because of the worker's work, with its evidence (`nexus check <step> <name> --unrelated`); Nexus runs it on the queue's base commit (see ["Checks run by Nexus"](checks.md#checks-run-by-nexus)) |
| `check.decided` | `queue`, `step`, `verdict` (`accept`, `fix`), `reason` | Orchestrator only: its decision on a disputed check Nexus could not run on the base (`nexus check decide`) |
| `step.done` | `queue`, `step`, `summary`, `commit?`, `warning?`, `activities?` | Acceptance met; the step's work is finished. `warning`: what `nexus step done` warned about at the step's end (see the CLI). `activities`: what the worker actually did (`--activities`), from the same lists as a draft (see ["Tags"](stats.md#tags)) |
| `step.failed` | `queue`, `step`, `reason` | The step cannot be finished as written |
| `queue.stop` | `queue`, `step?`, `condition`, `reason` | A stop condition was met; the engine halts the queue. `condition`: the condition met, as the queue words it; `reason`: what happened, short. The derived queue keeps them apart in `stop` (`{ condition, reason }`, until a lift) besides `status_reason` ("<condition>: <reason>"); the stopped waiting item's `text` is the reason and its `condition` the condition. A stop known only as one text (a queue imported as stopped) has no `stop`, and shows its `status_reason` |
| `question.asked` | `queue?`, `step?`, `qid`, `text`, `options?`, `recommended?`, `can_continue` | A question; `can_continue` says whether independent work remains; `recommended`: the asker's recommendation, one of `options` (the CLI refuses another; the state drops it with a warning) |
| `question.withdrawn` | `qid`, `reason` | No longer needed |
| `answer.given` | `qid`, `text`, `escalate?`, `continue?`, `recommended?` | Orchestrator only: an answer, or an escalation to the user with its framing. `continue`: `nexus answer --continue` writes true, `--wait` false, neither leaves it out (whether the asker goes on or waits for more). With `escalate`, `recommended` is the orchestrator's recommendation, one of the question's options; it replaces the asker's on the derived question (`QuestionView.recommended`, and the waiting item's `recommended`), whose button the dashboard marks |
| `note.read` | `note` | A note was received |
| `message.read` | `message` | An inbox message was received |
| `context.summary` | `queue?`, `step?`, `text`, `topics: []`, `files: []` | What a successor or continuation needs to know; written at the end of each step |
| `queue.report` | `queue`, `path`, `summary`, `source_hash?`, `findings?` | The worker's report of the whole queue, written when it ends (done or stopped). `path` is the copy in the queue's folder (`.nexus/queues/<queue>/report.md`), which `nexus report` writes. The CLI records `source_hash` (`sha256:<64 lowercase hex digits>`) from the exact registered bytes, without text normalization; older events may omit it. `findings`: a maintenance queue's number of findings (`--findings`, a whole number from 0; see ["Recurring queues"](planning.md#recurring-queues)) |
| `change.proposed` | `queue`, `patch`, `reason` | Not written by anything today, and it changes nothing in the derived state: a revision of a queue goes through `queue.drafted` |
| `queue.drafted` | `queue`, `definition` | Orchestrator only: a new or changed draft queue |
| `session.request` | `action` (start, resume, pause, stop, cancel_start), `queue`, `use_session?`, `runtime?`, `model?`, `effort?`, `after?`, `next?`, `start_at?`, `reason` | Orchestrator only: asks the engine to act on a queue's run (`use_session` continues an existing session). `start` with `after` (a list of queue ids; one id from an older CLI): put the queue into the plan, it starts when those are done (see ["The plan"](planning.md#the-plan)); with `next: true`: into the plan with none before it; with `start_at` (ISO 8601, or `usage-reset`): start at that time (a schedule, see ["Schedules"](planning.md#schedules)); `cancel_start`: take the queue out of the plan (its predecessors and its schedule) |
| `plan.proposed` | `queue`, `after` (ids), `reason` | Orchestrator only: proposes to the user a new list of predecessors for the queue that changes dependencies the user set (see ["The plan"](planning.md#the-plan)) |
| `tags.proposed` | one of `area`, `activity`, `rename` (`from`, `to`); `reason?` | Orchestrator only: proposes a change to the project's tag lists; the server records it in `tags.yaml`'s proposals and answers in `applied.jsonl` (see ["Tags"](stats.md#tags)) |
| `recurring.set` | `recurring`, `template`, `params`, `every?` or `after_queues?`, `maintenance?`, `reason?` | Orchestrator only: sets a recurring queue (`nexus recurring set`); the server checks it, writes `recurring/<id>.yaml` (taking the standing approval away) and answers in `applied.jsonl`. It carries no approval (see ["Recurring queues"](planning.md#recurring-queues)) |
| `static_analysis.declined` | `reason` | Orchestrator only: the user declined the `static-analysis` template (`nexus static-analysis decline`); the server notes it in `static-analysis.yaml`, rests the reminder for 90 days and answers in `applied.jsonl` (see ["Static analysis reminder"](planning.md#static-analysis-reminder)) |
| `metric.defined` | `name`, `unit?`, `show?`, `target?`, `warn_above?`, `warn_below?` | Orchestrator only: defines one of the project's metrics, or changes it (the whole definition); the server checks it, writes `metrics.yaml` and answers in `applied.jsonl` (see ["Project metrics"](stats.md#project-metrics)) |
| `metric.recorded` | `queue`, `step`, `name`, `value`, `unit`, `commit?` | Worker only (the loader ignores it from any other session): a value of one of the project's metrics for the step, with the metric's unit then and the HEAD of the worker's checkout (see ["Project metrics"](stats.md#project-metrics)) |
| `review.accepted` | `queue`, `step`, `text?`, `to?` (`next` or `orchestrator`) | Orchestrator, user or review helper (the helper only at review level 2; and Nexus itself for a model-free integration it accepts): a step in review is accepted; `text` is the note, `to` where the note goes (see ["Review"](review.md#review), ["The review helper"](review.md#the-review-helper)) |
| `review.sent_back` | `queue`, `step`, `text` | Orchestrator, user or review helper only: a step in review goes back to its worker with what to fix (see ["Sending a step back"](review.md#sending-a-step-back), ["The review helper"](review.md#the-review-helper)) |
| `review.audited` | `queue`, `step`, `accepted`, `verdict` (`agree`, `disagree`), `text` | Orchestrator only: its audit of a review helper's acceptance (`accepted`: that review.accepted's id) it was given; it does not reopen the step (see ["The review helper"](review.md#the-review-helper)) |
| `review.passed_on` | `queue`, `step`, `round`, `reasons`, `text` | Review helper or `nexus` only: the step goes on to the orchestrator's review, with why and the helper's findings (see ["The review helper"](review.md#the-review-helper)) |
| `review.rejected` | `queue`, `step`, `text?` | User only (the loader ignores it from any other session, the orchestrator's included): rejects a step waiting for the user's review (see ["Reject"](runtime-files.md#server-owned-runtime-files)) |
| `review.asked_user` | `queue`, `step`, `text` | The orchestrator's: a step waiting for its review goes to the user, with why. Also the server's from the user's session, when the user sets such a step's level to 1 (see ["The user's level"](review.md#review)): then taken for a step in review whoever its level gives it to, and marked `by: user` |
| `review.provisional` | `queue`, `step`, `text?` | Orchestrator only (the loader ignores the user's too): a step of review level 3 (or 2 while away mode is on) waiting for its review is accepted provisionally, `text` what the user should look at; the run goes on (see ["Provisional acceptances"](review.md#review)) |
| `review.confirmed` | `queue`, `step` | User only: confirms a provisional acceptance |
| `review.fix_asked` | `queue`, `step`, `text` | User only: Fix it on a provisional acceptance; the orchestrator drafts a revision with a step that fixes it |
| `review.decision` | `queue`, `step`, `decision` (`D1`, `D2`, …), `text`, `options` (two or more, each `label`, `effect?`: `fix`), `recommended?`, `material?`, `why?`, `for` (`user`, `reviewer`), `withdrawn?` | The step's own worker while the step is at work, or the orchestrator while it holds the review (the loader ignores any other session's): one decision of the step's review, a new version of it, or its withdrawal (see ["Review decisions"](review.md#review-decisions)) |
| `review.decisions_none` | `queue`, `step`, `text` | The same writers: the step has nothing to decide in its review, with why (see ["Review decisions"](review.md#review-decisions)) |
| `review.decided` | `queue`, `step`, `decision`, `version`, `round`, `choice?`, `text?` | Orchestrator, user or review helper (never a worker): an answer to one review decision; no acceptance (see ["Review decisions"](review.md#review-decisions)) |
| `status.set` | `queue`, `step?`, `to` (`skipped`, `finished`, `cancelled`, `propose-lift`), `reason`, `continued_in?` (with `skipped`: where the step's work went on) | Orchestrator only: housekeeping; the server checks it and records an entry in the queue's `changes` (see `queue.yaml`). A worker's is ignored by derivation, and the server applies only the orchestrator's own requests |
| `ideas.covered` | `refs` (note references, at least one) | Thinking partners only (`nexus covers`): the Decided entries a hand-over passes on; the ideas overview reads them as handed over (see ["Conversations"](conversations.md#conversations)). Another session's is ignored with a warning |
| `log` | `level`, `text` | Anything else worth keeping |

The server validates every event against the writer's role and ignores (and reports) what that role may not do.

**Step times** are derived from these events. A step's `started_at` is its first `step.started`; each `step.started`
opens a stretch at work (`segments` in the state), which ends at the step's `step.done` or `step.failed`, at a
`queue.stop` of its queue, at the run's `ended_at` when the run stopped going with the step still open, or, when the
step is started again without any of these, at the step's last event before the new start. The dashboard shows the
duration from the first start to the end (elapsed while at work) and, for a step started more than once, the working
time as the sum of the stretches (`packages/protocol/src/times.ts`).

## The user's session

The server keeps one session with id `user` and role `user` for what the user does in the dashboard. Its event log
holds the user's answers (`answer.given`). Like an orchestrator, it may write the events workers may not.

The server keeps one more, id `nexus` and role `nexus`, for the steps the engine runs itself without a model (the
integration step, queue MI): see ["The integration step"](git.md#the-integration-step), ["Without a model"](git.md#without-a-model).

## Inbox: `sessions/<id>/inbox.jsonl`

Written by the server, read by the session's adapter or hook. A `message` may name the `queue` and `step` it is
about, so the dashboard shows it on that step. The server **routes answers**: every final `answer.given` (not an
escalation), from the orchestrator or the user, is appended to the asking session's inbox once, with the id
`answer-<event id>`. An orchestrator session that went on in a fresh one (`continued_by`, see "The orchestrator's
context care") has its answers appended to the newest session of that line instead, unless one of them has it already.
The orchestrator gets an answer in its inbox as a turn of its own (or into the running one), once; the chat shows it. It routes send-backs the same way (`send_back`, see ["Sending a step back"](review.md#sending-a-step-back)). A check-fix round of the checks Nexus runs is an entry from Nexus (`check_failed`, see ["Checks run by Nexus"](checks.md#checks-run-by-nexus)). The session records
each entry it has seen with `message.read`; `nexus status` shows the unread ones and records them.

```json
{"v":1,"id":"01JD...","at":"...","type":"message","from":"user","text":"Use the grassland settings for the bench too."}
{"v":1,"id":"01JD...","at":"...","type":"answer","qid":"01JD...","from":"orchestrator","text":"...","continue":true}
{"v":1,"id":"send-back-01JD...","at":"...","type":"send_back","from":"user","ref":"01JD...","queue":"W","step":"W2","text":"Blue, not red.","round":2}
{"v":1,"id":"check-failed-01JD...","at":"...","type":"check_failed","from":"nexus","ref":"01JD...","queue":"W","step":"W2","fix":1,"text":"Check \"npm test\" failed twice (exit code 1). ..."}
```

The schema and the engine also know an inbox entry of type `stop` (delivered even to a run held at its limit), but nothing writes one today: the dashboard's Stop goes through the server directly.
The server records a delivery in the session's `delivered.jsonl` (`kind`, `id`, `via`) once the runtime has accepted the message (stdin write,
`turn/steer` result, or a hook's output); the dashboard shows it as read.

## `session.yaml`

```yaml
protocol: 1
id: 01JD...
project: honeycomb
role: worker                           # worker | orchestrator | conversation | user | nexus | helper
runtime: claude                        # claude | codex | external
native_id: 6f1c...                     # Claude session uuid / Codex thread id
title: ...                             # optional
queue: W                               # optional: the queue a worker (or hand-attached session) works for
model: claude-opus-5-5                 # optional: what Nexus launched it with, kept for resuming
effort: high                           # optional, likewise
archived: true                         # optional: a conversation the user put away
cwd: C:/Code/GameDev/ProjectHoneycomb
branch: v2/cliffs
launched_by: nexus                     # nexus | external
created_at: ...
forked_from: null
continues: 01JD...                     # context care (a worker's, the orchestrator's): the session this one took over from
continued_by: 01JD...                  # context care: the session that took over from this one
about:                                 # a conversation about a step (role conversation only); not `queue`
  queue: W
  step: W3
  seeded: { status: review, at: ... }  # the step's status when the partner last got its context
# a review helper's (role helper): about: { queue: W, step: W3, round: 2, level: 2 }, the step's own level
```

## The step turn

The engine opens each step with one message to the worker:

```
[Nexus] Queue W "Title" (revision 3, approved), step W3 (3 of 7): Support.
Goal: ...
Acceptance: ...
Tags as planned: ...
Checks for every step:                            # the project's checks as the run fixed them, then the queue's own, each once
- ...                                             # followed, where Nexus runs them, by the line saying so (see "Checks run by Nexus")
Review to prepare: <review.prepare>               # only with one, followed by the pointer to `nexus help review`
Stop conditions (meeting one ends the queue: ...): <the queue's own> + <project defaults>
Notes from the user for this step: ...
Answers to your questions about this step: ...
Begin with `nexus step start W3`. End with `nexus step done`, `nexus step failed` or `nexus stop`, then write `nexus context`.
```

The text is fixed (`stepOpening` in `apps/server/src/prompts.ts`; the golden files in `apps/server/test/golden/` show it
whole): it is no project setting. A closing, integration or merged-base step adds its own part, a survey step says it is a
survey, and the last step asks for the queue's report.

## Dashboard question links

The dashboard hash is `#/<project>[/<queue>[/<step>[/<qid>]]]`, with each part
URI-encoded. The optional fourth part selects exactly that question within the
project, queue and step. Waiting cards, sequential navigation, browser notifications
and push notifications preserve it. Legacy project, queue and step hashes keep their
meaning; a plain step link uses its first open question when there is no review.
An answered, withdrawn or absent explicit target is not replaced by another open
question. A question link selects an answer interaction, never a step review approval.

Answer requests remain `POST /api/projects/:id/questions/:qid/answer` with `text`
and `continue`; the answer event and durable inbox entry are saved immediately. Additional answers
to an answered question remain supported; an identical repeated user answer (same text and continuation flag)
is idempotent. Withdrawn and unknown targets are rejected. Routing follows a worker's `continued_by` line too:
undelivered answers move to the current worker's inbox, while already delivered answers are not sent again.

Before a worker's next work in a step, the engine requires every question for that queue and step to be closed:
neither `open` nor `escalated`. This includes questions marked `can_continue`: that flag allows independent work
in the current turn, not a new turn while an answer is outstanding. Partial answers remain unread in the inbox;
they and ordinary messages cannot start or steer work before the final answer. Stop messages remain deliverable.
When released, multiple accumulated answers open one turn together. Resume, restart, a no-outcome nudge and a
step transition obey the same barrier. Questions in other queues or other steps do not block the current step.
A withdrawal closes its question for this purpose. The derived step stays `waiting` after a partial answer and
returns to `running` when its last open question closes and continuation is permitted. The latest final answer,
ordered by event time and id, controls the answer permission: `continue: false` holds delivery and all new work
until an explicit Resume, even if earlier partial answers said `continue: true`. The engine records that release
as `answers_resumed` (the released answer event id) in `run.yaml`; automatic retries, updates and restarts never
set it. A newer answer is evaluated afresh. Pause, stop, review and revision approval are separate gates.
Once all gates allow delivery, accumulated answers and ordinary messages open one turn, with each answer's qid.
Answers wait for the asking turn to end, so it can record more questions. The engine rechecks disk state at the
delivery boundary. Delivery records are appended only after a send, including fallback handovers; if a new question
holds a handover, messages remain unread in the replacement session. No previous log is rewritten.

## The `nexus` command inside agents

The server writes `<NEXUS_HOME>/bin/nexus.cmd` (for cmd and PowerShell, where npm's `.ps1` shim is blocked when
scripts are disabled, as in Codex's shell) and `<NEXUS_HOME>/bin/nexus` (for Git Bash), both running this checkout's
CLI with the server's Node, and puts that directory first on every launched agent's `PATH`.
