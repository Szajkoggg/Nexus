# Tests

Part of [the design](../DESIGN.md).

See also: [Full test runs on the machine](test-runs.md): the lock, its lease and the machine probe.

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
  starts; every other test keeps the default. The moment's end itself is decided after the loop turn's I/O
  (`setImmediate` in its timer, queue LH): a server loop stalled past it ran the expired timer before the output that
  came meanwhile, and a late turn started in time was taken for none (claude-settling.test.ts stalls the loop 600 ms
  past a 100 ms moment). The orchestrator's and the partners' processes take it from
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

## The agents' texts against the CLI (queue ACF)

Every text an agent is given is pinned by a golden file and its `nexus` commands are checked against the CLI: a new
briefing, notice, packet or help topic gets its rendering in `apps/server/test/golden` (`prompts.test.ts` fails on a
notice function it does not render), and `packages/cli/test/instruction-commands.test.ts` then checks each command in
the goldens, the help topics and AGENTS.md for an existing command and subcommand, flags of that command the parser
knows, and the options the command cannot go without (its `REQUIRED` table, kept by hand beside main.ts's checks); a
text that shows only part of a command on purpose marks it with a standalone `…`.

## The compile cache, quick engine waits everywhere, and the tests' temporary folders (queue TI2)

Measured by TI1 (a survey of the slowest tests) and done in TI2, each full run measured under the lock, one after the
other, with a TEMP of its own (so what a run leaves can be counted):

- **The compile cache is on** for every node process of a full run and of `npm run test:files`: `scripts/test-lock.ts`
  and `scripts/test-files.mjs` set `NODE_COMPILE_CACHE` (the folder `node-compile-cache` in the system's temporary
  folder, Node's own default; one already set is kept) for the test runner, and so for every server, fake runtime and
  CLI the tests start. The nexus CLI turns it on itself (`packages/cli/bin/nexus.js`, `module.enableCompileCache()`
  before main.ts is imported, so main.ts is loaded dynamically), so every agent's call is faster too: `nexus help`
  took 308 ms and takes 188 ms (median of 15). FX's finding above ("Node's compile cache does not change it") no
  longer holds on Node 26, where the cache covers the TypeScript sources. `NODE_DISABLE_COMPILE_CACHE` turns it off.
- **Every engine of the tests uses QUICK_ENGINE**: the 54 files and helpers that built an engine with the server's
  waits (300 ms settle after every turn, 1500 ms before a new engine resumes held runs) spread it into their options,
  before their own, so a test that sets `startupMs` or `turnSettleMs` itself keeps its value. No test was about the
  defaults themselves.
- **The helpers' temporary folders are removed** when the test file's process ends (`apps/server/test/temp-dirs.ts`,
  `tempDir(prefix)`: engine-setup, coordinator-world, deploy-plan-setup, holdWork, plan.test.ts, deploy-plan.test.ts),
  with the project's worktrees folder beside a root; not at the test's end, since a fake or an engine may still write
  into it, and a later test of the file may read an earlier one's (a restart on the same files). Protocol tests remove
  theirs with `after`. Other helpers' folders (nexus-checks-, nexus-closing-, nexus-merger- and others, about 1000 a
  run) are still left: a later queue's.
- The full run: 822 s before, 666 s after (-19%); the tests' summed time 8143 s to 6407 s; tests over 5 s 502 to
  449, over 10 s 335 to 262; the same 1622 tests, all passing.

## Processes in tests (queue IPR)

Tests run the fake runtimes in their own process (`inProcessRuntime()`) and the CLI as a function; only the files
`scripts/real-process-tests.ts` lists, each with why, start processes ([cli-in-process.md](cli-in-process.md)).

## Startup and recovery tests, and their helpers (queue LCR)

Queue LCR closed the nine coverage gaps of the LC survey (LC-F1 to LC-F9, the survey of RN's start-up and recovery
work) with tests against the fakes and no product change. What they prove is Nexus's own choices: which start (resume
or fresh), which id, in which order, how many times a message or an effect reaches an agent, what a restart pauses or
goes on with. They do not prove how Claude Code or Codex keep a conversation (see
[runtimes.md](runtimes.md), "What the fake runtimes prove (queue LCR)"). The tracker that named every gap, its tests
and the latest run was the queue's review material; the table below is what stays.

| Gap | Test file (`apps/server/test/`) | What is held |
|---|---|---|
| F1 kill, close and stop during a startup replacement | `startup-replacement.test.ts`, `startup-replacement-worker.test.ts` | no corrective start after a kill or shutdown, one exit, the held message once; at the worker role Stop at once and a pause stay in force |
| F2 input replay, settings, accounting | the same two files | every message sent while the refused start is held reaches the corrected start once, in order and priority; arguments equal but for the session flag; usage from its own baseline; an answer given meanwhile reaches the turn once, with its qid |
| F3 a server that died without a word | `crash-recovery.test.ts` | a plain restart pauses the run; after Resume each start-up checkpoint and the twice-interrupted correction end as an uncrashed control does; the chat's cut-off message lost in a plain crash is not replayed |
| F4 a partner's cut-off first turn | `partner-recovery.test.ts` | once after cutOff, shutdown and resumeCutOff on a new server, for both runtimes, a saved conversation with a wrong mark, and a hand-over |
| F5 save signals and broken records | `claude-startup.test.ts`, `partner-recovery.test.ts` | the first whole init, assistant or result line tells saved once; a missing, truncated or wrong-typed runtime.json reads as none with a warning and is set aside at the next write; the id is kept |
| F6 Claude's negative start-up gates | `claude-startup.test.ts` | exactly one corrective start, only for a pre-output refusal naming the conversation; the 1000 ms stderr wait on mock timers |
| F7, F8 Codex's recovery and late refusals | `codex-recovery.test.ts`, `codex-exit.test.ts` | only the missing-rollout text starts a new thread, whatever the code; the new id is kept between the thread's answer and the turn; a refused turn/start ends one turn, once |
| F9 what a resumed conversation holds | `partner-recovery.test.ts` | a sentinel and a completed effect survive a normal resume, a legacy record and a false mark corrected to a resume, and the effect is not done again |

The helpers, all in `apps/server/test/` and all driven through the existing fakes (no second fake system):

- **`FakeGates`** (`fake-behaviour.ts`): holds Claude's fake at `first-read`, `save`, `first-output`, `refusal`,
  `stderr` and `exit`, Codex's at `answer:<method>`, each until the test releases it; the gates' environment goes into
  the adapter's options, never `process.env`. Only for fakes in the test's own process. `leftovers()` and `dispose()`
  are the cleanup (`fake-gates.test.ts`).
- **`FAKE-EXIT: <code | signal> [stderr]`** (Claude's fake) and **`FAKE_CODEX_RPC`** (Codex's): a start-up failure and a
  JSON-RPC answer chosen by the test (any error code and text, another result, none, an exit). `scripted-child.ts`
  is a runtime process the test writes itself, for the orders the fake does not give (stderr after the exit, stderr that
  never ends, a spawn error).
- **`crash-server.ts`** (`crashAt`, `endCrashServers`): a Node process of the test's own runs the engine or the
  orchestrator's resumeCutOff with the fakes in it, held at a gate, and the test ends it by its handle (no drain, no
  cut-off, no shutdown). The next server is a new store and engine on the same files and sees only what is on disk. Its
  environment keeps only a temporary `NEXUS_HOME` and the fakes' paths: a worker's own `NEXUS_DIR` and `NEXUS_SESSION`
  would point at the real project. The fakes have no process id, so a record left by it holds none and the next
  server ends nothing. `crash-recovery.test.ts` is listed in `scripts/real-process-tests.ts` for it.
- **The fakes' kept history and effect receipts** (`openConversation`, `takenIn`, `fakeHistory`, `fakeEffects`): a saved
  conversation keeps the messages Nexus sent it, and a resumed process starts with them; "FAKE-EFFECT: <key>" in a
  message makes a turn that completes write a receipt with an id of its own. A test counts receipts, so "once" means one
  receipt, not one id seen. A stopped or failed turn writes none.
- **`holds()`** (`wait.ts`): checks a state keeps for a window (every 25 ms), for what must not change after a late
  event.

Findings from building them, pinned as today's behaviour and not changed (the user decides whether any should be):

- A server killed after taking up a chat's cut-off mark (the notice sent, the mark cleared) before its process read the
  message leaves nothing to go on with: the next server does not replay it and nothing tells the user; the message
  stays in the chat and the next one is answered in the same session.
- The correction's "retry" activity (a refused start tried again, or a Codex thread started anew) begins the step's turn
  in AgentHost, so a crash in it leaves `turn_open` and the next server records one `interrupted` turn (queue CK).
- A legacy runtime record behind a saved conversation is resumed and keeps no mark afterwards.
- Refusal-like stderr after real output still tells `saved=false`; the next start's refusal corrects it with one more
  start. A Codex thread answered without an id gets a `turn/start` with none, a lasting `turnStartRejected`.

Stability of the new files was measured with `node scripts/load-tests.mjs` (12 busy loops, four copies, five rounds, 20
runs each, all green); none of the new test code sleeps longer than the 25 ms poll, except on the mock clock.

## The job host's End through a native seam (queue WHR)

`End` and `AwaitExit` in `apps/server/src/worker-job.cs` make their native calls (OpenProcess, IsProcessInJob,
WaitForSingleObject, TerminateProcess, CloseHandle and the last error after them) through one seam, the `EndCalls`
interface and its private field `calls`. The default, `Kernel32EndCalls`, forwards each call to the same P/Invoke the
code called directly before, and reads `Marshal.GetLastWin32Error()` right after it, so the job host behaves as before;
nothing at run time (no environment variable, no frame) selects another implementation.

A test compiles its own copy of `worker-job.cs` together with `apps/server/test/worker-end-calls.cs`
(`apps/server/test/worker-end.ps1`) and reaches the production `End` by reflection: no second implementation of the
algorithm exists in the tests. `ScriptedEndCalls` records every call with its handle, job and arguments, and answers
with the results and last errors the test scripts, for the ones Windows gives only in a race (a refused open, a false
TerminateProcess with error 5, WAIT_FAILED). `worker-end.test.ts` pins the call order on one handle and proves, with
the seam left at its default, that End ends a real member of a real job (exit code 1, from its TerminateProcess) and
leaves a process outside the job alive. Its matrix (queue WHR, WHR2) runs the whole End on every branch: OpenProcess
87 and other errors, a non-member, an exited member, an IsProcessInJob failure, TerminateProcess false/5 with a late exit
or a survivor, a timeout after a successful terminate, WAIT_FAILED after either, and last errors left or set by other
calls. Each case pins the exact calls and the outcome (exception type, NativeErrorCode, the operation's name), and the
identity rules hold on every branch: one open, every call on that handle, one close as the last call, a terminate only
after the membership check. These results are injected; the real-handle wait and the DACL denial stay in
`worker-exit.test.ts` as the Windows evidence.

`WorkerProcess` (`apps/server/src/worker-process.ts`), the server's end of the host's control pipe, takes the start of
the host as an optional constructor argument; the default starts `worker-job.ps1` as before.
`worker-process-frames.test.ts` gives it a pipe of its own and node:test's mock timers (queue WHR, WHR3): only the
matching `C <id>` resolves a cleanup, once; F and the host's close reject every pending one; the 15 s cleanup limit, the
15 s kill backstop after K and the 5 s grace after the input's E are passed on their boundaries, with the kills counted
and no timer left. A fake pipe frees no OS resource, so the file's native case runs the real host. Its job member
writes a ready file once it runs: a child's current directory is held only from its start, not from `spawn`'s return,
and asserting the lock before that failed 2 of 20 runs under load.

The cleanup held inside the native phase (queue WHR, WHR4): `nativeGate()` in `apps/server/test/gated-cleanup.ts`
starts the workers' processes in a real job host compiled with `apps/server/test/worker-gate.cs`
(`apps/server/test/worker-gate.ps1`), which wraps the host's End seam. It holds End at AwaitExit's 2000 ms wait on the
handle End opened and checked for the helper the test names (or before the kill's first open, after a DACL denial),
acknowledges with the PID and handle, and goes on with the real wait when the test opens it; the helper's
TerminateProcess can be answered false/5 instead of being made. `worker-cleanup-gate.test.ts` meets the held wait with
Stop now, Stop at once, the pipe's end, the host's kill, resumes, an inbox entry and a review's acceptance, for both
fake runtimes. Two Windows facts shaped it: a console helper started with `windowsHide` has a conhost of its own in the
job, and ending that conhost ends the helper whatever its DACL; Node puts its children in a kill-on-close job of its
own, so ending a runtime ends its helpers. The tests' helpers therefore share the host's console
(`ownedholdshared`, `owneddenyshared` in `apps/server/test/fake-behaviour.ts`).
