# State, order and reads

Part of [the design](../DESIGN.md).

## Clock steps: ordering by what was seen, not by the wall clock (queue FL, plan FL4)

**What breaks.** Nexus orders and compares wall-clock times written by different processes: the server's events,
activity and run records, the `nexus` CLI's events (each agent call is a fresh process) and git's commit times. The
clocks disagree after a clock step. On Windows V8 re-reads the system time only once a minute, so after an NTP step
(4 minutes forward on this machine, minutes after an unlock) the long-lived server writes on the old base for up to a
minute while every CLI call and git already use the new one; a backward step (a manual correction, a VM resume) skews
every process at once. FL2 reproduced it (`FL2-cause.md`, a preload that makes the test process lag): a worker's
`step.started` (CLI, new clock) sorts after the engine's `step.interrupted` (old clock), so the interrupted stretch
never closes; a stopped step's commits (git, new clock) fall outside every turn window of the worker's activity
(server, old clock), count as foreign, and the Keep/Discard choice is never offered (a Discard would revert nothing).

**The rules** (built in FL5, see "As built" below; nothing changes a file that existed before in a way an older reader
minds):

1. **One file keeps the order it was written in.** Every file has one writer, so its lines are in causal order. A
   reader that merges files never reorders the lines of one file: it sorts by an *effective* time, the line's `at`
   raised to the previous line's effective time of the same file (`max(at, previous)`), then by id (`compareIds`). For
   files written without a clock step this is the sort of today; for old files written across a backward step it
   restores their order.
2. **No writer writes a time earlier than one it has read** (a hybrid logical clock; the `at` format stays ISO 8601,
   only its value is constrained). `stamp()` = `max(Date.now(), high-water + 1 ms)`, where the high-water mark is the
   latest `at` the process has read or written in the project. The server raises it with every state it derives (it
   reads every log) and every stamp it writes. A CLI call reads its own session's events and inbox, and a small file
   the server keeps for it, `.nexus/clock.json` (`{ "at": … }`, the server's high-water mark; one writer: the server),
   written before the server hands an agent anything to act on (a turn's prompt, an inbox message, a resume). So an
   effect is stamped after its cause even when its writer's clock lags: the engine's `step.interrupted` comes after
   the `step.started` it interrupts because the engine had read that event. The watcher may not have delivered a line
   written a moment ago, so before the server writes a record about a step it raises the mark from that step's
   session log (one read of a file it reads anyway). A missing `clock.json` (an older server)
   leaves the CLI with its own files, as before. A time read more than `CLOCK_AHEAD_MS` (15 min) ahead of the
   reader's wall clock is not taken up (see "As built").
3. **A step's commits come from the HEADs around its turns, not from time windows.** The server records, per round in
   `git.yaml`, the HEAD at the start and the end of every turn of the worker's session on the step (`turns: [{ start,
   end }]`, a sha or null; an open turn has no `end` and uses the HEAD of now, as an open round does). A commit of the
   round is the step's when it is in some turn's `start..end` (`git rev-list`), foreign when it is only between turns.
   Someone else's commit in the main checkout *during* a turn still counts as the step's, as with the time windows.
   Rounds recorded before (no `turns`) keep the time windows. A trailer in the commit message was rejected: agents
   write their own messages, and one forgotten trailer would make a step's commit foreign.
4. **A duration inside one process uses the monotonic clock** (`performance.now()`); wall-clock deadlines stay wall
   clock (a time the user named, a provider's usage reset): they are meant in wall time.

**Where the wall clock is compared today, and what each place becomes:**

| Place | What it compares (writers) | After a clock step | Becomes |
|---|---|---|---|
| `state.ts` event order (`events.sort`) | `at` of every session's events (server, CLI) | an effect before its cause: the interrupted stretch stays open, a step stays running | rules 1 and 2 |
| `state.ts`, status changes among events | queue.yaml `changes` (server) against events (CLI) | a lift or a back-to-pending applied on the wrong side of a stop | rule 2; `changes` keep their array order (rule 1) |
| `state.ts`, `step.started` closing the previous stretch, `step.interrupted`, `endSegment` | the order of the step's events | as the event order | rules 1 and 2 |
| `state.ts`, an ended run closing the open stretch (`open.start <= ended`) | run `ended_at` (server) against `step.started` (CLI) | FL2: the paused run ended "before" the stretch began, so it stays open | rule 2 (the server stamps `ended_at` after the start it has read) |
| `state.ts`, rejection and lift proposal against approvals (`a.at > r.at`) | server against server | backward step only: an approval taken as older than the rejection it answers | rule 2 |
| `state.ts`, an event's revision (`history.replaced_at > e.at`) | queue.yaml history (server) against events (CLI) | an event counted to the revision before or after the right one | rule 2 (the worker acts on a revision only after the server told it) |
| `state.ts`, `review_levels_since` | a fixed cut-over date against events | none in practice (a date long past) | stays |
| `status-rules.ts` `questionBarrier`, `accepted.ts` latest acceptance | answers and acceptances (server, orchestrator's CLI) | the wrong answer or acceptance taken as the latest | rule 2 |
| `prompts.ts` `reviewBrief`, `mergeback.ts` `failedChecks` | checks, review items, metrics (server, CLI) at or after the round's `step.started` | a round's checks left out: "missing" checks, a wrong merge-back verdict | by order: the state derivation tags each check, item and metric with the stretch it came in (index in `segments`), the filters use the index; derived, nothing stored |
| `mergeback.ts` `stillEnding` | `finished_at` (CLI) against the server's `Date.now()` | the round waits up to the step longer, or is taken as ended too early | the server's own monotonic time of when it saw the outcome (after a restart: settled) |
| `engine.ts` context summary "fresh" | `context.summary` against the session's `step.started` (both the worker's CLI; fallback `run.started_at`, server) | an old summary taken as fresh, or a fresh one asked again | by order in the session's log (rule 1); the fallback by rule 2 |
| `orchestrator.ts` `summaryWritten` | `context.summary` (CLI) at or after the ask (`applied`, server) | the summary ignored, Nexus asks again or waits | rule 2 (`clock.json` written before the ask is delivered) |
| `orchestrator.ts` notices "since the last look" (`since`, deploy changes, plans, questions, metrics, merges, runs) | records of server and CLI against the server's `since` | a notice missed (backward) or told twice | rule 2 |
| `stopwork.ts` `discardRecorded` | a Discard (queue.yaml, server) at or after the `queue.stop` (CLI) | the Discard not counted: the choice asked again | rule 2 |
| `gitinfo.ts` `stepCommits` / `turnWindows`, `leftBehind` | commit time (git, `%ct`) against turn windows (activity, server) +-2 s | FL2: the stopped step's commits foreign, no Keep/Discard | rule 3 |
| `closing.ts` `queueRange` | rounds' `started_at`/`ended_at` (server) | backward step only: the wrong first or last round | rule 2 |
| `engine.ts` latest run, `conversations.ts`, `coordinator.ts` order | `updated_at`, `last_at`, a start's `at` (server) | a wrong pick or order, shown or tried once more | rule 2 |
| `agent-host.ts` turn `duration_ms`, step and check durations in stats | two stamps of one process; segments | a negative (clamped to 0) or inflated duration | the turn's duration from `performance.now()` (rule 4); segments become monotonic by rule 2 |
| Scheduler (planned starts, undo, `MISSED_MS`), deploy plan, recurring, away, usage resets, the background limit | wall-clock deadlines against `Date.now()` | fire up to the step early or late (`setTimeout` runs on the monotonic clock); a forward step over 15 min marks a planned start as missed | stay wall clock (rule 4); FL5 may re-check the due ones when it sees a step, not required |
| Display sorts (`main.ts` lists, refusals, ideas, digest) | `at` | a line shown out of place | rule 2; nothing else |

**Old data.** Events and other records keep their format; `at` keeps its meaning (a time, now never earlier than
what its writer had read). Old logs read as today, with rule 1 repairing the order inside one file. `git.yaml`
rounds gain an optional `turns`; rounds without it keep the time windows. `clock.json` is new and optional; an older
server ignores it, an older CLI never reads it. An older server that rewrites `git.yaml` drops `turns` (its schema
strips unknown keys), which only brings that round back to the time windows. PROTOCOL.md changes with FL5, in the
same commits as the formats (`turns`, `clock.json`, the stamp rule, the reader's order).

**As built (FL5).** `packages/protocol/src/clock.ts`: `now()` (re-exported by the store, so every `at: now()` is a
stamp), `observe()`, `inFileOrder()` (a heap merge of the logs), `resetClock()`. The store observes what it reads of
events, inbox and applied; the CLI reads its session's events and inbox and `clock.json` when it resolves its session;
`AgentHost` writes `clock.json` before every `send` to a runtime (the server's file watcher ignores it); the engine
reads the worker's log before it stamps a run that stops going (`writeRun`), so `ended_at` and the
`step.interrupted` written right after come after the step's last event. `gitinfo.ts` `recordTurn` takes the HEAD at
the runtime's turn start and end (the engine's activity handler); `inTurns` asks `git rev-list` once per run of turns
with no commit between them. The turn record's `duration_ms` comes from `performance.now()`. Differences from the
plan:

- *A cap instead of a warning.* Times read more than 15 minutes ahead are not taken up (`CLOCK_AHEAD_MS`): with no
  cap one record stamped by a clock set far ahead (by hand, or a test's fixture) would hold every later stamp of the
  process there until the wall clock caught up. The steps Nexus meets are minutes.
- *The "since" filters were left as they are* (`reviewBrief`, `failedChecks`, the context summary's freshness,
  `summaryWritten`, `discardRecorded`, the orchestrator's notices): with rule 2 the records they compare are stamped
  after their cause, which was the failure. `stillEnding` still compares an agent's `finished_at` with the server's
  clock: after a forward step that the server sees late, a merge back may wait up to the step longer (no wrong state).
- *A test that sets its clock back on purpose* (node:test's mock timers, each case starting at the same time) calls
  `resetClock()`; Nexus itself never does.

**Tests.** `apps/server/test/clock-steps.test.ts` runs stop-at-once.test.ts and stopwork.test.ts again in one process
each (no isolation) with the preload `clock-lag.mjs`: the engine's clock 5 s and 240 s behind the system clock and
60 s ahead, its children (CLI, fake runtimes, git) on the system clock. Without the fix 6 of 11 failed at 5 s
behind (as at 240 s in FL2); with rules 1 and 2 alone, the two Keep/Discard tests still failed at 60 s ahead (a
commit's time behind the turn windows), until rule 3. `packages/protocol/test/clock.test.ts` covers the stamps, the merge, and old logs (a
worker's log across a backward step, an interruption between); stopwork.test.ts covers a round without `turns`.

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
