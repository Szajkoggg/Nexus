# The engine and the agents

Part of [the design](../DESIGN.md).

See also: [Stopping a chat agent's turn](chat.md#stopping-a-chat-agents-turn).
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
never terminated. Enumeration repeats until only the two roots remain; failure or a timeout halts the queue and
ends its worker, without opening the next step. A process that has run no turn yet has nothing to clean and gets no
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

## Failures

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

## Refused actions

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

## Messages to a running step

| Runtime | How a message reaches a running turn |
|---|---|
| Claude Code (launched by Nexus) | A user message on the session's stream-json stdin with `priority: "next"`: read after the running tool calls finish, without interrupting |
| Codex (launched by Nexus) | `turn/steer` on the app-server connection |
| Either, started outside Nexus | A `PostToolUse` hook (both runtimes have one) checks the session's inbox and returns it as `additionalContext` |

An **urgent stop** uses the runtime's interrupt (Claude: `priority: "now"` or SIGINT; Codex: `turn/interrupt`).

## The orchestrator

One long-lived session per project, shown as the project's chat. It may:

- read the project (code, docs, logs, review material) and every `.nexus/` file,
- create and edit draft queues, propose them for approval,
- start, resume, fork, pause and stop worker sessions; choose which session gets a queue,
- answer or escalate worker questions, add notes to steps.

It may not edit project files, approve queues, or answer a question that is the user's. This is enforced by the
runtime's permissions (for Claude: read-only tools plus `Bash(nexus *)`, and writes only under `.nexus/drafts/`, where
it keeps its queue drafts), not only by instruction.

## Autonomy and insight

Queues run autonomously: they do not stop at each step for the user. The user checks queues as a whole, and looks
into individual steps when they want more detail. So the dashboard offers two levels:

- **Queue report**, the default review: when a queue ends (done or stopped), the worker writes a report of the
  whole queue: what each step achieved against its acceptance, the checks, the review material, open questions,
  and what is proposed next. The queue row links to it.
- **Step detail**, on demand: the step's timeline (progress lines, checks, review material, questions and answers,
  notes delivered), the agent's activity during the step (tool calls and messages, from the runtime's stream), the
  commits it made and its `context.summary`. Available live while the step runs and afterwards.

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

### A chained commit and step report (queue BR1)

Whether a worker may run `git commit … && nexus step done …` as one command was probed on 2026-11-19 (Claude Code
2.1.318 with `haiku`; Codex 0.169.0 with `gpt-6-luna`), each case in a fresh temporary repository with a staged
change and a harmless `nexus` stand-in first on PATH (it only logged its arguments), one session per command. Windows
PowerShell 5.1 is the machine's only PowerShell: it has no `&&` (a parser error, "not a valid statement separator").

Claude Code, `--tools Bash` or `--tools PowerShell`, the worker's rules (`Bash(nexus:*)`, `PowerShell(nexus:*)`):

| Mode, extra rules | Command | Result |
|---|---|---|
| `dontAsk`, none | Bash `git commit && nexus …` | refused (git commit has no rule; alone it is refused too) |
| `dontAsk`, none | PowerShell `git commit; if ($?) { nexus … }` | refused |
| `dontAsk`, `git commit:*` on both shells | Bash `git commit && nexus …` | ran: committed, stand-in called |
| `dontAsk`, `git commit:*` on both shells | PowerShell `git commit; if ($?) { nexus … }` | refused |
| `dontAsk`, `git commit:*` on both shells | PowerShell `git commit && nexus …` | refused |
| `dontAsk`, `git commit:*` on both shells | PowerShell `git commit; nexus …` | ran (but nexus runs even when the commit fails) |
| `dontAsk`, none | `nexus …` alone, either shell | ran (control) |
| `auto` (this project's setting), none | Bash `&&` and PowerShell `; if ($?) {}` | both ran |

Under `dontAsk` every subcommand must match a rule, and the PowerShell conditional (`if ($?) { … }`) is refused even
then; the refusal reads "Permission to use PowerShell has been denied because Claude Code is running in don't ask
mode". Under `auto` the classifier let both forms through; its own usage is not in the session's cost.

Codex, `workspace-write`, approval `never` and `on-request` with the `auto_review` reviewer: on this machine the
`elevated` Windows sandbox (the user's config) started no process at all from inside a Claude Code worker
("CryptUnprotectData failed: 2148073483", even `git status`, also in `codex sandbox` without a model), so the cases ran
with `windows.sandbox = "unelevated"`. Codex runs commands through `powershell.exe -Command`. In a plain repository
`git commit` failed in the sandbox (`.git/index.lock: Permission denied`, `.git` is kept read-only), chained or not, and
`if ($?)` then kept the stand-in from running. In a linked worktree with the writable roots Nexus gives
(`gitWritableRoots`), `git commit -m probe; if ($?) { nexus … }` committed and called the stand-in under both
approval settings; the `&&` form failed as a PowerShell parser error, not a refusal. Given the `&&` form in a plain
repository, `gpt-6-luna` twice declined to run it at all ("I can't run a chained command …"), a judgement of the model.

Cost: about $0.021 of Claude usage (eleven haiku sessions); twelve Codex runs on the ChatGPT subscription (about 383k
input tokens, 219k of them cached, 1k output; five of them the failed elevated runs).

Decided by the user on 2026-11-19: the chain's form follows the shell, `git commit … && nexus step done …` in Bash and
`git commit …; if ($?) { nexus step done … }` in PowerShell; a refused chain is run as separate commands (the one
retry), and workers get no new permission (no `git commit` rule).

The briefings (queue BR2) carry it in `shellCommands(runtime)` in `apps/server/src/prompts.ts`, the successor of the
SH text "on their own, one per call … no &&": a command that needs only the previous one's success is chained with it,
short enough that the error shows which part failed, and independent commands go as separate calls (parallel ones
when they only read). Beside it, `readingRules(runtime)`: independent reads in one response as parallel tool calls, a
part of a file rather than all of it (Claude Code: Grep with `-C` and `head_limit`, Read with `offset` and `limit`;
Codex: `rg` with `-C` and a limit, a line range by `Get-Content | Select-Object` or `sed -n`), the project's own
scripts before a one-off node or python script, which is an exception and reads only; and parallel calls are for
reads, never two builds or test runs at once. The worker's, the orchestrator's and the thinking partner's briefings
each get the form of their runtime (the worker's and the partner's Codex briefings now differ from Claude Code's).

Also from queue BR (BR3), to spend fewer tokens and turns: the worker looks at a changed view itself at one width and
only registers the other pictures for the review, without reading them back; it reports `nexus step progress` at a
phase boundary only, not after every command. The orchestrator puts S-sized items of one area together into one
queue, a step each (at most about five), when they are independent of the queues running or planned beside them and
the user would keep or drop them together; items the user may want to keep apart stay apart.
