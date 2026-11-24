# The plan and approvals

Part of [the design](../DESIGN.md).

See also: [Approving: the whole queue in one scroll](dashboard.md#approving-the-whole-queue-in-one-scroll).
See also: [The plan view's layout A](dashboard.md#the-plan-views-layout-a-queue-pb).

## The plan

"When queues A and C are done, start B" is a place in the plan kept in a file of B's (`plan.yaml`, with the start's
options in `start.yaml`), not a timer or a process: the engine looks at the plans after every change and when it
starts, so a plan survives restarts and updates, and nothing fires while an update drains. The user decided
(2026-11-14) that the plan is binding: Nexus starts by itself only a queue in the plan, and the plan generalizes the
chains of one predecessor to several. Decisions:

- It fires only when every predecessor is done. A halt, pause or stop of one is something to look at, not a reason to
  start B on work that may depend on it; the plan waits and says what it waits for. A stopped, cancelled or missing
  predecessor is told to the user and the orchestrator, since only they can change it.
- B's approval is checked when the plan comes due, not when it is made, and an unapproved B waits for it rather than
  failing (it used to fail): the plan shows what will happen, and "needs approval" is part of it. "Approved" means
  the revision current at that moment is approved. When B cannot start for another reason (stopped), the plan stays
  as an item for the user instead of vanishing or retrying by itself.
- The plan stays after B starts (marked used), so the view can show what came after what; a used plan waits for
  nothing and takes no part in the loop check.
- Each dependency records who set it. The user's are the user's: the orchestrator's requests that would drop one are
  refused with the way to propose it instead, so the rule holds in the files, not only in the briefing. A proposal is
  one whole list, as the orchestrator would set it; the user's answer is one action, and a hand-back makes the
  dependency the orchestrator's, as if it had set it.
- While the user is away, the orchestrator starts nothing outside the plan; the server refuses it, as it refuses the
  orchestrator's changes to the user's dependencies.
- A plan to continue a session waits while that session runs another queue, rather than failing: one session never
  runs two queues, and planning a queue into the session of the queue before it is the common case.
- The user's single-dependency changes (queue PB, 2026-11-16): "also after" adds one predecessor, a line's details
  take one away, and a move, an add or a remove can be undone for a few seconds. Taking a predecessor away, whoever
  set it, is the user's decision, recorded and told to the orchestrator; it may propose putting it back but not do it
  (refused in the files, as with the user's own dependencies). What an undo needs is kept in the plan files the
  change wrote (`undo`: the file before), not in the server's memory, so a restart within the window neither loses
  the undo nor lets a queue the change freed start early. A later write shows by `updated_at` (every write sets it),
  so an undo never overwrites a change made since; a start is checked apart (marking `started_at` keeps the rest).
  The server takes an undo 2 s longer than the dashboard offers it, for the request's way.

A schedule ("at 22:00", "when the usage window resets") is the same kind of plan with a time instead of a queue.
Decisions:

- A schedule does not wait for a busy session: at its time the queue starts, or the plan fails and the user is told.
  A schedule says when, and starting hours later than asked (after a busy session freed) would be a different plan
  than the one made. It does wait for its checkout and for a place under the limit on queues running at once (next
  section): that wait is Nexus keeping its own rule, not a plan gone wrong, so it is never marked missed.
- A schedule more than 15 minutes late, because the server was not running, does not start. Work set for the night
  must not begin by surprise in the morning; the user and the orchestrator are told, and decide.
- The usage reset is fixed when the plan is made, from the usage data then known, and shown as a time. A plan that
  moved with later data would be harder to read and to trust; making it again takes the new reset.
- Long timers are armed in pieces of at most a day: Node fires a timer longer than 2^31-1 ms (about 24.8 days) at once,
  which a weekly usage window can exceed. Tests drive these timers with a clock of their own.

The code is `packages/protocol/src/plan.ts` (the rules and the views: who may change what, the loop check, proposals
and the user's answers) and `apps/server/src/scheduler.ts`: `Scheduler` keeps the plans (plan, schedule, cancel; `duePlans` and
`startDue`, which the coordinator's pass calls to start what came due) and asks the engine to start a queue; `ClockTimers` arms the long timers on the engine's
clock, for the schedules and for the engine's own retry and usage waits. The engine owns the runs and keeps the public
`plan`, `scheduleStart` and `cancelStart`, which hand over to the scheduler.

The Queues view shows the plan above the queue lists (`apps/web/src/plan.ts`, `components/Plan.tsx`). Decisions:

- Columns, not a timeline: what works now or waits for the user (running, its checks running, waiting for a review or
  an answer) is the first column, and every planned queue stands one column right of the latest queue it waits for
  that is still shown. Done predecessors are not drawn (the card still names them, "done"), so the picture is what is
  left to happen. Times would come only from estimates (PV4); the order is certain, the times are not.
- A queue that has run but does not work now (paused, stopped, held at the limit) stands where its predecessors put it,
  as one that never ran does, with its state on the card ("paused · PA2", "stopped at SB1"); with no predecessor shown
  it stays in the first column, after those at work. The user's report (2026-11-18, queue PVA): queues paused since a
  restart or stopped, though planned after others, all stood first, so the first column no longer said what runs.
- A queue that a planned queue waits for is shown even when it is not in the plan itself ("not in the plan"): it is
  what holds the plan. Approved queues outside the plan are one line under it, since they wait for someone to plan them.
- Where the plan will wait for the user (the user's request, 2026-11-18, queue PVA): a card names its steps left that
  surely wait for the user's review (level 1; every level when no orchestrator takes reviews; a level-2 step may be
  handed to the user but is no sure wait, and in away mode it runs as 3) and the next of them; a line above the plan
  names the first such point and its time from the estimates (a queue's estimate shared evenly over its steps left,
  after its predecessors' ends). Of the queues' next points the earliest by time wins when every one has a time,
  else the first in the plan's order, so a missing estimate does not reorder by guesswork (`firstUserWait`).
- Marks (queue PVA, docs/ux/plan-view-modes.md): Critical path and What blocks light part of the plan and dim the
  rest, one at a time, and write nothing (the browser keeps the choice per project: a way of looking, not project
  state). They change frames, dimming and a word on a card's top line, never a card's size, so the boxes stay where
  they are. What blocks lists nothing of its own: "Waiting for you" in the rail already lists what waits (the user, PVA2
  round 2: no duplicate); a root's title opens exactly its review or question. The
  critical path is the longest chain of work by the estimates along the lines (`criticalPath`): not the run order; a
  missing estimate is no time known, so a chain through it is not compared rather than counted as 0 h; a tie goes to
  the chain first in the plan's order; a loop is cut where it closes. What blocks (`whatBlocks`) takes as roots only
  what waits for the user now; what ends by itself (usage window, time, checkout, limit, merge train, the
  orchestrator's review) is named apart, not a root.
- Views (queue PVA, PVA3): Columns and Lanes by area, one at a time, kept like the mark (the device's, per project);
  the time axis came with PVA4. The View group came with the lanes: one choice is no choice. A lane is a band across
  the same columns (`areaLanes`, `drawPlan` with bands): a queue's own area, else the area most of its steps left
  carry (a tie: the first step's), else "No area"; renamed areas read as their new name. The bands follow the
  project's area list, then other areas by name, "No area" last, so starting a queue never moves a band; an empty one
  is not drawn. Each queue is in one band, its steps in other areas named on the card, not drawn twice. Within a band
  a column keeps the plan's order; a line that skips a column passes it in a gap in its target's band, and a line
  between bands changes height only between the columns, so no line crosses a card or a band's name (written upwards
  in a gutter left of the first column). On a desktop the cards drop their chips (the lines and the line panel say
  the same); on the phone, where there are no lines, each band is a group whose cards name their column and keep them.
- The time axis (queue PVA, PVA4; `apps/web/src/planTime.ts`): a row per queue, a bar from its expected start (the
  latest predecessor's expected end, a schedule, the usage window's reset, now for a run at work) for its estimate.
  It is a reading of the estimates, not a scheduler: the limit, checkouts later on and the usage window running out
  are not modelled. What the user must do first (a review, an answer, an approval) and a wait of unknown length (a
  checkout, the limit) hatch the rest of the bar and every follower's, which name the condition ("if ST2 is reviewed
  by then"); a stop, a pause, a failed start or a predecessor gone gives no bar to it and its followers; a missing
  estimate is never 0 h, so what follows it has no end, only "not before". Only a fresh answer of `/estimates` is
  used: a failed fetch shows a notice and the set times, never the last answer or an empty plan.
- A line goes from a queue to the one that waits for it, solid in the accent colour where the user set the
  dependency, dashed where the orchestrator did; the card says "after A · set by you" too, so the phone's list (no
  lines) keeps who set what.
- On each planned queue what it waits for, what only the user can do first: a failed start, its approval, a
  predecessor stopped or gone; then its time, the usage window, its checkout or the limit. Running ones show their
  honest status (queueStatus), which already says review, usage window or stop.
- Reordering is a list's, as the user decided: moving B after Y takes B out of where it was (those after it close up
  to B's old predecessors) and puts it after Y. The rule lives in the protocol (`reorderedFollowers`) and the server
  applies it, so the dashboard's "After…" and dragging only name the move. Dropping onto a queue means "after it";
  dropping onto "Next" means first. Every entry a move writes is the user's, since the user made it.
- Proposals and hand-backs act where the dependency shows (the card) and where the user looks for decisions (the
  waiting list), with the same two buttons.
- Expected times are estimates, and say so ("about 2 h (estimate)"; "no estimate" below five finished steps): a step's
  time is its worker turns' time, so the wait for a review (the user's, often hours) does not make the next queue look
  slow; the average is by model and effort, falling back to the model, then to all, rather than a precise-looking
  number from one or two steps. The samples come from every project on the server: the same models behave alike
  across projects, and one project alone rarely has enough. A step already running counts whole: the view does not
  pretend to know how far it got.

## Approvals

Approving is a dashboard action: the user picks a queue revision, writes their words (optional, kept verbatim), and
Nexus records `{revision hash, time, words}`. The worker sees the approval in its step turns. This replaces quoting
the user into a Markdown queue, though a project may still copy it there.

**Statuses change through Nexus, never by editing files** (decided 2026-11-13, after Project Honeycomb's queue W: a
stopped queue's new revision was approved, `start` said ok and halted with the old stop note, and a worker then edited
the queue file by hand). Every change is an entry in the queue's `changes`, written by the server, with who, when
and why; derivation applies the entries in time order among the events, so neither a later rebuild nor an older event
undoes them. Only the user lifts a stop: stop conditions are the user's guard rails. Approving a new revision of a
stopped queue lifts it (the old stop's reason goes into the entry, the old run record is archived, a start begins at
the first pending step); `start` and `resume` refuse a stopped queue with the step and the reason. (`resume` used to
refuse a run of an older revision, which could reopen a step the new revision had replaced; since a revision changes
only steps that have not started, decided 2026-11-14, a run goes on across revisions: see "A new revision of a running
queue never stops the running step" in PROTOCOL.md.) Every write to the
API is the user's and is taken only from the dashboard's page (the Origin rule), approving among them; agents act
through the CLI and its events.

Housekeeping is the orchestrator's, with `nexus queue set` (event `status.set`, applied by the server as an entry
`by: orchestrator`): skip a step a revision replaced or that was done elsewhere (a stopped or failed one too), close
a halted run of a queue whose steps are all done or skipped, cancel a queue that is not running (the user gets a
push notification, nothing waits in their list), and propose that the user lift a stop. Consent stays the user's:
marking work done (the orchestrator skips with the reason saying where), approving, lifting a stop, reopening a
finished step. A draft cannot change a step's status or drop a step that has started or stopped, so a new revision
of a stopped queue keeps the replaced step and the orchestrator skips it: the record shows what became of it.

**Standing approvals of recurring queues** (queue TQ, decided 2026-11-14): the user approves a recurring queue once,
and its runs start by themselves while it stays as approved. "As approved" is one hash over what a run would be: the
template as resolved through the three layers and filled with the values (so a project template that replaces a
shipped one, an edited global one, or a deploy that changes the shipped one all count), the values, the schedule and
`coding`, hashed as JSON with sorted keys so the order things are written in does not count. The server checks it at
each time, just before it makes the queue from the same resolved template, so no run can start with content other
than what was approved: if the hash differs the time passes without a run and the user is asked again. Any
`nexus recurring set` by the orchestrator takes the approval away, even one that changes nothing, so that the
orchestrator cannot keep an approval alive across its own edits; only the user's action approves. Each queue it makes
carries a normal approval of its own revision hash, marked `standing` with the recurring and the approval it came
from, so the queue's record shows where its consent came from.

**Counting "after N queues" again after a pause or a skip** (the user's decision of 2026-11-23, queue CK, on the LY
survey's question 5). The count of a recurring that has run goes on from its last run through a set and an approval,
so the queues done since its run are not thrown away. That rule surprised once the recurring had stood still: one
paused for a week, or one whose N-th queue came without its approval, brought back every queue done meanwhile and ran
at once on being let go on or approved. Now the moment the user brings it back is where the count starts: letting a
paused one go on, and a set or an approval of one that is paused or has `skipped` set. One that never stood still keeps
the old rule. While paused, its count already began anew at each N-th queue, so this mainly concerns the approval
after a skip and the queues done between the last N-th and the resume.

## A closing refactoring step kept by Nexus

Decided by the user on 2026-11-14 (docs/ideas/refactor-step.md, queue RF); the protocol is in PROTOCOL.md, "The
closing refactoring step". Every queue that contains coding (`coding: true`, set by the orchestrator) ends with a step
Nexus keeps outside the queue's list of steps.

- **Derived, not stored.** The step is added by derivation after the queue's own steps (`stepDefs`), so everything
  that already walks a queue's steps (the engine's next pending step, "done", the report of the last step, the
  orchestrator's "last step", `queue set finished`) treats it as the last without a rule of its own. A revision cannot
  put anything after it, since it is not in the file a draft writes.
- **Running again** is derived too: a step of the queue's own that starts after it ran sets it back to pending. The
  rule looks at work, not at revisions: a revision that only rewords or skips adds nothing to refactor.
- **Fresh eyes through the existing switch.** Context care's switch to a fresh session is reused with a reason of its
  own (`refactor`); the seed gives no context summary, the step reads the queue's work itself from the commit range
  that `git.yaml` already records (first start to last end of the queue's own rounds) and git's `--stat`, so a large
  diff never fills the prompt.
- **A project's rules** are a "Refactoring" heading in its AGENTS.md; the opening says whether there is one, so the
  worker is told to follow it only where it exists, and no project has to change for the step to work.
- **Skipping is the user's, at Continue.** A stopped queue may close without the step: Continue carries the user's
  choice (a checkbox in the queue's bar, while the step has not run), recorded as a `status` change by
  `user_continue` with the stop's reason, so the record says who skipped it and why. Agents never skip it. A skipped
  closing step stays skipped when the stopped step goes on: the skip was chosen for that close. A rejected queue goes
  on by an approved revision, not Continue; it gets the closing step at its end, and the skip is not offered there.
