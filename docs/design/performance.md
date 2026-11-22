# The server's responsiveness

The server is one Node process: every request, every change notification, every decision of the engine and every
synchronous git call runs on its one event loop. While one of them runs, nothing else is answered: the dashboards and
every `nexus server …` call wait it out. This file says how the server measures that, and what the first measurement
found (queue SV).

## Measuring the server (queue SV1)

`apps/server/src/perf.ts` measures the server from its start, in memory:

- **The event loop's delay**: `perf_hooks.monitorEventLoopDelay` (10 ms resolution), since the start and since the
  last summary in the log.
- **Requests by route**: a middleware before every other times each request by the route that answered it
  (`GET /api/projects/:id/state`), its status, its whole time and its synchronous part (until the handler first
  waits: the part that holds the loop). A request of 200 ms or more is logged as slow.
- **Measured spans**: `perf.measure(what, fn)` times a synchronous piece of work. Measured now: each request's
  synchronous part, each state rebuild of the server's own (`state <project>`), each decision on a change (`engine
  (<project>)`, `orchestrator (<project>)`, …), making a project's engine (`engine start <project>`, which recovers its
  runs), and every synchronous git call of the server (`git <subcommand>`). A span counts under its path, so a git call
  says what it ran for (`GET /api/projects/:id/queues/:queue/git > git rev-parse`).
- **Blocks**: a ticker every 50 ms sees how late it fires. Fired 200 ms or more late, the loop was blocked that long;
  the spans that ended since the ticker's last turn say by what (the longest five). A block with no span in it ran in
  code nothing measures and is logged as such. A block is not always one long call: one turn of the loop that
  answers many requests in a row holds the ticker as long as all of them together.

The blocks and slow requests go to the server's log as they happen (`perf: event loop blocked 412 ms (…)`, `perf:
slow request …`), and a summary line every 10 minutes (the loop's delay in the window, the number of blocks, the
routes with the most time). `GET /api/server/perf` and `nexus server perf` give the numbers since the start
(docs/protocol/api.md, "Server API"). Taking them into the statistics is the benchmark queue's.

The state rebuilds the engine and the protocol's actions make themselves (`loadProjectState` called inside them) are
not measured one by one: the protocol does not know the server's measurer. They show inside the span that called
them (`engine (<project>)`, `engine start <project>`, a request's).

## The first measurement (2026-11-20)

`node scripts/perf-load.ts` (README.md, "Running") builds a development instance (port 4319, a temporary `NEXUS_HOME`,
the fake runtimes) with a project generated to the size of Nexus's own `.nexus` (its sizes read, never its files): 139
queues, 249 sessions, about 4,400 events, 28,000 activity lines, 6,400 chat lines, 30 MB of files. Two queues run on
the fake runtimes in worktrees of their own (eight 20-second steps each, the script accepting each step as the user);
three sessions' activity grows by a line every 400 ms, as the agent host appends a streaming agent's tool calls; two
dashboards read, on every change notification, what an open project page with a running queue's detail reads (12
requests: state, conversations, orchestrator, estimates, the project list, server, digest, usage, capacity, the
queue's git, the step's commits, the session's activity). Three minutes each, on the user's machine; a third run
without dashboards as a control (with no dashboard the script sees no step in review, so its queues waited there).

| | Quiet | Beside `npm test` | No dashboard |
|---|---|---|---|
| Start until the first answer | 36 s | 130 s | 36 s |
| Event loop delay p50 / p99 / max | 0.84 / 4.6 / 4.7 s | 2.8 / 20.5 / 20.5 s | 0.02 / 0.8 / 3.1 s |
| A state rebuild (`state big`) | 260 ms | 940 ms | 256 ms |
| The engine's decision on a change (`engine (big)`, mean) | 150 ms | 870 ms | 420 ms |
| A synchronous git call | 60 to 110 ms | 380 ms | 40 to 70 ms |
| What a dashboard waited for `state` (mean / p95) | 0.57 / 2.1 s | 6.9 / 18 s | |
| … for `server` (the header, after every notification) | 4.3 / 9.0 s | 24 / 38 s | |
| Changes the server handled in 3 minutes | 190 | 44 | 203 |

The delay's percentiles count samples, and a blocked loop gives one sample for its whole block: they understate how
much of the time the loop is held. The spans' sums say it better. Without a dashboard each change (each activity
line) cost about 800 ms (the engine's decision 420 to 520 ms, the rebuild 260 ms): about 140 s of 180, the loop held
three quarters of the time by the agents' activity alone.

**What dominates**, by the measured synchronous time in the quiet run (about 145 s of load after the start):

1. **Synchronous git: about 75 s, half of it.** Most of it is the dashboard's queue detail: `GET …/queues/:queue/git`
   runs five git processes (four `rev-parse`, one `rev-list`; 510 ms a request, 960 ms at most) and `GET
   …/steps/:step/commits` two or three (234 ms); both are read again on every change notification by every open
   dashboard. The engine's own (`rev-parse`, `status`, `branch` around turns and steps) added about 80 `rev-parse` calls and a few others. On
   Windows starting a process costs 60 to 100 ms by itself, and 380 ms beside the test suite.
2. **The startup: 36 s with the loop blocked, 124 s beside the suite.** Making the engine recovers its runs:
   `recoverAfterRestart` calls `releaseOrphanedSteps` for every queue, and each of those rebuilds the whole project
   state (`loadProjectState`): 139 rebuilds. A CPU profile of the start put 44.3 s of 45 s there (15 s in
   `existsSync`, 17 s parsing YAML, 5 s reading files). Every deploy restarts the live instance through this: its
   dashboards and its agents' CLI calls to the server wait that long.
3. **State rebuilds: about 37 s, a quarter.** One per change notification (an activity line of a streaming agent is a
   change: the watcher sees `activity.jsonl` grow), one more after each write of the server's own (`writeCount`), and
   the engine's own inside its decisions (`engine (big)`: 150 ms a change on average while its queues ran, 420 to
   520 ms while they waited in review; what inside it costs that much is not measured yet). A rebuild reads
   the whole project: 260 ms on this project, against 120 ms on 70 queues a week ago (state.md, "The cost of rebuilding
   state").
4. **Full reads per request: smaller.** `GET /api/digest` 108 ms and `…/conversations` 64 ms on every notification;
   the rest under 5 ms once the state snapshot is there.
5. **The dashboards' re-reading multiplies all of it.** 190 notifications in three minutes, each making each
   dashboard read 12 endpoints: about 4,500 requests, 87 s of synchronous time. `GET /api/server` is cheap itself
   (its two git calls are asynchronous) but waits for the loop: 3.5 s on average at the server, 4.3 s at the
   dashboard, after every notification.

Beside the full test suite everything takes three to four times as long, while the notifications come as often: the
server falls behind (44 notifications answered instead of 190), the loop is blocked for seconds at a time, and the
dashboard answers in 7 to 24 s. That is the state the live instance is in while a step's checks run.

**Proposed order for the following queues:**

1. **Asynchronous git for the dashboard's reads** (`gitinfo.ts`: `branchState`, `stepCommits`, `leftBehind`;
   `files.ts` `commitDetail`), and fewer calls: one `rev-parse` with several refs instead of four processes, the
   answer cached per queue until its HEAD or refs change. Reads only, so no order or atomicity of a write changes;
   the engine's and the merges' git calls stay synchronous until each is looked at on its own (the queue's stop
   condition).
2. **The startup: one state for the recovery.** `recoverAfterRestart` loads the state once and passes each queue's
   view to `releaseOrphanedSteps` (rebuilding only after a queue it changed). Lifecycle code: the `lifecycle`
   template follows.
3. **Fewer rebuilds and decisions per change**: activity lines (the agent host's appends, and the watcher's events for
   `activity.jsonl`) change no derived status, so they need not invalidate the snapshot nor run the decisions; a
   rebuild that reuses the parsed files of a previous one (by modification time) next. Planned in queue SM: items 2
   and 3 in [model.md](model.md#the-two-findings-of-the-measurement-and-the-step-that-removes-each).
4. **The dashboard's reads**: `/api/server`'s version cached (it changes only with a restart or a checkout), the
   queue's git and commits read only for what is open and not again for a notification that changed nothing of the
   queue's; the digest and conversations from the snapshot.
5. **Process priority** (the queue's last part): the test suite's processes below the server's, once the server's own
   blocking is down; measured again then with the same script.

## The dashboard's git reads without holding the loop (queue SV2)

What the dashboard reads from git now runs in git processes the loop does not wait for (`gitAsync` in
`apps/server/src/gitinfo.ts`, the same 10 s limit and output limit as before): a step's commits (`stepCommits`, behind
`GET …/steps/:step/commits`), a queue's branch (`branchState`, `GET …/queues/:queue/git`), what a stopped step left
(`leftBehind`, `GET …/queues/:queue/left`) and one commit by its hash (`commitDetail`, `GET …/commits/:hash`). Their
independent calls run side by side (the base's and the upstream's counts, each round's log and turn ranges). They only
read, so nothing can fall between two of their operations that matters: each answers from what it read.

Continue and the approval of a stopped queue decide by what the stopped step left. They read it first (asynchronously,
`readStoppedWork` in `src/stopwork.ts`), then check, decide and write in one synchronous go as before; a queue stopped
at another step by then is refused with "try again" (it was read for another stop), so a choice is never recorded
against work that was not shown. The dashboard still waits for the action's answer, as before.

`perf` counts such work apart, as `async git <subcommand>`: its whole time, never part of a block.
`apps/server/test/slow-git.test.ts` slows `git status` with an fsmonitor hook that sleeps 3 s: the stopped step's
`/left` takes that long, and `/api/projects` asked meanwhile answers at once (with the synchronous git it waited the
whole time: the test fails so).

**Before and after**, `node scripts/perf-load.ts --minutes 3` on the user's machine, the same load as SV1's quiet run:

| | Before | After |
|---|---|---|
| Event loop delay p50 / p99 / max | 0.87 / 5.3 / 5.7 s | 0.016 / 2.4 / 3.2 s |
| Synchronous git, all of it | 53 s | 10 s |
| Changes the server handled in 3 minutes | 190 | 354 |
| What a dashboard waited for `state` (mean / p95) | 0.68 / 1.9 s | 0.19 / 1.2 s |
| … for `server` | 4.3 / 8.6 s | 1.4 / 4.6 s |
| … for the queue's git / the step's commits (mean) | 1.3 / 1.5 s | 2.4 / 1.5 s |

The loop is free most of the time now and the server keeps up with twice the changes; the remaining blocks are the
state rebuilds and the engine's decisions (SV1's items 2 and 3). The queue's git answers no sooner: with the loop free
the dashboards ask more often, and up to a dozen git processes run at once (778 `rev-parse` in three minutes, 0.5 s
each on average, up to 4.7 s): the number of calls per read, SV1's item 4, is what is left there.

**What stays synchronous, and why.** The git calls on the engine's path read and then write at once, and the engine
relies on nothing else happening between: made asynchronous, another change could fall between the read and what
follows it (the queue's stop condition). They are described in the queue's stop and wait for the user's decision:

- `recordStepStart`, `recordStepEnd`, `recordTurn` (`gitinfo.ts`): the HEAD read at a step's opening is recorded
  before the worker hears of the step, and at a turn's start and end as the runtime reports them. Read later, a
  commit the worker made meanwhile would count as before the round, or the next step's as this one's; and two records
  of one queue (a turn's end and the next turn's start) could be written in the other order.
- The integration step Nexus runs without a model (`engine.ts` `integrateWithoutModel`, `integrateAgain`;
  `integration.ts` `cleanCheckout`, `mergeConflicts`, `mergeBase`): `step.started`, the merge, `step.done` and the next
  step's opening are one synchronous go. Between them the engine's own decisions on a change, or a Stop of the user,
  would see a step started with no process at work (the state a restart leaves, which `integrateAgain` handles by
  aborting the merge).
- A worktree's creation (`worktree.ts` `worktreeFor`, `recordBase`) and its setup's HEAD, before the worker's
  session is written and started; a fresh session's hand-over (`engine.ts`, its commits and uncommitted changes);
  the closing step's commit range (`closing.ts`) and the integration context, read while the step opens.
- The HEAD a step was reviewed at (`accepted.ts` `recordReviews`): read later, a next step's commit could be pushed
  as the reviewed one.
- Merge back (`mergeback.ts` `fastForward`, `reintegrate`, `cleanUp`, under `withMergeLock`, a lock held only while the
  synchronous call runs) and the planned deploy's check (`deploy-plan.ts`, a decision in the order of `changed()`:
  before the engine's, so the engine sees a run held for the deploy).
- Elsewhere on the engine's path: a step's left work in a survey (`surveyLeftWork`), the checks' setup HEAD
  (`check-runs.ts`), Codex's git directories at its start (`codex.ts`), the review helper's diff (`review-helper.ts`).
- Not the server's: `findNexusDir` in `packages/protocol/src/store.ts` (the CLI finding its project from a worktree;
  the server never calls it).

## The engine's git calls: fewer, still synchronous (queue SV2B)

The user decided (2026-11-20) that the engine's git calls stay synchronous, with no per-queue serial executor: they
are made fewer, their order and atomicity as they were. What changed:

- **A step's opening** (`engine.ts` `openStep`): the step before's round end and this step's round start read HEAD
  once (`headOnce` in `gitinfo.ts`): one `rev-parse` where there were two. They are one synchronous go with only
  reads between (the closing step's range, the integration context): a second read gives the same HEAD, unless another
  program commits within those milliseconds, and then the rounds meet at the first read instead of leaving that commit
  to neither.
- **The base merged at a step boundary** (`integration.ts` `pullBase`, every step of a queue with a worktree of its
  own): HEAD and the clean checkout from one `git status --porcelain=v2 --branch` (`checkoutStatus`), the base's commit
  from the `rev-parse` of the base branch already made, the queue's branch no longer read (a pull does not name it),
  and the "already contains the base" test by `rev-list --count HEAD..base` (0: contained), whose count the merge's
  record uses too. Six git calls in the common case (nothing to bring) became three; a merge saves one more.
- **The integration step without a model** (`integrateWithoutModel`): the clean checkout and HEAD from one call, that
  HEAD for the round records and the merge's start, the base's commit from the context, the merge test (`merge-tree`)
  made once instead of twice (a merge that conflicts after all is still caught by the merge and aborted), and the
  step's round ends at the merge's result instead of reading HEAD again: 16 git calls became 10 on a clean merge.
- **A check set's start** (`check-runs.ts` `startSet`): HEAD and the dirty flag from one `status` call.

What stays as it was, and why:

- `recordTurn` (each turn's start and end): one `rev-parse` each, already the least; each records its own moment.
- `recordStepEnd` at a turn's end (after the settle time) and `recordStepStart` for a send-back or check-fix round
  (`deliverInbox`): one read each, at a moment of its own; nothing to share.
- `accepted.ts` `recordReviews`: one `rev-parse` per step entering review. The round's recorded end is not the same
  moment (it is written after the turn's settle time, in no fixed order with the review's), so it is not reused.
- A worktree's creation (`worktreeFor`, `recordBase`): once per queue. `recordBase`'s branch test could give the sha
  too, but for a name both a tag and a branch git resolves the tag first: the recorded base would change.
- The integration step's opening for a worker (`integrationContext`, `withConflicts`) and the hand-over to a fresh
  session (`switchMidStep`): rare, and their reads differ (branch names, log, status, diff).
- Merge back (`mergeback.ts`) and the planned deploy's check (`deploy-plan.ts`): user actions or a due plan, under the
  merge lock; not on the path of every change. Codex's `gitWritableRoots` (one call per process start), the review
  helper's diff (per review) and the survey's left work (once per step) likewise.

**Before and after**, `node scripts/perf-load.ts --minutes 3`, the same load as SV2's (two queues in worktrees of
their own, each step a boundary with a base pull):

| | Before | After |
|---|---|---|
| Synchronous git: calls / time | 130 / 9.2 s | 106 / 6.5 s |
| Steps accepted in 3 minutes | 16 | 22 |
| Synchronous git calls per accepted step | 8.1 | 4.8 |
| … by kind | rev-parse 92, status 18, branch 10, merge-base 8, worktree 2 | rev-parse 72, status 20, rev-list 10, branch 2, worktree 2 |
| Event loop delay p50 / p99 / max | 19 ms / 3.9 s / 4.1 s | 18 ms / 2.6 s / 3.4 s |
| Changes the server handled in 3 minutes | 286 | 356 |

The engine's git was a small part of the loop's time already after SV2 (about 9 s of 180); the blocks left are the
state rebuilds and the engine's decisions (SV1's items 2 and 3). The loop's percentiles vary between runs more than
this change moves them.

## Below normal priority for tests and workers (queue SV3)

Beside the full test suite the server answered three to four times slower (SV1): the suite's processes take every
core, and the server's one thread and its git processes wait their turn among them. Two ways to give the server the
edge on Windows were weighed:

- **The server above normal.** One process to change, but only its own thread gains: the git processes it starts
  (380 ms each beside the suite) and the fake or real agents stay normal and keep waiting among the tests, and above
  normal is not inherited on Windows. It would also put the server ahead of the user's own programs (an editor, a
  browser), and the live instance would need a restart through its start scripts to get it.
- **The tests below normal (chosen).** The checks Nexus runs and every worker's tree (the runtime, and the tests,
  builds and tools it starts) run in the Windows job of `worker-job.cs`, which now limits its members' priority class
  to below normal (`JOB_OBJECT_LIMIT_PRIORITY_CLASS`): every process of the job, whatever starts it, and none can
  raise its own. The server, its git processes, the orchestrator and the conversations stay normal and go first; so
  do the user's own programs. Elsewhere (Linux, macOS) the server sets the nice value of the process it starts
  (`belowNormal`, `PRIORITY_BELOW_NORMAL`), which its children inherit.

The server turns it on at its start (`lowerOwnedProcesses(true)` in `main.ts`), and the job host applies the limit only
when told (`NEXUS_JOB_BELOW_NORMAL`). An engine made in a test process leaves it off: in the full suite the test
files run the engine in-process, and their fake workers below normal fell behind the suite's other files at normal
priority (a full run started in a terminal, or Nexus's checks before the change is deployed): three tests near their
time limits failed in SV3's checks.

What it changes for the rest of the machine: Nexus's tests and workers give way to every normal program. On a machine
busy with something else they run slower than before (and a timing-sensitive test with them); on an otherwise idle
machine a lower priority class changes nothing, the cores are free. A full `npm test` started in a terminal by the
user, and anything outside Nexus, runs as before. The test suite's parallelism is unchanged.
`apps/server/test/capacity.test.ts` and `worker-job.test.ts` read the priority of a granted process, of its child and
of a worker runtime: below normal.

**Before and after**, `node scripts/perf-load.ts --minutes 3` beside a full `npm test`: before at normal priority,
started in a terminal; after as a Nexus check runs it (the launcher of `check-runs.ts` in the job of `worker-job.cs`),
its 32 test processes shown "BelowNormal". The fake agents of the measured instance run in such jobs too, so they
were below normal in the second run as well.

| | Before | After |
|---|---|---|
| Start until the first answer | 133 s | 82 s |
| Event loop delay p50 / p99 / max | 0.50 / 12.9 / 13.4 s | 0.19 / 7.3 / 8.1 s |
| A state rebuild (`state big`, mean) | 939 ms | 587 ms |
| The engine's decision on a change (`engine (big)`, mean) | 781 ms | 486 ms |
| A synchronous `git rev-parse` (mean) | 465 ms | 348 ms |
| Changes the server handled in 3 minutes | 56 | 110 |
| What a dashboard waited for `state` (mean / p95) | 3.8 / 12.6 s | 1.3 / 3.8 s |
| … for `server` | 14.4 / 30.2 s | 7.4 / 16.9 s |
| … for the queue's git | 27.4 / 43.6 s | 12.3 / 23.0 s |
| The full suite itself | 813 s, 1425 passed | 820 s, 1426 passed |

The server keeps up with twice the changes and answers in a third of the time, but it is still two to three times
slower than on a quiet machine (a rebuild 587 ms against 260 ms): below normal gives way only where the processor
has a choice, and the suite's disk and memory traffic and its git processes are not prioritised by it. The suite took
as long as before: on this machine nothing else wanted the cores it gave way on.

## The measurement after the model, and the worker thread (queue SW)

The user's decision of 2026-11-18 put the processing of agent output, the ingesting and the round of decisions on a
worker thread; queue SM built the model on the event loop and left the thread to a measurement after SM4
([model.md](model.md#beyond-the-decision-proposals-not-decided)). SW1 measured (2026-11-21) and weighed it.

**The measurement**: `node scripts/perf-load.ts --minutes 3` at main's `01cb79b` (after SM4 and MF), the same load as
SV1's quiet run, on the user's machine with nothing else at work.

| | After SM4 (`01cb79b`) |
|---|---|
| Start until the first answer | 1.1 s |
| Event loop delay p50 / p99 / max | 15 ms / 117 ms / 767 ms |
| Blocks of 200 ms or more | 31, 12.2 s together (7% of the three minutes) |
| A derivation of the state (`state big`: count, mean, max) | 87, 61 ms, 352 ms |
| The decisions on a change (`engine (big)`: count, mean, max) | 46, 32 ms, 152 ms |
| Synchronous git (calls, time) | 156, 8.6 s (110 `rev-parse`, 28 `status`, 14 `rev-list`, 2 `worktree`, 2 `branch`) |
| The requests' synchronous time (count, sum) | 9,827, 45 s |
| What a dashboard waited for `state` (mean / p95) | 67 / 109 ms |
| … for `server` / the queue's git (p95) | 429 / 691 ms |
| Notifications; steps accepted | 1,077; 14 |

**What the blocks are**, by the spans each names:

- **A step's boundary, 22 of 31 (203 to 667 ms).** The engine's synchronous git as a step ends and the next opens (a
  turn's end after its settle time: `recordStepEnd`, the base pull's `status` and `rev-list`, the round records'
  `rev-parse`; `engine (big)` with its `rev-parse` inside on the next change): six to eight git processes of about
  50 ms each. They come in pairs: the load's two queues run 20-second steps started together. The user kept them
  synchronous (SV2B). A real step lasts minutes to an hour, so in use they come far more rarely than here; beside the
  full test suite each git process took about 350 ms (SV3), a boundary 2 to 3 s.
- **A derivation, 4 (283 to 494 ms)**: `state big` of 280 to 350 ms where its mean is 61 ms (three blocks), and one
  request's derivation of 317 ms.
- **The start, 5 (291 to 736 ms)**: making the engine (444 ms, once), the two queues' worktrees (`git worktree`, 170 ms
  each, with their `rev-parse`; once per queue) and the first requests' derivations (411 ms).

What holds the loop most is not a block: the dashboards' reads (45 s of synchronous time in 9,827 requests, a quarter of
the three minutes: two dashboards reading 12 endpoints on each of 1,077 notifications, `state` 16 ms, `digest` 14 ms,
`conversations` 10 ms each).

**What a worker thread would cost.** The state of the measured size, copied between threads (`v8.serialize` in one,
`deserialize` in the other, on the synthetic `.nexus`: model.md, "The gate"):

| | 1× | 4× |
|---|---|---|
| The state's size (serialized) | 7.3 MB | 30 MB |
| A derivation from memory (median) | 48 ms | 197 ms |
| Serializing it / deserializing it (median) | 10 / 17 ms | 48 / 67 ms |
| `structuredClone` (median) | 23 ms | 121 ms |

- **The decisions cannot be parted from the model.** The engine, the orchestrator, the merger and the user's actions
  read the state and write in one synchronous go (SV2B; `stopwork.ts`'s read, check and write). With the model in a
  worker and the decisions on the request thread, each of their reads becomes asynchronous and something else can fall
  between a read and its write; made synchronous again (`Atomics.wait`) the request thread waits as long as now.
- **So everything that writes would go to the worker**, or a file would get a second writer (the queue's stop
  condition): the engine, the agent hosts (they write `runtime.json` and the activity), the orchestrator, the
  conversations, the merger, the actions, the git calls. The request thread would keep the HTTP and WebSocket handling
  and a copy of the state: each change costs it a deserialization (17 ms; 67 ms at 4×, plus freezing the copy) in place
  of the derivation (61 ms here), and the worker a serialization on top of the derivation. Every route that reads logs
  or files through the model (activity, chats, the digest, conversations, ideas, search) becomes a message to the
  worker and back, or the request thread keeps a second model and a second watcher.
- **What it would win**: the boundary's git and the derivations no longer hold the GET routes that read the copy. It
  would not shorten what the user waits for after an action (a POST goes to the worker and waits for its loop as now),
  nor the dashboards' 45 s of reads, which stay on the request thread.
- **What it would risk**: the agents' pipes and timers live in the worker's loop; a worker that fails takes its agents'
  output with it, and restarting it is a restart of the engine (the recovery) without the process ending. Lifecycle code
  throughout (`engine.ts`, `agent-host.ts`, `handover.ts`, `lifecycle.ts`): a large change.

**Proposed: no worker thread now.** The loop's p99 is 117 ms and a dashboard's `state` p95 109 ms; the blocks left are
the step boundaries' synchronous git, the user's choice of SV2B, which a worker would only move, and a derivation's
outliers. The targeted proposals below (a step boundary's `rev-parse` read from the repository's files instead of a
git process, the boundary measured as a span of its own, the dashboards' reads keyed on the version) take what is left
for a fraction of the change. The worker thread is worth weighing again when a
derivation from memory on the live project passes about 150 ms on average (`nexus server perf`, `state <project>`: the
4× history costs 197 ms) and a derivation per queue cannot bring it down.

**Beyond the decision (proposals, not decided):**

- **A step boundary's HEAD and refs read from the repository's files**: 110 of the 156 synchronous git calls were
  `rev-parse`, about 50 ms each (350 ms beside the test suite) for what `.git/HEAD`, the worktree's `gitdir`, a loose
  ref or `packed-refs` say in microseconds. Still synchronous, in the same order (SV2B's decision kept); git itself
  where the files are not plain (a reftable repository, an unknown ref, a ref expression).
- **The step boundary measured as a span of its own**: the turn's settle timer in `engine.ts` (`turnEnd`:
  `recordStepEnd`, `advance`, the next step's opening) runs outside `changed()`, so 17 of the 31 blocks name only their
  git calls; a span (`engine turn end (<project>)`) would name what ran them.
- **The dashboards' reads keyed on the version**: after the model they are the loop's largest load (45 s of synchronous
  time in three minutes, two dashboards); `state`, `digest`, `conversations` and `estimates` could answer "not
  modified" for a version the dashboard already holds, short of the deltas (planned in queue SD: [live.md](live.md)).
- **A derivation's outliers**: `state big` took 280 to 350 ms three times against a mean of 61 ms; whether that is the
  garbage collector over the model's heap (`--trace-gc` on the load) is to be seen before a derivation per queue.
- **The load beside the full test suite again**: SV3's figures predate the model; the step boundaries' git is where that
  load would hurt most (2 to 3 s a boundary).
- **The worker thread again** when a derivation from memory on the live project passes about 150 ms on average, with
  this section's costs measured again at that size.

## The step boundary's reads from the .git files (queue GB)

SW1 found most blocks at a step's boundary: six to eight git processes of about 50 ms each, kept synchronous by the
user's decision (SV2B). GB keeps them synchronous and in the same order, and reads from the files of the checkout's
`.git` what git would only read there.

**The measured section.** `perf.section(what, fn)` (`perf.ts`) is a measured span with statistics of its own: its
runs and time, and the synchronous git calls made within it by kind, counted once however nested
(`GET /api/server/perf`'s `sections`, `nexus server perf`, and `scripts/perf-load.ts`'s report). The step boundary is
three sections:

- `step boundary: end`: the turn in which a step got its outcome, after its settle time (`recordStepEnd`, the
  engine's next look);
- `step boundary: review`: the step's HEAD recorded as it enters review (`accepted.ts` `recordReviews`);
- `step boundary: open`: the engine going on once the step has ended (`engine.ts` `goOn`): the planned deploy's
  look, the base merged in (`recoverPull`, `pullBase`), the setup, and the next step's opening (`openStep`).

**The reader** (`gitfiles.ts`): `refFromFiles(cwd, name)` gives what `git rev-parse <name>` gives for a full ref name
(HEAD, MERGE_HEAD, `refs/heads/<branch>`), `branchFromFiles(cwd)` what `git branch --show-current` gives. The
checkout's `.git` is a folder, or a file `gitdir: <path>` (a worktree; absolute or relative) whose folder names the
shared one in `commondir`. A ref is a loose file (a sha, or `ref: <other>` followed to git's depth of five), else a
line of `packed-refs`; HEAD, the pseudo-refs (MERGE_HEAD) and `refs/worktree/`, `refs/bisect/`, `refs/rewritten/`
are the worktree's own, the rest are shared. `gitinfo.ts` `revParse` asks the files first and git when they cannot
tell; `worktree.ts` `gitBranch` likewise. It serves the round records (`recordStepStart`, `recordStepEnd`,
`recordTurn`, `headOnce`), the review's HEAD, the base branch's commit (`baseBranch`), the half-done merge's test
(`recoverPull`), the HEAD after Nexus's merge (`mergeBase`), the survey step's left work and the integration fix round's HEAD.

The files are not asked, and git is, where they might not say what git says: a checkout without a `.git` of its own
(git would look in the folders above), `GIT_DIR` or another variable that moves the repository, the reftable ref
storage, a ref name that is not a full one, and a file that cannot be read or holds something unexpected (a write in
progress on Windows, a hand-made ref). Git refusing a repository of another owner (`safe.directory`) is the one case
the files answer where git would not; Nexus's own processes and its workers run as one user, so it does not arise.

**What stays git**, and why: `git status` (whether the tracked files changed needs the index compared with the files),
`git rev-list --count` (whether HEAD contains the base needs the commit graph), `git merge-tree` and the merge itself.
A commit's existence (`^{commit}`, `--verify` of a sha) needs the object database: loose objects, packs and their
indexes, alternates; `recordBase` (once per queue) keeps it. Reads off the boundary (a hand-over's log, the setup's
HEAD, the dashboard's asynchronous reads) are unchanged.

**Before and after**, `node scripts/perf-load.ts --minutes 3` (the same load as SV1's quiet run: two queues in
worktrees of their own, each step a boundary with a base pull), on the user's machine:

| | Before (`57cd2b8` with the sections) | After |
|---|---|---|
| A step boundary (the three sections together, mean) | 529 ms | 265 ms |
| … `end` / `review` / `open` (mean) | 105 / 54 / 370 ms | 50 / 3 / 213 ms |
| Synchronous git processes per boundary | 7 (5 `rev-parse`, `status`, `rev-list`) | 2 (`status`, `rev-list`) |
| … their time per boundary | 376 ms | 107 ms |
| Blocks of 200 ms or more (count, time together) | 41, 15.7 s | 24, 8.2 s |
| … naming the step boundary (count, range) | 21, 208 to 699 ms | 15, 229 to 484 ms |
| Event loop delay p50 / p99 / max | 15 / 133 / 749 ms | 15 / 127 / 596 ms |
| Steps accepted; notifications | 14; 1,170 | 14; 1,240 |

What is left of a boundary is its `status` and `rev-list` (about 50 ms each) and the state derivations the engine and
the requests make around it (`state big`, 50 to 300 ms): the blocks that still name the boundary are those, together
with the requests answered in the same turn of the loop. Beside the full test suite a git process took about 350 ms
(SV3), so each `rev-parse` the files now answer saved that much there.
