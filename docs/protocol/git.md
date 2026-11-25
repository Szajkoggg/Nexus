# Worktrees, integration and merging

Part of [the protocol](../PROTOCOL.md).

See also: [Server API](api.md#server-api).

## The integration step

A queue with a worktree of its own ends with a second step Nexus keeps, after the closing refactoring step and
whatever `coding` says (`packages/protocol/src/closing.ts`, `integrationStep`): in the queue's worktree a worker merges
the current base into the queue's branch and runs the queue's checks there, so that the queue's work and what reached
the base meanwhile are tested together. The base then only moves forward to that result (a fast-forward), so nothing
new arises on the base itself.

- **Which queues.** One with `worktree: auto`, or one the server marked `integration: true` in `queue.yaml` when it
  first gave the queue its worktree (an auto worktree it made, or a path the queue names that is not the project's
  checkout). The mark is the server's: a draft cannot set it (it is dropped), a revision keeps it, and it is not part
  of what an approval pins. A queue that worked in a worktree before the step existed (a path, no mark) has none.
- **Not for a survey run.** A queue with `maintenance: survey` has none, even in a worktree of its own: it leaves no
  commit (Nexus stops one that does), so there is nothing to merge back; its worktree is removed once it is done (see
  "Cleaning up a survey's worktree"). The same template in `fix_small` mode has one, as any worktree queue.
- **Kept like the closing step.** Not in `queue.yaml`'s `steps`; derivation adds it last (`stepDefs`), so it stays last
  when a revision adds steps. Its id is reserved: `<queue>.integrate` (a draft with a step of that id is refused); the
  state marks it with `integration: true`. Its text is Nexus's standard (`INTEGRATION_TITLE` "Integration",
  `INTEGRATION_GOAL`, `INTEGRATION_ACCEPTANCE`). Review level 2, as if drafted so; the user may set another.
- **It cannot be bypassed by agents.** `nexus queue set Q --step Q.integrate skipped` is refused; `nexus queue set Q
  finished` is refused while it is not done.
- **It is the last step**: the queue is `done` and the run `finished` only after it, and the orchestrator's notices
  that speak of a queue's last step mean it. The queue's report is the step's before it (queue MI, "Without a model");
  its opening asks for one only when the queue has none.
- **Runs again after new work.** Once it has run, any other step that starts afterwards (a revision's new step, or the
  closing step running again) sets it back to `pending`: the base is merged again into what the branch has become. Its
  own start leaves the closing step as it is.
- **Its opening** (`apps/server/src/integration.ts`, `prompts.ts`) names the queue's branch and the base to merge: the
  branch the worktree was made from (`git.yaml` `base`, when it is a branch), else the branch the project's checkout is
  on, with that branch's commit now. The worker runs `git merge --no-edit <base>`, never rebases or pushes, and changes
  neither the base nor another checkout. Without a conflict (or when the branch contains the base already) it runs the
  checks, fixes on the branch what the two sides break together, and reports done with the resulting HEAD. On a
  conflict, with the project's `resolve_conflicts` on, it resolves it, commits the merge, runs the checks and names the
  conflicting files and how it resolved each (the step's review judges it); with it off, or when it cannot resolve one
  with confidence, it aborts the merge (`git merge --abort`) and stops: `nexus stop Q.integrate --condition "The
  integration found a conflict that it does not resolve" --reason "<files, why>"` (`INTEGRATION_CONDITION`). The queue
  then waits for the user, who resolves it (in the worktree, or with a new revision) and goes on with Continue; the
  step runs again. Without a base branch to name, the opening says so and the worker stops the same way.

### Without a model

**Status: built (queue MI, step MI2).** The reasons are in DESIGN.md, ["The integration step without a model"](../design/git.md#the-integration-step-without-a-model-queue-mi); the
marks **(M1)**…**(M13)** are MI1's proposals, which the user accepted on 2026-11-18 as written. The engine's part is in
`apps/server/src/engine.ts` (`integrateWithoutModel`), the git part in `apps/server/src/integration.ts`.

- **The queue's report (M1)** is asked of the last step that runs with a model before the integration step: the
  closing refactoring step, or, in a queue without `coding`, its last own step. The opening's `last` means "no step is
  pending but this one and the integration step", and its text says "This is the queue's last step before its
  integration step, which Nexus runs after it (without a model when the merge is clean)."; the `nexus report` command
  is unchanged. The integration step's worker is asked for it only when the queue has no `queue.report` yet. The engine
  never writes `report.md`. The run-finished notice to the orchestrator gives the report's summary, or "It has no
  report.", and then the integration step's summary ("Integration (run and accepted by Nexus, without a model): …").
- **The `nexus` session (M2).** The server keeps a session with id `nexus` (`NEXUS_SESSION`) and role `nexus`
  (`session.yaml` `runtime: external`, `launched_by: nexus`, title "Nexus (without a model)"; `ensureNexusSession`), one
  per project, whose `events.jsonl` and `activity.jsonl` only the server writes: `step.started`, `step.progress`,
  `step.done` (`summary`, `commit`, `activities: [integration]`), `queue.stop` and `review.accepted`, each only for an
  integration step it runs. The derivation takes them as any session's; of the orchestrator's events it takes
  `review.accepted` only. A step whose latest `step.started` is the `nexus` session's has `model_free: true` and
  `session: nexus` **(M13)**; a worker's `step.started` clears it. The step's round in `git.yaml` has `session: nexus`.
  The session has no process and no inbox.
- **When (M3).** When the integration step is next (after the merge train's hold, as before), the engine goes without
  a model when Nexus runs the checks (the engine has the capacity coordinator), the queue has a worktree of its own
  without uncommitted changes to tracked files, and the merge is plain; else a worker opens the step as above (the
  worktree dirty, a conflict to resolve, an engine without the checks). A step that goes on (Continue after a stop, a
  send-back) is opened by a worker as above.
- **The sequence**, in one look of the engine: the merge is tested (`git merge-tree --write-tree --name-only HEAD
  <base>`); `step.started` from `nexus`, the round's start; `step.progress` "Nexus merges main into nexus/W without a
  model"; `git merge --no-edit <sha of the base>` (with Nexus's name as the committer only where git has no identity
  configured); `step.done` with the resulting HEAD as `commit` and a summary of facts, "Nexus merged main (3f2a1c9e04b1)
  into nexus/W without a model: 7 commits, 12 files changed, 340 insertions(+), 85 deletions(-); no conflict." or
  "nexus/W already contains main (3f2a1c9e04b1): nothing to merge."; the round's end. The checks then run as after any
  `step.done` (["Checks run by Nexus"](checks.md#checks-run-by-nexus)), the setup first when its inputs changed (below).
- **A conflict (M4).** No merge is made (a merge that conflicts after all is aborted). With `resolve_conflicts` off,
  `queue.stop` from `nexus` with `INTEGRATION_CONDITION` and the reason "<files>: Nexus does not resolve conflicts (the
  project's resolve_conflicts setting is off)"; with it on, a worker opens the step as above, its opening adding "Nexus
  tried the merge first: <files> conflict(s)." Without a base branch to name: `queue.stop` from `nexus`, reason "no base
  branch to merge".
- **A failing check (M5).** A set of the `nexus` session's `step.done` that fails twice gives the check-fix round as any
  (`check_fix` 1, the limit and disputes unchanged), but its `check_failed` entry goes to the run's worker session (the
  one that ran the step before), and its text begins with what the step is: "This is queue W's integration step
  (W.integrate), kept by Nexus. Nexus merged main (<sha>) into the queue's branch nexus/W in this worktree without a
  model (HEAD <sha>), and the checks failed on the result: the step is yours now." and the integration's rules (fix on
  the branch in small commits, never rebase or push, change neither the base nor another checkout). From the worker's
  `nexus step start` the step is the worker's, as above.
- **Accepted by Nexus (M6).** When the step is `model_free`, every check of its latest set passed (flaky ones included),
  the set has at least one check, its review level is 2 or 3 and the review was not handed to the user, the engine
  writes `review.accepted` from `nexus` with the text "accepted by Nexus: a clean merge without a model, and every
  check passed" (`acceptedByNexus`, `packages/protocol/src/checks.ts`). The orchestrator gets no review notice for such
  a step; it learns of it from the run-finished notice. At level 1, and when the queue has no check at all (the summary
  then ends "No check ran: the merge is untested."), the step goes to its review at its level.
- **Restart, drain, Pause, Stop (M11).** The merge is made within one look of the engine, so a drain or a Pause does
  not fall between its start and its done; a Pause takes effect at the review, as during the checks. `Engine.idle()` is
  false while a worktree setup runs (a new worktree's, or one after a merge at a step boundary), as while checks run,
  so an update's drain waits for it; a drain with `--now`, or one whose deadline came, ends it instead, which counts as
  neither success nor failure: it runs again when the held run goes on. A setup inside a check set is the check set's
  (drained, stopped and run again like a check). A server that stopped between the step's start and its done leaves
  the step `running` from `nexus` with no `step.done` after its start: when the run goes on (Resume after the restart,
  or by itself after an update), the engine runs `git merge --abort` where `MERGE_HEAD` exists, closes the open round,
  and runs the step again from its start (a merge already committed is found as nothing to merge); no worker opens it.

**The setup again after a change of its inputs (M7, M8).** `git.yaml` `setup` has `sha`: the HEAD on which the setup
last succeeded (the first setup: the worktree's base commit), and `reason` (why it ran last: "first setup",
"package-lock.json changed"). The project-only setting `defaults.worktree_setup_inputs` (a list of paths or globs
relative to the worktree's root: `**` any folders, `*` and `?` within a name) names the files whose change makes the
setup run again; by default (`WORKTREE_SETUP_INPUTS`) `**/package-lock.json`, `**/npm-shrinkwrap.json`, `**/yarn.lock`,
`**/pnpm-lock.yaml`, `**/bun.lockb`, `**/bun.lock`. In a worktree whose setup has succeeded once, when `git diff
--name-only <setup.sha, else base.sha> HEAD` names one of them:

- before a check set (any step's), the setup runs first within the set's grant, recorded on the set (`setup`: `name`
  ["worktree setup"](files.md#server-owned-runtime-files), `command`, `reason`, `runs` as a check's, logs `checks/<step>/r<round>f<fix>-0-setup.<run>.log`,
  `ok`, `flaky`); it is run once more after a failure; failing twice, its checks are not run, and the set stops as a
  machine cause, which the worker cannot fix: `interrupted` with `unrunnable`, the run halted with its output, no
  check-fix round (queue CK; docs/protocol/checks.md, "Checks run by Nexus"). Passing, `setup.sha` becomes HEAD;
- after a merge at a step boundary (below), before the step opens: `setup` loses its `done_at` and gets the reason, so
  the engine runs it as a first setup (a failure is tried once more, a second halts the run, and it runs again when
  the run goes on).

**Merging the base at a step boundary (M9, M10).** In a queue with an integration step, when the engine is about to
open the next step after another (one of the queue's own steps, or the closing step; never the integration step, and
never the same step going on), it merges the base when the worktree has no uncommitted changes to tracked files,
`integrationContext` names a base branch, and the base's commit is not already in HEAD. It tests the merge first (as
above); clean: `git merge --no-edit <sha>`, then the setup when its inputs changed. A conflict: no merge. `git.yaml`
records it under `pulls` (oldest first; a conflict only once per base commit and step): `at`, `before` (the step about
to open), `base` (the branch), `sha` (its commit), `from` (HEAD before), `to` (HEAD after; absent on a conflict),
`conflicts` (the files; only on a conflict), `setup` (true when the setup was to run again). The step's opening then
says "Before this step Nexus merged main (<sha>) into this branch: <n> commits, changing <files>." or "main (<sha>)
conflicts with this branch in <files>; Nexus did not merge it. Do not resolve it here: the queue's integration step
will." While the last pull is a conflict and the queue is not done, `nexus status` (and the orchestrator's overview)
shows it under the queue: "base: main (<sha>) conflicts with the queue's branch in <files> (found before step <step>,
<time>); Nexus did not merge it, the integration step will". The dashboard does not show the pulls yet.

Before it runs `git merge`, Nexus records the intent in `git.yaml` as `pulling` (`at`, `before`, `base`, `sha`, `from`)
and removes it once the merge ended (queue LF, F4). Before any step opens at a boundary, a `pulling` still there means
a server ended in the middle of that merge: when MERGE_HEAD is its `sha` and HEAD its `from`, the merge is aborted
(`git merge --abort`, as the integration step's half-done merge is; it keeps untracked files, and the merge began
without changes to tracked files), the record goes, and the base is pulled again. A merge under way in the worktree
that Nexus did not start (no such record) is left as it is, and the run halts ("a merge is under way in <path> that
Nexus did not start …") rather than open the next step on it; so does a merge of its own that would not abort, whose
`pulling` is kept, so after Resume it is still named as Nexus's own and aborted then (queue LH). A server that ended
after the merge's commit but before git.yaml was written leaves `pulling` with HEAD the merge of `sha` into `from` (its
parents): the pull is recorded then as it would have been, `to` that HEAD, and the setup marked to run again when the
merge changed its inputs.

With the pulls:

- the closing step's commit range starts at the last `pulls[].sha` merged in (`to` present), and ends at the latest of
  the own steps' round ends and that pull's `to`; else as above;
- a disputed check's base run uses that same commit, else `base.sha`.

## Git on the dashboard

The server reads git for the dashboard (`apps/server/src/gitinfo.ts`), only locally: `rev-parse`, `log`, `rev-list`,
`reflog`. It never fetches, so remote-tracking refs are as old as the last fetch anyone made.

- **Commits per step.** `git.yaml` records the HEAD of the queue's checkout when a step opens (or a send-back reopens
  it), before its worker is told of it, and at the end of the turn in which it got its outcome (at the latest when the
  next step opens); the step's commits are those between (`start..end`), with
  their subject, author, time, and files and lines changed. A round still at work runs to the present HEAD.
- **Foreign commits.** In the project's main checkout others may commit too. A commit made outside every turn of the
  worker's session on that step is marked `foreign`: the server records the HEAD at each of the runtime's `turn_start`
  and `turn_end` in the round's `turns`, and a commit of the round is the step's when it is in some turn's
  `start..end` (an open turn runs to the round's end, else the present HEAD). Commit times do not count: git, the CLI
  and the server may disagree about the time after a clock step (see ["Times and order"](sessions.md#events-sessionsideventsjsonl) under Events). A round recorded
  before `turns` existed goes by the commit's time against the turns in `activity.jsonl` (`turn_start` .. `turn_end`,
  with two seconds' slack). In a worktree of the queue's own nothing is marked.
- **The branch.** The queue's `branch` (else the checkout's current one): ahead and behind of its base (an auto
  worktree's recorded `base`, else the queue's `base`) and of its remote-tracking ref (its upstream, else
  `origin/<branch>`), with `at`, when that ref last changed (its newest reflog entry).
- A project that is not a git repository shows none of it.

## Merge back and clean up

A finished queue (`done`) with a worktree of its own is merged back into its base and cleaned up by the server with
local git (`apps/server/src/mergeback.ts`, `merger.ts`): by Nexus itself when the project's `merge_back` is on, else by
the user's two actions in the dashboard, each confirmed first. There is no CLI command or event for either, and the
HTTP writes take only the dashboard's own requests, so neither the orchestrator nor a worker can trigger them.

**A queue with an integration step** goes back one way only, whoever asks: its base moves forward to the integrated
commit (the end of the integration step's last round in `git.yaml`), `git merge --ff-only`, never a merge commit on
the base. The server and the user's Merge back judge it the same way (`judgeMerge`) under one lock per queue, so they
never race; whoever comes second finds it merged. Nexus does it by itself (`merge_back` on) when, after any change:

judged in this order:

1. every step is closed and none waits for its review; unconfirmed provisional work holds it only with
   `provisional_counts` off; the integration step's last round is closed (a round still open within a minute of the
   step's end is still ending: nothing is judged yet); the queue's branch is still at the integrated commit; the
   integration step's checks in its last round passed, and, when the base moved on, the step has run again fewer than
   twice by itself (`merge.reintegrations`); the base is checked out somewhere, not only detached, not in the live
   worktree. Else it waits and tells, and holds nothing;
2. a step at work in the base's checkout (running, waiting for an answer, or a pause waiting for the step's end) is
   held at its step's end first: the engine holds such a run (the boundary a planned deploy uses; `run.yaml` paused,
   `resume_after_restart`), so its uncommitted work is not judged as a dirty checkout;
3. the base's checkout has no uncommitted changes to tracked files (untracked files never keep it), else it waits and
   tells;
4. when the base moved on (it is no longer an ancestor of the integrated commit), the integration step goes back to
   `pending` (a `changes` entry `kind: status`, `by: nexus`, with the reason; the queue is no longer `done`) and the
   queue's run starts again: a new round, reviewed again. The base's checkout stays held meanwhile: a run there that
   reaches its step's end is held too. After two such runs by itself it waits for the user, whose Merge back runs it
   once more and starts the count anew (`merge.reintegrations` back to 0);
5. the fast-forward; then the runs held for it go on (`releaseHold`).

A hold lasts at most one run of the integration step (its checks and its review included). Whenever the merge back
cannot go once a run is held (a dirty checkout, failed checks, the limit, a run again that halts, waits, or cannot
start), the held runs go on at once, and the wait is recorded with them (`merge.waiting.released`), so the user and the
orchestrator are told; nothing stays held. Nothing moves while an update, a deploy or a hand-over is under way.

What keeps it waiting that the user should know of is recorded in `git.yaml` `merge.waiting` (once per reason, and
again when held runs went on: `released`, their queues): the user's waiting list has an item of kind `merge` with the
reason (and, with `released`, "; the run of queue M, held at its step's end for this merge back, goes on") and
`merge` (`into`: the base branch, `branch`: the queue's, when it names one) for the Merge back on its card, and the
orchestrator is told the same (`notify:mergewait:…`); a merge back Nexus did is told to it too
(`notify:merged:…`). While something waits it is looked at again every 30
seconds, since git can change what holds it without a file of the project changing. Nothing is pushed: the base goes
out with the next deploy, and a deploy planned after such a queue waits for its merge back (see ["Planned deploys"](api.md#server-api)),
as does, with `merge_back` on, a queue planned after it (see ["The plan"](planning.md#the-plan)).

**The merge train** (queue MQ; `packages/protocol/src/train.ts`, held and let go by `merger.ts`). With `merge_back`
on, the queues that go back into one base integrate one at a time, so that each integration step merges a base that
already has the queues before it, and a fast-forward never makes the next one run again. Per base, derived from the
files alone (a restarted server finds the same order):

- **One queue holds the base**: its integration step runs or waits for its review or an answer (unless its run
  halted), it was asked to run again (`merge.reintegrating`), or it is integrated and waits for its fast-forward (no
  `merge.waiting`, no `merge.queued`, and no unconfirmed provisional work holding it while `provisional_counts` is off).
- **The others wait in line**: a queue whose every other step is closed, whose integration step is pending and whose
  run is going (or held there), ordered by when its own steps ended (the latest `finished_at`); and a queue back from
  a wait (`merge.queued`), ordered by `since`. At the end of the step before its integration step, the engine asks the
  merge back (the boundary, as above): while another queue holds the base or is before it in line, the run is held
  there (`run.yaml` paused, `resume_after_restart`, reason "held at the end of step B2: it waits to integrate after W
  (one queue at a time merges back into main); it goes on by itself when its turn comes") and goes on by itself when
  its turn comes (`releaseHold`). A queue's own steps before its integration step never wait.
- **A fast-forward that waits** on something the user should know of (`merge.waiting`: a dirty checkout, failed checks,
  the limit of runs again, …) takes its queue out of the train: the next queue in line goes. Once it could go again
  while another queue holds the base (or one is before it in line), its wait is replaced by `merge.queued` (`since`:
  when the wait began), so it goes after the queues that were waiting before it got stuck; in its turn it is
  fast-forwarded, or, the base having moved on, its integration step runs again. One queue moves (or holds the
  checkout of) a base per look.
- **Where it shows**: each waiting queue's `train` in the project state (`base`, `position` in the line, `after`: the
  queue just before it, the one holding the base for the first in line; none when it goes next); `nexus status` says
  "integration: waits to integrate after W (one queue at a time merges back into main); it goes on by itself"; the
  dashboard's plan shows "waits to integrate after W" on the queue in progress.
- With `merge_back` off there is no train: the user merges back with Merge back, in any order, when they choose. The
  user's Merge back does not wait for the train either.

With `merge_back` on, the cleanup follows the merge (by anyone) once no provisional acceptance of the queue waits for
the user; a Fix it until then runs in the worktree and goes through the integration step again. A cleanup that is
refused waits and tells like the merge.

**A queue from before the integration step** (no `integration` mark) keeps the user's merge as it was:

- **The base** is recorded when Nexus makes an auto worktree: `git.yaml` `base.ref` (the queue's `base`, else the
  branch the project's checkout was on) and whether it is a branch.
- **Merge** (a queue without an integration step) runs in the worktree where the base branch is checked out: `git merge
  --no-edit <branch>`, a fast-forward when possible, else a merge commit. Refused when the base is checked out nowhere (or only detached), when that
  worktree has uncommitted changes to tracked files, when a run is going there, or when it is this server's own live
  worktree. On a conflict the merge is aborted (`git merge --abort`) and the refusal names the conflicting files;
  nothing is left half-done. A branch already in the base is reported as such. Nothing is pushed.
- **Cleanup** checks first, and removes nothing when refused: the worktree must have no uncommitted changes
  (untracked files included), and the branch must be merged (into its upstream if it has one, else into the base's
  checkout, as `git branch -d` decides). The server saves `cleanup_proof` before deleting anything, then removes
  verified entries with Node's unlink/nonrecursive rmdir (including Windows long paths), removes only this
  worktree's registration with `git worktree remove` once its folder is absent, and runs `git branch -d` (never
  `-D`). Unrelated registrations are not pruned. A filesystem error can leave a partial deletion; its proof
  stays for retry, including across server restarts. Cleanup holds the queue's merge lock, for both callers.
- Both are recorded in `git.yaml` (`merged` with `by`, `cleaned`) and shown on the queue.

**Interrupted cleanup evidence.** The optional `git.yaml` `cleanup_proof` is written only by the server, through
the existing atomic Git-file writer, in the project's store outside the target worktree. Its version 1 fields are:

- `version: 1`, `at`, canonical absolute `path`, canonical Git common-directory `repository`, and
  `repository_identity` (device, inode/file ID and birth time in nanoseconds, as a colon-separated string);
- `branch`, its verified `tip`, and `into` (the full ref checked for ancestry, or a commit for a detached checkout);
- `entries`: every entry, including ignored files, empty directories and the `.git` pointer. Each has `path`
  relative to the target (empty for the root), `kind` (`directory`, `file`, `link`) and `identity` in the same form.
  Files and links also have `digest` (SHA-256 of bytes or link text) and `modified` (mtime nanoseconds, ctime
  nanoseconds and mode, colon-separated). Integer identity/time fields remain strings to preserve precision.

Before the first snapshot, Git must identify the registered worktree, repository, branch and clean HEAD; Git
cleanliness is checked again after the snapshot. On retry, remaining entries must be an unchanged subset of the
saved manifest, the canonical target and repository must still match, the branch (if present) must still name
`tip`, and `tip` must remain merged into `into`. Directory timestamps are not compared because deleting children
changes them; directory identity is compared. Links are never traversed. The entire remainder is checked before
deletion and each entry and its parents again before removal; nonrecursive rmdir refuses new children.
Transient Windows removal errors get at most eight retries with increasing 250 ms delays, each preceded by a
fresh proof check; exhaustion leaves the proof for a later Clean up. Nexus's own cleanup after a merge back (and a survey run's) retries
only on its first try for a queue; once that failed, each later look (at most every 30 s) tries once, without the
delays, which wait synchronously on the server's one loop (queue CWA).

Every worktree cleanup, Nexus's (after a merge back, or a survey run's) and the user's Clean up, first ends the
queue's worker processes and waits until none is alive: a process still running in the worktree keeps its folder and
may write into it (queue PRC). The first look that finds one asks it to end and records nothing (it normally ends at
once). From the next look on the wait is recorded with its reason, where the cleanup's other waits go: for a merged-back
queue in `merge.waiting` (the waiting list's `merge` item), for a survey run in `cleanup.waiting` with
`processes: true` (the `cleanup` item; with that mark Nexus does look again):

- "queue Q's cleanup waits for its worker process to end (session S); Nexus kills it by force if it has not ended 60 s
  after it was asked";
- once that deadline has passed, Nexus kills it by force (on Windows its job host, which closes its job with every
  member; elsewhere SIGKILL). One that lives on after that: "queue Q's worker process did not end even when Nexus
  killed it by force (session S, process P): its cleanup waits until it has ended; end it by hand if it does not".

The wait stays, looked at again at most every 30 s, until the process has ended; then the cleanup goes and its success
clears it. The user's Clean up meanwhile is refused (409) with the same reason ("queue Q's worker process is still
ending: clean up again in a moment" at the first ask). Queue LCK, survey LC3 F2.

Missing files, a missing `.git` pointer or registration, and an entirely absent target are valid subsets. A missing
branch is accepted only with saved proof; it lets a crash after `branch -d` finish writing `cleaned`. The final
write sets `cleaned` and clears `cleanup_proof`, `cleanup` and `merge`. An already cleaned queue returns success
without touching a newly created path or branch. An interrupted automatic merge cleanup resumes before merge
judgement (which otherwise requires the deleted branch). A survey's recorded wait still requires the user's retry.

Old PT/WK remnants without proof are never inferred clean from failed `git status`. The 409 refusal identifies
the missing registered Git state and pre-deletion identity/content manifest, and asks the user to preserve and
inspect the remainder outside the worktree path before retrying with that path absent. If the branch is also
missing, a verified merged branch tip must first be restored by the user; Nexus cannot reconstruct that evidence.
No CLI repair command or second writer is added. See README, "Interrupted worktree cleanup".

## Cleaning up a survey's worktree

A survey run (`maintenance: survey`) in a worktree of its own (`worktree: auto`, or a path: the `integration` mark)
has no integration step and is never merged back: it leaves no commit. Once it is `done`, the server removes its
worktree and branch (`apps/server/src/merger.ts`), **whatever `merge_back` says**, the same way the cleanup above goes
(`cleanUp`: durable proof and verified entry removal; `git branch -d`, never `-D`), recorded as `cleaned` in `git.yaml`.
Only when:

- every step is done or skipped: a stopped survey (a stop condition, a commit Nexus found) or one with a failed step
  keeps its worktree, as evidence, until the user cleans it up;
- no provisional acceptance of it waits for the user (a Fix it runs in the worktree);
- its run is not going, and no step's last round is still open (the turn that reported the step's end still ending:
  looked at again a moment later);
- the worktree is clean, untracked files included (`git status --porcelain`).

When it is not clean, or the branch is not merged, nothing is removed. A removal failure can leave a partial tree
and keeps `cleanup_proof`. In either case `git.yaml` gets `cleanup.waiting` (`reason`, `since`; `files`: what is left, as git status
names it, the first 20, and `more`: how many besides), the user's waiting list an item of kind `cleanup` with the
reason ("survey run Q is done, but its worktree stays: 1 file: ?? notes.txt left in it; look at them, then clean up
(<path>)"), and the orchestrator is told once (`notify:cleanupwait:…`). Nexus does not try again (but for a wait for
the queue's worker processes, `processes: true`, above); the user's Clean up
on the queue's page does (refused the same way while something is left), and its success clears `cleanup`. The
dashboard offers no Merge back for a survey run.

## Pushing what was accepted

With `defaults.push_accepted` on, an accepted step's work is pushed by the server, not by an agent
(`apps/server/src/accepted.ts`):

- When a step enters review, the server records the HEAD of the queue's checkout (its worktree, else the project's
  checkout) in `push.yaml` (`review.<step>`: `sha`, the round's `finished_at`). Recorded with the setting off too, so
  turning it on later finds the commits.
- When a step is accepted (`review.accepted`, by the orchestrator or the user), the server pushes, in the background,
  that commit, never the branch tip: `git push <remote> <sha>:refs/heads/<branch>`. The branch is the queue's
  `branch`, else the checkout's current one; the remote is the branch's upstream, else `origin`. A branch missing on
  the remote is created there. As with the push on deploy: a plain push (git refuses anything but a fast-forward,
  never forced), `GIT_TERMINAL_PROMPT=0` and `GCM_INTERACTIVE=never`, at most 60 s. A commit of the next step made
  before the push is not pushed.
- Only the queue's newest acceptance is pushed; its commit includes the earlier ones. One push at a time per queue;
  an acceptance during a push is taken up after it.
- A provisional acceptance (`review.provisional`) is an acceptance here when `defaults.provisional_counts` is on (the
  default). With it off, a push waits while its commit contains provisional work the user has not confirmed: a step
  of the project with a provisional acceptance waiting for the user, whose recorded review commit is the commit or an
  ancestor of it, and that made commits of its own (its first round in `git.yaml` did not start at that commit). The
  step is then recorded `held`, with `held_by` (`queue/step`, what holds it); the push is tried again once one of those
  is confirmed or sent to a fix (the user has seen it; the fix is a step reviewed on its own), or the setting is turned
  on. So neither the provisional work nor anything built on it (an accepted step after it, in its queue or another
  in the same history) is pushed until then.
- The outcome goes in `push.yaml` `steps.<step>` (`acceptance`, the event's id; `sha`; `result` `pushed`, `failed`,
  `skipped` or `held`; `text`; `at`; `held_by?`). A failure also sets `error` (`text`, `at`, `sha`, `step`) until a push succeeds; it does
  not undo the acceptance. It is tried again at the next acceptance, whose commit includes the failed one (which then
  shows as pushed with it), and with **Push again** (`POST …/queues/:q/push`), which pushes the step of `error`
  again. Without a remote (no upstream, no `origin`) nothing is pushed, and the step says so (`skipped`).
- With the setting off nothing is pushed.

## One queue per checkout, and a limit

Queues run side by side only in worktrees of their own, never two in one checkout, and no more at once than the
limits: the global one across all projects, and a project's own for its queues (both hold).

- A queue's checkout is its worktree (`worktree`: a path; with `auto`, the folder Nexus creates for it, under
  `defaults.worktree_dir`), else the project's own checkout (`root`). Paths are compared without regard to case or
  the kind of slash.
- A checkout is held by a queue whose run is `running` (also with a step waiting for a review or an answer),
  `pausing`, `paused`, `usage_wait`, `retry_wait` or `approval_wait`: it will go on there. A halted or finished run
  holds none.
- The limits are the setting `defaults.max_running` (a whole number from 1 to 20, default 2; see ["Global settings"](settings.md#global-settings);
  decided 2026-11-15, queue OP). The global value limits the queues running at once across all projects; a project's
  own value limits its own queues as well, and a start must keep within both. A project that follows the global value
  has it as its own limit too, which adds nothing to the global one. Each limit counts the queues whose run is
  `running` or `pausing` (across all projects, or in the project), except a queue waiting for a review or an answer
  (its status `waiting`; but one whose worker asked with `--can-continue` and works on in its live turn counts), a
  queue whose steps are all done (its run is about to finish), a run held at the limit (`held`, below) and a queue
  back from waiting that its engine has not let go on yet (its worker idle with an answer or a send-back not yet
  delivered, or between a step whose review ended and the next). Runs waiting for the usage window, a retry or an
  approval do not count.
- A queue back from waiting (decided 2026-11-15, queue LQ) asks for a place before it opens a new turn or its next
  step: the turn of its answers (a blocking question answered, or one asked with `--can-continue` and answered after
  its turn ended), the turn of a send-back, and every next step after a step's end (its review accepted), the closing
  refactoring step and the integration step included. With a limit full it is held: its `run.yaml` stays `running`
  and gets `held` (`since`, `kind: limit`, `reason`: "waits: 2 queues run, the limit is 2", also as the run's
  `reason`); it opens nothing, its inbox keeps what came (answers, send-backs, messages; a stop still reaches it), and
  the dashboard shows "waits: limit reached". It goes on by itself once a place frees: then its next step opens, or
  its inbox's entries come in one turn. What reaches a live turn is never held (an answer given while the worker works
  on beside its question, a message to a working worker): the queue is at work and counts. Pausing, stopping or a
  drain for an update drops `held`, and so does a server restart, which pauses the run; going on afterwards asks for a
  place again.
- A start from the dashboard or the CLI (`nexus run Q start`, also a Continue that starts afresh) is refused with
  409 and the reason: "queue B cannot start: its checkout is in use, queue A runs there" ("… queue A is paused there";
  "… queue A of <project> runs there" for another project's queue), "queue B cannot start: 2 queues run, the limit
  is 2", or for the project's own limit "queue B cannot start: 1 queue of <project> runs, its limit is 1".
- Resuming a halted run, continuing a stopped queue whose run halted and accepting a review of a step whose run halted
  check the checkout the same way ("cannot go on", "cannot continue"); the limit does not apply to them. A paused or
  waiting run already holds its checkout and goes on as before.
- A planned start (by the plan or a schedule) that came due but may not start waits instead: its `start.yaml` gets
  `held` (`since`, `kind`: `checkout` or `limit`, `reason`: "waits for the checkout: queue A runs there", "waits: 2
  queues run, the limit is 2", "waits: 1 queue of <project> runs, its limit is 1"), shown in the plan's `waiting`. It starts by itself once it may; a held schedule is
  never missed. A plan that is no longer due (A opened again) loses `held`.
- The server has one coordinator over all projects' engines. It looks at the planned starts of every project after
  any change to a project's files (a project's own limit among them), after a run stops going (finished, halted,
  paused, waiting) and after the global limit changes. It first lets the held runs of all projects go on, in the order
  they became ready (`held.since`), as far as places are free, and only then takes the due plans of all projects in
  the order they were made (`created_at`), looking again after each, so one pass never starts two queues into one
  checkout or past the limit, and a free place goes to what has begun before what has not. A direct start and a queue
  back from waiting let the held runs take a free place first too.
- Runs that were going before this rule came are left alone.
- The engine's long timers (schedules, usage waits, retries) are armed in pieces of at most a day, each looking at the
  clock again, so a time weeks ahead neither fires at once (Node's `setTimeout` does beyond 2^31-1 ms) nor early. A
  restart arms them again from the files; nothing fires while an update drains.
- The dashboard shows the plan with its time and how long until it, and a chip "starts at 22:00" on the row; Cancel
  ends it.
