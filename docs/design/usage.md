# Context and usage

Part of [the design](../DESIGN.md).

## Context management

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
step's context summary and the queue's own text (protocol: ["Context care"](../protocol/runtimes.md#context-care)). A runtime left to itself compacts when
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
fresh orchestrator session started from it (protocol: ["The orchestrator's context care"](../protocol/orchestrator.md#the-orchestrators-context-care)). Compacting keeps the session
but leaves the choice of what to keep to the model, and compacting again summarizes a summary; a fresh session starts
from a summary written on purpose and kept as a file the user can read, from the **current briefing** (a session
started before a deploy keeps the old one), and from the files, where an orchestrator's truth is anyway (`nexus
status` in its first message), so wrong beliefs it built up do not carry over. What is lost is the chat's tone and
detail. (The Ideas conversations, whose material is the conversation itself, get a "Compact" action instead.)
Decisions, building it:

- Its own threshold, `orchestrator.context_threshold_tokens` (global with a project override, default 500k tokens),
  apart from the workers' `context_reuse_tokens` (default 300k), which is about reusing a session for related work.
- Thresholds in tokens, not shares of the window (queue CT, decided by the user on 2026-11-19): what a long context
  costs and how well a model works in it depends on the tokens, not on how big its window is; a share of a 1M window
  let a session grow far past where it pays to start afresh. Each is capped at 80 % of the model's window, so a small
  window is never filled before the switch; an unknown window switches nothing, as before. The old shares are
  ignored, not converted: the new defaults are the point of the change.
- Only between turns, with its process idle: a turn is never cut into, and a turn ending is the orchestrator's
  equivalent of a step's end. The request is a turn of its own and asked once (`context:asked` in `applied.jsonl`, a
  file, so a restart in between still switches); after that turn the switch comes with or without a summary.
  A turn's result is not yet "between turns" when messages were sent into the turn (`next`): one written to Claude
  Code just as its turn ended (Nexus had read the reply, not yet the result) was not read in it and runs as a turn of
  its own, and nothing in the stream tells that from a turn that read them all until that turn starts. So the process
  is *settling* (`AgentProcess.settling`) until a turn starts or 1.5 s pass, and context care waits for that (queue OF:
  the request went out on that false idle in about 2 of 150 full test runs).
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

## Usage limits

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

## Estimating a turn's use

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

## Sub-agent tokens

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

## Measuring token use

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
