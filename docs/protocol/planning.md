# Plan, schedules, templates and recurring queues

Part of [the protocol](../PROTOCOL.md).

## The plan

The plan says which queue starts after which. A queue is in it when it has a place: `queues/<id>/plan.yaml` (the
queues it waits for; none: "starts as soon as it may"), or a schedule in `queues/<id>/start.yaml` (see "Schedules").
Nexus starts by itself only a queue in the plan; an approved queue outside it waits. The user puts a queue into the
plan from the dashboard (the start form's "When"), the orchestrator with `nexus run B start --after A [--after C]...`
or `--next` (none before it). Both carry the options of a start (runtime, model, effort, a session to continue), kept
in `start.yaml`.

- `plan.yaml`, written only by the server: `by` (who put the queue into the plan), `reason?`, `after` (each queue it
  waits for: `queue`, `by` (`user` or `orchestrator`: who set it), `at`, `reason?`), `created_at`, `updated_at`,
  `started_at?` (it started since, by the plan or directly: the plan is used, and stays for the view until the queue is
  planned again; a start of a queue in the plan marks it), `proposal?` (the orchestrator's proposal: `at`, `after`, the
  whole new list, `reason`), `decisions` (the user's decisions, oldest first: `at`, `kind` (`accepted`, `declined`,
  `handed_back`, `removed`, `undone`), `after?` and `reason?` (the proposal's), `queues?` (those handed back, or the
  one taken away), `set_by?` (removed: who had set it), `change?` (removed, undone: the change), `undid?` (undone:
  `move`, `add` or `remove`)), `undo?` (a change of the user's that can still be undone, below: `change`, `kind`,
  `queue` (the queue it was made to), `at` (when it was written: the file's `updated_at`), `until` (the end of its
  window), `plan` (the file before it, or null), and on `queue`'s file `files` (every queue whose plan it wrote) and,
  for a move, `start` (its `start.yaml` before, or null)).
- It starts when every queue in `after` is done, and its current revision is approved (a revision of the queue
  proposed meanwhile waits for the user: the start is `held` with kind `approval`, "waits for approval of revision N",
  and comes once approved; it is not a failed start). "Done" is the queue's status `done` with every step closed (done
  or skipped; the closing refactoring step too) and, in a project whose `provisional_counts` is off, no provisional
  acceptance waiting for the user's confirmation. With the project's `merge_back` on, a predecessor in a worktree of
  its own (one with an integration step; not a survey run) is done only once its work is merged back into its base:
  `git.yaml` `merged` recorded, and not from before its integration step last finished (a Fix it after the merge back
  runs it again). So the queue after it starts from the base with that work in it (a worktree of its own is made from
  the project's checkout). Until then the entry waits with "queue A is done; it waits to be merged back into main",
  followed by what keeps the merge back (`merge.waiting`, "…: queue A: the checkout of main has uncommitted
  changes…"), and is `blocked` while such a reason stands (else Nexus is at it); the dashboard's plan and `nexus status`
  ("now: …") show it. With `merge_back` off the user merges back with Merge back when they choose: such a predecessor is
  done when it finishes, as one in the project's own checkout always is. A queue whose predecessors are all done
  already starts at once (if its checkout and the limit allow, see ["One queue per checkout, and a limit"](git.md#one-queue-per-checkout-and-a-limit); else it waits
  and starts by itself).
- A predecessor that halts, pauses or waits for an approval: the queue waits, `blocked` (on the user or the
  orchestrator). One that is stopped, cancelled or does not exist: the queue waits too, the user gets an attention
  item of kind `plan` ("Queue B waits, but queue A is stopped: …"; `plan.predecessor`, `plan.cause`), and the
  orchestrator is told once ("Queue B waits in the plan, but …"). Dependencies reach no other project.
- Setting a queue's predecessors replaces its list. Refused: a queue after itself, an unknown or cancelled
  predecessor, a loop through the plans (following every predecessor of every unused plan: "that would be a loop in
  the plan: B waits for C, C waits for B"), a queue that is done, cancelled or running, an effort the runtime does not
  take, a session that is not a worker session Nexus launched. The queue need not be approved yet.
- A dependency the user set is the user's. The user's list is wholly theirs (every entry `by: user`). The
  orchestrator's list must keep every predecessor the user set (refused otherwise: "queue C waits for A by the user's
  decision: you may not change that; keep it (--after A), or propose the change to the user: …"); entries it keeps
  stay as they were, new ones are its own. The orchestrator may not take out of the plan (`cancel-start`) a queue the
  user put in or made wait. Its own dependencies it changes freely.
- The user reorders the plan as a list (decided 2026-11-14; `POST …/queues/:q/plan` with `move`, from the
  dashboard's "After…" or by dragging): moving B after Y makes Y B's only predecessor, and every queue whose unused
  plan waited for B waits for B's old predecessors instead (keeping its other ones; no repeats), those entries the
  user's; `after: null` puts B first, with none before it. B's start options stay; a schedule goes. Refused like a
  plan (B done, cancelled or running; Y unknown or cancelled; B after itself; a loop in the plan as it will be). A
  move can be undone (below), and B, ready after it, starts once the undo window has ended.
- The user adds or takes away one predecessor (`POST …/queues/:q/plan` with `add` or `remove` and `after`, from the
  dashboard's "Also after…" and a line's details): the others stay as they are. An added one is the user's ("set by
  you"); `add` is refused for a queue not in the plan (put it in with `move`) and for one it waits for already, and
  like a plan (unknown or cancelled, a loop). `remove` takes away any predecessor, whoever set it, and is the user's
  decision: recorded as `removed` (with who had set it) and told to the orchestrator once. While the plan counts (not
  started since), the orchestrator may not put a predecessor the user took away back itself ("the user took A out of
  the predecessors of queue C: you may not put it back; …"); it proposes it, and a proposal that puts one back counts
  as changing the user's. With no predecessor left the queue stays in the plan and starts as soon as it may.
- A `move`, an `add` and a `remove` can be undone for 12 s (the dashboard offers it for 10 s; the rest is the
  request's way): the answer names the change (`undo.change`), the window's end (`undo.until`) and the queues whose
  plans it wrote; each of those plan files keeps `undo` with the file as it was before, so the window survives a
  restart. None of those queues starts before the window ends, even if the change made it ready. `undo` with
  `change` puts every one of those plan files back as it was (the predecessors with who set each, the orchestrator's
  too), and a move's `start.yaml` (a schedule armed again); the queue it was made to records `undone` (`undid`), told
  to the orchestrator once. Refused (409) once the window has ended, when one of those plans changed since (another
  write: its `updated_at` is not the change's `at`, or its `undo` is another change's), or when one of those queues
  started since.
- To change the user's, the orchestrator proposes: `nexus plan propose B [--after X]... --reason …` (event
  `plan.proposed`), the whole new list; refused when it neither drops a predecessor the user set nor puts back one
  they took away ("set it yourself"). A new proposal replaces one waiting. The user gets an item of kind `plan` (`plan.proposal`: `after`, `reason`, `current`)
  and answers with one action (`POST …/queues/:q/plan`): `accept` (the list becomes the proposal's; the entries it
  keeps stay as they were, new ones are the orchestrator's), `decline` (the plan stays), or `hand_back` (a predecessor
  the user set, or all of them, becomes the orchestrator's; a proposal that no longer changes anything of the user's
  goes). Each answer is recorded in `decisions` and told to the orchestrator once. A start of the queue drops a
  waiting proposal.
- A plan that continues a session waits while that session runs another queue, and fires when it is free (A's own
  session is free once A's run is finished): one session never runs two queues.
- At the moment it fires, B starts as a start does: it must not be stopped or have a rejected step. If it cannot
  start, its `start.yaml` gets `failed` and the user an attention item of kind `start` ("Did not start after A: …");
  it is not tried again by itself. Starting B or taking it out of the plan ends it.
- Nothing fires while an update drains: the plans stay in their files, and the next server (or a cancelled update)
  looks at them once it is up. The server looks at the plans after every change to the project's files and 1.5 s
  after it starts.
- When the queues B waits for are done but B's checkout is held by another queue, or as many queues run as the limit
  allows, B waits and starts by itself once it may; `waiting` then says why, e.g. "queue A is done; waits for the
  checkout: queue C runs there". Queues waiting for the same A in one checkout so run one after the other, the plan
  made first first.
- The run B gets records `after` (the predecessors, a list; one id in older records). The state shows on B its `plan`
  (each predecessor with `done`, `waiting`, `blocked`, `cause?`; `used`, `ready`, `approval`, `waiting`, `blocked`)
  and on each predecessor `starts_next`.
- While the user is away (see ["Away mode"](review.md#review)), only the plan's next queues start, and Nexus starts them itself: the
  orchestrator's direct start of a queue is refused unless the queue is in the plan, its predecessors done and it is
  approved, and so is putting an approved queue that is not in the plan into it (an unapproved one may be planned: it
  waits for the user anyway). Its notice when a queue waits for the user lists the plan's next queues with what each
  waits for.
- Before the plan, a chain was `start.yaml` with `after` (one queue). The server moves such a file into `plan.yaml` at
  its start (the predecessor set by whoever made the chain; `start.yaml` keeps the options); until then the state reads
  it as that plan.

## Schedules

"Start B at night", "start B when the usage window resets": a planned start with `at`, in `queues/B/start.yaml`, set
from the dashboard's start form ("When": at a time, or when the usage window resets) or with `nexus run B start --at
…`. A schedule puts the queue into the plan; it replaces the start's options but keeps the queue's predecessors (a
queue with both starts at its time once they are done), and putting the queue after others (`--after`) replaces a
schedule.

- `--at usage-reset` takes the reset time from the latest usage data (`<NEXUS_HOME>/usage.json`) of the runtime the
  start would run on (the session's to continue, else the start's runtime, else the project's default): Claude Code's
  5-hour window; for Codex, of its windows not yet reset, the last to reset among those at or above the pause
  threshold, else the first to reset. The plan's `at` is that time plus the usage margin (60 s), and `usage` names the
  runtime. Without usage data of that runtime the request is refused. A time in the past (more than a minute) is
  refused.
- At its time the queue starts as a start does. Its current revision not approved, it waits for the approval
  (`held`, kind `approval`) and starts once approved. If it cannot start (stopped, …) or its session to continue runs
  another queue (a schedule does not wait), the plan stays with `failed` and the user gets an item of kind `start`
  ("Did not start at 22:00: …").
- More than 15 minutes late (the server was not running at the time; it looks at the plans 1.5 s after it starts), the
  queue does not start: `failed` with `missed: true`, an item for the user, and the orchestrator is told once. Less late,
  it starts.
- At its time, a queue waiting for its approval, whose checkout is held by another queue, or that would pass the
  limit on queues running at once, waits (`held`) and starts by itself once it may; a waiting schedule is never
  missed, however long it waits.

## Queue templates

A template is a queue skeleton with parameters: a queue's YAML (as an orchestrator drafts it) with two more keys,
`template:` and `params:`, and `{{name}}` placeholders in its texts (`packages/protocol/src/templates.ts`).

```yaml
template:
  id: bugfix                   # 1-40 lowercase letters, digits and dashes
  title: Bug fix
  description: Reproduce a bug with a failing test, find its cause and fix it.   # optional
params:
  - name: issue                # lowercase letters, digits and underscores
    description: what goes wrong and how it shows
  - name: area
    description: the part of the project where it shows
    default: the engine        # optional: without one the parameter must be given
title: "Fix: {{issue}}"
coding: true
steps:
  - id: "{{id}}1"
    title: "Reproduce and find the cause: {{issue}}"
    goal: |
      ...
```

- A placeholder is `{{name}}` (spaces inside the braces allowed) in any string value, never in a key. `{{id}}` is
  always there: the queue's id, given when the template is filled (step ids are written `"{{id}}1"`); a parameter may
  not be named `id`. A placeholder that names no parameter is refused when the template is read, since it would stay
  unfilled. A template has at least one step; a top-level `id` in it is ignored.
- Filling puts each value in as it is (a `{{…}}` inside a value is not filled again), takes the defaults for what is
  not given, and drops `template:` and `params:`; the queue's id comes first. Refused: a parameter without a default
  that is not given (named with its description), a parameter the template does not have, a placeholder left unfilled,
  and a result that is not a valid queue definition. The rest of the draft path's checks (tags against the project's
  lists, a queue of that id) apply when the draft is uploaded.
- **A maintenance template** has a top-level `maintenance: survey|fix_small`, its default mode. A step marked
  `maintenance: fix_small` is there only in that mode. Filled in survey mode, the queue leaves those steps out and gets
  `coding: false` (no closing refactoring step); in fix_small mode it keeps them (the marks dropped); either way the
  queue carries `maintenance: <mode>` (queue.yaml; part of what an approval pins when set). The mode is given with
  `--maintenance` (`nexus queue draft --template`, `nexus recurring set`: the project's mode over the template's);
  refused for a template that is not a maintenance one, and a template is refused that marks a step without the
  top-level key, or keeps no step in survey mode. The shipped `maintenance` template surveys `{{scope}}` and, in
  fix_small mode, fixes `{{small_fixes}}` (by default patch-level dependency updates whose checks pass, and typos in
  documentation).
- **A worktree of its own**: a template may carry `worktree: auto` (passed to the queue as any queue key). A survey
  run then works beside the project's checkout without holding it, has no integration step, and its worktree is
  removed once it is done (see ["Cleaning up a survey's worktree"](git.md#cleaning-up-a-surveys-worktree)); in fix_small mode it ends with the integration step
  and is merged back as any worktree queue. The shipped templates carry none: a project decides in its own instance.
  Nexus's own instances (`nexus-templates/nexus-*.yaml`) carry `worktree: auto`; the notes instance reads its ideas
  folder, which git does not track here, in the main checkout by its absolute path (a worktree has no copy of it).
- **Report-only maintenance templates**: `security-audit`, `test-health`, `performance`, `git-hygiene` and
  `lifecycle` have no step marked `fix_small`, so their fix_small mode is their survey (with `maintenance: fix_small`
  on the queue). `git-hygiene` takes the checkouts to look at (`checkouts`, by default the project's root) and the
  places that are never a finding (`never`); its own worktree and branch are never findings. `lifecycle` needs the
  change to look at (`change`: commits or a queue); it has no schedule: the orchestrator's briefing tells it to offer
  the template in one sentence when a queue that touched the project's run control or lifecycle code is done (the
  project's AGENTS.md may name that code; Nexus's names the engine, the scheduler and the runtime adapters).

**Three layers**, weakest first; for the same template id the stronger replaces the weaker:

| Layer | Folder | |
|---|---|---|
| `nexus` | `templates/` in Nexus's repository | shipped with Nexus: `bugfix`, `ui-change`, `spike`, `refactor`, `maintenance`, `static-analysis`, `check-failure` (the fix queue Nexus proposes for an accepted check failure, see ["Checks run by Nexus"](checks.md#checks-run-by-nexus)), and the maintenance templates `dependencies`, `security-audit`, `dead-code`, `test-health`, `performance`, `docs-freshness`, `notes`, `agent-contract`, `git-hygiene`, `lifecycle` |
| `global` | `<NEXUS_HOME>/templates/` | the user's own, for every project |
| `project` | `nexus-templates/` in the project's repository root | versioned with the project and seen by its agents (not under `.nexus/`, which git ignores) |

Every `*.yaml` and `*.yml` file of a folder is read; a file that is not a valid template, or a second file of one
layer with an id already taken there (the first by path is used), is listed as not used, with the reason.

- `nexus template list` (any session, or none: outside a project only the `nexus` and `global` layers) prints each
  template in effect, `bugfix (project, over nexus and global): Bug fix (params: issue [area])` (a parameter with a
  default in brackets), then the files not used.
- `nexus template show <id>` prints its layer and file, what it replaces, its parameters (required, or the default),
  and the file's YAML.
- `nexus queue draft --template <id> [--set name=value]... [--id <queue-id>]` fills it and writes the result into
  `.nexus/drafts/<queue-id>.yaml`, with a comment at the top naming the template and what to complete (the goals'
  details, the project's checks, tags such as the area, the texts in the queue's language); a text of several lines
  is written as a literal block (`|`), as a person writes it, never folded (`>`). It records no event and
  uploads nothing: the orchestrator completes the file and uploads it with `nexus queue draft .nexus/drafts/<id>.yaml`,
  and the queue then goes as any other, through the user's approval. Without `--id` the queue's id is the template's
  id in capitals (letters and digits, at most 12), numbered from 2 when a queue or a draft file has it (`SPIKE2`).
  Refused before anything is written: a missing or unknown parameter, `--set` without `name=value` or given twice, an
  unknown template (or one whose file is not used, with the reason), a queue of that id that exists already, and a
  draft file of that name.

## Recurring queues

A recurring queue is a template (see "Queue templates") with its parameters' values and a schedule. At each time of
the schedule Nexus makes the queue from the template and starts it, while the user's **standing approval** holds: the
user approves a recurring once, and its runs start by themselves as long as it stays as approved.

`.nexus/recurring/<id>.yaml`, written only by the server (`RecurringFile`):

```yaml
protocol: 1
id: weekly                     # 1-16 letters, digits, dashes or underscores
template: maintenance
params: { scope: dependencies }
every: mon 03:00               # daily HH:MM | <mon..sun> HH:MM | monthly <1-31> HH:MM, the server machine's local time
after_queues: 5                # or this instead of every: after every 5 queues of the project that are done
baseline: [A, B]               # after N queues: the queues done when the count began
maintenance: fix_small         # the project's mode for a maintenance template, over the template's
set_by: orchestrator           # or user; with reason
approval: { hash: sha256:..., at: 2026-11-15T10:00:00Z }   # the user's standing approval
paused: true                   # the user paused it
handled: 2026-11-16T02:00:00Z  # the times up to this one have been looked at; the next comes after it
last: { queue: weekly-20261116-0300, at: ..., due: ..., caught_up: ... }  # the last queue it made; caught_up: made up for a missed time
skipped: { due: ..., at: ..., kind: previous, reason: its previous run weekly-20261109-0300 is still stopped }
created_at: ...
updated_at: ...
```

- **Setting it**: `nexus recurring set <id> --template <t> [--set name=value]... (--every "<when>" | --after-queues
  <n>) [--maintenance survey|fix_small] [--reason]` (orchestrator only) records `recurring.set`; the server checks the
  id, the schedule (exactly one of the two; refused: another form, a number outside 1-1000) and that the template fills
  with the values and the mode (refused: a missing or unknown parameter, an unknown template, a mode for a template
  that is not a maintenance one), writes the
  file with the schedule in its one written form (`Mon 3:00` becomes `mon 03:00`) and answers. **Any set takes the
  standing approval away**, whatever it changes: the recurring waits for the user's approval again. A set counts the
  times from then on (`handled` is the set's time), so it never starts a time that has passed.
- **The standing approval's hash** (`recurringHash`) covers the resolved, filled template (after the three layers,
  filled with the recurring's id as the queue id), the values, the schedule, the effective maintenance mode and
  `coding`, hashed as JSON with sorted keys. Switching survey to fix_small (or back) thus asks for the approval again.
  A project template that replaces the shipped one with other content, a deploy that changes the shipped one,
  an edited project or global template, another value or schedule: each gives another hash, and the approval no
  longer holds (the state shows `needs_approval`) until the user approves again. The approval is the user's action
  (`POST /api/projects/:id/recurring/:rid`, `approve`); no CLI command or event approves, pauses or removes one, and
  `nexus recurring approve|pause|resume|remove` are refused from every session.
- **At each time** the server looks again, and makes and starts the queue only when the recurring is not paused, its
  template resolves and fills, its standing approval's hash is the hash it has at that moment, the time is not missed,
  and its previous run has closed. Otherwise the time passes without a run and `skipped` says why: `approval`,
  `template`, `missed`, `previous` or `failed`. A paused recurring's times pass without a record. A monthly day past
  the month's end (31 in November) is the month's last day.
- **The queue** gets the id `<id>-<yyyymmdd>-<hhmm>` (the time, local; `-2`, `-3`, ... when taken), the template filled
  with that id, and goes through the draft path's checks (tags, step ids). It is written approved, with one approval
  of its own revision hash marked `standing: { id, approved_at, hash }` (the recurring, when the user approved it,
  and the hash approved). Then it is put into the plan with no queue before it (`by: user`, the reason naming the
  recurring), so it starts at once or waits for its checkout, the limit or an update as any planned queue.
- **The previous run**: while the last queue it made is not done or cancelled (running, waiting, stopped), a time
  passes without a run (`skipped.kind: previous`), and the user gets an item. A removed queue counts as closed.
- **After N queues** (`after_queues`): it counts the project's queues that are done (removed queues are gone, so they
  do not count) and were not done when the count began (`baseline`), leaving out every recurring's own runs (a queue
  whose approval is marked `standing`), so two such recurrings never start each other. The count begins at the set,
  at the approval, and whenever its N-th queue comes and is looked at (whether a run starts or the time passes for
  one of the reasons above). The server counts at every change of the project. `ProjectState.recurring` shows
  `counted` for it, and no `next_at`.
- **Maintenance runs** (a queue with `maintenance`): the worker's prompt asks for the number of findings with the
  report (`nexus report ... --findings <n>`, 0 when there were none). When the run finishes, the orchestrator is told
  once when the report has findings, with the report's path ("Maintenance queue weekly-20261116-0300 (survey) finished
  with 3 findings. Report: <path>"), to propose a queue to the user from it; without findings the run closes quietly,
  without the usual notice of its end (a halted run is told as any). A survey run is told to change nothing; when one of
  its steps reports its end (done, or waiting for its review), the engine checks once that the step left no commit
  since its round began and no changed tracked file in the queue's checkout (untracked files do not count), and
  otherwise stops the queue with the condition "Nexus: a survey run leaves no commit and no changed tracked file" and
  what it left (a `queue.stop` in the user's session, which the server writes), before the step's review.
- **Missed times are made up for once**: once the server is up (with the planned starts) it looks at each timed
  recurring's times since `handled`. When the latest of those more than 15 minutes ago (`MISSED_MS`, as for
  schedules) is also the latest that passed, it is made up for now: it goes the usual way (paused, template, the
  standing approval's hash, the previous run, each with its own `skipped` reason), as if it had come now, and its run's
  `last` gets `caught_up` (that time, the same as `due`); the plan's reason says "its time … passed while Nexus was not
  running: made up for now". Every older one passes (`missed`, when it would have run; the run made up for clears it,
  as any run does). A time less late than 15 minutes comes now as usual, and every older one is missed. The next
  regular time is unchanged either way. "After N queues" recurrings have no times: a restart changes nothing for them.
  The dashboard shows a run made up for on its "Last run" ("made up for the missed time" and the time), `nexus
  recurring list` too.
- **The state** (`ProjectState.recurring`, `RecurringView`) adds `status` (`approved`, `needs_approval`, `paused`,
  `waiting_previous`, `broken`), the current `hash`, the template's title and layer, `problem` when broken, and
  `next_at`. Attention items of kind `recurring` (`recurring`: its id): one waits for the user's approval ("Recurring
  weekly (Maintenance, mon 03:00) waits for your approval", with `approvable: true`: the waiting list offers Approve),
  cannot run (its template), or a time passed without a run
  while its previous run is still open (with `queue`: that run), after a failure, or missed.
- `nexus recurring list` (any session) prints each with its template, values, schedule, state, next and last run, and
  the last time that passed without one.
- The user pauses it and lets it go on (`pause`, `resume`) and removes it (`DELETE`); the queues it made stay.
- **The dashboard**: "Recurring" on the project's queues (below the plan and the queues in progress and planned) lists
  each with its state, schedule, values, mode, next and last run, and the user's Approve (while it waits for that),
  Pause or Resume, and Remove. "New queue from template" (at the top of the page) picks a template (`GET /api/projects/:id/templates`), takes its parameters (the required ones before it can
  be sent), a maintenance template's mode and the user's own words, and sends them as the user's message to the
  orchestrator (`POST /api/projects/:id/orchestrator/messages`), with the `nexus queue draft --template` command that
  writes the draft; the orchestrator drafts the queue, which waits for the user's approval as any.

### The notes template and reading outside the project

The `notes` template's worker reads the Claude sessions' memory folder (`memory_dir`), which is outside the project. Probed
2026-11-15 (Claude Code, `haiku`, effort low, a temporary project with the folder beside it; about $0.01 in all): in
`--permission-mode auto` the `Read` tool opens a file there; in `dontAsk` it is refused ("denied because the session is
running in don't ask permission mode"). With the rule `Read(//c/<path>/**)` in `--allowedTools` `dontAsk` reads it, and a
`Write` to the same folder is still refused: the rule gives reading of that folder only. So in a project whose
`permission_mode` is not auto, the user adds that rule to `runtimes.claude.allowed_tools` (the dashboard's Allow rule on the
refusal; a template cannot carry it, since a queue has no permission rules and an agent must not widen its own). The
template's stop conditions tell the worker to report a refused read as a finding with the rule to add.

## Static analysis reminder

Nexus ships a `static-analysis` template (`templates/static-analysis.yaml`, for any stack): survey the stack and ask the
user which tools to use, set them up with the existing findings as a baseline, and propose the lines for the project's
`defaults.checks` (which the user sets). While a project has none, its orchestrator is reminded of it once a month.

- **Detection** (`@nexus/protocol` static-analysis.ts, `detectStaticAnalysis`: pure, on a list of the project's files
  and a reader; `listProjectFiles` skips `node_modules`, `.git`, `.nexus`, `Library`, `Temp`, `Logs`, `obj`, `bin`,
  `dist`, `build`, `out`, `.vs`, `.idea`, `UserSettings`, at most 6 folders deep and 20000 files). Stacks: Node (a
  `package.json`), .NET (a `.csproj`, `.fsproj`, `.vbproj`, `.sln` or `.slnx`), Unity
  (`ProjectSettings/ProjectVersion.txt`; its generated projects do not make it .NET). Static analysis: for Node a linter
  config (ESLint, Biome, oxlint, JSHint, TSLint), `eslintConfig` in a package.json or a `lint` script; for .NET
  `EnableNETAnalyzers`, `AnalysisLevel`, `AnalysisMode` or `EnforceCodeStyleInBuild` in a project or
  `Directory.Build.props`, an analyzer package, or `dotnet_diagnostic.` rules in an `.editorconfig` or `.globalconfig`;
  for Unity a DLL whose `.meta` carries the label `RoslynAnalyzer`, an analyzer in a `csc.rsp`, or such rules. A
  project of no known stack is never reminded.
- **The note**: `.nexus/static-analysis.yaml` (`StaticAnalysisNote`), written only by the server
  (apps/server/src/static-reminder.ts): `reminded_at`, the last reminder; `declined` (`at`, `reason`, `session?`),
  the user's last no.
- **The reminder**: the engine looks at its start and then on its clock: when due (a month, 30 days, after
  `reminded_at`, and not before 90 days after `declined.at`) and the project has none, it writes `reminded_at`. The
  orchestrator is told that latest reminder once (also a session started after it), unless the user declined since:
  "This project has no static analysis set up ...", with the instruction to recommend the template in one sentence. A
  project that has static analysis is looked at again a month later.
- **The user's no**: `nexus static-analysis decline --reason "..."` (orchestrator only) records
  `static_analysis.declined`; the server writes `declined` and answers in `applied.jsonl` ("noted: ... no reminder
  until <time>"). `nexus static-analysis [status]` (any session) prints the stacks, what was found, and the note.
