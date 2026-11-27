# The engine and the agents

Part of [the design](../DESIGN.md).

See also: [Stopping a chat agent's turn](chat.md#stopping-a-chat-agents-turn).
See also: [Failures and the sections after it](engine-failures.md), moved out when this file passed 40 KB.
See also: [Completing the question barrier](questions.md#completing-the-question-barrier-qa4).

## Background work

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

## Worker process ownership on Windows (queue PT)

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

**The C# is compiled once per machine (queue TI, TI3).** Add-Type compiled `worker-job.cs` at every host start: 0.2 s
idle, 3 to 7 s on a busy machine. The host now compiles it once into a machine-wide folder (`%LOCALAPPDATA%/Nexus/job-host`,
not NEXUS_HOME, which every test has its own of), as `worker-job-<first 16 hex digits of the source's SHA-256>.dll`, and
the next hosts load it. A compiled DLL cannot be loaded from its file on the user's machine (Smart App Control refuses
it, 0x800711C7, measured in TI1), so the host reads its bytes and loads them (`Assembly.Load(byte[])`). A host compiles into a
private temporary file in the folder and renames it to the hashed name; when another host was first, the rename fails
and its file is kept, so hosts starting at once never write into one file. A changed source has another hash and is
compiled again; old files are left (a few tens of kilobytes each). Any failure of the cache (an unreadable folder, a file
that does not load) falls back to compiling in memory as before, deletes the bad file so the next host stores a sound
one, and is logged on the host's stderr and in `worker-job.log` in the folder. Measured from spawn to the runtime
started in the job (the `R` frame), the two hosts alternating: idle 632 to 317 ms (medians of 20), with 12 busy loops on
12 logical processors 1089 to 779 ms, with 36 busy loops 4766 to 2762 ms (medians of 10). What is left is PowerShell's
own start. Tests: `apps/server/test/worker-job.test.ts`, with the cache in a folder of their own (`NEXUS_JOB_CACHE`).

At a step boundary, the helper enumerates job members except itself and the runtime, opens each as a process handle,
verifies its membership on that same handle, terminates it and waits for exit. A reused PID outside the job is
never terminated. Enumeration repeats until only the two roots remain; a failure halts a running queue and ends its
worker, without opening the next step. A paused run (the user's Pause, Stop now or Stop at once) is not halted by it:
it stays paused with its own reason, the failure is in the session's activity, the worker is ended, and Resume goes on
in a new process (the user's decision D2 with queue LCG, survey LC4 finding 2: before, a stopped run halted with
"worker process cleanup failed", and LCK's retry had added two more ways in). A failure because the job host ended
("worker job host exited", `JobHostExited`) is the process's exit, whichever of the two the engine hears first: the
barrier lasts until the exit, which is decided as any other (the run goes on in a new process), and it halts nothing
(D2, finding 8: before, the failure heard first halted the run after a runtime crash). A timeout of the server's fifteen seconds is asked once more within the same
barrier, with a fresh limit and no kill: on a busy machine the helper may only be slow, and ending the worker there
turned a slow cleanup into a halted run (the user's decision with queue LCK, survey LC3 F5). Only a second timeout halts
("worker process cleanup timed out twice") and ends the worker. A resume waiting for the barrier waits through the
second request too. A pending barrier keeps the engine from being idle, so an update's drain waits for its outcome; one
that fails while the drain holds the run halts nothing: the run stays held, the failure is in the activity and the
worker is ended (docs/design/updates.md, "Updating Nexus": the drain waits for a pending cleanup too). A process that has run no turn yet has nothing to clean and gets no
barrier: when a step boundary starts a new process (another model), its first barrier comes after its first turn.
Before queue CI8 the engine asked the new process at once, while its helper was still starting (PowerShell compiling
`worker-job.cs`, half a second idle, 3 to 7 s on a busy machine and more), so the fifteen-second acknowledgement limit
counted the helper's start and halted the run. New inbox delivery waits for the cleanup acknowledgement. Runtime
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

## The run's state transitions

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

## One host for agent processes

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

**A turn a crash left open** (the user's decision of 2026-11-23, queue CK, on the LY survey's question 6). The host
records a turn in `turns.jsonl` when it ends, or when its process exits first (`interrupted`); both live in the
server's memory, so a server that crashed recorded neither, and the statistics lost the turn. The runtime record now
keeps the open turn (`turn_open`: its start and step) from the turn's start to its record. The next server's engine,
which looks at every session's record at its start before anything else starts a process, records such a turn as
`interrupted` (no duration: its end is unknown) and drops `turn_open` with the record's `exited`. git.yaml's round
turns already close lazily at the next turn or the step's end, so they were left as they are.

### When a worker's process ends

A worker session's process lives across turns and steps. The engine ends it (through AgentHost, never by pid, name or
command line) when its run finishes, when context care or a fallback switches the run to a fresh session, at a restart
for another model or effort, and at Stop at once. A paused or halted run keeps its process: a Resume goes on in the
same session and the same process, and only a process that is gone starts again resuming the session.

**A queue's earlier sessions keep no process (queue PRC).** A halt does not end the process, and before queue PRC
nothing did later either: a halted run started afresh (a new session) left the old session's process idle beside the
new one, in the same checkout, until the server stopped; a halted run closed as finished, or a queue cancelled, kept
its process the same way, and a worktree cleanup then met a folder a live process held. Now:

- a start of the queue (`Engine.start`) ends the processes of the queue's other worker sessions (a session belongs to
  the queue its file names); a session the start continues (`--use-session`) is kept;
- a queue that is done or cancelled keeps none: the engine ends them at its next look after the change (`onChange`);
- a worktree cleanup, Nexus's (Merger, after a merge back or a survey run) or the user's Clean up, first asks the
  engine to end them (`Engine.queueProcessesLeft`) and waits until none is alive: Nexus's looks again, the user's is
  refused for a moment (409). From the second ask on the wait has a reason, recorded where the cleanup's other waits
  go; a process still alive 60 s (`endDeadlineMs`) after it was first found is killed by force
  (`AgentProcess.kill(true)`: the job host itself on Windows, closing the job; SIGKILL elsewhere), and one that lives on
  even then keeps the wait, which says so (docs/protocol/git.md, "Merge back and clean up"; survey LC3 F2: before, it waited
  forever with nothing shown, freed only by a server restart).

A process in the middle of a turn ends after that turn (its input closes: a done queue's last turn may still write its
context summary), any other at once; one Nexus is ending already is left to end as it does. A session a going run works
in is never ended this way. The exit is one Nexus asked for: no failure, nothing retried, and AgentHost marks the
runtime record `exited`. The forced kill at `endDeadlineMs` is armed by every one of these callers, not only by a
cleanup waiting for the process: a fresh start beside an earlier session's process and a closed queue's look as well
(the user's decision D4 with queue LCG, survey LC4 finding 4). A turn still at work a minute after it was asked to end
is stuck, and two sessions in one checkout are worse than a cut last turn: it is killed by force, the old session's
activity says so ("did not end within 60 s of being asked"), and the new run gets no failure or retry from it
(`test/old-session-processes.test.ts`). After a server restart nothing more happens than the recovery's rule (every record not
`exited` is marked so; a worker's job closed with the old server).

## The texts agents receive

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
