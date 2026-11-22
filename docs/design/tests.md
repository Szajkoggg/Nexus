# Tests

Part of [the design](../DESIGN.md).

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
- **A moment the product measures from the runtime's event is the test's when its fake acts after the engine**
  (`EngineOptions.lateTurnMs`, Claude's `lateTurnMs`, default 1.5 s: how long after a turn's result the CLI may still
  start a turn of its own). The late-turn test (context-care.test.ts, queue LF, F3) starts that turn only once the
  engine shows it waits, so the turn begins as long after the result as the engine takes to look: 0.5 s alone, 1.0 to
  1.7 s under load, past the default (queue CI3). The test holds the moment open and its gate decides when the turn
  starts; every other test keeps the default. The orchestrator's and the partners' processes take it from
  `AgentHostOptions.lateTurnMs` (queue LH), for every Claude launch that sets none; with `FAKE_LATE_NEXT=inside` the
  fake reads the message inside its turn, so a test reaches the settling that ends with no late turn (`settled`).
- **The workers' cleanup barrier has one stand-in** (gated-cleanup.ts, queue LH): `gatedCleanup()` makes the fakes'
  processes with every cleanup counted (`calls`, each with whether the process had run a turn) and passed through a
  gate the test holds, releases or makes fail; `failBeforeTurn` fails the cleanups before a first turn, as a busy
  machine's slow job host does.
- **A server that ends between two writes** is `ProjectStore.faultWrites({ file, after })` (queue LH): the named file's
  writes past the first `after` throw, in this process, leaving the file as it was and no temporary file, until
  `clear()`; no file contents forged by hand.
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

## Findings from the tests that failed or hung in full runs (queue FL)

- **A failed test must not keep its file running** (limit-hold.test.ts). The suite runs with `--test-timeout=0`, so
  a file ends only when nothing keeps Node up. A watcher's `setInterval` cleared only on the success path, or an
  `Engine` never shut down (its startup timer arms the recurring and reminder timers, which re-arm forever; tried: a
  file whose only test made one and passed did not exit in 40 s), held the whole run until someone killed it. Every
  timer, engine or server a test starts is stopped on every path: `t.after`, or a `try` that begins right after it
  with the stop in `finally`, and no assertion or `await` between the two.
- **"Not yet" after a wait for something else races the code under test** (limit-hold.test.ts, "a queue back from
  its answer"). The test waited for the held queue to go on, then asserted that the planned start had not started.
  But a fake answer turn ends at once: under load the test looked 1.5 s late, the queue had already used its place
  and gone to review, and the planned start had rightly taken the place it freed (9 of 12 load runs failed). The
  engine kept the limit throughout. A test that asserts something has not happened yet holds the state it relies on:
  the answer's turn now works until the test releases it (fake behaviour `askslow`).

## Findings from four tests that failed once in full runs (queue KM)

- **A reply is not the end of its turn** (languages.test.ts, the thinking partner's reader's language). The test
  changed the settings as soon as the first reply was in the chat, but the turn ends a moment later, with its result.
  A message sent in between goes into that turn, to the process it runs in, and the new settings count from the
  message after (as designed), so under load the second reply came from the old process (1 of 30 load runs). The test
  now waits for the turn's end (`conversations.idle()`). The same race showed a fault in the product: the stale
  process was restarted at the turn's end even while the message sent into the turn could still run as a turn of its
  own (Claude Code runs a `next` message that came too late for the turn after it), and the kill took the message
  with it: no reply, ever. AgentHost now waits for the settling moment (AgentProcess.settling) before such a restart,
  and a settling partner gets the message without a restart (conversations.test.ts, FAKE_LATE_NEXT with FAKE-SLOW, so
  the late turn takes a moment as the CLI's does; without that the fake's reply was already in the pipe at the kill).
- **A log a fake creates must not be seen empty** (orchestrator.test.ts "the orchestrator gets Nexus's helper agents",
  agent-changes.test.ts "the orchestrator that ran the update gets its outcome"). Both failed with "Unexpected end of
  JSON input" on the first line of FAKE_ARGS or FAKE_LOG: the file existed but was empty. appendFileSync creates the
  file and writes it in two calls, and a test that polls for the file can read it in between. Not reproduced: 78 and
  30 load runs passed, and a probe (a writer creating 1200 files under 16 busy cores, a reader polling each) never saw
  one empty; it needs the writer held between the two calls, as a full run's hundreds of processes do. Concurrent
  appends of several fakes to one log are atomic (6 processes, 12000 lines, none torn). The fakes now bring a new
  log into place with its first line in it (written beside it, then hard-linked; appended when another process made
  it meanwhile).
- **Not found: the partner not resumed after an update's hand-over** (chat-update.test.ts, "--now: …", twice in queue
  AC). The successor resumed the worker and the orchestrator but sent the partner nothing within 60 s. Not reproduced
  in about 55 load runs (alone and beside other files). Ruled out: lost appends, a record cleared before the hand-over
  (only resumeCutOff clears it). The pattern fits an exception in the successor between the orchestrator's resume and
  the partners' (activate runs them in turn), which would also end it. The test now gives the successor a log of its
  own and, on a failure, prints its tail, the partner's chat and record, and the successor's crash.json (queue KM3).

## Volume shadow copies stop the tests (queue CI4)

Four engine tests of one full run (integration-free, lift, plan, question-barrier) failed in the same four seconds,
each "timed out waiting for …" with its run's `updated_at` frozen; alone, and under `scripts/load-tests.mjs`, they
pass. The cause was the machine: Windows made a volume shadow copy of C: (the scheduled task
`\Microsoft\Windows\Setup\PITRTask`, Windows' Point-in-time restore, daily about 18:44), and while one is made, file
writes on the volume stop. For those 32.5 s the whole suite (about 15 test files at once) wrote 3 files under
`%TEMP%`, against 3 to 60 a second before and after. Every test then in a wait shorter than the stall timed out
together: the fakes, the `nexus` CLI and the engine all write files. The same machine also makes copies for a Dell
backup (`esentutl … SRUDB.dat /vss`, 01:00 and 12:00) and for Windows Update, and they took longer each day as the
copies piled up: 1.5 s (2026-11-17), 8 to 12 s, 13 to 27 s, 32.5 s (2026-11-20). Two more full runs failed in a copy
(11.4 s and 11.8 s). Load alone never stopped the tests together: under load they fail one by one, from slowness.

Nexus cannot prevent a copy (turning off Point-in-time restore or removing old copies needs an administrator, and is
the user's), and a longer wait would only hide it. It **recognizes** one instead: after a check's run fails on
Windows, the check runner reads the event log for copies made meanwhile (src/snapshots.ts) and keeps them with the run
(`snapshots` in checks.yaml, docs/protocol/checks.md, "Checks run by Nexus"); the check-fix round's text and an
accepted failure's fix queue say so beside the failing tests ("While it ran, Windows made a volume shadow copy (at …,
32.5 s, asked by taskhostw.exe): …"). A failure whose tests timed out within that time is the machine's: the worker
disputes it, and nobody debugs the tests.

How to see one by hand (no administrator needed): the Application log's VSS event 8231 (who asked: its second field
is the command line), Microsoft-Windows-VolumeSnapshot-Driver/Operational event 126 (the copy begins; its second field
is the shadow copy's id) and Microsoft-Windows-Ntfs/Operational event 4 mounting `\Device\HarddiskVolumeShadowCopyN`
(it is made; its first field is the same id). The messages are in the system's language, so src/snapshots.ts reads
the fields by position. A gap in the write times of the files under `%TEMP%\nexus-*` shows the stall itself.

## Waits for a stretch, not for a whole run; a window on the test's clock (queue CI8)

Four tests failed in full runs without a volume shadow copy (integration-free's check-fix and conflict tests,
engine-checks' P3, context-care's fallback summary), each in one `LONGER.run` wait (30 s) for a whole run. Such a run
is a chain of 12 to 20 processes started one after another (the worker's job host, the fake's `nexus` calls, the
stand-in checks, git), and load stretches every one of them alike: 5.3 s alone, 22 to 26 s under
`scripts/load-tests.mjs`, 30 to 41 s in a full run. Nothing waited in line (the capacity coordinator granted within
22 to 104 ms; each test has its own full-test lock) and the engine never stood still: the wait covered too much, and the
suite as a whole slowing (618 s to 1070 s in three days, for 10 % more tests) moved the chain past it. The waits are
now one per stretch (a step done, a check set failed, the fix round's set, the end), each a few processes under the
same limit, rather than a longer limit for the whole.

plan.test.ts ran a real 3 s undo window and checked it after real sleeps; a test process that got no CPU for 1.5 s saw
the queue started "within" the window, or its undo refused as "its time is over". The window is now on a `TestClock`
(apps/server/test/test-clock.ts, the engine's `clock` option), moved by the test; a test whose orchestrator is told of
decisions made since its session began moves the clock up to the real time first.

## The tests read through the model (queue MF)

The model's reads are read-only (docs/design/model.md, "Its reads are read-only"). Every test file's stores read
through a model (`apps/server/test/model-reads.ts`, loaded by `npm test`, `test:times`, `test:files` and the load
tool), so a change of what the model hands out fails a test as it would fail the server, in one run
(`model-reads.test.ts` fails if the preload is not loaded).

- **Other processes' writes are seen at the next read.** The server reads them through its watcher; a test reads at
  once after a server it started answered, or after a `nexus` child ended, before any watcher could report (in the
  first full run so, `guard.test.ts` read the project's old name after the server renamed it). So the preload's model
  looks before each read whether what it holds changed on disk: the files and folders it read, by a stat (id, size,
  time), the paths it probed, and every log's size; and before the state is read, all of them. Nothing is read again
  unless it changed, and the state is still derived once per change and shared. A test needs no `wrote(path)` for a
  file it writes itself outside the store. The watcher's own feeding is no longer what these tests show; the servers
  the API tests start run the server's model as it is, fed by its watcher alone.
- **A file that compares the model with the files themselves**, or counts the files' reads (`model.test.ts`,
  `work-gate.test.ts`), calls `useProjectReaders(undefined)`: its plain stores read the files.

MF1's survey (the full suite through the model, with every node process recording each write to a frozen object,
caught or not, through an in-process inspector paused on every exception; and a review of `apps/server/src` and
`packages/protocol/src`) found no other change in the code; two tests bent the state they read, and now copy it.
Running the suite through the model by default did not make it slower: 734 s before, 634 s and 661 s after (the
first before the preload looked at the files on disk), one `npm test` each on the same machine under its other load
(`ℹ duration_ms`); the difference is within what that load moves a run by.
