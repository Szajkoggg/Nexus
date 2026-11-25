# The engine and the agents: failures, refused actions and the orchestrator

Part of [the design](../DESIGN.md).

See also: [The engine and the agents](engine.md), the sections that moved out when this file passed 40 KB.

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
as Claude Code does (`test/fake-claude.ts`; FAKE_START_MS holds its first read). A test that needs an exact moment holds
the fake at a named point instead of timing it (`FakeGates` in `apps/server/test/fake-behaviour.ts`, queue LCR): its
first read, the save, its first output, a refusal, its stderr and its exit, each until the test releases it.

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
