# Nexus: design

Status: **draft 1**, 2026-11-12. For discussion; nothing here is built yet.

Nexus is a local dashboard and orchestrator for AI-driven development across several projects. It shows each
project's queues of work, drives agent sessions through them, carries messages between the user, an orchestrator
agent and the working agents, and keeps the context those sessions hold usable for later work.

The wire format (files, events, CLI) is in [PROTOCOL.md](PROTOCOL.md).

## Goals

1. **See what is happening.** For every project: finished, running and planned queues; for every step its state,
   its acceptance criteria, its review material; for every running agent what it is doing now.
2. **Talk without interrupting.** Leave a note on a step that has not started (delivered when it starts); send a
   message to a running step (delivered at the agent's next safe point); answer an agent's question.
3. **Only open the dashboard.** Each project has an orchestrator chat. The orchestrator plans queues with the user
   and starts, resumes and stops sessions. The user does not need a terminal.
4. **Generic.** Claude Code and Codex are both first-class. Nothing in the protocol is specific to one runtime or
   to one project's conventions; Project Honeycomb's queue practice is the first example, not the schema.
5. **Reuse context.** A session that has built up relevant context is continued for the next related queue
   rather than starting cold.
6. **Later: remote access** to the dashboard from the user's phone while the PC is on.

Non-goals for now: multiple users, cloud execution, running agents anywhere but this PC, replacing the projects'
own documentation (STATUS, logs, design documents stay where they are).

## Concepts

| Concept | What it is |
|---|---|
| **Project** | A registered repository (main checkout path) with its defaults: runtimes, review conventions, stop conditions every queue inherits |
| **Queue** | An ordered list of steps on one track, with stop conditions. It has a revision; the user approves a specific revision |
| **Step** | A unit of work with a goal, acceptance criteria and a review spec (what to prepare for review). One step runs at a time per queue |
| **Session** | One agent conversation in one runtime (Claude Code or Codex), with its native id, working directory (worktree), role and a *context card* |
| **Role** | `orchestrator` (one per project: plans and launches, never edits project files) or `worker` (executes a queue's steps) |
| **Note** | A message from the user (or orchestrator) attached to a not-yet-started step; delivered when the step starts |
| **Message** | A message to a running session; delivered at its next safe point |
| **Question** | Raised by a worker. Routed to the orchestrator, which answers it or escalates it to the user |
| **Approval** | The user's recorded consent to a queue revision: who, when, their words, the revision hash |
| **Review** | The material a finished step leaves for the user: images, sheets, documents, numbers, open questions |

### Queue and step states

```
queue:  draft → proposed → approved → running ⇄ paused
                                        ↓
                         waiting (on a question) → running
                                        ↓
                                stopped | done | cancelled
step:   pending → running → review → done
                     ↓  ↘ waiting → running
                   failed   skipped
```

- `draft`: the orchestrator and user are still shaping it. `proposed`: waiting for the user's approval.
- Any change to an approved queue's steps, criteria or stop conditions makes a new revision that needs approval
  again. Notes and messages do not.
- `stopped` carries the stop condition that was met and the worker's explanation. Resuming a stopped queue
  is an explicit user action (possibly after edits and re-approval).
- `review`: the step's work is finished and its review material is ready. By default (`review_policy: continue`)
  the queue goes straight on to the next step and the step counts as `done`; the user reviews whole queues. A queue
  or a single step can be set to `wait`, which holds the queue in `review` until the user accepts the step.

## Architecture

```
┌──────────────── Browser (PC or phone) ────────────────┐
│  Dashboard (React)                                     │
└───────────────▲───────────────────────────────────────┘
                │ HTTP + WebSocket
┌───────────────┴───────────── Nexus server (Node) ─────────────────────────┐
│  Project registry · Queue engine (drives steps) · Router (notes, messages,│
│  questions) · Session manager · File watcher · Notifications              │
│        │ runtime adapters                                                  │
│   ┌────┴─────────┐   ┌──────────────┐   ┌──────────────────────────┐      │
│   │ Claude Code  │   │ Codex        │   │ External (observe only:  │      │
│   │ claude -p    │   │ app-server   │   │ terminal / desktop app   │      │
│   │ stream-json  │   │ (JSON-RPC)   │   │ sessions, via hooks)     │      │
│   └──────────────┘   └──────────────┘   └──────────────────────────┘      │
└───────────────────────────────▲──────────────────────────────────────────┘
                                │ files (.nexus/ in each project) + `nexus` CLI
                         ┌──────┴──────┐
                         │ Agents      │  workers and orchestrators
                         └─────────────┘
```

### The files are the contract

Everything durable is a file in the project's `.nexus/` directory (git-ignored). The server is a reader, a
router and a process supervisor; if it stops, nothing is lost, and when it restarts it rebuilds its view from the
files. Agents never call the server directly: they run the `nexus` CLI, which writes files. This keeps agents
inside their workspace, works for any runtime that can run a shell command, and lets an agent started by hand in a
terminal take part.

**One writer per file.** Each session appends only to its own event log; the server is the only writer of queue
definitions and inboxes. No two processes ever write the same file, so no locks are needed across worktrees.

### Nexus drives the queue, step by step

Today a worker receives a whole queue and runs it in one long turn, and has to remember to check for notes. In
Nexus the **queue engine drives the steps**:

1. The engine starts (or resumes) the worker's session and sends one turn: *start step W3*, composed of the step's
   definition, the queue's stop conditions, any notes for W3, and pending answers.
2. The worker works, reporting through `nexus` (progress, review material, questions) and ends with
   `nexus step done` (or `failed`, or `stop`).
3. When the turn ends, the engine reads the outcome and decides: next step, wait for review, wait for an answer,
   or halt. Between steps it can also switch sessions, compact, or pause on the user's request.

This makes note delivery certain (it is part of the step's opening turn), gives natural pause points between steps,
and works the same for both runtimes. If a turn ends without a step outcome, the engine asks the worker once for
its status, then marks the step `waiting` and tells the orchestrator. A turn that failed is not such a turn: see
"Failures" below.

### Failures

A turn can fail without the worker deciding anything: the service is overloaded, the network drops, a limit is hit,
the runtime's process crashes. The adapters read why from the runtime's own codes and hand the engine a failure of
one of three kinds; the engine decides (`src/engine.ts`, `turnFailed`).

| Kind | Claude Code | Codex | What the engine does |
|---|---|---|---|
| Passing | `overloaded`, `server_error`, `rate_limit` without a reset time, a connection error | `serverOverloaded`, `internalServerError`, `rateLimitExceeded`, `httpConnectionFailed`, `responseStreamConnectionFailed`, `responseStreamDisconnected`, `responseTooManyFailedAttempts`, `usageLimitExceeded` without a known reset | Tries the turn again (`retry_wait`) |
| Usage, with a reset time | `rate_limit` after a `rate_limit_event` with `status: rejected` and `resetsAt` | `usageLimitExceeded` when the last rate limits show a full window and its `resetsAt` | Waits for the window (`usage_wait`, `resume_at`) |
| Lasting | `authentication_failed`, `billing_error`, `invalid_request`, `model_not_found`, a refusal, the result subtypes `error_max_turns` and the like, anything unknown | `unauthorized`, `badRequest`, `modelNotFound`, `contextWindowExceeded`, the policy codes, `sandboxError`, `other`, anything unknown | Halts the run, naming the failure |

A process that exits while its run goes on, without Nexus ending it, is a passing failure (`processExited`): the
retry starts a new process that resumes the same session (Claude Code `--resume`, Codex `thread/resume`).

- **Retries**: after 1, 2, 4, 8 and 16 minutes (`RETRY_BASE_MS` 60 000, doubled each time; `RETRY_LIMIT` 5 in a
  row). The sixth failure in a row halts the run with the last failure as its reason. A turn that ends well clears
  the count (`retries` in run.yaml), and so does a new step. The retry continues the step with a turn that says the
  last one failed. A usage wait goes on `USAGE_MARGIN_MS` (60 s) after the reset and is not counted.
- **The runtime's own retries** (Claude Code's `api_retry`, Codex's `error` with `willRetry`) are recorded in the
  activity as `retry` and not counted: only the turn's end decides.
- **Exits Nexus causes are never failures**: its shutdown, the hand-over of an update, an update's drain with `now`,
  the end of a finished run. A stopped engine writes nothing into the runs, so a run held by an update stays held and
  resumes after the restart; one whose last step was done before the stop is finished by the next server.
- **A retry waiting at an update** is held like a running queue (`resume_after_restart`), and the next server makes
  it when it is due. A timer that comes during the drain does nothing; a cancelled update sets it again. A pause or a
  stop by the user cancels a pending retry.
- **Shown** on the step's card, at the top of the step and in the run box: "retry 2 of 5 at 14:05, overloaded" (the
  run's `retries`, `resume_at` and `failure`, the code in short words; `retryLine` in `@nexus/protocol/times`). The
  step's activity lists both the runtime's own retries and the engine's.

### Refused actions

Unattended means unasked, so an action the permissions do not allow is refused, not asked about. Each refusal is a
record in the session's `refusals.jsonl`, written by the engine from the adapters' `refusal` events, tagged with the
queue and step of the run that drives the session now (also when the session was continued from an earlier queue).
One record per refusal: the adapters report a call once, and the engine skips a `ref` the file already has (a
resumed runtime may repeat its list).

- **Claude Code** reports a denial twice: a `permission_denied` system message as it happens (tool name and call id,
  the reason, but not the input, which Nexus takes from the call's `tool_use` earlier in the turn), and the result's
  `permission_denials` (name, id and input), which is the authoritative list: it also holds denials the messages
  leave out, such as a hook's or a path rule's.
- **Codex** refuses in two ways. With approvals routed to the user, Codex sends an approval request, which Nexus
  declines because it runs unattended (`item/commandExecution/requestApproval`, `item/fileChange/requestApproval`,
  `item/permissions/requestApproval`, and the older `execCommandApproval` and `applyPatchApproval`). With
  `auto_review`, the reviewer decides and Nexus only hears the verdict, `item/autoApprovalReview/completed` with
  `review.status` `denied` (or `timedOut`), naming the action. Either way the item then completes with status
  `declined`; an item declined with no request or review heard of is recorded from the item itself.

The shapes come from the runtimes' published types, not from a probe: Claude Code's from the Agent SDK's `sdk.d.ts`
(`@anthropic-ai/claude-agent-sdk` 0.3.323: `SDKPermissionDeniedMessage`, `SDKPermissionDenial`), Codex's from
`codex app-server generate-ts` of Codex 0.167.2 (`ServerRequest`, `CommandExecutionRequestApprovalParams`,
`ItemGuardianApprovalReviewCompletedNotification`, `GuardianApprovalReviewAction`, `CommandExecutionStatus` and
`PatchApplyStatus` with `declined`). The auto-review notification is marked unstable in that schema ("expected to
change soon"): when Codex is updated, check it first. The fakes write the same shapes.

The dashboard shows them in the step's detail, and on the project page grouped by kind (the tool, and for a command
its first words: `Bash: git push`), with counts and the latest time (`@nexus/protocol/refusals`). From a Claude Code
refusal the user can add an allow rule: prefilled in Claude Code's rule syntax (`Bash(git push:*)`,
`Write(<path>)`, `WebFetch(domain:<host>)`), editable, and saved only on "Add rule", to the project's Nexus settings
(`runtimes.claude.allowed_tools`, which runs started afterwards get as `--allowedTools`). Never to the project's own
`.claude/settings.json` or `AGENTS.md`: those are the project's, and other tools read them. The server takes the rule
only from the dashboard's page, so an agent cannot widen its own permissions. Codex refusals are shown only: Nexus
does not write Codex's own configuration.

The shapes come from the runtimes' published types, not from a probe: Claude Code's from the Agent SDK's `sdk.d.ts`
(`@anthropic-ai/claude-agent-sdk` 0.3.323, the release that matches Claude Code 2.1.323: `SDKAssistantMessageError`,
`SDKAPIRetryMessage`, `SDKRateLimitInfo`, `SDKResultMessage` with `is_error`, `api_error_status`, `terminal_reason`),
and Codex's from `codex app-server generate-ts` of Codex 0.167.2 (`TurnError`, `CodexErrorInfo`,
`ErrorNotification`, `TurnStatus`). A Claude Code connection error has no code of its own; it is read from the
`api_retry` messages before the failure, which carry no HTTP status for one. The fakes write the same shapes.

### Messages to a running step

| Runtime | How a message reaches a running turn |
|---|---|
| Claude Code (launched by Nexus) | A user message on the session's stream-json stdin with `priority: "next"`: read after the running tool calls finish, without interrupting |
| Codex (launched by Nexus) | `turn/steer` on the app-server connection |
| Either, started outside Nexus | A `PostToolUse` hook (both runtimes have one) checks the session's inbox and returns it as `additionalContext` |

An **urgent stop** uses the runtime's interrupt (Claude: `priority: "now"` or SIGINT; Codex: `turn/interrupt`).

### Questions: worker ↔ orchestrator ↔ user

A worker's question goes to the orchestrator first, not straight to the user. The worker states whether it can
continue with independent work meanwhile. The orchestrator then:

- answers it itself when the answer is already settled (in the approved queue, the project rules, earlier decisions),
- or escalates it to the user, with its own framing and a recommendation, and tells the worker whether to wait or
  to go on with independent work.

Whether to block is thereby decided between the worker and the orchestrator for each question, not by a global
rule. Questions that are the user's by the project's rules (the look, gameplay, final numbers in Honeycomb) are
always escalated; the orchestrator never answers on the user's behalf there.

The user sees every question and answer in the dashboard, including those the orchestrator settled, and can
override an answer.

### The orchestrator

One long-lived session per project, shown as the project's chat. It may:

- read the project (code, docs, logs, review material) and every `.nexus/` file,
- create and edit draft queues, propose them for approval,
- start, resume, fork, pause and stop worker sessions; choose which session gets a queue,
- answer or escalate worker questions, add notes to steps.

It may not edit project files, approve queues, or answer a question that is the user's. This is enforced by the
runtime's permissions (for Claude: read-only tools plus `Bash(nexus *)`, and writes only under `.nexus/drafts/`, where
it keeps its queue drafts), not only by instruction.

### Context management

Every session has a **context card**, kept by Nexus:

| Field | Source |
|---|---|
| Runtime, native id, worktree, branch | Session manager |
| Queues and steps it has worked on | Event log |
| Topics and files it knows | The worker's `nexus context` summary at the end of each step or queue |
| Context window fill (%) | Claude: token usage in the stream; Codex: `thread/tokenUsage/updated` |
| Compactions so far, last active, state | Event log / runtime events |

When the orchestrator assigns a queue it picks one of:

- **continue** a session whose card matches the queue's topic and whose context is below a threshold (default
  60 %, a project setting),
- **fork** such a session when two queues build on the same context but should run in parallel (both runtimes
  support forking),
- **start fresh**, seeded with the handoff summaries (`nexus context`) of the relevant earlier sessions.

Its choice and the reason are shown on the queue. The user can override it. A session is used by one process at a
time: Nexus never runs two processes on one session.

**Context care between steps.** Within a run the engine keeps the same threshold. When a step ends with its session's
context above it, the next step runs in a fresh session of the same runtime, model and effort, seeded with the
step's context summary and the queue's own text (protocol: "Context care"). A runtime left to itself compacts when
the window is full, which can happen in the middle of a step and loses detail nobody chose to lose; a step's end is
the natural cut, and the worker's own summary is a better hand-over than an automatic compaction. Decisions:

- On by default (`defaults.context_care`), also for existing projects; the user turns it off in the settings.
- The summary must be fresh: written by that session at or after its latest start of the step that just ended. An
  older one would miss the step's own work. A missing summary is asked for once; if the worker still writes none,
  the seed is the queue's description and the finished steps' summaries, which every worker writes anyway.
- No known context window (a runtime that has not reported one yet) means no switch: Nexus does not guess.
- What the old session had not read yet (a message that came between its last turn and the switch) goes into the new
  session's first turn, after the step, and counts as delivered in the old session's `delivered.jsonl`.
- The switch is recorded in `run.yaml` (`switches`) and on both `session.yaml` files (`continues`, `continued_by`),
  and the run's panel lists it: from which step, how full the old context was, and where the seed came from.

**Runtime, model and effort per step.** A step may name its runtime, model and effort (a mechanical step on a small
model, a design step on a strong one). Decisions:

- A step without them runs on the run's values, fixed at the run's start, not on the previous step's: a step on
  `haiku` is an exception for that step only, so the queue reads the same whatever order its steps run in.
- Another runtime always means a fresh session seeded like context care's, also when going back to a runtime used
  earlier in the run: that earlier session missed the steps in between, and the summary chain carries them.
- Another model or effort keeps the session, so its context is kept: Claude Code is restarted between steps with
  `--resume` (it takes both only at start), Codex takes them per turn. The values on another runtime come from the
  project's defaults for that runtime, since the run's model names a model of its own runtime.
- Bad combinations are found as early as they can be: at draft when the step names both runtime and effort, otherwise
  at the run's start for every step still to run; never halfway through a run.

### Autonomy and insight

Queues run autonomously: they do not stop at each step for the user. The user checks queues as a whole, and looks
into individual steps when they want more detail. So the dashboard offers two levels:

- **Queue report**, the default review: when a queue ends (done or stopped), the worker writes a report of the
  whole queue: what each step achieved against its acceptance, the checks, the review material, open questions,
  and what is proposed next. The queue row links to it.
- **Step detail**, on demand: the step's timeline (progress lines, checks, review material, questions and answers,
  notes delivered), the agent's activity during the step (tool calls and messages, from the runtime's stream), the
  commits it made and its `context.summary`. Available live while the step runs and afterwards.

### Worktrees

Nexus creates the worktree and branch for a queue itself when the queue says `worktree: auto`: a new branch from a
named base commit, in the project's worktree directory (a project setting; default
`<main checkout>/../<repo name>.worktrees/<queue id>`). The queue engine does this, at the orchestrator's request,
not the orchestrator by editing files. Nexus never switches, resets or deletes a worktree another session is using;
removing a finished queue's worktree is a user action. Merging back is a step of a queue (or the user's), not
something Nexus does on its own.

### Usage limits

The engine watches the subscription limits: Claude Code's 5-hour and 7-day usage, Codex's rate-limit updates
(`account/rateLimits/updated`). Above a project-set threshold (default 90 % of the 5-hour window) it does not open
new step turns; running turns finish. Queues paused this way resume when the window resets, and the dashboard says
why they wait. Where Claude Code reports these figures in print mode is to be confirmed when the adapter is built.

### Review material

A step's review spec says what to prepare (e.g. "before/after shots of fixtures X, Y; one phone-width sheet").
The worker registers what it produced with `nexus review add <path>…`. The files stay where the project's tools put
them (e.g. Honeycomb's `tmp/review/<step>/`); Nexus serves them read-only and renders images, Markdown, HTML and
JSON. Artifact links and similar URLs can be registered too.

### Approvals

Approving is a dashboard action: the user picks a queue revision, writes their words (optional, kept verbatim), and
Nexus records `{revision hash, time, words}`. The worker sees the approval in its step turns. This replaces quoting
the user into a Markdown queue, though a project may still copy it there.

**Statuses change through Nexus, never by editing files** (decided 2026-11-13, after Project Honeycomb's queue W: a
stopped queue's new revision was approved, `start` said ok and halted with the old stop note, and a worker then edited
the queue file by hand). Every change is an entry in the queue's `changes`, written by the server, with who, when
and why; derivation applies the entries in time order among the events, so neither a later rebuild nor an older event
undoes them. Only the user lifts a stop: stop conditions are the user's guard rails. Approving a new revision of a
stopped queue lifts it (the old stop's reason goes into the entry, the old run record is archived, a start begins at
the first pending step); `start` and `resume` refuse a stopped queue with the step and the reason, and `resume`
refuses a run of an older revision, which would reopen a step the new revision may have replaced. Every write to the
API is the user's and is taken only from the dashboard's page (the Origin rule), approving among them; agents act
through the CLI and its events.

Housekeeping is the orchestrator's, with `nexus queue set` (event `status.set`, applied by the server as an entry
`by: orchestrator`): skip a step a revision replaced or that was done elsewhere (a stopped or failed one too), close
a halted run of a queue whose steps are all done or skipped, cancel a queue that is not running (the user gets a
push notification, nothing waits in their list), and propose that the user lift a stop. Consent stays the user's:
marking work done (the orchestrator skips with the reason saying where), approving, lifting a stop, reopening a
finished step. A draft cannot change a step's status or drop a step that has started or stopped, so a new revision
of a stopped queue keeps the replaced step and the orchestrator skips it: the record shows what became of it.

### Runtimes and authentication

- **Claude Code**: Nexus spawns the unmodified `claude` binary in print mode with stream-json input and output and
  a session id it chooses, signed in with the user's own Max subscription. It does **not** use the Agent SDK with
  subscription login (Anthropic's documentation does not cover that for personal tools; the SDK is for API keys).
- **Codex**: Nexus runs `codex app-server` over stdio (threads, turns, steer, interrupt, token usage). The
  app-server is marked experimental, so Nexus pins the Codex version it was tested with and generates its types
  from that version. Fallback: `codex exec --json` with `exec resume` (no steering; messages wait for the next
  step turn). Signed in with the user's ChatGPT login.
- **Unattended permissions**: each project sets the permission mode per role and runtime. Workers usually need
  edit and shell rights in their worktree, and write access to the main checkout's `.nexus/` (for Codex, an added
  writable root). A Codex worker in a queue's own worktree also gets that worktree's git paths as writable roots, so
  that it can commit there (see the findings).
- Hooks are installed per project only for the observe-only path and for session-start context; the Nexus-launched
  path does not depend on them.

### Updating Nexus

Nexus updates itself between steps (`src/lifecycle.ts`). It holds every running queue at the end of its step
(`resume_after_restart`), moves the live worktree, installs and builds, then hands over to its successor
(`src/handover.ts`). The hand-over keeps two rules: exactly one server writes the projects' files at any time, and
the old server goes only once the new one has shown it works.

1. The predecessor writes `predecessor.json`, stops every agent and waits for their exits to be recorded. It stops
   its own writing (watchers closed, timers cleared, change handling off) and frees the port. It stays alive.
2. It starts the successor with `NEXUS_HANDOVER` naming the hand-over folder. The successor listens and runs a smoke
   check, reading only: `GET /api/server` answers with a version, the dashboard answers if it is built, and every
   registered project's state loads. It writes `ready.json` on success. On failure it writes `failed.json` and
   exits.
3. When `ready.json` appears, the predecessor writes `released.json` with its update log and exits. The successor
   then builds its engines, which is when held runs are recovered and resumed. Its update log, shown in the
   dashboard's server panel (`phase: updated`), begins with the predecessor's lines and ends with the version that
   is up.
4. If the successor does not come up, the predecessor rolls back. That is when it gets no signal within 60 seconds
   (a constant), finds `failed.json`, or sees the successor exit early. See "Rolling back" below.

**Rolling back.** The predecessor's process still runs the old code from memory. Only what is read from disk has
moved: the worktree, which the next start runs, and `node_modules` and the built dashboard, which this server serves.
So rolling back means four things:
- Stop the successor and everything it started: on Windows `taskkill /T /F` on its pid, elsewhere its process group,
  since it was started detached. A successor never released is still in standby and has started nothing, but an
  older one that ignores the hand-over may have.
- Check out the commit the update came from on a live worktree. Run `npm install` if the lock file differs from the
  one the update installed (or half installed), and rebuild the dashboard. A development checkout is never moved.
- Take the port again, retrying for up to 20 s while the stopped successor lets go of it.
- Build new engines on the files. Their recovery resumes the held queues (`resume_after_restart`) exactly as a
  successor's would. The old engines were shut down for good by the release.

The update then ends in phase `failed`. The error is the reason followed by "rolled back to <commit>" (in a
development checkout: "this server goes on"). The log keeps every line, and a push notification goes to the user's
devices. A failure before the hand-over (a checkout, install or build that fails) also puts a live worktree back.
That server never let go, so its queues simply go on. If the worktree cannot be put back, the error says to do it by
hand before the next start; if the port cannot be had, the error says so and the work goes on without the dashboard.

Until it is released, a successor builds no engine. So it does no recovery, resumes nothing, starts no agent and
writes nothing under any `.nexus/`; it answers `/api/projects…` with 503. The predecessor's exit also counts as
release, since a gone process writes nothing. This covers a predecessor that gave up waiting.

Files carry the signals, not HTTP. The predecessor has given up its port and has nothing to serve. Files keep each
signal's single writer obvious, and they stay behind for reading after a failed update. The order is
release → start → wait, so the successor normally finds the port free; it still waits up to 60 s for it
(`NEXUS_WAIT_PORT`).

**Compatibility.** A start without `NEXUS_HANDOVER` behaves as before: `live.ps1`, `autostart.ps1`, a plain
`npm start`, or a successor started by an older server, which frees the port as it exits and sends no hand-over.
Such a server is active at once and resumes the held queues. A successor of an older version, started by a newer
predecessor, ignores the folder and never signals. Updating to a version from before the hand-over is a downgrade:
after 60 s the predecessor stops that successor, along with any agents it had resumed, and rolls back. Runs the old
successor had resumed come back paused ("the Nexus server restarted"), as after any crash. Updating to such a
version is not supported; do it with `live.ps1`.

**The variable is consumed once.** A successor reads `NEXUS_HANDOVER` at start and deletes it from `process.env`
before anything else runs, so nothing it starts inherits it. `agentEnv()` also removes it, as a second guard, and
tests start `main.ts` only through `test/helpers.ts`, which strips it. Removing the variable is the real protection.
As a backstop, a successor refuses a folder that is not under `<NEXUS_HOME>/handover`: both paths are resolved, the
comparison is case-insensitive on Windows, and the folder must lie strictly inside, ending in a separator. A refused
successor logs why and exits non-zero before writing or starting anything, so a real predecessor sees a failure and
rolls back. The backstop cannot catch a stray server that runs without `NEXUS_HOME`, since that server's home is the
real one.

**Push on deploy** (`src/deploy.ts`). The successor pushes, once it has taken over, and the predecessor does not.
Three reasons:
- A push may take up to its 60-second limit, and the predecessor pushing would keep the successor in standby, with
  the held queues waiting, for that long.
- A push is only right once the new version is known to be up, and the successor is where that is known.
- The result belongs in the update log the server panel shows, and that is the successor's.

The predecessor passes the deployed ref in `released.json`, and only `main` is pushed: the exact commit the live
worktree runs, `<sha>:refs/heads/main` to the upstream remote of `main`. It is a plain push, so git itself refuses
anything but a fast-forward. Prompts are off, and a hang ends at 60 s, so an unattended push can fail but never wait.
A failed push changes nothing about the deploy. The setting lives in `<NEXUS_HOME>/deploy.json`, written only by the
server. It can only be changed from the dashboard (the same Origin rule as withdrawing an approval), so an agent can
neither push nor turn pushing on.

**What changed for agents** (the user's decision of 2026-11-13). An orchestrator session started before a deploy
keeps its old briefing and its habits. The `Agents:` lines in commit messages are where its news comes from:
- The successor collects them from the deployed range (local git, ancestry checked) into
  `<NEXUS_HOME>/deploy-changes.jsonl`. One file for the whole instance means every project's orchestrator reads the
  same record, and a restart rebuilds nothing.
- Each session is told the deploys newer than itself and not yet in its `applied.jsonl`.
- Notifications decide when, not whether: on, the changes go out like any notice and start a turn; off, they ride
  along with the next message the orchestrator gets. Holding them is why the key is written when they are delivered,
  not when they are recorded.
- They never reach the user's chat; the user asked for no "what changed" view.

## Tech stack

| Part | Choice |
|---|---|
| Language | TypeScript throughout, run natively by Node.js 24+ (type stripping: no build step for CLI and server), npm workspaces |
| `packages/protocol` | Schemas (zod) for every file and event; shared by server, CLI and web |
| `packages/cli` | The `nexus` command agents run; validates and appends |
| `apps/server` | Hono (HTTP), ws (WebSocket), chokidar (file watching), the runtime adapters |
| `apps/web` | React, Vite, Tailwind CSS; usable at phone width; installable as a PWA later |
| Storage | The `.nexus/` files are the source of truth; an in-memory index, SQLite only if search or history needs it |
| Remote access (later) | Tailscale (no open ports); Cloudflare Tunnel with Access as an alternative |

Needed on the machine: Node.js LTS, and the Codex CLI (`npm i -g @openai/codex`) for the Codex adapter.

## Phases

| # | Phase | Done when |
|---|---|---|
| 1 | **Protocol and read-only dashboard.** Schemas, the `nexus` CLI, project registry, the queue view (rows by state, steps side by side), step detail with review material. A one-time importer turns Honeycomb's current `docs/QUEUE.md` tracks into `.nexus/` queues | Honeycomb's queues show correctly; an agent run by hand can report through `nexus` and the dashboard updates live |
| 2 | **Notes, approvals, questions.** Notes on steps, approval records, the question flow, notifications (desktop; phone later) | A note left on a pending step reaches the worker at that step's start; a question round-trips |
| 3 | **Claude Code adapter and queue engine.** Launch, drive step by step, live messages, interrupt, resume; context cards | A Honeycomb-style queue runs to its end or a stop condition with no terminal open |
| 4 | **Orchestrator chat.** One per project, with its permissions; session choice (continue / fork / fresh) | The user plans, approves and starts a queue from the chat alone |
| 5 | **Codex adapter.** app-server, steer, token usage; exec fallback | The same queue runs on Codex |
| 6 | **Remote access.** Authentication, Tailscale, phone layout, push notifications | The dashboard works from the phone away from home |

Phase 1 and 2 already help with sessions started by hand in a terminal; phase 3 is where the terminal goes away.

## What projects need to change

A project joins Nexus by registering and adding a short rule to its agent instructions (`AGENTS.md` / `CLAUDE.md`):
when a session runs under Nexus (the `NEXUS_SESSION` environment variable is set), queue state, notes and questions go
through `nexus`. Honeycomb's working rules (approved queues, stop conditions, the look loop, review sheets) stay;
only where the queue's state lives changes. That edit is made in the project with the user's agreement, not by Nexus.

Nexus is expected to refine its own process model over time: the queue/step model above is a starting point drawn
from Honeycomb, and it changes when practice shows a better shape.

## Decisions

The user's answers, 2026-11-12:

| Question | Decision |
|---|---|
| Stop at every step for review? | No. Queues run autonomously (`review_policy: continue`); the user reviews queues, with step detail on demand |
| Who creates worktrees? | Nexus, by itself, for queues that ask for one |
| Watch the usage limits? | Yes; pause before the limit, resume when it resets |
| Where does `.nexus/` live? | In the project's main checkout, git-ignored |

### Back closes the topmost layer

Everything the dashboard opens over the queue list is a layer kept in the browser history, so the phone's back
button, the back gesture, the browser's Back and Escape all close the topmost one, and Back leaves the app only when
nothing is open. Each history entry Nexus writes carries `{hash, layers, depth}` in `history.state`: the hash is the
route (`#/<project>[/<queue>[/<step>]]`, the queue or step drawer being the layer `item`), `layers` the open stack
(`chat`, `ideas`, `conversation:<id>`, `settings`, `remote`, `waiting`, `projects`, `viewer:<index>` for a review
image), `depth` how many entries Nexus
pushed. Opening pushes one entry; a close button goes back to it, so Back never reopens what was closed and no dead
entries pile up; switching within a kind (another step, another conversation) replaces the entry. Switching
projects is not a layer: it rewrites the entry in place. A page loaded with something open (a hash with a step,
`?chat`) has no entry to go back to, so closing it rewrites the entry instead. Review images open in an in-app
viewer for the same reason: a new browser tab, in an installed app on a phone, had no way back; moving to the next
image replaces the viewer's entry, so one Back always returns to the step. The rules are pure
(`apps/web/src/layers.ts`, unit tested); `nav.ts` applies them to `window.history`.

### Details beside the chat on a wide screen

From 1280 px a queue or step opens in a panel on the left and the orchestrator chat or the Ideas panel in one on the
right, both below the header and without a backdrop, and the queue list keeps the room between them (about 370 px
at 1440, 330 at 1280): a step can be read while talking about it. The breakpoint is where two readable panels (about
510 and 430 px) still leave the list a column; below it, and on phones, both stay layers over the page. The two side
panels are independent layers, so the history rules above learnt two things: switching or closing a layer that is
not on top goes back to its entry and opens the layers above it again (applied as one change, so the panel that
stays does not flicker), and a layer that belongs to another (a conversation to the Ideas panel, an image to its
step) closes with it while the others stay.

### Drafts stay in the browser

Unsent text in the dashboard's boxes is kept in `localStorage` (`nexus.drafts`: one map from a target key to the
text and when it was last touched), not in `.nexus/`: a draft is the user's half-typed thought on one device, the
server has no use for it, and keeping it out of the files keeps "one writer per file" and the files' meaning intact.
The key names the project and the target (`<project>/orchestrator`, `/conversation/<id>`, `/message/<queue>/<step>`,
`/note/<queue>/<step>`, `/answer/<qid>`, `/approval/<queue>`), each part URI-encoded. `Composer` is keyed by it, so
moving from one step or conversation to another remounts the box with that target's own text instead of carrying
the text across. Drafts untouched for 14 days are pruned when the page loads.

## Findings from building phase 3

- **Context fill and usage limits are in the stream.** Every `assistant` message carries its usage (input, cache
  creation and cache read tokens: the context in use); the `result` gives the model's `contextWindow`; a
  `rate_limit_event` gives the 5-hour and 7-day windows' utilization and reset times.
- **A message with `priority: "next"` reaches a running turn** after its current tool calls, without interrupting it;
  a plain message sent during a turn becomes the next turn.
- **The CLI starts turns by itself** when a background task it started finishes. The engine therefore opens a step
  only when the session is idle, and re-decides after every turn.
- **Claude Code blocks long foreground `sleep`** and the agent moves such waits to the background. Nothing for Nexus
  to do, but it explains extra turns in the activity.
- **A killed server takes its `claude` children with it** (their stdin closes). On restart, any session process still
  alive is ended before a resume, and running queues come back paused.

- **Codex has the same moves.** `turn/steer` reaches a running turn (checked live), `thread/resume` continues a
  thread with its context (checked: the agent recalled the previous queue), token usage and the context window
  arrive per request, and the rate limits arrive as a weekly window.
- **Codex runs commands in PowerShell**, where npm's `nexus.ps1` is blocked by the execution policy: Nexus therefore
  puts its own `nexus.cmd` first on the agents' PATH. The sandboxed shell can run it and write to `.nexus/`.
- **Codex can commit in a worktree only with its git paths writable.** A linked worktree's git directory lies in the
  main checkout's `.git`, outside the worktree, so under `workspace-write` `git commit` failed on
  `.git/worktrees/<name>/index.lock` (probe with Codex 0.167.2 on Windows, `gpt-6-luna`). With exactly four paths
  added as writable roots it committed without an escalation request: the worktree's own git directory
  (`.git/worktrees/<name>`: index, HEAD) and the repository's `objects`, `refs` and `logs`. The rest of `.git`
  (config, hooks) stays read-only. Nexus asks git for the paths (`rev-parse --git-dir --git-common-dir`) and adds them
  only when the git directory lies outside the working directory; the roots work both in the thread's config
  (`sandbox_workspace_write.writable_roots`) and in a turn's sandbox policy, and Nexus sends both.

- **Workers cannot write under `.nexus` with their file tools, and only Claude Code workers** (decided 2026-11-13; a
  Honeycomb worker had edited a queue file by hand). Claude Code workers get deny rules for Edit and Write on the
  project's `.nexus` by its absolute path (`Edit(//c/…/.nexus/**)`, `Write(//c/…/.nexus/**)`). A probe (haiku,
  dontAsk, a temporary project, the rules from the code; $0.007) showed Write and Edit refused there ("File is in a
  directory that is denied by your permission settings."), both working elsewhere in the project, Read still allowed,
  and `nexus log` recording its event. File-tool rules do not cover the shell: a Bash redirection or a script can
  still write there. The project setting `defaults.protect_nexus` turns the rules off.
  Codex cannot be kept out, on this machine (probe with Codex 0.167.2 on Windows, `gpt-6-luna`, about 136k tokens,
  mostly cached): `workspace-write`, the sandbox mode Nexus uses, has no read-only subpath of its own (only `.git`,
  `.codex` and `.agents` are kept read-only), and a permission profile sent with it is ignored (the older sandbox
  settings win, as Codex's documentation says). A permission profile alone (Beta; `extends = ":workspace"`, `.nexus`
  read, the session's own folder write, because Codex sandboxes every process it starts, the nexus CLI included)
  made the Windows sandbox refuse every command: "windows elevated sandbox cannot reopen writable descendants under
  read-only carveouts directly; refusing to run unsandboxed". Without that carve-out the CLI could not record events.
  So Codex workers are unchanged.

- **Remote access needs no open port.** The server keeps listening on 127.0.0.1; Tailscale Serve relays the tailnet's
  https requests to it. Requests relayed by a proxy count as remote and need the access token; this machine does
  not. Push works through the browsers' own push services (Web Push with VAPID), so a phone gets notifications with
  Nexus closed once it is installed to the home screen.

- **Nexus updates itself between steps.** The live instance runs from its own worktree on a detached commit; an
  update holds every running queue at the end of its step, moves the worktree, builds and starts its successor,
  which waits for the port and resumes only the queues the update held. On Windows two details mattered: the
  server writes its own log (a shell's `>>` locks the file against the successor), and the line endings are fixed
  by `.gitattributes` (npm rewrites bin scripts, which made the worktree look changed).
- **A successor that is merely started is not up.** Until 2026-11-12 the predecessor started its successor and exited
  300 ms later, whatever became of it: a successor that crashed on start, could not load a project or never got the
  port left nothing running, and the successor recovered and resumed runs while the predecessor might still be
  writing. Now the successor proves it is up (a smoke check) before the predecessor goes, and it touches nothing until
  the predecessor has let go (see "Updating Nexus"). Checked end to end on a development instance: the predecessor
  exited about 0.3 s after the successor's ready signal, and the successor's update log showed both servers' lines.
- **Rolling back is fast, and the old server never has to restart.** A probe used a detached worktree of this
  repository as a live instance on port 4319 and updated it to a branch whose server throws at start. The successor
  crashed within a second. About 2 s later the instance answered on 4319 again, from the same process, on its
  previous commit, and the queue the update had held ran to its end. Three details mattered:
  - A crash is seen at once through the child's exit event, without waiting for the time limit.
  - `node_modules` has to be compared with the lock the update installed, not the one it started from.
  - On Windows a pid can still show as a process for a few seconds after it exits, so the probe recorded every pid
    and checked them again after killing.
- **The hand-over variable leaked to agents and their test servers.** After the live instance's first hand-over
  (2026-11-13, 00:22), it kept `NEXUS_HANDOVER` in its environment, and every agent it started inherited it. At
  00:24:52 a worker's test started `main.ts` with its own environment. `withdraw.test.ts` did that, and so did
  `handover.test.ts` for a plain start; which one ran then is not recorded. That test server took the
  live predecessor's folder (`%APPDATA%\Nexus\handover\…`) for its own, passed its smoke check, and overwrote
  `ready.json` there. No harm followed, because that hand-over was already released. But the test server then took
  over as if it were the live successor. During a real update it could have answered for the real successor. The
  same test on the old code, with `NEXUS_HANDOVER` pointing at a decoy folder, wrote `ready.json` into the decoy. The
  whole suite on the new code, inheriting the same decoy, wrote nothing there (see "The variable is consumed once").
- **The predecessor named the wrong commit.** `predecessor.json` took its version after the worktree had moved, so
  the successor's log said "(was <the new commit>)". It now names the commit the update started from. The push probe
  showed it. That probe was a clone of this repository, not a worktree, because a worktree shares the real `origin`.
  The clone's `origin` was a temporary bare repository. The probe deployed to it, was rejected by it once someone else
  had pushed, and had the setting off.
- **Screenshots at phone width need an http parent page.** In a 390 px iframe inside a `file://` page, the settings
  panel rendered without its Nexus section: `/api/server` did not reach the dashboard there, while the project API
  did. The same iframe inside a page served over http from 127.0.0.1 shows it, so phone-width screenshots use an http
  parent.
- **Notices held by an update waited for the next write.** On 2026-11-13 the live instance updated from 6f7d2e6 to
  21bf813 while queue N3 ran. During the drain, the user approved SP (23:17 UTC) and N3 finished (23:22:05). Both
  notices were held, as they should be while draining. The successor took over at 23:22:05, but nobody told the
  orchestrator. Its notices only run in a project's change pass, and that pass ran only when a watcher saw a file
  change. The watchers ignore the files already there (`ignoreInitial`), so nothing ran until the user wrote in the
  chat at 23:23:22 ("did you get a notice about the update?"). That write delivered the held notices 77 s late, inside
  the user's own turn. Their turn did not start by itself.

  The same pass also told 19 approvals at once, some hours old, because approval notices were new in that version
  and nothing had marked old approvals as told. Now every server, once active, runs one pass over every project, and
  so does every update that settles (up and pushed, failed, cancelled). An orchestrator that ran the update is told
  its outcome, keyed by the update's id that `predecessor.json` carries. A new kind of notice still tells everything
  it covers since the orchestrator session began, the first time it runs.

- **Queue drafts go through files, not heredocs.** On 2026-11-12 an orchestrator could not upload a long queue
  revision: `cd … && nexus queue draft - <<'EOF'` was refused in `dontAsk` mode (a chained command does not match
  `Bash(nexus:*)`), and the heredoc alone (about 8.5 KB; about 7 KB worked) broke in Claude Code's Bash wrapper on
  Windows, with YAML lines reaching the shell as commands. The orchestrator now writes `.nexus/drafts/<queue>.yaml`
  and runs `nexus queue draft` on that file, and the heredoc form left its briefing. A probe (Claude Code, `haiku`,
  `dontAsk`, the orchestrator's exact lists, about $0.02 for three runs) showed that `Edit(<path>/**)` alone also
  permits `Write` there, creating missing directories, while `Write(<path>/**)` alone permits nothing; Nexus keeps
  both rules so the allow list says what is meant. `Write` and `Edit` must not be disallowed, since a disallow rule
  beats an allow rule.

## Open questions

1. **The orchestrator on Codex.** The orchestrator runs on Claude Code only: its read-only guarantee rests on Claude
   Code's `dontAsk` mode. Codex's `read-only` sandbox could give the same, with `.nexus/` writable; not built yet.
