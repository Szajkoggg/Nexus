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
  review_policy: continue              # continue | wait
  context_reuse_threshold: 0.6         # max context fill to continue a session
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
```

A queue is runnable only when its latest approval's hash matches its current revision and no withdrawal came
after that approval (a withdrawal's `approvals` is not below the number of approvals). Withdrawing sets the queue
back to `proposed`; the approvals stay as they were, and a later approval makes it runnable again. Only a queue
that never ran can be withdrawn (no `run.yaml`, no step started); a started one is paused or stopped instead.

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
| `queue.report` | `queue`, `path`, `summary` | The worker's report of the whole queue, written when it ends (done or stopped) |
| `change.proposed` | `queue`, `patch`, `reason` | A proposed change to a queue definition (needs a new approval) |
| `queue.drafted` | `queue`, `definition` | Orchestrator only: a new or changed draft queue |
| `session.request` | `action` (start, resume, pause, stop), `queue`, `use_session?`, `model?`, `reason` | Orchestrator only: asks the engine to act on a queue's run (`use_session` continues an existing session) |
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
| `queues/<id>/run.yaml` | The engine's intent for a queue: `session`, `state` (`running`, `pausing`, `paused`, `halted`, `finished`, `usage_wait`, `retry_wait`: a turn failed for a passing reason and is tried again at `resume_at`), `reason`, the `step` it last opened, `nudged`, `resume_at` (when a usage wait or a retry goes on), `retries` (turns failed in a row for a passing reason; cleared by a turn that ends well or a new step), `failure` (the runtime's code for the failure being retried or that halted the run, e.g. `overloaded`), `resume_after_restart`, `started_at`, `ended_at` (when it last stopped going: set when it becomes `finished`, `halted` or `paused`, kept while it stays so, removed when it goes on; older files without it fall back to `updated_at`) |
| `sessions/<id>/runtime.json` | A launched session's live facts: process state and pid, model, context tokens and window, turns, cost |
| `sessions/<id>/delivered.jsonl` | What the server handed to the session (notes put into a step turn, inbox entries injected or sent as a turn); counts as read |
| `sessions/<id>/refusals.jsonl` | One line per action the agent wanted but was refused: `at`, `session`, `runtime`, `by` (`permissions`: Claude Code's permission mode or rules; `nexus`: Nexus declined a Codex approval request; `auto_review`: Codex's auto reviewer), `tool` (Claude Code's tool name; for Codex `command`, `file_change`, `network`, `mcp`, `permissions`, …), `input` in short (the command, path or host, at most 300 characters), `reason` when the runtime gave one, `ref` (the runtime's id for the call: one record per refusal), `queue`, `step` |
| `sessions/<id>/activity.jsonl` | A condensed record of the agent's stream: turns, tool calls, texts (clipped to 600 characters), tool errors, exits, and retries (`retry`: the runtime's own and the engine's), tagged with queue and step |
| `sessions/<orchestrator>/applied.jsonl` | The server's result for each orchestrator request (`queue.drafted`, `session.request`), and the notices it has sent the orchestrator; the CLI waits for the result and prints it |
| `sessions/<orchestrator>/chat.jsonl` | The chat shown in the dashboard: the user's messages, the orchestrator's texts (whole, however long) and tool calls, Nexus notices |
| `<NEXUS_HOME>/usage.json` | The subscription's windows (5-hour, 7-day: utilization and reset time) from the latest `rate_limit_event` |

A session launched by Nexus has `launched_by: nexus`, `runtime: claude`, `native_id` (Claude's session UUID, chosen
by Nexus) and the `model` it was started with. A queue may also say `worktree: auto`: Nexus then creates the worktree
and branch when it starts the queue and writes their paths back into `queue.yaml`.

The event `review.accepted` (`queue`, `step`, `text?`), written by the user or an orchestrator, accepts a step held in
`review`.

## The user's session

The server keeps one session with id `user` and role `user` for what the user does in the dashboard. Its event log
holds the user's answers (`answer.given`). Like an orchestrator, it may write the events workers may not.

## Inbox: `sessions/<id>/inbox.jsonl`

Written by the server, read by the session's adapter or hook. A `message` may name the `queue` and `step` it is
about, so the dashboard shows it on that step. The server **routes answers**: every final `answer.given` (not an
escalation), from the orchestrator or the user, is appended to the asking session's inbox once, with the id
`answer-<event id>`. The session records each entry it has seen with `message.read`; `nexus status` shows the unread
ones and records them.

```json
{"v":1,"id":"01JD...","at":"...","type":"message","from":"user","text":"Use the grassland settings for the bench too."}
{"v":1,"id":"01JD...","at":"...","type":"answer","qid":"01JD...","from":"orchestrator","text":"...","continue":true}
{"v":1,"id":"01JD...","at":"...","type":"stop","from":"user","text":"Stop after this check."}
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
nexus report W --file docs/reports/W.md --summary "..."
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

Writes (JSON bodies only; a request with a foreign `Origin` is refused):

| Request | Body | Effect |
|---|---|---|
| `POST /api/projects/:id/queues/:q/steps/:s/notes` | `text` | A note from the user for the step |
| `DELETE /api/projects/:id/queues/:q/steps/:s/notes/:note` | | Withdraws a note not yet delivered |
| `POST /api/projects/:id/sessions/:session/messages` | `text`, `queue?`, `step?` | A message to a session's inbox |
| `POST /api/projects/:id/queues/:q/approve` | `words?` | Approves the current revision |
| `POST /api/projects/:id/queues/:q/withdraw` | `reason?` | The user takes back the approval of a queue that never ran. Only from the dashboard's own page: the request must carry this server's `Origin` and, if it sends one, `Sec-Fetch-Site: same-origin`; anything else is refused (403). There is no CLI command and no event for it |
| `PATCH /api/projects/:id/queues/:q` | `review_policy` (`continue`, `wait` or null) | Queue settings |
| `POST /api/projects/:id/questions/:qid/answer` | `text`, `continue?` | The user's answer, routed to the asker |
| `POST /api/projects/:id/queues/:q/run` | `action` (`start`, `pause`, `resume`, `stop`), `model?`, `session?` | Runs the queue through a Nexus-launched session (`session` continues an existing one) |
| `POST /api/projects/:id/queues/:q/steps/:s/accept` | `text?` | Accepts a step waiting in review |
| `POST /api/projects/:id/orchestrator/messages` | `text` | A chat message to the orchestrator (starts or wakes it) |
| `POST /api/projects/:id/orchestrator/reset` | | The next message starts a new orchestrator session |
| `POST /api/projects/:id/orchestrator/settings` | `model`, `effort` (empty: the default) | The orchestrator's model and effort, from its next message on |
| `PATCH /api/projects/:id/settings` | `name`, `runtimes`, `defaults`, `orchestrator.notify` (an empty value clears a field) | Project settings, checked against the schema |

Also `GET /api/projects/:id/sessions/:session/activity?queue=&step=&limit=`, `GET /api/projects/:id/orchestrator`
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
update), `held`, `waiting`, `log`, `error?`. `POST /api/server/update` (`now?`, `ref?`) and `POST /api/server/cancel`
start and cancel an update. A server waiting to take over answers every `/api/projects…` request, and every write
under `/api/server/`, with 503.

**The hand-over after an update.** The two servers talk through files in `<NEXUS_HOME>/handover/<id>/` (JSON, each
written whole and renamed into place, one writer each). The predecessor removes the folders of earlier hand-overs
when it starts one.

| File | Writer | When |
|---|---|---|
| `predecessor.json` | predecessor | `pid`, `commit`, `subject`, `at`; before it stops its agents and starts the successor |
| `ready.json` | successor | `pid`, `commit`, `subject`, `at`; it listens, its API (and the dashboard, if built) answers, every registered project's state loads |
| `failed.json` | successor | `pid`, `at`, `reason`; the smoke check failed or the port never came free; it exits with code 1 |
| `released.json` | predecessor | `at`, `log` (the update's log so far); it saw `ready.json`, writes nothing more, and exits |

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

API: `GET /api/projects/:id/conversations`, `POST …/conversations` (`title`, `runtime?`, `model?`, `effort?`),
`GET …/conversations/:cid` (session, state, chat), `PATCH …/conversations/:cid` (`title`, `model`, `effort`,
`archived`), `POST …/conversations/:cid/messages` (`text`), `POST …/conversations/:cid/handoff`: the partner writes a
summary (decisions, open questions, proposed work), which goes whole into the orchestrator's chat.

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
- `nexus run <queue> start|pause|resume|stop --reason … [--use-session <id>] [--model <m>]` sends `session.request`.
  Starting an unapproved revision is refused.
- With `notify` on, the server tells the orchestrator (starting it if needed) when a worker asks a question, when the
  user approves a revision of a queue ("Queue X revision N approved.", with the instruction to start it, or to resume
  its paused or halted run, if the plan puts it next), when the user withdraws an approval, when a run reaches a
  requested pause ("Run of X paused after step S.": a pause asked for by the user or the orchestrator, not a stop now,
  nor the pause of a server restart or of an update), and when a run halts or finishes. The chat shows only the fact;
  the instruction goes to the orchestrator alone. Each notice is told once, recorded in `applied.jsonl` (`notify:…`
  keys; approvals and withdrawals by their position in the queue's `approvals` and `withdrawals`, so approving a
  withdrawn revision again is told again). Nothing older than the orchestrator session is told; what happens during
  an update's drain is told once after the restart.

## The `nexus` command inside agents

The server writes `<NEXUS_HOME>/bin/nexus.cmd` (for cmd and PowerShell, where npm's `.ps1` shim is blocked when
scripts are disabled, as in Codex's shell) and `<NEXUS_HOME>/bin/nexus` (for Git Bash), both running this checkout's
CLI with the server's Node, and puts that directory first on every launched agent's `PATH`.

## How the engine runs a Codex session

`codex app-server` over stdio: JSON-RPC requests and notifications, one JSON object per line, no `jsonrpc` field.
After `initialize` (with `experimentalApi`) and `initialized`, `thread/start` (or `thread/resume` with the stored
thread id) with the working directory, model, sandbox mode, approval policy (`never`: Nexus runs unattended; any
approval request that still comes is declined) and the worker briefing as `developerInstructions`. The thread id
becomes the session's `native_id`.

- a step turn: `turn/start` with `input: [{type: "text", text, text_elements: []}]` and, in `workspace-write`, a
  `sandboxPolicy` whose writable roots include the project's `.nexus/` when the worktree is elsewhere
- a message while the agent works: `turn/steer` with the running turn's id
- stop now: `turn/interrupt`, then the message as the next turn

It reads `turn/started` and `turn/completed` (the turn's status), `item/started` and `item/completed`
(`commandExecution`, `fileChange`, `agentMessage`, `mcpToolCall`, `webSearch`), `thread/tokenUsage/updated` (the last
request's input tokens are the context in use; `modelContextWindow`) and `account/rateLimits/updated` (stored as
`codex_<window>` in `usage.json`, e.g. `codex_7d`). Checked against Codex CLI 0.167.2.

## How the engine runs a Claude Code session

`claude -p --input-format stream-json --output-format stream-json --verbose --session-id <uuid>` (or `--resume
<uuid>` for a session that ran before), with the project's permission mode, `--allowedTools Bash(nexus:*)` plus the
project's list, the model, and a worker briefing as `--append-system-prompt`. Environment: `NEXUS_SESSION`,
`NEXUS_DIR`. The process stays alive across turns; stdin carries user messages:

- a step turn: `{"type":"user","message":{"role":"user","content":"…"},"parent_tool_use_id":null}`
- a message while the agent works: the same with `"priority":"next"` (read after its current tool calls, no interrupt)
- stop now: `"priority":"now"` (interrupts the turn)

From stdout it reads `system/init` (a turn starts), `assistant` (tool calls, text, context usage),
`user` tool results (errors), `rate_limit_event` (usage windows) and `result` (the turn ended; the context window
from `modelUsage`). After a turn ends it decides the next move from the step's state: next step, wait (question,
review), nudge once if the step has no outcome, or halt.
