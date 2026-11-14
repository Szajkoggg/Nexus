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
  again. Notes and messages do not. A revision changes only what has not started (decided 2026-11-14): pending
  steps may be added, changed, removed or reordered; started steps keep their definition and order, and a queue
  that has run keeps its checkout. A change to a started step goes to its worker as a message or a send-back.
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
"Failures" below; nor is one that ended while work the agent started still runs: see "Background work".

### Background work

An agent can start work that runs on after its turn: a command in the background, a sub-agent it does not wait for.
Its turn then ends without the step's outcome, though the step is still at work; counted as a turn without an outcome,
it was nudged at once and halted at the next such end (queue TR, 2026-11-14). Two things answer it:

- **The texts.** The worker's briefing and the nudge say: do not end the turn while work you started still runs; run
  a sub-agent in the foreground and take its result within the turn, or do the work yourself.
- **The engine waits.** Both runtimes report the work (probed 2026-11-14: Claude Code with `haiku`, $0.01;
  Codex with `gpt-6-luna`, about 87,000 tokens, mostly cached, of the subscription): Claude Code 2.1.323 writes `system/background_tasks_changed` with the whole list of its
  background tasks (a Bash command or a sub-agent, each with `run_in_background`), and when one ends, starts a turn
  by itself with the task's notification. Codex 0.167.2 has no such list, but its items say it: a unified-exec
  `commandExecution` completed 14 s after its turn did, and a sub-agent is open from its `subAgentActivity` `started`
  to its `completed`; the sub-agent's own thread sends its turns over the same connection (the adapter keeps only the
  session's thread). Codex starts no turn by itself when the work ends. A turn that ends without the step's outcome
  while such work runs is therefore not counted: the engine waits for the work's end, at most `BACKGROUND_LIMIT_MS`
  (30 minutes) from that turn's end. When the work ends with the session idle, the engine looks again 2 s later (Claude
  Code's own turn comes first, and its end is decided as any); with no outcome by then the usual rule applies, and its
  nudge says the background work has finished. After the limit the usual rule applies as well, with a nudge that names
  the work still running and says Nexus waits no longer; the next end without an outcome halts the run. The wait is
  kept in the engine's memory only: a restarted server has no process with the work anyway (its runs come back paused).

### The run's state transitions

A queue's run record (`run.yaml`) changes state only through the named transitions in `apps/server/src/run-state.ts`.
They are pure functions that each own which fields they set and clear. The engine writes their result, adding
`ended_at` and `updated_at`, and keeps the side effects (timers, processes, what the agent is told) where they are:

| Transition | To | Clears | Used for |
|---|---|---|---|
| `startedRun` | running | (a new record) | a start |
| `toResumed` | running | reason, `resume_at`, the hold; `nudged` false; a rejection, taking the approved revision | resume, a retry or usage wait come due, the restart after an update |
| `toUnheld` | running | reason, the hold | a cancelled update releases a pausing run |
| `toPausedByUser` | pausing / paused | `resume_at`, the hold (the user's pause wins) | Pause, Stop now, a rejected step |
| `toHeldForUpdate` | pausing / paused | (sets the hold, `resume_after_restart`) | an update drains; the next server takes it over |
| `toPaused` | paused | nothing (reason when given) | a pausing run's step ended; a pausing turn failed; a server restart |
| `toHalted` | halted | `resume_at`, the hold (sets `failure` when given) | stops, stalls, lasting failures, out of retries |
| `toFinished` | finished | reason, `retries`, `failure`, `resume_at`, the hold | every finish |
| `toUsageWait` | usage_wait | the hold | a full usage window, a runtime's usage limit |
| `toRetryWait` | retry_wait | nothing (keeps the hold) | a turn that failed for a passing reason |
| `toApprovalWait` | approval_wait | `resume_at`, the hold; `nudged` false | a step's end while a newer revision waits for approval |
| `toRevision` | (unchanged) | nothing (sets `revision`) | a step's end under a newer approved revision |

There is one finish. It used to be written in three places, each clearing different fields, so a run that finished
while an update drained could keep `resume_after_restart`. A finished run now keeps none of these fields, because
nothing reads them on it. Writes that change other fields only stay inline in the engine: the hold of a waiting retry
and its release, `nudged`, `summary_asked`, a session switch, a step opened, and clearing `retries` and `failure` after
a turn that ended well. The guards `assertCanStart` and `assertCanResume` live beside the transitions. The test of an
older revision's run is `runIsOlder(run, revision, history)` (protocol): such a run may resume (a revision changes no
started step), and while a newer revision waits for approval it may resume mid-step. An `approval_wait` run goes on
through `resume` once its revision is approved (the engine's `onChange`, a cancelled drain, the restart). `test/scenario.test.ts` keeps run.yaml and runtime.json at each point
of a run in golden files, as a guard for refactoring the engine.

### One host for agent processes

Workers (the engine), the orchestrator and thinking partners (conversations) start their processes through one
`AgentHost` (`apps/server/src/agent-host.ts`), one host per role. The host starts the runtime the role asks for (Claude
Code or Codex; it resumes a session that has a runtime record), keeps the session's `runtime.json`, takes the stream's
facts (the record, the runtime's own session id, the usage windows into `usage.json`) and ends processes so the
session's next message starts a new one (`retire`, `close`, `restartAfterTurn`, `shutdown`). The role gives its launch
options and its handlers for texts, activity, refusals, turn ends and exits; they run after the host has kept its
records. What a role does with a turn stays with the role: the engine keeps its crash, retry, restart and closing
handling (`ending`, `restarting`, the 300 ms wait before deciding after a turn), the orchestrator its chat, a
conversation its hand-over and idle timer.

The record differs by role, as it did before the host (`ROLE_RECORDS`): workers and the orchestrator keep `cost_usd`;
only a worker's record turns `working` at a turn's start and counts `turns`; the others are `working` from the first
reply's context tokens and keep `turns` at 0. Every role's usage windows reach `usage.json` (one subscription, decided
with ST1 on 2026-11-14), so the usage display and the usage pause count orchestrator and partner turns too.
`test/runtime-records.test.ts` keeps each role's `runtime.json` fields against the fakes.

### The texts agents receive

What Nexus says to agents lives in one module, `apps/server/src/prompts.ts`, as pure functions of their inputs: the
worker's briefing, the step-opening text, inbox entries as delivered, the fresh-session seed and the nudges; the
orchestrator's briefing, its helpers' prompts and its notices; the thinking partner's briefing. The roles decide when a
text goes out and to whom; the module decides only its words. Agents rely on these texts (a change carries an
`Agents:` line), so `test/prompts.test.ts` drives the engine, the orchestrator and conversations with stand-in processes
(`AgentHostOptions.spawn`) and compares everything they receive with golden files (`test/golden/prompts-*.txt`). A
change of a text is made in the module and shows as a changed golden file in the same commit
(`NEXUS_UPDATE_GOLDEN=1 node --test apps/server/test/prompts.test.ts`). Not in the module: error messages, activity
lines and chat lines for the user, the step chat's seed (`step-seed.ts`) and the hand-over request
(`conversations.ts`).

**Languages in the texts.** The briefings name the languages of the project's effective settings (PROTOCOL.md,
"Languages") instead of a fixed rule. A briefing is the process's system prompt, fixed when it starts, so the worker's
language line also goes with each step's opening and each inbox message; the orchestrator and partners, whose
messages are the user's own words, get a new process with the new briefing at their next message instead (the
launch comparison of global settings does that by itself, as the briefing is part of the launch). The defaults keep
every text as it was: without a reader's language, queue text stays in the working language, so nothing changes for
a user until they choose a reader's language. The queue-reviewer's prompt is one file for every project, so it does
not name a language: the orchestrator tells it.

### Failures

A turn can fail without the worker deciding anything: the service is overloaded, the network drops, a limit is hit,
the runtime's process crashes. The adapters read why from the runtime's own codes and hand the engine a failure of
one of three kinds; the engine decides (`src/engine.ts`, `turnFailed`).

| Kind | Claude Code | Codex | What the engine does |
|---|---|---|---|
| Passing | `overloaded`, `server_error`, `rate_limit` without a reset time, a connection error | `serverOverloaded`, `internalServerError`, `rateLimitExceeded`, `httpConnectionFailed`, `responseStreamConnectionFailed`, `responseStreamDisconnected`, `responseTooManyFailedAttempts`, `usageLimitExceeded` without a known reset | Tries the turn again (`retry_wait`) |
| Usage, with a reset time | `rate_limit` after a `rate_limit_event` with `status: rejected` and `resetsAt` | `usageLimitExceeded` when the last rate limits show a full window and its `resetsAt` | Waits for the window (`usage_wait`, `resume_at`) |
| Passing, an edge's 403 | `authentication_failed` (or another lasting code) whose text has a 403 and the mark of Cloudflare or a like edge ("Attention Required!", "cf-ray", "Just a moment...", Akamai): code `edge_block_403` | The same, by its message, whatever the code (no sample yet; assumed `unauthorized` with "unexpected status 403 Forbidden: Attention Required! \| Cloudflare"); as a connection failure with `httpStatusCode` 403 it is passing by its code | Tries the turn again, like any passing failure; the sixth in a row halts naming it |
| Lasting | `authentication_failed`, `billing_error`, `invalid_request`, `model_not_found`, a refusal, the result subtypes `error_max_turns` and the like, anything unknown | `unauthorized`, `badRequest`, `modelNotFound`, `contextWindowExceeded`, the policy codes, `sandboxError`, `other`, anything unknown | Halts the run, naming the failure |

**An edge's 403 is not a credential error.** On 2026-11-13 queue N7 halted with `authentication_failed`: "Failed to
authenticate. API Error: 403 Attention Required! | Cloudflare". That is Cloudflare's block page in front of the API,
not a wrong credential, and a resume went on fine. Such a failure is passing (`edgeBlock` in `src/agent.ts`): both the
403 and an edge's mark must be in the text (the whole of it, not only the 300 characters kept), so a 401, "Invalid API
key", an expired token or a plain 403 about permissions stays lasting.

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
something Nexus does on its own. The code is `apps/server/src/worktree.ts` (`worktreeFor`, `gitBranch`), beside
`gitinfo.ts`, which records what the queue's checkout committed.

### Usage limits

The engine watches the subscription limits: Claude Code's 5-hour and 7-day usage, Codex's rate-limit updates
(`account/rateLimits/updated`). Above a project-set threshold (default 90 % of the 5-hour window) it does not open
new step turns; running turns finish. Queues paused this way resume when the window resets, and the dashboard says
why they wait. Where Claude Code reports these figures in print mode is to be confirmed when the adapter is built.

### Chains

"When queue A is done, start B" is a planned start kept in a file of B's (`start.yaml`), not a timer or a process:
the engine looks at the plans after every change and when it starts, so a plan survives restarts and updates, and
nothing fires while an update drains. Decisions:

- It fires only when A is done. A halt, pause or stop of A is something to look at, not a reason to start B on work
  that may depend on A's; the plan waits and says what it waits for.
- B is checked when the plan comes due, not when it is made: the user may approve B in the meantime, and an approval
  withdrawn or a revision proposed since must not start unapproved work. "Approved" means the revision current at
  that moment is approved (an approval of a later revision counts). When B cannot start, the plan stays as an item
  for the user instead of vanishing or retrying by itself; starting B or cancelling ends it.
- A plan to continue a session waits while that session runs another queue, rather than failing: one session never
  runs two queues, and chaining a queue into the session of the queue before it is the common case.

A schedule ("at 22:00", "when the usage window resets") is the same kind of plan with a time instead of a queue.
Decisions:

- A schedule does not wait for a busy session: at its time the queue starts, or the plan fails and the user is told.
  A schedule says when, and starting hours later than asked (after a busy session freed) would be a different plan
  than the one made. It does wait for its checkout and for a place under the limit on queues running at once (next
  section): that wait is Nexus keeping its own rule, not a plan gone wrong, so it is never marked missed.
- A schedule more than 15 minutes late, because the server was not running, does not start. Work set for the night
  must not begin by surprise in the morning; the user and the orchestrator are told, and decide.
- The usage reset is fixed when the plan is made, from the usage data then known, and shown as a time. A plan that
  moved with later data would be harder to read and to trust; making it again takes the new reset.
- Long timers are armed in pieces of at most a day: Node fires a timer longer than 2^31-1 ms (about 24.8 days) at once,
  which a weekly usage window can exceed. Tests drive these timers with a clock of their own.

The code is `apps/server/src/scheduler.ts`: `Scheduler` keeps the plans (chain, schedule, cancel; `duePlans` and
`startDue`, which the coordinator's pass calls to start what came due) and asks the engine to start a queue; `ClockTimers` arms the long timers on the engine's
clock, for the schedules and for the engine's own retry and usage waits. The engine owns the runs and keeps the public
`chain`, `scheduleStart` and `cancelStart`, which hand over to the scheduler.

### Never two queues in one checkout

Decided by the user on 2026-11-14: queues run side by side only in worktrees of their own, never two in one checkout,
and no more at once than a server-wide limit (default 2). Two agents committing in one working tree mix each other's
changes into their commits and their checks; and every running queue spends the same subscription, so how many run at
once is the user's setting, not something each project decides alone.

- A checkout is held by a run that will go on there, also while paused or waiting (a usage wait, a retry, an
  approval, a review); a halted run holds none, and going on with it checks the checkout like a start. A paused run
  holding its checkout means a forgotten pause keeps others out: better than a resume that finds its tree changed
  under it.
- The limit counts only runs at work (running or pausing, not waiting for a review or an answer): a queue waiting for
  the user costs nothing, and counting it would let one unanswered review stop every project.
- A direct start is refused with the reason (the user or the orchestrator asked now, and should know at once); a
  planned start waits and says why on its plan, and starts by itself. Waiting starts go in the order the plans were
  made, across projects.
- One coordinator over the projects' engines (`apps/server/src/coordinator.ts`), because the limit and a queue ending
  in one project concern the others: the engines stay per project and ask it, and it runs the pass over every
  project's due plans, looking again after each start. The waiting reason is written into the plan's file (`held`),
  since the project's state alone cannot know what other projects run.

### Review material

A step's review spec says what to prepare (e.g. "before/after shots of fixtures X, Y; one phone-width sheet").
The worker registers what it produced with `nexus review add <path>…`, which copies each file into the queue's
folder (`.nexus/queues/<queue>/review/<step>/`) and records the copy (decided 2026-11-14, queue FU), as `nexus report`
does with the report: the CLI is the one writer there, so a worker kept out of `.nexus` can still add material; the
pictures outlast the working tree; and none is left untracked in a worktree, where it blocked the cleanup (as reports
did, queue WR). The worker writes the files outside the working tree, in the system's temporary folder for example,
and `scripts/capture.ts` writes there by default. Material added before, where the project's tools put it (e.g.
Honeycomb's `tmp/review/<step>/`), is shown where it is. Nexus serves both read-only and renders images, Markdown,
HTML and JSON. Artifact links and similar URLs can be registered too.

Pictures pair by a view key and a named role, checked when they are added (decided 2026-11-14, queue RS; the
standard is `nexus help review`, the rules in `packages/protocol/src/pictures.ts`). For Nexus's own dashboard,
`scripts/capture.ts` takes them: the views are data (key, route, setup actions), the afters come from the checkout,
the befores from the same list at the step's base commit in a temporary worktree, each side on its own development
instance with seeded test projects. It never blocks: what it cannot take is reported and taken by hand.

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
the first pending step); `start` and `resume` refuse a stopped queue with the step and the reason. (`resume` used to
refuse a run of an older revision, which could reopen a step the new revision had replaced; since a revision changes
only steps that have not started, decided 2026-11-14, a run goes on across revisions: see "A new revision of a running
queue never stops the running step" in PROTOCOL.md.) Every write to the
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

**Commits per step, and foreign ones** (`src/gitinfo.ts`, queue N8). A commit carries nothing that says which agent
made it: workers commit with the user's own identity. In a worktree of the queue's own only its worker commits, but in
the main checkout the user and other queues commit too. Nexus already knows when the worker was at work on the step
(the runtime's turns in `activity.jsonl`), so a commit made outside those turns is marked as not the worker's. A commit
of the user's made during a turn is not caught; changing the commits (an author, a trailer) would catch it, but
Nexus does not touch what agents commit. The branch's state uses the local remote-tracking refs and says how old they
are: fetching is a network action, which the server does not take for the dashboard.

**Pushing what was accepted** (`src/accepted.ts`, queue N5). The server pushes an accepted step's work, not the
worker: a worker pushing depends on its permissions and sandbox, and could push work nobody accepted. What is pushed
is the commit that was HEAD when the step entered review, recorded then, never the branch tip at the time of the
acceptance: by then the next step may have committed (a run goes on while a step waits, or after it is accepted), and
that work is not accepted. Only the newest acceptance of a queue is pushed, since its commit includes the earlier
ones; a failed push is not retried on a timer but at the next acceptance and with Push again, so a refusing remote
costs one attempt per acceptance. The push reuses the deploy push's rules (plain push, no prompts, 60 s). Off by
default, per project (`defaults.push_accepted`). Found while testing it against a bare repository with a refusing
pre-receive hook: a push that changes no ref ("Everything up-to-date") never runs the remote's hooks, so it succeeds
however the remote is set; the result then says the commit "was already" there.

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

A project joins Nexus by registering and adding a short rule to its agent instructions (its `AGENTS.md`, pulled into
`CLAUDE.md` with `@AGENTS.md`; see the README, Setup):
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
pushed, and the view (`tab`: the phone's tab, a desktop's middle column; see below). Opening pushes one entry; a close button goes back to it, so Back never reopens what was closed and no dead
entries pile up; switching within a kind (another step, another conversation) replaces the entry. Switching
projects is not a layer: it rewrites the entry in place. A page loaded with something open (a hash with a step,
`?chat`) has no entry to go back to, so closing it rewrites the entry instead. Review images open in an in-app
viewer for the same reason: a new browser tab, in an installed app on a phone, had no way back; moving to the next
image replaces the viewer's entry, so one Back always returns to the step. The rules are pure
(`apps/web/src/layers.ts`, unit tested); `nav.ts` applies them to `window.history`.

### Details beside the chat on a wide screen (replaced)

N2B.3 opened a queue or step in a panel on the left and the chat or Ideas in one on the right from 1280 px, the queue
list between them. **Chat-first (below) replaces it**: from 1024 px the chat is the middle column, not a panel. What
N2B.3 taught the history rules stays: switching or closing a layer that is not on top goes back to its entry and
opens the layers above it again (applied as one change, so what stays does not flicker), and a layer that belongs to
another (a conversation to Ideas, an image to its step) closes with it while the others stay. Its 1280 px breakpoint
(`WIDE`, `useWide`) is where the right rail of chat-first begins.

### Chat-first on a desktop

From 1024 px (UX proposals 11A and 12A, the user's choice after queue UX) the dashboard is a chat app with a
project sidebar. The **sidebar** (`ProjectSidebar` in Projects.tsx) lists every project with its waiting count and a
dot while something runs (from the projects API; the list scrolls, so any number fit), and holds the global status at
its foot: an update going on, the usage windows one per row, notifications, the project's settings, remote access;
"live" or "offline" sits at its top. The **middle column** shows one of three views: the project's **orchestrator
chat** (the view a project opens on), **Ideas** (the conversations, the list beside the open one), or the project's
**queues** ("All queues": its queues, the finished ones, refused actions, sessions; below 1280 px also what waits in
it). Its header (`DeskHead` in Chat.tsx) is the Orchestrator / Ideas switch, what the view says about itself (the
chat's state, model and context, "Tool calls", ⋯ with "New conversation"), and below 1280 px "Waiting N". The chat's text keeps a chat app's measure, at most 780 px wide in the middle; the
orchestrator's and the partner's messages are text under a line saying who and when, Nexus's notices a line with a
rule at the left, the composer a card with Send at its right. The phone keeps its bubbles.

**The view is not a layer.** It is the history entry's `tab`, as on the phone, read through `viewOf(nav, "desk")`
(chat first) and switched by `switchTab(…, "desk")`; `nav.ts` picks the layout by the `PHONE` query and turns opening
the chat or Ideas into a view switch on both layouts. So:

- **Switching the view adds no history entry**, and neither does switching projects. Back closes what is open (a
  conversation, a queue or step, an image, Settings, the waiting list) and then leaves the app.
- **A project switch shows its orchestrator chat** (`switchProject` with the desk layout) and closes what was open.
- **What lies beside the column stays when the view switches.** A queue or step opens on the right (`Drawer beside`,
  no backdrop), in the rail's place (see "The right rail"); switching to Ideas or the queues keeps it open: Nexus
  goes back to the entry below it, rewrites that with the new view and opens it again, so Back still closes it and
  the view stays. A conversation belongs to the Ideas view and closes when another view shows; the Ideas switch with
  a conversation open shows the list again.
- **"Chat about this"** on a step shows Ideas and opens the conversation over it with the step still beside it
  (`openConversation`); Back closes the conversation, then the step.
- A `?chat` or `?ideas` link, or a phone's entry in a window made wide, is read as its view (a phone's Waiting tab
  shows the chat).

The approval's **full view** covers the window right of the sidebar. "Ask the orchestrator…" there turns it into the
compact list on the right (the form remembered for that revision, as "Show as a panel" does) and shows the chat
with the reference in its composer, so the queue and the chat are both in view: the full view used to leave a chat
open beside it its room, which no longer exists as a panel.

### The right rail

From 1280 px (`WIDE`) a rail stands at the right of the chat, 372 px wide as in mockup 11A (`RAIL`, `Rail.tsx`):

- **Waiting for you · N, all projects**: one card, an item a row (`WaitingCards` in Attention.tsx): its kind, where
  it is (with its project's name when it is not the current project) and when, the text in two lines; a stopped
  queue has Continue and Open, as on the waiting list. A tap opens the item in its project.
- **Running in <project>**: the project's queues whose run goes now, running or pausing after its step (`atWork` in
  `apps/web/src/rail.ts`, pure, unit tested; decided 2026-11-14, queue FU, after a planned queue showed here as
  "after CL"), each with its honest status from `queueStatus` as a dot and a few words (`shortStatus`: "1/3", steps
  closed of all, or "pausing"). Everything else is where it belongs: what waits for the user (a question, a review,
  an approval, a stop or failure) under Waiting for you; what waits on its own (a retry, the usage window), what is
  paused and what is planned in the project's queues (All queues).
- **Finished today · N**: the project's queues done or cancelled today, most recent first, with their time
  (`finishedToday`, built on `splitFinished`, so one that still waits for the user is not finished).
- **All queues of <project>** at its foot shows the queues in the middle (pressed while they show).

The rail scrolls as a whole: with many items waiting, what runs and what finished come below them.

**Items open over the rail** (quick fix 10): a queue or step, from the rail, the chat or the queues, is a drawer
exactly in the rail's place, so the chat never moves, and Back shows the rail again. On the queues page the project's
own waiting cards are left out from 1280 px, since the rail shows them. **Between 1024 and 1280 px** the rail folds
into "Waiting N" in the chat's header (N: what waits in all projects): it opens the same rail as a drawer in the
rail's place (the `waiting` layer, so Back closes it), and the column makes room for it, as it does for a queue or
step there, which opens over the drawer. Below 1024 px the phone has its Waiting tab instead.

### Refs in the chat

The ids of the project's queues and steps in a chat message ("SF", "UX2", "W4c", "W / W4c") are links that open
the item, on every screen size: over the rail on a desktop, as a sheet on the phone (`nav.item`, so Back closes it and
the chat is there again). They are drawn as a chip with the item's status dot (a queue's honest status, a step's
own: running, waiting, review, stopped, failed), as in the mockups, in the orchestrator's and the partner's messages
(their Markdown, through a rehype step), the user's messages and Nexus's notices; not in tool lines.

Which words are refs is `splitRefs` (`apps/web/src/refs.ts`, pure, unit tested), against an index of the project's
queues and steps (`refIndex`); nothing else counts, so a word that looks like an id is text unless the project has it:

- An id stands alone: no letter (accented ones too), digit or underscore around it; a hyphenated suffix ("SF-et",
  "W4c-nél") is fine. After `/`, `\`, `.` or `-`, or before a file extension or a path's next part, it is a path or a
  file name ("drafts/SC.yaml") and stays text. Code spans, code blocks and links keep their text.
- "Q/S" or "Q / S" is a ref to the step when S is Q's step; otherwise Q alone is.
- A bare step id is a ref when one queue has that step; when several have it, only "Q/S" links it.
- One-letter ids that are also words at a sentence's start (A, I, O) are refs only as "Q/S": a queue called A would
  otherwise turn every "A" into a link.
- Case matters: "ux2" is not "UX2".

Refs link only within the project whose chat it is; another project's ids ("Honeycomb · W/W4c") stay text.

**Files and commits** (decided by the user on 2026-11-14, queue CH3): a file path with a line
(`apps/server/src/engine.ts:138`, `C:\Code\Nexus\README.md:5`) opens the file viewer at the line (`nav.file`; "The
file viewer"), a commit hash opens the commit's details in a drawer (layer `commit:<hash>`, `?commit=<hash>` at load,
`components/Commit.tsx`). They are not checked against the repository while the message is drawn but when clicked: the
viewer and the drawer say "not found". So only their shape counts (`findFileRefs` in `refs.ts`, unit tested), and it is
kept strict:

- A path ends in a file name with an extension (one letter first), then `:line`, optionally `:column` or `-line` (the
  first line is taken). It may start with a drive (`C:\`, `C:/`), `/`, `./`, `../` or `~/`. A bare file name without
  a folder counts only with a known source or text extension, so `example.com:8080` stays text; times (`12:30`),
  versions, `localhost:4317` and `127.0.0.1:4318` have none. A path without a line stays text, as decided.
- A hash is 7 to 40 lowercase hex digits with at least one digit and one letter ("defaced", "1234567" stay text), not
  after `#`, `0x`, `/`, `.`, `-` or a letter, and not the first part of a UUID.
- Nothing inside a URL (`scheme://…`, `www.…`) counts, and both may take a Hungarian suffix after a hyphen
  (`engine.ts:138-ban`, `13118f1-ben`).
- In Markdown, an inline code span that is wholly one file or one commit (`` `src/files.ts:40` ``) is a link too, since
  agents write paths that way; code blocks and links keep their text.

They are drawn as plain links (accent colour, dotted underline), not chips: they carry no status. Relative paths are
the project root's (the endpoint's rule), so a worker's path relative to its own worktree may say "not found".

### The morning digest

"Since you last looked" (UX proposals 16, quick fixes 5 and 9; `Digest.tsx`) sits at the top of the right rail on a
desktop (in the folded rail's drawer between 1024 and 1280 px) and at the top of the Waiting tab on the phone. The
time is stored per device (`nexus.digest.seen` in local storage; the first time, a day ago). The digest shows when
something is new after it, a line of what happened or an item that came to wait (`hasNews`); "Mark as seen" stores now
and folds it until something new comes. It crosses projects through one small read-only API, `GET /api/digest?since=`
(PROTOCOL.md): steps done or failed, stops, queues done or cancelled with their report, refused actions and retries
(one line per step with how many); fetching each project's state would have missed the last two, which live in each
session's refusals and activity, and taken a request per project. It has, in a 372 px column:

- a greeting and the time it counts from; **Mark as seen**;
- **four numbers** (`digestTiles` in `apps/web/src/digest.ts`, pure, unit tested): steps finished (and queues done)
  and queues stopped since the time, then what waits now (by kind) and what runs now (the first with how long it has
  been at its step);
- **what happened, newest first**: time, the step or queue, the outcome in a word or two with its colour (`outcome`:
  "done", "stopped at W4c", "queue done", "2 refused actions", "retried twice"), its words and project; six lines,
  the rest one click away; a tap opens the item, a finished queue's report has "report ▸";
- **Go through them one by one**, when something waits. The waiting list is the one under the digest (the rail's, the
  Waiting tab's), not a copy.
- **the usage line** at its foot (decided 2026-11-14, queue FU; `usageLine` in `apps/web/src/digest.ts`, the numbers
  from `usageSince` in `packages/protocol/src/digest.ts`, both unit tested): "Usage: 5-hour window peak 82%, 7-day
  window now 41%, no waits" (or "2 waits (1 h 5 min in all)"). Its sources are the turn records (`turns.jsonl`) since
  the time: the peak is the highest 5-hour utilization a turn ended with, the 7-day value the latest one (the higher
  of Claude's and Codex's when both reported one); a wait is a turn that ended on a usage limit (until its session's
  next turn, or now while its run still waits) or a run in `usage_wait` now that no such turn explains (from when it
  began). A threshold wait that is already over leaves no record and is not counted. With no turn in the period the
  line says "no agent turns".

**One by one.** The button opens the first waiting item (newest first, as the list) and starts a round in App: once
the item open no longer waits (an answer, an acceptance, an approval, Continue), the next one opens in its place
(`moveOn` in `waiting.ts`, on `waitingPosition`: the first that still waits; an item still waiting at the same place,
such as a review after an answer, keeps it open). Closing the item, opening something else by hand, or the end of the
list ends the round. On the phone the sheet's "2 of 6 waiting" counts along.

### Drafts stay in the browser

Unsent text in the dashboard's boxes is kept in `localStorage` (`nexus.drafts`: one map from a target key to the
text and when it was last touched), not in `.nexus/`: a draft is the user's half-typed thought on one device, the
server has no use for it, and keeping it out of the files keeps "one writer per file" and the files' meaning intact.
The key names the project and the target (`<project>/orchestrator`, `/conversation/<id>`, `/message/<queue>/<step>`,
`/note/<queue>/<step>`, `/answer/<qid>`, `/approval/<queue>`), each part URI-encoded. `Composer` is keyed by it, so
moving from one step or conversation to another remounts the box with that target's own text instead of carrying
the text across. Drafts untouched for 14 days are pruned when the page loads.

### Each chat keeps its place

Decided by the user on 2026-11-14 (queue CH1). The chats are views (the desktop's middle column, the phone's tabs), so
switching unmounts one and mounts the other; each chat, the orchestrator's and every conversation, now keeps its place
in the browser's `localStorage` (`nexus.place:<project>/orchestrator`, `…/conversation/<id>`, like the drafts' keys;
`sessionStorage` until queue FU, which the user moved so the place outlasts a reload and a closed tab; another tab's
change reaches the unread markers through the storage event): the entry at the top of the view (its index in the whole chat, tool lines included, so showing or
hiding them keeps it) and how far past it, whether the view was at the end, and `seen`, the time of the latest entry
that has been in view. The rules are pure (`apps/web/src/chatPlace.ts`, unit tested); `usePlace` in Chat.tsx applies
them:

- **Opening waits for the chat to load** (`ready`: the fetched view is this chat's, not the one shown before), then
  goes to the place, or to the newest message when there is none (the first time in this session, or a chat started
  over and now shorter than the place).
- **Messages that came while away do not move the view**: they are below it, and a "N new ↓" button (messages of
  others after `seen`, not the user's own, not tool lines) jumps to the first of them.
- **While the chat is open and at its end, new messages keep it at the end**; scrolled up, they are counted by the
  button instead. Sending a message goes to the end.
- **Unread markers** come from the same state: a count on the orchestrator's side of the switch and on the phone's
  Orchestrator tab ("Orchestrator 2"), a dot on Ideas when any conversation's last entry is newer than its `seen`, and
  that conversation's dot in the list. A chat not opened in this session has nothing unread: it opens at its newest.

### Quoting in a chat

Decided by the user on 2026-11-14 (queue CH1; docs/ideas/chat-improvements.md). Two ways to quote a message into the
chat's box, both through `withQuote` (`apps/web/src/quote.ts`, pure, unit tested): the quote (`> ` on every line, a
bare `>` for an empty one) goes at the end, after any draft and a blank line, and a blank line follows it; the box
takes the focus with the cursor at the end, so the answer starts below the quote (`putDraftAndFocus` in drafts.ts,
which the open `Composer` hears).

- **A selection** in the messages shows a small floating **Quote** button (`QuoteSelection` in Quote.tsx, in a portal,
  fixed): on a desktop beside the selection's end (below its last line when there is no room beside it), on the phone
  below the selection, clear of the system's menu above it, and 44 px high. It keeps the selected text when it shows,
  so a tap that clears the selection still quotes it. **Alt+Q** does the same (Ctrl+Q and Cmd+Q close browsers on some
  systems). It hides when the selection leaves the chat's view. The browser's right-click menu is not touched.
- **Reply to this**: hovering a paragraph or a list item of a message (on a phone, tapping it) shows an icon at its
  right edge (`Replyable`, the Markdown's `p` and `li`); only the innermost hovered item shows one, and a list item's
  own paragraphs have none. A click quotes the item's **Markdown source**, not its rendered text: `sourceAt` cuts it
  from the message by the position react-markdown gives the node, and a nested item loses its own indentation, so
  "  - two steps\n    - SC1" quotes as "- two steps\n  - SC1". The test parses with mdast-util-from-markdown, the
  parser react-markdown uses, so the positions are the real ones.

### Long replies and message actions

Decided by the user on 2026-11-14 (queue CH4; docs/ideas/chat-improvements.md): a long reply gets a small table of
contents from its headings, and a "jump to the questions" button when it asks the user to decide; every message can be
copied as Markdown, every code block has a copy button, and every message shows its time. "Asks the user to decide" is
recognized from the text, with no new protocol: a heading with "Kérdés" or "Question" in it or ending in "?".

How it is built (`apps/web/src/messageTools.ts`, pure and unit tested; `components/MessageTools.tsx`): the reply is
parsed with mdast-util-from-markdown, the parser react-markdown uses, so the source lines it finds are the ones the
rendered elements carry (`data-md-line` on headings, paragraphs and list items, set in ChatMarkdown); Contents and the
jump scroll to that element (below the sticky line, `scroll-margin-top`) and flash it. Without a question heading, the
first paragraph or list item that asks ("…?", "Question: …") is where the questions start; code and quotes never are.
Copy puts the message's text on the clipboard as it is in chat.jsonl; over plain http (remote access on the home
network), where the Clipboard API is missing, a hidden text area and the copy command do it. Smaller choices made while
building, not by the user, for the orchestrator's review: a reply is long from 1500 characters, Contents needs two
headings or more, and both live on the reply's line, which is sticky (on a desktop the line over the reply sticks to
the top of the chat; on the phone the line under the bubble, with the time, sticks to the bottom), so they are in
reach wherever the reply is read; Copy shows on hover on a desktop and always on the phone; the time is the clock time
("14:02", with the date on another day; the full date on hover), also over the agent's replies and on Nexus's
notices, which showed "5 min ago" before. Finding from building: a sticky element sticks at the scroller's padding edge, so the chat's space at its ends
moved from the scroller's padding to its content; otherwise a strip of text scrolled past above the sticky line.

### Search in a chat, and pinned messages

Decided by the user on 2026-11-14 (queue CH4; docs/ideas/chat-improvements.md): search covers the whole chat, not only
what is loaded; a pin is keyed by the session and the line index in its append-only chat.jsonl, stored by the server in
`sessions/<id>/pins.json` (one writer), and a fresh orchestrator session starts without pins. The files and the API
are in PROTOCOL.md.

How it is built: `readJsonl` gives every entry its line (blank and broken lines counted), and the chat views send each
entry with it, so the dashboard keys entries, pins and matches by line, which never changes. The views still send only
the newest 300 (orchestrator) or 400 (conversation) entries; when a match or a pin is older, the chat loads the lines
from it up to the view's first (`GET …/sessions/:session/chat`) and puts them before (`useOlder` in Chat.tsx). Old
entries never change, so they are fetched once; when the view's window moves past them, the gap is filled. The search
runs on the server over every line (`searchChat` in `@nexus/protocol/chat`, pure and unit tested, shared with the
dashboard's `matchRanges`), a quarter of a second after the typing stops. Matching ignores case and accents ("kerdes"
finds "Kérdés"), on the message's Markdown source; the marks are put into the rendered text (a rehype step in
ChatMarkdown, and `Marked` for plain text), so a match that runs across formatting is counted but not marked.
Smaller choices made while building, not by the user, for the orchestrator's review: next and previous go from
message to message (all of a message's matches are marked, the current message's stronger), starting at the newest,
with "3 of 12" counted in chat order; tool lines are searched only while the chat shows them; the pins bar shows the
two most recently pinned and the others behind "N more pinned", each as who, when and the message's first words
(`excerpt`); the pin button sits beside Copy, and only a message (not a tool line or a notice) has one.

### Stopping a chat agent's turn

Decided by the user on 2026-11-14 (queue CH4; docs/ideas/chat-improvements.md): a stop button while a chat's agent is
working; a pure interrupt (Claude's interrupt control, Codex's turn/interrupt), not a message asking to stop; no text
from the stopped turn is added after it, the chat shows "stopped", the process goes idle, and user messages sent during
the turn and not yet delivered go in with the next turn. The protocol details are in PROTOCOL.md ("Stopping a chat
agent's turn").

Findings from building (probed live with haiku and gpt-6-luna, a few cents): Claude Code still writes the partial text
after its interrupt, and runs the `next` messages it had not read as a new turn right away, so on its own the process
would not go idle; Codex drops a steered message it had not taken in. So the stop lives in the adapters
(`AgentProcess.stop`): while it settles they emit no text, the Claude adapter interrupts the CLI's own follow-up turn and
holds new messages, and the Codex adapter carries what the turn never took in (it reports what it took in as
`userMessage` items). The roles only check that a turn runs and add the notice. Smaller choices made while building,
not by the user, for the orchestrator's review: the button sits above the message box on the right, shown only while
the agent works ("Stop", "Stopping…" once pressed); "Stopped." is a Nexus notice like the others; there is no
confirmation (a stop loses nothing that was written); a stopped hand-over of a conversation hands nothing over.

### Pictures in a chat message

Decided by the user on 2026-11-14 (queue CH2; docs/ideas/chat-improvements.md): pictures go into a chat message by
pasting, by dropping them on the chat, or with an attach button, in every chat composer (the orchestrator, each
conversation, the phone); PNG, JPEG, WebP or GIF up to 10 MB, judged from the bytes; a refused file shows "only PNG,
JPEG, WebP or GIF up to 10 MB" in the composer; the message gets the picture's absolute path on its own line; uploads
are kept. The upload and the runtimes are in PROTOCOL.md ("Uploads", and how Codex gets an image item).

How it is built (`apps/web/src/pictures.ts`, pure and unit tested; `components/Pictures.tsx`): `ChatColumn` holds the
pictures of its draft (`usePictures`) and hands them to the `Composer`. A picture is checked in the browser first (its
first bytes and its size, the server's rules), so a HEIC photo is refused without uploading it, and uploaded at once;
its thumbnail sits above the box, dimmed while the upload runs, with ✕ to remove it, and Send waits for running
uploads. A picture alone is a message (no text needed). The paths are kept beside the draft's text (the drafts'
store, key `<draft>/pictures`), so they survive a reload like the text. A paste that carries plain text stays a text
paste even when the clipboard holds an image too, since Word and Excel put a picture of copied text beside it. The
message is the text, an empty line and the paths, one per line (`withPictures`); a sent message shows its path lines
as the pictures below its bubble (`splitPictures`), served by the file endpoint, and a click opens the picture in a
new tab. Smaller choices made while building, not by the user: the paths surviving a reload, the click opening a new
tab rather than the review viewer, and the plain-text rule for pastes.

### The file viewer

Decided by the user on 2026-11-14 (queue CH3; docs/ideas/chat-improvements.md): a referenced file opens in the
dashboard's own read-only viewer, at the line: code highlighted, Markdown rendered, pictures in the picture viewer; it
works on the phone and starts no program. Files over 1 MB are cut with a note; binary files other than pictures are
not shown.

How it is built (`apps/web/src/fileview.ts`, pure and unit tested; `components/FileView.tsx`; the endpoint in
PROTOCOL.md, "Files and commits"): the viewer is a layer in the history, `file:<line>:<path>` (`nav.file`), so Back
and Escape close it; `?file=<path>&line=<n>` opens it at load. It fetches the file once, and the server's
`X-Nexus-Kind` decides what it shows: a picture goes to the review's picture viewer (alone, "Original ↗" beside it),
a PDF or another binary gets a line with a link instead. Code is shown with line numbers, the line asked for marked
and scrolled to the middle. The highlighter is **lowlight** (highlight.js's grammars, returning a syntax tree rather
than an HTML string): the tree is flattened into lines of tokens and rendered as React text, so file content is
never injected as HTML; its classes take the theme's tokens (`.hl` in `index.css`), so every theme highlights
without a stylesheet of its own. Shiki was the alternative: TextMate grammars, nicer for some languages, but several
times the size and with fixed colour themes; Prism and plain highlight.js produce HTML strings. The highlighter is a
chunk of its own, loaded with the first code file, and so is the viewer; text over 512 KB is shown plain. The
language comes from the extension (unknown ones are plain text, never guessed). Markdown is rendered with
react-markdown and GitHub's extensions (remark-gfm: tables, task lists); raw HTML in it stays text. Its links to
other files of the project open them in the viewer (`..` is resolved in the browser, since the server follows none),
web links open a new tab, its own pictures come through the file endpoint and pictures from the web are not loaded.
Opened at a line, a Markdown file stays rendered and the block holding that line is marked and scrolled to; "Source"
shows it as code at the line. Smaller choices made while building, not by the user: the Rendered/Source switch, the
marked block, not loading web pictures, and a "Raw ↗" link to the file itself (sandboxed by the server).

**Open in editor** (decided by the user; `apps/web/src/editor.ts`, pure and unit tested): beside a text file in the
viewer, a link through the editor's own URL scheme opens the file at the line; the browser hands it to whatever the
system registered for the scheme, and no server action starts a program. The editor is a setting of this browser,
like the theme (`nexus.editor` in local storage; VS Code by default, Cursor, JetBrains, none). It shows only when the
dashboard is opened on the server machine (`local` from `GET /api/server`, the same test remote access uses) and not
in the phone layout: on another device the path would point nowhere. The path is the server's (`X-Nexus-Path`, links
followed), so a relative reference opens the right file. VS Code and Cursor take `vscode://file/<path>:<line>` and
`cursor://file/<path>:<line>`. JetBrains has no scheme of its own that takes an absolute path; the JetBrains Toolbox
App's `jetbrains://idea/navigate/reference?project=<name>&path=<path>:<line>` names a project, given as the project
root's folder name with the path within it, so a file outside the project gets no JetBrains link; the tool in it is
`idea` (IntelliJ IDEA). None of the links was opened while building (that starts a program); on the machine it was
built on only VS Code's scheme is registered, so the Cursor and JetBrains forms are untested.

### Colours are theme tokens

Every colour in the dashboard is a theme token: a CSS variable in `apps/web/src/index.css` (Tailwind's `@theme`),
used through Tailwind's utilities (`bg-surface`, `text-fg-2`, `border-line`, `text-warn`, `bg-review/15`). Tailwind's
own palette is switched off (`--color-*: initial`), so a palette class such as `text-zinc-400` produces no CSS: a
colour can only come from the scheme. The default values are the **Graphite** theme of the UX
proposals (`docs/ux/mockups/mock.css`, item 19); **Paper** and **Honey** set the same variables under
`html[data-theme="paper"]` and `html[data-theme="honey"]`, and every component follows without a change. The
values are the mockup's; `surface-4` (hover over `surface-3`) and `scrim` (black in all three) are additions.

| Token | Use |
|---|---|
| `canvas` | The page; text boxes and inputs; dark chips over pictures |
| `surface`, `surface-2`, `surface-3`, `surface-4` | Panels and cards; raised fills (info boxes, step cards); chips, quiet buttons, the current step; hover over those |
| `line`, `line-strong` | Dividers and card edges; inputs, buttons, a hovered edge (`fg-3/60`) |
| `fg`, `fg-2`, `fg-3` | Main text; secondary text (labels, descriptions); meta (ids, times, hints), still at about 4.5:1 on a surface |
| `accent`, `accent-strong`, `on-accent` | The one accent: actions, links, focus, selection, what is running; a primary button's fill and its text |
| `ok`, `warn`, `stop`, `review`, `info`, `danger` | Status colours: done; waiting and questions; stopped; in review (and the orchestrator's doings); approval and pending deliveries; failed, rejected and errors |
| `user-bubble`, `scrim` | The user's own chat messages; the dimming behind a drawer or menu |

Rules the components keep:

- **A status is a dot and a word** in its colour (`StatusBadge`, the run's state, the update pill), never a ring or a
  filled pill. Step cards are neutral (`surface-2`, the current one `surface-3`); the dot and word carry the status.
- **A kind is a tag**: what waits for the user (Question, Review, Needs approval, Stopped) is the kind's colour on a
  15 % fill of it, without a ring.
- **A callout** (a stop, a merge to confirm, a rejection) is a faint fill of its colour with a 30 % border of it.
- **One accent** for actions: primary buttons, links, focus, checkboxes. Information that is not an action (a
  pending delivery, a planned start) uses `info`.
- Opacity modifiers derive tints from tokens (`bg-warn/15`), so a theme defines each colour once.

### The interface texts in one place

Decided on 2026-11-14 (`docs/ideas/languages.md`): the dashboard is prepared for translation, English the source; the
translations themselves are a later queue. Every text the dashboard shows is a key in one catalogue,
`apps/web/src/messages/en.ts`, and components ask for it through `apps/web/src/i18n.ts`:

- **`t(key, params)`** returns the text in the interface language. `{name}` in a text is a parameter; a number is
  formatted for the locale (`1,234`). A text that depends on a number is a plural message, one form per plural
  category (`{ one, other }`, and `few`, `many`… where a language has them), chosen by the `count` parameter through
  `Intl.PluralRules`. A placeholder without a value stays as written, so a missing parameter shows.
- **`rich(key, params)`** is the same with elements as parameters (a `<code>`, a link): it returns the parts for React
  to render, so a sentence with markup inside stays one text a translator can reorder.
- **A translation** is a catalogue with any subset of the keys (`addLanguage`, `setLanguage`); a key it lacks falls
  back to English, with English plural rules. Keys are typed from the English catalogue, so a typo does not compile.
  A key is named by where its text is used (`rail.…`, `notify.…`, `common.…` for what is shared); a new meaning gets a
  new key, so a translation never keeps an old sense under a changed English text.
- **Dates and times** go through `Intl.DateTimeFormat` with the interface language's locale (`formatClock`,
  `formatDateTime`, `formatDate`, `formatTime`); English uses `en-GB`, the day-month order and 24-hour clock the
  dashboard already had. They follow the interface language, not the reader's language setting, so until a
  translation exists nothing changes (decided with the queue). A hover title that used the browser's own locale
  (`toLocaleString()`) now uses the interface language's too.
- **Durations and "ago"** (`formatDuration`, `timeAgo`) are composed from catalogue texts (`{h} h {m} min`), with the
  numbers through `Intl.NumberFormat`. `Intl.DurationFormat` and `Intl.RelativeTimeFormat` would write "1 hr, 12 min"
  and "5 minutes ago": longer than the dashboard's short forms, and the former is new in browsers; the catalogue keeps
  each language's short form in the translator's hands.

No library: react-intl or i18next would bring a provider, message syntax and a runtime of their own for what is a
lookup, a placeholder fill and `Intl.PluralRules`, about a hundred lines that are pure and unit tested
(`apps/web/test/i18n.test.ts`). The language is a module-level setting, not a React context: how a change of it reaches an
open page (a reload, a key on the root) is for the translation queue to choose.

Code never reads a translated text back: a status built from catalogue texts keeps its key and parameters beside
its words (`HonestStatus.says` in `queueStatus.ts`), and its shorter forms (the rail's few words) are chosen from the
key, not by matching the English label.

A test keeps it so (`apps/web/test/strings.test.ts`): it parses every component and fails on a literal with words
in JSX text or in a text prop (`title`, `aria-label`, `placeholder`, `alt`, and our components' `label`, `hint`,
`button`), naming the file and line. Its exceptions are listed in it with their reasons: product names (Nexus,
Claude Code, Codex), text inside `<code>` (commands, paths), and two path fragments.

Not in the catalogue: texts that come from the server (an action's error message, a run's reason, the stop's place)
and `packages/protocol/src/times.ts` (`retryLine`, the server's own times), which the server also uses; these stay
English until a queue decides how the server learns the interface language.

### One action bar

Every panel that asks something of the user is built the same way (UX proposals, item 13): `PanelHeader` (where it
is, what it is, its status, ✕ at the top right), `PanelBody` (scrolls), `ActionBar` (stays). The bar holds the main
action on the right, the second left of it, the rest under ⋯ (`Menu`), a short hint on the left; what an action
needs (a text, a reason, a confirmation) opens in the bar, above its buttons, so the button and its form are never
apart. A drawer with `panel` leaves all three to its content. One bar per panel: a step's bar is its review when it
waits for the user, else the answer to its first open question (a second open question keeps its box in its card); a
queue's bar is Continue on a stopped queue whose revision is approved, else Approve on one that is not. A form opens
by itself when its draft has text, so nothing typed earlier is hidden. `useDraftText` holds a box's draft, sending
and Ctrl+Enter for both `Composer` and the bars. The chats keep the rule in their top row (the switch left, ⋯ and ✕
right) and the viewer ends with the same bar. The menu closes on Escape without closing the panel: its handler runs
in the capture phase and stops the event before nav.ts sees it.

The theme is chosen per browser, not per project (settings, "This browser"): `localStorage` `nexus.theme`, one of
`graphite`, `paper`, `honey` or `system` (Paper when the system is light, Graphite when dark, following it while the
page is open); nothing stored, or anything else, is Graphite. Like drafts, it is the device's own matter, so it stays
out of `.nexus/`. `theme.ts` holds the rules (unit tested). So that a page never shows the wrong theme first, a small
inline script in `index.html` applies the same rules before the stylesheet paints; a test keeps the two in step.
Opacity modifiers compile to `color-mix()` on the token, with a fixed Graphite fallback only for browsers without
`color-mix()`.

### The phone

Below 1024 px (phones and narrow windows; `PHONE` in `apps/web/src/phone.ts`) the dashboard has a phone layout
(UX proposals, item 18): a top line and a bottom bar instead of the header. The top line is one row: the project
picker, what runs in the project ("SF running"), and settings (with "offline" while live updates reconnect). The
bottom bar has four tabs at the thumb: **Orchestrator** (the chat), **Waiting** (everything that waits in all
projects, with its count), **Queues** (the project's queues; what waits has its own tab) and **Ideas** (the
conversations). The header's tools (the update, the usage, notifications, remote access) are in Settings there, at
the top, under "Nexus on this device". From 1024 px the desktop layout takes over ("Chat-first on a desktop").

The tab is not a layer. It is a field of the history entry (`Nav.tab`), and switching rewrites the entry it is on
(`switchTab` in `layers.ts`), so:

- **Switching tabs adds no history entry.** Back closes sheets and layers, then leaves the app; it never walks back
  through tabs.
- **What is open over a tab closes when the tab changes**, going back over the entries Nexus pushed for it, so none
  is left behind. Tapping the tab already shown closes what is over it (a conversation goes back to the list).
- **A sheet keeps the tab under it.** A queue or step, Settings, remote access, an image push entries as on the
  desktop; their entries carry the tab, so Back from a step opened on Queues shows Queues again.
- **A project switch shows the Waiting tab** (`switchProject`); the chat does not open by itself (on a desktop it
  does: see "Chat-first on a desktop").
- **The chat, Ideas and the waiting list are tabs, not layers, on the phone.** Code that opens them as layers (a link
  with `?chat`, a window made narrow, "Chat about this" on a step) is shown through `phoneView`: such a layer stands
  for its tab, the topmost winning; a conversation stays a layer over the Ideas tab. `nav.ts` turns opening or raising
  them into a tab switch on the phone, and a conversation from a step's sheet closes the sheet, shows Ideas and opens
  the conversation over it (`openConversation`), so Back returns to the list.

On a tab, the chats are inline (`inline` in Chat.tsx): no panel row, since the bottom bar switches and nothing closes
a tab; the chat's ⋯ moves into its own header, and the Ideas tab shows the list or one conversation at a time.

**Sheets.** On the phone a queue or step, Settings and remote access open as full-screen sheets. A panel's header
becomes one row: ‹ (back to what was under the sheet), where it is, its place among what waits ("1 of 6 waiting")
and ✕; the title and status follow below it. Every sheet closes with ‹, ✕ or Back, and every button of a sheet's
header and action bar, the bottom bar and the waiting cards is at least 44 px high (Tailwind's `max-lg:`, the same
breakpoint as the phone layout).

**Questions.** A step with an open question opens on the phone as the question's sheet (`QuestionSheet` in
Details.tsx): the question first, what the orchestrator said passing it on, the options as 48 px buttons, the user's
own words, whether the worker may go on, then the step's details below; Answer in the action bar. An option and words
go together in one answer: the option, a blank line, the words. A waiting card shows a question's options as buttons
(the attention item carries `options`); a tap opens the sheet with that option chosen and the user confirms there.
The choice travels in memory (`chooseOption`), not in the URL: a reload opens the sheet with nothing chosen. On the
desktop the card has no option buttons and the step keeps its answer box in the action bar.

**Waiting cards** put the kind, where it is and when on one line and give the text the full width (three lines). The
phone's chat composer is one line that grows with the text (up to six) and a round Send.

**What waits, in order.** `waitingPosition` (`apps/web/src/waiting.ts`, pure, unit tested) tells where a place (a
project, queue and step) stands in the waiting list, newest first, and which item comes next: several items at one
place count as one; next skips them and wraps round to the first; a place no longer waiting (just answered) has no
position and its next is the first that waits. The phone's sheets show the place ("2 of 6 waiting") now; the next
item's button and the desktop's waiting rail build on it.

### A queue's steps as a list, with one honest status

A queue on the project page (UX proposals, 17B) is its header, a progress line with a segment per step coloured by its
status, and its steps one line each: a dot, the id, the title and the status. The step that matters (the one at work,
the stop, else the first not finished, once the queue has started) is tinted by its status and gets two lines more:
why it is where it is (the stop's reason, the question, its summary, its progress, why its run is paused) and its
action. A stop's is Continue right on its line (see "Continue at the stop" below); **Review…** and the questions
open the step. On the desktop the steps fill two columns, the left first, all of
them. On the phone (`foldSteps` in `apps/web/src/steplist.ts`, pure, unit tested) one column folds what does not
matter now: the leading run of done and skipped steps becomes one line ("W1 – W4b · 3 done, 2 skipped ▸"), and so do
the steps after the third that follow the step that matters ("+ W6, W7 ▸"); a fold of a single step is shown instead,
and a tap unfolds. The finished queues keep their own folded group at the bottom of the page (FQ).

One status per queue (`queueStatus` in `apps/web/src/queueStatus.ts`, pure, unit tested; survey Q3) replaces the
status, run and question chips that contradicted each other. It reads, first match wins: cancelled; stopped (at the
step that holds the stop); failed at a step (unless a run took it up again); waiting for the user's review (one step,
or how many); waiting for an answer (a question the worker waits on); the orchestrator reviews; then the run as it
really is: running, pausing after a step, waiting to retry, waiting for the usage window; done; a planned start (or
that it did not start); and a queue whose steps say they run while no run goes reads **paused**, with its run's reason.
Proposed reads "needs your approval". Open questions and the steps in review are counted beside it ("5 of 11 · 2 in
review"). The step lines follow the same rule: a step whose events say it runs while its run does not reads paused,
without a progress bar. The page's groups are unchanged here; the desktop layouts of the next queue use the same helper.

### Approving: the whole queue in one scroll

The approval (UX proposals, 15, and 13 left) has two forms of the same thing, both in `apps/web/src/components/
Approval.tsx`. The **full view**, a layer over the whole window, is what a desktop opens for a queue whose revision
waits for approval (`needsApproval`: not approved, neither done nor cancelled), from its waiting item and from the
queue, so reading and approving a 4-step queue takes 2 clicks (it took 7): the title with its status, run settings
(`runSettings`: the run's values, else its planned start's, else the project's) and who proposed it on one line; an
outline on the left (description, each step, stop conditions, checks) that follows the scroll, and keeps a part picked
in it marked while that part shows; every step's goal and acceptance in the page. The **compact list** is the queue's
drawer on a desktop and its sheet on the phone: one row per step, "N criteria ▾" opens the goal and acceptance in
place, the rest as folds. The phone opens the compact list; "Full view ⤢" and "Show as a panel" switch, remembered per
revision while the page lives (a choice, not history: Back closes the queue whichever form shows). On a desktop the
full view leaves the project sidebar in sight, and "Ask the orchestrator…" turns it into the panel beside the chat
("Chat-first on a desktop").

Both forms share the approval (`useApprove`: the words under ⋯, the button, what it pins; Keep or Discard of a stopped
queue's revision through `stopDecision`, so Approve waits for the choice), Ctrl+Enter outside a text box, and "Ask the
orchestrator…", which puts "About queue X (revision N): " at the start of the orchestrator's composer (`putDraft`
tells an open composer) and raises its chat. The orchestrator's message is found in its chat (`draftOf`): the first
message after its last `nexus queue draft` of the queue's file; a draft from stdin or a queue imported by hand has
none, and the line says "imported from" or "proposed" instead. No server change.

### Continue at the stop

A stopped queue goes on from where its stop shows (UX proposals, quick fix 4): the stopped step's line in the queue's
card, the stop's waiting card (in the waiting list across projects, and on the project's page), and the queue's bar.
The reason is shown once per view: on the project's page the stopped step's line carries it, so the waiting card above
names the queue instead (unless the card shows no stopped step: a queue that never ran). Every place, the queue's
drawer and bar included, has one read of what the stopped step left (`useLeft`), one Continue (`useContinue`), both in
`apps/web/src/components/Stop.tsx`, and its buttons, their words and the hint from one pure decision
(`stopDecision`, `apps/web/src/stopDecision.ts`, unit tested), so no two places can disagree. With the
revision approved and nothing to decide, **Continue** lifts the stop at once; when the stopped step left commits of
its own, **Continue…** opens SC2's Keep or Discard in place (the commits, the uncommitted changes, the two choices,
then Continue or "Discard and ask for a revert"); once Discard is recorded no place offers Continue (the server would
ask for the choice again) and each says so instead: approving the orchestrator's revert lifts the stop. A revision not yet approved has **Approve revision N…**, which opens the
queue. What a stopped step left comes from git on the server, which takes a second or more on Windows: the places
showing one stop share one request per queue and version (its times) and show the last answer while reading anew.

### Reviewing: the pictures first, the decision in the viewer

A step that waits for the user's review opens on what to judge (UX proposals, 13 and 14): its summary, what the
orchestrator asks, then its pictures, large, two per row, each with its mark (✓ marked, ⇄ has a before, 💬 comments)
and "k marked"; links and sheets follow as one line of links. The checks are one line of ✓ and ✗ beside three folds,
Goal and acceptance (with what to prepare), Commits · N and Timeline, which open in place. Accept is in the action
bar, under the evidence. The step's other parts (its chat, notes, messages, activity) follow below. Steps that do not
wait for the user keep the usual order.

The viewer has a top bar (‹ back to the step, the picture, "picture 3 of 7" and where, After | Before | After |
Overlay, ✕), a filmstrip of all the step's pictures with their marks and the one shown framed, and the same action bar
as every panel: for the picture on the left its mark and a one-line comment (Enter sends), for the step on the right,
while it waits for the user, the drawer's decision (⋯ with Reject and a note, Fix it…, Accept the step), so the user
decides after the last picture without leaving the viewer. Both bars share one hook (`useReviewDecision`); each keeps
its own open forms, and Fix it's text is the same draft in both. The arrow keys move (not while typing in a box), and
a swipe moves in every view: the picture alone, before and after, and the overlay outside its slider.

### A project's rules: AGENTS.md, pulled into CLAUDE.md

Decided by the user on 2026-11-14 (notes in docs/ideas/project-rules-file.md, queue PR). The two runtimes load
different files by themselves: Codex reads `AGENTS.md`; Claude Code reads `CLAUDE.md` and sees `AGENTS.md` only when
`CLAUDE.md` pulls it in. Nexus's convention, as in Nexus itself: a project's rules are in its `AGENTS.md`, and its
`CLAUDE.md` pulls them in with a line `@AGENTS.md`; the orchestrator's briefing says that rules it proposes go into
`AGENTS.md`. Decisions that send a project's own conventions "to its AGENTS.md" (review material, refactoring) rely on
both runtimes seeing that file.

- **The check is pure** (`packages/protocol/src/rules.ts`), from the two files' contents: linked is a line `@AGENTS.md`
  or `@./AGENTS.md` outside code fences. `nexus project add` prints it; the project's page warns, naming the runtime
  that would not see the rules. A project with neither file gets no warning.
- **The fix is the user's** and changes the project's own files, which is new for Nexus (it otherwise writes only
  under `.nexus/`): a dashboard action only, shown as the change to each file before it is made, written by the server
  and not committed. It keeps the files' bytes (BOM, line endings) and refuses a file that is not UTF-8 rather than
  re-encode it. "A run in the root checkout is not finished" is read as a run that holds that checkout
  (`CHECKOUT_RUN_STATES`, paused included): a halted run holds nothing and does not block the fix; a worker that comes
  back to a changed file reads it again at its next turn. The fix carries the check's `version` (a hash of both files),
  so a file changed after the user looked is never overwritten by a change the user did not see.
- **Moving `CLAUDE.md` into `AGENTS.md`** leaves the link lines out of the moved text (they would import the file
  itself), and lists the @imports it holds: Codex does not follow them, so the confirmation says so.

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

- **A turn's tokens and cost, per runtime** (probes 2026-11-14, two turns in one session each). Claude Code
  (2.1.323, haiku; $0.0066): `result.usage` is the turn's own (the second turn's output was 172 tokens while the
  cumulative `modelUsage` said 175), and `total_cost_usd` runs on through the process ($0.00325, then $0.00659), so a
  turn's cost is the difference from the previous result; a resumed process's total starts with turns this process
  never saw, so its first turn's cost is left unknown. `result.usage` covers the main agent loop only (subagents'
  tokens are in `modelUsage`). Codex (0.167.2, `gpt-6-luna`; about 34k tokens, mostly cached): every
  `thread/tokenUsage/updated` carries the thread's running `total` and `last`, the figures of one model request
  (a turn with tool calls has several), so a turn's tokens are the difference of `total` between its start and end;
  when the start is unknown (a resumed thread), the turn's `last` figures are summed. Codex reports no cost. The
  adapters normalize both to `input` (not from the cache), `output`, `cacheRead` and `cacheCreation`: Codex's
  `inputTokens` includes `cachedInputTokens`, Claude Code's `input_tokens` does not.

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

- **Windows does not replace a file another process has open.** Nexus writes its files atomically (a temporary
  file, then a rename over the target). On Windows the rename fails with `EPERM` while any other process has the
  target open, even only to read it: an agent's `nexus` CLI reading `run.yaml`, a test polling it, the other server of
  an update, the search indexer. Measured on 2026-11-13: a rename onto a file another Node process held open failed
  with `EPERM`, and went through once it was closed. The engine took such a failure for an engine error and halted the
  run; under load (a full test suite beside CPU-bound processes) the server-process tests timed out now and then for
  this reason (queue SF, step SF3). Every such rename now tries again for up to 2 s (`renameRetrying` in
  `packages/protocol/src/store.ts`); other errors are thrown at once.
- **Queue drafts go through files, not heredocs.** On 2026-11-12 an orchestrator could not upload a long queue
  revision: `cd … && nexus queue draft - <<'EOF'` was refused in `dontAsk` mode (a chained command does not match
  `Bash(nexus:*)`), and the heredoc alone (about 8.5 KB; about 7 KB worked) broke in Claude Code's Bash wrapper on
  Windows, with YAML lines reaching the shell as commands. The orchestrator now writes `.nexus/drafts/<queue>.yaml`
  and runs `nexus queue draft` on that file, and the heredoc form left its briefing. A probe (Claude Code, `haiku`,
  `dontAsk`, the orchestrator's exact lists, about $0.02 for three runs) showed that `Edit(<path>/**)` alone also
  permits `Write` there, creating missing directories, while `Write(<path>/**)` alone permits nothing; Nexus keeps
  both rules so the allow list says what is meant. `Write` and `Edit` must not be disallowed, since a disallow rule
  beats an allow rule.
- **Git for Windows cannot remove a worktree with node_modules in it** unless `core.longpaths` is on: it drops the
  worktree from its list, deletes what it can and fails with "Directory not empty" on paths beyond 260 characters
  (seen 2026-11-14, the capture tool's base worktree under the temporary folder). The capture tool asks git a few
  times, then deletes the rest with Node's `rmSync` (long paths, retries; junctions not followed) and prunes.
- **Pictures in chat messages: Claude Code opens a path, Codex needs an image item.** Probed on 2026-11-14 (queue CH2)
  through Nexus's own adapters, with the chat roles' exact permissions, in a temporary project, with a PNG showing the
  number 47 at `.nexus/uploads/…png` and the message "What number is shown in this picture? … \n<path>". Claude Code
  2.1.323 (`haiku`, effort low, `dontAsk`) used `Read` on the path and answered "47", as the orchestrator and as a
  partner ($0.0044 each). Codex 0.167.2 (`gpt-6-luna`, effort low, a partner's `workspace-write` sandbox in the
  notes folder, approvals `never`) did not try to open it: "I can't access that image path from here" (about 17k
  input tokens). Given the same text with a `localImage` item for the path, it answered "47" (about 16k input tokens,
  mostly cached). So the message keeps the path on its own line for both, and the Codex adapter adds the item for
  every such line of an uploaded picture. An item whose file is missing does not fail the turn: the model is told the
file is missing ("I can't read the image because the file is missing"); the adapter leaves such a line as text only.
Total cost of the probes: about $0.009 of Claude usage (two turns) and, for Codex (gpt-6-luna, seven one-turn
threads), about 117k input tokens, about 90k of them cached, and under 100 output tokens.

## Open questions

1. **The orchestrator on Codex.** The orchestrator runs on Claude Code only: its read-only guarantee rests on Claude
   Code's `dontAsk` mode. Codex's `read-only` sandbox could give the same, with `.nexus/` writable; not built yet.
