# Goals, concepts and decisions

Part of [the design](../DESIGN.md).

## Goals

1. **See what is happening.** For every project: finished, running and planned queues; for every step its state,
   its acceptance criteria, its review material; for every running agent what it is doing now.
2. **Talk without interrupting.** Leave a note on a step that has not started (delivered when it starts); send a
   message to a running step (delivered at the agent's next safe point); answer an agent's question.
3. **Only open the dashboard.** Each project has an orchestrator chat. The orchestrator plans queues with the user
   and starts, resumes and stops sessions. The user does not need a terminal.
4. **Generic.** Claude Code and Codex are both first-class. Nothing in the protocol is specific to one runtime or
   to one project's conventions; Project Honeycomb's queue practice is the first example, not the schema.
5. **Reuse context, narrowly.** Each queue starts in a new session by default. A session is continued only for work
   that builds directly on the same code it just worked on, and only while its context is small (about 150k tokens):
   a long context costs more on every turn, and works less well, than reading the files again (queue CT, decided by
   the user on 2026-11-19).
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
- `review`: the step's work is finished and its review material is ready. Every step is reviewed, by the user or
  the orchestrator, as its review level says (PROTOCOL.md, ["Review"](../protocol/review.md#review)); there is no level without review (the user's
  decision of 2026-11-14). Until RL2 a step in review holds its queue.

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
["Failures"](engine-failures.md#failures) below; nor is one that ended while work the agent started still runs: see ["Background work"](engine.md#background-work).

## Tech stack

| Part | Choice |
|---|---|
| Language | TypeScript throughout, run natively by Node.js 24+ (type stripping: no build step for CLI and server), npm workspaces |
| `packages/protocol` | Schemas (zod) for every file and event; shared by server, CLI and web |
| `packages/cli` | The `nexus` command agents run; validates and appends |
| `apps/server` | Hono (HTTP), ws (WebSocket), chokidar (file watching), the runtime adapters |
| `apps/web` | React, Vite, Tailwind CSS; usable at phone width; installable as a PWA later |
| Storage | The `.nexus/` files are the source of truth; an in-memory index, SQLite only if search or history needs it |
| Static analysis | ESLint (typed, correctness rules only) and dependency-cruiser (module boundaries): `npm run lint`; knip (unused code): `npm run knip` |
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
| Stop at every step for review? | Every step is reviewed, at its review level: by the user (1) or the orchestrator (2, 3); at level 3 the queue goes on (2026-11-14, replacing `review_policy: continue`) |
| Who creates worktrees? | Nexus, by itself, for queues that ask for one |
| Watch the usage limits? | Yes; pause before the limit, resume when it resets |
| Where does `.nexus/` live? | In the project's main checkout, git-ignored |

## A project's rules: AGENTS.md, pulled into CLAUDE.md

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
  (`runHoldsCheckout`, paused included): a halted run holds nothing and does not block the fix; a worker that comes
  back to a changed file reads it again at its next turn. The fix carries the check's `version` (a hash of both files),
  so a file changed after the user looked is never overwritten by a change the user did not see.
- **Moving `CLAUDE.md` into `AGENTS.md`** leaves the link lines out of the moved text (they would import the file
  itself), and lists the @imports it holds: Codex does not follow them, so the confirmation says so.

## Removing a project (queue PJ)

The user decided (2026-11-15) two levels, both theirs only and only while nothing runs: "Remove from Nexus" (off the
registry, `.nexus/` kept, `nexus project add` brings it back as it was) and "Delete Nexus's data" (the `.nexus/`
folder too). Neither touches the project's own files, nor the worktrees and branches Nexus made: those belong to the
project's git repository. It goes through the server's API and not the CLI, so the write guard keeps it to the
dashboard's page and no agent can remove a project, its own or another.

"Nothing runs" is what would otherwise be cut off or left behind: a run that started and did not finish (a stopped
one too: its stop waits for the user's decision), a merge back, a deploy planned after the project's work, an agent in
a turn, an update. What only waits for a time or an answer (planned and scheduled starts, open questions) goes with
the project, and comes back with it: the files are the contract, so re-adding rebuilds the same state.

Deleting is the one place Nexus removes a folder by itself, so its target is fixed in code rather than trusted from a
path: `realpath(root)/.nexus`, a folder of its own (a link or junction there could point at anything, and Node's
`lstat` sees a Windows junction as a link), holding a `project.yaml`, of a project in this server's own registry. The
server becomes the registry's second writer; both writers are the user's own actions, each a whole-file rename, and
the server drops a project the moment it unregisters it, in one synchronous stretch, so no request in between loads
it again.
