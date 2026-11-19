# Review

Part of [the design](../DESIGN.md).

See also: [Reviewing: the pictures first, the decision in the viewer](dashboard.md#reviewing-the-pictures-first-the-decision-in-the-viewer).

## Routine reviews by a helper (queue RH)

**Status: built (RH2 the helper's run and verdicts, `apps/server/src/review-helper.ts`; RH3 the orchestrator's
notices, the audit and the statistics); RH4 the dashboard.** The user approved the proposals below but H12, which is
left out. From the user's decision of 2026-11-17 (docs/ideas/token-costs.md,
"Routine reviews leave the orchestrator's big chat" and "The review helper"). The formats are in PROTOCOL.md, "The
review helper". Points marked **(H1)**…**(H17)** go beyond the decision: RH1's proposals, each for the user's approval.

**Why.** The orchestrator handled every review in its big chat: 176 of its 586 turns in the analysed transcripts were
`nexus review accept`, each on a context of 400–800k tokens. Most of them are routine: the checks passed, the criteria
can be checked from what the step left behind. A short-lived helper on a cheaper model reads only that, decides, and
ends; the orchestrator gets the result and the exceptions. The engine's checks (queue EC) are what makes this
possible: the helper gets their results and runs nothing.

**Who it is.** A session of its own role, `helper` **(H1)**, started by the engine for one review round of one step
and ended with its verdict: no chat, no resume, no context care. Its model and effort are a setting of their own
(`review_helper`), global with a project override, Claude Code's Sonnet at medium effort by default **(H13)**; Codex
runs it too, and Claude Code is the default runtime **(H14)**.

**When it runs** **(H2)**. Only where the orchestrator would review: a step at level 2 or 3 that waits for the
orchestrator's review (the project has an orchestrator and its notices are on), once per review round. Not for a step
that waits for the user (level 1, beyond the send-back limit, handed to the user, after a Fix it), and not for the
integration step Nexus accepts itself (queue MI). With the setting off, the orchestrator reviews as before. What the
engine can tell without a model it passes on at once, without a helper **(H3)**: a question the worker asked during
the step, and the send-back limit reached (the next send-back would go to the user).

**The packet.** The helper gets a fixed packet, nothing else to look for: the step's goal, acceptance and review notes
(`review.prepare`), the engine's check results of the round (each check's outcome, flaky ones marked, the time, the
log's path), the step's diff, the round's review material, the worker's summary, and the step's earlier send-backs
(round, who, text). What the orchestrator wants a review to weigh (a promise to the user, an earlier decision) goes
into the step's acceptance or review notes when it drafts the queue: that keeps it in the files, where the helper
reads it. The packet is the helper's first and only prompt; the diff is a file beside it, the step's whole change from
its first round's start to the reported commit, with the latest round's range named and the `--stat` inline, so a
large diff costs only the parts the helper reads **(H4)**. It may read the checkout to check a criterion (a document
that should say something, a test that should exist); it never runs a build or a test.

**The verdicts.** Accept, send back, or pass to the orchestrator. It passes on when:

- a criterion cannot be checked from the packet (the look, the feel, the user's judgement, a measurement nobody took);
- the worker's summary reports a deviation from the plan (its "what was left out or differs" part says so);
- a question was asked during the step (normally the engine passes these on before the helper starts, H3);
- the send-back limit is reached (likewise);
- it doubts its own verdict.

At levels 2 and 3 it judges the checkable criteria. At level 2 that is the review: it accepts, or sends back with what
to fix. At level 3 judgement stays with the orchestrator: the helper never accepts a level-3 step; with the checkable
criteria met it passes the step on with its findings, and the orchestrator decides as today (accept, accept
provisionally, send back, ask the user) without re-checking what the helper found **(H5)**. A failing checkable
criterion is sent back at either level. A send-back of the helper's counts toward `review_send_back_limit` like the
orchestrator's **(H7)**: the limit is about the worker and the step going round, not about who reviews. A pass-on
names its reasons and the helper's findings, and the orchestrator's review notice carries both, so it starts where the
helper stopped. If more than about a quarter of the reviews are passed on, the packet lacks something: the statistics
show the share (below).

**The existing rules stay.** Review levels, away mode and provisional acceptances do not change; the helper takes a
part of the orchestrator's work within them:

- A provisional acceptance stays the orchestrator's alone: the helper has no command for it.
- Away mode reviews a level-2 step as level 3 so that the orchestrator may accept provisionally what is the user's.
  The helper goes by the step's own level **(H6)**: a level-2 step whose criteria are all checkable and met it accepts
  for good, which is what the orchestrator does at level 3 with what has nothing of the user's (RL2); everything it
  passes on reaches the orchestrator with the level-3 choices, as away mode says.
- A step that goes to the user because its level changed to 1, or for any other reason, is no longer the helper's: the
  engine ends a helper still running, and a verdict that arrives later is ignored with a warning, as an orchestrator's
  is.

**When it has no verdict** **(H8)**. The helper has a time limit (20 minutes). Past it, or when its process ends
without a verdict, or when its runtime is beyond the usage threshold or fails, Nexus passes the step on itself (reason
`no_verdict` or `unavailable`) and the orchestrator reviews it as before; there is no fallback chain, since the
orchestrator is the fallback. A helper running at a restart or an update's hand-over is started again once after it,
with the packet built again; a second one without a verdict passes on.

**Its rights.** It only reads **(H15)**: Claude Code in `dontAsk` mode with `Read`, `Grep`, `Glob`, read-only git and
`nexus status` and `nexus help`, plus three review commands, `nexus review accept`, `nexus review send-back` and
`nexus review pass-on`, which the CLI takes from a helper only for the step and round it was started for; no
`Edit`, no `Write`, not the project's own allow rules. On Codex the same as a thinking partner without a notes folder,
but with its own session folder as the working directory and only writable root, for the CLI's events. As AGENTS.md
asks of every agent: it never calls the server (the CLI writes its events), writes nothing but its own session's files,
and an action its permissions refuse is refused, not asked about: recorded in its `refusals.jsonl`, and reported in its
verdict (it passes on with `doubt`, naming what it could not do). The dashboard shows a helper's refusals but offers no
"Add rule": its rights are Nexus's, not the project's.

**What the orchestrator learns.** The verdicts are in the files: the review events of the helper's session, and the
step shows who accepted it and on which model (`nexus status`, the dashboard) **(H17)**. The orchestrator's chat gets
no line per accepted step and no turn for it. The next notice it gets anyway (a step that needs it, a question, a halt,
the run's end) lists the steps accepted since its last notice, each with who accepted it: the helper (runtime, model,
effort), Nexus (the integration without a model) or the user **(H9)**, and the helper's send-backs since, one line each
**(H10)**. This is not batching: no notice that needs action waits for another, and an acceptance alone starts no turn.

**The random audit.** A lax helper is what the other signals miss: the user does not see most level-2 steps, and a
laxer helper even lowers the send-back rate. So the orchestrator reviews again about one in ten of the helper's
acceptances (`review_helper.audit_rate`, 0.1) and records whether it agrees. Which ones is decided by a hash of the
acceptance's event id, so it needs no state, survives a restart, and a test can steer it by the id **(H11)**; always
auditing the first five acceptances after the helper's model or effort changed (**H12**) was left out by the user. An
audit rides with the next notice like the list above, with the packet's path, and the orchestrator answers with `nexus review audit`. A
disagreement does not reopen the step (later steps may build on it, as with a provisional acceptance's Fix it): it is
counted, and when the work needs a fix the orchestrator drafts it as a revision.

**Built in RH2: who starts it, and a race.** The helpers run inside the orchestrator's change handling, before its
notices (`ReviewHelpers.onChange`, from `Orchestrator.changedState`): a decision of its own in the server's list would
have kept their order in two places, and the many tests that build an orchestrator without helpers keep the old
reviews. A test found the race this leaves: the orchestrator reads the state again after carrying out its requests,
and a `step.done` written in between reached its notices before the helpers had seen it. So while helpers take
reviews the orchestrator gets no notice for a step without a `helper` yet; the helpers take it at the next change.

**Built in RH3: what rides goes last.** The list of acceptances and the audits end the notice instead of starting it,
as planned: a notice's first line is what the user sees in the chat and what the orchestrator acts on; the list is for
its overview. User acceptances are listed too (H9): the orchestrator learns of the user's reviews only this way.

**Quality on three levels** (`nexus stats --reviews`, the Stats view) **(H16)**:

1. The user's signals: Fix it, Reject, a provisional acceptance returned.
2. The cost signals: send-backs (the helper's, the orchestrator's), check-fix rounds after failed checks, and the
   helper's passed-on share by reason, marked above about a quarter.
3. The audit: how many acceptances were audited, how many the orchestrator disagreed with, by the helper's model and
   effort.

The helper's turns are records of their own in `turns.jsonl` (role `helper`), so its use of the windows is measured
like any other.

## Review material

A step's review spec says what to prepare (e.g. "before/after shots of fixtures X, Y; one phone-width sheet").
The worker registers what it produced with `nexus review add <path>…`, which copies each file into the queue's
folder (`.nexus/queues/<queue>/review/<step>/`) and records the copy (decided 2026-11-14, queue FU), as `nexus report`
does with the report: the CLI is the one writer there, so a worker kept out of `.nexus` can still add material; the
pictures outlast the working tree; and none is left untracked in a worktree, where it blocked the cleanup (as reports
did, queue WR). The worker writes the files outside the working tree, in the system's temporary folder for example,
and `scripts/capture.ts` writes there by default. Material added before, where the project's tools put it (e.g.
Honeycomb's `tmp/review/<step>/`), is shown where it is. Nexus serves both read-only and renders images, Markdown,
HTML and JSON. Artifact links and similar URLs can be registered too.

Pictures pair by a view key and a named role, checked when they are added (decided 2026-11-14, queue RS; the
standard is `nexus help review`, the rules in `packages/protocol/src/pictures.ts`). For Nexus's own dashboard,
`scripts/capture.ts` takes them: the views are data (key, route, setup actions), the afters come from the checkout,
the befores from the same list at the step's base commit in a temporary worktree, each side on its own development
instance with seeded test projects. It never blocks: what it cannot take is reported and taken by hand.

## Findings from review levels (queue RL1)

- **Every step is reviewed now, so the last step of every queue ends in review.** Before, `continue` ended a queue's
  last step `done`, and an agent whose process ended right after its report (the CLI closing, a crash after it) left
  nothing to run: the run finished. In review, the same exit read as a failed turn and was retried on a new process,
  for nothing. Now a process that ends while its run's step waits for its review is no failure: the run waits for the
  review, and then finishes if nothing is left, or starts a process that resumes the session for what comes next (the
  next step, a send-back).
- **Levels apply from the change on, not to the past** (the orchestrator's send-back of RL1). The first version
  derived every recorded `step.done` by level, so after its deploy about 38 long-finished queues stood `waiting`, their
  `continue` steps in review for the orchestrator. The simplest fix of the options: one time per project,
  `review_levels_since`, set by the server at its first start with levels; an earlier `step.done` is derived by the
  old policy of its step, which the queue file keeps (`legacy_policies`) once the old fields are gone. A marker on each
  new `step.done` would have needed every writer of events (the CLI, tests, seeds) to change, and the events written
  between the two deploys would still have been ambiguous. Checked read-only against this repository's 136 steps in
  55 queues: derived with the code before levels and with this one, none differs (without the time, 95 did).
- **A pause takes effect at the review.** A run asked to pause (by the user, or by an update's drain) paused at the
  step's end, and a step in review never reached it: the run stayed `pausing` until the review, and an update would
  have waited for an orchestrator that is not told anything during a drain. A step in review has finished its turn,
  so the pause takes effect there; the review goes on meanwhile.
- **Tests about something else than review stand in for the reviewer.** Most engine tests ran their queues through
  under the old default `continue`. With no level without review, a test project without an orchestrator hands each
  step to the user; `apps/server/test/fake-reviewer.ts` accepts those (levels 2 and 3) where the test stands in for
  the file watcher, and leaves level 1 to tests that want a step held for the user.
- **Approvals survive the change of form.** An approval pins a hash of the steps, and a step's old `review.policy` was
  part of them. Rather than a second hash rule kept forever, reading a queue carries an approval of the old form of the
  same content over to the new form (`parseQueue`), and the next write stores it so; checked against the 55 queues of
  this repository's own `.nexus` (read only): none changed its approved state.

## Level 3: provisional acceptances (queue RL2)

- **At level 3 the orchestrator still accepts what has nothing of the user's.** The queue's text named two choices
  (accept provisionally, send back); asked, the orchestrator settled it from the decision ("what is the user's goes
  into a batch"): a step with only checkable criteria is accepted for good, as at level 2, and only what has something
  of the user's goes to the return batch. Otherwise away mode, which runs level 2 as 3, would fill the batch with every
  technical step.
- **A Fix it on a provisional step does not reopen it.** Later steps may already build on it, so the step and its work
  stay and the fix becomes a new step: the orchestrator drafts it as a revision, which a running queue waits for at its
  running step's end (the approval wait it already had) and a finished queue gets approved and started.
- **"Built on it" is git ancestry.** With provisional work not counting, a push is held when the commit to push has the
  provisional step's review commit in its history (and that step made commits of its own), whatever queue it came
  from: the same rule covers a later step of the same queue and another queue in the same checkout.

## Away mode (queue RL3)

- **One global mode, kept with its history.** Away mode is the user's, for all projects, in one file the server writes
  (`<NEXUS_HOME>/away.yaml`). Its past periods stay on record because derivation needs them: a level-2 step accepted
  provisionally while the user was away must still read as accepted after the mode ends, so the rule is "the
  acceptance's time lies in an away period", not "away mode is on now".
- **It ends by itself, also across restarts.** A period past its `until` reads as off at once; a server timer, armed
  again at every start, records the end so the orchestrator is told.
- **Only the user switches it.** The dashboard does, and so does `nexus server away` from the user's own terminal; the
  CLI refuses it in any agent session, the orchestrator's included, and there is no event an agent could write. As
  with update and cancel, the server cannot tell the CLI from another local process; the CLI is the gate.
- **"Which queue can start" is the coordinator's answer.** When a queue waits for the user meanwhile, the orchestrator
  is told the approved queues that pass the same check a start would (one queue per checkout, the limit), so it never
  gets a queue in the checkout the waiting one still holds.
