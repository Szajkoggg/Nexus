# Nexus protocol

Status: **draft 1**, `protocol: 1`, 2026-11-12. The concepts behind it are in [DESIGN.md](DESIGN.md).

This is the contract between Nexus, the agents and the user: the files under a project's `.nexus/` directory, the
events agents append, and the `nexus` CLI that writes them. It does not depend on any runtime: anything that can run
a shell command can take part.

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
6. **English** in every file. The dashboard shows the user's words verbatim in whatever language they were written.

## Layout

```
<main checkout>/.nexus/                 git-ignored
  project.yaml                          server
  queues/
    <queue-id>/
      queue.yaml                        server: definition, revisions, approvals
      notes/<step-id>/<note-id>.md      server: notes for a step (front matter + body)
      report.md                         `nexus report`: the queue's report, copied from where the worker wrote it
  sessions/
    <session-id>/
      session.yaml                      server: runtime, native id, role, cwd
      events.jsonl                      that session only (through `nexus`)
      inbox.jsonl                       server: messages, answers, notes delivered to it
  state.json                            server: derived cache
```

Review files are not copied here; events point to them by path (relative to the session's working directory, stored
as absolute) or URL.

## `project.yaml`

```yaml
protocol: 1
id: honeycomb
name: Project Honeycomb
root: C:/Code/GameDev/ProjectHoneycomb
defaults:
  stop_conditions:                     # every queue inherits these
    - A decision that is the user's comes up (the look, gameplay, a final number).
    - A required asset is missing.
    - A step would grow beyond what is written in it.
    - A check that passed before the queue fails and is not fixed within the step.
  review_policy: continue              # continue | wait | orchestrator (see "Review" below)
  review_send_back_limit: 2            # the orchestrator's send-backs of a step before the next goes to the user
  context_reuse_threshold: 0.6         # max context fill to continue a session
  context_care: true                   # above that fill at a step's end, the next step runs in a fresh session
  protect_nexus: true                  # Claude Code workers' file tools may not write under the project's .nexus
  push_accepted: false                 # push the commit an accepted step was reviewed at (see "Pushing what was accepted")
  usage_pause_threshold: 0.9           # share of the 5-hour window at which no new step turn starts
  worktree_dir: C:/Code/GameDev/ProjectHoneycomb.worktrees
runtimes:
  default: claude                      # the runtime a run uses when its start names none
  claude: { model: opus, effort: high, permission_mode: auto, allowed_tools: [] }
  codex:  { model: gpt-6-astra, effort: high, sandbox: workspace-write, approval_policy: on-request, approvals_reviewer: auto_review }
orchestrator:
  runtime: claude
  session: 01JD...                     # its current session id
```

## `queue.yaml`

```yaml
protocol: 1
id: W
title: Variant B made a system
track: cliffs-v2
worktree: C:/Code/GameDev/ProjectHoneycomb      # where the worker runs; `auto` = Nexus creates one
branch: v2/cliffs                      # with `worktree: auto`, the new branch's name
base: null                             # with `worktree: auto`, the commit or branch to start from
revision: 3                            # increases on every change to steps, criteria or stop conditions
status: running                        # mirrors the derived state; the event logs are authoritative for progress
review_policy: continue
stop_conditions:                       # in addition to the project defaults
  - The climb probe finds a way up a wall of two levels or more that two attempts within the step do not remove.
checks:                                # run for every step
  - Core tests (v1 fingerprints unchanged), rock tests, climb probe, bench pictures.
steps:
  - id: W1
    title: Voronoi fracture
    goal: |
      The rock cut into the cells of seed points instead of a lattice of three plane families...
    acceptance:
      - The parallelism measure separates the two characters clearly (canyon well above grassland).
      - Every body closed; the same rock on one thread and many; build time per fixture measured.
    review:
      prepare: Pictures of both characters on the bench, gameplay view first.
  - id: W2
    title: Bodies shaped
    goal: ...
    acceptance: [...]
    review: { prepare: ..., rounds: 3 }
  - id: W3
    title: Fixture sheet
    goal: ...
    runtime: codex                     # optional: claude | codex; this step only
    model: gpt-6-luna                  # optional
    effort: low                        # optional: low, medium, high, xhigh, max (Claude Code); Codex: the model's levels
approvals:
  - revision: 3
    at: 2026-11-12T09:14:00Z
    words: "Rendben, előrehozhatjuk a shadert, illetve a kettes ponttal is egyet tudok érteni."
    hash: sha256:...                   # of the revision's steps, criteria and stop conditions
withdrawals:                           # approvals the user took back before the queue ever ran
  - revision: 3
    at: 2026-11-12T10:02:00Z
    reason: "The art is not ready yet." # optional
    approvals: 1                       # how many approval records there were then
history:                               # previous revisions, kept for the record
  - { revision: 2, hash: sha256:..., replaced_at: 2026-11-12T09:10:00Z }
changes:                               # status changes made through Nexus; written only by the server
  - at: 2026-11-13T09:40:00Z
    kind: lift                         # lift | status | run | proposal (see below)
    by: user_approval                  # user_approval (approving a new revision) | user_continue | orchestrator
    from: stopped
    to: approved
    reason: "the art is missing: W4 needs the cliff textures"   # the stop's own reason, as it was derived
    revision: 3                        # the revision the change was made on
```

A step's `runtime`, `model` and `effort` are part of what is approved. Each one a step leaves out is the run's
(see "Runtime, model and effort per step"). A draft is refused when a step names Claude Code with an effort it does
not take (`ultra`); an effort without a runtime is checked when a run starts.

A queue is runnable only when its latest approval's hash matches its current revision and no withdrawal came
after that approval (a withdrawal's `approvals` is not below the number of approvals). Withdrawing sets the queue
back to `proposed`; the approvals stay as they were, and a later approval makes it runnable again. Only a queue
that never ran can be withdrawn (no `run.yaml`, no step started); a started one is paused or stopped instead.

**Changes and lifting a stop.** `changes` records the status changes made through Nexus, oldest first, written only
by the server; nobody edits statuses in the file. Derivation applies each entry in time order among the events (an
event at the same time goes first), so a later event can still change the status again. A `lift` makes a `stopped`
queue `approved` and its `stopped` steps `pending` again (their reason cleared); a stop before the lift, whether a
`queue.stop` event or a `stopped` status an import wrote into the file, no longer counts. A stop after it does.

Approving a revision of a stopped queue lifts the stop: the server appends the approval and a `lift` by
`user_approval` with the stop's derived reason (`condition: reason` for an event stop, the file's `status_note` for
an imported one), writes the queue `approved`, and archives the queue's `run.yaml` as `run.<time>.yaml` beside it
(the time of archiving in ISO 8601 with `-` for `:` and `.`, e.g. `run.2026-11-13T09-40-00-123Z.yaml`), so a start
begins at the first pending step, which is the stopped step itself unless the new revision says otherwise. An
archived run record is read by nothing; it is kept for the record. Approving a stopped queue whose run is still
going is refused.

**Continue** is the user's other way to lift a stop, for when the cause was outside the queue and no new revision is
needed: only a stopped queue whose current revision is approved (otherwise approving that revision lifts the stop),
and only from the dashboard (`POST /api/projects/:id/queues/:q/continue`; no CLI command, no event). The server
appends a `lift` by `user_continue` with the stop's derived reason, writes the queue `approved`, and goes on: a run
of this revision resumes, reopening the step it last opened in its session with a turn that says the user lifted the
stop (when the orchestrator skipped that step, the next pending one opens); with no `run.yaml` (an imported stop), a
finished run or one of an older revision, the queue starts afresh at its first pending step. The orchestrator is
told once. The dashboard shows the stop with the orchestrator's proposal (`lift_proposal`) beside Continue, and the
queue's and each step's `changes`: who, when, what and why.

**Where a stop is, and the ways out shown.** The queue's view keeps `stop_step`, the step the latest `queue.stop` named
(or, for a queue imported as stopped, its last stopped step), until a lift. While that step is not finished the stop is
"at step W4b"; once the orchestrator skips it, the stop is the queue's: "stopped (the stop came from W4b, now
skipped)" (`stopPlace`). The engine's refusal of start and resume and its halt on a stopped queue name the place and
both ways out: Continue in the dashboard, or approving a new revision. The attention item of a stopped queue (kind
`stopped`, a queue whose status is `stopped`, not a halted run) carries `lift`: `place`, `continue` (the current
revision is approved, so Continue lifts the stop; else approving revision `revision` does) and the orchestrator's
`proposal` (`at`, `reason`) when there is one; its `step` is the stop's step only while that step holds it, and its
time is the later of the queue's last change and the proposal. Such an item is keyed by its queue alone (a skip is no
new notification), and opens the queue, whose stop box has Continue. `nexus status` prints, under a stopped queue,
`stopped<place>; the user lifts it with …` and `proposal to lift (orchestrator, <time>): <reason>`; the
orchestrator's "Waiting for the user" shows the same under the item.

**Housekeeping by the orchestrator** (`nexus queue set`, event `status.set`). The server checks each request against
the derived state and records it as an entry `by: orchestrator` with the request's `reason` and the queue's
`revision`:

| Request | Allowed when | Entry, and what derivation does |
|---|---|---|
| `--step S skipped` | S is `pending`, `stopped` or `failed`, and the queue is not done or cancelled | `kind: status`, `step`, `from` (S's status), `to: skipped`: S becomes `skipped` with the reason; when every step is then done, skipped or failed the queue is `done`. A stop is not lifted by it |
| `finished` | the queue's run is `halted` and every step is done or skipped | `kind: run`, `from: halted`, `to: finished`; the server also writes `run.yaml` `finished` |
| `cancelled` | the queue is not done or cancelled and its run is not `running`, `pausing`, `usage_wait` or `retry_wait` | `kind: status`, `from` (the queue's status), `to: cancelled`: the queue is `cancelled` with the reason; a later stop leaves it so. The user gets a push notification; nothing goes into the waiting list |
| `propose-lift` | the queue is `stopped` | `kind: proposal`, `from: stopped`, `to: lift proposed`: the queue's view carries `lift_proposal` (`at`, `reason`) until a lift, a later `queue.stop` or a later approval |

Refused, with the reason: `done` (work done elsewhere is skipped, with the reason saying where), approving, lifting
a stop (`lift`, `approved`, `running` or `pending` for a queue), reopening a finished step (`pending`, `running`),
skipping a step at work, and any other status. The engine reads a step's status again before it opens a step, so
skipping a pending step of a running queue takes effect: the step is never opened. A cancelled queue is neither
started nor resumed.

**Drafts do not change statuses.** In a draft of an existing queue a step's `status` may be left out or be the one in
the file; any other value refuses the whole draft, listing the steps. A new step has no status or `skipped`. A draft
that leaves out a step that has started or stopped (one with a stretch at work, or a status other than `pending` or
`skipped`) is refused: keep the step and skip it with `nexus queue set`.

## Notes: `notes/<step-id>/<note-id>.md`

```markdown
---
id: 01JD...
step: W3
from: user                             # user | orchestrator
at: 2026-11-12T10:02:00Z
---
Keep the debris as it is; only the wall bodies need support.
```

Delivered as part of the step's opening turn. The worker acknowledges with a `note.read` event.

## Events: `sessions/<id>/events.jsonl`

Every line:

```json
{"v":1,"id":"01JD...","at":"2026-11-12T10:05:00Z","session":"01JD...","type":"step.started","queue":"W","step":"W3", ...}
```

| Type | Fields | Meaning |
|---|---|---|
| `step.started` | `queue`, `step` | The worker begins the step |
| `step.progress` | `queue`, `step`, `text`, `pct?` | A short status line for the dashboard |
| `review.added` | `queue`, `step`, `items: [{path or url, label, kind?}]`, `round?` | Review material, `kind` = image, sheet, doc, data, link |
| `check.result` | `queue`, `step`, `name`, `ok`, `summary` | One check's outcome |
| `step.done` | `queue`, `step`, `summary`, `commit?` | Acceptance met; the step's work is finished |
| `step.failed` | `queue`, `step`, `reason` | The step cannot be finished as written |
| `queue.stop` | `queue`, `step`, `condition`, `reason` | A stop condition was met; the engine halts the queue |
| `question.asked` | `queue?`, `step?`, `qid`, `text`, `options?`, `can_continue` | A question; `can_continue` says whether independent work remains |
| `question.withdrawn` | `qid`, `reason` | No longer needed |
| `answer.given` | `qid`, `text`, `escalate?` | Orchestrator only: an answer, or an escalation to the user with its framing |
| `note.read` | `note` | A note was received |
| `message.read` | `message` | An inbox message was received |
| `context.summary` | `text`, `topics: []`, `files: []` | What a successor or continuation needs to know; written at the end of each step |
| `queue.report` | `queue`, `path`, `summary` | The worker's report of the whole queue, written when it ends (done or stopped). `path` is the copy in the queue's folder (`.nexus/queues/<queue>/report.md`), which `nexus report` writes |
| `change.proposed` | `queue`, `patch`, `reason` | A proposed change to a queue definition (needs a new approval) |
| `queue.drafted` | `queue`, `definition` | Orchestrator only: a new or changed draft queue |
| `session.request` | `action` (start, resume, pause, stop, cancel_start), `queue`, `use_session?`, `runtime?`, `model?`, `effort?`, `after?`, `start_at?`, `reason` | Orchestrator only: asks the engine to act on a queue's run (`use_session` continues an existing session). `start` with `after`: start when that queue is done (a chain, see "Chains"); with `start_at` (ISO 8601, or `usage-reset`): start at that time (a schedule, see "Schedules"); `cancel_start`: cancel the queue's planned start |
| `review.sent_back` | `queue`, `step`, `text` | Orchestrator or user only: a step in review goes back to its worker with what to fix (see "Sending a step back") |
| `review.rejected` | `queue`, `step`, `text?` | User only (the loader ignores it from any other session, the orchestrator's included): rejects a step waiting for the user's review (see "Reject") |
| `review.asked_user` | `queue`, `step`, `text` | Orchestrator only in practice (the loader takes it from an orchestrator or the user): a step waiting for the orchestrator's review goes to the user, with why |
| `status.set` | `queue`, `step?`, `to` (`skipped`, `finished`, `cancelled`, `propose-lift`), `reason` | Orchestrator only: housekeeping; the server checks it and records an entry in the queue's `changes` (see `queue.yaml`). A worker's is ignored by derivation, and the server applies only the orchestrator's own requests |
| `log` | `level`, `text` | Anything else worth keeping |

The server validates every event against the writer's role and ignores (and reports) what that role may not do.

**Step times** are derived from these events. A step's `started_at` is its first `step.started`; each `step.started`
opens a stretch at work (`segments` in the state), which ends at the step's `step.done` or `step.failed`, at a
`queue.stop` of its queue, at the run's `ended_at` when the run stopped going with the step still open, or, when the
step is started again without any of these, at the step's last event before the new start. The dashboard shows the
duration from the first start to the end (elapsed while at work) and, for a step started more than once, the working
time as the sum of the stretches (`packages/protocol/src/times.ts`).

## Server-owned runtime files

Written only by the server's queue engine; agents never touch them.

| File | What |
|---|---|
| `queues/<id>/push.yaml` | Pushing what was accepted: `review` (per step, the HEAD of the checkout when it entered review: `sha` or null, `finished_at`, `at`), `steps` (per accepted step: `acceptance`, `sha`, `result`, `text`, `at`), `pushed` (the last success: `sha`, `step`, `at`, `remote`, `branch`), `error` (the last failure until a success). One writer: the server. See "Pushing what was accepted" |
| `queues/<id>/start.yaml` | A planned start of the queue (see "Chains" and "Schedules"): either `after` (the queue it waits for) or `at` (the time, ISO 8601; with `usage`, `claude` or `codex`, when that is the usage window's reset plus the margin), the start's `runtime?`, `model?`, `effort?`, `session?` (a session to continue), `by` (`user` or `orchestrator`), `reason?`, `revision` (the queue's when planned), `created_at`, `failed?` (`at`, `reason`, `missed?`: it came due and the queue could not start; `missed`: a schedule more than 15 minutes late, the server not running at its time). One writer: the server; a start of the queue or a cancel removes it |
| `queues/<id>/run.yaml` | The engine's intent for a queue: `session`, `after` (started by a chain: the queue that was done), `state` (`running`, `pausing`, `paused`, `halted`, `finished`, `usage_wait`, `retry_wait`: a turn failed for a passing reason and is tried again at `resume_at`), `reason`, the `step` it last opened, `nudged`, `resume_at` (when a usage wait or a retry goes on), `retries` (turns failed in a row for a passing reason; cleared by a turn that ends well or a new step), `failure` (the runtime's code for the failure being retried or that halted the run, e.g. `overloaded`), `resume_after_restart`, `runtime`, `model` and `effort` (the run's own, fixed at its start: the start's choice, else the continued session's, else the project's defaults; a missing model or effort is the runtime's default), `started_at`, `ended_at` (when it last stopped going: set when it becomes `finished`, `halted` or `paused`, kept while it stays so, removed when it goes on; older files without it fall back to `updated_at`), `summary_asked` (context care: the step whose context summary Nexus asked for; asked once), `switches` (each fresh session, oldest first: `at`, `from` and `to` session, `step` the new session began with, `why`: `context` (context care; a record without `why` is this) or `runtime` (the step runs on another runtime), `fill` of the old one from 0 to 1 when known, `summary`: `written` by the worker, `asked` and then written, or `fallback`), `revision` (the queue's revision the run was started on). Start refuses a `stopped` queue, naming the step and the stop's reason, and writes `revision`. Resume refuses a stopped queue too, and a run of an older revision (`revision` below the queue's; a run record without `revision` is older when a revision was replaced, in `history`, after its `started_at`): start the queue instead. Archived records are `run.<time>.yaml` (see "Changes and lifting a stop") |
| `sessions/<id>/runtime.json` | A launched session's live facts: process state and pid, model, context tokens and window, turns, cost |
| `sessions/<id>/delivered.jsonl` | What the server handed to the session (notes put into a step turn, inbox entries injected or sent as a turn, or `carried` into the first turn of the session `to` that took over); counts as read |
| `sessions/<id>/refusals.jsonl` | One line per action the agent wanted but was refused: `at`, `session`, `runtime`, `by` (`permissions`: Claude Code's permission mode or rules; `nexus`: Nexus declined a Codex approval request; `auto_review`: Codex's auto reviewer), `tool` (Claude Code's tool name; for Codex `command`, `file_change`, `network`, `mcp`, `permissions`, …), `input` in short (the command, path or host, at most 300 characters), `reason` when the runtime gave one, `ref` (the runtime's id for the call: one record per refusal), `queue`, `step` |
| `sessions/<id>/activity.jsonl` | A condensed record of the agent's stream: turns, tool calls, texts (clipped to 600 characters), tool errors, exits, and retries (`retry`: the runtime's own and the engine's), tagged with queue and step |
| `sessions/<orchestrator>/applied.jsonl` | The server's result for each orchestrator request (`queue.drafted`, `session.request`, `status.set`), and the notices it has sent the orchestrator; the CLI waits for the result and prints it |
| `sessions/<orchestrator>/chat.jsonl` | The chat shown in the dashboard: the user's messages, the orchestrator's texts (whole, however long) and tool calls, Nexus notices |
| `<NEXUS_HOME>/usage.json` | The subscription's windows (5-hour, 7-day: utilization and reset time) from the latest `rate_limit_event` |
| `<NEXUS_HOME>/deploy.json` | `{ push_on_deploy: boolean }` (default `true` when the file is missing). One writer: the server, on `POST /api/server/settings` from the dashboard |
| `<NEXUS_HOME>/deploy-changes.jsonl` | One line per successful deploy with changes for agents: `key` (`deploy-changes:<new sha>`), `at`, `from`, `to` (full shas), `changes` (`commit`, `text`: the commits' `Agents:` lines, oldest first). One writer: the server that took over (a successor, once per deploy) |

A session launched by Nexus has `launched_by: nexus`, `runtime: claude`, `native_id` (Claude's session UUID, chosen
by Nexus) and the `model` it was started with. A queue may also say `worktree: auto`: Nexus then creates the worktree
and branch when it starts the queue and writes their paths back into `queue.yaml`.

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
An acceptance with a note pushes like any other (see "Pushing what was accepted").

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

### Review

The review policy says what happens when a step is done. It is the step's own (`review.policy`), else its queue's
(`review_policy`), else the project's default (`defaults.review_policy`):

- `continue`: the step is done and the run goes on.
- `wait`: the step is held in `review` for the user; the queue is `waiting`.
- `orchestrator`: the step is held in `review` for the project's orchestrator; the queue is `waiting`. The orchestrator
  accepts it (`review.accepted`), sends it back (`review.sent_back`) or hands it to the user (`review.asked_user`,
  with why). It goes to the user instead when the project has no orchestrator (`project.yaml` has no `orchestrator`)
  or its notices are off (`orchestrator.notify: false`); this is derived, so turning notices off hands every step
  waiting for the orchestrator to the user.

The derived step has `review_with` (`orchestrator` or `user`) while in `review`, `asked_user` (`text`, `at`) after a
hand-over in the current round, and `sent_back` (each `id`, `text`, `at`, `by`, `round`, `delivered`, `to_user?`). Only a step waiting for the user is in the
user's attention list (kind `review`, with the orchestrator's reason as its text when it handed it over); the queue
shows `waiting` in both cases. An orchestrator's `review.accepted` or `review.asked_user` on a step that waits for the
user is ignored (with a warning); the user may accept either. Workers may write none of the three events.

### Sending a step back

One server action (`sendBack` in `packages/protocol/src/actions.ts`) sends a step in review back to its worker, with
who sends it (`orchestrator` or `user`) and the text. The orchestrator's comes from `nexus review send-back` (its
`review.sent_back` event, which the server carries out and answers in `applied.jsonl`); the user's is **Fix it** in
the dashboard (`POST …/steps/:s/send-back`), for which the server writes `review.sent_back` as the user's session, the
text verbatim (it must not be empty). Picture comments (N8.3) are a user's Fix it.

- The orchestrator sends back only a step waiting for its review; Fix it is only for a step waiting for the user.
- The server **routes send-backs** like answers: each accepted one goes once into the inbox of the session that worked
  on the step, as `send_back` (`id` `send-back-<event id>`, `ref`, `queue`, `step`, `text`, `round`, `from`). That
  entry reopens the step: derivation sets it `running` again as round `round` (its `step.done`s so far plus one). The
  engine hands the entry to the same session as the next turn; on a paused or halted run it waits, and the resume
  opens the turn with it. The worker's prompt names the round, the text, the step's criteria, and, for a Fix it,
  that the user's words win over the acceptance criteria where they conflict. No new queue revision is made.
- The orchestrator's send-backs of a step beyond `defaults.review_send_back_limit` (default 2) are not delivered: the
  step goes to the user (`review_with: user`, `asked_user` saying so with the text), and the entry is `to_user`. The
  user's Fix it does not count toward the limit.
- After a Fix it the step's next round waits for the user, whatever the policy (`user_fix` on the derived step).

### Pushing what was accepted

With `defaults.push_accepted` on, an accepted step's work is pushed by the server, not by an agent
(`apps/server/src/accepted.ts`):

- When a step enters review, the server records the HEAD of the queue's checkout (its worktree, else the project's
  checkout) in `push.yaml` (`review.<step>`: `sha`, the round's `finished_at`). Recorded with the setting off too, so
  turning it on later finds the commits.
- When a step is accepted (`review.accepted`, by the orchestrator or the user), the server pushes, in the background,
  that commit, never the branch tip: `git push <remote> <sha>:refs/heads/<branch>`. The branch is the queue's
  `branch`, else the checkout's current one; the remote is the branch's upstream, else `origin`. A branch missing on
  the remote is created there. As with the push on deploy: a plain push (git refuses anything but a fast-forward,
  never forced), `GIT_TERMINAL_PROMPT=0` and `GCM_INTERACTIVE=never`, at most 60 s. A commit of the next step made
  before the push is not pushed.
- Only the queue's newest acceptance is pushed; its commit includes the earlier ones. One push at a time per queue;
  an acceptance during a push is taken up after it.
- The outcome goes in `push.yaml` `steps.<step>` (`acceptance`, the event's id; `sha`; `result` `pushed`, `failed` or
  `skipped`; `text`; `at`). A failure also sets `error` (`text`, `at`, `sha`, `step`) until a push succeeds; it does
  not undo the acceptance. It is tried again at the next acceptance, whose commit includes the failed one (which then
  shows as pushed with it), and with **Push again** (`POST …/queues/:q/push`), which pushes the step of `error`
  again. Without a remote (no upstream, no `origin`) nothing is pushed, and the step says so (`skipped`).
- With the setting off nothing is pushed.

## The user's session

The server keeps one session with id `user` and role `user` for what the user does in the dashboard. Its event log
holds the user's answers (`answer.given`). Like an orchestrator, it may write the events workers may not.

## Inbox: `sessions/<id>/inbox.jsonl`

Written by the server, read by the session's adapter or hook. A `message` may name the `queue` and `step` it is
about, so the dashboard shows it on that step. The server **routes answers**: every final `answer.given` (not an
escalation), from the orchestrator or the user, is appended to the asking session's inbox once, with the id
`answer-<event id>`. It routes send-backs the same way (`send_back`, see "Sending a step back"). The session records
each entry it has seen with `message.read`; `nexus status` shows the unread ones and records them.

```json
{"v":1,"id":"01JD...","at":"...","type":"message","from":"user","text":"Use the grassland settings for the bench too."}
{"v":1,"id":"01JD...","at":"...","type":"answer","qid":"01JD...","from":"orchestrator","text":"...","continue":true}
{"v":1,"id":"01JD...","at":"...","type":"stop","from":"user","text":"Stop after this check."}
{"v":1,"id":"send-back-01JD...","at":"...","type":"send_back","from":"user","ref":"01JD...","queue":"W","step":"W2","text":"Blue, not red.","round":2}
```

`delivered_at` is recorded by the server in `state.json` once the runtime has accepted the message (stdin write,
`turn/steer` result, or a hook's output).

## `session.yaml`

```yaml
protocol: 1
id: 01JD...
project: honeycomb
role: worker                           # worker | orchestrator
runtime: claude                        # claude | codex | external
native_id: 6f1c...                     # Claude session uuid / Codex thread id
cwd: C:/Code/GameDev/ProjectHoneycomb
branch: v2/cliffs
launched_by: nexus                     # nexus | external
created_at: ...
forked_from: null
continues: 01JD...                     # context care: the session this one took over from
continued_by: 01JD...                  # context care: the session that took over from this one
about:                                 # a conversation about a step (role conversation only); not `queue`
  queue: W
  step: W3
  seeded: { status: review, at: ... }  # the step's status when the partner last got its context
```

## The `nexus` CLI

The only interface agents use. It finds its session from the `NEXUS_SESSION` and `NEXUS_DIR` environment variables
(set by Nexus when it launches a session, or by `nexus attach` for a session started by hand), validates the
arguments against the protocol and appends one event.

```
nexus status                                   # the current queue, step, notes and unanswered questions, as text
nexus step start W3
nexus step progress W3 "Support graph built; probing fixtures"
nexus review add W3 tmp/review/w3/sheet.png --label "Sheet, round 1"
nexus check W3 core-tests --ok --summary "548 passed"
nexus step done W3 --summary "No floating body on any fixture" [--commit 1a2b3c]
nexus step failed W3 --reason "..."
nexus stop W3 --condition "user decision" --reason "..."
nexus ask "Canyon joints: vertical only, or also inclined?" [--option ...] [--can-continue]
nexus context --topics rock,support --files Runtime/Core/Rock/* <<< "summary text"
nexus report W --file tmp/reports/W.md --summary "..."   # copies the file to .nexus/queues/W/report.md
nexus propose-change W --file patch.yaml --reason "..."
# orchestrator only
nexus queue draft --file queue.yaml
nexus answer <qid> "..." [--escalate] [--continue|--wait]
nexus session start|resume|fork|pause|stop ...
nexus attach                                   # register a hand-started session as external
# setup (the user)
nexus project add <path> [--id] [--name]       # creates .nexus/ (self-ignoring) and registers the project
nexus import <file.md> [--prefix X]            # one-time import of queues written as Markdown tables
nexus note <queue> <step> <text>               # until the dashboard can add notes
```

`nexus status`, run by a session with a queue, prints that queue's undelivered notes and records them as read
(`note.read`): being shown to the agent is the delivery.
Without a session (or with one that has no queue) it lists the queues at work (running, waiting, stopped), then the
approved ones not running, each with its steps and, when it is not running, the run left behind (`run: halted at W3
(...)`). An orchestrator or a thinking partner gets the overview of every queue instead.

`nexus report <queue> --file <path> --summary <text>` copies the file into `.nexus/queues/<queue>/report.md` (the one
writer of that file; a path that is already that file is left as it is) and records `queue.report` naming the copy, so
the dashboard and the run digest read it there. Workers may not write under `.nexus` with their file tools
(`protect_nexus`), so the last step's prompt asks for the report at `tmp/reports/<queue>.md` in the working directory
(or any path outside `.nexus`).

Step states also include `stopped` (the step a `queue.stop` named, when it was not finished).

Output is short plain text so it reads well inside an agent's transcript. Exit code 0 on success, 2 on a protocol
violation (with the reason on stderr).

## The step turn

The engine opens each step with one message to the worker:

```
[Nexus] Queue W (revision 3, approved 2026-11-12), step W3 of W1–W7: Support.
Goal: ...
Acceptance: ...
Checks: ...
Stop conditions: <project defaults> + <queue's own>
Notes for this step (2): ...
Answers to your earlier questions: ...
Report with `nexus`. End the step with `nexus step done`, `nexus step failed` or `nexus stop`.
```

The template is a project setting, so each project can phrase it in its own terms.

## Server API

Reads: `GET /api/projects` (with each project's "waiting for you" list), `GET /api/projects/:id/state`,
`GET /api/projects/:id/file?path=` (files under the project, its worktree directory or a session's directory only).
Live: a WebSocket at `/ws` sends `{"type":"changed","project":id}` and `{"type":"projects"}`.

Writes (JSON bodies only; a request with a foreign `Origin` is refused). Every write is a user action and is taken
only from the dashboard's own page: the request must carry this server's `Origin` and, if it sends one,
`Sec-Fetch-Site: same-origin`; anything else is refused (403). Agents change things through the `nexus` CLI, which
writes files. The only exceptions are `POST /api/server/update` and `POST /api/server/cancel`, which `nexus server`
sends (see the CLI).

| Request | Body | Effect |
|---|---|---|
| `POST /api/projects/:id/queues/:q/steps/:s/notes` | `text` | A note from the user for the step |
| `DELETE /api/projects/:id/queues/:q/steps/:s/notes/:note` | | Withdraws a note not yet delivered |
| `POST /api/projects/:id/sessions/:session/messages` | `text`, `queue?`, `step?` | A message to a session's inbox |
| `POST /api/projects/:id/queues/:q/approve` | `words?` | Approves the current revision; for a stopped queue it also lifts the stop (see `queue.yaml`) |
| `POST /api/projects/:id/queues/:q/withdraw` | `reason?` | The user takes back the approval of a queue that never ran. There is no CLI command and no event for it |
| `PATCH /api/projects/:id/queues/:q` | `review_policy` (`continue`, `wait`, `orchestrator` or null) | Queue settings |
| `POST /api/projects/:id/questions/:qid/answer` | `text`, `continue?` | The user's answer, routed to the asker |
| `POST /api/projects/:id/queues/:q/run` | `action` (`start`, `pause`, `resume`, `stop`, `cancel_start`), `runtime?`, `model?`, `effort?`, `session?`, `after?`, `at?` | Runs the queue through a Nexus-launched session (`session` continues an existing one). `start` with `after`: a chain, the queue starts when that one is done (`{message}`); with `at` (ISO 8601, or `usage-reset`): a schedule (`{message}`); `cancel_start` cancels the planned start (`{message}`) |
| `POST /api/projects/:id/queues/:q/steps/:s/reject` | `text?` | Reject (the user's): the step is rejected, the run pauses until a newer revision is approved; answers `{ message }` |
| `POST /api/projects/:id/queues/:q/steps/:s/accept` | `text?` (the note), `note_to?` (`next` or `orchestrator`) | Accepts a step waiting in review (and, with `push_accepted`, pushes it); answers where the note went (`to`, `step`) |
| `POST /api/projects/:id/queues/:q/push` | | Push again: the step of the queue's last failed push; answers `{ message }` at once, the push runs in the background |
| `POST /api/projects/:id/queues/:q/steps/:s/send-back` | `text` (required, kept verbatim) | Fix it: sends a step waiting for the user's review back to its worker; answers `{ message }` |
| `POST /api/projects/:id/queues/:q/continue` | | Continue: lifts the stop of a stopped queue whose current revision is approved and goes on (see "Continue" under `queue.yaml`); refused (409) otherwise |
| `POST /api/projects/:id/orchestrator/messages` | `text` | A chat message to the orchestrator (starts or wakes it) |
| `POST /api/projects/:id/orchestrator/reset` | | The next message starts a new orchestrator session |
| `POST /api/projects/:id/orchestrator/settings` | `model`, `effort` (empty: the default) | The orchestrator's model and effort, from its next message on |
| `PATCH /api/projects/:id/settings` | `name`, `runtimes`, `defaults`, `orchestrator.notify` (an empty value clears a field) | Project settings, checked against the schema |
| `POST /api/projects/:id/settings/allow-rule` | `rule` | Adds an allow rule for Claude Code workers to `runtimes.claude.allowed_tools` in `.nexus/project.yaml` (once; a rule already there is left as it is), typically from a refusal. A tool name, optionally with a specifier in parentheses, on one line. Like every write, only from the dashboard's own page: an agent must not widen its own permissions. Nothing else is written, not the project's `.claude/settings.json` or `AGENTS.md` |

Also `GET /api/projects/:id/sessions/:session/activity?queue=&step=&limit=`, `GET /api/projects/:id/refusals?queue=&step=`
(the refused actions of every session of the project, oldest first; optionally only a queue's or a step's), `GET /api/projects/:id/orchestrator`
(its session, state and chat), `GET /api/usage` and `GET /api/models/:runtime`: the models a runtime offers, asked from the runtime itself
(Claude Code: an `initialize` control request on its stream-json input; Codex: `model/list`), with each model's
name, description and effort levels; the dashboard offers only these.

**Remote access.** A request is local when it comes from a loopback address without proxy headers
(`X-Forwarded-For`, `Forwarded`, `X-Forwarded-Host`, `Tailscale-User-Login`). Anything else, pages, API and the
WebSocket alike, needs the `nexus_auth` cookie holding the token from `<NEXUS_HOME>/auth.json`, set by
`POST /login` (form field `token`) or `GET /login?token=`. `GET /api/remote` gives the Tailscale address, the devices
receiving push and, to local requests only, the token, a sign-in link and its QR code; `POST /api/remote/rotate`
(local only) replaces the token.

**Push.** `GET /api/push/key` (the VAPID public key), `POST /api/push/subscribe` (`subscription`, `label`),
`POST /api/push/unsubscribe` (`endpoint`), `POST /api/push/test`. Keys and subscriptions are in
`<NEXUS_HOME>/push.json`. Whatever newly appears in a project's "waiting for you" list is pushed to every device; the
list as found when the server starts is the baseline.

**Nexus itself.** `GET /api/server` gives the version (`commit`, `subject`, `live`, `branch`, `root`) and `update`:
`phase` (`idle`, `draining`, `updating`, `restarting`, `failed`, or `updated` on a server that took over from an
update), `held`, `waiting`, `log`, `error?`, and after a deploy `push?` (`result`: `pushed`, `failed` or `skipped`,
`text`, `at`), `id` (the update's id), `by?` (`project`, `session`: the orchestrator that asked for it) and, on a
successor, `up` (`commit`, `subject`, `previous?`). It also gives `push_on_deploy` and `running`: the steps running
now, per project (`project`, `name`, `steps`: `queue`, `step`, `title`, `session`, `run`), which `nexus server status`
prints. `POST /api/server/update` (`now?`, `ref?`, `by?`) and `POST /api/server/cancel` start and cancel an update.
`by` is sent by `nexus server update` run in an orchestrator session (from `NEXUS_SESSION` and its project); the
server keeps it only for an orchestrator session of a registered project. The dashboard sends none. `POST /api/server/settings` (`push_on_deploy`: boolean) is the
user's only: like withdrawing an approval, it is refused without the dashboard page's own `Origin`. A server waiting
to take over answers every `/api/projects…` request, and every write under `/api/server/`, with 503.

**Push on deploy.** A successor that took over a live instance (`live: true`) pushes what it runs once it is up, if
`push_on_deploy` is on and the update's ref was `main`. It runs
`git push <main's upstream remote> <deployed sha>:refs/heads/main`, a plain push and so fast-forward only, never forced,
with `GIT_TERMINAL_PROMPT=0` and `GCM_INTERACTIVE=never` and a 60-second limit. A prompt or a hang counts as a failed
push. The result goes into `update.push` and the update log. A failed push (no upstream, rejected, network,
credentials, time-out) leaves the deploy as it is. A deployed ref other than `main`, an unknown ref (a predecessor from
before this), a development checkout, or the setting off: no push, and the log says why.

**The hand-over after an update.** The two servers talk through files in `<NEXUS_HOME>/handover/<id>/` (JSON, each
written whole and renamed into place, one writer each). The predecessor removes the folders of earlier hand-overs
when it starts one.

| File | Writer | When |
|---|---|---|
| `predecessor.json` | predecessor | `pid`, `commit`, `subject` (the version it ran), `at`, `update` (`id`, `by?`, `from`, `to`: the full commits the update went from and to); before it stops its agents and starts the successor |
| `ready.json` | successor | `pid`, `commit`, `subject`, `at`; it listens, its API (and the dashboard, if built) answers, every registered project's state loads |
| `failed.json` | successor | `pid`, `at`, `reason`; the smoke check failed or the port never came free; it exits with code 1 |
| `released.json` | predecessor | `at`, `log` (the update's log so far), `ref` (what the update deployed); it saw `ready.json`, writes nothing more, and exits |

The predecessor starts the successor with `NEXUS_HANDOVER=<that folder>` (and `NEXUS_WAIT_PORT=60`). It waits up to
60 seconds for `ready.json` or `failed.json`, or for the successor to exit. A successor started with `NEXUS_HANDOVER`
stays read-only until `released.json` appears or the predecessor's process is gone. A server started without it is
active at once, as before. Without `ready.json` the predecessor rolls back: it stops the successor's process tree,
puts a live worktree back on the commit it came from (`npm install` if the lock file differs, then a dashboard
build), listens on the port again and resumes the held queues. The update then ends with `phase: failed` and an
`error` of the form `<reason>; rolled back to <commit>` (a development checkout: `<reason>; this server goes on
(a development checkout is not moved)`). A push notification titled "Nexus: update failed" goes to every device.

A successor removes `NEXUS_HANDOVER` from its environment as soon as it starts, and no agent's environment ever
contains it. A folder that is not inside `<NEXUS_HOME>/handover` is refused: the successor logs
`refusing to take over: …` and exits with code 1, writing nothing.

## Conversations

`project.yaml` holds `conversations: { notes_dir?, runtime, model?, effort? }`. A conversation is a session with
role `conversation`: a thinking partner the user talks with about the project, one session per topic, with its chat
in `chat.jsonl` (`from: partner` for its replies, whole). It reads the whole project and writes only in `notes_dir`
(relative to the root, checked to lie inside it): Claude Code runs it in `dontAsk` mode allowed `Read`, `Grep`,
`Glob`, `Bash(nexus status:*)`, read-only git and `Edit(<notes_dir>/**)` only; Codex runs it with `notes_dir` as its
working directory in a `workspace-write` sandbox (`read-only` without a notes folder), approval `never`. It starts no
work. An idle partner's process ends after 15 minutes; the next message resumes the conversation.

API: `GET /api/projects/:id/conversations`, `POST …/conversations` (`title`, `runtime?`, `model?`, `effort?`,
`queue?` and `step?`, both or neither), `GET …/conversations/:cid` (session, state, chat), `PATCH …/conversations/:cid`
(`title`, `model`, `effort`, `archived`), `POST …/conversations/:cid/messages` (`text`), `POST
…/conversations/:cid/handoff`: the partner writes a summary (decisions, open questions, proposed work), which goes
whole into the orchestrator's chat. `GET …/queues/:q/steps/:s/conversation` answers `{ conversation }`: the step's
latest conversation that is not archived (the one with the latest message, or the newest when none has one), or
`null`.

**A conversation about a step** ("Chat about this"): `queue` and `step` are kept in `session.yaml` as `about`, never as
`queue` (which makes a session a worker of the queue: `nexus status` would deliver the queue's notes to it and mark
them read). The default title is `<step>: <step title>`. Creating it starts no model turn and changes nothing in the
run (a step in review keeps waiting); `nexus status` from it prints the orchestrator's overview and writes no event.
The server builds the step's context, the **seed**, and sends it with the user's first message (the chat keeps the
user's words only), by the step's state: `pending` and `skipped`: goal, acceptance criteria and notes (and the reason
of a skip); `running` and `waiting`: also the progress so far; `review`, `done`, `failed`, `stopped` and `rejected`:
also the summary, the reason, commits, send-backs, checks and review material; open questions of the step in every
state. It records the step's status in `about.seeded`. When the step's status differs at a later message, a short
"since then" addition (the change, and the outcome or progress of the new state) goes with that message, once.

## The orchestrator

`project.yaml` holds `orchestrator: { runtime, session, model?, notify }`. The orchestrator is a Claude Code session
launched in the project's checkout with `--permission-mode dontAsk`, allowed only `Read`, `Grep`, `Glob`, `Agent`,
`Bash(nexus:*)`, read-only git commands, and `Write(.nexus/drafts/**)` and `Edit(.nexus/drafts/**)`, and with
`NotebookEdit` and `MultiEdit` disallowed: anything else, writes outside `.nexus/drafts/` included, is refused without
a prompt. (`Write` and `Edit` are not disallowed: a disallow rule would beat the drafts rules.) Its briefing
(appended system prompt) explains its role, the commands and the queue YAML.

- `.nexus/drafts/<queue>.yaml` holds the orchestrator's queue drafts; the orchestrator is its only writer. It writes a
  draft there, uploads it with `nexus queue draft .nexus/drafts/<queue>.yaml` (relative to the project's root, its
  working directory), and keeps the file to edit for later revisions. The server reads only the path it is given.
  The briefing tells it to run `nexus` commands on their own: a chained command (`cd …`, `&&`, a pipe) does not match
  `Bash(nexus:*)` and is refused.

- `nexus queue draft <file|->` sends a queue definition (YAML) as `queue.drafted`. The server writes it: a new queue
  becomes `proposed` (or `draft`); a change to an existing queue's steps, checks or stop conditions makes a new
  revision, which needs the user's approval again.
- `nexus run <queue> start|pause|resume|stop --reason … [--use-session <id>] [--runtime claude|codex] [--model <m>] [--effort <e>] [--after <queue> | --at <time>]`
  sends `session.request`; `start --after A` plans the start for when queue A is done (a chain); `start --at
  "YYYY-MM-DD HH:MM"` (this machine's local time; sent as ISO 8601 in `start_at`) or `--at usage-reset` plans it for
  a time (a schedule); `nexus run <queue> cancel-start --reason …` cancels either.
  Starting an unapproved revision is refused.
- `nexus review accept <queue> <step> [--note <text>]`, `nexus review send-back <queue> <step> <what to fix>` and
  `nexus review ask-user <queue> <step> <why>` write `review.accepted` (the note as its `text`), `review.sent_back`
  and `review.asked_user`. The CLI refuses them from any session but an orchestrator, and for a step that is not
  waiting for the orchestrator's review. `send-back` waits for the server's result and prints it ("sent back to its
  worker as round N", or that the step goes to the user beyond the limit).
- `nexus queue set <queue> [--step <step>] skipped|finished|cancelled|propose-lift --reason …` sends `status.set`
  and prints the server's result: housekeeping (see "Housekeeping by the orchestrator" under `queue.yaml`). A worker
  session is refused by the CLI.
- With `notify` on, the server tells the orchestrator (starting it if needed) when a worker asks a question, when the
  user approves a revision of a queue ("Queue X revision N approved.", with the instruction to start it, or to resume
  its paused or halted run, if the plan puts it next; a run of an older revision cannot be resumed, so then: start it), when the user withdraws an approval, when the user lifts a stop with Continue ("The user lifted the stop of queue X with Continue (the stop was: …); its run goes on.", told once), when a run reaches a
  requested pause ("Run of X paused after step S.": a pause asked for by the user or the orchestrator, not a stop now,
  nor the pause of a server restart or of an update), when a step waits for its review ("Step S of queue X is done and
  waits for your review: <summary>", with the step's goal, acceptance, the checks reported this round and those of the
  queue not reported, the review material of the round, the commits, and the three commands; key
  `notify:review:<queue>:<step>:<finished_at>`, once per round and session, also for a step that entered review before
  the session started, so a reset orchestrator is told; a step waiting for it starts an orchestrator that has no
  session), and when a run halts or finishes. The chat shows only the fact;
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

## The `nexus` command inside agents

The server writes `<NEXUS_HOME>/bin/nexus.cmd` (for cmd and PowerShell, where npm's `.ps1` shim is blocked when
scripts are disabled, as in Codex's shell) and `<NEXUS_HOME>/bin/nexus` (for Git Bash), both running this checkout's
CLI with the server's Node, and puts that directory first on every launched agent's `PATH`.

## Chains

"When queue A is done, start B": a planned start, `queues/B/start.yaml`, set by the user in the dashboard (the start
form's "When") or by the orchestrator (`nexus run B start --after A`), with the options of a start (runtime, model,
effort, a session to continue). One per queue: a new plan replaces the old one. Refused: a queue after itself, a
loop through other plans, an unknown or cancelled A, a B that is done, cancelled or running, an effort the runtime does
not take, a session that is not a worker session Nexus launched. B need not be approved yet.

- It fires when A is done (every step done or skipped; its run finished). If A already is, B starts at once.
- If A's run halts or pauses, or A is stopped or cancelled, the plan waits; the dashboard shows why (`waiting`,
  `blocked` in the state).
- At the moment it fires, B starts as a start does: its current revision must be approved, and it must not be stopped
  or have a rejected step. If it cannot start, the plan stays with `failed` and the user gets an attention item of kind
  `start` ("Did not start after A: …"); it is not tried again by itself. Starting B or cancelling the plan ends it.
- A plan that continues a session waits while that session runs another queue, and fires when it is free (A's own
  session is free once A's run is finished): one session never runs two queues.
- Nothing fires while an update drains: the plans stay in their files, and the next server (or a cancelled update)
  looks at them once it is up. The server looks at the plans after every change to the project's files and 1.5 s
  after it starts.
- The run B gets records `after: A`. The dashboard shows the plan on B (with Cancel) and on A ("When this queue is
  done, B starts"), and a chip on B's row.

## Schedules

"Start B at night", "start B when the usage window resets": a planned start with `at`, in the same
`queues/B/start.yaml` (one plan per queue, chain or schedule), set from the dashboard's start form ("When": at a time,
or when the usage window resets) or with `nexus run B start --at …`.

- `--at usage-reset` takes the reset time from the latest usage data (`<NEXUS_HOME>/usage.json`) of the runtime the
  start would run on (the session's to continue, else the start's runtime, else the project's default): Claude Code's
  5-hour window; for Codex, of its windows not yet reset, the last to reset among those at or above the pause
  threshold, else the first to reset. The plan's `at` is that time plus the usage margin (60 s), and `usage` names the
  runtime. Without usage data of that runtime the request is refused. A time in the past (more than a minute) is
  refused.
- At its time the queue starts as a start does. If it cannot (its current revision not approved, stopped, …) or its
  session to continue runs another queue (a schedule does not wait), the plan stays with `failed` and the user gets an
  item of kind `start` ("Did not start at 22:00: …").
- More than 15 minutes late (the server was not running at the time; it looks at the plans 1.5 s after it starts), the
  queue does not start: `failed` with `missed: true`, an item for the user, and the orchestrator is told once. Less late,
  it starts.
- The engine's long timers (schedules, usage waits, retries) are armed in pieces of at most a day, each looking at the
  clock again, so a time weeks ahead neither fires at once (Node's `setTimeout` does beyond 2^31-1 ms) nor early. A
  restart arms them again from the files; nothing fires while an update drains.
- The dashboard shows the plan with its time and how long until it, and a chip "starts at 22:00" on the row; Cancel
  ends it.

## Runtime, model and effort per step

A run fixes its own runtime, model and effort when it starts (`run.yaml`). A step runs on its own values where it
names them and on the run's where it does not, never on the previous step's. A step on another runtime than the run's
takes a model or effort it does not name from the project's defaults for that runtime (`runtimes.<runtime>`): the
run's model belongs to the run's runtime.

Starting a run checks every step still to run: one that would run on Claude Code at an effort Claude Code does not take
refuses the start, naming the step and the reason; nothing is written. A run that continues a session (`session`,
`use_session`) must begin with a step on that session's runtime. Before opening each step the engine makes the session
fit it:

- **Another runtime** than the session's (also back to one used before): a fresh session, seeded as below
  (`switches[].why: runtime`).
- **The same runtime, another model or effort**: the same session. Claude Code takes them only at start, so the engine
  ends the idle process and starts it again with `--resume`, the new `--model` and `--effort`, then opens the step
  (a process that has not exited after 10 seconds is killed). Codex takes them per turn: `turn/start` carries `model`
  and `effort` ("for this turn and subsequent turns"); going back to a value the step left out names what the thread
  started with (`model` and `reasoningEffort` of the `thread/start` or `thread/resume` result). `session.yaml` holds
  the values in use.

## Context care

With `defaults.context_care` on (the default), at the end of a step whose session's context fill (`context_tokens`
/ `context_window` in `runtime.json`) is above `context_reuse_threshold`, and when a next step remains, the engine
goes on in a fresh session. Without a known context window it goes on in the same session. A fresh session for another
runtime is made the same way.

1. It looks for a fresh summary: a `context.summary` from that session at or after its latest `step.started` of the
   step that ended. If there is none, it asks once with a turn ("… write your context summary with `nexus context`
   …, then end your turn") and records `summary_asked` in `run.yaml`; after that turn it goes on with or without one.
2. It writes the new `session.yaml` (the next step's runtime, model and effort, the same working directory; `continues`) and sets
   `continued_by` on the old one, closes the old process, points `run.yaml` at the new session and appends to
   `switches`.
3. The new session's first turn is a seed, then the step turn, then the old session's unread inbox entries (recorded
   in the old session's `delivered.jsonl` as `carried`). The seed names the queue and the old session's fill, gives
   the summary (text, topics, files) or says there was none, and lists the queue's description and its steps with
   their states and the finished steps' summaries.

```
[Nexus] You take over queue W "Variant B made a system" in a fresh session: the session that ran the queue so far
had its context 82% full. You have not seen its work, only what follows.

Its context summary at the end of W2:
...
Topics: rock, support

The queue:
...

Its steps:
- W1 Voronoi fracture: done. <its summary>
- W2 Bodies shaped: done. <its summary>
- W3 Support: yours now

[Nexus] Queue W "Variant B made a system" (revision 3, approved), step W3 (3 of 7): Support.
...
```

## How the engine runs a Codex session

`codex app-server` over stdio: JSON-RPC requests and notifications, one JSON object per line, no `jsonrpc` field.
After `initialize` (with `experimentalApi`) and `initialized`, `thread/start` (or `thread/resume` with the stored
thread id) with the working directory, model, sandbox mode, approval policy (`never`: Nexus runs unattended; any
approval request that still comes is declined) and the worker briefing as `developerInstructions`. The thread id
becomes the session's `native_id`.

- a step turn: `turn/start` with `input: [{type: "text", text, text_elements: []}]`, the session's `effort` (and,
  once a step changed them, `model` and `effort`) and, in `workspace-write`, a `sandboxPolicy` whose writable roots include the project's `.nexus/` when the worktree is elsewhere
- a message while the agent works: `turn/steer` with the running turn's id
- stop now: `turn/interrupt`, then the message as the next turn

It reads `turn/started` and `turn/completed` (the turn's status), `item/started` and `item/completed`
(`commandExecution`, `fileChange`, `agentMessage`, `mcpToolCall`, `webSearch`), `thread/tokenUsage/updated` (the last
request's input tokens are the context in use; `modelContextWindow`) and `account/rateLimits/updated` (stored as
`codex_<window>` in `usage.json`, e.g. `codex_7d`). Checked against Codex CLI 0.167.2.

## How the engine runs a Claude Code session

`claude -p --input-format stream-json --output-format stream-json --verbose --session-id <uuid>` (or `--resume
<uuid>` for a session that ran before), with the project's permission mode, `--allowedTools Bash(nexus:*)` plus the
project's list, the model, and a worker briefing as `--append-system-prompt`. With `defaults.protect_nexus` on (the
default), `--disallowedTools Edit(//<.nexus>/**),Write(//<.nexus>/**)` names the project's `.nexus` by its absolute
path in Claude Code's rule form (`//` and forward slashes, the Windows drive letter as the first segment:
`C:\Code\P\.nexus` is `//c/Code/P/.nexus`), so it holds from a worktree too; deny rules win over the allow list. The
nexus CLI, which writes the worker's events there, is a process, not a file tool, and keeps working. Orchestrators
and thinking partners keep their own rules. Codex workers are not restricted (see DESIGN.md). Environment: `NEXUS_SESSION`,
`NEXUS_DIR`. The process stays alive across turns; stdin carries user messages:

- a step turn: `{"type":"user","message":{"role":"user","content":"…"},"parent_tool_use_id":null}`
- a message while the agent works: the same with `"priority":"next"` (read after its current tool calls, no interrupt)
- stop now: `"priority":"now"` (interrupts the turn)

From stdout it reads `system/init` (a turn starts), `assistant` (tool calls, text, context usage),
`user` tool results (errors), `rate_limit_event` (usage windows) and `result` (the turn ended; the context window
from `modelUsage`). After a turn ends it decides the next move from the step's state: next step, wait (question,
review), nudge once if the step has no outcome, or halt.
