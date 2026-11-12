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
its status, then marks the step `waiting` and tells the orchestrator.

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
runtime's permissions (for Claude: read-only tools plus `Bash(nexus *)`), not only by instruction.

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
  writable root).
- Hooks are installed per project only for the observe-only path and for session-start context; the Nexus-launched
  path does not depend on them.

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

## Open questions

1. **Codex parity.** The app-server offers the same moves (turns, `turn/steer`, `turn/interrupt`, token usage); to be
   confirmed in phase 5.
