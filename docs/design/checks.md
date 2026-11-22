# Checks and static analysis

Part of [the design](../DESIGN.md).

See also: [One full test run on the machine](tests.md#one-full-test-run-on-the-machine-queue-fx).

## Nexus runs the checks (queue EC)

Designed in EC1 from the user's decisions of 2026-11-17 (docs/ideas/token-costs.md) and 2026-11-16
(docs/ideas/worker-phases-and-resources.md); built in EC2 (the capacity coordinator, `apps/server/src/capacity.ts`) and
EC3 (the engine, `apps/server/src/check-runs.ts`, and the derivation, `packages/protocol/src/checks.ts`) and EC4 (the
briefings, AGENTS.md and the dashboard, `apps/web/src/checks.ts`). The file formats are in PROTOCOL.md, ["Checks run by Nexus"](../protocol/checks.md#checks-run-by-nexus). Points marked
**(P1)**…**(P17)** went beyond the decisions: EC1's proposals, which the user accepted on 2026-11-18, P3 made more
precise and P6 changed (below).

**Why.** A worker ran the full suite at every step's end, and every call around it (starting it, polling it, waiting
for the full-test lock, reading the output) re-read the worker's whole context: about 16% of the cost of the analysed
transcripts, 563 full runs and 512 polls of the lock. The engine runs the same commands without a model; the worker
sees output only when something fails. While working, the worker still runs the targeted tests
(`npm run test:files -- <files>` in Nexus).

**When.** The worker's turn ends with `nexus step done`; the engine cleans the worker's descendants as today (queue
PT), then runs the checks, then sends the step to review. The step is not in review, and nothing of the step's end
happens yet (the next step, the closing step, context care's switch, a plan or a deploy waiting for the step), until
the checks have passed: a failure goes back to the same session, which holds the context the fix needs. `nexus step
failed` and `nexus stop` run no checks. Which checks: the project's and the queue's, each once, as the step's opening
lists them, every one a shell command run in the queue's checkout **(P1)**. Steps opened before the change keep the
worker's reporting: whether Nexus runs a step's checks is fixed when the step opens.

**How.** Each check is a child process outside the event loop (`spawn` through the shell, never `execSync`), in the
queue's checkout, its stdout and stderr to a log file under the queue's folder, nothing of it kept in memory but the
tail. On Windows it runs in a Job Object of its own, as a worker does (queue PT), so the check's whole tree, detached
children included, ends with it and its end can be observed. The server writes the check's state (command, start,
end, exit code, the log's path) to a file before it starts the process and after it ends, so a restart finds what was
running. The checks of a step run one after another, as one heavy operation **(P2)**, all of them even after one has
failed, so one fix round sees every failure **(P3)**. A check has a time limit, past which it is ended and counts as
failed **(P10)**. The checks run on the checkout as it is; the result records its HEAD and whether tracked files had
uncommitted changes (`nexus step done` already warns about those).

**A failing check is run once more.** Only the failed ones, within the same grant of the machine, right after the
set, where the code has not changed (P3 as the user made it precise on 2026-11-18). After a check-fix round or a
send-back, any new code, every check runs again, the ones that passed before too: a green result does not carry over
to new code. Passing the second time, the step goes on and the check is recorded as flaky for that step: the statistics count
it, and the orchestrator hears of it with its next notice, so it can propose a maintenance queue **(P14)**. Failing
twice, the worker gets a check-fix round: a message to its session with the failing tests' names (where the output's
format is known), the end of the output and the full log's path **(P15)**. It fixes, commits and ends with `nexus
step done` again, and the checks run again, all of them.

**The check-fix round is not a send-back.** It has its own limit, 3 by default (decided "like
`review_send_back_limit`") **(P4)**, and is counted apart: the step's review round (send-backs, the round of
its review pictures) stays as it is, and the fix round is numbered within it **(P13)**. After the limit the run halts
for the orchestrator, which decides what comes next **(P5)**: a Resume gives one more round.

**A failure that is not the work's** (P6 as the user changed it on 2026-11-18). A worker that finds a failure unrelated
to its work (it fails on the base too, a test it did not touch that fails now and then) does not patch around it: it
says so with its evidence (`nexus check --unrelated`), and Nexus itself runs that check on the queue's base commit, in
a worktree of its own, through the same coordinator. Failing there too, the failure is accepted: the step goes to its
review, and the failure is recorded for the statistics and a fix queue. Passing there, the failure is the queue's: a
fix round, counted toward the limit, without a dispute. Only when the check cannot run on the base (the command or
script is not there, the setup fails) does the orchestrator decide (accept or fix), its reason recorded. The evidence
is checked by a run, not by a judgement, wherever a run can tell.

**Every accepted failure gets a fix queue at once** (the user's decision of 2026-11-18), without exception: Nexus
proposes it itself, origin `ci`, from a shipped template (`check-failure`): the first step (debugging) reproduces the
failure on the base and finds its cause, the second (code) fixes it so the full run passes under load too. Its
description carries the check, the tests' names, the log's path, the step and the worker's evidence. While one is open
for the same test, a new occurrence is added to its description instead of a second queue. The orchestrator is told,
to complete it and put it into the plan. A flaky failure, which passed on its second run, gets no queue of its own: it
is in the statistics and in the step's review notice **(P14)**.

**Restarts and updates.** After a restart, a check that was running is run again, not re-attached: the old server's
check processes ended with its Job Objects (kill-on-close), and a log half written says nothing certain. A server that
stopped mid-check brings its run back paused like any; the check runs again when the run goes on **(P9)**. An update's
drain waits for running checks for a while **(P8)**, then stops them (recorded as interrupted, not failed), and they
run again after the hand-over with the held run. Checks waiting for the machine do not start while an update drains.
A Pause lets running checks finish and takes effect before the review or the fix round; Stop now and Stop at once end
them, and they run again when the run goes on **(P16)**.

**What the worker, the orchestrator and the review see.** The step's opening says that Nexus runs the listed checks
after `nexus step done` and that the worker runs only the tests of what it changes. `nexus check` no longer reports a
check Nexus runs **(P7)**; it remains for the evidence of an unrelated failure and for steps whose checks the worker
runs. The review (the orchestrator's notice, later the review helper) gets the engine's results, with flaky checks
marked: a step reaches review only with its checks passed, or with a failure the orchestrator accepted. The review
levels, the merge train and the merge back's condition ("the integration step's checks in its last round passed") do
not change; they read the engine's results. The closing refactoring step no longer runs the checks before it starts:
it starts at the HEAD on which the last step's checks passed, and its opening says so **(P12)**. The integration step
works as before (merge, `nexus step done`), and its checks are Nexus's like any step's; that it runs without a model
when the merge is clean is queue MI's (see ["The integration step without a model"](git.md#the-integration-step-without-a-model-queue-mi)).

**AGENTS.md "Before every commit"** keeps typecheck, lint and the tests of the changed files before each commit (the
worker still commits several times in a step); its second half says (EC4): the whole suite is no commit's check, it
runs at the step's end as the queue's checks, run by Nexus, which waits for the machine; only a step whose opening does
not say so (an older server's, work started by hand) has its worker run and report them.

**The step's states.** A step gets one new status, `checking`, between `running` and `review`, with a phase:
`queued` (waiting for the machine; what it waits behind is the machine's line in `nexus status`), `running` (which
check, since when) or `base` (a disputed check on the base commit). A disputed failure waiting for the orchestrator's
decision is `waiting` (phase `decision`). A step in a check-fix round is `running` with its fix round number, shown
apart from a send-back's round. The queue stays `running` and the run holds its checkout throughout.

**Findings from building it (EC3).**

- **The engine runs the checks only with the capacity coordinator.** The server always gives one; an engine without
  (most engine tests, which use the fake runtimes for other subjects) leaves the checks to the worker as before. So the
  existing tests keep their behaviour, and only the tests about the checks run commands.
- **cmd.exe's switches cannot be quoted**, and the worker's job host quotes every argument for CreateProcess. A check
  runs as `node -e <launcher> <command>`, the launcher calling `spawnSync(command, { shell: true })`, which builds
  cmd.exe's line as Node always does.
- **The output may arrive after the job host has closed**: the log is closed only once both streams have ended (at
  most two seconds after the tree), else the end of the output was lost.
- **A Job Object per check costs a second or two on Windows** (the host's PowerShell compiles its helper). The tests of
  the engine's logic run their stand-in checks without one (`Capacity`'s `jobs: false`); the tests of a restart and a
  drain, which end a check mid-run, use one: without it, ending the launcher leaves its child running, holding the
  output pipe open.
- **Events the derivation does not handle never reach a step's timeline.** `check.disputed` and `check.decided` are
  listed there explicitly, since the checks' derivation and the engine read them from the timeline.

**Findings from EC4.**

- **A check-fix round the worker took up was lost.** The derivation read the checks only for a step in `review`; a
  worker that opened its round with `nexus step start`, as its turn asks, made the step plain `running`: no round
  number on the dashboard or in `nexus status`, and a dispute said after it never ran on the base (the CLI took it,
  the engine never saw `checking`). Seen in the dashboard's pictures of a fix round on the fake runtimes. The
  derivation now reads a step `running` after a failed (or accepted) set's done as in that round, and an accepted
  dispute sends it to its review as of the done.
- **The dashboard's pictures run the real engine.** The capture seed (`scripts/capture/seed-check-runs.ts`) gives the
  test projects a `package.json` whose scripts are the checks (a ten-minute `npm test`, or one failing in TAP), and a
  start due at once: the fake worker reports its step done, and the engine runs, queues or fails the checks as it
  would. `NEXUS_TEST_LOCK` must name a file of the capture's own, else a full run elsewhere on the machine holds the
  coordinator, and every check reads "queued".
- **What a queued check waits behind is not on the dashboard yet**: the machine's line (`capacity.yaml`) is read by
  `nexus status` only; the step says it waits for the machine and since when.
- **A check set's effect on the step must hold during the replay, not only after it** (queue NL, found on ND/ND1,
  2026-11-19). `applyCheckSets` runs after every event is replayed. A step whose worker took up its check-fix round
  (`step.started`) replays as `running` until then, so every review verdict after Nexus accepted the failure was
  weighed against `running` and dropped: the helper's pass-on (so the helper counted as still running, and the
  orchestrator never got the notice), the orchestrator's and the user's acceptances. Now a review verdict first puts
  such a step in its review (`enterAcceptedReview`), and a take-up is recorded at the `step.started` (`fix_round_of`:
  started while its done still waited for review), so a start after a send-back is not mistaken for one. The
  notices themselves were never lost to a busy orchestrator: they are derived from the state at every change and told
  once by key. The reverse window (queue LH): a set that failed before the round was taken up left the replayed step
  in its review from its `step.done`, so a verdict written then (from a stale view) was taken as the review of work
  whose checks failed, and the step went to done. A verdict now counts only when the latest done's set had let the
  step into its review (`verdictBeforeReview`).

### The capacity coordinator, first slice

The checks are the coordinator's first user (decided 2026-11-16 and 2026-11-17): one heavy operation per workstation,
across projects, granted atomically or queued, the queue shown, released when the operation's processes have ended,
and never a start without the grant after a time. Built in EC2 (`apps/server/src/capacity.ts`; PROTOCOL.md, "The
capacity coordinator"), with no user yet until EC3. In this slice:

- **It lives in the server**, which serves every project of the workstation, and keeps its state in a file of its own
  (`<NEXUS_HOME>/capacity.yaml`, the server its one writer), so the dashboard and `nexus status` show the queue and a
  restart finds it. The workstation has an id (its host name) from the start, for the later model of several machines
  **(P17)**.
- **One slot, `heavy`**: one step's checks at a time on the machine. Requests are served in the order they came (by
  `requested_at`); a waiting request shows what holds the slot and since when, and what is ahead of it.
- **Release follows the process**: the grant ends when the check set's last process tree is gone (the Job Object is
  empty), not when a worker or the engine says it is done. A check ended at its time limit releases only once its tree
  is gone.
- **No time bypass**: waiting long gives status, never a start beside another heavy operation.
- **After a restart** the old server's grants are void (their processes ended with it), and the queue is rebuilt from
  the checks files: the requests not finished, in their order.
- **Outside Nexus**: a full test run started by hand (or by an agent against its briefing) is not Nexus's to control.
  `scripts/test-lock.ts` stays the machine-wide guard of `npm test` and `npm run test:times`, whoever starts them, the
  engine's checks included; the coordinator shows a lock held by a run outside it as what occupies the machine, and
  grants nothing meanwhile. What changes in test-lock.ts: **(P11)**. `npm run test:files` takes neither.

## Static analysis (queue SA)

Agents make mistakes a static check catches cheaply; the user decided on 2026-11-14 that Nexus checks them by machine
(docs/ideas/software-dev-features.md). `npm run lint` runs ESLint, then dependency-cruiser, and fails on any finding.

**ESLint** (`eslint.config.js`) with type information (`projectService`, each file under its own tsconfig) over
`packages/protocol`, `packages/cli`, `apps/server` and `apps/web`, sources and tests. Correctness rules only, no style
rules, and every rule an error (a warning nobody has to fix is noise):

- `no-floating-promises`: a promise nobody awaits loses its rejection and its ordering (the forgotten `await`). The
  `test()` calls of `node:test` are exempt: the runner awaits them. A promise left alone on purpose says so with `void`.
- `no-misused-promises`: a promise where a condition or a void callback is expected, e.g. an async function as a
  React `onClick`. The dashboard's handlers write `() => void save()`: the handlers catch their own errors.
- `switch-exhaustiveness-check`, with a `default` not counting as handling the members it hides: a switch over a union
  names every member, so a new state or event type is a lint error wherever it is not decided on. A switch that does
  nothing for some members lists them as empty cases before its `default` (the `default` stays for values from files
  written by another version).
- `react-hooks/rules-of-hooks` and `react-hooks/exhaustive-deps` on the dashboard: a hook called conditionally breaks
  React's bookkeeping; a missing dependency leaves an effect working on stale values. Only these two of the plugin:
  its React Compiler rules are about a compiler Nexus does not use.
- `no-restricted-syntax` against `localeCompare` on an id (a name `id`, `ids`, `event`, `queue`, `step`, `dir` or
  ending in `Id`, on either side of the call): ids compare with `compareIds` (`packages/protocol/src/ids.ts`), by code
  unit. Found in queue FL: Node and the browser take the machine's locale, and in hu-HU CS, GY, LY, NY, TY, ZS (and DZ,
  DZS) are letters of their own, so `"…ZS"` sorts after `"…ZT"`; two monotonic ULIDs of one millisecond came out
  reversed, and a step whose `step.started` sorted after its `step.done` stayed `running` (about 3 % of the step-chat
  seed test's runs). Timestamps (`at`) may keep `localeCompare`: ISO times hold no letter pairs.
- Unused `eslint-disable` comments are errors, so a suppression cannot outlive its reason.

No `--cache`: ESLint's cache is per file, and with type information a change in one file (a function becoming async)
can create a finding in another, unchanged one. The whole run takes about 12 s.

**dependency-cruiser** (`.dependency-cruiser.cjs`) over `packages`, `apps` and `scripts`, type-only imports included
(a type pulled from the server is still a dependency on it):

- `protocol-not-to-apps`: the protocol is the shared contract and imports nothing from `apps/` or the CLI.
- `web-not-to-server`: the dashboard talks to the server over HTTP only.
- `cli-not-to-server`: agents never call the server; the CLI writes files through the protocol.
- `not-to-unresolvable`: an import that resolves to nothing.

What the code showed when the rules came (2026-11-15): no boundary crossed. The server, the CLI, the dashboard and the
scripts depend on the protocol and on nothing else of each other; nothing depends on the server. The dashboard imports
the protocol's index (mostly types) besides its Node-free subpaths (`times`, `attention`, …); that the subpaths it runs
stay free of Node is kept by the Vite build, not by a rule.

**Baselines.** Findings are fixed, not suppressed; one that cannot be fixed safely in the step (or whose fix would
change what the user sees) goes to the tool's own baseline with its reason: ESLint's `eslint-suppressions.json`
(`eslint --suppress-rule`; ESLint fails while an entry no longer matches, so the file can only shrink) and
dependency-cruiser's known violations (`depcruise-baseline`, then `--ignore-known` in the script). When the rules came
both were empty: the 20 findings (15 misused promises, 5 non-exhaustive switches) were fixed without a change in
behaviour, and the 686 floating promises were all `node:test` calls.

**knip** (`knip.json`) finds files nothing loads, exports nothing imports and dependencies nothing uses (or uses
without listing). It runs in the closing refactoring step and in maintenance queues, not as every step's check: an
export a step adds for the next step is not dead yet. The entries are what runs: `apps/server/src/main.ts` (the root `start` script), the CLI's
`bin`, the dashboard's `index.html` (through knip's Vite plugin), every `*.test.ts`, the scripts, and the seeds of
`scripts/capture`, which views files load by path. The protocol is checked with its entry exports included
(`includeEntryExports`): it is a package of this repository, not a published one, so an export of it nobody imports is
as dead as any other.

When it came (2026-11-15) it found 50 unused exports outside the protocol and 34 in it, and `yaml` used without being
listed (by the server's tests and the capture scripts). The unused exports were nearly all used inside their own
module: they lost `export`. What was not used at all was deleted: `clearDraft` (drafts.ts), `WorkChoice`
(stopwork.ts), the re-exports of `ActivityItem`, `StreamFacts` (claude.ts) and `ChatEntry` (orchestrator.ts), and
in the protocol `PROTOCOL_VERSION`, `EventOf`, `hasOwn`, `isClosingStep` and the `Approval` and `Withdrawal` type
aliases. No baseline was needed. `tsc --noUnusedLocals` would find about a hundred unused locals and imports more; not
switched on, a matter for a later queue.

**The project's checks.** `npm run lint` is a check of every step, also of queues approved before it existed, without
a new revision of each: a project setting, `defaults.checks`, puts its checks before every queue's own. It is
project-only, not global: a global `npm run lint` would break every project that is not on Node. A run fixes the list
when it starts (`checks` in run.yaml) instead of reading the setting at each step, so a running queue's steps all run
the same checks and its reviews judge them by the same list; the change comes with the queue's next start. A check
both lists name runs once (the queue need not drop its own `npm run lint`). Shown in the approval view, marked as the
project's, the way the project's stop conditions are.
