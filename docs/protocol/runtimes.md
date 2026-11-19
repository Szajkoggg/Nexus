# Runtimes, fallback and context care

Part of [the protocol](../PROTOCOL.md).

## Fallback when usage runs out

When a step's runtime is beyond the usage threshold, the work goes on on a fallback instead of waiting (decided with
queue FB, 2026-11-14). Nexus switches by rules (the settings and the queue YAML), not by the orchestrator's judgement;
the orchestrator is told afterwards.

**Beyond the threshold** (`routing.ts`, `overThreshold`): any of the runtime's windows in `<NEXUS_HOME>/usage.json`
(Claude Code's `five_hour` and `seven_day`, and any other it reports; Codex's `codex_*`) at or above the project's
`defaults.usage_pause_threshold`. A window the runtime has not reported is free; one whose `resets_at` has passed counts
as reset, without a fresh reading; one without a reset time counts as free (nothing to wait for). With two full
windows, the later reset counts.

**At a step boundary** (`chooseRoute`), before the next step opens: its own values (see "Kinds and their defaults")
while their runtime is free; else the first entry of its fallback chain whose runtime is free (an entry on a full
runtime is passed over; an entry's model or effort left out is the project's for that runtime); a `wait` entry waits
(`usage_wait` until the reset); a chain with no free entry left (or none) waits until the earliest reset among the
runtimes it tried, so with both full the run waits for the one that comes back first. The switch is at the threshold,
not the limit, so no turn is cut off. A step on another runtime than the session's opens in a fresh session given the
previous step's context summary (asked for first, as for any change of runtime; "Runtime, model and effort per step").
At the next boundary after its own runtime is free again, a step opens on its own values again (back), the same way. A
first step whose runtime is full at the start opens on its fallback at once (its session is made there).

**In the middle of a step** (the engine's `usageGate`): before every turn within a step, that is a nudge of a turn
without an outcome, an answer, a send-back (the user's Fix it or the orchestrator's), and a message to an idle session (not a
continue after a wait or a retry, which goes on as before), the engine looks at the session's runtime. Beyond the threshold, the step goes by
its chain as at a boundary: on the first free entry (or on its own values again, when the session runs on a fallback
that is full now), the old session ends and a fresh one continues the step (`switches[].why: usage`, a `fallbacks`
entry for the step). Its first text (`midStepSeed`) says why and gives the step's progress lines, its commits since its
round began (`git log` from the round's start in `git.yaml`), and the uncommitted changes in the checkout
(`git status`, `git diff --stat`), which stay where they are: the new session is told to keep them and go on from
them. Then the step's opening ("Continue this step"), then the old session's unread inbox entries (the answer, the
send-back, the message that was due); a carried send-back opens its round. At a `wait` entry, or with no free entry,
the run waits (`usage_wait`) in the middle of the step, its session kept, and continues it after the reset. A turn that is running is never cut off: an entry for a working session goes into its running
turn as before, and the gate looks only when the session is idle. A turn that failed on the usage limit (a `usage`
failure with its reset time) goes the same way: its runtime counts as full until that reset, and the step goes on on
the next entry of its chain instead of waiting (`fallbacks[].reason`: "the usage limit was reached (…)").

**The words**: why a runtime counts as full is said one way everywhere (`windowReason`): "Claude Code's 7-day window at
96 % (limit 90 %)", "Codex's 5-hour window at 100 % (limit 90 %)"; a run's `usage_wait` reason, a fallback's `reason`
and the orchestrator's notice use it, and the dashboard shows a step's switches as "On Codex (gpt-6-luna, low effort):
<reason>" and "Back on Claude Code: its usage is below the limit again" (in its details, and for the step on the
queue card: a line under the step that matters, a ⇄ with the text as its title on the others). A turn refused for the
limit keeps its own reason ("the usage limit was reached (…)").

**The record**: each step that opened on its fallback, and the step that opened on its own values again, is an entry
in `run.yaml` `fallbacks` (once per step), with an activity line; `StepView.usage_switch` is the step's latest entry,
and each turn of a step on its fallback has `fallback: { from, reason }` in `turns.jsonl`, so statistics can tell them
apart.

**The orchestrator** is told of each entry (`notify:fallback:<queue>:<step>:<at>`: "Step Q2 of queue Q runs on its
fallback, Codex, …, instead of Claude Code: <reason>"; a switch back likewise). While its active runtime is
beyond the threshold, no notice starts its turn: each goes into its inbox (`sessions/<id>/inbox.jsonl`, id
`notice-<key>`, from `nexus`), not told yet; the reviews it would do (levels 2 and 3) wait meanwhile. At the first
change after that runtime is free (a timer looks again just after the reset), every held notice is told, and its inbox
entry counts as delivered. With `orchestrator.fallback` configured, it may switch to the available backup between
turns, carrying those notices; user messages also wait while the active runtime is full (see ["The orchestrator"](orchestrator.md#the-orchestrator)).
Without a fallback, the user's own messages to it are not held.

## Kinds and their defaults

Each kind (see ["Tags"](stats.md#tags)) has its own runtime, model, effort and fallback chain in the settings (`kinds.<kind>`, global
with a project override, edited per kind in the settings panel's "Kinds of work"). They replace the project's one
model as the only default (decided with queue FB, 2026-11-14). As shipped (the user changes them at any time):

| Kind | Runtime | Model | Effort | Fallback |
|---|---|---|---|---|
| mechanical | Claude Code | claude-sonnet-5-5 | low | Codex, gpt-6-luna, low |
| code, debugging, research | Claude Code | claude-opus-5-5 | high | Codex, the project's Codex model, high |
| docs | Claude Code | claude-sonnet-5-5 | medium | Codex, the project's Codex model, medium |
| design | Claude Code | claude-opus-5-5 | high | wait |

A kind's model or effort left out (or the project's own `null`) is the project's for that runtime
(`runtimes.<runtime>`). A fallback chain is a list: each entry a runtime with an optional model and effort (left out:
the project's for that runtime), or `wait`; `wait` ends the chain. Checked where it is written: a draft, the settings
(an effort the runtime does not take, an entry after `wait`, an unknown key are refused).

**The precedence** (`packages/protocol/src/routing.ts`, `routeStep`), strongest first:

1. The step's own `runtime`, `model`, `effort`, `fallback` in the queue YAML.
2. The queue's `runtime`, `model`, `effort`, `fallback` (part of what an approval pins when set).
3. What the run's start named explicitly: `--runtime`, `--model`, `--effort` (the dashboard's start the same), or all
   three when it continues a session. Those it took from the project's defaults (`run.yaml` `from_defaults`) are not
   this level.
4. The step's kind's defaults: the project's own values, else the global ones.
5. The project's defaults: `runtimes.default`, and `runtimes.<runtime>.model` and `effort`.

The runtime is the strongest level's that names one. A model or effort comes from the strongest level that names one
and belongs to that runtime: the step's always; the queue's when the queue names no runtime or the same one; the
start's and the kind's only when their runtime is the step's (the start's runtime is the one it resolved, explicit or
from the defaults); else the project's for that runtime. So the kind overrides only what the start took from the
defaults (a run started with `--model X` runs a mechanical step on X, at the kind's effort), and with an explicit
runtime the kind's model and effort count only when the kind's runtime is the same one; else the run's values. The
fallback chain is the strongest level's that names one (step, queue, kind; an empty list is a choice too); none: the
run waits for the usage window, as before. A step without a kind gets the project's defaults. The orchestrator may
depart from this for a run or a step (`--model`, the step's own values) and says why. The estimates
(`queueEstimate`) use the same precedence.

## Runtime, model and effort per step

A run records its own runtime, model and effort when it starts (`run.yaml`). Those its start chose (or took from the
session it continues) stay for the whole run. Those it took from the project's defaults are listed in `from_defaults`
and resolved again from the project's effective settings (its own values, else the global ones) when each step opens,
so a changed default reaches a running queue at its next step. Which values a step runs on follows "Kinds and their
defaults" above: its own, its queue's, the start's, its kind's, the project's, never the previous step's. A model or
effort chosen at the start belongs to the runtime the run started on: a step on another runtime takes what it does not
name from its kind (when the kind is on that runtime) or the project's defaults for that runtime. The values are
checked when the step opens: an effort the resolved runtime does not take halts the run, naming the step and the reason
(`step Q2: Claude Code takes effort …`).

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

With `defaults.context_care` on (the default), at the end of a step whose session's context (`context_tokens` in
`runtime.json`) is beyond its threshold, and when a next step remains, the engine goes on in a fresh session. The
threshold in use is `defaults.context_reuse_tokens` (tokens, global with a project override, default 300000), but at
most 80 % of the model's context window (`context_window` in `runtime.json`; `contextLimit` in
`packages/protocol/src/schemas.ts`): a 1M window switches past 300k tokens, a 256k one past 204.8k. Without a known
context window it goes on in the same session. (Before queue CT the threshold was a share of the window,
`context_reuse_threshold`; reading ignores that key and nothing converts it: a project or global file that still has it
gets the default.) A fresh session for another
runtime is made the same way, and so is one for the closing refactoring step (`why: refactor`: no summary is asked
for, and the seed gives none; see ["The closing refactoring step"](queues.md#the-closing-refactoring-step)).

**After an idle hour** (queue FI): with context care on, a step boundary where the session has been idle for more than
an hour (`IDLE_SWITCH_MS`, the life of the runtime's prompt cache: the next turn would write the whole context to the
cache again) goes on in a fresh session too, below the threshold, when the session's summary is fresh. Idle is the
engine's clock at the boundary less `last_turn.ended_at` in `runtime.json`; fresh here is stricter than below: a
`context.summary` of that session at or after `last_turn.started_at`, written in its latest turn, so a turn after it
(a check-fix round, a send-back, a message) makes it old. Without a fresh summary nothing is asked (asking is a turn
in the old session, which rewrites the cache all the same) and the step opens in the same session. The switch is
recorded as `why: idle` with `idle_minutes` and `summary: written`; the seed says how long the session was idle. A
switch for the threshold or another runtime comes first. The run's panel and `nexus status` (a line per switch under
the queue, `switchLines` in `packages/protocol/src/overview.ts`) show every switch with its reason.

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

What a switch costs in quality is measured by `nexus stats --switches` (`switchReport`, `packages/protocol/src/stats.ts`;
queue CT): of the steps with an outcome (in the range and project), those that opened in a fresh session after a
context switch (`switches` in the queue's current `run.yaml`, `why: context` or none) against those that opened in the
session that ran the queue's step before them, each with the steps accepted in the first round (of those decided), the
steps sent back at least once (of all; and the send-backs), and the check-fix rounds (failed check sets, all and per
step). Steps that opened a session otherwise (a run's first step, a runtime switch, an idle switch, the closing refactoring step) are
counted apart, in neither. A switch recorded in an archived run (`run.<time>.yaml`) is not read.

## How the engine runs a Codex session

`codex app-server` over stdio: JSON-RPC requests and notifications, one JSON object per line, no `jsonrpc` field.
After `initialize` (with `experimentalApi`) and `initialized`, `thread/start` (or `thread/resume` with the stored
thread id) with the working directory, model, sandbox mode, approval policy (`never`: Nexus runs unattended; any
approval request that still comes is declined) and the worker briefing as `developerInstructions`. The thread id
becomes the session's `native_id`.

A worker's thread starts without the user's own Codex tools (queue FX): before `thread/start` (or `thread/resume`)
Nexus reads the effective config (`config/read` with the working directory) and adds to the thread's `config`
`features.apps: false`, `features.plugins: false` and `mcp_servers.<name>.enabled: false` for every MCP server it
names, except those in the project's `runtimes.codex.mcp_servers` (left as the user's config has them). A name that
is not a bare key is quoted (`mcp_servers."odd.name".enabled`). When the config cannot be read, the thread does not
start. A thinking partner's thread starts so too, keeping none, and so does an orchestrator's on Codex (queue OC):
`runtimes.codex.mcp_servers` is the workers' only.

- a step turn: `turn/start` with `input: [{type: "text", text, text_elements: []}]`, the session's `effort` (and,
  once a step changed them, `model` and `effort`) and, in `workspace-write`, a `sandboxPolicy` whose writable roots include the project's `.nexus/` when the worktree is elsewhere
- a message while the agent works: `turn/steer` with the running turn's id
- a picture uploaded for a chat message: each line of a message (of either request) that is the absolute path of an
  existing `.png`, `.jpg`, `.jpeg`, `.webp` or `.gif` file in a `.nexus/uploads/` folder also goes in as
  `{type: "localImage", path}` after the text item; the text keeps the path (see ["Uploads"](api.md#server-api) under ["Server API"](api.md#server-api))
- stop now: `turn/interrupt`, then the message as the next turn

It reads `turn/started` and `turn/completed` (the turn's status), `item/started` and `item/completed`
(`commandExecution`, `fileChange`, `agentMessage`, `mcpToolCall`, `webSearch`, `subAgentActivity`),
`thread/tokenUsage/updated` (the last request's input tokens are the context in use; `modelContextWindow`) and
`account/rateLimits/updated` (stored as `codex_<window>` in `usage.json`, e.g. `codex_7d`). Only notifications of the
session's own thread count: a sub-agent's thread sends its own turns and items over the same connection, and they are
ignored. Background work (DESIGN.md, ["Background work"](../design/engine.md#background-work)): a `commandExecution` item still open when its turn has
completed, and a sub-agent from its `subAgentActivity` `started` (or `interacted`) until its `completed` (or
`interrupted`). Checked against Codex CLI 0.167.2.

## How the engine runs a Claude Code session

`claude -p --input-format stream-json --output-format stream-json --verbose --session-id <uuid>` (or `--resume
<uuid>` for a session that ran before), with the project's permission mode, `--allowedTools Bash(nexus:*)
PowerShell(nexus:*)` plus the project's list (as it is: its rules get no PowerShell pair), the model, and a worker briefing as `--append-system-prompt-file <.nexus>/sessions/<id>/briefing.md`
(every Claude Code session's briefing, the orchestrator's and a thinking partner's too, goes in that file, written by the
server at each start: the command line stays short of Windows' 32,767 characters). With `defaults.protect_nexus` on (the
default), `--disallowedTools Edit(//<.nexus>/**),Write(//<.nexus>/**)` names the project's `.nexus` by its absolute
path in Claude Code's rule form (`//` and forward slashes, the Windows drive letter as the first segment:
`C:\Code\P\.nexus` is `//c/Code/P/.nexus`), so it holds from a worktree too; deny rules win over the allow list. The
nexus CLI, which writes the worker's events there, is a process, not a file tool, and keeps working. Orchestrators
and thinking partners keep their own rules. Codex workers start without the user's own Codex tools but the MCP servers
the project names (see "How the engine runs a Codex session"). Environment: `NEXUS_SESSION`,
`NEXUS_DIR`. The process stays alive across turns; stdin carries user messages:

- a step turn: `{"type":"user","message":{"role":"user","content":"…"},"parent_tool_use_id":null}`
- a message while the agent works: the same with `"priority":"next"` (read after its current tool calls, no interrupt)
- stop now: `"priority":"now"` (interrupts the turn)

From stdout it reads `system/init` (a turn starts), `assistant` (tool calls, text, context usage),
`user` tool results (errors), `rate_limit_event` (usage windows), `system/background_tasks_changed` (the whole list
of background tasks: a Bash command or a sub-agent started with `run_in_background`; when one ends, the CLI starts a
turn by itself with its notification) and `result` (the turn ended; the context window from `modelUsage`). After a
turn ends it decides the next move from the step's state: next step, wait (question, review, background work: see
DESIGN.md, ["Background work"](../design/engine.md#background-work)), nudge once if the step has no outcome, or halt.

### Windows worker process host (PT)

Only worker launches use `apps/server/src/worker-process.ts` and the private `worker-job.ps1` / `worker-job.cs`
host. Other roles keep direct process spawning. No new durable file or event is introduced. The runtime record's
`pid` is the actual runtime PID, supplied once the helper reports it, never the helper's PID. The existing
`stop_at_once` action now waits for that worker's whole job to end. Windows recovery never kills a worker by a
persisted PID; its old host owns the job and closes it when its server pipe closes.

The internal redirected-stdio control channel is line-based UTF-8, separate from the runtime's own protocol. The
server writes two initial base64 lines: the UTF-8 executable path, then its Windows-quoted argument string. The
helper inherits the worker environment and working directory. It creates a private hidden console and joins a
kill-on-close Job Object before launching the runtime. Subsequent frames:

| Direction | Frame | Meaning |
|---|---|---|
| Server to helper | `W <base64>` | Write these UTF-8 bytes to runtime stdin |
| Server to helper | `E` | Close runtime stdin; after five seconds the server requests `K` if still alive |
| Server to helper | `C <id>` | End descendants, preserve helper and runtime, wait for their exit |
| Server to helper | `K` | End all job members except the helper; runtime exit ends the helper |
| Helper to server | `R <pid>` | Runtime launched inside the job |
| Helper to server | `O <base64>` / `E <base64>` | Runtime stdout / stderr line, including its newline |
| Helper to server | `C <id>` | Descendant cleanup completed; the engine may cross the boundary |
| Helper to server | `X <code>` | Runtime exited and descendants were cleaned |
| Helper to server | `F <base64>` | Cleanup/exit failure text; pending cleanup rejects and the worker is ended |

Helper startup errors go to its own stderr and fail the launch. An EOF on its control input ends the job. The helper
allows ten seconds for repeated descendant enumeration (each termination waits at most two seconds); the server
allows fifteen seconds for a cleanup acknowledgement and otherwise halts the run and requests termination. A kill
not completed in fifteen seconds ends the helper through Node's child handle, closing the job. Only handles whose
membership in this private job was verified may be terminated, with no name/command-line matching. The helper
reports exit only after runtime and descendants have gone; helper death also triggers Windows kill-on-job-close. After
`X` (and `F`) the helper leaves through the native `ExitProcess`, not through the PowerShell/.NET shutdown, which took
2.3 s: the server still signals the runtime's exit when the helper process closes, now some 20 to 45 ms after the
runtime ended.

The worker briefing says that processes cannot be left running for another step. The engine cleans after a step
outcome and the turn's end, before the next step or while waiting for review, and after Stop now's turn. A question
or a turn without an outcome keeps the existing background-work policy. Failures halt rather than advancing with
uncertain cleanup. Resume while cleanup is pending is deferred until its acknowledgement, including automatic
resumes after a cancelled drain; a subsequent run change cancels that request. Resume while an immediate stop is
still exiting remains 409. Orchestrator and thinking-partner process ownership is unchanged. The implementation is Windows
only; its scope and the console-lifetime finding are documented in DESIGN.md, ["Worker process ownership on Windows"](../design/engine.md#worker-process-ownership-on-windows-queue-pt).

### Full-test lock and lifetime channel (PT2)

`node scripts/test-lock.ts <node arguments...>` uses a machine-local temporary lock, outside project `.nexus` data.
`NEXUS_TEST_LOCK` overrides its path. The JSON record contains `pid` (the wrapper), `cwd`, `since` (ISO time), and a
random `token`. When process queries are unavailable it also contains `lease: true`; its file modification time is
the last renewal. `NEXUS_TEST_LOCK_STALE_MS` is then the maximum gap between renewals (default 20 minutes), rather
than the maximum age since acquisition. Renewal is every second or one third of a shorter expiry, at least 10 ms.
Release checks both PID and token. Old records without `lease` retain the original dead-PID/absolute-age rules.
A waiting run waits until it has the lock; since queue EC (EC2) no time lets it proceed without it, and
`NEXUS_TEST_LOCK_MAX_MS` is gone (see ["The capacity coordinator"](checks.md#the-capacity-coordinator)). The rules for when a lock counts as held are in
`packages/protocol/src/full-test-lock.ts`, shared with the server's capacity coordinator.

The internal `--watchdog <wrapper pid> <starter pid> <lock path>` child owns the runner. The wrapper's Node IPC sends
`{args, token}` to start it, `{signal}` to forward a signal, or `{stop:true}` to end it. The watchdog announces
`{ready:true, queried:boolean}`, reports `{gone:pid}` when a known starter ends, and `{code}` before exit. Its exit
status is the runner's status, or 1 for interruption/startup failure. Losing the wrapper channel ends the owned run;
the wrapper also honors a disconnect from a caller-provided IPC channel. No process-list PID is a cleanup target.

`NEXUS_TEST_LOCK_QUERY=off` disables ancestry discovery for tests and restricted environments. Without a query result,
the watchdog relies on lifetime IPC and the holder renews a lease. If the sandbox ends both, the unrenewed lock is
reclaimable after expiry. `NEXUS_TEST_LOCK_WATCHED`, when set for diagnostics/tests, names a JSON file written once:
`{watched:[pid,...], guard:pid, queried:boolean}`. An unavailable ancestry has an empty `watched` array. These are
private test-runner formats, not project events or server APIs.
