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
- `review`: the step's work is finished and its review material is ready. Every step is reviewed, by the user or
  the orchestrator, as its review level says (PROTOCOL.md, "Review"); there is no level without review (the user's
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

### Worker process ownership on Windows (queue PT)

The worker's process tree belongs to its session. At a step outcome, after the turn is idle, the engine waits for
descendant cleanup before opening another step or settling at review or a stop. Questions and turns without an
outcome retain the existing background-work wait. Stop now cleans when its turn ends; Stop at once, shutdown,
session completion and unexpected runtime exit end the whole tree. The runtime stays alive between steps.

Each Windows worker has a private Job Object, hosted by `worker-job.ps1` and the repository's `worker-job.cs` through
PowerShell's Add-Type (approved by the user for PT1; no npm dependency, downloaded binary or installed compiler).
AgentHost enables it only for worker sessions, never orchestrators or thinking partners. The helper joins the job
before it starts the runtime: every ordinary descendant inherits membership, even if a short-lived intermediate
parent exits. This is why snapshots of parent PIDs were rejected: a parent can start and exit between snapshots.
Breakaway is not enabled. The non-inheritable job handle has kill-on-close; losing the server's pipe or the helper
also ends the tree. Failure to create or join the job fails the launch instead of silently starting an unowned worker.

At a step boundary, the helper enumerates job members except itself and the runtime, opens each as a process handle,
verifies its membership on that same handle, terminates it and waits for exit. A reused PID outside the job is
never terminated. Enumeration repeats until only the two roots remain; failure or a timeout halts the queue and
ends its worker, without opening the next step. New inbox delivery waits for the cleanup acknowledgement. Runtime
resumes, including a cancelled deploy's automatic resume, wait for that acknowledgement too; a later run change
cancels the deferred request. A runtime exit after a reported step is not retried even if the review was already
accepted while its exit notice was in flight. The next step starts a fresh runtime in the same session.
Runtime exit cleans descendants before the adapter emits exit. Closing the runtime's input has a five-second grace period;
an unresponsive control reader is ended after a further fifteen seconds, closing its job. Windows worker recovery
does not kill a persisted PID: job ownership ends with the old host, and a number alone is not proof of ownership.

**The console is infrastructure.** The helper allocates its own console before joining the job, hides it, restores
its redirected control pipes, and shares that console with the runtime. Creating the console inside the job caused
step cleanup to kill its conhost; the runtime survived but its next node child failed with `0xc0000142`. A focused
probe reproduced that fault, and the fake-runtime test now checks that the same runtime starts work in step two.
No process is selected or exempted by name or command line. The helper's console ends with the helper.

Full-suite validation exposed test waits that included more work than their names: a chain's start wait also waited
for its entire run, and a question wait included the preceding step. These now wait separately for each boundary,
using the existing named step/run budgets, without changing the global waits. The chat-stop fake-log reader also
waits for a newline before parsing a record, including when a file has just been created; malformed complete records
still fail. A deterministic partial-write test covers that reader race.

The Windows integration tests use both fake runtimes, actual sleepers, an orphaned grandchild, and a second worker.
They cover step continuation, review, stops, interruption, shutdown, runtime exit and cleanup failure. No real model
was called. The cross-step test holds the first step until a test observer retains Windows process handles, then
allows cleanup and asserts exit while those handles remain open. A full-suite run failed its old PID-only exit
assertion; those snapshots cannot distinguish a surviving child from a recycled PID. Retained handles prevent PID
reuse during the assertions, without weakening the requirement that cleanup precedes the next step. Each worker
has its own release barrier, so releasing the first cannot finish the isolation sentinel's step.
The helper's internal pipe protocol is in PROTOCOL.md. This Windows implementation leaves non-Windows
launching as before. Job membership covers normal process creation, including detached children, not work delegated
to an unrelated system service (`Win32_Process.Create`, for example); Nexus does not chase such processes with
heuristics. References: [Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects) and
[AssignProcessToJobObject](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-assignprocesstojobobject).

### Nexus runs the checks (queue EC)

Designed in EC1 from the user's decisions of 2026-11-17 (docs/ideas/token-costs.md) and 2026-11-16
(docs/ideas/worker-phases-and-resources.md); built in EC2 (the capacity coordinator, `apps/server/src/capacity.ts`) and
EC3 (the engine, `apps/server/src/check-runs.ts`, and the derivation, `packages/protocol/src/checks.ts`) and EC4 (the
briefings, AGENTS.md and the dashboard, `apps/web/src/checks.ts`). The file formats are in PROTOCOL.md, "Checks run by Nexus". Points marked
**(P1)**…**(P17)** went beyond the decisions: EC1's proposals, which the user accepted on 2026-11-18, P3 made more
precise and P6 changed (below).

**Why.** A worker ran the full suite at every step's end, and every call around it (starting it, polling it, waiting
for the full-test lock, reading the output) re-read the worker's whole context: about 16% of the cost of the analysed
transcripts, 563 full runs and 512 polls of the lock. The engine runs the same commands without a model; the worker
sees output only when something fails. While working, the worker still runs the targeted tests
(`npm run test:files -- <files>` in Nexus).

**When.** The worker's turn ends with `nexus step done`; the engine cleans the worker's descendants as today (queue
PT), then runs the checks, then sends the step to review. The step is not in review, and nothing of the step's end
happens yet (the next step, the closing step, context care's switch, a plan or a deploy waiting for the step), until
the checks have passed: a failure goes back to the same session, which holds the context the fix needs. `nexus step
failed` and `nexus stop` run no checks. Which checks: the project's and the queue's, each once, as the step's opening
lists them, every one a shell command run in the queue's checkout **(P1)**. Steps opened before the change keep the
worker's reporting: whether Nexus runs a step's checks is fixed when the step opens.

**How.** Each check is a child process outside the event loop (`spawn` through the shell, never `execSync`), in the
queue's checkout, its stdout and stderr to a log file under the queue's folder, nothing of it kept in memory but the
tail. On Windows it runs in a Job Object of its own, as a worker does (queue PT), so the check's whole tree, detached
children included, ends with it and its end can be observed. The server writes the check's state (command, start,
end, exit code, the log's path) to a file before it starts the process and after it ends, so a restart finds what was
running. The checks of a step run one after another, as one heavy operation **(P2)**, all of them even after one has
failed, so one fix round sees every failure **(P3)**. A check has a time limit, past which it is ended and counts as
failed **(P10)**. The checks run on the checkout as it is; the result records its HEAD and whether tracked files had
uncommitted changes (`nexus step done` already warns about those).

**A failing check is run once more.** Only the failed ones, within the same grant of the machine, right after the
set, where the code has not changed (P3 as the user made it precise on 2026-11-18). After a check-fix round or a
send-back, any new code, every check runs again, the ones that passed before too: a green result does not carry over
to new code. Passing the second time, the step goes on and the check is recorded as flaky for that step: the statistics count
it, and the orchestrator hears of it with its next notice, so it can propose a maintenance queue **(P14)**. Failing
twice, the worker gets a check-fix round: a message to its session with the failing tests' names (where the output's
format is known), the end of the output and the full log's path **(P15)**. It fixes, commits and ends with `nexus
step done` again, and the checks run again, all of them.

**The check-fix round is not a send-back.** It has its own limit, 3 by default (decided "like
`review_send_back_limit`") **(P4)**, and is counted apart: the step's review round (send-backs, the round of
its review pictures) stays as it is, and the fix round is numbered within it **(P13)**. After the limit the run halts
for the orchestrator, which decides what comes next **(P5)**: a Resume gives one more round.

**A failure that is not the work's** (P6 as the user changed it on 2026-11-18). A worker that finds a failure unrelated
to its work (it fails on the base too, a test it did not touch that fails now and then) does not patch around it: it
says so with its evidence (`nexus check --unrelated`), and Nexus itself runs that check on the queue's base commit, in
a worktree of its own, through the same coordinator. Failing there too, the failure is accepted: the step goes to its
review, and the failure is recorded for the statistics and a fix queue. Passing there, the failure is the queue's: a
fix round, counted toward the limit, without a dispute. Only when the check cannot run on the base (the command or
script is not there, the setup fails) does the orchestrator decide (accept or fix), its reason recorded. The evidence
is checked by a run, not by a judgement, wherever a run can tell.

**Every accepted failure gets a fix queue at once** (the user's decision of 2026-11-18), without exception: Nexus
proposes it itself, origin `ci`, from a shipped template (`check-failure`): the first step (debugging) reproduces the
failure on the base and finds its cause, the second (code) fixes it so the full run passes under load too. Its
description carries the check, the tests' names, the log's path, the step and the worker's evidence. While one is open
for the same test, a new occurrence is added to its description instead of a second queue. The orchestrator is told,
to complete it and put it into the plan. A flaky failure, which passed on its second run, gets no queue of its own: it
is in the statistics and in the step's review notice **(P14)**.

**Restarts and updates.** After a restart, a check that was running is run again, not re-attached: the old server's
check processes ended with its Job Objects (kill-on-close), and a log half written says nothing certain. A server that
stopped mid-check brings its run back paused like any; the check runs again when the run goes on **(P9)**. An update's
drain waits for running checks for a while **(P8)**, then stops them (recorded as interrupted, not failed), and they
run again after the hand-over with the held run. Checks waiting for the machine do not start while an update drains.
A Pause lets running checks finish and takes effect before the review or the fix round; Stop now and Stop at once end
them, and they run again when the run goes on **(P16)**.

**What the worker, the orchestrator and the review see.** The step's opening says that Nexus runs the listed checks
after `nexus step done` and that the worker runs only the tests of what it changes. `nexus check` no longer reports a
check Nexus runs **(P7)**; it remains for the evidence of an unrelated failure and for steps whose checks the worker
runs. The review (the orchestrator's notice, later the review helper) gets the engine's results, with flaky checks
marked: a step reaches review only with its checks passed, or with a failure the orchestrator accepted. The review
levels, the merge train and the merge back's condition ("the integration step's checks in its last round passed") do
not change; they read the engine's results. The closing refactoring step no longer runs the checks before it starts:
it starts at the HEAD on which the last step's checks passed, and its opening says so **(P12)**. The integration step
works as before (merge, `nexus step done`), and its checks are Nexus's like any step's; that it runs without a model
when the merge is clean is queue MI's (see "The integration step without a model").

**AGENTS.md "Before every commit"** keeps typecheck, lint and the tests of the changed files before each commit (the
worker still commits several times in a step); its second half says (EC4): the whole suite is no commit's check, it
runs at the step's end as the queue's checks, run by Nexus, which waits for the machine; only a step whose opening does
not say so (an older server's, work started by hand) has its worker run and report them.

**The step's states.** A step gets one new status, `checking`, between `running` and `review`, with a phase:
`queued` (waiting for the machine; what it waits behind is the machine's line in `nexus status`), `running` (which
check, since when) or `base` (a disputed check on the base commit). A disputed failure waiting for the orchestrator's
decision is `waiting` (phase `decision`). A step in a check-fix round is `running` with its fix round number, shown
apart from a send-back's round. The queue stays `running` and the run holds its checkout throughout.

**Findings from building it (EC3).**

- **The engine runs the checks only with the capacity coordinator.** The server always gives one; an engine without
  (most engine tests, which use the fake runtimes for other subjects) leaves the checks to the worker as before. So the
  existing tests keep their behaviour, and only the tests about the checks run commands.
- **cmd.exe's switches cannot be quoted**, and the worker's job host quotes every argument for CreateProcess. A check
  runs as `node -e <launcher> <command>`, the launcher calling `spawnSync(command, { shell: true })`, which builds
  cmd.exe's line as Node always does.
- **The output may arrive after the job host has closed**: the log is closed only once both streams have ended (at
  most two seconds after the tree), else the end of the output was lost.
- **A Job Object per check costs a second or two on Windows** (the host's PowerShell compiles its helper). The tests of
  the engine's logic run their stand-in checks without one (`Capacity`'s `jobs: false`); the tests of a restart and a
  drain, which end a check mid-run, use one: without it, ending the launcher leaves its child running, holding the
  output pipe open.
- **Events the derivation does not handle never reach a step's timeline.** `check.disputed` and `check.decided` are
  listed there explicitly, since the checks' derivation and the engine read them from the timeline.

**Findings from EC4.**

- **A check-fix round the worker took up was lost.** The derivation read the checks only for a step in `review`; a
  worker that opened its round with `nexus step start`, as its turn asks, made the step plain `running`: no round
  number on the dashboard or in `nexus status`, and a dispute said after it never ran on the base (the CLI took it,
  the engine never saw `checking`). Seen in the dashboard's pictures of a fix round on the fake runtimes. The
  derivation now reads a step `running` after a failed (or accepted) set's done as in that round, and an accepted
  dispute sends it to its review as of the done.
- **The dashboard's pictures run the real engine.** The capture seed (`scripts/capture/seed-check-runs.ts`) gives the
  test projects a `package.json` whose scripts are the checks (a ten-minute `npm test`, or one failing in TAP), and a
  start due at once: the fake worker reports its step done, and the engine runs, queues or fails the checks as it
  would. `NEXUS_TEST_LOCK` must name a file of the capture's own, else a full run elsewhere on the machine holds the
  coordinator, and every check reads "queued".
- **What a queued check waits behind is not on the dashboard yet**: the machine's line (`capacity.yaml`) is read by
  `nexus status` only; the step says it waits for the machine and since when.

#### The capacity coordinator, first slice

The checks are the coordinator's first user (decided 2026-11-16 and 2026-11-17): one heavy operation per workstation,
across projects, granted atomically or queued, the queue shown, released when the operation's processes have ended,
and never a start without the grant after a time. Built in EC2 (`apps/server/src/capacity.ts`; PROTOCOL.md, "The
capacity coordinator"), with no user yet until EC3. In this slice:

- **It lives in the server**, which serves every project of the workstation, and keeps its state in a file of its own
  (`<NEXUS_HOME>/capacity.yaml`, the server its one writer), so the dashboard and `nexus status` show the queue and a
  restart finds it. The workstation has an id (its host name) from the start, for the later model of several machines
  **(P17)**.
- **One slot, `heavy`**: one step's checks at a time on the machine. Requests are served in the order they came (by
  `requested_at`); a waiting request shows what holds the slot and since when, and what is ahead of it.
- **Release follows the process**: the grant ends when the check set's last process tree is gone (the Job Object is
  empty), not when a worker or the engine says it is done. A check ended at its time limit releases only once its tree
  is gone.
- **No time bypass**: waiting long gives status, never a start beside another heavy operation.
- **After a restart** the old server's grants are void (their processes ended with it), and the queue is rebuilt from
  the checks files: the requests not finished, in their order.
- **Outside Nexus**: a full test run started by hand (or by an agent against its briefing) is not Nexus's to control.
  `scripts/test-lock.ts` stays the machine-wide guard of `npm test` and `npm run test:times`, whoever starts them, the
  engine's checks included; the coordinator shows a lock held by a run outside it as what occupies the machine, and
  grants nothing meanwhile. What changes in test-lock.ts: **(P11)**. `npm run test:files` takes neither.

### The run's state transitions

A queue's run record (`run.yaml`) changes state only through the named transitions in `apps/server/src/run-state.ts`.
They are pure functions that each own which fields they set and clear. The engine writes their result, adding
`ended_at` and `updated_at`, and keeps the side effects (timers, processes, what the agent is told) where they are:

| Transition | To | Clears | Used for |
|---|---|---|---|
| `startedRun` | running | (a new record) | a start |
| `toResumed` | running | reason, `resume_at`, the hold; `nudged` false; a rejection, taking the approved revision | resume, a retry or usage wait come due, the restart after an update |
| `toUnheld` | running | reason, the hold | a cancelled update releases a pausing run |
| `toPausedByUser` | pausing / paused | `resume_at`, the hold (the user's pause wins) | Pause, Stop now, Stop at once, a rejected step |
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

Stop at once (PJ3) first marks the worker as ending and pauses its run, then calls the runtime's pure interrupt
and kills the process. Its exit is intentional, so it must not schedule a retry or process a late turn result. The
API waits for exit; Resume refuses while that exit is pending, preventing two processes on the same session. The
server records `step.interrupted` in the user's event log, closing the current work segment without giving the
step an outcome. The worker's files and session remain, and its next process resumes that session. Stop now keeps
its existing message and priority. Neither the CLI nor the orchestrator gains an immediate-stop action.

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

**When Claude Code saves a conversation** (queue RN, probed 2026-11-15 with Claude Code 2.1.323 and haiku: five runs,
one model call). Not at its start: a process started with `--session-id` and left without a message for 8 s wrote
nothing, and `--resume` of that id then failed with "No conversation found with session ID: <id>" (exit 1, an error
result). Not at the turn's end either: the transcript appears as the CLI reads the first message (its queue entry and
the user message, before the turn's `system init` and the model call). A transcript cut right after that message
resumes without an error, and `--session-id` of a saved id fails with "Error: Session ID <id> is already in use."
(exit 1). So a session whose process ended before it read a message (a deploy's hand-over right after its start, a
CLI still starting up) has nothing to resume, and the old rule, "resume whenever there is a runtime record", ended
the run with "No conversation found" after a deploy. Now `runtime.json` keeps `conversation_saved`: false from a fresh
Claude start, true once the process shows it read a message (its first turn's `system init`; Claude Code writes
nothing to stdout before); only a session whose record does not say false resumes, the others start afresh with the
same id, and the step or the cut-off message goes to the new process as before. A record without the field (written
before RN) counts as saved, so the deploy that brought this dropped no conversation. Where the record is still wrong
(one from before RN whose process never saved anything, or a process ended in the moment between its read and its
first output), the CLI refuses the start, and its words correct the record both ways (`savedFromRefusal` in
`src/claude.ts`): "No conversation found" marks it unsaved, "already in use" saved. `ClaudeSession` then starts the
process once more the other way, with what it had written to the refused one (the step's turn, a message, a stop),
and the role never sees the refusal: the run goes on, the message arrives. The refused `--resume`'s error result,
its first output, is held until the exit decides. Only once per ClaudeSession, only while the process wrote nothing
else and Nexus did not end it: a second refusal exits as any process does (the engine's usual failure handling), so
nothing retries without end. Why the stream's sign and not the transcript
file: the file's place (`~/.claude/projects/<folder from the path>/<id>.jsonl`) is Claude Code's internal layout,
the stream is its interface. The fake runtime keeps what it saved across its processes and refuses in both directions
as Claude Code does (`test/fake-claude.ts`; FAKE_START_MS holds its first read).

**Codex is affected the same way** (step RN2, probed 2026-11-15 with Codex 0.167.2 and gpt-6-luna: four runs, no
token figures reported; the one turn was ended as it started). `thread/start` saves nothing: three seconds after it,
and after the process ended, no rollout file of the thread existed, and `thread/resume` of it failed with "no rollout
found for thread id <id>" (JSON-RPC error -32600). The rollout is written when the thread's first turn starts (it
was there at `turn/start`'s answer), and a thread ended in its first turn resumes. Nexus records the thread id
(`native_id`) from `thread/start`'s answer, so a process ended between the two (a deploy, a turn/start not yet
taken) left an id that cannot be resumed, and the run failed again on every retry. Codex chooses its ids, so there is
no fresh start with the same id and no mark is needed: Codex's own answer decides. `CodexSession` resumes the
thread, and on exactly that error starts a new thread, records its id, and sends the session's message into it
(`resumeThread` in `src/codex.ts`); any other failure stays a failure. A session from before RN with a saved thread
resumes as before. The fake Codex saves a thread at its first turn and refuses `thread/resume` of one it never saved
(`test/fake-codex.ts`; FAKE_TURN_START_MS holds its turn/start).

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

**The orchestrator's context care** (decided by the user on 2026-11-15, queue CC; docs/ideas/chat-context.md). The
orchestrator's long chat is not compacted: when its context nears full, Nexus asks it for a summary and goes on in a
fresh orchestrator session started from it (protocol: "The orchestrator's context care"). Compacting keeps the session
but leaves the choice of what to keep to the model, and compacting again summarizes a summary; a fresh session starts
from a summary written on purpose and kept as a file the user can read, from the **current briefing** (a session
started before a deploy keeps the old one), and from the files, where an orchestrator's truth is anyway (`nexus
status` in its first message), so wrong beliefs it built up do not carry over. What is lost is the chat's tone and
detail. (The Ideas conversations, whose material is the conversation itself, get a "Compact" action instead.)
Decisions, building it:

- Its own threshold, `orchestrator.context_threshold` (global with a project override, default 0.85: "nears full"),
  apart from the workers' `context_reuse_threshold`, which is about reusing a session for related work.
- Only between turns, with its process idle: a turn is never cut into, and a turn ending is the orchestrator's
  equivalent of a step's end. The request is a turn of its own and asked once (`context:asked` in `applied.jsonl`, a
  file, so a restart in between still switches); after that turn the switch comes with or without a summary.
- While the summary is written, nothing else goes to the old session: the user's message would land in a session that
  is about to end, so it waits in its inbox and is carried into the fresh session's first turn, as a worker's unread
  messages are. Notices are not carried: the fresh session is told them anew, as what no session of its line was told
  (the `notify:…` keys of every session it continues), since the first of them.
- The status in the first message is the same text `nexus status` prints in an orchestrator's session: the overview
  moved from the CLI into the protocol (`overview.ts`), so both read one function.
- Answers to a question of an old orchestrator session go to the newest session of its line (`routeAnswers` follows
  `continued_by` for orchestrators), and the orchestrator now gets the answers in its inbox delivered as a turn:
  before this nothing delivered them, as it asked no questions in practice.
- A fresh session that is above the threshold already at the end of its first turn (a threshold below what a briefing
  and a status fill) is not switched again: another would be no emptier, and the switches would loop.
- A setting with a default that a write leaves out (an `orchestrator` section written before the setting existed, or
  made from a literal) is not cleared: only a setting without a default has a project's own "none".

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
not the orchestrator by editing files. Nexus never switches, resets or deletes a worktree another session is using.
A new worktree gets the project's setup command once (`defaults.worktree_setup`, `npm ci` in Nexus) before its first
step. The code is `apps/server/src/worktree.ts` (`worktreeFor`, `gitBranch`, the setup), beside `gitinfo.ts`, which
records what the queue's checkout committed.

### Merging back

Decided by the user on 2026-11-14 (docs/ideas/parallel-worktrees-and-merge-back.md): independent queues run side by
side in worktrees of their own, and Nexus may merge them back by itself. Two settings, global with a project
override and off for a new project, since everything then rests on the project's checks: `merge_back` (Nexus merges
back by itself) and `resolve_conflicts` (the integration step's worker resolves a conflict).

- **The base only moves forward.** A merge without textual conflicts can still break (each queue passes its checks,
  together they fail), so the merge happens on the queue's branch, not on the base: the queue's last step, the
  integration step, merges the current base into the branch in the worktree and runs the checks there; the base then
  moves to that commit by a fast-forward. Nothing new can arise on the base itself, and the base never gets a merge
  commit of Nexus's (its history does contain the integration step's merge, which was checked).
- **The fast-forward** (`apps/server/src/merger.ts`, judged in `mergeback.ts`) waits for every step to be accepted
  (at its review level; provisional acceptances count as `provisional_counts` says), the integration step's checks to
  pass, and the base to still be an ancestor of the integrated commit. When the base moved on meanwhile (another queue
  merged, the user committed), the integration step runs again, at most twice by itself; then it waits for the user,
  whose Merge back runs it once more. The user's Merge back also starts the count of runs again anew (to zero), so
  after it Nexus may again run the step twice by itself.
- **It never moves files under someone.** It uses the protections of the user's merge (the base checked out somewhere,
  not detached, not in the live worktree, no uncommitted changes to tracked files; untracked files never count) and
  waits, telling the user and the orchestrator, when one fails. Nothing moves during an update, a deploy or a
  hand-over. Git can change what holds it without any file of the project changing (a commit in the checkout), so
  while something waits it is looked at again every 30 seconds.
- **First hold, then decide** (queue FX, 2026-11-15). The judgement goes in this order: (1) what keeps it whatever the
  base's checkout is like (the integration step's checks, the limit of runs again, the base checked out nowhere or
  only in the live worktree): it waits, and nothing is held; (2) a step at work in the base's checkout (running,
  waiting for an answer, or a pause waiting for the step's end) is held at its end, the way a planned deploy's drain
  holds a run; (3) only then the checkout's cleanliness (tracked files only); (4) when the base moved on, the
  integration step runs again, and the run stays held meanwhile, so the base does not move on again under it; (5) the
  fast-forward; (6) the held run goes on. A hold lasts at most one integration step (its checks and its review
  included, a few minutes). Whenever the merge back cannot go once a run is held (a dirty checkout, failed checks, the
  limit, a run again that halts, waits or cannot start), the held run goes on at once, and the wait names it
  (`merge.waiting.released`), so the user and the orchestrator are told; nothing stays held. A server restart lets
  it go too: a held run is marked to go on after a restart.
- **One way for both.** The dashboard's Merge back uses the same judgement and the same fast-forward, under one lock
  per queue, so the button and the server never race; `git.yaml` `merged.by` says who did it.
- **Cleanup** comes after the merge, once every provisional acceptance of the queue is confirmed: a Fix it until then
  runs in the worktree and goes through the integration step again. The worktree is removed with git where it can, and
  by Node where Git for Windows cannot (paths beyond 260 characters); the branch with `git branch -d`, never `-D`.
- **No push.** The merged base goes to the remote with the next deploy; a deploy planned after such a queue goes
  after its fast-forward.
- **The plan waits for the merge back** (queue MQ, 2026-11-16). With `merge_back` on, a queue planned after one in a
  worktree of its own starts only once that one's work is merged back (`doneForPlan`, `notMergedBack` in
  packages/protocol/src/plan.ts), so it starts from a base that has the work, and a chain of worktree queues does not
  build on a base without its predecessors. The planned deploy already waited the same way; both use one test. With
  `merge_back` off the user's Merge back may come much later, or never, so finishing stays enough there.
- **The merge train** (queue MQ, 2026-11-16). Two worktree queues finishing together both used to integrate against
  the same base; the first fast-forward then moved the base under the second, whose integration step ran again (and,
  with a third, again, up to the limit). Now, with `merge_back` on, one queue per base integrates at a time: it holds
  the base from its integration step's start to its fast-forward, and the others are held at the end of the step
  before their integration step, in the order they got there. Each integration step thus merges a base that already
  has the queues before it, runs once, and is followed by a fast-forward. A fast-forward that waits on the user (a
  dirty checkout, failed checks) must not stop the train: it lets the next queue go, and once it could go again it
  queues up behind those already waiting (by when its wait began). Choices: the rule is derived from the files
  (`packages/protocol/src/train.ts`), not kept in the server's memory, so a restart finds the same order and the
  dashboard and `nexus status` show the same place; the hold reuses the engine's step boundary and `releaseHold` (the
  planned deploy's and the merge back's own hold), so no new run state; a queue's own steps never wait, only its
  integration step; with `merge_back` off there is no train, since the user's Merge back decides the order anyway.
- A queue from before the integration step keeps the user's old merge (which may make a merge commit).
- Found while building: a scripted run on a development instance first stood still because a project without an
  orchestrator section has its level-2 reviews done by the user; and a commit in the base's checkout changes nothing
  under `.nexus`, so without the 30-second look a merge that waited for a clean checkout would wait until some other
  change came.
- Found on 2026-11-15 (queue FX): the order used to be cleanliness first, then the runs at work. A worktree queue's
  fast-forward then waited on the uncommitted work of a step running in the main checkout instead of holding that
  run; each of that queue's next steps moved main on, so the integration step ran six times (the user's Merge back
  reset the count twice). Holding first, and keeping the hold through the run again, makes it one run again at most.
- Found while building it: a run can finish (its integration step's review accepted) a moment before the turn in
  which the step got its outcome ends and closes its round in `git.yaml`. Judged in that moment, the last closed round
  was the older one, so the merge back waited ("the branch moved on after its integration step") and told the user
  for nothing; with a hold, it let the held run go. A round that is still open within a minute of the step's end
  now counts as still ending, and is judged once it closes.

### The integration step without a model (queue MI)

Decided by the user on 2026-11-17 (docs/ideas/token-costs.md): the integration step runs without a model when the
merge is clean and the checks pass, as a CI pipeline does; a worker is started only for a conflict or a failing check.
When the merge changes the lockfile, the worktree setup runs again before the checks. At the step boundaries the
engine may merge the base into the queue's worktree when it merges cleanly, so conflicts show up small and early.
Designed in MI1, built in MI2; the file formats are in PROTOCOL.md, "The integration step", "Without a model". Points
marked **(M1)**…**(M13)** go beyond the decision: MI1's proposals, which the user accepted on 2026-11-18 as written.

**Why.** Most integration steps find a clean merge (or nothing to merge) and passing checks: the worker's whole turn
(reading its briefing and the opening, `git merge`, `nexus step done`, the context summary) only repeats what git and
the checks say. Since queue EC the engine runs the checks itself, so the one thing left for a model is what a model is
needed for: a conflict to resolve, a failure to fix.

**Who writes the queue's report (M1).** Today the last step's opening asks for the report, and the integration step is
the last. Without a worker nobody would write it. The report moves to **the last step that runs with a model before
the integration step**: the closing refactoring step when the queue has one, else the queue's last own step. Its
opening's "last" becomes "no step is pending but this one and the integration step". That step is the right author:
the closing step runs in a fresh session whose seed already holds the queue's description and every step's summary,
it read the queue's whole diff, and the report's judgement (each step against its acceptance, a proposed next step) is
a model's work. The integration's own outcome is not in the report: it is the integration step's summary (the
engine's, or its worker's), which the dashboard shows beside the report and the run-finished notice adds to the
report's summary ("Integration: …"). The engine never writes `report.md`: `nexus report` stays its one writer. The
integration step's opening asks for a report only when the queue has none yet (its closing step skipped by the user, a
report never written); a model-free integration of such a queue finishes without one, and the run-finished notice says
so. Alternatives weighed: the engine compiling the report from the steps' summaries (no model, but no judgement and no
proposed next step, a summary that is no substantive outcome for the ideas' excerpts (IC2), and a second writer of
`report.md`); the closing step writing it and the engine appending an integration section (the same second writer).

**The engine's own session (M2).** A model-free step still needs its events (`step.started`, `step.progress`,
`step.done`, a `queue.stop`, an acceptance) so that the derivation, the checks (their sets are keyed by the
`step.done`), the merge back, the train, `nexus status` and the dashboard read it as any step. A session appends only
to its own log, so the worker's log cannot take them. The server keeps one more session of its own, as it keeps the
user's: id `nexus`, role `nexus`, no runtime, its events written only by the server. The step's rounds in `git.yaml`
name it as their session.

**When the step goes without a model (M3).** Only when everything is plain; anything else goes the way it goes today
(a worker opens the step), so the model-free path never has to judge: Nexus runs the step's checks (the server's
capacity coordinator, `by: nexus`); the worktree has no uncommitted changes to tracked files; a base branch can be
named. The engine then merges (`git merge --no-edit <base>`), and on a clean merge (or nothing to merge) runs the setup
when needed and records `step.done` with a summary built from facts (the base and its commit, how many commits and
files the merge brought in, the resulting HEAD as its commit); the checks run as after any `step.done`.

**A conflict (M4).** The engine aborts its merge (`git merge --abort`), so the branch is as it was. With
`resolve_conflicts` off, it stops the step itself with the integration's condition and the conflicting files as the
reason: no worker, since today's worker would only do the same. With it on, a worker opens the step as today, its
opening naming the files Nexus found in conflict. No base branch to name: the engine stops the same way.

**A failing check (M5).** A set that fails twice after the engine's `step.done` is a check-fix round as for any step,
but the step has no worker yet: the engine opens the integration step in the run's session (started again when its
process has ended, as a resume does), with the integration's opening in its "continue" form, saying that Nexus did the
merge (the HEAD) and what failed (the round's text). The round counts toward `check_fix_limit` as usual (the engine's
own set is fix 0), and the worker may dispute a failure as in any round.

**Accepted by Nexus (M6).** A model-free integration whose checks all passed has nothing a review could judge beyond
them: git made the merge, the checks judged it. At review level 2 or 3 the engine accepts it itself (`review.accepted`
from the `nexus` session, its text saying so); the orchestrator is told with its next notice, as the routine reviews'
helper's verdicts will be. A level the user set to 1 still goes to the user. This narrows "every step is reviewed"
(PROTOCOL.md, "Review") for this one case, which is why it is a proposal. A queue without any check gets the merge
without a model too, but not the acceptance: its summary and the review notice say the merge is untested, and the step
goes to its review at its level. An integration a worker took part in (a conflict resolved, a failure fixed) is
reviewed as today.

**The setup after a lockfile change (M7, M8).** The decision names the integration's merge; the rule is made general,
since it is the same question everywhere: is the worktree's setup current for its HEAD? `git.yaml` records the commit
on which the setup last succeeded (`setup.sha`; the worktree's first setup: the base commit). Before a check set (any
step's, the integration's included) and after a step-boundary merge, when a file of the setup's inputs differs between
that commit and HEAD, the setup runs again first. The inputs are a project setting (`defaults.worktree_setup_inputs`,
project only), by default the lockfiles of the common package managers anywhere in the tree (`package-lock.json`,
`npm-shrinkwrap.json`, `yarn.lock`, `pnpm-lock.yaml`, `bun.lockb`, `bun.lock`), so a project with another kind of
setup can name its own (a `requirements.txt`). Before a check set the setup runs inside the set's grant of the machine,
recorded on the set, and counts as the set's first check: a failure runs once more (`npm ci` fails on the network now
and then), and failing twice it fails the set like a check, the checks after it not run (they would fail for it), so
the worker of a check-fix round sees it (a lockfile the merge broke is the queue's to fix). A worker that changed the
lockfile itself (and ran its install) gets one run too many, about half a minute, a price for one rule instead of two.

**Merging the base at the step boundaries (M9, M10).** When the engine opens a step of a queue with an integration
step (one of the queue's own steps, or the closing step; never the integration step itself, which merges anyway, and
never a step that goes on: a continue, a send-back, a check-fix round), it first tries to merge the base into the
queue's branch. It does so whatever `merge_back` says: with `merge_back` off the base still only moves by a
fast-forward to the integration's result. The pull only reads the base branch, so it neither waits for the merge train
nor holds the base. It needs a clean worktree (tracked files) and a base branch to name, and something to bring (the
base not already in HEAD). The engine first tests the merge without touching the worktree (`git merge-tree
--write-tree`; where git is too old for it, a real merge aborted on a conflict); a clean one is made (`git merge
--no-edit <base>`), then the setup when its inputs changed. A conflicting one is not made: it is recorded, shown on the
queue and in `nexus status`, and the next step's opening says which files of the base conflict with the branch, so the
worker knows what is coming; resolving it remains the integration step's. The orchestrator is not told separately: it
sees it with the step's review. No checks run at a pull: the next step's checks run on the result. Its opening says
what the pull brought in (the base's commit, how many commits, the files).

Three things change with it: the pull's merge commit falls between two steps' rounds, so it is no step's work; the
closing step's commit range starts at the last base commit merged in (else the first round's start, as today), so its
diff shows the queue's own work, not what the base brought; and a disputed check runs on the last base commit merged
into the branch (else `base.sha`), so the comparison is with what the branch contains.

**Run control (M11).** The merge and the setup are the engine's own work in the queue's run: `Engine.idle()` is false
while they run, so an update's drain waits for them; the setup is a child process ended and run again like a check
(interrupted by a Stop now, a drain's end or a restart). A server that stopped in the middle of a model-free step finds
the step `running` from the `nexus` session: it aborts a merge left half done (`MERGE_HEAD` present) and runs the step
again from its start, which finds the merge commit already there when it was made. A Pause during the step takes effect
at its review, as during the checks.

**The merge train and the merge back do not change (M12).** The train's hold is taken where it is taken today (the end
of the step before the integration step), and the integration step holds the base while it runs or waits, whoever
runs it; it only holds it for less time. The merge back's conditions read the integration step's last round and its
check set, which a model-free step records the same way. A run again because the base moved on costs no model now,
but the limit of two by itself stays: it guards against a loop, and the checks cost the machine.

**Measuring it (M13).** The decision wants the effect measured, as its own deploy. A model-free step is marked on the
derived step (`model_free: true`), so the statistics count model-free and worker integrations apart, and the steps
without a turn do not pull the per-step averages of tokens and time down unseen.

The orchestrator's briefing asks that the checks of a queue with a worktree of its own cover the typecheck, the tests
and, where the work touches it, the build: a model-free integration is exactly as safe as its list of checks (MI2).

**Built, and where it differs from the design (MI2).**

- The `nexus` session's `runtime` is `external`, as the user's session's is, not a new value `none`: no reader needs to
  tell the two apart, and a new runtime value would reach every switch over runtimes.
- The orchestrator is not told of Nexus's acceptance in its next notice, as M6 said: no notice lists "the steps
  accepted since" yet (that comes with the routine reviews' helper). It learns of it from the run-finished notice
  ("Integration (run and accepted by Nexus, without a model): …"), and gets no review notice for such a step: the step
  is in `review` for the moment between its passed checks and Nexus's acceptance, and the notice skips it
  (`acceptedByNexus`, one predicate for the engine and the notice).
- A conflicting pull is shown in `nexus status` and the orchestrator's overview (round 2 of MI2), not yet on the
  dashboard (M9 said both): that is left for a later queue.
- The merge is made within one look of the engine (git merge-tree, then git merge, then the events), so a drain or a
  Pause cannot fall between the step's start and its done; only a server that stops in that moment leaves it open,
  which the next look repairs (M11). Found while testing it: a Resume after the restart continued the open step the
  usual way, by opening it for the worker; it now goes to the engine's look, which runs the step again without a model.
- The update's drain did not wait for a worktree setup run outside the checks (a new worktree's, or one after a merge
  at a step boundary): `Engine.idle()` looked only at the agents and the checks. It waits for it now, and a drain that
  cannot wait ends it without counting a failure.
- Found while testing: test temporary folders that nest (each test pointing TEMP inside the last one's) made worktree
  paths long enough that git commands failed on Windows; the new tests take their folders from the system's temporary
  folder as it was at the start.

### Usage limits

The engine watches the subscription limits: Claude Code's 5-hour and 7-day usage, Codex's rate-limit updates
(`account/rateLimits/updated`). Above a project-set threshold (default 90 % of the 5-hour window) it does not open
new step turns; running turns finish. Queues paused this way resume when the window resets, and the dashboard says
why they wait. Where Claude Code reports these figures in print mode is to be confirmed when the adapter is built.

Since queue FB (2026-11-14) a step whose runtime is beyond the threshold goes on on a fallback instead of waiting,
by rules: each kind's fallback chain in the settings, a queue's or a step's in its YAML (PROTOCOL.md, "Fallback when
usage runs out"). Choices made while building it (FB4):

- **One pure decision.** `chooseRoute` (routing.ts) takes the step's own values and chain, the usage windows, the
  threshold and the time, and says primary, fallback or wait; the engine only carries it out. The tests drive it with
  windows written into usage.json, no clock tricks needed: a reset time in the past is a reset.
- **A passed reset is a reset.** Claude Code reports its windows only inside a turn: a runtime nobody used since its
  window reset would otherwise look full for ever. So `resets_at` in the past counts as free, and a window never
  reported counts as free too (Codex before its first session).
- **Every Claude Code window counts, the later reset wins.** The 7-day window full with the 5-hour one free is still
  full for a week; waiting for the 5-hour reset would wake the run only to wait again.
- **The record lives in run.yaml, not in an event.** A session's events log is its own (one writer per file); the
  engine's decisions are the server's, so they go into run.yaml `fallbacks` beside `switches`, and the step view and
  the turn records read them from there.
- **In the middle of a step, only between turns (FB5).** One gate, `usageGate`, stands before every turn the engine
  starts within a step (the nudge, the inbox delivery to an idle session: an answer, a send-back, a message) and
  after a turn that failed on the limit; not before the continue of a resume or a retry, which the decision does not
  name and which goes on as before (the run-state golden files stay as they were); it looks only when the session is idle, so a running turn is never cut off. The new
  session is told what the old one cannot hand over itself: its progress lines, its commits since the round began and
  `git status` of the checkout. The changes are not touched: the seed asks the new session to keep them. Asking the
  full runtime for a context summary first (as at a boundary) would spend the usage that ran out, so none is asked.
- **An entry during the asking turn is no turn of its own (TF1).** An answer or a message that comes while the turn
  that asked the question still runs (as Nexus sees it: until the turn's result is read) goes into that turn on the
  same runtime (`next`), so the gate does not look. The full runtime may then take one more turn: the agent acts on it
  in its turn, or, when the CLI had already ended the turn and its result was still on the way, starts a turn for it.
  Accepted: it is one turn, and holding entries back from a running turn would cost every other step its in-turn
  messages. `fallback-mid.test.ts` once raced exactly this under load (a step left waiting, or done on Claude Code);
  its answers and messages now wait for the asking turn's end, and the fake lingers after the question
  (FAKE_ASK_LINGER_MS) so that a test which does not wait fails every time.
- **A failed turn's reset counts as a window.** A turn refused for the usage limit names its reset; that is added as a
  full window of the runtime for the decision, since usage.json may not show it yet.
- **Notices wait in the orchestrator's inbox.** A notice that started the orchestrator's turn while its runtime (Claude
  Code or Codex, `orchestrator.runtime`) is full would spend the very usage that ran out. The notice is put into its inbox (seen there, not
  told) and told once the runtime is free; the reviews it would do wait with it, as decided.

**The orchestrator's own fallback (OC4).** The primary and one optional backup are user settings. Its active fallback
is server state in the session file, with the primary's reset deadline; lower readings cannot bounce it back early,
and a server restart cannot forget the choice. Every automatic selection waits for a turn boundary. The existing
runtime-switch lineage carries unread messages and the latest `nexus context` summary; no extra summary turn is
requested from a runtime whose quota is already full. A missing summary is stated in the chat. Context care keeps
the fallback state when it creates another session. The user's clarification on 2026-11-16: an alternative model
of the same runtime shares the quota and must wait, so it is configurable but cannot provide extra capacity. Tests
use both fake runtimes, a movable usage clock and a held chat turn, including restart while on the fallback.

### Estimating a turn's use

A step's use of the usage windows is an estimate, labelled as one (decided 2026-11-14, docs/ideas/statistics.md): the
windows are the account's, measured only as a utilization now and then, and several turns run at once. Built in ST2
(`usageEstimates`, packages/protocol/src/usage-estimate.ts, a pure function of the turn records):

- **A window's growth over a turn, shared by tokens.** For each window a turn's record names, the growth is the
  utilization at its end less that at its start (as the server knew them, `windows_start` / `windows_end`). The turn's
  part is growth × its weighted tokens / the weighted tokens of every turn of the same runtime within the stretch, its
  own included. A step's (and a queue's, a tag's) use is the sum of its turns' parts, done by the statistics.
- **Only the same runtime shares a window.** Claude Code's windows and Codex's are apart; every role and project
  counts (one subscription): an orchestrator's turn beside a worker's takes its part.
- **A partly overlapping turn counts with the part of its tokens within.** Its tokens are taken as spent evenly over
  its duration, so a turn that began just before the end of this one takes little of its growth. The approved wording
  ("the turn's tokens over the overlapping turns' tokens") is the case of full overlap; prorating keeps a long turn
  from taking a share of every short turn it touches.
- **No estimate rather than a wrong one.** A reset between the two readings (the growth is negative, the starting
  reading's reset time passed before the turn ended, or the reset times differ by more than five minutes: Codex's is
  computed from a countdown and drifts) gives `reset`; a reading missing at either end gives `missing`; a turn whose
  tokens are unknown (interrupted, no result) gives `tokens`, and counts with no tokens in its neighbours' shares.
- **The token weights are the runtime's** (`TOKEN_WEIGHTS`, by runtime; queue TW, 2026-11-18). What the windows meter
  is not published; the API's prices are the best public proxy for the compute a token costs, and only ratios matter,
  since a share compares turns of one runtime: input not from the cache 1, output 5 (thinking is billed as output), a
  cache write 1.25, a cache read 0.1 (`PRICE_WEIGHTS`). Claude Code's cache read weighs 0.02 instead, as measured in its
  5-hour window (TB2, below: 0.022, 95% 0.014–0.028, a fifth of the price ratio); its other weights stay the price
  ratios (output to cache write came out near the ratio's 4). Codex keeps the price ratios (its cached input is priced
  near a tenth too; its window could not tell the cache read's weight yet), and so does any other runtime
  (`tokenWeights`). A turn's tokens and its sub-agents' are weighed with its runtime's weights. Since a share only
  compares turns of one runtime, the change moves Claude Code turns' shares toward the turns with more uncached input,
  output and cache writes, and leaves Codex's as they were.
- **Known limits.** The starting reading is the last the server had, possibly from a turn that ended before this one
  began, so growth from before the turn can land in it; a window that moves only in whole percents makes a short
  turn's growth 0 or a percent. Summed over a step's turns these even out; one turn's estimate is coarse.

### Sub-agent tokens

A Claude Code turn may run sub-agents (the Agent tool); they use the same subscription. Probed on 2026-11-15 (Claude
Code 2.1.323, haiku, a temporary directory, one turn that ran one sub-agent, then a turn without; about $0.008 at list
prices, `costBasis: list`):

- `result.usage` is the main loop's turn alone: the sub-agent's 24 492 cache-creation tokens were not in it.
- `result.modelUsage` (per model: `inputTokens`, `outputTokens`, `cacheReadInputTokens`, `cacheCreationInputTokens`)
  is the process's running total, sub-agents included, like `total_cost_usd`: the second turn's figures were the first
  turn's plus its own.
- So a turn's sub-agent tokens are the growth of modelUsage (summed over its models) since the previous result, less
  `result.usage`: in the probe exactly the sub-agent's message (2 input, 24 492 cache creation; output differs by a
  few tokens from its streamed message, whose usage is a snapshot). The turns after it came out at zero.
- The sub-agent ran in the background (`isAsync`), and Claude Code started a turn by itself when it ended; its tokens
  land in the turn whose result follows them. Its streamed messages carry `parent_tool_use_id`; their usage is the
  sub-agent's own context, which the adapter no longer takes as the session's context fill.

The adapter keeps the previous total like the cost's (unknown in a resumed process, so that process's first turn has
no `subagent_tokens`), clamps each figure at zero, and the record keeps the field apart from `tokens`; zeros mean no
sub-agent ran.

### Measuring token use

The token savings of docs/ideas/token-costs.md go out in separate deploys, each measured against the time before it
(decided 2026-11-17). The user's two analyses of the transcripts were made outside Nexus; `scripts/token-report.ts`
(queue TB) repeats them from the files, over a period (`--since`, `--until`), so the figures before and after a deploy
are counted the same way. It only reads, and its report holds totals only (README.md, "Where the tokens went"). The
readers (`scripts/token-report/transcripts.ts`) and the breakdowns (`analysis.ts`) are pure functions, tested on
made-up transcripts (`scripts/test/token-report.test.ts`).

- **The unit is a model call**, one API response: Claude Code writes one line per content block with the same message
  id (one call; the largest usage of its lines), Codex one `token_usage_record` per response (older transcripts: a
  `token_count` event whose total changed). A call's tools are its tool_use blocks (Claude Code) or the tools its exec
  cells run (`tools.exec_command({cmd})` and the like, read from the cell's JavaScript; Codex); the results come back by
  tool id. A Codex cell's output is shared evenly among its tools. A forked transcript repeats its parent's calls: a
  response id counts once.
- **Whose call it is**: a transcript's id is a Nexus session's `native_id` (session.yaml), which gives the role; a
  sub-agent's transcript is its parent's (Claude Code's `<session>/subagents/`, Codex's `parent_thread_id`: the
  guardian that reviews approvals, for instance). A transcript of a project folder no session names (one started by
  hand) counts as role `other`. A session's earlier native ids are not kept, so a session whose native id changed
  shows up as `other` too.
- **Cost** is weighted tokens with the call's or turn's runtime's `TOKEN_WEIGHTS`, the same as the estimates above
  (Claude Code: input 1, output 5, cache write 1.25, cache read 0.02; Codex and any other runtime: cache read 0.1), and
  the report's head says which: not a bill. Claude Code's and Codex's figures are summed into one total and share,
  though their windows are apart; a share across runtimes says where the weighted tokens went, not which window they
  filled. A call's context is input + cache read + cache written; "context above 300k / 500k" is the share of a
  role's context tokens spent in calls above that size (the thresholds decided for workers and the orchestrator).
- **Cache written after an idle hour** (the cache lives an hour): the cache writes of the first call after a gap of more
  than an hour since the transcript's previous call (also when that call lies before the period). From turns.jsonl the
  same for a turn that began over an hour after its session's previous turn ended.
- **Routine work** is told by a shell command's simple commands (split at `;`, `&&`, `||`, `|`), matched at their
  start, so a grep for "npm test" is none: tests (`npm test`, `npm run test:files`, `node … --test`), checks (typecheck,
  lint, knip, tsc, eslint), build. A call counts once, in the first that applies, with its whole weighted tokens; the
  call that reads the output afterwards is not counted. "Waiting for the lock" is a call whose tool result says
  `npm test: waiting for …` (scripts/test-lock.ts): a poll that saw nothing new is not caught.
- **Images read back** are image blocks in tool results; **files read** are Read's file and the files of `cat`,
  `head`, `tail`, `sed`, `Get-Content` and the like, paths made relative to the project's root or worktree; a read's
  tokens are its result's characters / 4, an estimate.
- **Read-only calls**: every tool call reads (Read, Grep, Glob, or a shell command each part of which is a reading
  command: cat, sed without -i, grep, ls, git log/diff/show/status, `nexus status`/`help`/`doc`…). The share is of all
  the role's calls; a run is consecutive read-only calls in one transcript.
- **Quality**, from the projects' events in the period: Fix it (`review.sent_back` by the user, a picture comment sent
  back), Reject (`review.rejected`), provisional acceptances and those returned (`review.provisional`,
  `review.fix_asked`), send-backs by the orchestrator, and fix rounds after a failed check (a failing `check.result`
  followed by another result of the same check in the step). Done steps count once however many rounds they had.
- **Gaps** are listed, not guessed at: sessions with turns but no transcript on this machine, transcripts no session
  names, turns without tokens, and transcripts reaching back further than turns.jsonl.

The baseline (`--until 2026-11-18`: Nexus's transcripts from 2026-11-12, turns.jsonl from 2026-11-14) was measured on
this machine only; it counts Codex too, which the user's first analysis left out, so their figures differ in scope.
Measured again with the runtimes' weights (queue TW, step TW1; price ratios → Claude Code's cache read at 0.02), the
same data: per call, the worker's share of the weighted tokens 76.0% → 76.6%, the orchestrator's 17.3% → 16.7%; the
cache reads' part of the worker's and the orchestrator's weighted tokens fell from about 77% to about 48% (76.5% → 49.0%,
76.8% → 47.6%); per turn, Codex's part rose from 17.2% to 35.8% (its tokens weighed as before, Claude Code's lighter);
the cache written after an idle hour 3.6% → 7.9% of all, the routine checks (typecheck, lint, knip) 8.4% → 7.1% and the
tests 5.3% → 4.8%. Later reports count with the new weights, so a before-and-after compares like with like only when
both are made with one version of the weights.

**The tokens' weights in the usage windows** (`--weights`, `scripts/token-report/weights.ts`; queue TB, step TB2): what
the windows meter is not published, so it is estimated from turns.jsonl, every project's turns (the windows are the
account's). The readings are the windows as the server last knew them at a turn's start and end, in whole percents.

- **Samples.** `solo`: a turn no other turn of the same runtime overlapped, its growth between its own two readings.
  `stretch`: consecutive readings at least an hour apart (`--stretch-minutes`), every turn's tokens prorated over its
  duration, sub-agents' included. A reset between readings (a fall, another reset time, the reset time passed) ends a
  stretch; a stretch a turn without tokens touches is left out, its tokens being unknown.
- **Fits**, least squares through the origin (no use, no growth), in percentage points per million tokens: the four
  kinds freely; growth ≈ a·(input + 5·output + 1.25·cache write) + b·cache read, whose b/a is the cache read's weight
  in TOKEN_WEIGHTS units (one number, so a cache read is measured against the rest at its price ratios); the same with a
  constant use per hour beside (the account's use outside these turns: the user's own chats, sessions started by hand);
  and one scale on the TOKEN_WEIGHTS-weighted sum. The uncertainty is the standard error (delta method) and a seeded
  bootstrap over the samples (1000 rounds, 95%). With the spread seen, it says how many samples a 95% interval of
  ±0.025 would take (enough to tell the price ratio from half of it) and how many days that is at the same pace; under
  20 points of growth in all it says the whole-percent steps are the signal.
- **Known limits.** A reading may be older than its turn (the last report of any session), so a stretch of an hour or
  more is the main sample; the account's use outside the turns adds growth the tokens do not explain; a Claude Code
  turn's cache writes are written for an hour (twice an input token at list price, not 1.25); and Claude Code's
  uncached input is a few tokens a call, so its own weight cannot be told apart.
- **Found (2026-11-18, data to 2026-11-17).** Claude Code's 5-hour window: a cache read weighs about 0.02 of an input
  token (0.022, 95% 0.014–0.028, 42 stretches, 556 points of growth; 0.012–0.023 for stretches of 30 minutes to 4
  hours; the weekly window and the solo turns agree within their wider intervals), a fifth of the price ratio; output
  to cache write came out at about 4.4, ± about 1 (TOKEN_WEIGHTS: 4). Nearly every Claude turn ran on Opus. Codex's weekly window
  could not tell (30 stretches, an interval of −0.01 to 0.22, unstable with the stretch length); about 650 stretches, or
  some 45 days at this pace, would. The user decided (queue TW) to take the 0.02 for Claude Code's cache read and keep
  Codex at the price ratio; with it, the one-number fit on Claude Code's 5-hour stretches explains a little more
  (R² 0.98 → 0.99), as it should. The fits for the cache read's weight measure it against input, output and cache write
  at their weights (the same for both runtimes), so they do not depend on the cache read's own weight.

### The plan

"When queues A and C are done, start B" is a place in the plan kept in a file of B's (`plan.yaml`, with the start's
options in `start.yaml`), not a timer or a process: the engine looks at the plans after every change and when it
starts, so a plan survives restarts and updates, and nothing fires while an update drains. The user decided
(2026-11-14) that the plan is binding: Nexus starts by itself only a queue in the plan, and the plan generalizes the
chains of one predecessor to several. Decisions:

- It fires only when every predecessor is done. A halt, pause or stop of one is something to look at, not a reason to
  start B on work that may depend on it; the plan waits and says what it waits for. A stopped, cancelled or missing
  predecessor is told to the user and the orchestrator, since only they can change it.
- B's approval is checked when the plan comes due, not when it is made, and an unapproved B waits for it rather than
  failing (it used to fail): the plan shows what will happen, and "needs approval" is part of it. "Approved" means
  the revision current at that moment is approved. When B cannot start for another reason (stopped), the plan stays
  as an item for the user instead of vanishing or retrying by itself.
- The plan stays after B starts (marked used), so the view can show what came after what; a used plan waits for
  nothing and takes no part in the loop check.
- Each dependency records who set it. The user's are the user's: the orchestrator's requests that would drop one are
  refused with the way to propose it instead, so the rule holds in the files, not only in the briefing. A proposal is
  one whole list, as the orchestrator would set it; the user's answer is one action, and a hand-back makes the
  dependency the orchestrator's, as if it had set it.
- While the user is away, the orchestrator starts nothing outside the plan; the server refuses it, as it refuses the
  orchestrator's changes to the user's dependencies.
- A plan to continue a session waits while that session runs another queue, rather than failing: one session never
  runs two queues, and planning a queue into the session of the queue before it is the common case.
- The user's single-dependency changes (queue PB, 2026-11-16): "also after" adds one predecessor, a line's details
  take one away, and a move, an add or a remove can be undone for a few seconds. Taking a predecessor away, whoever
  set it, is the user's decision, recorded and told to the orchestrator; it may propose putting it back but not do it
  (refused in the files, as with the user's own dependencies). What an undo needs is kept in the plan files the
  change wrote (`undo`: the file before), not in the server's memory, so a restart within the window neither loses
  the undo nor lets a queue the change freed start early. A later write shows by `updated_at` (every write sets it),
  so an undo never overwrites a change made since; a start is checked apart (marking `started_at` keeps the rest).
  The server takes an undo 2 s longer than the dashboard offers it, for the request's way.

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

The code is `packages/protocol/src/plan.ts` (the rules and the views: who may change what, the loop check, proposals
and the user's answers) and `apps/server/src/scheduler.ts`: `Scheduler` keeps the plans (plan, schedule, cancel; `duePlans` and
`startDue`, which the coordinator's pass calls to start what came due) and asks the engine to start a queue; `ClockTimers` arms the long timers on the engine's
clock, for the schedules and for the engine's own retry and usage waits. The engine owns the runs and keeps the public
`plan`, `scheduleStart` and `cancelStart`, which hand over to the scheduler.

The Queues view shows the plan above the queue lists (`apps/web/src/plan.ts`, `components/Plan.tsx`). Decisions:

- Columns, not a timeline: what is in progress now (at work, waiting for a review or an answer, paused, stopped) is
  the first column, and every planned queue stands one column right of the latest queue it waits for that is still
  shown. Done predecessors are not drawn (the card still names them, "done"), so the picture is what is left to happen.
  Times would come only from estimates (PV4); the order is certain, the times are not.
- A queue that a planned queue waits for is shown even when it is not in the plan itself ("not in the plan"): it is
  what holds the plan. Approved queues outside the plan are one line under it, since they wait for someone to plan them.
- A line goes from a queue to the one that waits for it, solid in the accent colour where the user set the
  dependency, dashed where the orchestrator did; the card says "after A · set by you" too, so the phone's list (no
  lines) keeps who set what.
- On each planned queue what it waits for, what only the user can do first: a failed start, its approval, a
  predecessor stopped or gone; then its time, the usage window, its checkout or the limit. Running ones show their
  honest status (queueStatus), which already says review, usage window or stop.
- Reordering is a list's, as the user decided: moving B after Y takes B out of where it was (those after it close up
  to B's old predecessors) and puts it after Y. The rule lives in the protocol (`reorderedFollowers`) and the server
  applies it, so the dashboard's "After…" and dragging only name the move. Dropping onto a queue means "after it";
  dropping onto "Next" means first. Every entry a move writes is the user's, since the user made it.
- Proposals and hand-backs act where the dependency shows (the card) and where the user looks for decisions (the
  waiting list), with the same two buttons.
- Expected times are estimates, and say so ("about 2 h (estimate)"; "no estimate" below five finished steps): a step's
  time is its worker turns' time, so the wait for a review (the user's, often hours) does not make the next queue look
  slow; the average is by model and effort, falling back to the model, then to all, rather than a precise-looking
  number from one or two steps. The samples come from every project on the server: the same models behave alike
  across projects, and one project alone rarely has enough. A step already running counts whole: the view does not
  pretend to know how far it got.

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
- A queue back from waiting waits for a place too (decided by the user on 2026-11-15, queue LQ, after five queues ran
  under a limit of four: two waited for answers, two others started in their places, and the answers came). Its
  engine asks the coordinator before it opens the turn of its answers or a send-back, or its next step; with the limit
  full the run is held (`held` in run.yaml) rather than paused, so nothing of it changes but that it opens nothing,
  and the coordinator lets the held runs go on first when a place frees, in the order they became ready: what has
  begun goes ahead of what has not. The hold is written on the run, not kept in memory, because the coordinator and
  the dashboard read it across projects; the only thing kept in memory is which answers reached a live turn, which a
  restart (pausing every run) loses harmlessly. Counting follows the same line: a queue counts from when its engine
  lets it go on, not from when its derived status turns back to running (an answer recorded, a review accepted), else
  the queue on its way back would fill the place it is about to ask for.
- What reaches a live turn is never held: an answer to a worker that works on beside its question (`--can-continue`),
  a message to a working worker. Holding it would cut into a turn at work; and such a worker counts while it works,
  so no other queue takes its place meanwhile.
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

**Standing approvals of recurring queues** (queue TQ, decided 2026-11-14): the user approves a recurring queue once,
and its runs start by themselves while it stays as approved. "As approved" is one hash over what a run would be: the
template as resolved through the three layers and filled with the values (so a project template that replaces a
shipped one, an edited global one, or a deploy that changes the shipped one all count), the values, the schedule and
`coding`, hashed as JSON with sorted keys so the order things are written in does not count. The server checks it at
each time, just before it makes the queue from the same resolved template, so no run can start with content other
than what was approved: if the hash differs the time passes without a run and the user is asked again. Any
`nexus recurring set` by the orchestrator takes the approval away, even one that changes nothing, so that the
orchestrator cannot keep an approval alive across its own edits; only the user's action approves. Each queue it makes
carries a normal approval of its own revision hash, marked `standing` with the recurring and the approval it came
from, so the queue's record shows where its consent came from.

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

**The chats during an update** (decided 2026-11-15, queue OP). Before, the drain waited for every agent's turn and
refused the user's chat messages, so a deploy that waited an hour for a step closed the orchestrator's chat and the
conversations for that hour, with nothing gained: a chat turn starts no work, and a run start stays refused anyway. Now
only the workers' turns hold the drain (`projectPart` in `src/lifecycle.ts`, the one wiring main.ts and the tests
share). A chat turn still running when the drain ends is not waited for either: at the hand-over it is cut off. Waiting
for it would let a long answer, or a chatty user, hold a deploy indefinitely, and cutting it off loses little, since the
turn can be asked again. So the release first cuts off (interrupts) those turns, after it stopped taking requests, so no
new turn slips in between, and writes what each answered into its session's `runtime.json` (`interrupted`). The server
already owns that file, and every server, once active, reads it: a successor, and also a predecessor that rolled back,
which goes on the same way. What a turn answers is tracked as messages are sent (`AgentHost.send`): the texts sent into
the running turn, and those queued as the next one, by the roles' own quote, the user's words rather than a message
wrapped with a step's context or deploy changes. The quote of a resumed turn is the original one, so a second restart
does not nest them. The agent is asked to check what the cut-off turn had already done, because it may have written a
draft or run a command before it was stopped.

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

**Planned deploys** (the user's decision of 2026-11-14, queue PD; `src/deploy-plan.ts`). A deploy can wait for a step
or a queue instead of starting at once. The plan does not hold anything itself: when its target is in, it starts an
ordinary update, whose drain holds every running queue at its step's end. The target's step has just ended, so its
queue stops right there. Watching the files alone was not enough: an agent's `nexus step done` and the end of its turn
can come within the file watcher's debounce, and the engine opens the next step at the turn's end. So the engine also
asks the planner at every step boundary, before it goes on (Engine option `boundary`). The hand-over ends the plan
before the successor starts, so that a successor reading the same file never deploys a second time; a plain restart
keeps it.

A plan that waits for the user's confirmation of provisional work (`provisional_counts` off, queue PD2) holds only its
own queue, at the step's end, not every queue through an early drain: the setting is the user's own choice for when they
are away, and a drain held open until they come back would stop every project. A plan at a time does not start its
drain while it waits, for the same reason. The deadline turns a waiting drain into one with `now` (Lifecycle.hurry)
rather than starting a second update.

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

### Back closes the topmost layer

Everything the dashboard opens over the queue list is a layer kept in the browser history, so the phone's back
button, the back gesture, the browser's Back and Escape all close the topmost one, and Back leaves the app only when
nothing is open. Each history entry Nexus writes carries `{hash, layers, depth}` in `history.state`: the hash is the
route (`#/<project>[/<queue>[/<step>[/<qid>]]]`, the queue or step drawer being the layer `item`), `layers` the open stack
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
  been at its step; by the rail's definition, `runsNow`, so a run waiting for a retry or the usage window is not
  counted: queue FU);
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

### Speaking into a chat

Decided by the user on 2026-11-14 (queue BI; docs/ideas/backlog-smaller-items.md): a microphone in every chat's box,
only where the browser has speech recognition (the Web Speech API: Chrome, Edge, Safari; not Firefox); it listens in
the reader's language as a BCP-47 tag, else the browser's language; what it hears goes into the box and is never sent
by itself; tapping it again or a silence stops it. Chrome and Edge send the sound to their maker's servers, so the
first use says so in a line under the box.

How it is built (`apps/web/src/voice.ts`, pure and unit tested with a fake recognition class; `components/Voice.tsx`):
`recognitionOf` finds `SpeechRecognition` or `webkitSpeechRecognition`; without either `useVoice` returns nothing and
no button is drawn. A `Dictation` runs one utterance (`continuous` off, interim results on): final text goes to the
draft through `useDraftText`'s `append` (after the text as it is then, a space between), interim text shows under the
box. The reader's language reaches the box through the page context (`page.ts`, the current project's effective
setting); `voiceLanguage` keeps the browser's region when it has one for that language ("en" with an en-GB browser:
en-GB), else uses a usual one (hu-HU, en-US…). Only the chat layouts (the card and the phone's line) show it; the
forms' plain boxes do not. Headless Edge has `webkitSpeechRecognition`, so the capture shows the button as it is; the
listening state is captured with `scripts/capture/fake-speech.js`, loaded through a view's `script` before the
dashboard. Smaller choices made while building, not by the user: the regions, en-US for English, a stop square on a red
button while it listens, and the notice remembered per browser (localStorage `nexus.voice.noticed`).

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
| `series` | A chart's one series colour (the Stats views): the accent stepped into the lightness band the `dataviz` skill's validator allows for the mode (Graphite `#3f7cf5`, Paper `#2f6fec`, Honey `#c47e14`), checked against the cards' surface; a few-data group is `fg-3`, a value beyond a threshold `warn` with ⚠ |

Rules the components keep:

- **A status is a dot and a word** in its colour (`StatusBadge`, the run's state, the update pill), never a ring or a
  filled pill. Step cards are neutral (`surface-2`, the current one `surface-3`); the dot and word carry the status.
- **A kind is a tag**: what waits for the user (Question, Review, Needs approval, Stopped) is the kind's colour on a
  15 % fill of it, without a ring.
- **A callout** (a stop, a merge to confirm, a rejection) is a faint fill of its colour with a 30 % border of it.
- **One accent** for actions: primary buttons, links, focus, checkboxes. Information that is not an action (a
  pending delivery, a planned start) uses `info`.
- Opacity modifiers derive tints from tokens (`bg-warn/15`), so a theme defines each colour once.
- **Charts** (components/charts.tsx, the reasons per form in docs/ux/stats-mockups.md) follow Claude Code's `dataviz`
  skill: one series colour, never a status colour for a series; thin marks with a 4 px rounded end; hairline solid grid,
  dashed only for a reference line (a threshold, a target); text in the text tokens; a tooltip on hover and focus;
  and a table view beside every chart. Two measures of different units are two charts, never two y-axes.

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
bottom bar has five tabs at the thumb: **Orchestrator** (the chat), **Waiting** (everything that waits in all
projects, with its count), **Queues** (the project's queues; what waits has its own tab), **Ideas** (the
conversations) and **Stats** (the project's metrics; queue ST3). The header's tools (the update, the usage, notifications, remote access) are in Settings there, at
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
`components/details/questions.tsx`): the question first, what the orchestrator said passing it on, the options as 48 px
buttons, the user's own words, whether the worker may go on, then the step's details below; Answer in the action bar. An
option and words go together in one answer: the option, a blank line, the words. A waiting card shows a question's
options as buttons (the attention item carries `options`); a tap opens the sheet with that option chosen and the user
confirms there. The choice travels in memory (`chooseOption`), not in the URL: a reload opens the sheet with nothing
chosen. On the desktop the card has no option buttons and the step keeps its answer box in the action bar.

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
  (`runHoldsCheckout`, paused included): a halted run holds nothing and does not block the fix; a worker that comes
  back to a changed file reads it again at its next turn. The fix carries the check's `version` (a hash of both files),
  so a file changed after the user looked is never overwritten by a change the user did not see.
- **Moving `CLAUDE.md` into `AGENTS.md`** leaves the link lines out of the moved text (they would import the file
  itself), and lists the @imports it holds: Codex does not follow them, so the confirmation says so.

### Removing a project (queue PJ)

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

### A closing refactoring step kept by Nexus

Decided by the user on 2026-11-14 (docs/ideas/refactor-step.md, queue RF); the protocol is in PROTOCOL.md, "The
closing refactoring step". Every queue that contains coding (`coding: true`, set by the orchestrator) ends with a step
Nexus keeps outside the queue's list of steps.

- **Derived, not stored.** The step is added by derivation after the queue's own steps (`stepDefs`), so everything
  that already walks a queue's steps (the engine's next pending step, "done", the report of the last step, the
  orchestrator's "last step", `queue set finished`) treats it as the last without a rule of its own. A revision cannot
  put anything after it, since it is not in the file a draft writes.
- **Running again** is derived too: a step of the queue's own that starts after it ran sets it back to pending. The
  rule looks at work, not at revisions: a revision that only rewords or skips adds nothing to refactor.
- **Fresh eyes through the existing switch.** Context care's switch to a fresh session is reused with a reason of its
  own (`refactor`); the seed gives no context summary, the step reads the queue's work itself from the commit range
  that `git.yaml` already records (first start to last end of the queue's own rounds) and git's `--stat`, so a large
  diff never fills the prompt.
- **A project's rules** are a "Refactoring" heading in its AGENTS.md; the opening says whether there is one, so the
  worker is told to follow it only where it exists, and no project has to change for the step to work.
- **Skipping is the user's, at Continue.** A stopped queue may close without the step: Continue carries the user's
  choice (a checkbox in the queue's bar, while the step has not run), recorded as a `status` change by
  `user_continue` with the stop's reason, so the record says who skipped it and why. Agents never skip it. A skipped
  closing step stays skipped when the stopped step goes on: the skip was chosen for that close. A rejected queue goes
  on by an approved revision, not Continue; it gets the closing step at its end, and the skip is not offered there.

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
- **Every write to a child's input needs an error listener** (queue CR). A process that has exited while the server
  has not yet seen its exit (the server busy) fails the next write with EPIPE, also a short line on Windows, emitted as
  an error event of its input; unheard, it ends the server. On 2026-11-18 the model list's `initialized` to a Codex
  that had answered and exited did so. Once the exit is seen, Node has destroyed the input and a write fails only to
  its callback; reading the output of an exited process ends it, no error.

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

- **An orchestrator on Codex can be kept to its drafts and its own event log, by a permission profile** (queue OC,
  decided by the user 2026-11-16). Probes with Codex 0.167.2 on Windows (elevated sandbox), a temporary project
  outside the temp folder (`:workspace` makes the system temp folder writable, so a project under it proves
  nothing): first `codex sandbox -P <profile>` with a script that tries every write (no model), then two `gpt-6-luna`
  turns that tried the same with the file tool (apply_patch) and the shell: `codex exec` (199k input tokens, 191k of
  them cached, 636 output) and `codex app-server` (118k input, 113k cached, 511 output; Codex reports no cost).
  - A profile with no writable ancestor works where the carve-out above failed: `extends = ":read-only"` and
    `filesystem = { "<root>/.nexus/drafts" = "write", "<root>/.nexus/sessions/<orchestrator>/events.jsonl" = "write" }`
    (a single **file** may be granted), the working directory the project's root. Writable: the drafts and that one
    file. Refused: the project's root and its files, `project.yaml`, the session's own `session.yaml` (its role) and
    `inbox.jsonl`, another session's inbox, `sessions/user/events.jsonl`, `queues/*/queue.yaml` (approvals, Continue),
    anything outside the project (`away.yaml` lives in NEXUS_HOME), and the temp folder. The `nexus` CLI works inside
    it (`queue draft --template`, an event appended), and `--session user` cannot write in another session's name. Raw
    lines in its own events.jsonl add nothing: the loader drops events that claim another session and user-only
    events from a session whose role is not `user`.
  - Through the app-server, Nexus's way: `thread/start` with `config: { default_permissions, "permissions.<name>.extends",
    "permissions.<name>.filesystem" }` and no `sandbox` (the older settings would win); the thread then reports
    `workspaceWrite` with exactly those two roots, and the working directory stays read-only. A turn must not send a
    `sandboxPolicy` either.
  - The elevated sandbox leaves its grant on the file as ACL entries (`CodexSandboxUsers` and a per-grant SID); a
    later `:read-only` or `:workspace` sandbox elsewhere still cannot write the file.
  - Rejected: `workspace-write` with `.nexus/drafts` as the working directory alone writes only the drafts (verified),
    but the CLI then needs `.nexus/sessions/<orchestrator>/` writable, and that folder holds `session.yaml`: the
    orchestrator could rewrite its role to `user` and act as the user.
  - **Loopback stays open in every Codex sandbox**: with `network.enabled = false`, and with `:read-only`, a public host
    was refused (EACCES) but `fetch("http://127.0.0.1:<port>/")` reached a test server, and a sandboxed script could
    send an `Origin` header of its choosing. The server's write guard (Origin's host equal to Host, JSON, no
    `Sec-Fetch-Site`) lets such a request through (read from the code; the live server was not probed). So any agent
    with a free shell on this machine (Codex workers, Claude Code workers, an orchestrator on Codex) can do the user's
    dashboard actions over HTTP; the orchestrator on Claude Code cannot (it runs only `nexus` and read-only git). The
    user decided: the gap is closed by a queue of its own, and the orchestrator is not switched to Codex until it is.
  - Built in OC2: `CodexOptions.permissions` (a profile in place of `sandbox` and `writableRoots`), the orchestrator's
    launch by `orchestrator.runtime`, its Codex briefing without helpers (it does their work itself, by their own
    checklists in short), and a fresh session at a runtime switch (no conversation moves between runtimes; the old
    chat stays above). A switch waits for the turn running then to end: two orchestrator processes at once could act
    twice. Building it found a lost message in the Codex adapter: a `turn/steer` refused because the turn had just
    ended came back after `turn/completed` had found the queue empty, so the message waited for a next one; it now
    starts its own turn.
  - **A resumed thread keeps the profile** (probed in OC2's review round, 2026-11-16, Codex 0.167.2, `gpt-6-luna` at
    effort low, a temporary project outside the temp folder): through Nexus's own `Orchestrator` against the real
    Codex, a wrapper logging the JSON-RPC lines. A turn on `thread/start`, the process ended, then a new
    `Orchestrator` (a restarted server) resumed the same session with `thread/resume`, sent with the same `config`
    and no `sandbox`; both answers reported `activePermissionProfile: nexus_orchestrator` (extends `:read-only`) and
    a `workspaceWrite` sandbox with exactly the two granted paths. In the resumed thread a file in the project's
    root (apply_patch: "writing outside of the project; rejected by user approval settings"; and `Add-Content`:
    access denied) and the session's `session.yaml` (access denied) were refused; the draft was written. The first
    run found that a fresh project has no `.nexus/drafts` and the sandbox cannot make it ("Failed to create parent
    directories"), so the server now makes the folder before Codex starts, as it does the events file. Cost: two
    runs, each a short turn (18.4k input tokens, 5 output) and a turn of four actions (113k input, 93k of them
    cached, 364 and 445 output); no cost reported.

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

## The tests' waits (queue TS1)

Decided by the user on 2026-11-14 (docs/ideas/test-speed.md): the tests that run fake runtimes, servers or git wait
briefly, so that a change that breaks many tests fails the suite in minutes. Before, each test file had its own wait
of 20 or 30 s polled every 100 ms, and a broken change took the suite past an hour (605 tests with 138 failures in 97
minutes, almost all of them "timed out waiting for the run to finish").

- **One helper, `apps/server/test/wait.ts`**: `until(what, pred, ms, detail)` looks every 25 ms (`POLL_MS`) and fails
  after `WAIT_MS`, 10000 by default, set with `NEXUS_TEST_WAIT_MS` (higher on a slow machine). Every test file uses it;
  their own `until` keeps only its failure detail. `serverUp(url)` waits for a server a test started.
- **Longer waits are named** (`LONGER`), as multiples of `WAIT_MS`, so the variable scales them too, each with its
  reason measured: `LONGER.step` (2×) for one step of a worker's, or one agent's turn after another's (the
  orchestrator sends a step back, the worker takes round 2), which took 2.5 to 3.5 s in a full run and over 5 s in a
  slower one; `LONGER.run` (3×) for a whole run or chain of runs to its end (finished, halted, stopped, paused):
  every step starts the fake worker's turn and calls the nexus CLI, each a node process; alone a two-step run takes
  about 2 s, in the full suite, whose files run side by side, such waits took 4 to 8 s. `LONGER.processes` (6×) for
  work made of many processes waited on together: a server's start, an update's hand-over and rollback, a push by
  git, a run that commits in a worktree; the longest took 12 s (a rollback). `LONGER.closingRun` (12×, queue TT2)
  for a coding queue's whole run in its worktree through its closing refactoring and integration steps: alone 6 s, in
  a full run 18 s, but 71 s on the user's slower machine (full runs of 700 to 760 s), where the test of two such runs
  failed in 3 of 4 full runs. That test stays one: a second test from a finished first run would need the run's end
  (worktree, merge, integration mark, events) made by hand, a copy of what the engine does. A test that waits for a
  time of its own (an away mode that ends in 8 s, a slow fake step of 4 s) waits that time plus `WAIT_MS`.
  `NEXUS_TEST_WAIT_LOG` names a file that gets every wait over 2 s: how these were measured.
- **10 s, not 5** (decided 2026-11-14 with the orchestrator; the user's 5 s was an example). At 5 s, with the
  causes below fixed and the named waits in place, an agent's turn or a worker's step still took 5 to 7 s now and
  then in a full run: the user's machine runs other applications (18 to 25 % of the CPU when idle) and a full run took
  185 to 240 s; a different test failed in nearly every run. The goal stays: a change that breaks many tests fails
  the suite in minutes, not hours.
- **Under made-up load** (`scripts/load-tests.mjs`) the waits took four to five times as long as in a full run, so
  the script sets `NEXUS_TEST_WAIT_MS` to 50000 unless told otherwise (`--wait-ms`): a load run looks for races, not
  slowness.
- **What the shorter, faster waits brought out**, each fixed at its cause:
  - away.test.ts waited for a chat line and then read the orchestrator process's log, which the delivery reaches a
    little later; polled every 100 ms the gap was hidden, every 25 ms it showed. It now waits for the delivery it
    checks, as do three waits of orchestrator.test.ts that slept 700 ms or not at all before such a read.
  - away.test.ts turned away mode on for a real 8 s that the run had to fit in, and for 6 s that a server's restart
    had to fit in; on a busy machine both outlasted it. The first's end is now set to "now" when the test gets there,
    as the server's own timer would end it; the second keeps an hour across the restart and then sets a few seconds
    on the running server to see it end.
  - deploy-notices.test.ts started a request to the server on every look without awaiting it; at 25 ms they piled up
    (40 a second) and the update did not settle in time. It now asks once at a time (`untilAsync`).
  - Tests that waited for a passing state (a step "running" for 0.3 to 2.5 s, two steps running at the same moment)
    missed it on a busy machine. Where a test acts while a step works, the fake step now works `WORK_MS` (half of
    `WAIT_MS`) and the test waits for the step to have begun (its first stretch at work recorded); where it checks
    that two runs went side by side, it compares their recorded times afterwards.
  - provisional.test.ts waited for a step "at work" between two rounds, a state a fast fake round can leave between
    two looks; it now waits for the send-back's record, and the next round's review for its end.
  - review.test.ts sent the orchestrator's fake a command (`FAKE-NEXUS`) once a review notice showed in the chat;
    sooner now, the command often arrived while the fake still answered the notice, as a message read mid-turn, which
    the fakes only kept in their history: the command was lost. The fakes now act on a command read mid-turn before
    the turn ends, as an agent does (`actOnRead`).
  - One was the engine's: gitinfo.test.ts saw a step's recorded first HEAD include the step's own commit. The engine
    sent the worker its step and then read HEAD (git), which took one to two seconds on a busy machine; the fake worker
    had started and committed meanwhile. The engine now records the rounds (the step before ends its round, this one
    begins) before the worker hears of the step.
- **Failing fast.** With the engine deliberately broken (a done step never moves the run on), the suite failed 148 of
  626 tests in 18 minutes (1101 s) at 10 s, and 147 of 625 in 9 minutes (561 s) while it was 5 s; it had taken over an
  hour before. The longest file is the one with the most waits for whole runs. A green full run takes 270 to 285 s.

## Tests while working, and the slowest files (queue TS2)

Decided by the user on 2026-11-14 (docs/ideas/test-speed.md): while working, only the affected test files run, and the
run stops at the first failure; the whole suite runs at the step's end, as the queue's check. `npm run test:files --
<files>` (`scripts/test-files.mjs`) runs the files one after another with the spec reporter and stops the run (its own
process tree) at the first failing test. Workers learn it from their briefing and `nexus help tests`, which keeps it
general (the project's own way is in its AGENTS.md) and names Nexus's script as the example.

`npm run test:times` (`scripts/test-times.mjs`, a test reporter) lists each file's time, the sum of its top-level
tests, which run one after another within a file while the files run side by side. The suite's time is that of its
slowest file under the load of all the others: 277 s before, all but one second of it engine.test.ts (276 s; 148 s
alone). Two changes, neither touching what is tested:

- **Steps held, not timed.** A test that acts while a step works used to let the fake work `WORK_MS` (5 s) and wait it
  out. `holdWork()` (wait.ts) now holds the fakes' "slow" steps until the test calls `release()` (FAKE_RELEASE), right
  after it has acted: no fixed wait, and a late look still finds the step at work. Used in engine, approval-wait,
  lift and handover tests (approval-wait alone: 106 s to 70 s).
- **engine.test.ts in four files** (engine, engine-runtimes, engine-failures, engine-updates; their setup in
  engine-setup.ts), so its 48 tests run side by side: together 69 s alone.

The whole suite went from 277 s to 189 s; its slowest files now are accepted.test.ts (git pushes to bare repositories)
and approval-wait.test.ts, each about 170 s under the full load.

**The rest held too (queue MX).** Eight more files (chains, context-care, coordinator, global-settings, languages,
orchestrator, provisional, rollback) let a fake step work `WORK_MS` while they acted; they hold it now, and `WORK_MS`
is gone. Three things the move needed:

- `release(step)` lets only that step go (the fake reads `<FAKE_RELEASE>-<step>`): a test that needs one queue's step
  to end while another's stays at work (the limit across projects), or one step after another to end (a pause, a
  stop, an update's drain), a step re-run after a restart still held.
- "summaryslow" works as "slow" does (held, or FAKE_SLOW_MS), instead of a timer of its own.
- A test that checked that nothing started (a chain that must not fire) slept 400 to 800 ms first. It now has the
  engine look at the files once, synchronously (the test's `tick`, as the server's watcher does): the coordinator's
  pass starts what is due within `onChange`, so what did not start then never would by itself. A message sent while
  a step works is handed over the same way (languages.test.ts), where it used to arrive only at the step's end.

Measured back to back on a quiet machine, the eight files went from 606 s to 503 s together; the suite (240 s against
246 s) is set by its slowest files, which this did not touch.

**Remaining fixed work and repeated repositories (queue TF3).** The provisional deploy tests now release Q1 and Q2
separately after their commits. The scenario tests release Q1 after pausing and Q4 only after the restart; their
frozen-clock golden files stay unchanged. Neither test needs the work to last a fixed time. The merger tests build
their initial Git repository once and copy it, including `.git`, into each new project. No objects, branches, index,
reflogs or worktree registrations are shared, and each copy gets its own ProjectStore. The context-care,
global-settings and protocol closing/integration pairs use tables of the original cases, retaining their distinct
inputs and assertions; fewer test registrations do not mean fewer cases.

## One full test run on the machine (queue FX)

Decided on 2026-11-15: with queues in worktrees side by side, two checkouts often ran `npm test` at once; each run
then took 480 to 510 s instead of 240 s, and unrelated tests failed on their time limits (MX2, ST2.3, ST2.integrate).
The suite runs every file side by side on every core already, so two at once only compete. `npm test` (and
`npm run test:times`, whose times mean nothing under such load) run through `scripts/test-lock.ts`:

- **A file, created exclusively**, in the system's temporary folder, with the pid and the checkout of its run (the
  wrapper's process, which lives as long as the run). Of two runs starting at once, one creates it.
- **The other waits**, saying once a minute on stderr what for (the checkout, the pid, since when), so a worker's
  check does not look stuck. A lock whose process is not alive is taken over at once (a run killed with its tree,
  a crash); one that cannot be read is being written while it is young, and is taken over once it is not.
- **At most 15 minutes**, then the run went on without the lock: a run stuck for longer, or a pid that Windows gave to
  another process, would never block the suite for good. Two runs taking over the same dead lock in the same moment
  could both run; that is today's behaviour, not worse. *Gone since queue EC (EC2, the user's acceptance of EC1's
  P11): a run waits until it has the lock; the staleness of queue TF below handles a hung holder or a reused pid.*
- **`npm run test:files` never waits**: a few files while working, short, and run often.
- Only branches that contain the lock take it: an older branch's run neither waits nor is waited for.

Measured with two temporary clones started 5 s apart (a busy machine, other work running): the first took 268 s,
the second waited about 263 s and then took 181 s; both green.

### A run ends with its starter; a lock held too long is stale (queue TF)

The survey TH found a hung run of another worktree holding the lock through a night, so every full run waited 15
minutes and then ran without it. On Windows a killed parent leaves its children running: a worker's `npm test` ended
on its background time limit, or a shell closed, could leave the whole test run going and holding the lock (its
process alive). Decided:

- **A watchdog process** per run (`test-lock.ts --watchdog`, detached, with an IPC channel to the wrapper) watches the
  run's starter: the wrapper's parent always, then each ancestor while it is a shell (cmd, bash, sh, PowerShell, ...)
  or npm, so up to the agent or terminal that ran the command and not beyond (not the Nexus server, whose restart is
  not the run's end). Since PT2 the watchdog starts the runner itself. One of the watched processes gone, or the
  wrapper's IPC closed: the watchdog ends its own child and removes the lock. On Windows it uses the retained child
  handle and Node/libuv's job; elsewhere, the runner's process group. It looks every second; while waiting for the
  lock too. It never needs a second process query to prove ownership of an orphaned runner.
- **Found by asking the system**: on Windows one PowerShell walks the parents with a CIM query per level (about a
  second; the whole process table takes several, and `wmic` is gone from current Windows), and stops after the first
  that is no shell or npm: WMI is not cheap, and twelve levels per walk, about eight walks per suite (the run's and the
  lock tests'), coincided with the update tests timing out in most full runs. A parent newer than its
  child is a reused pid and ends the walk. Git Bash breaks the Windows chain where an MSYS process execs another (npm's
  own shell script does): the exec'd process's Windows parent is a stand-in that is gone, and the walk goes on through
  MSYS's process table (`ps -e -l` beside its bash.exe: PID, PPID, WINPID). The run waits for this discovery before
  acquiring its lock. Unknown ancestor PIDs are not used as evidence that a starter has died.
- **Node already does part of it on Windows**: libuv puts a process's children in a job object that ends them with it,
  so a killed Node parent takes its children along (and a test whose starter is a Node process does not show the
  problem: the starter in the tests is a shell). That job would end the watchdog too, which is why it is detached.
- **20 minutes since `since`** (`NEXUS_TEST_LOCK_STALE_MS`), five times a full run, makes a lock stale even if its
  process lives (a hung run, a pid reused): the next run takes it over at once instead of waiting 15 minutes and
  running without it. The old run is not ended (not that run's to end); its end leaves the new lock alone.
- **Never a tree kill by a pid that may have been reused**: Windows gives a pid to a new process at once, and
  `taskkill /T` of a reused one ends another program's tree. The watchdog now owns the runner's process handle; no
  PID from an ancestry snapshot is a cleanup target. The tests end only
  their own starter, through its handle, and their long run ends by itself within two minutes.
- **Failing tests left servers running**: `chat-update.test.ts`, failing before its hand-over, released its stand-in
  build in `finally`, so the update went on after the test and started a successor server nobody ended (with its fake
  runtimes, which kept starting turns); a timed-out hand-over's successor was not ended either. Several were found
  after a morning of full runs, and they loaded the following ones. Its `finally` now cancels the drain or fails the
  build, waits for the update to settle and ends the successor the update's log names.
- **The drain and the queue's pause are separate observations (TF.refactor)**: the lifecycle checks whether the
  worker runtime is idle, while the engine records the queue's `paused` state after its turn-settle delay. Under load
  the chat-update test observed `updating` while the queue still said `pausing`. It now also waits for `paused` before
  reading the run, keeping its assertions about the pause, restart flag and interrupted step unchanged.

### Without process queries: lifetime IPC and a renewable lease (queue PT2)

When WMI or `ps` cannot report the starter (or `NEXUS_TEST_LOCK_QUERY=off` explicitly disables discovery), the
wrapper and watchdog still share an IPC channel. The watchdog owns the runner from its launch and can end it when
the wrapper disappears, without identifying any process from a list. A cooperative caller may also supply a Node
IPC channel to the wrapper: disconnecting that channel ends the run even if the wrapper itself survives its caller.
No unavailable ancestor chain is guessed. A plain shell with no such connection cannot be watched beyond the
sandbox's teardown of the wrapper when queries are denied.

In this mode the lock carries `lease: true` and a random ownership token. Its holder renews its modification time
through the open file descriptor every second (or one third of a shorter expiry, at least 10 ms). A live renewal
keeps other runs waiting regardless of the original acquisition time or PID visibility. Without renewal for
`NEXUS_TEST_LOCK_STALE_MS` (20 minutes by default), another run can take it over. This also handles a sandbox killing
both wrapper and watchdog: no observer needs to survive to release the lease. Expiry makes the lock reclaimable;
the next acquirer removes the old file. (The 15 minutes' maximum wait went in queue EC, EC2.)

Renewal uses the original open file, not its pathname, and release checks the ownership token as well as PID. A
superseded holder cannot renew or remove its replacement, even when the PID is the same. Older records without a
lease retain the original dead-PID and 20-minute absolute-age behavior; available process queries retain the
existing ancestor-watch behavior. The private lock and IPC formats are in PROTOCOL.md.

Tests disable queries and remove either the connected starter or the wrapper, then check the watchdog, runner,
test process, grandchild and lock are gone. They also cover expiry with a still-live recorded PID, renewal beyond
the initial deadline, and safe replacement under the same PID. The existing shell and Git Bash tests still run
where system queries are available.

The real probe (Codex 0.167.2, `gpt-6-luna`, effort low, workspace-write, approval never, an isolated temporary
folder) ran a tiny test without WMI, then started a long test. Interrupting the turn and closing the sandbox ended
all five observed processes, including the watchdog. Consequently the lock file remained as an unrenewed lease;
a second real sandbox invocation, without a model call, reclaimed the expired lease and removed it after its tiny
test passed. No process or lock remained at the end. Usage was 11,185 input tokens (none cached) and 76 output tokens,
11,261 total; Codex reported no dollar charge. At the [published Luna rates](https://developers.openai.com/api/docs/models/gpt-6-luna)
the API equivalent is about $0.00116, not a reported bill. The probe used a two-second expiry; production retains twenty minutes.

## The engine's own waits in tests, and what sets the slowest files (queue FX)

Measured first (`npm run test:times`, `NEXUS_TEST_WAIT_LOG`): the slowest files (approval-wait, engine-failures,
lift, merger; accepted further down) spend almost nothing in the tests' own fixed waits (approval-wait about 10 s of
its 57 s alone, 117 s in the full suite). Their time is work: every step's turn starts or wakes a fake runtime process
and calls the nexus CLI at least twice (`step start`, `step done`), each a node process of about 270 ms alone (loading
zod about 85 ms, the schemas 55 ms, yaml 55 ms; Node's compile cache does not change it), and the merger's cases run
git dozens of times. In the full suite every core is busy, so each file takes about twice its time alone.

- **The engine's fixed waits are options** (`EngineOptions.turnSettleMs`, default 300 ms, the settle after a turn's end
  before the engine decides; `startupMs`, default 1500 ms, before a new engine resumes held runs and looks at planned
  starts). The server keeps the defaults; tests spread `QUICK_ENGINE` (wait.ts: 50 and 200 ms) into their options,
  `FAST` (engine-setup.ts) included. The fakes write their last events before the turn ends, so the shorter settle
  changes nothing they test.
- **"Nothing happens" waits are kept, shorter, sized to what would have happened**: twice the timer that would have
  acted (500 ms past `startupMs`, 200 ms past a retry or a nudge), and a push that would have started is waited for
  with `pusher.settled()` after twice the test's 150 ms look.
- Measured back to back on the user's machine (another session's test file running beside them): the four slowest
  files and accepted went from 443 s to 386 s together (13 %), the slowest file from 118 s to 92 s, the suite from
  156 s to 147 s. The 25 % the queue asked for is out of reach by waits: what is left is the processes' own CPU work.
  A faster CLI start (loading zod and yaml only for the commands that need them) would help every test and every
  agent's call; that is a change to the CLI, for a queue of its own.

## Findings from the flaky tests (queue FU4)

Four server tests failed now and then on a busy machine. `scripts/load-tests.mjs` brings such failures out (12
busy-loop processes on the user's 16 logical cores and 4 to 6 copies of the test files at once); with 6 copies,
9 of 12 runs failed before the fixes. The causes:

- **A hand-over during a turn handed over that turn's reply** (conversations.test.ts). The instruction went into the
  running turn (`next`, or Codex's steer) with the hand-over flag already set, so that turn's end took its reply, the
  answer to the earlier message, as the summary. Real, not only a test's: a user who hands over while the partner
  still writes. Now the instruction waits for the turn's end and runs as its own turn.
- **A stopped partner's idle timer kept the process alive for 15 minutes** (conversations.test.ts: a run that took
  906 s instead of about 100). A turn's end that the stopped process still delivered after the shutdown armed the
  idle timer again. Now none is armed after the shutdown, it is cleared when the process exits, and it never keeps
  Node up (`unref`). The load script reports tests and files over a minute, so such a hang shows even when the run
  passes.
- **A runtime record was `idle` during a turn** (runtime-records.test.ts, Codex). The record went `working` only with
  the context tokens, and a Codex reply's text comes before them, so a record still `idle` from the process start read
  as a finished turn. `AgentHost` now marks it `working` when a turn begins; `idle` means between turns.
- **A test halted a run in the middle of its worker's turn** (review.test.ts, "a send-back on a halted run waits for
  the resume"). The step's outcome lands while the turn still runs (the last step's report follows it), and a message
  to a working process goes into its turn whatever the run's state. The engine halts only between turns, so the test
  now waits for the turn's end, as a real halt does.
- **A worktree was removed while its worker's process was still exiting** (report.test.ts): Windows refuses to delete
  a folder a process runs in ("Permission denied"). The test now cleans up after the process has exited, as a user's
  cleanup comes. Its other failure was time: two steps and a report start about eight node processes, a step took 14 s
  under that load, and the 20 s wait was shorter than the work: now a named longer wait (see "The tests' waits").

## Findings from review levels (queue RL1)

- **Every step is reviewed now, so the last step of every queue ends in review.** Before, `continue` ended a queue's
  last step `done`, and an agent whose process ended right after its report (the CLI closing, a crash after it) left
  nothing to run: the run finished. In review, the same exit read as a failed turn and was retried on a new process,
  for nothing. Now a process that ends while its run's step waits for its review is no failure: the run waits for the
  review, and then finishes if nothing is left, or starts a process that resumes the session for what comes next (the
  next step, a send-back).
- **Levels apply from the change on, not to the past** (the orchestrator's send-back of RL1). The first version
  derived every recorded `step.done` by level, so after its deploy about 38 long-finished queues stood `waiting`, their
  `continue` steps in review for the orchestrator. The simplest fix of the options: one time per project,
  `review_levels_since`, set by the server at its first start with levels; an earlier `step.done` is derived by the
  old policy of its step, which the queue file keeps (`legacy_policies`) once the old fields are gone. A marker on each
  new `step.done` would have needed every writer of events (the CLI, tests, seeds) to change, and the events written
  between the two deploys would still have been ambiguous. Checked read-only against this repository's 136 steps in
  55 queues: derived with the code before levels and with this one, none differs (without the time, 95 did).
- **A pause takes effect at the review.** A run asked to pause (by the user, or by an update's drain) paused at the
  step's end, and a step in review never reached it: the run stayed `pausing` until the review, and an update would
  have waited for an orchestrator that is not told anything during a drain. A step in review has finished its turn,
  so the pause takes effect there; the review goes on meanwhile.
- **Tests about something else than review stand in for the reviewer.** Most engine tests ran their queues through
  under the old default `continue`. With no level without review, a test project without an orchestrator hands each
  step to the user; `apps/server/test/fake-reviewer.ts` accepts those (levels 2 and 3) where the test stands in for
  the file watcher, and leaves level 1 to tests that want a step held for the user.
- **Approvals survive the change of form.** An approval pins a hash of the steps, and a step's old `review.policy` was
  part of them. Rather than a second hash rule kept forever, reading a queue carries an approval of the old form of the
  same content over to the new form (`parseQueue`), and the next write stores it so; checked against the 55 queues of
  this repository's own `.nexus` (read only): none changed its approved state.

## Level 3: provisional acceptances (queue RL2)

- **At level 3 the orchestrator still accepts what has nothing of the user's.** The queue's text named two choices
  (accept provisionally, send back); asked, the orchestrator settled it from the decision ("what is the user's goes
  into a batch"): a step with only checkable criteria is accepted for good, as at level 2, and only what has something
  of the user's goes to the return batch. Otherwise away mode, which runs level 2 as 3, would fill the batch with every
  technical step.
- **A Fix it on a provisional step does not reopen it.** Later steps may already build on it, so the step and its work
  stay and the fix becomes a new step: the orchestrator drafts it as a revision, which a running queue waits for at its
  running step's end (the approval wait it already had) and a finished queue gets approved and started.
- **"Built on it" is git ancestry.** With provisional work not counting, a push is held when the commit to push has the
  provisional step's review commit in its history (and that step made commits of its own), whatever queue it came
  from: the same rule covers a later step of the same queue and another queue in the same checkout.

## Away mode (queue RL3)

- **One global mode, kept with its history.** Away mode is the user's, for all projects, in one file the server writes
  (`<NEXUS_HOME>/away.yaml`). Its past periods stay on record because derivation needs them: a level-2 step accepted
  provisionally while the user was away must still read as accepted after the mode ends, so the rule is "the
  acceptance's time lies in an away period", not "away mode is on now".
- **It ends by itself, also across restarts.** A period past its `until` reads as off at once; a server timer, armed
  again at every start, records the end so the orchestrator is told.
- **Only the user switches it.** The dashboard does, and so does `nexus server away` from the user's own terminal; the
  CLI refuses it in any agent session, the orchestrator's included, and there is no event an agent could write. As
  with update and cancel, the server cannot tell the CLI from another local process; the CLI is the gate.
- **"Which queue can start" is the coordinator's answer.** When a queue waits for the user meanwhile, the orchestrator
  is told the approved queues that pass the same check a start would (one queue per checkout, the limit), so it never
  gets a queue in the checkout the waiting one still holds.

## The web for thinking partners (queue WB)

Probed on 2026-11-15 with Claude Code 2.1.323 (`haiku`) and Codex 0.167.2 (`gpt-6-luna`), in temporary directories,
against a local test server on port 4391. Cost: about $0.07 of Claude usage (six short turns, $0.005 to $0.023
each) and seven short Codex turns on the ChatGPT subscription (20k to 40k tokens each, most of them cached).

- **Claude Code's deny rules hold, by name only.** `WebFetch(domain:localhost)`, `(domain:127.0.0.1)` and a wildcard
  `(domain:*.x)` refused the fetch (`permission_denied`, also inside a sub-agent). But a name that merely resolves to
  127.0.0.1 (`127.0.0.1.nip.io`) was not denied, and WebFetch connected to the local port (its upgrade to https failed
  the handshake there, which is luck, not protection). So `fetch` also gets a `PreToolUse` hook (web-guard.ts) that
  resolves the host and refuses local, private, Tailscale and the machine's own addresses; probed: the nip.io name and
  `[::1]` were refused by the hook, example.com was fetched. The machine's changing addresses are the hook's to check,
  not rules': a changed rule would restart the partner's process.
- **In Claude Code 2.1.323 the main agent has no WebFetch of its own**: it calls the `web-fetch` sub-agent, which
  fetches. The rules and the hook apply inside it, so nothing more is needed. WebSearch is a deferred tool the model
  loads with ToolSearch, which `dontAsk` allows.
- **A Codex thread searches the web without any setting** (Codex's default), and with `web_search: "disabled"` it still
  searched, through the `codex_apps` MCP server's search connector, an app of the user's ChatGPT account. Worse, the
  user's own MCP servers run outside the sandbox: `node_repl` fetched `http://127.0.0.1:4391` without an approval, so a
  Codex partner could already read the local API before this queue, whatever its sandbox. Thread config overrides
  turn them off: `features.apps: false`, `features.plugins: false` (the plugins' servers: computer use, Blender) and
  `mcp_servers.<name>.enabled: false` for each top-level server (`config/read` names them; an override for a name
  that does not exist fails the thread start: "invalid transport"). The user decided that partners run so at every
  level; workers and the orchestrator still got the user's tools then (see below, queue FX).
- **Codex's search modes**: `cached` searches; `live` also opens pages (an `openPage` action). Both run at OpenAI, so
  no local address is reachable through them. A webSearch item's query is empty when it starts; the chat line is
  written at its completion, from its action.

## The user's Codex tools for workers (queue FX)

Decided on 2026-11-15 with the queue's approval, after WB's probe: a Codex worker got the user's MCP servers,
plugins and apps from `~/.codex/config.toml`, and an MCP server runs outside the sandbox (WB saw `node_repl` fetch a
local port without an approval), so a Codex worker could reach this machine's Nexus API on port 4317.

- **Off by default, kept by name.** A Codex worker's thread starts as a partner's does (`withoutUserTools`):
  plugins and apps off, every MCP server `config/read` names off, except those the project lists in
  `runtimes.codex.mcp_servers` (project only, empty by default: a project whose Codex workers need one, Blender in
  Honeycomb, names it in its settings). Plugins and apps are never kept: a plugin's servers (computer use, Blender)
  come and go with the plugin, and the apps' connectors searched even with web search off.
- **An orchestrator on Codex keeps no server** (queue OC): its thread starts with every MCP server off, plugins and
  apps too, whatever `runtimes.codex.mcp_servers` says (that list is the workers'); a test guards it. A server runs
  outside the sandbox, and could reach the Nexus API for it.
- **Probed on 2026-11-15** with Codex 0.167.2 and `gpt-6-luna` (effort low, read-only sandbox, approval `never`), in
  a temporary project, through `CodexSession` with the worker's options. The probe's own MCP server (one tool,
  `fx_probe_echo`, noting its start) came in by `-c mcp_servers.fxprobe...` on a wrapper around `codex app-server`,
  so the user's `~/.codex/config.toml` was not touched; the user's own servers were turned off as above. Off by
  default: the server never started, and the model had no such tool ("NONE"). Kept by name: the server started and
  the model called `fxprobe.fx_probe_echo` (the call did not complete under the read-only sandbox with approval
  `never`, which is the probe's setting, not the subject). Cost: two short turns on the ChatGPT subscription,
  1910 + 8368 input tokens (24704 + 31872 cached) and 31 + 75 output tokens; no model call otherwise.

## Static analysis (queue SA)

Agents make mistakes a static check catches cheaply; the user decided on 2026-11-14 that Nexus checks them by machine
(docs/ideas/software-dev-features.md). `npm run lint` runs ESLint, then dependency-cruiser, and fails on any finding.

**ESLint** (`eslint.config.js`) with type information (`projectService`, each file under its own tsconfig) over
`packages/protocol`, `packages/cli`, `apps/server` and `apps/web`, sources and tests. Correctness rules only, no style
rules, and every rule an error (a warning nobody has to fix is noise):

- `no-floating-promises`: a promise nobody awaits loses its rejection and its ordering (the forgotten `await`). The
  `test()` calls of `node:test` are exempt: the runner awaits them. A promise left alone on purpose says so with `void`.
- `no-misused-promises`: a promise where a condition or a void callback is expected, e.g. an async function as a
  React `onClick`. The dashboard's handlers write `() => void save()`: the handlers catch their own errors.
- `switch-exhaustiveness-check`, with a `default` not counting as handling the members it hides: a switch over a union
  names every member, so a new state or event type is a lint error wherever it is not decided on. A switch that does
  nothing for some members lists them as empty cases before its `default` (the `default` stays for values from files
  written by another version).
- `react-hooks/rules-of-hooks` and `react-hooks/exhaustive-deps` on the dashboard: a hook called conditionally breaks
  React's bookkeeping; a missing dependency leaves an effect working on stale values. Only these two of the plugin:
  its React Compiler rules are about a compiler Nexus does not use.
- Unused `eslint-disable` comments are errors, so a suppression cannot outlive its reason.

No `--cache`: ESLint's cache is per file, and with type information a change in one file (a function becoming async)
can create a finding in another, unchanged one. The whole run takes about 12 s.

**dependency-cruiser** (`.dependency-cruiser.cjs`) over `packages`, `apps` and `scripts`, type-only imports included
(a type pulled from the server is still a dependency on it):

- `protocol-not-to-apps`: the protocol is the shared contract and imports nothing from `apps/` or the CLI.
- `web-not-to-server`: the dashboard talks to the server over HTTP only.
- `cli-not-to-server`: agents never call the server; the CLI writes files through the protocol.
- `not-to-unresolvable`: an import that resolves to nothing.

What the code showed when the rules came (2026-11-15): no boundary crossed. The server, the CLI, the dashboard and the
scripts depend on the protocol and on nothing else of each other; nothing depends on the server. The dashboard imports
the protocol's index (mostly types) besides its Node-free subpaths (`times`, `attention`, …); that the subpaths it runs
stay free of Node is kept by the Vite build, not by a rule.

**Baselines.** Findings are fixed, not suppressed; one that cannot be fixed safely in the step (or whose fix would
change what the user sees) goes to the tool's own baseline with its reason: ESLint's `eslint-suppressions.json`
(`eslint --suppress-rule`; ESLint fails while an entry no longer matches, so the file can only shrink) and
dependency-cruiser's known violations (`depcruise-baseline`, then `--ignore-known` in the script). When the rules came
both were empty: the 20 findings (15 misused promises, 5 non-exhaustive switches) were fixed without a change in
behaviour, and the 686 floating promises were all `node:test` calls.

**knip** (`knip.json`) finds files nothing loads, exports nothing imports and dependencies nothing uses (or uses
without listing). It runs in the closing refactoring step and in maintenance queues, not as every step's check: an
export a step adds for the next step is not dead yet. The entries are what runs: `apps/server/src/main.ts` (the root `start` script), the CLI's
`bin`, the dashboard's `index.html` (through knip's Vite plugin), every `*.test.ts`, the scripts, and the seeds of
`scripts/capture`, which views files load by path. The protocol is checked with its entry exports included
(`includeEntryExports`): it is a package of this repository, not a published one, so an export of it nobody imports is
as dead as any other.

When it came (2026-11-15) it found 50 unused exports outside the protocol and 34 in it, and `yaml` used without being
listed (by the server's tests and the capture scripts). The unused exports were nearly all used inside their own
module: they lost `export`. What was not used at all was deleted: `clearDraft` (drafts.ts), `WorkChoice`
(stopwork.ts), the re-exports of `ActivityItem`, `StreamFacts` (claude.ts) and `ChatEntry` (orchestrator.ts), and
in the protocol `PROTOCOL_VERSION`, `EventOf`, `hasOwn`, `isClosingStep` and the `Approval` and `Withdrawal` type
aliases. No baseline was needed. `tsc --noUnusedLocals` would find about a hundred unused locals and imports more; not
switched on, a matter for a later queue.

**The project's checks.** `npm run lint` is a check of every step, also of queues approved before it existed, without
a new revision of each: a project setting, `defaults.checks`, puts its checks before every queue's own. It is
project-only, not global: a global `npm run lint` would break every project that is not on Node. A run fixes the list
when it starts (`checks` in run.yaml) instead of reading the setting at each step, so a running queue's steps all run
the same checks and its reviews judge them by the same list; the change comes with the queue's next start. A check
both lists name runs once (the queue need not drop its own `npm run lint`). Shown in the approval view, marked as the
project's, the way the project's stop conditions are.

## The dashboard's reads (queue RX1)

Every GET of the dashboard goes through one keyed query (`apps/web/src/query.ts`, used as `useQuery` from `api.ts`).
An answer belongs to the URL it was asked for: a new URL shows nothing until its own answer lands, never the previous
URL's, and a late answer for a URL no longer asked is dropped. Before, `useFetch` kept the previous URL's data, so
switching steps showed the first step's commits under the second until the reply landed (for good if it failed), and
the project's state had no guard against a late reply for the previously selected project. A failure is the query's
`error` (the data it had for the same URL stays), not swallowed. Queries asking the same URL at the same version share
one request; nothing is cached beyond that.

What is asked again comes from the live notifications, counted per scope (`Versions`): every message bumps `all`
(read at it: what spans projects, the digest, the usage, the server's state, remote access), a project's `changed` its
own counter (its state, orchestrator chat, conversations), and `changed` or `projects` the project list. A reconnect
may have missed anything: it bumps an epoch that is part of every project's version. Before, one global tick refetched
every read on any message from any project. Reads inside a step or queue still key on the project state's
`generated_at`, which moves only with that project.

Every request goes through `apps/web/src/http.ts` (queue RX2): `request` checks the status and rejects with an
`HttpError` (the server's reason, else the status text; its status; `reason`, the server's own only), `open` does the
same for a reply whose body the caller reads itself (a file). The typed endpoint functions are built on them, next to
the type they return until the API types have a module of their own. Before, five calls parsed whatever came back: an
error reply read as "no conversation yet" started a new one, a refused token rotation said "replaced". A user's action
keeps its busy and error state in `useAction` (over the tested `Action` in `action.ts`): busy until every run of it has
settled, the last error cleared when a run starts. Places whose state is a result line or a toast keep their own.

The browser check of the fix (a script, not a test: a development instance, a project whose two steps have their own
commits, every commits reply held back 700 ms, switching between the steps five times and sampling the page at every
frame): at the base commit 556 of 1101 samples showed the other step's commits; with the keyed query none did.

**The order of reads after a write (queue DF1).** A control that writes stays in progress until the page shows the
write's outcome: the write's answer is not that moment. The flicker the user saw on the approval, the review-level
pickers, the away switch and the settings came from three places, measured with a script sampling each control at
every frame on a development instance:

- The busy state ended with the write's answer, while what the control shows comes from the next read of the state,
  which landed 30–100 ms later on a small test project (more on a large one: a state rebuild there takes about
  120 ms). In between the control showed the old value again and could be clicked again: "Approve revision 1" came
  back after "Sending…", the level picker showed the old level, the away switch showed "off" for 175 ms after Turn on.
- A control whose value is the server's (the "queues running at once" select, "push on deploy") is controlled by the
  read: React set it back to the old value at once, until the read landed 450 ms later.
- A form built again from a read after its save (the global settings, keyed on a counter; the project's, keyed on its
  own keys) was built from the answer it still held, from before the save, and kept those values: the global form
  showed the old value after Save for good.

So `reloaded(...urls)` (page.ts) is the page's reload that resolves once the reads asked after the write have landed
(`Reloads` in query.ts: taken before the versions move, armed once App's effects have asked at the new versions, which
run after every child's). A control awaits it inside its action, after the write, and names the URLs it shows (the
project's state, `/api/server`), so it does not wait for a slow read of something else (`/api/server` takes 300–600 ms,
the git calls behind its version). The value asked for shows at once where the control is a choice (the levels, the
server's settings), dimmed and disabled while in progress, and goes back to the read value on a failure, with why. A
form keeps what it holds after a save, which is what was saved, instead of being built again from the reads as they
land one by one. A wait ends after ten seconds at most, so a read that hangs never holds a control.

An older answer never replaces a newer one: answers are ordered by the version they were asked at (a query's later ask
wins, whatever lands first), and the server answers a read made after its own write from the state after it (the
snapshot is rebuilt when `writeCount` has moved). The same script after the fix: no sample after the action showed the
earlier value again on any of the six controls.

## One place for the status rules (queue RX3)

When a run is going (holds its session), holds its checkout, counts toward the limit or has ended; when a step waits for
the user's review or the orchestrator's, is at work, or holds its queue in `waiting`; when a question is open: each is
one function in `@nexus/protocol/status-rules`, a module free of Node that the dashboard imports directly, the way it
imports `times`. Before, the run-state lists lived in `times.ts` and were also spelled out by hand in the engine, and
"open question" was written out in ten places (server, CLI, dashboard, the state derivation). A check of one status
(`status === "review"`) stays as it is: a rule is what combines several. The rules take a status as plain text too,
since the dashboard's pure helpers hold it so. The server's replies the dashboard reads are typed once in
`@nexus/protocol/api` (types only); the first typecheck with it found the dashboard's copy of "what a stopped step left"
missing the commits' `foreign` flag.

## The cost of rebuilding state (queue RX5)

Measured on 2026-11-15 on a copy of Nexus's own `.nexus` (70 queues, 214 steps, 55 sessions, 2,457 events, 13,735
activity lines, 2,211 chat lines, 14 MB): one `loadProjectState` takes 121-124 ms (median of 30, after a warm-up).
`changed()` in the server rebuilt the state five times on every change, before each of the planner, the orchestrator,
the engine and the attention watch, whether or not the decision before it had written anything: about 590 ms of
rebuilding per change notification, the decisions' own work not counted (a replay of its sequence on the copy, without
the server, which would have touched the worktrees the copy's queues name). Now the store counts the writes this process
makes (`writeCount`), and the server passes one snapshot on until the count moves; `changed()` forces only the first
rebuild (the change came from outside). With no decision writing, one rebuild per change: about 125 ms. A decision that
writes still gets the state its predecessors left. A write by another process between two decisions is seen at the next
change notification, which the watcher sends for it anyway. The rest of a rebuild is reading: a profile puts 17% in
`existsSync`, 15% in reading files and a quarter in parsing YAML; a cache of parsed files by modification time would be
the next step if 120 ms starts to hurt. The engine's own 15 rebuilds are in actions (a start, a resume, a review), not
on every change, and were left.

## The orchestrator's briefing and the command line (queue TQ4)

Claude Code gets the orchestrator's briefing as one argument (`--append-system-prompt`), and Windows limits a whole
command line to 32,767 characters. Adding the templates and recurring queues to the briefing first took it from about
29,700 to 32,700 characters, and every orchestrator start failed with `spawn ENAMETOOLONG` (89 tests at once). The
sentences were cut to about 1,100 characters; the orchestrator's command line is now about 31,300 characters in the
tests (whose temporary paths are longer than a real project's), so some 1,400 characters are left. The next addition
to the briefing should move it out of the command line (a file, if the CLI takes one: a small probe decides) rather than
shorten other sentences again.

Queue SH moved every Claude Code briefing (orchestrator, thinking partner, worker) out of the command line. Claude Code
2.1.323 takes `--append-system-prompt-file <path>`: its `--help` lists it only in passing (`--bare` names
`--append-system-prompt[-file]` among the ways to give context). Probed on 2026-11-15 with `haiku` in a temporary
directory, a file asking for the password ZEBRA-4471 when asked: `-p` answered "ZEBRA-4471", and so did a stream-json
session with `--session-id` and a Windows path to the file; without the file the model did not know it. Cost: about
$0.011 (three one-line turns). The server writes the briefing to the session's own `sessions/<id>/briefing.md` at
every start, overwriting the last (AgentHost; the path is no setting, so a start does not count as a change of them),
and the CLI reads it as it starts. The orchestrator's command line went from about 31,600 characters in the tests to
778; a test (command-line.test.ts) keeps every role's below 16,000 and says the length when it is not.

## The same commands on every shell tool (queue SH)

Claude Code on Windows has two shell tools, Bash and PowerShell, and Nexus allowed its commands only on Bash: an agent
whose `nexus` call went to PowerShell was refused, and its briefing told it not to work around a refusal in another
shell. Now one place (`apps/server/src/shell-rules.ts`) turns each role's command prefixes into a rule on every shell
tool, and the orchestrator, the thinking partners and the workers use it; the lists of commands did not change, and a
project's own `claude.allowed_tools` go on as they are. The three briefings ask for nexus and git commands on their own,
the name first (not `git -C <path>`), and allow one retry of the same command alone, not in another shell.

The rule's form, from Claude Code's permissions page ("PowerShell permission rules use the same shape as Bash rules";
"Claude Code parses the PowerShell AST and checks each command in a compound command independently"), probed on
2026-11-15 with Claude Code 2.1.323, `haiku`, `dontAsk`, `--tools PowerShell` and only `PowerShell(nexus:*)` and
`PowerShell(git show:*)` allowed, one session per command: `nexus status` and `git show` ran; `nexus status; git push`,
`nexus help | Out-File x.txt`, `nexus help > x.txt`, `nexus $(Remove-Item x.txt)`, `& { nexus status }` and
`git -C <path> show` were refused (x.txt stayed). A PowerShell rule on a machine without the tool (here switched off
with `CLAUDE_CODE_USE_POWERSHELL_TOOL=0`, as on Linux or macOS without `pwsh`) did no harm: no warning, no error, and
the Bash rule worked; so the rules are the same on every platform. Cost: about $0.013 (nine one-command sessions).

## Compacting a conversation (queue CC3)

Decided by the user on 2026-11-15 (docs/ideas/chat-context.md): the Ideas conversations get a **Compact** action; the
orchestrator does not (it goes on in a fresh session with a summary, see "The orchestrator's context care"). A thinking
partner's material is the conversation itself, so the runtime's own compaction, which keeps the session, suits it.

Probed on 2026-11-15 with Claude Code 2.1.323 (`haiku`) and Codex 0.167.2 (`gpt-6-luna`), each in a temporary directory:
a turn ("remember PELICAN"), the compaction, then a turn asking for the word. Cost: about $0.01 of Claude usage (three
short turns; the first turn and the compaction together $0.0056) and three short Codex turns on the ChatGPT subscription (about 17k input
tokens each, most of them cached).

- **Claude Code** takes `/compact` as a user message on its stream-json input and runs it as a turn of its own: a
  system `status` "compacting", then `init`, a `compact_boundary` with `compact_metadata` (`trigger: manual`,
  `pre_tokens` 32,692, `post_tokens` 9,892, `duration_ms` 3,690), the summary replayed as a user message
  (`isReplay`), "<local-command-stdout>Compacted </local-command-stdout>", and a `result` `success` with an empty
  `result` and no usage. About 3.7 s. The next turn still knew the word.
- **Codex** has `thread/compact/start` (`{ threadId }`, answered `{}` at once), which runs as a turn of its own:
  `turn/started`, an item of type `contextCompaction` (started, completed), `turn/completed` `completed`. About 1.7 s.
  It sends no token figures for it, and `thread/compacted` is deprecated (not sent). The next turn still knew the word.

Decisions, building it:

- Both runtimes offer it (`COMPACTS` in agent.ts); a runtime that cannot gets no Compact (the conversation view's
  `compact` is false, and a request is refused), which a test checks with a stand-in.
- The compaction is a turn like any: refused while the partner answers, never put into a running turn; the process
  (`AgentProcess.compact`) emits `compacted` when the runtime says it is done, with Claude Code's tokens before and
  after, and the context fill takes the after figure.
- The chat gets one Nexus line once it is done ("The conversation's context was compacted: 32,692 tokens of context
  became 9,892", or without the figures on Codex); a compaction that ended without it gets an error line. The chat
  itself keeps every message: compacting changes only what the partner holds.
- A conversation without a reply yet has nothing to compact: refused.
- In the ⋯ menu, beside "Hand to orchestrator", with a confirmation that says what it does (details it leaves out are
  no longer in the partner's context).

## Layout faults (queue PL)

The user decided on 2026-11-15 that layout faults are part of the dashboard's design work, checked on the designs and
the pictures rather than found in use: a dependency line running through a queue's box (seen in the built plan view:
ST2 → ST3 crossed RX's box and read as a chain), boxes overlapping, and text cut short ("Statisztik…").

`scripts/layout-faults.ts` measures them on a page: a mockup file (served with its folder over http, its query kept)
or a development instance's dashboard (`--click` opens the view, e.g. "All queues of Nexus"). The page side
(`collector` in `scripts/capture/faults.ts`) gathers only geometry, so the judging is plain functions with a unit test:

- **Boxes** are `[data-plan-card], [data-box]`; **lines** `[data-edge]` (on the dashboard:
  `section[aria-label='The plan'] svg path`), each sampled every 2 px with `getPointAtLength` and the shape's screen
  matrix. A line with a point inside a box shrunk by 1 px is a fault, so a line ending on a box's edge is not.
- **Text cut short**: an element whose content is wider than it (`scrollWidth > clientWidth`), or taller where its
  overflow is hidden; only the innermost of a chain of ancestors. Found building it: the two are whole pixels, so a
  title 0.2 px too wide is cut with an ellipsis yet equal by them (the plan's "Small fixes from the user's notes of 14
  November" on the phone, 310.1 px in 309.9). The element's own text nodes are measured too, with a Range against
  its content box; its children's are not, since a child may sit in the padding on purpose (the ↩ of a chip, -2 px).
- **Crossings** of two lines are counted but are no fault: fewer is easier to read, and a layout can compare them.

On the plan view of the step's base commit (seed `scripts/capture/seed-plan-nexus.ts`, Nexus's own plan of 15 queues)
it found 6 lines through boxes and 15 titles or reasons cut short at 1440 px, and 9 cut texts at 390 px; on the PL1
mockups (`docs/ux/mockups/22-plan-layout.html`, variants A and B) none.

### The plan view's layout A (queue PB)

The user chose layout A (docs/ux/plan-view-options.md). It is built in `apps/web/src/plan.ts` as a pure function,
`drawPlan(layout, heights, width)`, with no library; `components/Plan.tsx` renders the cards at the column width,
measures their heights, and places them and the lines from the drawing. Decisions and findings:

- The order and the columns are `planLayout`'s, unchanged: the drawing only stacks each column from the top and adds
  gaps, so a queue is where it was.
- A gap goes before the first queue of its column that the line would otherwise run beside (the line's height in the
  column before is above that queue's bottom). On Nexus's own plan this reproduces the mockup's hand-placed gaps
  exactly (MX > RA at the top of Next and Then, ST2 > ST3 before CH, IO > DG before ST3).
- Ports are 10 px apart (less on a short card), sorted by where each line goes or comes from. Between two columns a
  line arriving at the height another leaves at would run along it: the arriving end moves within its card or gap
  (2 px steps) until it is 3 px from every other. Each line that changes height then gets a vertical track of its own
  in the gap between the columns (interval colouring, the tracks spread evenly).
- The arrowhead's tip is the line's end, a pixel before the card (`refX` at the tip, `userSpaceOnUse`): the old marker
  reached into the card.
- Unit tests check Nexus's plan at several widths and card heights and 300 random plans: no stretch inside a card, no
  two lines along each other, no slanted stretch, the order planLayout's.
- Measured with `scripts/layout-faults.ts` on a development instance with `seed-plan-nexus.ts`, the boxes and lines
  limited to `section[aria-label='The plan']`: 0 lines through boxes, 0 overlaps and no text cut short in the plan at
  1440 and 390 px (5 crossings at 1440, the mockup 3). Two cut texts outside the plan are older: the rail's "Running in
  Nexus" title at 1440 and the sessions table at 390.
- A line is clicked through a wider transparent band along it (12 px, `pointer-events: stroke`), drawn after the
  lines; the measured lines are the drawn ones (`svg path[data-edge]`), since the bands would count as crossings.
  The line's details open under the card it comes from, and the plan grows to hold them (the plan scrolls sideways,
  so anything below its box would be cut). On the phone an "after" chip opens them under the card, scrolled into view
  clear of the bottom bar. Dragging is the desktop's.
- The drop target splits only while a queue is dragged over it, into "instead" (a move, every dependency it replaces
  named, done ones too) and "also" (offered only to a queue with a place of its own that does not wait for the
  target already). A drop elsewhere on the card is a move, as before.
- The capture tool drags as the plan view takes it: HTML5 drag events dispatched in the page with one DataTransfer
  (`scripts/capture/drag.ts`), since a headless window cannot be driven to a native drag; React's handlers take them
  as a user's. Its click dispatches the event where an element has no `click()` (an SVG shape).

## Resuming worktree cleanup (queue CW1)

PT exposed a gap between two individually reasonable checks: cleanup checked a clean, merged worktree, then
`git worktree remove`/recursive removal could remove `.git` or its registration before failing on another file.
The next Clean up could only report an unreadable Git status. A successful merge does not prove that the remaining
folder still belongs to that cleanup, nor that someone has not written new work into it.

The server now saves a versioned `cleanup_proof` in the queue's existing `git.yaml` **before deletion**. That file
already has an atomic writer and belongs to the server; a second journal writer or a marker inside the directory
being deleted would weaken the contract. A separate top-level field also survives the existing `cleanup.waiting`
and merge-wait patches in `merger.ts`, and step-round updates in `gitinfo.ts`. No migration invents evidence for old
queues. The proof lasts until worktree removal, registration cleanup and branch deletion all succeed and `cleaned`
is recorded together with clearing the proof.

The proof binds the canonical target and Git common directory, filesystem identities (device, file ID and birth
time), the merged tip and destination ref, and a manifest of all entries. Ignored files and empty directories are
included: Git alone cannot detect foreign additions to node_modules after cleanup starts. Regular-file bytes and
link text are hashed; file timestamps and mode also detect rewrites, while directory timestamps are excluded
because deleting children changes them. Junctions and symlinks are recorded as links, never traversed. An unreadable
entry or unavailable identity refuses cleanup. This costs a full filesystem walk and content hashing, and the
manifest makes git.yaml larger while cleanup is pending; that is the cost of proving an unchanged remainder even
after Git metadata has vanished. A mere boolean "cleanup started" or a root marker would not prove content safety.

Deletion uses unlink and nonrecursive rmdir instead of Git's initial recursive deletion or a recursive Node
fallback. Each attempt checks the whole remaining tree against the proof before removing anything, then checks
each entry and its parent identities immediately before deletion. Only an unchanged subset is accepted. A new
child arriving during removal prevents rmdir; a replacement or changed file prevents unlink at the next check.
This is recovery from interrupted local operations, not an OS transaction against a hostile process racing the
final filesystem syscall; users must not keep editing a worktree they are deleting. The queue's shared merge lock
serializes the dashboard and server callers. No running queue is eligible. Removal retries transient Windows
errors up to eight times with increasing 250 ms delays, rechecking the proof on each attempt. A fake-runtime
survey test exposed a short EBUSY while its exiting worker still held the empty directory; keeping the former
bounded retry behavior handles that without treating a lasting lock as success. Once the directory is gone,
`git worktree remove` removes only its registration; a global prune would affect unrelated missing worktrees.

A missing target is an empty subset. A missing branch can complete only when the recorded tip is still in the
recorded destination; a changed branch is refused. The automatic merger checks for pending cleanup before judging
the branch, so a restart after branch deletion can finish the final record. Completed cleanup is idempotent and
does not touch a later folder or branch at the old names. Surveys retain their existing manual retry after a
recorded cleanup wait.

Real temporary Git repositories reproduce partial removal with deterministic EPERM injection, both with and
without worktree registration, then reload the store and construct a new Merger. Tests cover content and identity
changes, ignored additions, branch/base movement, missing folders, deletion before/after branch removal, Windows
long paths, legacy refusal and preservation of the merged commit. The injected error does not identify the cause
of PT's original EPERM; lock/permission investigation remains separate. No real PT/WK remainder or live server was
used. The legacy recovery path preserves the entire remainder outside its old path and requires independent
inspection before discarding it; missing branch evidence is restored only from a verified tip, never guessed.

### Worktree handle investigation: negative reproduction (queue WH1)

WH1 initially attributed the PT remainder's handle to the live Nexus server. The user's subsequent exact-path
screenshot corrected that attribution: `codex-command-runner-0.167.2.exe`, PID 364580, held a File handle named
`C:\Code\Nexus.worktrees\PT`. The server's earlier matches referred to `.nexus/queues/PT/review`, not the worktree.
The image establishes ownership at that observation, not the creating session, job membership or safe termination
of a later process at that PID. Neither WH1 nor WH2 changed that process, the live checkout or the real PT/WK folders.

A Windows probe used separate temporary Git repositories and NEXUS_HOME, fake Claude/Codex runtime paths, and
development servers on ports 50805 and 62890. The successful extended probe ran a fake Claude worker through its
work step and integration, accepted reviews with the existing fake reviewer, then called the development server's
cleanup route. Its worktree was removed while the same server continued answering requests. A separate finished,
merged queue was also removed. After restarting only that development server, both a partial remainder (without
`.git`) and an empty remainder with CW cleanup proofs were removed. An empty legacy remainder without a proof was
refused with HTTP 409 and preserved. The partial-removal fixtures deliberately injected EPERM before startup;
that injection tests recovery, not the origin of a persistent Windows lock.

A diagnostic preload in those server processes wrapped `fs.watch`, recording PID, path, creation stack and close
events. The observed paths were the temporary registry file and the project's `.nexus` tree, including newly
created worker sessions and queues; none pointed into either worktree directory. `main.ts`'s `watchProject` watches
the store directory, `dropProject` closes its watcher, and the handover release awaits watcher closure. This probe
therefore does not justify closing a project watcher when one queue ends: other queues still need it. The inspected
file route uses `files.ts`'s `head` with a finally-close and `Readable.toWeb(createReadStream(...))`; `gitinfo.ts` runs
synchronous child commands with explicit cwd. The probe did not exercise interrupted HTTP file streams or enumerate
native handles, so it does not exonerate every file-serving path or establish the historical PT handle's origin.

WH1 stopped without a production fix or a claimed regression test: no before-fix lasting lock was reproduced.
The review artifacts retain the standalone probe and its PID-tagged observations. The subsequent image supplies
the missing handle name/type; the creating session and events preceding the lasting lock remain unestablished.
A process match alone is insufficient for choosing a fix.
The real remainder stays untouched until that evidence is available. Any later user-controlled maintenance must
first let active work finish; legacy recovery still preserves and independently inspects the remainder as described
above, and must never fabricate a CW proof or force-close a handle.

### A Codex cleanup refusal while termination is completing (queue WH2)

The separate WH1 runtime log contains `Access is denied` at 2026-11-16T17:23:50.655Z, followed by the worker's
exit. That old message did not name a Windows operation. WH2 reproduced the same cleanup symptom with installed
Codex 0.167.2 in temporary directories, under a copy of Nexus's Windows worker host with diagnostic logging.
Three short `gpt-6-luna` turns each ran only `Write-Output`: first reproduction, operation-level diagnosis, then
verification of the bounded-wait change. MCP servers, plugins, apps and sub-agents were disabled, the sandbox
remained workspace-write with approval never, and no administrator rights or sandbox weakening were used. A
model-free `command/exec` attempt cleaned up before the boundary and did not reproduce the unified-exec case.

The diagnostic trace locates the reproduced refusal in `worker-job.cs`, `End`: OpenProcess and IsProcessInJob
succeeded for an owned job member, TerminateProcess returned false with error 5, and WaitForSingleObject(handle, 0)
returned 258 (timeout). In the verification trace the same sequence was followed by a wait on the **same retained
handle**, which returned 0 (signaled); cleanup acknowledged success and the runtime remained available. The old
code threw before giving that pending exit the two seconds it already allowed after a successful TerminateProcess.
This is consistent with [Windows' asynchronous termination contract](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-terminateprocess).
The trace establishes a Codex-created job member, not which executable that member was; it does not identify the
historical PT process. A worktree deletion attempted while the host/runtime still used it as cwd was EBUSY, which
alone cannot attribute its handle to a runner. After the owned host exited, each probe's worktree was removable.

`End` now captures the termination error immediately and awaits actual exit on that handle for the existing
two-second deadline (`AwaitExit`). Only a signaled handle counts as success; an error leaving the process alive
still fails with the original Windows code, and a successful request that never finishes still times out.
OpenProcess and IsProcessInJob failures now name their operation. Membership checks, non-inheritable job ownership,
kill-on-close, the engine's cleanup barrier and CW's deletion proof checks are unchanged. There is no PID/name-based
fallback, privilege change or new protocol message. The existing `F` error payload simply has more useful text.

The native regression replays the observed error-5 result against a real retained process handle and a real empty
directory held as its cwd, then permits exit; another case leaves it alive and checks failure. This deterministic
test models the OS return sequence; it does not pretend a scheduling race will recur on demand. A development-server
test with fake Codex uses real helpers and Windows jobs, including a helper that adds a deny-PROCESS_TERMINATE ACE
to **its own** DACL. That distinct, genuine OpenProcess refusal halts the queue before the next step, ends its whole
worker job and releases its directory; Resume then completes. Normal step cleanup, immediate stop/resume, deletion
of the completed temporary worktrees while the server lives, and another worker retaining its directory are checked.
The existing worker tests cover reported stop, Stop now, shutdown, crash and same-runtime continuation too.

One further, explicitly approved turn tested natural app-server exit separately from Nexus cleanup. Its temporary
host kept the non-inheritable kill-on-close job open after the runtime exited, and used a cwd **outside** the empty
worktree. Before sending EOF to app-server, it enumerated only its job, opened query/synchronize handles, verified
membership on those handles, and recorded full executable paths and creation times. Those retained handles pinned
identity across exit. The captured processes were codex.exe, codex-code-mode-host.exe, codex-computer-use.exe and
two conhost.exe instances; no codex-command-runner was still present at that snapshot after the shell command.
All five handles were unsignaled before EOF and signaled after app-server's exit code 0. The worktree changed from
EBUSY to removable **while the guard still lived, before its cleanup**. A second snapshot after two seconds had no
new job member and all retained handles remained signaled. The guard then completed cleanup and exited. Its raw
RPC trace records one successful 303 ms unified-exec PowerShell command. This observes graceful EOF after a short
command, not abrupt app-server failure or a command runner captured while still executing.

The historical PT runner's continued existence after its owning session remains unexplained: the isolated probes
did not leave a helper alive after full job shutdown, even before this change, and the final natural-exit probe
also released the directory. The proven fix addresses a premature cleanup failure, not a proven source of that
historical orphan. No further runtime probes are implied by this finding. Existing session/version records must
first establish which launcher and ownership mechanism created that runner; a future failure needs observation
while the owned runner exists, not selection by an old PID. Legacy PT recovery still requires user-controlled
maintenance after active work finishes and preservation/inspection of the remainder; no retrospective cleanup
proof may be fabricated and no historical PID may be used for termination.

The four real turns reported 89,454 input tokens (44,032 cached) and 274 output tokens, 89,728 total. On the ChatGPT
subscription no dollar charge was reported. The [published GPT-6 Luna API rates](https://developers.openai.com/api/docs/models/gpt-6-luna)
give an API-equivalent estimate of $0.00511952, not a measured bill ($0.00126578 for the final lifetime probe).
The real turns were necessary because plain helpers cannot model Codex's internal teardown ordering, and the
model-free command/exec call did not reproduce it. All other probes and automated tests used no model.

## Hono Node adapter 2.x and the public SPA fallback (queue DU1)

The server declares `@hono/node-server ^2.1.8`, locked to 2.1.8, the stable npm `latest` on 2026-11-16.
[GHSA-rmxm-3fg6-px4f](https://github.com/advisories/GHSA-rmxm-3fg6-px4f) lists 2.1.3 as the first fix for
`serveStatic` decoding paths a second time. 2.1.8 also includes the later `allowPercentInPath` fix; Nexus does not
enable that option. The [1.19.19 release](https://github.com/honojs/node-server/releases/tag/v1.19.19) describes a
backport, although the advisory still lists that version as affected. Moving to the maintained 2.x line removes
that audit ambiguity. Only this adapter's declaration and lock entry changed; Hono stays at 4.13.18.

The [2.0.0 migration](https://github.com/honojs/node-server/releases/tag/v2.0.0) drops Node 18 and the Vercel adapter.
Nexus already requires Node >=24 and does not use Vercel. `serve`, `HttpBindings`, `serveStatic` and the returned
Node HTTP server remain compatible: the adapter upgrade needed no `main.ts` adjustment, including its `ws` upgrade
listener. Checks ran on Windows with Node 26.13.1. HTTP tests use a temporary home, a free loopback port above 4317 and fake runtimes.
They cover API reads/writes, cookies, Origin/JSON guards, WebSocket acceptance/refusal and, when the dashboard is
built, the actual assets, SPA entry and public installation files. Build first to run the static subtest; it skips
in source-only checkouts. Encoded, repeated and malformed percent escapes cannot bypass the guard on protected
API/asset paths in these tests.

**Policy gap found in DU1, closed by the approved DU1F:** `/icons/` is public. When its static handler found
no file (including rejected encodings), the unrestricted `app.get("*", serveStatic({ path: index }))` returned the
SPA shell without another authorization check. `/icons/missing.png`, `/icons/%252e%252e/index.html` and
`/icons/%%32%65%%32%65/index.html` returned 200 with `index.html`; a double-encoded request aimed at a JS asset also
got the shell, not the JS. An isolated comparison reproduced the shell response with both 1.19.19 and 2.1.8.
DU1 recorded this limitation and stopped for a separate approval; its dependency upgrade is retained.

DU1F moves the static routes into `web-static.ts`, sharing `isPublicFile` with the access guard. The public set is
unchanged. When `serveStatic` rejects or cannot find a public file, the request terminates in 404 text/plain
(`404 Not Found`) before the SPA fallback. This holds for local and signed-in requests too. Nexus
does not decode again: it uses the same routed path at both boundaries and keeps the adapter's default rejection
of residual percent encodings. Paths normalized into protected routes still meet the original access guard first;
their unauthenticated 302/401 responses are preserved. Login, API writes and WebSocket authorization are unchanged.

The HTTP regression replaces DU1's explicit 200/SPA baseline with 404 assertions for the same raw requests, then
adds repeated encodings, encoded separators, malformed escapes and an API target. It checks MIME types and exact
response bytes in remote, signed-in and local modes, with the real dashboard built first. A separate temporary web
root mounts the same production static routes through the Node adapter: it has an index, a JS asset, an icon and an
outside-root sentinel, but no manifest or service worker. Their missing-file responses are proven without deleting
or changing the real build. Both test servers close before the tests finish.

The post-upgrade npm audit no longer reports the Hono advisory. It still reports GHSA-g3hv-75wg-m249 through
`typescript-eslint -> @typescript-eslint/typescript-estree -> minimatch 10.2.6`: seven moderate affected package
entries from one underlying advisory, not seven independent vulnerabilities. That dependency change is outside DU1.

## The lint toolchain's minimatch update (queue DU2)

On 2026-11-16, stable [typescript-eslint 8.73.0](https://github.com/typescript-eslint/typescript-eslint/releases/tag/v8.73.0)
became available with `@typescript-eslint/typescript-estree` depending on `minimatch ^11.0.1`. Nexus upgrades from
8.72.2 to 8.73.0 and locks that minimatch to 11.0.8. This is the upstream fix, so no override is needed.
[GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249) lists versions 7 through 11.0.0 as affected.
ESLint's independent minimatch 3.1.5 branch is unchanged, as are the lint configuration and enabled rules. The lock
changes only the eleven synchronized TypeScript ESLint packages, their minimatch and its new nonrecursive matcher.

The actual estree call is `minimatch(relativePath, pattern, { dot: true })`, used for `allowDefaultProject` matching.
Nexus uses `projectService: true` without that allowance; the default path uses TypeScript's project service.
The [minimatch 11 changelog](https://raw.githubusercontent.com/isaacs/minimatch/main/changelog.md) removes `makeRe`,
`regexp`, `AST` and internal methods, and replaces regexp entries in `Minimatch.set` with matcher objects. Estree
uses none of those APIs. Empty trailing path segments no longer match optional/zero-repeat extglobs; those are
directory forms, not the file paths this call receives. Changes to globstar/partial matching and Windows root/UNC
normalization do not change the tested relative-file cases. The new matcher requires Node 20 or >=22, within
Nexus's >=24 requirement. The new optional TypeScript-native backend in 8.73.0 is not enabled or installed.

`scripts/test/lint-dependencies.test.ts` checks the dependency resolved from estree rather than ESLint's 3.x copy.
Small examples cover dot files/directories, relative and Windows-separated paths, single-level glob boundaries,
braces and extglobs. The same cases pass with minimatch 10.2.6 and 11.0.8. A temporary TypeScript project verifies
typed parsing and the actual default-project allowance/rejections (including overly broad patterns); the unchanged
repository ESLint configuration recognizes TS/TSX files and still reports a deliberately unawaited promise as an
error. The final lockfile is also installed with `npm ci` in a separate temporary checkout, where the compatibility
tests and dependency tree are checked again. No access, HTTP or agent protocol changes accompany this update.

## Ideas relationships: persisted corrections (IC2)

The accepted IC1 contract uses origin-level overlays in `idea-matches.yaml`, with append-only logical action
history and immutable legacy matches. A correction snapshots known identities and keeps inactive records, so a
missing queue/date does not erase the explanation. A replace and its undo each write one complete file. Source
overrides are explicit operations; neither a rejected match nor any idea action edits an approved queue.

A revision covers both the stored decisions and current note/queue inputs. The server holds an exclusive file
lock across re-read, comparison and atomic replacement; request IDs retrieve saved results before revision checks.
Undo checks touched origin IDs across later history, so unrelated actions do not block it and a newer decision
cannot be silently reversed. A crash-left lock fails closed; no time-based lock stealing. This preserves the
one-writer contract across overlapping server requests and accidental overlapping server processes.

Outcome excerpts quote current accepted StepView rounds or the recorded queue-report summary, with source hashes,
event/round/commit links, sampling counts and missing-evidence warnings. Old reported rounds remain explicitly
historical; they never supply current acceptance. Closing-only fallback recognizes reused closing summaries and
explicit closing labels; it makes no semantic promise about arbitrary report prose. No model runs when a page opens.
The expanded manager/status/chat UI remains in IC3–IC5; IC2 only adapts the existing matching client's save tokens.

IC2 review found two places where an old observation could appear current. Pending relationship snapshots now
stand apart from freshly derived suggestion evidence, and the revision includes that live evidence even for a
previously decided edge. Stored decisions keep their original evidence; missing references retain historical
identity with diagnostics. Queue report excerpts likewise keep their immutable event identity. The CLI records
the exact registered report bytes' SHA-256 in that event; reads compare the file to it and explicitly distinguish
current, outdated, unverifiable legacy and missing sources. Hashing only today's file cannot establish that an old
summary belongs to it, so no historical fingerprint is invented at read time.

## Ideas corrections: design boundary (IC1)

[The IC1 design](ux/ideas-corrections.md) specifies origin-specific relationship corrections,
separate implementation confirmation, precedence over legacy note markers, and scoped conversation/handoff
actions. The server remains the only writer of Nexus decisions; the partner remains the only writer of notes.
The current `built` derivation is work completion, not evidence that a whole dated decision is implemented or
deployed. The user chose a new conversation on each Chat about this action. IC1 records the design and review
fixtures only; subsequent IC steps implement the approved contract and update the protocol with their changes.

## Open questions

1. **The local HTTP gap.** Any agent with a free shell on this machine (Codex's sandbox leaves loopback open) can
   send the dashboard's writes with a forged `Origin` ("An orchestrator on Codex can be kept to its drafts"). The
   orchestrator on Codex is built (queue OC), but the user does not switch to it until this is closed, in a queue of
   its own.

## Ideas dispositions and assessment validity (IC3)

The server owns `idea-statuses.yaml`; the partner remains the sole note writer. A dated entry has three independent
axes: effective disposition, explicit user assessment and linked work. The original `built` compatibility field
never becomes a full assessment. UI dispositions override their observed legacy markers; later marker edits are
conflicts, with reasoned keep/adopt actions. Restoring the first override restores today's legacy fallback.

Assessments retain complete normalized content and a deterministic work/evidence snapshot. Snapshot equality is
intentionally stricter than human semantic equality. Source origins and link reasons do not enter the effective
edge set. The existing queue/step derivation supplies acceptance, including provisional reviews, skipped work,
reopened results and integration caveats; Ideas does not invent another acceptance state. A full assessment is
blocked by unfinished work, missing targets or required merge/review, while cancellation and skipped steps require
an explicit coverage explanation. No work at all requires an external evidence reference.

Invalidation must survive a revert. The server records observed divergence for every assessment in current records
and history, including ones temporarily revoked or suspended; undo cannot revive an assessment invalidated while
it was hidden. Notes are watched with symlink following disabled after boundary validation. Reconciliation also runs
on startup and before reads, and synchronously around link writes so quick remove/undo cannot hide the changed edge.
Only observed states can be retained: edits reverted entirely while the server is offline leave no recoverable
intermediate state. Source observations preserve missing queue identity without deciding a match. Status operations
have revision/request-ID checks and compensating before/after history; they never alter a queue, run or start plan.

The read-only `nexus ideas status` command gives agents the same effective state and conflicts as the API. The
partner's and orchestrator's instructions now combine that state with dated note content. IC4 owns the controls,
labels and filters; IC5 owns the new idea conversation and direct handoff workflow.

## Ideas correction controls (IC4)

The overview and entry consume the same server `effective` state, never interpreting legacy `built` as a user
assessment. The note roll-up and Needs attention count come from the server; the pure filter helper selects those
same dated entries. Open sits below Summary and above Decided, with Related work collapsed. Work excerpts retain
their scope and report freshness; provenance and historical evidence are secondary details. Manage links remains
available independently of pending counts and even before the first match decision.

Relationship forms select an origin, not a whole queue, and preview the exact date being changed. Queue and dated
decision pickers are searchable and show the complete selected text. Status forms act on one complete date. Each
draft pins the read revision, keeps its fields across errors and explicit refresh, and retries an uncertain write
with the same request ID. Saving waits for the refreshed Ideas read; failure to read after an acknowledged write
is labelled separately from a failed write. Undo uses the API's compensating actions with its concurrency checks.

The note and dated status form are navigation layers; Back from the manager or a work/report returns to the note.
The overview's filter, search and scroll position survive those transitions and reload in this browser session.
The note header opts into wrapping and keeps its close control inside its measured bounds. Titles, questions and
action labels are not clamped. The capture fixture clears only its own stored list position for reproducible views.

`scripts/verify-ideas-ui.ts` drives the actual dashboard with the capture browser and layout-faults engine against
temporary projects. It covers the correction guide, atomic replacement/undo, accepted/rejected undo, zero-pending
reopening, a project never matched, an uncertain response after a committed save, date-specific confirmation and
stale drafts after a concurrent note change. It verifies all 12 agreed view/size combinations and initial Open
visibility. The UI keeps chat/handoff for IC5, including the accepted always-new-chat rule.

The overview's replacement arrow, like the status form's current target, reads `effective.replacement` only while
`effective.disposition` is `replaced`. The legacy `replaced_by` field is source metadata, never a fallback for a
current target. Original markers remain in the explicitly historical/conflict-labelled details; the API's dated
decision content already excludes these disposition markers.
`scripts/verify-idea-replacements.ts` checks the rendered row and assessment after UI Reopen, B-to-C replacement,
and replacement without a note marker, including reload and Back. All three dates have no linked queues.

### Idea conversations and direct handoffs (IC5)

The accepted always-new-chat choice in IC1 supersedes the queue's earlier latest-chat wording. IC5 round 2 narrows
the UI to one note-level Chat about this / Hand to orchestrator pair, with neither action on dated entries or
their operation menus. New chats cover the entire note: Summary, all Decided dates with current states and
relationships, and undecided Open/Ideas. Date selection belongs only to the handoff preview. Historical dated
chats keep their scope and readable history; dated status controls remain unchanged. A stable creation
request ID distinguishes a retry from a deliberate new click. The session's topic is a compatible union: the old
queue/step link or an exact idea file/optional date. Context is supplied only on a real message and refreshed by
its content/status/provenance fingerprint. The existing own model/effort selection is preserved; CM owns further
model-choice UI. Archived and missing-source conversations remain readable and cannot silently change scope.

Direct handoff uses no partner/model summary. The server composes a preview from one note and explicit dates,
with effective state and undecided sections separated. Terminal or fully confirmed entries are context only;
requesting new work first requires an explicit Reopen. The handoff's intent is saved before enqueueing; its stable
ID joins an immutable snapshot, existing orchestrator inbox entry and visible chat row. Retrying can complete a
partially persisted delivery without appending another inbox message, even across session switches/restarts.
Delivery means queued and visible, not read or executed. Pending/failed attempts stay visible and retryable.
There is no distributed exactly-once claim about model processing: the existing runtime/inbox lifecycle owns
turn delivery, while this feature guarantees idempotent enqueue and visible delivery identity.

The server alone writes handoff records, session metadata, inbox and chat rows. It never writes a partner's events
or notes. A delivery contributes historical handover evidence without replacing later user corrections. The
preview fingerprint is deliberately distinct from implementation confirmation: Open/Summary changes refresh the
preview/context, while the IC3 confirmation rule remains unchanged. New server messages and briefings repeat the
no-approval/no-start/no-plan-change boundary. Note/chat/handoff navigation preserves the note and overview's
position on Back; uncertain creation/delivery requests retain their IDs through browser reload.

`scripts/verify-ideas-onward.ts` checks all nine capture/layout scenes and the browser workflows against isolated
fake-runtime projects: direct handoff without a chat, exact dates/full-date exclusion, stale preview, uncertain
delivery and creation responses, reload/restart idempotence, deliberately new chats, changed/missing source,
and Back with the overview filter preserved. History assertions wait for the asynchronously loaded receipt,
not merely the mounted details summary. Exact preformatted payloads use `white-space: break-spaces` so preserved
trailing spaces cannot hang outside the box, including when details are expanded.

IC5 validation exposed existing timing-sensitive tests at default file concurrency on a 16-thread host; the
same cases passed unchanged in isolation. Full-suite verification uses the normal lock runner and complete
test-file set with bounded file concurrency:
`node scripts/test-lock.ts --test --test-concurrency=4 packages/*/test/*.test.ts apps/*/test/*.test.ts scripts/test/*.test.ts`.
All 1,237 tests passed without skips; process inspection confirms four direct test-file children.
The Node option must precede file patterns:
appending it with `npm test -- --test-concurrency=4` did not apply the limit. No assertions, per-test timeouts,
internal concurrency scenarios or repository runner configuration change; review reports retain the failed
attempts alongside the final verification result.

### Question navigation identity (QA1 finding)

Waiting-list identity includes a question's qid, but the baseline navigation address carries only project,
queue and step. StepDetail consequently chooses the first open question for its main answer form, even
after the user clicked another question. Existing qid-based React and draft keys do not repair that earlier
loss of identity. The API and inbox route the qid they receive correctly. Preserve explicit question identity
through navigation and refresh; a generic step link can keep its first-open default. Do not infer current
question state from historical prose. The original incident, isolated browser traces, separate desktop-option
gap and smallest correction are documented in [the QA1 reproduction](qa/question-target-reproduction.md).


### Preserving the selected question (QA2)

An optional qid is now part of the dashboard address, waiting position and sequential
navigation. StepDetail resolves it within the selected step's questions. Explicit
question links take precedence over step review controls, show the selected question
first, and retain an answered/withdrawn target or show an unavailable message. Only
plain step links keep the first-open fallback. A normal answer leaves the selected
question visible with its recorded answer and the other questions still present;
the explicitly requested sequential mode advances to the next distinct waiting item.

Answer components and option handoffs are scoped by project and qid. In-flight sends
capture their own text, option and continuation flag; existing draft handling retains
words edited during a send or a failed save. The desktop action bar labels the question
it answers. Desktop option buttons remain QA3; requiring all answers before work
resumes remains QA4. No API, answer event or inbox contract changes in QA2, including
the existing support for additional answers to an answered question.

The committed `scripts/question-target.mjs` preserves QA1's clicked-BRAVO regression.
After building the dashboard, run it with an optional output directory outside the
checkout. It uses temporary projects, fake-runtime server configuration and external
fixture workers, with real browser requests. It checks all three widths, reload and
Back, project isolation, reordered/new questions, failed/slow saves, another browser
answering the target, withdrawal, missing targets, sequential navigation and the
desktop action bar. Request, answer event and worker inbox identities are asserted.
No model is called; answer delivery code has not changed.

The initial QA2 probe stopped after three harness failures; its source and observations
remain review history. On user-authorized resumption, the second-page scenario uses
an actual second browser instead of a Node POST without Origin. The server's existing
same-origin write restriction remains intact. A real browser also preserves the
additional-answer contract when its first page is stale.

### Clickable question answers on every layout (QA3)

The phone sheet and every desktop question's card share `useAnswer` and `AnswerFields`.
Each form has one optional choice, optional words and one explicit send action, bound to its project and qid.
Recommendations never choose for the user. Choosing again clears the choice; arrow keys, Home and End move it.
The choice stays in memory while that form is mounted; words keep the existing per-question persisted draft.
A reload restores words without inventing a selection. Failed saves preserve both; a synchronous submit guard
prevents repeated clicks or keys from sending twice before the busy state renders. The option cannot change
during a send; words edited during it remain a draft. All forms post only to the question-answer endpoint.

In QA3 round 2 the user replaced the desktop answer bar with complete per-question cards. An explicit question
link puts that card first and scrolls it into view; the phone keeps its sheet and bottom Answer action. Closed
questions keep their option lists. Labels inside option buttons wrap so that long options remain readable.

The same round explicitly brought the all-questions prerequisite into this step: partial answers are saved and
routed durably, but the engine holds their delivery, ordinary messages and subsequent work while any question for
the current queue and step is open or escalated. The barrier is scoped by queue and step rather than session,
so it survives a session change without blocking another queue. The last answer releases accumulated answers
together in one turn. State derivation also keeps the waiting status until the last question closes. A withdrawal
counts as closure; the existing continuation checkbox instruction remains intact. Fake-runtime tests cover three
questions, a nonblocking question, another queue, partial saves, Resume and restart with both adapters.

`scripts/question-options.mjs` checks three widths against isolated fake-runtime instances: separate selection and
send, primary and secondary forms, exact request/event/inbox targets, continuation flags, free text with and without
options, project/target switches, reload, reordered live data, failed/slow saves, duplicate submission and keyboard
input. It also runs the layout-faults CLI. The raw collector includes boxes outside their scroll viewport, so the
probe additionally asserts non-overlap of visible option rectangles and records their clipping geometry.

### Completing the question barrier (QA4)

The baseline reproduced a second hole: after two `continue:true` partial answers, a final `continue:false`
still opened a worker turn on both fake runtimes. The old flag was only prompt wording. `questionBarrier` now
derives both the remaining count and the latest answer's wait decision from durable events, scoped to queue and
step. `can_continue` only describes independent work inside the asking turn; even those questions show waiting.
The same predicate gates delivery, nudges, step openings, advancement, fallback and finishing after an exit.

Explicit Resume records the released answer id in `run.yaml.answers_resumed`. Automatic recovery, usage retries
and approval resumes do not grant it. A later answer is a new decision. The question barrier does not replace
pause, stop, approval or review. Resume prefers pending answers over a new step-opening prompt: otherwise a
paused worker asks its questions again instead of seeing the saved replies (reproduced with both fakes).

All accumulated answers and ordinary messages are delivered in one turn after the asking turn ends. Each answer
names its qid. The server rereads the question state immediately before delivery/opening; a question recorded
with the last answer keeps the barrier closed. Fallback records delivery after sending, retaining unread entries
in the replacement inbox if its opening is held. Answer routing follows replacement worker sessions as well as
orchestrator sessions; no historical log is edited. Repeated identical HTTP user answers are idempotent, while
different additional answers remain supported.

The desktop cards, phone sheet and run controls share the remaining-count and permission text. Answer remains
available while questions remain; Resume cannot promise a start with outstanding questions. The honest queue
status and digest also treat all open questions as waiting. Captures use two saved answers and one open question,
plus the all-answered state, at 1440/492/390 px. Protocol, fake-runtime, HTTP and browser regressions cover the
saved state separately from actual turns, runtime work markers and delivery traces.
The step panel uses the existing bounded-header option on desktop: this removes the old 8 px negative close-button
margin reported by layout-faults. The phone header is unchanged; both capture states have zero layout faults at
all three widths.
An additional reuse probe found that selecting the first queue with a matching session could pick an older halted
run and apply its questions to the current queue. Inbox ownership now prefers the going run, then the session's
current queue. Both fake adapters cover an old halted run and its open question sharing the current session id.
