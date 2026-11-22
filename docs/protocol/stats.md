# Tags, metrics and statistics

Part of [the protocol](../PROTOCOL.md).

## Tags

A step's tags are facets, each answering one question (decided 2026-11-14, docs/ideas/tags.md;
`packages/protocol/src/tags.ts`). They are what statistics count by, and the kind will choose the runtime, model,
effort and fallback.

- `kind`: exactly one per step, the dominant kind of thinking: `mechanical`, `code`, `debugging`, `design`,
  `research`, `docs`. What else the step does goes into its activities. A list (or `code, docs`) is refused.
- `activities` (a list): what the step does. Nexus's own: `feature`, `bugfix`, `refactor`, `test`, `performance`,
  `security`, `migration` (data, schema, protocol), `dependency`, `ui`, `i18n`, `capture` (pictures and review
  material), `integration` (merging), `cleanup`, `build` (build and configuration); for games `assets`, `tuning`,
  `content`. A project's own carry its prefix (`hc:terrain`); statistics across projects compare Nexus's only.
- `area`: the part of the project, from the project's list.
- `size`: `S`, `M` or `L`, as planned; the time and use are measured, so estimate and outcome can be compared.
- `origin`: `user`, `maintenance` (a recurring or housekeeping queue; Nexus's own closing and integration steps),
  `orchestrator`, `fix` (a revision after a send-back or the user's Fix it), `ci` (a failing check or a bug found by a
  failure).

Each is optional in `queue.yaml`, so older queues stay valid; the orchestrator's briefing has new drafts always give
kind, size and origin. On the queue they are its steps' defaults: a step inherits each one it does not set (its own
`activities` replace the queue's). The steps Nexus keeps have their own: the closing step `code`, `[refactor]`,
`maintenance`; the integration step `code`, `[integration]`, `maintenance` (area and size: the queue's). Part of what
an approval pins: a step's tags are in its definition, and a queue's are in the revision hash only when set, so a
queue without them hashes as before. A started step keeps its tags (also those it inherits): a draft that would change
them is refused.

No free text: when a queue is drafted, every name must be on Nexus's lists or the project's as they are now; an unknown
one is refused with what to do (`nexus tags propose`), so is one proposed and not yet accepted, and one renamed since
("use the new name"). Tags a revision leaves as they were are not checked again. Files are never checked when read: a
queue with an unknown or renamed name still reads.

The project's lists, `.nexus/tags.yaml` (`TagsFile`), written only by the server: `prefix` (fixed by the first project
activity accepted), `areas` and `activities` (`name`, `at`, `reason?`), `renames` (`from`, `to`, `at`, oldest first),
`proposals` (`id`, `at`, `kind`: `area`, `activity` or `rename`, `name` (the new name), `from?` (a rename's old
name), `reason?`, `session?`) and `decisions` (`at`, `accepted`, `proposal`). Missing: empty lists.

- The orchestrator proposes with `nexus tags propose` or `nexus tags rename` (event `tags.proposed`); the server checks
  it (an area is lowercase words joined by hyphens; a project activity is `<prefix>:<name>` with the project's prefix;
  a new name is on no list, not proposed, not renamed away; only the project's own names are renamed) and adds it to
  `proposals`. Its first list is proposed the same way, and its briefing has it ask the user in the chat once whether
  the list is right, and again when it would extend it.
- Each proposal is an item of kind `tags` in the user's waiting list (`tags`: the proposal; text "New area terrain:
  <reason>", "Rename area engine to core"). Only the user decides (`POST /api/projects/:id/tags/:proposal`, `accept` or
  `decline`): accepting puts the name on its list (or renames the entry and records the rename); either way the
  decision goes into `decisions` and the orchestrator is told once (`notify:tagdecision:<id>`).
- A rename: every reader reads the old name as the new one (`renamedTag`, followed through a chain), in the step views,
  `nexus status` and the turn records; the files that carry the old name are never rewritten, so the history does not
  split. The old name is not used again.

Planned and observed: the orchestrator plans a step's tags; at `nexus step done --activities a,b` its worker says which
activities it actually did (checked like a draft's: a name on no list, or not accepted yet, is refused and nothing is
recorded). `StepView.observed_activities` is what the step's `step.done` events reported, over every round, renamed
names read as the new ones; absent while none was reported. `activityDifference(planned, observed)` gives `both`,
`unplanned` (done, not planned) and `skipped` (planned, not reported); the difference is itself a measure. The worker's
briefing asks for `--activities`, and a step's opening names its planned tags.

Where they show: `StepView.tags` (the step's as they read now), `ProjectState.tags` (the lists), the worker's `nexus
status` (a `tags:` line under each step), the orchestrator's overview (`{kind size}` after each step), and each worker
turn's record in `turns.jsonl`. The dashboard (`apps/web/src/components/Tags.tsx`): the step's details (a Tags section:
kind, size, area and origin, then the activities planned beside those done, planned-not-done struck through,
done-not-planned marked +), the queue card (its own steps' kinds and areas in a quiet line), the project's settings
(a Tags section: the proposals waiting, with Accept and Decline, the areas, own activities and renames, and Nexus's own
lists on request), and the waiting list (a `tags` item has Accept and Decline; on the project's page it opens the
settings). The pure part of the module (`@nexus/protocol/tags`) is free of Node; the proposals and decisions, which
write `tags.yaml`, are in `tag-proposals.ts`.

## Project metrics

What a project measures, beside its checks' times (decided 2026-11-14, docs/ideas/statistics.md;
`packages/protocol/src/metrics.ts`): the orchestrator names the metrics, the workers record their values, and every
value belongs to its step and the commit it was measured at. The statistics' views (queue ST3) and `nexus stats` read
them.

`.nexus/metrics.yaml` (`MetricsFile`), written only by the server: `metrics`, in the order they were first defined,
each `name`, `unit`, `show` (`line`, `bar` or `number`: how the views show it; default `line`), `target?` (the value
aimed at), `warn_above?` or `warn_below?` (the warning threshold, one at most), `at` (when it was last defined) and
`session?` (the orchestrator session). Missing: no metrics.

- The orchestrator defines one with `nexus metric define <name> --unit <unit> [--show …] [--target <n>]
  [--warn-above|--warn-below <n>]` (event `metric.defined`). The CLI checks it and the server checks it again, writes
  it and answers in `applied.jsonl`: a name is lowercase words and digits joined by hyphens, dots or underscores
  (`bundle-kb`, `fps.p95`, at most 64 characters); a unit is one short word (at most 16 characters); numbers are
  finite; one threshold at most. Defining a known name again replaces its whole definition (what it leaves out is
  gone), in its place. A worker cannot define (the CLI refuses it, and the loader ignores the event from any session
  but an orchestrator's or the user's).
- A worker records a value with `nexus metric record <name> <value> [--step <step>]` (event `metric.recorded`, among
  its own events): for its one step at work (`--step` names another of its queue), with the metric's unit as it is
  then and the HEAD of the session's checkout (`commit`; absent outside a git repository). Refused, with nothing
  written: a value that is no finite number, a name the project has not defined (the refusal lists those it has), a
  check's time, no step at work, or any session but a worker's (the loader ignores a `metric.recorded` from any other
  session, with a warning). The orchestrator says in a step's goal what its worker should measure; the worker's
  briefing names the command.
- A check's time is a metric without a definition: `check:<the check's name, as reported with nexus check>`, in
  seconds, from `check.result`'s `duration`; `nexus check` records the HEAD commit with it. The orchestrator may define
  `check:<name>` for a target or a threshold (its unit is `s`, the only one taken). It is never recorded by hand.

Derived: `ProjectState.metrics` is the file; `StepView.metrics` the step's values over every round, oldest first, each
`name`, `value`, `unit`, `at`, `event` (the event's id), `session`, `commit?`, and `warn` (`side`: `above` or `below`,
`limit`) when the value is strictly beyond its metric's threshold as the metric is defined now. A value beyond the
threshold that was recorded after the threshold was defined (and after the orchestrator session began) is told to the
orchestrator once (`notify:metric:<event>`: "Step W3 of queue W: bundle-kb is 900 KB, above its warning threshold of
500 KB (at 1a2b3c4)."), and its review notice lists the round's recorded values ("Metrics recorded this round"), each
beyond its threshold marked. The dashboard does not show metrics yet (queue ST3); `nexus metric list` lists them.

## Statistics

How steps went, by group, for two readers (decided 2026-11-14, docs/ideas/statistics.md): the orchestrator choosing a
model and effort, the user watching the use of the subscription. One computation, free of Node
(`packages/protocol/src/stats.ts`), read by `nexus stats` from the files and by `GET /api/stats` (and the project's
metrics by `GET /api/projects/:id/metrics`) for the Stats views.

- **The steps counted** (`stepStats`): every step with an outcome in its timeline (`step.done`, `step.failed`, a
  `queue.stop` at it), with its worker turns from `turns.jsonl` (`role` worker, its project, queue and step). `rounds`:
  how many times it was reported done; `accepted`: its status is done; `first`: accepted with one round; `decided`:
  accepted, rejected or failed; `stops` and `failures`: its `queue.stop` and `step.failed` events; `work_ms`: the sum of
  its worker turns' `duration_ms` (its own work, never the wait for a review); `model`, `effort`, `runtime`: its last
  worker turn's; `fallback`: a worker turn of it ran on a fallback (`TurnRecord.fallback`); `usage`: the estimated use
  of each window (`<runtime>:<window>`, in utilization, 0 to 1) summed over its worker turns (`usageEstimates`, see
  `turns.jsonl`), and `usage_missing`, its turns without an estimate. `--since` compares its last outcome.
- **Groups** (`statsReport`), by `model`, `effort`, or a tag facet: `kind`, `activity` (a step is in the group of each
  activity it planned or reported), `area`, `size`, `origin`. A step without the facet (older queues), or without a
  worker turn's model, is `untagged`; one with a model and no effort is `default`. A project's own names, its areas and
  prefixed activities, count only within it: across projects they read `<project>/<name>`; Nexus's activities are
  compared across projects as they are.
- **Each group** (`StatGroup`): `steps`; `few` when fewer than 5 (`FEW_STEPS`: read with care); `decided`,
  `first_accepted` and `first_rate`; `avg_rounds` (of the steps reported done); `stops`, `failures`; `median_ms`,
  `p25_ms`, `p75_ms` (the working time of its accepted steps; by size, how the planned size came out); `usage` and
  `usage_missing` (an estimate, and labelled so); `fallback` (steps with a turn on a fallback); by activity also
  `activities`: `planned` (steps that planned it), `observed` (that reported it), `unplanned`, `skipped` (planned, and
  the step reported other activities). Largest group first. Also `runtimes` (of its steps' last worker turns) and
  `usage_steps` (by window, its steps with an estimate in it: what a use per step divides by).
- **The report** (`StatsReport`): `by`, `project?`, `since?`, `filter?` (the tag values it was narrowed to: `kind`,
  `activity`, `area`, `size`, `origin`, one each; a step passes when it is in that facet's group of the value),
  `steps`, `groups`, `total` (every step counted, once, as one group keyed `all`) and `facets` (by facet, the values the
  steps in the range and project have before the tag filter, sorted: what the view's filters offer).
- **The windows day by day** (`usageDays`, `GET /api/usage/days`): `days` (local dates of the server, oldest first)
  and `windows`, each `{ runtime, window, kind, values }` for the 5-hour (`kind` `5h`) and weekly (`7d`) windows with
  a reading in the period (Claude Code's first). The readings are every turn's `windows_start` and `windows_end` in
  `turns.jsonl`. A 5-hour window's value is the day's highest reading (null on a day without one); a weekly window's
  the last reading by the day's end, 0 once its `resets_at` has passed, null before its first reading.
- **`nexus stats`** prints a line per group (`statsText`): "- opus: 5 steps; accepted in the first round 3 of 4
  (75 %); 1.2 rounds on average; 1 stop, 0 failures; median work 30 min (25 min to 33 min 45 s); estimated use
  claude:five_hour 1 %; 1 on a fallback", with "(few data)" after a small group's count and a closing line that says
  the use is estimated. It reads the registered projects (and the one it runs in, if not registered) and
  `<NEXUS_HOME>/turns.jsonl`, and writes nothing. `--since` takes a date (from that day's start, local time) or a time.
- The orchestrator's briefing asks it to look at `nexus stats --by model` and `--by effort` (and `--by kind`) before it
  chooses a model or effort other than the kind's, or proposes changing a kind's values, and to cite the figures it goes
  by; a few-data group is no evidence.
