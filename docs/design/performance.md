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
   rebuild that reuses the parsed files of a previous one (by modification time) next.
4. **The dashboard's reads**: `/api/server`'s version cached (it changes only with a restart or a checkout), the
   queue's git and commits read only for what is open and not again for a notification that changed nothing of the
   queue's; the digest and conversations from the snapshot.
5. **Process priority** (the queue's last part): the test suite's processes below the server's, once the server's own
   blocking is down; measured again then with the same script.
