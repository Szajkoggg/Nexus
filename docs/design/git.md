# Worktrees and merging

Part of [the design](../DESIGN.md).

## Worktrees

Nexus creates the worktree and branch for a queue itself when the queue says `worktree: auto`: a new branch from a
named base commit, in the project's worktree directory (a project setting; default
`<main checkout>/../<repo name>.worktrees/<queue id>`). The queue engine does this, at the orchestrator's request,
not the orchestrator by editing files. Nexus never switches, resets or deletes a worktree another session is using.
A new worktree gets the project's setup command once (`defaults.worktree_setup`, `npm ci` in Nexus) before its first
step. The code is `apps/server/src/worktree.ts` (`worktreeFor`, `gitBranch`, the setup), beside `gitinfo.ts`, which
records what the queue's checkout committed.

## Merging back

Decided by the user on 2026-11-14 (docs/ideas/parallel-worktrees-and-merge-back.md): independent queues run side by
side in worktrees of their own, and Nexus may merge them back by itself. Two settings, global with a project
override and off for a new project, since everything then rests on the project's checks: `merge_back` (Nexus merges
back by itself) and `resolve_conflicts` (the integration step's worker resolves a conflict).

- **The base only moves forward.** A merge without textual conflicts can still break (each queue passes its checks,
  together they fail), so the merge happens on the queue's branch, not on the base: the queue's last step, the
  integration step, merges the current base into the branch in the worktree and runs the checks there; the base then
  moves to that commit by a fast-forward. Nothing new can arise on the base itself, and the base never gets a merge
  commit of Nexus's (its history does contain the integration step's merge, which was checked).
- **The fast-forward** (`apps/server/src/merger.ts`, judged in `mergeback.ts`) waits for every step to be accepted
  (at its review level; provisional acceptances count as `provisional_counts` says), the integration step's checks to
  pass, and the base to still be an ancestor of the integrated commit. When the base moved on meanwhile (another queue
  merged, the user committed), the integration step runs again, at most twice by itself; then it waits for the user,
  whose Merge back runs it once more. The user's Merge back also starts the count of runs again anew (to zero), so
  after it Nexus may again run the step twice by itself.
- **It never moves files under someone.** It uses the protections of the user's merge (the base checked out somewhere,
  not detached, not in the live worktree, no uncommitted changes to tracked files; untracked files never count) and
  waits, telling the user and the orchestrator, when one fails. Nothing moves during an update, a deploy or a
  hand-over. Git can change what holds it without any file of the project changing (a commit in the checkout), so
  while something waits it is looked at again every 30 seconds.
- **First hold, then decide** (queue FX, 2026-11-15). The judgement goes in this order: (1) what keeps it whatever the
  base's checkout is like (the integration step's checks, the limit of runs again, the base checked out nowhere or
  only in the live worktree): it waits, and nothing is held; (2) a step at work in the base's checkout (running,
  waiting for an answer, or a pause waiting for the step's end) is held at its end, the way a planned deploy's drain
  holds a run; (3) only then the checkout's cleanliness (tracked files only); (4) when the base moved on, the
  integration step runs again, and the run stays held meanwhile, so the base does not move on again under it; (5) the
  fast-forward; (6) the held run goes on. A hold lasts at most one integration step (its checks and its review
  included, a few minutes). Whenever the merge back cannot go once a run is held (a dirty checkout, failed checks, the
  limit, a run again that halts, waits or cannot start), the held run goes on at once, and the wait names it
  (`merge.waiting.released`), so the user and the orchestrator are told; nothing stays held. A server restart lets
  it go too: a held run is marked to go on after a restart.
- **One way for both.** The dashboard's Merge back uses the same judgement and the same fast-forward, under one lock
  per queue, so the button and the server never race; `git.yaml` `merged.by` says who did it.
- **Cleanup** comes after the merge, once every provisional acceptance of the queue is confirmed: a Fix it until then
  runs in the worktree and goes through the integration step again. The worktree is removed with git where it can, and
  by Node where Git for Windows cannot (paths beyond 260 characters); the branch with `git branch -d`, never `-D`.
- **No push.** The merged base goes to the remote with the next deploy; a deploy planned after such a queue goes
  after its fast-forward.
- **The plan waits for the merge back** (queue MQ, 2026-11-16). With `merge_back` on, a queue planned after one in a
  worktree of its own starts only once that one's work is merged back (`doneForPlan`, `notMergedBack` in
  packages/protocol/src/plan.ts), so it starts from a base that has the work, and a chain of worktree queues does not
  build on a base without its predecessors. The planned deploy already waited the same way; both use one test. With
  `merge_back` off the user's Merge back may come much later, or never, so finishing stays enough there.
- **The merge train** (queue MQ, 2026-11-16). Two worktree queues finishing together both used to integrate against
  the same base; the first fast-forward then moved the base under the second, whose integration step ran again (and,
  with a third, again, up to the limit). Now, with `merge_back` on, one queue per base integrates at a time: it holds
  the base from its integration step's start to its fast-forward, and the others are held at the end of the step
  before their integration step, in the order they got there. Each integration step thus merges a base that already
  has the queues before it, runs once, and is followed by a fast-forward. A fast-forward that waits on the user (a
  dirty checkout, failed checks) must not stop the train: it lets the next queue go, and once it could go again it
  queues up behind those already waiting (by when its wait began). Choices: the rule is derived from the files
  (`packages/protocol/src/train.ts`), not kept in the server's memory, so a restart finds the same order and the
  dashboard and `nexus status` show the same place; the hold reuses the engine's step boundary and `releaseHold` (the
  planned deploy's and the merge back's own hold), so no new run state; a queue's own steps never wait, only its
  integration step; with `merge_back` off there is no train, since the user's Merge back decides the order anyway.
- A queue from before the integration step keeps the user's old merge (which may make a merge commit).
- Found while building: a scripted run on a development instance first stood still because a project without an
  orchestrator section has its level-2 reviews done by the user; and a commit in the base's checkout changes nothing
  under `.nexus`, so without the 30-second look a merge that waited for a clean checkout would wait until some other
  change came.
- Found on 2026-11-15 (queue FX): the order used to be cleanliness first, then the runs at work. A worktree queue's
  fast-forward then waited on the uncommitted work of a step running in the main checkout instead of holding that
  run; each of that queue's next steps moved main on, so the integration step ran six times (the user's Merge back
  reset the count twice). Holding first, and keeping the hold through the run again, makes it one run again at most.
- Found while building it: a run can finish (its integration step's review accepted) a moment before the turn in
  which the step got its outcome ends and closes its round in `git.yaml`. Judged in that moment, the last closed round
  was the older one, so the merge back waited ("the branch moved on after its integration step") and told the user
  for nothing; with a hold, it let the held run go. A round that is still open within a minute of the step's end
  now counts as still ending, and is judged once it closes.

## The integration step without a model (queue MI)

Decided by the user on 2026-11-17 (docs/ideas/token-costs.md): the integration step runs without a model when the
merge is clean and the checks pass, as a CI pipeline does; a worker is started only for a conflict or a failing check.
When the merge changes the lockfile, the worktree setup runs again before the checks. At the step boundaries the
engine may merge the base into the queue's worktree when it merges cleanly, so conflicts show up small and early.
Designed in MI1, built in MI2; the file formats are in PROTOCOL.md, ["The integration step"](../protocol/git.md#the-integration-step), ["Without a model"](../protocol/git.md#without-a-model). Points
marked **(M1)**…**(M13)** go beyond the decision: MI1's proposals, which the user accepted on 2026-11-18 as written.

**Why.** Most integration steps find a clean merge (or nothing to merge) and passing checks: the worker's whole turn
(reading its briefing and the opening, `git merge`, `nexus step done`, the context summary) only repeats what git and
the checks say. Since queue EC the engine runs the checks itself, so the one thing left for a model is what a model is
needed for: a conflict to resolve, a failure to fix.

**Who writes the queue's report (M1).** Today the last step's opening asks for the report, and the integration step is
the last. Without a worker nobody would write it. The report moves to **the last step that runs with a model before
the integration step**: the closing refactoring step when the queue has one, else the queue's last own step. Its
opening's "last" becomes "no step is pending but this one and the integration step". That step is the right author:
the closing step runs in a fresh session whose seed already holds the queue's description and every step's summary,
it read the queue's whole diff, and the report's judgement (each step against its acceptance, a proposed next step) is
a model's work. The integration's own outcome is not in the report: it is the integration step's summary (the
engine's, or its worker's), which the dashboard shows beside the report and the run-finished notice adds to the
report's summary ("Integration: …"). The engine never writes `report.md`: `nexus report` stays its one writer. The
integration step's opening asks for a report only when the queue has none yet (its closing step skipped by the user, a
report never written); a model-free integration of such a queue finishes without one, and the run-finished notice says
so. Alternatives weighed: the engine compiling the report from the steps' summaries (no model, but no judgement and no
proposed next step, a summary that is no substantive outcome for the ideas' excerpts (IC2), and a second writer of
`report.md`); the closing step writing it and the engine appending an integration section (the same second writer).

**The engine's own session (M2).** A model-free step still needs its events (`step.started`, `step.progress`,
`step.done`, a `queue.stop`, an acceptance) so that the derivation, the checks (their sets are keyed by the
`step.done`), the merge back, the train, `nexus status` and the dashboard read it as any step. A session appends only
to its own log, so the worker's log cannot take them. The server keeps one more session of its own, as it keeps the
user's: id `nexus`, role `nexus`, no runtime, its events written only by the server. The step's rounds in `git.yaml`
name it as their session.

**When the step goes without a model (M3).** Only when everything is plain; anything else goes the way it goes today
(a worker opens the step), so the model-free path never has to judge: Nexus runs the step's checks (the server's
capacity coordinator, `by: nexus`); the worktree has no uncommitted changes to tracked files; a base branch can be
named. The engine then merges (`git merge --no-edit <base>`), and on a clean merge (or nothing to merge) runs the setup
when needed and records `step.done` with a summary built from facts (the base and its commit, how many commits and
files the merge brought in, the resulting HEAD as its commit); the checks run as after any `step.done`.

**A conflict (M4).** The engine aborts its merge (`git merge --abort`), so the branch is as it was. With
`resolve_conflicts` off, it stops the step itself with the integration's condition and the conflicting files as the
reason: no worker, since today's worker would only do the same. With it on, a worker opens the step as today, its
opening naming the files Nexus found in conflict. No base branch to name: the engine stops the same way.

**A failing check (M5).** A set that fails twice after the engine's `step.done` is a check-fix round as for any step,
but the step has no worker yet: the engine opens the integration step in the run's session (started again when its
process has ended, as a resume does), with the integration's opening in its "continue" form, saying that Nexus did the
merge (the HEAD) and what failed (the round's text). The round counts toward `check_fix_limit` as usual (the engine's
own set is fix 0), and the worker may dispute a failure as in any round.

**Accepted by Nexus (M6).** A model-free integration whose checks all passed has nothing a review could judge beyond
them: git made the merge, the checks judged it. At review level 2 or 3 the engine accepts it itself (`review.accepted`
from the `nexus` session, its text saying so); the orchestrator is told with its next notice, as the routine reviews'
helper's verdicts will be. A level the user set to 1 still goes to the user. This narrows "every step is reviewed"
(PROTOCOL.md, ["Review"](../protocol/review.md#review)) for this one case, which is why it is a proposal. A queue without any check gets the merge
without a model too, but not the acceptance: its summary and the review notice say the merge is untested, and the step
goes to its review at its level. An integration a worker took part in (a conflict resolved, a failure fixed) is
reviewed as today.

**The setup after a lockfile change (M7, M8).** The decision names the integration's merge; the rule is made general,
since it is the same question everywhere: is the worktree's setup current for its HEAD? `git.yaml` records the commit
on which the setup last succeeded (`setup.sha`; the worktree's first setup: the base commit). Before a check set (any
step's, the integration's included) and after a step-boundary merge, when a file of the setup's inputs differs between
that commit and HEAD, the setup runs again first. The inputs are a project setting (`defaults.worktree_setup_inputs`,
project only), by default the lockfiles of the common package managers anywhere in the tree (`package-lock.json`,
`npm-shrinkwrap.json`, `yarn.lock`, `pnpm-lock.yaml`, `bun.lockb`, `bun.lock`), so a project with another kind of
setup can name its own (a `requirements.txt`). Before a check set the setup runs inside the set's grant of the machine,
recorded on the set, and counts as the set's first check: a failure runs once more (`npm ci` fails on the network now
and then), and failing twice it fails the set like a check, the checks after it not run (they would fail for it), so
the worker of a check-fix round sees it (a lockfile the merge broke is the queue's to fix). A worker that changed the
lockfile itself (and ran its install) gets one run too many, about half a minute, a price for one rule instead of two.

**Merging the base at the step boundaries (M9, M10).** When the engine opens a step of a queue with an integration
step (one of the queue's own steps, or the closing step; never the integration step itself, which merges anyway, and
never a step that goes on: a continue, a send-back, a check-fix round), it first tries to merge the base into the
queue's branch. It does so whatever `merge_back` says: with `merge_back` off the base still only moves by a
fast-forward to the integration's result. The pull only reads the base branch, so it neither waits for the merge train
nor holds the base. It needs a clean worktree (tracked files) and a base branch to name, and something to bring (the
base not already in HEAD). The engine first tests the merge without touching the worktree (`git merge-tree
--write-tree`; where git is too old for it, a real merge aborted on a conflict); a clean one is made (`git merge
--no-edit <base>`), then the setup when its inputs changed. A conflicting one is not made: it is recorded, shown on the
queue and in `nexus status`, and the next step's opening says which files of the base conflict with the branch, so the
worker knows what is coming; resolving it remains the integration step's. The orchestrator is not told separately: it
sees it with the step's review. No checks run at a pull: the next step's checks run on the result. Its opening says
what the pull brought in (the base's commit, how many commits, the files).

Three things change with it: the pull's merge commit falls between two steps' rounds, so it is no step's work; the
closing step's commit range starts at the last base commit merged in (else the first round's start, as today), so its
diff shows the queue's own work, not what the base brought; and a disputed check runs on the last base commit merged
into the branch (else `base.sha`), so the comparison is with what the branch contains.

**Run control (M11).** The merge and the setup are the engine's own work in the queue's run: `Engine.idle()` is false
while they run, so an update's drain waits for them; the setup is a child process ended and run again like a check
(interrupted by a Stop now, a drain's end or a restart). A server that stopped in the middle of a model-free step finds
the step `running` from the `nexus` session: it aborts a merge left half done (`MERGE_HEAD` present) and runs the step
again from its start, which finds the merge commit already there when it was made. A Pause during the step takes effect
at its review, as during the checks.

**The merge train and the merge back do not change (M12).** The train's hold is taken where it is taken today (the end
of the step before the integration step), and the integration step holds the base while it runs or waits, whoever
runs it; it only holds it for less time. The merge back's conditions read the integration step's last round and its
check set, which a model-free step records the same way. A run again because the base moved on costs no model now,
but the limit of two by itself stays: it guards against a loop, and the checks cost the machine.

**Measuring it (M13).** The decision wants the effect measured, as its own deploy. A model-free step is marked on the
derived step (`model_free: true`), so the statistics count model-free and worker integrations apart, and the steps
without a turn do not pull the per-step averages of tokens and time down unseen.

The orchestrator's briefing asks that the checks of a queue with a worktree of its own cover the typecheck, the tests
and, where the work touches it, the build: a model-free integration is exactly as safe as its list of checks (MI2).

**Built, and where it differs from the design (MI2).**

- The `nexus` session's `runtime` is `external`, as the user's session's is, not a new value `none`: no reader needs to
  tell the two apart, and a new runtime value would reach every switch over runtimes.
- The orchestrator is not told of Nexus's acceptance in its next notice, as M6 said: no notice lists "the steps
  accepted since" yet (that comes with the routine reviews' helper). It learns of it from the run-finished notice
  ("Integration (run and accepted by Nexus, without a model): …"), and gets no review notice for such a step: the step
  is in `review` for the moment between its passed checks and Nexus's acceptance, and the notice skips it
  (`acceptedByNexus`, one predicate for the engine and the notice).
- A conflicting pull is shown in `nexus status` and the orchestrator's overview (round 2 of MI2), not yet on the
  dashboard (M9 said both): that is left for a later queue.
- The merge is made within one look of the engine (git merge-tree, then git merge, then the events), so a drain or a
  Pause cannot fall between the step's start and its done; only a server that stops in that moment leaves it open,
  which the next look repairs (M11). Found while testing it: a Resume after the restart continued the open step the
  usual way, by opening it for the worker; it now goes to the engine's look, which runs the step again without a model.
- The update's drain did not wait for a worktree setup run outside the checks (a new worktree's, or one after a merge
  at a step boundary): `Engine.idle()` looked only at the agents and the checks. It waits for it now, and a drain that
  cannot wait ends it without counting a failure.
- Found while testing: test temporary folders that nest (each test pointing TEMP inside the last one's) made worktree
  paths long enough that git commands failed on Windows; the new tests take their folders from the system's temporary
  folder as it was at the start.

## Never two queues in one checkout

Decided by the user on 2026-11-14: queues run side by side only in worktrees of their own, never two in one checkout,
and no more at once than a server-wide limit (default 2). Two agents committing in one working tree mix each other's
changes into their commits and their checks; and every running queue spends the same subscription, so how many run at
once is the user's setting, not something each project decides alone.

- A checkout is held by a run that will go on there, also while paused or waiting (a usage wait, a retry, an
  approval, a review); a halted run holds none, and going on with it checks the checkout like a start. A paused run
  holding its checkout means a forgotten pause keeps others out: better than a resume that finds its tree changed
  under it.
- The limit counts only runs at work (running or pausing, not waiting for a review or an answer): a queue waiting for
  the user costs nothing, and counting it would let one unanswered review stop every project.
- A queue back from waiting waits for a place too (decided by the user on 2026-11-15, queue LQ, after five queues ran
  under a limit of four: two waited for answers, two others started in their places, and the answers came). Its
  engine asks the coordinator before it opens the turn of its answers or a send-back, or its next step; with the limit
  full the run is held (`held` in run.yaml) rather than paused, so nothing of it changes but that it opens nothing,
  and the coordinator lets the held runs go on first when a place frees, in the order they became ready: what has
  begun goes ahead of what has not. The hold is written on the run, not kept in memory, because the coordinator and
  the dashboard read it across projects; the only thing kept in memory is which answers reached a live turn, which a
  restart (pausing every run) loses harmlessly. Counting follows the same line: a queue counts from when its engine
  lets it go on, not from when its derived status turns back to running (an answer recorded, a review accepted), else
  the queue on its way back would fill the place it is about to ask for.
- What reaches a live turn is never held: an answer to a worker that works on beside its question (`--can-continue`),
  a message to a working worker. Holding it would cut into a turn at work; and such a worker counts while it works,
  so no other queue takes its place meanwhile.
- A direct start is refused with the reason (the user or the orchestrator asked now, and should know at once); a
  planned start waits and says why on its plan, and starts by itself. Waiting starts go in the order the plans were
  made, across projects.
- One coordinator over the projects' engines (`apps/server/src/coordinator.ts`), because the limit and a queue ending
  in one project concern the others: the engines stay per project and ask it, and it runs the pass over every
  project's due plans, looking again after each start. The waiting reason is written into the plan's file (`held`),
  since the project's state alone cannot know what other projects run.

## Resuming worktree cleanup (queue CW1)

PT exposed a gap between two individually reasonable checks: cleanup checked a clean, merged worktree, then
`git worktree remove`/recursive removal could remove `.git` or its registration before failing on another file.
The next Clean up could only report an unreadable Git status. A successful merge does not prove that the remaining
folder still belongs to that cleanup, nor that someone has not written new work into it.

The server now saves a versioned `cleanup_proof` in the queue's existing `git.yaml` **before deletion**. That file
already has an atomic writer and belongs to the server; a second journal writer or a marker inside the directory
being deleted would weaken the contract. A separate top-level field also survives the existing `cleanup.waiting`
and merge-wait patches in `merger.ts`, and step-round updates in `gitinfo.ts`. No migration invents evidence for old
queues. The proof lasts until worktree removal, registration cleanup and branch deletion all succeed and `cleaned`
is recorded together with clearing the proof.

The proof binds the canonical target and Git common directory, filesystem identities (device, file ID and birth
time), the merged tip and destination ref, and a manifest of all entries. Ignored files and empty directories are
included: Git alone cannot detect foreign additions to node_modules after cleanup starts. Regular-file bytes and
link text are hashed; file timestamps and mode also detect rewrites, while directory timestamps are excluded
because deleting children changes them. Junctions and symlinks are recorded as links, never traversed. An unreadable
entry or unavailable identity refuses cleanup. This costs a full filesystem walk and content hashing, and the
manifest makes git.yaml larger while cleanup is pending; that is the cost of proving an unchanged remainder even
after Git metadata has vanished. A mere boolean "cleanup started" or a root marker would not prove content safety.

Deletion uses unlink and nonrecursive rmdir instead of Git's initial recursive deletion or a recursive Node
fallback. Each attempt checks the whole remaining tree against the proof before removing anything, then checks
each entry and its parent identities immediately before deletion. Only an unchanged subset is accepted. A new
child arriving during removal prevents rmdir; a replacement or changed file prevents unlink at the next check.
This is recovery from interrupted local operations, not an OS transaction against a hostile process racing the
final filesystem syscall; users must not keep editing a worktree they are deleting. The queue's shared merge lock
serializes the dashboard and server callers. No running queue is eligible. Removal retries transient Windows
errors up to eight times with increasing 250 ms delays, rechecking the proof on each attempt. A fake-runtime
survey test exposed a short EBUSY while its exiting worker still held the empty directory; keeping the former
bounded retry behavior handles that without treating a lasting lock as success. Once the directory is gone,
`git worktree remove` removes only its registration; a global prune would affect unrelated missing worktrees.

A missing target is an empty subset. A missing branch can complete only when the recorded tip is still in the
recorded destination; a changed branch is refused. The automatic merger checks for pending cleanup before judging
the branch, so a restart after branch deletion can finish the final record. Completed cleanup is idempotent and
does not touch a later folder or branch at the old names. Surveys retain their existing manual retry after a
recorded cleanup wait.

Real temporary Git repositories reproduce partial removal with deterministic EPERM injection, both with and
without worktree registration, then reload the store and construct a new Merger. Tests cover content and identity
changes, ignored additions, branch/base movement, missing folders, deletion before/after branch removal, Windows
long paths, legacy refusal and preservation of the merged commit. The injected error does not identify the cause
of PT's original EPERM; lock/permission investigation remains separate. No real PT/WK remainder or live server was
used. The legacy recovery path preserves the entire remainder outside its old path and requires independent
inspection before discarding it; missing branch evidence is restored only from a verified tip, never guessed.

### Worktree handle investigation: negative reproduction (queue WH1)

WH1 initially attributed the PT remainder's handle to the live Nexus server. The user's subsequent exact-path
screenshot corrected that attribution: `codex-command-runner-0.167.2.exe`, PID 364580, held a File handle named
`C:\Code\Nexus.worktrees\PT`. The server's earlier matches referred to `.nexus/queues/PT/review`, not the worktree.
The image establishes ownership at that observation, not the creating session, job membership or safe termination
of a later process at that PID. Neither WH1 nor WH2 changed that process, the live checkout or the real PT/WK folders.

A Windows probe used separate temporary Git repositories and NEXUS_HOME, fake Claude/Codex runtime paths, and
development servers on ports 50805 and 62890. The successful extended probe ran a fake Claude worker through its
work step and integration, accepted reviews with the existing fake reviewer, then called the development server's
cleanup route. Its worktree was removed while the same server continued answering requests. A separate finished,
merged queue was also removed. After restarting only that development server, both a partial remainder (without
`.git`) and an empty remainder with CW cleanup proofs were removed. An empty legacy remainder without a proof was
refused with HTTP 409 and preserved. The partial-removal fixtures deliberately injected EPERM before startup;
that injection tests recovery, not the origin of a persistent Windows lock.

A diagnostic preload in those server processes wrapped `fs.watch`, recording PID, path, creation stack and close
events. The observed paths were the temporary registry file and the project's `.nexus` tree, including newly
created worker sessions and queues; none pointed into either worktree directory. `main.ts`'s `watchProject` watches
the store directory, `dropProject` closes its watcher, and the handover release awaits watcher closure. This probe
therefore does not justify closing a project watcher when one queue ends: other queues still need it. The inspected
file route uses `files.ts`'s `head` with a finally-close and `Readable.toWeb(createReadStream(...))`; `gitinfo.ts` runs
synchronous child commands with explicit cwd. The probe did not exercise interrupted HTTP file streams or enumerate
native handles, so it does not exonerate every file-serving path or establish the historical PT handle's origin.

WH1 stopped without a production fix or a claimed regression test: no before-fix lasting lock was reproduced.
The review artifacts retain the standalone probe and its PID-tagged observations. The subsequent image supplies
the missing handle name/type; the creating session and events preceding the lasting lock remain unestablished.
A process match alone is insufficient for choosing a fix.
The real remainder stays untouched until that evidence is available. Any later user-controlled maintenance must
first let active work finish; legacy recovery still preserves and independently inspects the remainder as described
above, and must never fabricate a CW proof or force-close a handle.

### A Codex cleanup refusal while termination is completing (queue WH2)

The separate WH1 runtime log contains `Access is denied` at 2026-11-16T17:23:50.655Z, followed by the worker's
exit. That old message did not name a Windows operation. WH2 reproduced the same cleanup symptom with installed
Codex 0.167.2 in temporary directories, under a copy of Nexus's Windows worker host with diagnostic logging.
Three short `gpt-6-luna` turns each ran only `Write-Output`: first reproduction, operation-level diagnosis, then
verification of the bounded-wait change. MCP servers, plugins, apps and sub-agents were disabled, the sandbox
remained workspace-write with approval never, and no administrator rights or sandbox weakening were used. A
model-free `command/exec` attempt cleaned up before the boundary and did not reproduce the unified-exec case.

The diagnostic trace locates the reproduced refusal in `worker-job.cs`, `End`: OpenProcess and IsProcessInJob
succeeded for an owned job member, TerminateProcess returned false with error 5, and WaitForSingleObject(handle, 0)
returned 258 (timeout). In the verification trace the same sequence was followed by a wait on the **same retained
handle**, which returned 0 (signaled); cleanup acknowledged success and the runtime remained available. The old
code threw before giving that pending exit the two seconds it already allowed after a successful TerminateProcess.
This is consistent with [Windows' asynchronous termination contract](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-terminateprocess).
The trace establishes a Codex-created job member, not which executable that member was; it does not identify the
historical PT process. A worktree deletion attempted while the host/runtime still used it as cwd was EBUSY, which
alone cannot attribute its handle to a runner. After the owned host exited, each probe's worktree was removable.

`End` now captures the termination error immediately and awaits actual exit on that handle for the existing
two-second deadline (`AwaitExit`). Only a signaled handle counts as success; an error leaving the process alive
still fails with the original Windows code, and a successful request that never finishes still times out.
OpenProcess and IsProcessInJob failures now name their operation. Membership checks, non-inheritable job ownership,
kill-on-close, the engine's cleanup barrier and CW's deletion proof checks are unchanged. There is no PID/name-based
fallback, privilege change or new protocol message. The existing `F` error payload simply has more useful text.

The native regression replays the observed error-5 result against a real retained process handle and a real empty
directory held as its cwd, then permits exit; another case leaves it alive and checks failure. This deterministic
test models the OS return sequence; it does not pretend a scheduling race will recur on demand. A development-server
test with fake Codex uses real helpers and Windows jobs, including a helper that adds a deny-PROCESS_TERMINATE ACE
to **its own** DACL. That distinct, genuine OpenProcess refusal halts the queue before the next step, ends its whole
worker job and releases its directory; Resume then completes. Normal step cleanup, immediate stop/resume, deletion
of the completed temporary worktrees while the server lives, and another worker retaining its directory are checked.
The existing worker tests cover reported stop, Stop now, shutdown, crash and same-runtime continuation too.

One further, explicitly approved turn tested natural app-server exit separately from Nexus cleanup. Its temporary
host kept the non-inheritable kill-on-close job open after the runtime exited, and used a cwd **outside** the empty
worktree. Before sending EOF to app-server, it enumerated only its job, opened query/synchronize handles, verified
membership on those handles, and recorded full executable paths and creation times. Those retained handles pinned
identity across exit. The captured processes were codex.exe, codex-code-mode-host.exe, codex-computer-use.exe and
two conhost.exe instances; no codex-command-runner was still present at that snapshot after the shell command.
All five handles were unsignaled before EOF and signaled after app-server's exit code 0. The worktree changed from
EBUSY to removable **while the guard still lived, before its cleanup**. A second snapshot after two seconds had no
new job member and all retained handles remained signaled. The guard then completed cleanup and exited. Its raw
RPC trace records one successful 303 ms unified-exec PowerShell command. This observes graceful EOF after a short
command, not abrupt app-server failure or a command runner captured while still executing.

The historical PT runner's continued existence after its owning session remains unexplained: the isolated probes
did not leave a helper alive after full job shutdown, even before this change, and the final natural-exit probe
also released the directory. The proven fix addresses a premature cleanup failure, not a proven source of that
historical orphan. No further runtime probes are implied by this finding. Existing session/version records must
first establish which launcher and ownership mechanism created that runner; a future failure needs observation
while the owned runner exists, not selection by an old PID. Legacy PT recovery still requires user-controlled
maintenance after active work finishes and preservation/inspection of the remainder; no retrospective cleanup
proof may be fabricated and no historical PID may be used for termination.

The four real turns reported 89,454 input tokens (44,032 cached) and 274 output tokens, 89,728 total. On the ChatGPT
subscription no dollar charge was reported. The [published GPT-6 Luna API rates](https://developers.openai.com/api/docs/models/gpt-6-luna)
give an API-equivalent estimate of $0.00511952, not a measured bill ($0.00126578 for the final lifetime probe).
The real turns were necessary because plain helpers cannot model Codex's internal teardown ordering, and the
model-free command/exec call did not reproduce it. All other probes and automated tests used no model.
