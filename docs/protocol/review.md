# Review

Part of [the protocol](../PROTOCOL.md).

## Review

Every step is reviewed when it is done; there is no level without review, with one exception: the integration step
Nexus ran without a model, every check passed, at level 2 or 3, is accepted by Nexus itself (queue MI; "The integration
step", ["Without a model"](git.md#without-a-model)). A step's **review level** says who:

- `1`: the user reviews. The step is held in `review` for the user; the queue is `waiting`.
- `2`: the orchestrator reviews what can be checked; what is the user's (the look, the feel, what the project's rules
  give the user) goes to the user. The step is held in `review` for the project's orchestrator; the queue is
  `waiting`. The orchestrator accepts it (`review.accepted`), sends it back (`review.sent_back`) or hands it to the
  user (`review.asked_user`, with why).
- `3`: the orchestrator judges everything and the queue goes on. The step is held for the orchestrator as at level 2;
  it accepts what has nothing of the user's (`review.accepted`), accepts provisionally what has
  (`review.provisional`: the run goes on, see "Provisional acceptances"), or sends it back. Beyond the limit of
  send-backs the step goes to the user as at level 2, and its queue waits at that step. It may still hand the review
  to the user (`review.asked_user`) when it cannot decide.

With `review_helper.enabled` on (queue RH), a short-lived review helper takes the orchestrator's routine reviews at
levels 2 and 3 within these rules; see "The review helper".

**Provisional acceptances.** A `review.provisional` (only the orchestrator's, only of a step waiting for its review that
is at level 3, or at level 2 while away mode is on; any other is ignored with a warning) makes the step `done` with `provisional` (`at`, `event`, `text?`) on the
derived step, and the run goes on. Until the user deals with it, it is in the **return batch**: one item of kind
`provisional` in the attention list ("N provisional acceptances wait for your confirmation"), with `provisional`, the
steps oldest first (`queue`, `step`, `title`, `at`, `text?`, `summary?`); a finished queue's steps too. For each the
user either confirms it (`review.confirmed`, `POST …/steps/:s/confirm`; `provisional.confirmed`) or asks a fix
(`review.fix_asked`, **Fix it**: the same `POST …/steps/:s/send-back`; `provisional.fix` with `text` and `at`). Both
are the user's only: the orchestrator never confirms, and the CLI has no command for either. A Fix it does not reopen
the step: the step and its work stay, and the orchestrator is told (whatever `notify` says) to draft a revision with a
step that fixes it. A queue that went on waits for that revision's approval at its running step's end
(`approval_wait`, see ["A new revision of a running queue never stops the running step"](queues.md#queueyaml)); a finished queue gets a revision the user approves and starts.

**Away mode.** The user may mark that they are away until a time. It is global (all projects), the user's only, and
kept in `<NEXUS_HOME>/away.yaml` (written only by the server): `current` (`since`, `until`) while it is on, and `past`
periods (`since`, `until`, `ended`, `why`: `expired` or `off`). The user turns it on with `POST /api/server/away`
(`until`: a local time "8:00", the next such time, or an ISO 8601 time ahead; again with a new `until` moves its end)
or `nexus server away on --until 8:00`, and off with `{ until: null }` or `nexus server away off`; the CLI refuses
both from any agent session (`NEXUS_SESSION` set), the orchestrator's included, and there is no event for it.
`GET /api/server` and the derived state (`away`: `on`, `since?`, `until?`) say whether it is on now. It ends at
`until` by itself: the server keeps a timer (armed again at its start) that records the end (`expired`); a period
past its `until` reads as off at once.
- While it is on, a level-2 step is reviewed as level 3 (`levelNow` in `away.ts`): its review notice gives the level-3
  choices, and the orchestrator may accept it provisionally (`nexus review provisional`; the CLI checks the level as
  it is now). A `review.provisional` of a level-2 step is valid when its time lies in an away period, so it stays
  valid after the period ends. Level-1 steps are not touched. Without an orchestrator, or with its notices off, it
  changes nothing (those steps go to the user anyway).
- The orchestrator is told when it comes on or its end moves (key `notify:away:on:<since>:<until>`, "The user is
  away until HH:MM."), when it ends (`notify:away:end:<since>`, "Away mode ended at its time." or "The user turned
  away mode off."), and, while it is on, of each queue that waits for the user at a step (level 1, the send-back limit,
  or handed to the user; key `notify:awaywait:<queue>:<step>:<time>`): the queues next in the plan, which Nexus starts
  by itself, each with what it waits for (or that nothing else is in the plan), and the paused queues that could go on
  (`Engine.startable`). Meanwhile only the plan's next queues start: the orchestrator starts no queue outside the plan
  and puts no approved queue into it (see ["The plan"](planning.md#the-plan)).

A step in review has finished its turn: a pause asked for while it ran (the user's, or an update's drain) takes
effect then (`pausing` becomes `paused`), and the review goes on meanwhile. A worker's process that ends on its own
while its run's step is in review is no failed turn: the run waits for the review, then finishes if nothing is left,
or starts a process that resumes the session for the next step or a send-back.

Levels 2 and 3 go to the user instead when the project has no orchestrator (`project.yaml` has no `orchestrator`) or
its notices are off (`orchestrator.notify: false`); this is derived, so turning notices off hands every step waiting
for the orchestrator to the user.

**Where a step's level comes from** (`reviewLevelOf` in `state.ts`; the derived step has `level` and `level_from`):
the level the user set on it (queue's `user_levels`, `user`), else the one it was drafted with (`review.level`,
`step`), else its queue's (`review_level`, `queue`), else the project's effective `defaults.review_level` (its own
value, else the global one, built-in 2; `project`). The orchestrator writes each step's level into its draft: criteria
that can be checked (tests, measurements, numbers) give 2, a criterion that is the user's judgement (the look, the
feel) gives 1.

**The user's level** of a step (`PUT …/steps/:s/level`, `setStepLevel`) goes into the queue's `user_levels`, written
only by the server. It is not part of what an approval pins (the `hash` in `approvals`: steps, checks, stop conditions and the queue's other drafted parts, see `queue.yaml` in queues.md), so it asks for no new approval; a
later revision keeps it for the steps it keeps, and a draft cannot bring levels of the user's (its `user_levels` is
ignored). `null` clears it: the step's drafted level applies again. The queue's own `review_level` (`PATCH
…/queues/:q`) is not pinned either. Both change also after approval, until the step's review is over: a step that is
`done` (also accepted provisionally), `skipped`, `failed` or `rejected` keeps its level, and a request to change it is
refused (409). A step waiting for the orchestrator's review whose level a change of the user's makes 1 (its own, or
the queue's it takes) goes to the user: the server writes `review.asked_user` from the user's session ("The user set
the step's review level to 1: they review it themselves."), the step's `asked_user` gets `by: user`, and the
orchestrator is told once ("The user set the review level of step S of queue Q to 1 while it waited for your
review…"); the user's item shows the step's summary. A step the user's change sets to 3 keeps waiting for the
orchestrator: nothing is accepted by itself. The level a step's review goes by is read when the state is derived, so
the user's `review.asked_user` is what keeps such a review the user's should the level change again.

**Before review levels** there were review policies: `review_policy` on the queue, `review.policy` on a step and
`defaults.review_policy` in the settings, with `continue` (no review), `wait` and `orchestrator`. Every reader takes
them as levels (`withLevel` in `schemas.ts`): `continue` and `orchestrator` became 2, `wait` 1; a level beside one
wins. Files keep the old keys until their next write, which writes the level; drafts from an older briefing are read
the same way. An approval of the old form stays valid: when `queue.yaml` is read (`parseQueue` in `store.ts`), an
approval of the current revision whose hash is that of the same content in the old form (each step's review with its
`policy`) is taken as pinning the new form, and written so at the queue's next write.

**Steps done before review levels keep their meaning.** The server records once, at its first start with review
levels, when the project's steps began to be reviewed by level (`review_levels_since` in `project.yaml`;
`ProjectStore.markReviewLevels`). A `step.done` from before that time is derived by the old policy of its step: its
own, else its queue's, kept from the old fields as `legacy_policies` in `queue.yaml` when the file is first read in the
new form (and kept by later revisions for the steps they keep). `continue`: the step is done, with no review; `wait`:
it waits for the user; `orchestrator`: for the orchestrator (an acceptance it gave then stands). A step without an old
policy (its queue had none, or the file lost the old fields) reads `wait` from level 1, else `continue`, the old
built-in default. A `step.done` after that time, and every one in a project without the mark (a new one), goes by its
level. So queues finished before the change stay finished, and nothing about them is told.

The derived step has `review_with` (`orchestrator` or `user`) while in `review`, `asked_user` (`text`, `at`) after a
hand-over in the current round, and `sent_back` (each `id`, `text`, `at`, `by`, `round`, `delivered`, `to_user?`). Only a step waiting for the user is in the
user's attention list (kind `review`, with the orchestrator's reason as its text when it handed it over); the queue
shows `waiting` in both cases. An orchestrator's `review.accepted` or `review.asked_user` on a step that waits for the
user is ignored (with a warning); the user may accept either. Workers may write none of the three events.

## Sending a step back

One server action (`sendBack` in `packages/protocol/src/actions.ts`) sends a step in review back to its worker, with
who sends it (`orchestrator`, `helper` or `user`) and the text. The orchestrator's (and the review helper's) comes from `nexus review send-back` (its
`review.sent_back` event, which the server carries out and answers in `applied.jsonl`); the user's is **Fix it** in
the dashboard (`POST …/steps/:s/send-back`), for which the server writes `review.sent_back` as the user's session, the
text verbatim (it must not be empty). Picture comments (N8.3) are a user's Fix it.

- The orchestrator sends back only a step waiting for its review; Fix it is only for a step waiting for the user.
- The server **routes send-backs** like answers: each accepted one goes once into the inbox of the session that worked
  on the step, as `send_back` (`id` `send-back-<event id>`, `ref`, `queue`, `step`, `text`, `round`, `from`). That
  entry reopens the step: derivation sets it `running` again as round `round` (its `step.done`s so far plus one). The
  engine hands the entry to the same session as the next turn; on a paused or halted run it waits, and the resume
  opens the turn with it. The worker's prompt names the round, the text, the step's criteria, and, for a Fix it,
  that the user's words win over the acceptance criteria where they conflict. No new queue revision is made.
- The orchestrator's (and a review helper's, counted together) send-backs of a step beyond
  `defaults.review_send_back_limit` (default 2) are not delivered: the step goes to the user (`review_with: user`, `asked_user` saying so with the text), and the entry is `to_user`. The
  user's Fix it does not count toward the limit.
- After a Fix it the step's next round waits for the user, whatever the level (`user_fix` on the derived step).

## The review helper

**Status: in effect** (queue RH): which reviews, the helper's session, packet, settings, rights, verdicts, what happens
without one, the derived step and the review notice after a pass-on (RH2); what rides with the orchestrator's notices,
the audit and the statistics (RH3). **Not built yet**: the dashboard (RH4). The reasons are in DESIGN.md, ["Routine reviews by a helper"](../design/review.md#routine-reviews-by-a-helper-queue-rh). The marks **(H1)**…**(H17)** were
RH1's proposals beyond the user's decision of 2026-11-17; the user approved them all but **H12** (the first five
acceptances after a change of the helper's model or effort always audited), which is left out.

A short-lived session, role `helper` **(H1)**, reviews a step in the orchestrator's place: it accepts it, sends it back,
or passes it on to the orchestrator. Review levels, away mode and provisional acceptances keep their rules (above).

**Which reviews** **(H2)**. When a step enters `review` with `review_with: orchestrator` (level 2 or 3, the project has
an orchestrator, `orchestrator.notify` on) and `review_helper.enabled` is on, the server starts one helper for that
review round, instead of the orchestrator's review notice (`src/review-helper.ts`, run on every change before the
orchestrator's notices; while Nexus updates, after the restart). None for a step waiting for the user, nor for the
integration step accepted by Nexus (queue MI). Before starting one, the server passes the step on itself (a
`review.passed_on` from the `nexus` session) when **(H3)**: a worker asked a question at that step in the current round
(since the step's latest delivered send-back, else ever), reason `question`; or the step's send-backs that count
toward the limit (the orchestrator's and the helper's) already number `defaults.review_send_back_limit`, reason
`limit`. With the setting off, the orchestrator reviews as before.

**The helper's session.** `session.yaml` with `role: helper` and `about` (`queue`, `step`, `round`, `level`: the step's
own level, not the one away mode reads it at **(H6)**). The server writes two files into its session folder before it
starts, their only writer:

- `packet.md`, the helper's first and only prompt, as given: the step's id, title and level; its goal, acceptance and
  `review.prepare`; the checks of the round's latest set from `checks.yaml` (each name, `ok`, `flaky`, `duration`, the
  summary, the log's path; a check accepted as unrelated marked so); the round's review material (label, key, role,
  the copy's path under `.nexus/queues/<q>/review/<step>/`, the pair it belongs to); the worker's summary of the
  round; the step's earlier send-backs (round, `by`, text); the diff's `--stat` and the path of `diff.patch`.
- `diff.patch`: `git diff` from the step's first round's `start` (`git.yaml`) to the commit the round's `step.done`
  named (else the checkout's HEAD), with the latest round's own range named in the packet **(H4)**.

It runs in the queue's checkout (Claude Code) or in its session folder (Codex, see below), with no resume, no context
care and no chat: the packet is its one turn, and its process ends after that turn. Its briefing (Claude Code's
appended system prompt, Codex's instructions) says what it may do and how to decide: judge each criterion, send back
what fails, pass on with its reasons, accept only at level 2 with every criterion checkable and met, findings in the
project's working language.

**Settings** (global, with a project override; checked like a kind's runtime, model and effort) **(H13, H14)**:

```yaml
review_helper: { enabled: true, runtime: claude, model: claude-sonnet-5-5, effort: medium, audit_rate: 0.1 }
```

`runtime` is `claude` or `codex`; a model or effort left out (or the project's own `null`) is the project's for that
runtime (`runtimes.<runtime>.model`, `.effort`): switching the helper to Codex, clear its model or name a Codex one.
An effort the runtime does not take is refused where it is written (the settings actions, global and project); one
found anyway passes the step on (`unavailable`). `audit_rate` is a fraction from 0 to 1 (below). There is no fallback
chain: the orchestrator is the fallback (H8).

**Rights** **(H15)**. Claude Code: `--permission-mode dontAsk`, allowed `Read`, `Grep`, `Glob`, read-only git
(`git log`, `git status`, `git diff`, `git show`), `nexus status`, `nexus help`, `nexus doc`, `nexus review accept`, `nexus review
send-back` and `nexus review pass-on`, each on both shell tools (`Bash(nexus review accept:*)` and
`PowerShell(nexus review accept:*)`, and so on); not the project's `runtimes.claude.allowed_tools`; `Edit` and `Write`
never. Codex: its session folder as the working directory in a `workspace-write` sandbox whose only writable root it
is (for the CLI's events), approval `never`, without the user's own Codex tools; it reads the checkout by absolute path.
The CLI takes the three review commands from a helper session only for the step in its `about`, while the step's
`helper` is that session and `running`; it refuses a helper every command but `nexus status`, `nexus help`, `nexus doc` and those
three (`nexus review ask-user`, `provisional`, `add`, `nexus ask`, `nexus step …`: "a review helper only reads and
decides its review"). A refused action is
recorded in its `refusals.jsonl` like any session's; its briefing asks it to report the refusal in its verdict (pass on
with `doubt`, naming what it could not do), never to work around it. The dashboard lists a helper's refusals without
"Add rule".

**Verdicts** (events of the helper's session):

- `review.accepted` (`queue`, `step`, `text`: its findings): valid only from the helper started for that step's current
  round, on a step at its own level 2 that still waits for the orchestrator's review. At level 3 it is ignored with a
  warning **(H5)**. It accepts the step as the orchestrator's would (pushing included, see ["Pushing what was accepted"](git.md#pushing-what-was-accepted)).
- `review.sent_back` (`queue`, `step`, `text`): carried out by `sendBack` with `by: helper` and answered in the
  helper's `applied.jsonl` (the CLI waits for it, as for the orchestrator's); it counts toward `review_send_back_limit`
  together with the orchestrator's **(H7)**, so `sent_back[].by` and the worker's inbox entry's `from` may be `helper`.
- `review.passed_on` (`queue`, `step`, `round`, `reasons`, `text`: its findings, what it checked and what it could
  not): the step keeps waiting for the orchestrator's review, and the orchestrator gets the review notice now. Each
  reason one of `criterion` (a criterion the packet cannot settle), `deviation` (the summary reports a deviation from
  the plan), `question`, `limit`, `doubt`, `level` (level 3: the checkable criteria met, judgement is the
  orchestrator's) and, from the `nexus` session only, `no_verdict` and `unavailable` (from a helper they are dropped;
  none left reads as `doubt`). Valid only from the helper of the step's current round while it has the review, or
  from `nexus` for the current round of a step waiting for the orchestrator that was not passed on yet.

Any other event of a helper's session is ignored with a warning; `review.passed_on` from any session but a helper or
`nexus` likewise.

**No verdict** **(H8)**. A helper still without a verdict after `HELPER_LIMIT_MS` (20 minutes) is ended; Nexus writes
`review.passed_on` (`no_verdict`) from the `nexus` session, as it does when the process ends without a verdict. When
the helper's runtime is beyond `defaults.usage_pause_threshold`, its settings cannot run, its start fails or its turn
fails, the step is passed on (`unavailable`) without waiting. A helper running at a restart or an update's hand-over is started again once after
it (a new session, the packet written again); a second one without a verdict passes on. A verdict that comes after the
step stopped waiting for the orchestrator (the user set its level to 1, a pass-on by Nexus) is ignored with a warning,
and the engine ends a helper whose step left that wait.

**The derived step** **(H17)**: `accepted` (`by`: `user`, `orchestrator`, `helper` or `nexus`; `at`, `event`, and for
an agent `session`, `runtime`, `model`, `effort`) once its review is accepted (cleared when the step starts again);
`helper` for the current review round (`session`, `round`, `state`: `running` while a helper session of that round
exists without a verdict, `passed_on` after a pass-on, with `by` (`helper` or `nexus`), `reasons` and `findings`;
cleared by the next `step.done`). `nexus status` and the orchestrator's overview add to a step's line `(the review
helper reviews it)` and `(accepted by the review helper, Claude Code, claude-sonnet-5-5, medium)`; who else accepted a
step is in `accepted`, not in these lines, so what they show without helpers stays as it was.

**The orchestrator's notices.**

- The review notice ("Step S of queue X is done and waits for your review", key `notify:review:<queue>:<step>:<finished_at>`
  as before) comes when the step is passed on, or at once where no helper runs; after a pass-on its instruction starts
  with the reasons and the findings ("The review helper passed it to you: a criterion it cannot settle from what the
  step left behind. Its findings (…; no need to check that again): …", or "Nexus passed it to you without the review
  helper: …"). A step a helper has, or one it will take at the next change, gets no notice (built in RH2). A helper's
  acceptance gives the orchestrator no notice, no turn and no chat line.
- **Accepted since** **(H9, H10)**: the last notice of a batch that is told anyway (a review, a question, a halt, the
  run's end, an approval, …; not one told while notices are off) ends with the steps accepted since by anyone but the
  orchestrator itself, and the helper's send-backs since, oldest first, under "Since your last notice (for your
  overview; nothing to do):": "step W2 of queue W: accepted by the review helper (Claude Code, claude-sonnet-5-5,
  medium)", "…: accepted by Nexus, a clean merge without a model", "…: accepted by the user", "step W3 of queue W: sent
  back by the review helper, round 2: <first line>" (or ", which handed it to the user (the send-back limit)"). At the
  end, not the start as RH1 planned, so a notice still begins with its own fact. Only what happened since the first
  session of the orchestrator's line (context care) began; each listed once per line, key `notify:accepted:<event id>`
  (`notify:helpersentback:<event id>`), recorded when the notice carrying it is told. None of them starts a turn, and
  none is shown in the chat. A batch held while the orchestrator's runtime is full carries none (they ride later).
- **Audits** **(H11)**: a helper's acceptance (since the line's first session) is audited when `hash(event id)` (the
  first 8 hexadecimal digits of its SHA-256, read as a fraction of 2³²; `audited` in `src/review-helper.ts`) is below
  `review_helper.audit_rate` (H12, always auditing the first five acceptances after a change of the helper's model or
  effort, is left out by the user's decision). An audit rides after the list above (key `notify:audit:<event id>`):
  "Audit: review again step S of queue X, which the review helper accepted (its packet: <path>; …). Judge it as you
  would review it, then answer: nexus review audit X S agree|disagree --reason "why". …". The orchestrator answers with `nexus review audit <queue> <step> agree|disagree
  --reason <text>`, which writes `review.audited` (`queue`, `step`, `accepted`: the acceptance's event id, `verdict`,
  `text`); the CLI takes it only from an orchestrator, only for an audit it was given (its key in an orchestrator
  session's `applied.jsonl`), once per acceptance; the derived step keeps it as `audit` (`accepted`, `verdict`,
  `text`, `at`, `event`), and one for another acceptance, or a second one, is ignored with a warning. A disagreement does not reopen
  the step: the orchestrator drafts a fix as a revision when the work needs one, as after a provisional acceptance's
  Fix it.

**The CLI**: `nexus review pass-on` (review helpers only), `nexus review accept`/`send-back` from a helper, `nexus review
audit` (orchestrator only) and `nexus stats --reviews` are in ["The `nexus` CLI"](cli.md#the-nexus-cli).

**Records and statistics** **(H16)**. Each helper turn is a record in `turns.jsonl` with `role: helper`, its `queue`
and `step`. `nexus stats --reviews` (`reviewStats`, `packages/protocol/src/review-stats.ts`) (and `reviews` in `GET /api/stats`) reports, for the range and project, grouped by
who reviewed (the helper by model and effort, the orchestrator, the user): the user's signals (Fix it, Reject,
provisional acceptances returned); the cost signals (send-backs by who sent them, check-fix rounds, the helper's
reviews passed on by reason and as a share, marked when above 25%); the audit (acceptances audited, disagreements,
their share).

## Review pictures

The standard for review material is `nexus help review` (`packages/cli/src/help.ts`): formats, view keys, roles,
pairing, rounds, fixed-viewport captures, the process. It ships with Nexus, so every project has the current text
after a deploy; a project's own conventions stay in its AGENTS.md and its steps' `review.prepare`.

- **Where the files go.** `nexus review add` copies every file it is given (the picture and `--before` alike) into
  `.nexus/queues/<queue>/review/<step>/` and records the copy's absolute path; URLs are recorded as they are. The
  source may be anywhere outside the working tree (the worker's file tools may not write under `.nexus`; untracked
  files in a worktree block its cleanup); the help and the worker's briefing name the system's temporary folder
  (`<temp>/nexus-review/<step>/`), and `scripts/capture.ts` writes there by default
  (`<temp>/nexus-review/<queue>/<step>/`). The source is left as it is. A file already in the folder is recorded as
  it is; one of the same name and the same bytes is not copied again; one of a taken name with other bytes is copied as
  `<name>-2.<ext>`, `-3`, … (an earlier round's picture is never overwritten). Everything is checked before anything is
  copied: a refused command (a missing file, a folder, a wrong pair) leaves nothing behind.
- **View keys and roles.** `nexus review add <step> <picture> --key KEY --role ROLE` adds one picture (PNG, JPEG, GIF
  or WebP; kind image or sheet) with its view key and role. A key is the view's subject and state in lowercase words
  joined by hyphens (dots allowed), `@`, and the window's width in CSS pixels: `waiting-tab@492`
  (`VIEW_KEY` in `packages/protocol/src/pictures.ts`). The label is a caption only. Roles: `before` (the old state),
  `mockup` (the design), `after` (the new state), `variant-a` and `variant-b` (two alternatives), `result` (a new view
  with nothing to compare). The item records `key`, `role`, `size` (read from the file) and the round: `--round`, else
  the step's current one (the round its latest delivered send-back opened, else 1). `--key` and `--role` go together,
  with one picture, and not with `--before`.
- **Keyed pairs** (`counterpartOf`, the same rule for the check and the viewer), among the items added before it:
  an `after` pairs with the latest `before` or `mockup` of its key; without one, with the latest `after` or `result`
  of its key from the latest earlier round (`round N`; a new screen added as a result in round 1 and taken again as an
  after in round 2); a `variant-b` with the latest `variant-a` of its key. `before`, `mockup`, `variant-a` and
  `result` have no counterpart of their own.
- **Checked pairs.** `nexus review add` refuses a keyed picture (exit 2, nothing recorded) whose key is not a view
  key; an `after` or `variant-b` with no counterpart of its key (naming the step's same view at another width, "another
  key", or else what the step has); and a picture whose counterpart has other pixel dimensions. Every refusal says
  why and ends with `See: nexus help review`.
- **Pairs without a key** (older material): a picture is compared with the one its item names (`before`, from
  `nexus review add <step> <picture> --before <path>`, one picture at a time), else the latest earlier unkeyed
  picture with the same label from an earlier round (without round numbers: the latest earlier one with that label).
  Nothing checks them.
- **The viewer** shows a picture and its counterpart beside each other (stacked when the screen is upright) or
  overlaid with a slider; `pairPictures` (`apps/web/src/review.ts`) finds the other side and `comparisonOf` names the
  comparison, under the picture's title before its key and round ("before → after", "mockup → after", "variant A /
  variant B", "round 1 → round 2"; a keyed picture shown alone by its role, e.g. "result"), and the two sides
  (Before, Mockup, Variant A, Round N; After, Variant B, Round M). Unkeyed pairs keep Before and After.
- **How agents learn the standard.** The worker's briefing has its essentials (keys, roles, the same conditions, a
  refused pair) and the pointer to `nexus help review`; the orchestrator's briefing asks for review.prepare with keys
  and roles. The opening of a step with a `review.prepare` and every send-back repeat the pointer.
- **Marks.** The user may mark a picture accepted (`review.marked`, by its path), and take the mark back. It is a
  mark only: the step is not accepted by it. The derived step has `pictures.<path>` (`accepted`: when, while marked;
  `comments`).
- **Comments.** A comment on a picture goes, while the step waits for the user's review, back to the worker with a
  send-back (a user's Fix it, see "Sending a step back"); while the orchestrator holds the step in review, to the
  orchestrator, as a note for it on that step (`to: orchestrator`, see ["Notes"](files.md#notes-notesstep-idnote-idmd); `review.commented` `to: orchestrator`);
  otherwise it becomes a note from the user on the next pending step after it, delivered when that step starts. With
  none of these it is refused. The text sent says which picture
  (`About the picture "<label>" (<path>): …`); `review.commented` records the user's own words and where they went.
