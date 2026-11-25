# Checks and the machine's capacity

Part of [the protocol](../PROTOCOL.md).

See also: [Full-test lock and lifetime channel (PT2)](runtimes.md#full-test-lock-and-lifetime-channel-pt2).

## Checks run by Nexus

**Status: built (queue EC, steps EC2 to EC4).** The reasons and the
decisions are in DESIGN.md, ["Nexus runs the checks"](../design/checks.md#nexus-runs-the-checks-queue-ec); the marks **(P1)**…**(P17)** are EC1's proposals, accepted by the
user on 2026-11-18, with P3 and P6 as the user changed them. The engine runs the checks only with the server's
capacity coordinator (`EngineOptions.capacity`; the server always gives it): an engine without one (older tests)
leaves them to the worker, as below for `by: worker`.

**Which steps.** Whether Nexus runs a step's checks is fixed when the step opens: the engine records it on the step's
entry in `checks.yaml` (`by: nexus`). A step opened before (by an older server) has no entry, and its worker reports the
checks with `nexus check` until the step ends. Every check, the project's (`defaults.checks`, as the run fixed them)
and the queue's own, each once (`stepChecks`), is a shell command run in the queue's checkout **(P1)**; what only an
agent can verify goes into the acceptance or `review.prepare`.

**Only a command can be a check** (queue EF, P1; `packages/protocol/src/commands.ts`). A check looks like a command
when its first word (after any leading `NAME=value` assignments, without quotes) can run: one of the few shell
built-ins a check uses (`echo`, `exit`, `cd`, `pushd`, `call`, `set`, `export`, `true`, `false`, `:`, `.`, `source`,
`env`), a file given as a path (relative to the project's root, or absolute), a file in the project's root by its name,
or a program on the PATH (on Windows with the `PATHEXT` extensions; a word with a capital letter must match the file's
name as written, so "Az összes teszt zöld" is no call of `az.cmd`). `queue.drafted` (`applyDraft`) refuses a draft
with a check that does not, every check of it, also one an older queue already had, and says that the text belongs in
a step's acceptance or its `review.prepare`. A check of a queue approved before the rule, run by Nexus, is looked at
the same way in the queue's checkout before it would run: one that is no command (its first word is not on the
server's PATH) is recorded with `not_command: true`, `ok: false` and no runs, and the set cannot run (below, "Machine
causes"): no check-fix round, no fix queue, the run halts. The orchestrator is told once per queue and check
(`notify:checknotcommand:<queue>:<check>`) to convert it with a revision. The step's checks show it as failed, "not on
the server's PATH: not run" (`CheckView.not_command`, `ok: false`).

The step's opening says under "Checks for every step"
that Nexus runs them after `nexus step done`, that the worker neither runs nor reports them, and runs only the tests
of what it changes.

**The sequence** (`apps/server/src/check-runs.ts`).

1. The worker ends its turn with `nexus step done`. After the worker's descendants are cleaned (Windows, queue PT), the
   engine adds a set to the step's entry (`state: queued`) and asks the coordinator for the `heavy` slot. The step is
   `checking` (phase `queued`). A step without checks passes at once.
2. Granted (`state: running`), the checks run one after another in the order the opening lists them, all of them even
   after one has failed **(P2, P3)**: each through the system's shell (`cmd.exe` or `sh`, as Node's `shell: true`, in a
   small Node launcher), in a Job Object of its own on Windows, in the queue's checkout, with the server's environment
   less `NEXUS_SESSION`, `NEXUS_DIR`, `NEXUS_HANDOVER`, `NEXUS_HOME` and `NODE_TEST_CONTEXT`. Its stdout and stderr go
   to its log. The server writes the run (`started_at`, `log`) before it starts and its end (`ended_at`, `exit_code`,
   `duration`) after its tree has ended.
3. The checks that failed run once more, in the same grant: the code has not changed. One that passes then is `ok`
   and `flaky` **(P3)**. A check that ran into its time limit (`timed_out`) is not run again: it has failed, and the
   worker's check-fix round says it ended at its time limit (the user's decision of 2026-11-23, queue CK). Only when
   Windows made a volume shadow copy while it ran (its run has `snapshots`, below) does it run once more: passing then,
   it is `ok` and `snapshot_rerun` (not `flaky`), shown as "passed (rerun after a disk snapshot)".
4. The grant ends; the slot is free once the last tree has ended.
5. Every check passed: the set is `passed`, and the step goes to its review as a `step.done` did before, with the
   step's end handled there (the next step, context care, a plan or a deploy waiting for it). A check failed (twice, or
   once at its time limit): the set is `failed`, and the worker gets a check-fix round (below), unless the set's `fix` has reached
   `defaults.check_fix_limit`: then the set gets `limit: true` and the run halts for the orchestrator **(P4, P5)**.

**Machine causes** (the user's decision of 2026-11-23, queue CK). What the worker cannot fix, a cause outside the
checkout, Nexus does not give it as a check-fix round: the set stops `interrupted` with `unrunnable: <reason>`, and the
run halts with `step <step>: the checks cannot run, for a cause outside the checkout the worker cannot fix: <reason>`
(`nexus status` and the dashboard show it as any halt's reason; the step stays `checking`, with
`checking.unrunnable`, and its line reads "checks by Nexus: cannot run (the run halted): <reason>"). A Resume runs the
set again. The causes:

- **No checkout**: the queue's checkout does not exist (its worktree's folder has gone), or none is known: `no checkout:
  the queue's checkout <path> does not exist`. A step with no checks at all still passes at once.
- **Not on the PATH**: a check whose first word is no program on the server's PATH nor a file (an older queue's check in
  words too): `check "<name>": "<word>" is not on the server's PATH (…)`; `not_command: true`. The checks after it do
  not run.
- **Missing script**: a check whose output has npm's `Missing script:` after its first run: `check "<name>": missing
  script (<npm's line>)`; `missing_script: true`, `ok: false`, not run again.
- **The worktree setup** run before the set (`setup`, below) failing twice: `the worktree setup (<command>) failed
  twice: exit code <n>; its output ends: <output>`. The engine's setup of a new worktree before the first step is
  tried once more the same way before it halts the run (docs/protocol/files.md, "Worktree setup").

A check that ran and ended with an error stays the worker's: the check-fix round, or `--unrelated`.

`nexus step failed` and `nexus stop` run no checks. A check longer than `CHECK_LIMIT_MS` (60 minutes) **(P10)** is
ended with its tree and counts as failed (`timed_out`), without a second run unless a shadow copy was made meanwhile
(step 3). After a check-fix round or a send-back (any new `step.done`) every check runs again, the ones that passed
before too: an earlier result does not hold for new code **(P3)**.

**`queues/<id>/checks.yaml`** (server-owned, one writer: the engine's `CheckRunner`; `ChecksFile` in schemas.ts):

```yaml
protocol: 1
steps:
  W3:
    by: nexus                      # fixed when the step opened (worker: an older server opened it)
    sets:                          # one per step.done of the step, oldest first
      - done: 01JD...              # the step.done event it checks
        round: 1                   # the step's review round (send-backs)
        fix: 0                     # check-fix rounds before it within that round (0: the step's own done)
        commit: 3f2a...            # HEAD of the queue's checkout when the set started (null outside git)
        dirty: true                # only when tracked files had uncommitted changes
        requested_at: ...
        granted_at: ...
        ended_at: ...
        state: failed              # queued, running, passed, failed, interrupted, accepted
        limit: true                # failed with the check-fix rounds used up: the run halted
        checks:
          - name: npm test         # as the step's opening lists it (and the command run)
            command: npm test
            runs:                  # the first, and the one run again after a failure
              - { started_at: ..., ended_at: ..., exit_code: 1, duration: 212, log: checks/W3/r1f0-1-npm-test.1.log,
                  failed_tests: ["engine › halts after the fix limit"], tail: "..." }
              - { started_at: ..., ended_at: ..., exit_code: 1, duration: 205, log: checks/W3/r1f0-1-npm-test.2.log }
            ok: false              # its outcome in the set; flaky: true when it failed, then passed;
                                   # snapshot_rerun: true when it ran again after a time limit with a shadow copy, then passed
          - name: All tests green  # an older queue's check in words: not_command: true, ok: false, no runs
            command: All tests green
            not_command: true
            ok: false
        # unrunnable: 'check "All tests green": "All" is not on the server''s PATH (…)'   with state: interrupted, when
        #                          the set could not run (machine causes, above): the run halted
        dispute:                   # the worker's word that a failure is not its work's (below)
          event: 01JD...           # its check.disputed
          name: npm test
          evidence: it fails on main too
          at: ...
          base: { state: failed, commit: 9c1e... }   # queued, running, failed, passed, unrunnable (with reason); run
          decided: { verdict: accept, reason: ..., at: ..., event: ... }   # the orchestrator's, when it was not runnable
          outcome: accepted        # accepted, or fix
        fix_queue: { id: CI, created: true }   # an accepted failure's fix queue (created, or an open one it joined)
        setup:                     # the worktree setup, run first because its inputs changed (queue MI)
          { name: worktree setup, command: npm ci, reason: package-lock.json changed, runs: [...], ok: true }
```

A run's `tail` is the output's last 80 lines, at most 6000 characters, and `failed_tests` the failing tests' names where
the output's format is known (node:test's spec and TAP reporters), both only for a failed run **(P15)**. `exit_code`
is null for a run that was ended (`timed_out`, or `interrupted` by a restart, a drain or a stop). A failed run on
Windows also has `snapshots` when Windows made a volume shadow copy while it ran (queue CI4; read from the event log
after the run, src/snapshots.ts): `[{ at, seconds, by?, unfinished? }]`, each copy's start, how long it took (to the
run's end when `unfinished`) and the command line that asked for it. File writes stop while one is made, so tests
waiting then time out together; the check-fix round's text and an accepted failure's fix queue name the copies
(docs/design/tests.md, "Volume shadow copies stop the tests"). The logs are
`queues/<id>/checks/<step>/r<round>f<fix>-<n>-<name as a file name>.<run>.log` (a base run's: `…-base.1.log`), and
stay with the queue.

**Restarts** **(P9)**. A starting engine marks what the old server left `queued` or `running` as `interrupted` (its
runs without an end: `interrupted`, with an end now; a base run back to `queued`): the old processes ended with their
Job Objects. The set runs again, from the start, when its run goes on: at once after an update's hand-over
(`resume_after_restart`), at Resume after any other restart (the run comes back paused).

**The step's state** (`applyCheckSets`, `packages/protocol/src/checks.ts`). A `step.done` of a step with `by: nexus`
leaves it `review` only when the set for that done is `passed` or `accepted`. Otherwise:

| The set for the latest step.done | The step | `checking` |
|---|---|---|
| none yet, `queued`, `interrupted` | `checking` | `{ phase: queued, since }` |
| `running` | `checking` | `{ phase: running, since, check }` |
| `failed`, no dispute | `running`: a check-fix round, `check_fix` = `fix` + 1, `check_fix_limit` (the project's `defaults.check_fix_limit`), `check_limit` with `limit` | |
| `failed`, disputed, the base run to come or running | `checking` | `{ phase: base, since, check }` |
| `failed`, disputed, the base `unrunnable`, not decided | `waiting` | `{ phase: decision, since }` |
| `failed`, the dispute's `outcome: fix` | `running` (the same check-fix round) | |

The same holds once the worker took up its check-fix round with `nexus step start` (the step `running` after the failed
set's done): it stays in that round (`check_fix`), a dispute it says there runs on the base as above, and an accepted
one sends the step to its review as of the done (its `finished_at` and `review_with` the done's).

**An unreadable checks.yaml** (queue LF, F6): the state warns (`queue <id> checks: <error>`), the queue view carries
`check_runs_error` (the error), and every step its events put in `review` is `checking` (`{ phase: queued, since: the
done }`) instead: whether its checks passed is unknown, and it is not reviewed as if they had. The engine halts the
run whose current step that is, with the reason (`<path>/queues/<id>/checks.yaml cannot be read: <why>. Nexus cannot
tell whether the checks of step <step> passed …`: the error names the file, the reason does not name it again, queue
LCK). Repaired, the file is read again; moved aside, the step goes to its review
without Nexus's checks.

**Failures inside the checks' work** (queue LF, F1): a stop ends the grant, and nothing starts under it afterwards (the
base run looks at the stop after its `git worktree add` too, and leaves its base run `queued`). Anything else that
throws in a set's or a base run's chain (an unwritable checks.yaml, a failed spawn) is logged and halts the run (`step
<step>: the checks Nexus runs failed: <error>`); a Resume runs the checks again. An accept the orchestrator decided
whose outcome was not yet written (the server ended between the two writes, F5) is finished at the engine's next look;
its fix queue gets the occurrence once.

The review round (`reviewRound`) counts only the step.dones that reached review, so a check-fix round is no send-back
round, and the review pictures keep their round **(P13)**. The engine's results join the step's `checks` (`by:
"nexus"`, `flaky`; the summary "passed", "failed, then passed on the second run (flaky)", "passed (rerun after a
disk snapshot)", "ended at its time limit", "exit code 1; 2 tests failed, twice") and its metrics (`check:<name>`), so `nexus status`, the dashboard, the review notice and the
statistics read both kinds alike. `nexus status` adds a line under a checking step (`checks by Nexus: waiting for the
machine since …`, `running <check>`, `running <check> on the queue's base commit`, `a disputed failure waits for the
orchestrator's decision`) and under a fix round (`check-fix round 1 of 3`).

**The check-fix round** is an inbox entry from Nexus, `check_failed` (`ref`: the set's done, `queue`, `step`, `fix`:
the round it opens, `text`: per failed check its exit code, failing tests, full log path and the end of its output),
id `check-failed-<done>` (`…-base` and `…-decided` for the rounds a dispute gives). Its being in the inbox reopens the
step; the engine hands it to the session as the next turn ("[Nexus] The checks Nexus ran for step W3 of queue W:
check-fix round 1 of 3. What failed: …"), which asks for the fix at its cause, says every check runs again after the
next `nexus step done`, and how to say a failure is not the work's. A run halted at the limit gets the orchestrator's
halt notice with the reason (`step W3: the checks failed after 3 check-fix rounds (the limit, check_fix_limit 3): …`);
`nexus run <queue> resume` (or the user's Resume) gives one more round, the entry written then, its text saying so.

**An unrelated failure** **(P6, as the user decided on 2026-11-18)**. In a check-fix round the worker says a failed
check is not its work's with its evidence: `nexus check <step> "<name>" --unrelated --evidence "<what shows it>"`
(event `check.disputed`, worker only: `queue`, `step`, `name`, `evidence`; refused unless the step is in a check-fix
round, the check is one that failed, and the round has no dispute yet), and ends its turn without `nexus step done`.
The step is `checking` (phase `base`): Nexus runs that check on the queue's base commit (git.yaml's `base.sha`, else
the HEAD of the checkout when the queue's first step opened), in a detached worktree of its own in the system's
temporary folder, with the project's worktree setup first when it has one, under the same coordinator; the worktree is
removed after.

- **It fails there too**: the failure is accepted (`outcome: accepted`, the set `accepted`): the step goes to its
  review, and Nexus proposes a fix queue for it at once (below); the orchestrator is told. Also when the worker took
  up the check-fix round first (`nexus step start`): the step waits for its review from the set's `ended_at` on, as of
  its `step.done`, and the verdicts on it after that time (a helper's pass-on, an acceptance, a send-back, a hand-over
  to the user) count (queue NL; before it they were dropped, and the orchestrator never got the review notice).
  The other way round, a verdict written while the step's latest done had a set that had not let it into its review
  (queued, running, interrupted, or failed and not accepted, also before its check-fix round was taken up), or before
  Nexus accepted its failure, does not count: it is left out with a warning in the state (queue LH). The CLI refuses
  such a verdict anyway; only one written from a stale view gets that far.
- **It passes there**: the failure is the queue's (`outcome: fix`): the worker gets the round's entry
  (`check-failed-<done>-base`) saying so; it counts in the round it is in, without a decision.
- **It cannot run there** (the worktree cannot be made, the setup fails, or the command is not there: exit code 127
  or 9009, "Missing script:", "is not recognized as an internal or external command", "command not found"; also a
  name that is not one of the failed checks): the base is `unrunnable` with the reason, the step `waiting` for the
  orchestrator, which is told with the evidence, the failing tests and the log, and answers `nexus check decide
  <queue> <step> accept|fix --reason "…"` (event `check.decided`, orchestrator only; refused unless the step waits for
  that decision). `accept`: as a failure on the base, with the reason recorded; `fix`: a round
  (`check-failed-<done>-decided`) with the reason as its text. A dispute itself is no round.

**The fix queue of an accepted failure** (the user's decision of 2026-11-18). For every accepted failure, by either
way, Nexus proposes a queue at once, from the shipped template `check-failure` (`templates/check-failure.yaml`; a
global or project template of that id replaces it): id `CI` (`CI2`, … when taken), origin `ci`, `coding: true`, the
failed check as its check, two steps, the first (kind `debugging`) reproducing the failure on the base and finding its
cause, the second (kind `code`) fixing it so the full run passes under load too. Its description lists the tests
(`- test: <name>`, or `- check: <name>` when their names are unknown) and the occurrence: the time, queue, step,
rounds, commit, how it was accepted, the log's path, the worker's evidence and the end of the output. When an open
queue of origin `ci` (not done or cancelled) lists one of the same tests, no second one is made: the occurrence is
added to its description (no new revision: the description is not pinned). The set records it (`fix_queue`), and the
orchestrator is told once (`notify:checkaccepted:<queue>:<step>:<done>`), to complete it and put it into the plan; a
disputed failure waiting for its decision is told once too (`notify:checkdecision:…`). The review notice of the step
names an accepted failure of its round, and a flaky check's summary says so.

**`nexus check`** **(P7)**: refused (exit 2) for a step whose checks Nexus runs, naming the way to dispute a failure;
unchanged for a step without an entry or with `by: worker`; with `--unrelated --evidence`, and `decide`, as above.

**Settings.** `defaults.check_fix_limit` (global, with a project override; an integer from 0; default 3) **(P4)**.

**The briefings** (EC4, `apps/server/src/prompts.ts`). The step's opening keeps the list under "Checks for every step"
and adds that Nexus runs them. The worker's briefing says `nexus check --ok|--fail` is refused where Nexus runs the
checks, lists `nexus check --unrelated --evidence`, and that the worker neither starts nor waits for the whole suite
there. The check-fix round's turn asks the worker to work from the output and the log it names, running only the failing
tests. A send-back of such a step asks for the fix, not for the checks. The closing refactoring step whose checks Nexus
runs no longer runs them before it changes anything: its opening says they passed on the commit where the queue's last
step ended (`ClosingContext.checked`: the latest set of the queue's own steps, when it passed) **(P12)**. The
integration step's says Nexus runs the checks on the merge's result after its `nexus step done`, and a conflict it
resolves is followed by the tests of the files that conflicted.

**The dashboard** (EC4, `apps/web/src/checks.ts`). A `checking` step reads "checks running", "checks queued" (quieter:
it waits for the machine) or "checks on the base", with a line under it in the queue list (`npm test since 14:02`,
`waiting for the machine since 14:01`); one waiting for the decision reads "waiting: orchestrator decides"; a check-fix
round reads "check fix 1 of 3", never as a review round. The queue's one status says it too ("checks running · W3",
"checks wait for the machine · W3", "check fix 1 of 3 · W3", "a check dispute waits for the orchestrator · W3"). The
step's panel has a "Checks by Nexus" box while they decide the step: what they do and since when, the round apart from
the review round, and the latest set's checks one by one (passed, flaky, failed twice with the failing tests and the
log, running, waiting their turn); its "Checks" list marks the engine's results "by Nexus".

**Updates, Pause and Stop.** An update's drain withdraws the requests still waiting for the machine and lets running
checks go on at most `CHECK_DRAIN_WAIT_MS` (15 minutes) **(P8)**; `Engine.idle()` is false meanwhile, so the drain
waits. Then, or at once with `--now` or at a planned deploy's deadline, it ends them (`interrupted`), and the held run
runs them again after the hand-over; a cancelled drain lets them start again as their runs go on. A Pause lets
running checks finish and takes effect at the review, or before a fix round's turn; Stop now and Stop at once end
them (`interrupted`), and they run again when the run goes on **(P16)**.

The checks ask the capacity coordinator for the machine (next section), one request per set or base run.

## The capacity coordinator

**Status: built (queue EC, step EC2); its first user, the engine's checks, comes with EC3.** One heavy operation on the
workstation at a time, across projects (decided 2026-11-16, docs/ideas/worker-phases-and-resources.md; EC1's P2, P11
and P17). It is the server's (`apps/server/src/capacity.ts`, one per server, made when the server becomes active):

- **A request** (`kind: checks`, `project`, `queue`, `step`) is granted at once when the `heavy` slot is free and no
  full test run outside Nexus holds the machine (below), else it waits in line; requests are granted in the order
  they came. A waiting request may be cancelled; a granted one is ended by its owner.
- **The slot follows the processes.** The owner starts the operation's processes through its grant: on Windows each
  in a Job Object of its own (the worker's job host, `worker-process.ts`), so its end is the end of its whole tree,
  detached descendants included (the host ends what the root left, then closes); elsewhere in a process group of its
  own, ended with its root. The slot is free once the owner has ended the grant **and** every process started under
  it has ended: a process still running holds it however the owner sees the work, and a process killed (by its owner,
  by hand, by a crash) frees it once its tree is gone.
- **No time bypass.** Nothing is granted beside a held slot or a run outside Nexus, however long a request has waited.
- **Restarts and hand-overs.** A server becoming active writes the file anew (no grants: the old server's processes
  ended with it). A server that hands over or shuts down grants and writes nothing more; its waiting requests fail.

**`<NEXUS_HOME>/capacity.yaml`** (one writer: the server; written when what it says changes):

```yaml
protocol: 1
workstation: DESKTOP-1234          # the host name (P17)
slots: { heavy: 1 }
held:                              # granted, until the owner ended it and its processes have ended
  - { id: ..., kind: checks, project: nexus, queue: EC, step: EC3, requested_at: ..., granted_at: ... }
waiting:                           # in the order they came
  - { id: ..., kind: checks, project: honeycomb, queue: W, step: W5, requested_at: ... }
outside: { cwd: ..., pid: ..., since: ... }   # while requests wait: a full test run holding the lock outside Nexus
updated_at: ...
```

**`nexus status`** (any session, any project) prints the file's line after the queues, while anything holds or waits
for the slot (`capacityLines`, `packages/protocol/src/capacity.ts`):

```
machine DESKTOP-1234 (one heavy operation at a time, across projects):
  running: checks of EC/EC3 (project nexus), since 10:02
  waiting: checks of W/W5 (project honeycomb), since 10:03, 1st in line, behind checks of EC/EC3 (project nexus)
  outside Nexus: a full test run in C:\Code\Other (pid 4242, since 09:58); nothing is granted until it ends
```

**The dashboard** (queue EF) reads the same file through `GET /api/capacity` (the file as it is, or null when there is
none); the server broadcasts a `server` change whenever the coordinator writes it. A step whose checks are queued says
in its **Checks by Nexus** box what it waits behind (`capacityWait`, `packages/protocol/src/capacity.ts`): its place in
line (`position` of `waiting`), the operations holding the slot (another queue's checks, named with their project when
it is another one), a full test run outside Nexus (`outside`, its folder and pid), and the requests ahead of it.

**The full-test lock** **(P11)**. `scripts/test-lock.ts` stays the guard of `npm test` and `npm run test:times` for
every starter (by hand, an agent, and the engine's checks, inside their grant). It no longer starts a run without the
lock after a time (`NEXUS_TEST_LOCK_MAX_MS` is gone): a waiting run keeps waiting, saying once a minute what for (`npm
test: waiting for the full test run in <cwd> (pid <pid>, since <HH:MM>) to end (<n> min so far; it never runs without
the lock)`); a lock whose holder is gone, or that is stale (held, or unrenewed, longer than
`NEXUS_TEST_LOCK_STALE_MS`, 20 minutes), is still taken over at once. The coordinator reads the same file
(`NEXUS_TEST_LOCK`, else `nexus-full-test.lock` in the system's temporary folder) by the same rules
(`packages/protocol/src/full-test-lock.ts`, which test-lock.ts imports): a lock held by a live run, while the slot is
free, is a run outside Nexus, recorded as `outside`; the coordinator looks again every second and grants once it is
gone. It never takes the lock itself.
