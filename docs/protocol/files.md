# The `.nexus` files

Part of [the protocol](../PROTOCOL.md).

## Rules

1. **One writer per file.** A session appends only to its own `events.jsonl`. The Nexus server is the only writer of
   `project.yaml`, `queue.yaml`, notes, inboxes and `state.json`. Agents change anything else only by appending an
   event that asks for the change.
2. **Append-only logs.** JSONL files are only appended to, one complete JSON object per line, written in a single
   write. A reader ignores a final line without a newline (it is still being written).
3. **Rebuildable state.** `state.json` is a cache derived from the other files; deleting it loses nothing.
4. **Ids**: queues and steps have short human ids unique in their scope (`W`, `W2b`); sessions, events, notes,
   messages and questions have ULIDs (sortable by time). Times are ISO 8601 UTC.
5. **Versioned.** Every YAML file has `protocol: 1`; every event carries `v: 1`. Readers reject a higher major version.
6. **English** in every file Nexus writes itself. The dashboard shows the user's words verbatim in whatever language
   they were written. What agents write is in the languages of the settings (see ["Languages"](settings.md#languages)).

## Layout

```
<main checkout>/.nexus/                 git-ignored
  project.yaml                          server
  tags.yaml                             server: the project's tag lists (areas, own activities, renames, proposals)
  metrics.yaml                          server: the project's metrics (unit, how shown, target, warning threshold)
  idea-matches.yaml                     server: the user's decisions on matching earlier queues to the notes' entries
  idea-statuses.yaml                    server: user dispositions, assessments, history and observed invalidations
  idea-handoffs.yaml                    server: immutable scoped payloads and delivery attempts/receipts
  orchestrator/summary.md               server: the orchestrator's latest summary for a fresh session (its context care)
  drafts/<queue-id>.yaml                the orchestrator: its queue drafts (also `nexus queue draft --template`)
  recurring/<id>.yaml                   server: a recurring queue (template, values, schedule, standing approval)
  static-analysis.yaml                  server: the static analysis reminder's last time and the user's last no
  clock.json                            server: its latest time, read by `nexus` before it writes (see "Times and order")
  queues/
    <queue-id>/
      queue.yaml                        server: definition, revisions, approvals
      notes/<step-id>/<note-id>.md      server: notes for a step (front matter + body)
      report.md                         `nexus report`: the queue's report, copied from where the worker wrote it
      review/<step-id>/<file>           `nexus review add`: a step's review files, copied from where the worker wrote them
  sessions/
    <session-id>/
      session.yaml                      server: runtime, native id, role, cwd
      events.jsonl                      that session only (through `nexus`)
      inbox.jsonl                       server: messages, answers, notes delivered to it
  uploads/
    <yyyymmdd>-<hhmmss>-<hash>.<ext>    server: pictures added to chat messages (see "Uploads" under "Server API")
  state.json                            server: derived cache
```

Review files are copied here by `nexus review add` (into `queues/<queue>/review/<step>/`, its only writer) and the
event points to the copy by its absolute path; a link stays a URL. Material added before this (a path anywhere in the
project, a worktree or a session's working directory, as the event names it) is shown and served where it is.

## `project.yaml`

The project's own settings and state. A setting that is global with a project override (see ["Global settings"](settings.md#global-settings)
below) is in the file only when the project has its own value of it; absent, it follows the global value. The example
is a project with its own stop conditions, push, threshold, permission mode and Codex approvals:

```yaml
protocol: 1
id: honeycomb
name: Project Honeycomb
root: C:/Code/GameDev/ProjectHoneycomb
follows_global: true                   # this file is in the form below (absent: from before global settings, migrated once)
review_levels_since: 2026-11-14T15:00:00Z   # set once by the server; steps done before it keep their old review policy (see "Review")
defaults:
  stop_conditions:                     # every queue inherits these
    - A decision that is the user's comes up (the look, gameplay, a final number).
    - A required asset is missing.
  push_accepted: true                  # push the commit an accepted step was reviewed at (see "Pushing what was accepted")
  usage_pause_threshold: 0.85          # share of the 5-hour window at which no new step turn starts
  worktree_dir: C:/Code/GameDev/ProjectHoneycomb.worktrees   # project only
  worktree_setup: npm ci               # project only: run once in each new worktree Nexus makes (see "Worktree setup")
  worktree_setup_inputs: ["**/package-lock.json"]   # project only: their change runs the setup again (default: the common lockfiles)
  checks: [npm run lint]               # project only: every step of every queue runs them first (see "The project's checks")
runtimes:
  claude: { permission_mode: auto, allowed_tools: [] }       # allowed_tools: project only
  codex:  { model: null, approval_policy: on-request, approvals_reviewer: auto_review }   # null: its own "none"
  # codex.mcp_servers: [blender]       # project only: the user's Codex MCP servers Codex workers keep (default: none)
conversations:
  notes_dir: Dev/Concepts/Gameplay     # project only
orchestrator:
  session: 01JD...                     # state: its current session id
  effort: high
languages:
  working: en                          # project only (see "Languages")
```

## Notes: `notes/<step-id>/<note-id>.md`

```markdown
---
id: 01JD...
step: W3
from: user                             # user | orchestrator
at: 2026-11-12T10:02:00Z
to: orchestrator                       # optional: only on a note for the orchestrator's review (see below)
---
Keep the debris as it is; only the wall bodies need support.
```

Delivered as part of the step's opening turn. The worker acknowledges with a `note.read` event.

A note the user writes on a step the orchestrator holds in review (status `review`, `review_with: orchestrator`) is
written with `to: orchestrator`. It goes to the orchestrator, never to a worker: the orchestrator is told it once per
project (key `notify:stepnote:<note id>` in any orchestrator session's `applied.jsonl`), like a chat message of the
user, whatever `notify` says and starting it if it has no session, with the queue, the step and the text, and the
instruction to weigh it in its acceptance and send the step back if it asks for a fix. Telling it records a delivery
(`kind: note`) in the orchestrator session's `delivered.jsonl`, so the note shows as delivered. Notes on other steps
behave as before.

## Server-owned runtime files

Written only by the server's queue engine; agents never touch them.

| File | What |
|---|---|
| `queues/<id>/git.yaml` | The HEAD of the queue's checkout around each step's work (`src/gitinfo.ts`): `base` (an auto worktree's: `ref`, the branch or commit it was made from, its `sha`, `at`), `base.branch` (whether `ref` names a branch: only a branch can be merged back into), `merged` (`at`, `into`, `path`, `sha`, `fast_forward`, `by`: `nexus` or `user`, absent on older records), `cleaned` (`at`, `path`, `branch`), `cleanup` (Nexus's cleanup of a done survey run's worktree could not go: `waiting` (`reason`, `since`, `files` (what is left, at most 20), `more`); see ["Cleaning up a survey's worktree"](git.md#cleaning-up-a-surveys-worktree)), `merge` (Nexus merging back by itself: `waiting` (`reason`, `since`: what keeps it, told to the user and the orchestrator; `released`: the queues whose runs Nexus held for this merge back and let go on when it could not go), `reintegrations` (runs of the integration step again since the user's last Merge back), `reintegrating` (when the last was asked for, until the step opens), `queued` (`since`: back from a wait, it could go but another queue holds its base; it waits its turn in the merge train, ordered by when its wait began; see ["The merge train"](git.md#merge-back-and-clean-up))), `setup` (the worktree setup command for the worktree Nexus made: `command` (the last one run), `at` (when the worktree was made), `done_at` (once it succeeded), `failed` (`at`, `reason`: its last failure), `sha` (the HEAD it last succeeded on), `reason` (why it ran last)), `pulls` (the base merged into the queue's branch at step boundaries: `at`, `before`, `base`, `sha`, `from`, `to`, `conflicts`, `setup`; see ["Without a model"](git.md#without-a-model)), `steps.<step>` (rounds, oldest first: `session`, `start` (HEAD when the step opened, or when a send-back reopened it), `started_at`, `end` (HEAD at the end of the turn in which the step got its outcome: done, review, failed or stopped), `ended_at`, `turns` (the HEAD at the start and the end of each turn of the session on the step in this round: `start`, `end`, absent while the turn is open; a turn still open when the round ends ends with it; absent on rounds recorded before, which keep the time windows; see ["Git on the dashboard"](git.md#git-on-the-dashboard)); a sha is null outside a git repository). A continued step keeps its open round. One writer: the server. See ["Git on the dashboard"](git.md#git-on-the-dashboard) |
| `queues/<id>/checks.yaml` | The checks Nexus runs after each `step.done` (`by` per step, its sets of checks with their runs, a dispute and its base run, the fix queue of an accepted failure); the logs under `queues/<id>/checks/<step>/`. One writer: the server's engine. See ["Checks run by Nexus"](checks.md#checks-run-by-nexus) |
| `queues/<id>/push.yaml` | Pushing what was accepted: `review` (per step, the HEAD of the checkout when it entered review: `sha` or null, `finished_at`, `at`), `steps` (per accepted step: `acceptance`, `sha`, `result` (`pushed`, `failed`, `skipped`, `held`), `text`, `at`, `held_by?`), `pushed` (the last success: `sha`, `step`, `at`, `remote`, `branch`), `error` (the last failure until a success). One writer: the server. See ["Pushing what was accepted"](git.md#pushing-what-was-accepted) |
| `queues/<id>/plan.yaml` | The queue's place in the plan (see ["The plan"](planning.md#the-plan)): `by`, `reason?`, `after` (the queues it waits for, each with `queue`, `by`, `at`, `reason?`), `created_at`, `updated_at`, `started_at?`, `proposal?`, `decisions`. One writer: the server; it stays after the queue starts (marked `started_at`), and taking the queue out of the plan removes it |
| `queues/<id>/start.yaml` | The queue's next start as planned (see ["The plan"](planning.md#the-plan) and ["Schedules"](planning.md#schedules)): `at?` (a schedule: the time, ISO 8601; with `usage`, `claude` or `codex`, when that is the usage window's reset plus the margin; without `at`, the options of a start by the plan; `after` only in files from before the plan, moved into `plan.yaml` at the server's start), the start's `runtime?`, `model?`, `effort?`, `session?` (a session to continue), `by` (`user` or `orchestrator`), `reason?`, `revision` (the queue's when planned), `created_at`, `failed?` (`at`, `reason`, `missed?`: it came due and the queue could not start; `missed`: a schedule more than 15 minutes late, the server not running at its time), `held?` (`since`, `kind`: `approval`, `checkout` or `limit`, `reason`: it came due but waits for the approval of the queue's current revision, for its checkout or for a place under the limit, and starts by itself; see ["The plan"](planning.md#the-plan) and ["One queue per checkout, and a limit"](git.md#one-queue-per-checkout-and-a-limit)). One writer: the server; a start of the queue or a cancel removes it |
| `queues/<id>/run.yaml` | The engine's intent for a queue: `session`, `after` (started by the plan: the queues that were done, a list; one id in older records), `state` (`running`, `pausing`, `paused`, `halted`, `finished`, `usage_wait`, `retry_wait`: a turn failed for a passing reason and is tried again at `resume_at`, `approval_wait`: a step ended while a newer revision waits for the user's approval, and the run goes on by itself once approved, see ["A new revision of a running queue never stops the running step"](queues.md#queueyaml); `running`, `pausing`, `usage_wait`, `retry_wait` and `approval_wait` hold the run's session and checkout: `runGoing` in the protocol's `status-rules.ts`), `reason`, the `step` it last opened, `nudged`, `resume_at` (when a usage wait or a retry goes on), `retries` (turns failed in a row for a passing reason; cleared by a turn that ends well or a new step), `failure` (the runtime's code for the failure being retried or that halted the run, e.g. `overloaded`), `resume_after_restart`, `held` (a `running` run held at the limit on queues running at once: `since`, `kind` `limit`, `reason`, also the run's `reason` while held; it opens nothing and does not count, and goes on by itself once a place frees; any other state drops it; see ["One queue per checkout, and a limit"](git.md#one-queue-per-checkout-and-a-limit)), `runtime`, `model` and `effort` (the run's own as its start resolved them: the start's choice, else the continued session's, else the project's effective defaults; a missing model or effort is the runtime's default), `from_defaults` (which of the three came from the project's defaults: resolved again when each step opens; see ["Runtime, model and effort per step"](runtimes.md#runtime-model-and-effort-per-step)), `started_at`, `ended_at` (when it last stopped going: set when it becomes `finished`, `halted` or `paused`, kept while it stays so, removed when it goes on; older files without it fall back to `updated_at`), `summary_asked` (context care: the step whose context summary Nexus asked for; asked once), `switches` (each fresh session, oldest first: `at`, `from` and `to` session, `step` the new session began with, `why`: `context` (context care; a record without `why` is this), `runtime` (the step runs on another runtime), `refactor` (the closing refactoring step, see ["The closing refactoring step"](queues.md#the-closing-refactoring-step)) or `usage` (in the middle of a step, on its fallback: see ["Fallback when usage runs out"](runtimes.md#fallback-when-usage-runs-out)), `fill` of the old one from 0 to 1 and `tokens`, its context tokens, when known (`tokens` since queue CT), `summary`: `written` by the worker, `asked` and then written, or `fallback`), `revision` (the queue's revision the run goes by: written at the start, moved to the current approved one at the end of a step), `checks` (the project's `defaults.checks` as they were at the start, when there were any: every step of the run runs them before the queue's own; see "The project's checks"), `fallbacks` (each step that opened on its fallback, and each that opened on its own values again after one did, oldest first: `at`, `step`, `runtime`, `model`, `effort` it opened on, `from` (its own values), `reason`, `back: true` for a switch back; see ["Fallback when usage runs out"](runtimes.md#fallback-when-usage-runs-out)). Start refuses a `stopped` queue, naming the step and the stop's reason, and writes `revision`; it also refuses while the run holds its session (`approval_wait` included). Resume refuses a stopped or cancelled queue, an unapproved revision unless the run is of an older one (`revision` below the queue's; a run record without `revision` is older when a revision was replaced, in `history`, after its `started_at`: such a run goes on mid-step while the newer revision waits), and an `approval_wait` run until its revision is approved. A run of an older revision is resumed like any: a revision changes no started step. Archived records are `run.<time>.yaml` (see ["Changes and lifting a stop"](queues.md#queueyaml)) |
| `sessions/<id>/runtime.json` | A launched session's live facts: process state (`working` from a turn's start to its end, `idle` between turns, `exited`) and pid, model, context tokens and window, turns, cost; `interrupted` (`at`, `asked`, `handoff?`): a chat turn an update's hand-over cut off, until the next server goes on with it (see ["The chats during an update"](api.md#server-api)); `conversation_saved?` (Claude Code sessions): false from a fresh start until the process shows it read a message (Claude Code saves the conversation then), true after; the next process resumes the session (`--resume`) unless it is false, else starts afresh with the same id (`--session-id`); a record without it (written before queue RN) counts as saved (DESIGN.md, "When Claude Code saves a conversation") |
| `sessions/<id>/briefing.md` | A Claude Code session's briefing as its process last started with it (`--append-system-prompt-file`): rewritten at every start, read by the CLI as it starts. One writer: the server |
| `sessions/<id>/delivered.jsonl` | What the server handed to the session (notes put into a step turn, inbox entries injected or sent as a turn, or `carried` into the first turn of the session `to` that took over); counts as read |
| `sessions/<id>/refusals.jsonl` | One line per action the agent wanted but was refused: `at`, `session`, `runtime`, `by` (`permissions`: Claude Code's permission mode or rules; `nexus`: Nexus declined a Codex approval request; `auto_review`: Codex's auto reviewer), `tool` (Claude Code's tool name; for Codex `command`, `file_change`, `network`, `mcp`, `permissions`, …), `input` in short (the command, path or host, at most 300 characters), `reason` when the runtime gave one, `ref` (the runtime's id for the call: one record per refusal), `queue`, `step` |
| `sessions/<id>/activity.jsonl` | A condensed record of the agent's stream: turns, tool calls, texts (clipped to 600 characters), tool errors, exits, and retries (`retry`: the runtime's own and the engine's), tagged with queue and step |
| `sessions/<orchestrator>/applied.jsonl` | The server's result for each orchestrator request (`queue.drafted`, `session.request`, `status.set`), and the notices it has sent the orchestrator; the CLI waits for the result and prints it. Its context care's records: `context:asked` (its summary asked for; `message`: the context fill then, 0 to 1; `tokens`: its context tokens then, since queue CT) and `context:first` (a fresh session's context tokens at the end of its first turn; before queue CT its fill, 0 to 1, read as that share of the window); see ["The orchestrator's context care"](orchestrator.md#the-orchestrators-context-care) |
| `sessions/<orchestrator>/chat.jsonl` | The chat shown in the dashboard: the user's messages, the orchestrator's texts (whole, however long) and tool calls, Nexus notices. Append-only: an entry's **line** is the index from 0 of its line in the file (blank and broken lines counted, never shown), and stays its line for good |
| `sessions/<orchestrator or conversation>/pins.json` | The chat's pinned messages: `{ pins: [{ line, at }] }`, `line` the message's line in that session's chat.jsonl, `at` when it was pinned; in chat order. A tool line cannot be pinned. A fresh session (a new orchestrator conversation) starts without pins; the old session's file stays with it. One writer: the server, on `POST …/sessions/:session/pins` from the dashboard |
| `<NEXUS_HOME>/settings.yaml` | The global settings, which projects follow where they have no value of their own (see ["Global settings"](settings.md#global-settings)) |
| `<NEXUS_HOME>/usage.json` | The subscription's windows (5-hour, 7-day: utilization and reset time) from the latest `rate_limit_event` (Codex: `account/rateLimits`) of any session. Every session's turns count toward usage, workers', orchestrators' and thinking partners' alike (one subscription), so the usage display and the usage pause see them all |
| `<NEXUS_HOME>/turns.jsonl` | One line per agent turn of every project and role, appended by the server (AgentHost, its one writer) when the turn ends, or when its process ends first: `v`, `at` (the end), `started_at` (the runtime's turn start, or the first thing it streamed after the previous turn's end), `duration_ms`, `project`, `session`, `role` (`worker`, `orchestrator`, `conversation`, `helper`), `runtime`, `model`, `effort`, `queue` and `step` (a worker's run, when any), `tags` (that step's tags as planned when the turn ended: its own over its queue's, renamed names read as the new ones; absent when it has none, see ["Tags"](stats.md#tags)), `fallback` (a turn of a step that runs on its fallback: `from`, the runtime it would have run on, and `reason`, its full window; see ["Fallback when usage runs out"](runtimes.md#fallback-when-usage-runs-out)), `outcome` (`ok`; a failure's kind `passing`, `lasting` or `usage`, with `failure`, the runtime's code; `interrupted`: no result, because Nexus interrupted the turn or its process ended: a kill, an update's drain, a crash), `tokens` (the turn's own, its main loop's: `input` not from the cache, `output`, `cache_read`, `cache_creation`), `subagent_tokens` (what the turn's sub-agents used, in the same four figures, apart from `tokens`: Claude Code turns only, zeros when none ran; absent where unknown: a Codex turn, the first turn of a resumed process, an older record; read from the growth of `result.modelUsage`, the process's running total, less `result.usage`, see DESIGN.md "Sub-agent tokens"), `cost_usd` (the turn's own, where the runtime reports cost and it is known: Claude Code, not the first turn of a resumed process), `windows_start` and `windows_end` (the turn's runtime's usage windows, `utilization` and `resets_at`, as the server knew them when the turn began and ended; left out when none was known). In one file because the windows are the account's, across projects; statistics are computed from it when read. A turn's use of the windows is estimated when read (`usageEstimates`, `packages/protocol/src/usage-estimate.ts`, free of Node): per window, the window's growth between the turn's two readings times the turn's weighted tokens (sub-agents' included) over the weighted tokens of every turn of the same runtime within that stretch, each overlapping turn with the part of its tokens spent within it; `{ share }` (in utilization, 0 to 1) or `{ none }`: `missing` (no reading at the start or the end), `reset` (the window reset between them), `tokens` (the turn's tokens unknown). The token weights (`TOKEN_WEIGHTS`, by the turn's runtime; any other runtime's `PRICE_WEIGHTS`) and the method: DESIGN.md, "Estimating a turn's use" |
| `<NEXUS_HOME>/away.yaml` | The user's away mode: `current` (`since`, `until`) while on, `past` periods (`since`, `until`, `ended`, `why`: `expired` or `off`). One writer: the server, on `POST /api/server/away` and when a period's time comes. See ["Away mode"](review.md#review) under ["Review"](review.md#review) |
| `<NEXUS_HOME>/capacity.yaml` | The capacity coordinator: the workstation, its `heavy` slot, the operations `held` and `waiting` for it, and a full test run `outside` Nexus that keeps it. One writer: the server, anew when it becomes active. See ["The capacity coordinator"](checks.md#the-capacity-coordinator) |
| `<NEXUS_HOME>/limits.json` | `{ max_running: number }`: where the limit on queues running at once was kept before it became the global setting `defaults.max_running` (decided 2026-11-15, queue OP). A server whose `settings.yaml` has no `defaults.max_running` (from before it, or rewritten by an older server) takes a valid value from here into it at its start. The file stays: the server writes the global limit into it with every write of the global settings, so an older server (an update rolled back) reads the current limit. One writer: the server |
| `<NEXUS_HOME>/deploy.json` | `{ push_on_deploy: boolean }` (default `true` when the file is missing). One writer: the server, on `POST /api/server/settings` from the dashboard |
| `<NEXUS_HOME>/deploy-plan.json` | The planned deploy, if any: `plan?` (`id`, either `after` (`project`, `queue`, `step?`: none, the whole queue) or `at` (ISO 8601) with `deadline?`, `ref?`, `by?` (`project`, `session`: the orchestrator that planned it), `created_at`, `warning?`, `waiting_for?` (`queue/step`: the unconfirmed provisional work it waits for), `held?` (`project`, `queue`: the run it holds while it waits), `started?` (`at`, `update`: the id of the update it started)), and the last plan that ended, `ended?` (`plan`, `at`, `why`: `carried-out`, `dropped`, `update-failed` or `cancelled`, `reason`, `by?`). One writer: the server. See ["Planned deploys"](api.md#server-api) |
| `<NEXUS_HOME>/deploy-changes.jsonl` | One line per successful deploy with changes for agents: `key` (`deploy-changes:<new sha>`), `at`, `from`, `to` (full shas), `changes` (`commit`, `text`: the commits' `Agents:` lines, oldest first). One writer: the server that took over (a successor, once per deploy) |

A session launched by Nexus has `launched_by: nexus`, `runtime: claude`, `native_id` (Claude's session UUID, chosen
by Nexus) and the `model` it was started with. A queue may also say `worktree: auto`: Nexus then creates the worktree
and branch when it starts the queue and writes their paths back into `queue.yaml`.

**The project's checks.** A project's `defaults.checks` (project only, a list of commands; empty by default; in Nexus
`npm run lint`) are checks every step of every queue of the project runs, before the queue's own `checks`. A run fixes
them when it starts (`checks` in `run.yaml`): a change of the setting reaches a queue at its next start, not its next
step, and a resume goes on with what its run fixed; a run from before the setting has none. The step's opening lists
them first under "Checks for every step", then the queue's own; a check both name (compared trimmed) is listed and
run once. The orchestrator's review notice counts a missing one like a missing check of the queue. The settings API
stores them trimmed, without empty or repeated entries. The approval view and the queue's details show them before
the queue's own, marked "(project)": the run's while it has one that has not finished, else the setting now.

**Worktree setup.** A project's `defaults.worktree_setup` (project only; none by default; in Nexus `npm ci`) is a
command run once in each new worktree Nexus makes for a queue (`worktree: auto`), so the worktree can build and test
(its own `node_modules`, for example). When Nexus makes the worktree it records `setup` in the queue's `git.yaml`; the
engine runs the command through the shell in the worktree before the run's first step opens (no step opens while it
runs, at most 30 minutes) and records `done_at`. A failure (an exit code other than 0, or the time limit) halts the run
with the reason, `the worktree setup command (<command>) failed: exit code <n>; its output ends: <output>`, and records
it under `failed`; when the run goes on (Continue, resume), the project's command as it is then runs again in the same
worktree. A worktree the queue names by path, an existing one, and the project's own checkout get no setup. A success
records the commit it ran on (`sha`); a change of its inputs (`defaults.worktree_setup_inputs`) since then runs it again
before a check set or after a merge of the base at a step boundary (queue MI): ["The integration step"](git.md#the-integration-step), "Without a
model".

**Merging back by itself and resolving conflicts** (`defaults.merge_back`, `defaults.resolve_conflicts`; global, with a
project override; both off by default, so a new project merges back only by the user's hand until the user turns
them on): with `merge_back`, Nexus merges a queue with a worktree of its own back by itself, when all its steps are
accepted, the merge has no conflict and its integration step's checks pass; with `resolve_conflicts`, the integration
step's worker tries to resolve a conflict with the current base, judged by the checks and the step's review, and only
one it cannot resolve waits for the user (see ["The integration step"](git.md#the-integration-step)). How the base then moves: "Merge back and clean
up".

The event `review.accepted` (`queue`, `step`, `text?`, `to?`), written by the user or an orchestrator, accepts a step
held in `review`.

**Accept with a note** (the user's). The note is optional; empty means a plain accept. `to` says where it went:
- `next` (the default): the next pending step of the queue gets it as a note from the user (`notes/`), delivered when
  that step starts, like any note on a pending step.
- `orchestrator`: the note stays on the event, and the orchestrator is told it once per project, like a chat message
  of the user: it starts an orchestrator that has no session and is told whatever `notify` says (but not while an
  update drains; then after the restart). The key `notify:note:<event id>` in any orchestrator session's
  `applied.jsonl` marks it told, so a reset orchestrator is not told again. The chat shows the note.
- On the queue's last step (no pending step after it) the note always goes to the orchestrator.
An acceptance with a note pushes like any other (see ["Pushing what was accepted"](git.md#pushing-what-was-accepted)).

**Reject** (the user's only, `POST …/steps/:s/reject` with an optional `text`; only on a step waiting for the user's
review). The server writes `review.rejected` as the user's session and pauses the run (`run.yaml`: `state: paused`,
the reason, `rejected: <step>`). Nothing is reverted.
- The step's status is `rejected` (its `reason` is the text). It is never run again.
- The derived queue has `rejection` (`step`, `at`, `text?`, `revision`: the revision current when it came) and is
  `paused`, with the reason, until the user approves a newer revision. Then the rejection lifts.
- Once the rejection lifts, the rejected step counts as closed, like a skipped one (`stepClosed`): it keeps its
  status `rejected` and its reason, start and resume run what is pending, and the queue is `done` when every other step
  is finished (the run ends `finished`).
- The orchestrator is told once per project, like a note on an acceptance: whatever `notify` says, starting it if it
  has no session (key `notify:reject:<event id>`). It proposes what follows as queue revisions for the user's
  approval: a revert as a step, changes to the remaining steps, or a new queue (then the user can stop this one).
- While the rejection holds, start and resume are refused, and nothing of the queue is pushed (no push of an
  acceptance, no Push again). After the approval, resume goes on at the first pending step: a run paused by a
  rejection may resume although it is of an older revision (it takes the new one).
- The orchestrator's approval notice for such a queue says to resume it.

## Removing a project

The user removes a project from Nexus on the server's API, from the dashboard only (`src/removal.ts`); there is no CLI
command for it, and no agent can do it (the write guard refuses a request without the dashboard's `Origin`, a remote
request needs the access token). Two levels, neither touching the project's own files:

- **Remove from Nexus**: the project leaves `<NEXUS_HOME>/projects.yaml`; its `.nexus/` stays, so `nexus project add
  <path>` brings it back as it was (under the id its `project.yaml` has).
- **Delete Nexus's data**: the same, and its `.nexus/` folder is deleted. The request names the project (`name`, as the
  user typed it); the server checks it against the project's name.

Either one only while **nothing runs** in the project; else 409 with the reasons (`blockers`): a run that started and
did not finish (running, pausing, paused, held, waiting for the usage window, a retry or an approval, halted or
stopped) of a queue that is not done or cancelled; a merge back in progress (Nexus waiting on a checkout for a
fast-forward, an integration step asked again) or waiting (`merge.waiting` in `git.yaml`); a deploy planned after a
step or queue of the project; the orchestrator or a thinking partner in a turn; an update under way. Planned and
scheduled starts and open questions do not keep it: they go with the project (and come back with it), and the
confirmation lists them. The worktrees and branches Nexus made stay (they belong to the project's git repository);
the confirmation lists them too.

On a removal the server takes the project off the registry, then out of itself in the same moment (its engine,
orchestrator, thinking partners and merger shut down, their processes ended and waited for; its watcher closed; the
coordinator no longer counts it). An entry taken off `projects.yaml` by hand is dropped the same way. The registry
has two writers, both the user's: `nexus project add` and this removal; each writes the whole file at once (a
temporary file renamed over it).

What Delete deletes is guarded in code: only `realpath(<the project's root>)/.nexus`, only a folder of its own (not a
link or junction, found with `lstat` and checked again by its own real path), only one holding a `project.yaml`, only
of a project registered in this server's NEXUS_HOME under that root, and not when a worktree of one of its queues lies
inside it. A link or junction inside the folder is removed as a link; what it points to is not touched. The folder is
checked again right before it is deleted.

## A project's rules files

Nexus's convention: a project's rules are in its `AGENTS.md` (Codex reads it), and its `CLAUDE.md` pulls them in with
a line `@AGENTS.md` (Claude Code reads `CLAUDE.md` only). The check is pure, from the two files' contents
(`packages/protocol/src/rules.ts`, `checkRules`): `CLAUDE.md` is **linked** when a line `@AGENTS.md` or `@./AGENTS.md`
(surrounding blanks allowed) stands anywhere in it outside code fences.

| Files | State | Who would not see the rules | The fix |
|---|---|---|---|
| both, linked | `linked` | | |
| neither (or only a `CLAUDE.md` that holds nothing but the link) | `neither` | | |
| only `AGENTS.md` | `only-agents` | Claude Code | create `CLAUDE.md` as the line `@AGENTS.md`, in `AGENTS.md`'s line endings |
| only `CLAUDE.md` | `only-claude` | Codex | move `CLAUDE.md`'s content, byte for byte (BOM, line endings), into a new `AGENTS.md` (its link lines left out), and leave `CLAUDE.md` as `@AGENTS.md` with its BOM and line endings; the @imports in the moved text (`@path` outside code), which Codex does not follow, are listed |
| both, not linked | `unlinked` | Claude Code | add `@AGENTS.md` as the first line of `CLAUDE.md` (after its BOM, in its line endings) |

`nexus project add` prints the check's result. The dashboard shows it on the project's page, with the fix as the
user's action: the change is shown (each file's lines removed and added) before it is made. The server
(`apps/server/src/rulesfix.ts`) writes the files and commits nothing; the user commits them. It is refused (409) while
a run in the project's own checkout holds it (a run state of the checkout's, paused included: see "One queue per
checkout"), when either file changed since the change was shown (the check's `version`), when there is nothing to fix,
and when a file to rewrite is not UTF-8. There is no CLI command or event for the fix.
