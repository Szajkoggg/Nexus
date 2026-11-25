# Full test runs on the machine

Part of [the design](../DESIGN.md).

See also: [Tests](tests.md), the sections that moved out when this file passed 40 KB.

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

## The machine's state beside every full run (queue TI4)

TI1 found that a full run grew from 618 s to 1070 s in three days (CI81) while the code explained none of it: the
tests that start processes had slowed by half, the pure CPU tests not at all, and a restart of the machine took most
of it back. Its cause could not be shown afterwards, since nothing had measured the machine at the time. So every
full run now does (`scripts/machine-probe.ts`, called by `scripts/test-lock.ts`):

- **What**: the start of `node -e ""`, of `powershell.exe -NoProfile` to its first line, an `Add-Type` of a small C#
  class inside that PowerShell (timed there; a fresh class name each run), and `git --version`. These are the process
  starts the tests are made of (TI1: 2531 CLI processes, 988 job hosts and 9729 git commands a run), and the
  compile the job host did for every start before TI3. One after another, not at once, so they do not slow each
  other; each has 10 s at most, and one that cannot run is null.
- **When**: after the lock is taken, before the test runner starts: no other full run disturbs it, and it is not
  counted in `run_s` (the runner's time). Measured: 0.5 s on an idle machine, 1.4 s beside a busy loop per CPU,
  6 to 7 s beside three per CPU (then it shows what the run is up against).
- **Where**: one JSON line per run in `nexus-test-machine.jsonl` in the system's temporary folder, written when the
  run ends, and the same values in one line of the run's output, so a check's log carries them too. Not a Nexus
  metric: a check run cannot record one, and the Stats are the user's.
- **Reading it**: a run slower than its neighbours with slower process starts is the machine's; one with the usual
  starts is the code's (or the tests'). The lock's own tests turn the probe off (`NEXUS_TEST_MACHINE_LOG=off`), but
  one, which points it to a file of its own.
