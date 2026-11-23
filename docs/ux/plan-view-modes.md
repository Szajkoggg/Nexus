# The plan view's modes: PL's features fitted to the built view and its data

Queue PVA, step PVA1 (2026-11-23). Queue PL designed the plan view (docs/ux/plan-view-options.md, mockup
`mockups/23-plan-features.html`); queue PB built its first two parts, PVA0 and PVAR added to them. This document fits
PL's four missing features (critical path, what blocks, lanes by area, time axis) to the view as it is built and to the
data the dashboard has, and fixes the rules PVA2 to PVA4 build by. It changes no plan, no scheduler and no estimate.

- Mockup: `mockups/26-plan-modes.html?m=base|critical|blocked|lanes|time|unknown` (drawn by `mockups/plan-modes.js` over
  PL's `mockups/plan-mock.js`), at 1440, 492 and 390 px, with a fixed clock (Monday 23 November, 21:10).
- Data: Nexus's own plan as `scripts/capture/seed-plan-nexus.ts` seeds it. For these modes the seed now has what Nexus
  itself has: an orchestrator that takes the level-2 reviews (ST2, IO3 and DG2 wait for the user's review), area tags on
  the queues (NB has none, ST3 has a step in another area), and session ids so that MX's run resumes on a development
  instance.
- Compared: the base view with the switcher against today's view on the same seed (`plan-view-modes`, before and
  mockup); each mode against PL's design of it, taken from `23-plan-features.html` at the same window sizes
  (`plan-critical-path`, `plan-blocked-filter`, `plan-area-lanes`, `plan-time-axis`); the time axis without estimates
  (`plan-time-unknown`) is new.

## PL's promises, what PB built, what PVA adds

| PL promised (plan-view-options.md) | Built (PB, PVA0, PVAR) | PVA adds (step) |
|---|---|---|
| Layout A: columns, lines routed around the boxes, full titles | PB1: `drawPlan` in `apps/web/src/plan.ts`, 0 layout faults | Kept as the base view, "Columns" |
| A line's details: who set it, Remove, "Let the orchestrator decide" | PB3: the line panel; the phone's chip opens it | Kept in Columns and Lanes, under a mark too |
| "Also after…" by dragging, Undo | PB2, PB3: drop zones, the 10 s undo bar, the server's undo | Kept in Columns and Lanes; the time axis has no dragging |
| Finished queues folded at the page's end | Already so (PL2's decision: nothing to build) | Unchanged in every mode |
| The right rail stays on the Queues view | Stays | Stays |
| Critical path: the longest chain by the estimates, the rest dimmed | Not built | PVA2: as a mark, with the rules below |
| What blocks: what waits for the user, what it holds up, its action | Not built | PVA2: as a mark; the exact review, question or approval opens |
| Lanes by area: a band per area, columns kept, compact cards | Not built (today's `Lanes` component is the columns, not areas) | PVA3: as a view; the rules for many or no areas below |
| Time axis: a view of its own, start and end from the estimates, hatched after an approval | Not built; estimates on the cards only (PV4) | PVA4: as a view, by the estimate contract below; the view without estimates |
| On the phone: the tools as chips that wrap; the path marked on the list | List only | PVA2 to PVA4: every mode has its list form (below) |
| Not in PL | Started but resting queues stand after their predecessors (PVA0) | Every mode uses the same columns |
| Not in PL | The steps that will wait for the user's review, the first such point (PVAR) | Kept in every mode; the time axis marks the points |

## Decided before, not reopened here

- Layout A with our own code, no library (PL1, the user's choice; plan-view-options.md, "Recommendation").
- The rail stays; the plan is 788 px wide at 1440 (PL's open point, accepted with PB).
- Finished queues stay folded at the page's end, where they are today (PL2 review, rounds 2 and 3).
- Lanes use compact cards without chips; the time axis is a view of its own without lines (PL's points for the build,
  accepted with PB).
- The plan is binding, done predecessors are not drawn, a started queue that does not work stands after its
  predecessors (docs/design/planning.md, "The plan"; PVA0).
- Estimates are work time by model and effort, from every project's finished steps, none below five; a running step
  counts whole; the wait for a review is not in them (docs/design/planning.md; `packages/protocol/src/estimates.ts`).
- Where the plan will wait for the user's review: level 1 always, every level without an orchestrator, level 2 never a
  sure wait (PVAR; `userReviews`, `firstUserWait`).
- PB's protection of the user's dependencies (the orchestrator cannot drop them) and the undo rules hold in every mode.

## Decided now: the switcher and how the modes work together

These are this step's proposals. They go to the user's review with the pictures; anything changed there is what PVA2 to
PVA4 build.

- **Two groups, one row** under the plan's title: **View**: Columns | Lanes by area | Time axis (one of three, a
  segmented control); **Mark**: Critical path | What blocks · N (none or one). A view is a layout; a mark is a
  highlight on whichever view is shown. PL's single row of four toggles mixed the two, so "lanes with the critical path"
  had no clear meaning.
- **The base view** is Columns with no mark: today's view, unchanged. Back to it: click Columns, click the lit mark
  again or its ×, or press Escape (clears the mark).
- **Marks on every view.** On Columns and Lanes they mark the cards and lines (outlined, held, dimmed), and the boxes stay
  where they are, so nothing jumps. On the time axis they mark the rows the same way. Only one mark at a time: both dim
  the rest, and two dimmings would not say which is which.
- **Nothing is written.** Switching neither writes a plan nor starts or stops anything. The choice is the device's
  (browser storage per project), not a file under `.nexus/`: it is a way of looking, not project state. A reload keeps
  it; another project starts at its own last choice, else the base view.
- **The plan's actions stay.** In Columns and Lanes, under a mark too: the line panel, dragging, After…, Undo; the undo
  bar shows in every view. The time axis has no lines and no dragging; a row opens its queue, and After… stays on Columns.
- **Only what is built shows.** Until PVA3 and PVA4, Lanes by area and Time axis are absent (not disabled). A mark that
  cannot work now is shown disabled with the reason: Critical path without estimates ("Critical path · no estimates");
  What blocks with nothing waiting reads "What blocks · 0" and is disabled.
- **The hint line** says what the active mode shows (the chain and its length; how many wait for the user and how many
  more they hold up). PVAR's line "First wait for your review: …" stays above the plan in every mode.
- **Phone and narrow windows (below the dashboard's 768 px plan width: 492 and 390 px).** The switcher wraps into two
  lines (View, Mark). Columns: today's list. Critical path and What blocks: the same marks on the list, the buttons on
  the root cards. Lanes: a group per lane, headed "dashboard · 6", the cards in the plan's order, each naming its column
  (Now, Next, Then) and keeping its chips (the list has no lines). Time axis: the ruler on top, then per queue its title
  and its row on the same axis; the legend on a line of its own.

## Critical path

- **What it is.** The chain of queues, each waiting for the one before, whose work adds up to the most, by the
  estimates (`/estimates`, a queue's steps left). It answers "what has to happen, one after another, before the plan
  ends", not "when". The hint says so: "about 8 h of work by the dependencies (estimate); waits for you, the limit on
  queues at once and checkouts are not in it".
- **Over what.** The queues the plan shows and the lines between them (done predecessors are not drawn). Queues at work
  count from now with their estimate (a running step whole).
- **Separate from the run order.** The real order also depends on the user's reviews and approvals, the limit on queues
  running at once, checkouts, the usage window and the merge train. The path does not model these; the time axis shows
  the user's waits as conditions, and neither decides what runs.
- **A tie** (two chains with the same total, to the minute): the one whose last queue comes first in the plan's order
  (`planList`), then whose earlier queues do. One chain is marked; the hint adds "and 1 more as long".
- **A missing estimate.** No estimates at all (fewer than five finished steps on the server): the mark is disabled. A
  single queue without one (possible in the type, not with today's fallback): chains through it are not compared, and
  the hint names it ("RA has no estimate; chains through it are not counted"). A missing estimate is never 0 h.
- **A loop** in the plan (refused when written, possible in damaged files): its queues take no part; the computation
  never follows a line twice.

## What blocks

- **The roots: what waits for the user now**, each with the button that opens the exact item through the dashboard's
  addresses (`apps/web/src/hash.ts`):

| Root | Button | Opens |
|---|---|---|
| A step waiting for the user's review (not the orchestrator's) | Open ST21's review | the step: `#/<project>/<queue>/<step>` |
| An open question, a permission or a check decision for the user | Open the question | the question: `#/<project>/<queue>/<step>/<qid>` (or its step) |
| A queue that needs approval | Open the approval | the queue, where Approve is: `#/<project>/<queue>` |
| A failed start | Open the queue | the queue |
| A stopped queue (only the user lifts a stop) | Open the stop | the queue, with its stop bar |
| A paused queue (paused by the user, or since a restart and not resumed) | Open the queue | the queue, with Resume |
| A planned queue whose predecessor is cancelled or missing | Open the queue | the queue; its line panel can take the dependency away |

- **Not roots**: what Nexus waits for by itself, which ends without the user: the usage window, a schedule's time, a
  checkout, the limit on queues at once, the merge train, a review the orchestrator has. The hint names those that hold
  something ("PL waits for the usage window by itself (22:10)"); they are dimmed like the rest.
- **What they hold up**: every shown queue reachable from a root along the plan's open lines. Its card says "Held up by
  ST2 (your review)" (by each root it depends on) and stays lit; a root held by another root is both. The count in the
  hint and on the chip: roots; "hold up N more": the held queues that are not roots.
- **The rest is dimmed**, including queues at work. Nothing moves.

## Lanes by area

- **A queue's lane** is its own `area` tag (the queue's, which its steps inherit). Without one, the area most of its steps
  left carry (a tie: the first such step's); with none at all, "No area". A queue is in exactly one lane.
- **Steps in other areas**: the card says so ("also engine: ST31"), so a queue spanning two areas is found in one lane
  and named in the other's terms, not drawn twice.
- **The lanes' order**: the project's area list (`.nexus/tags.yaml`, the user's order), then areas not in it by name,
  "No area" last. An order by the plan would move the lanes whenever a queue starts. Empty lanes are not drawn.
- **Inside a lane** the columns stay the plan's, and a column's queues keep the plan's order; lines between lanes run in
  the gaps, through the slots kept for lines that skip a column, as in Columns.
- **Compact cards** (desktop): the full title, the state, the review points, the estimate and After… stay; the chips go
  (the lines and the line panel say the same). A renamed area (tags.yaml renames) shows under its new name.

## The time axis: the estimate contract

A row per queue, in the plan's order; a bar from its expected start to its expected end, proportional to time; no lines
(the starts show the order). Times are estimates of work, placed by the dependencies. Everything the view does not
know is shown as not known, never as a sure time.

| Case | What the axis does | Why |
|---|---|---|
| Several predecessors | Starts when the latest of them is expected to end | The plan fires when every predecessor is done |
| A schedule (`start.at`) | Starts at its time, or after its predecessors if they end later | A schedule says when; it does not wait for a busy session |
| The usage window (a run waiting with `resume_at`, a start at the reset) | A dotted lead up to the reset, then the bar | The reset is a known time; Nexus waits by itself |
| Running, a step in progress | From now, the queue's whole estimate; the note says "counted whole" | The estimate does not guess progress |
| Waiting for the user's review now | Hatched from now: "if you review ST21 now" | The user's wait is not measured; a time after it would be a guess |
| A later step that surely waits for the user's review (PVAR's rule) | A diamond where its queue's estimate puts it (steps shared evenly), hatched after it | Same as PVAR's `firstUserWait`; the first one is the same point as the line above the plan |
| Needs approval | Hatched from now: "if you approve revision 2 now" | PL's "if approved now" |
| Follows a hatched queue | Hatched, its note naming the condition ("after RX, if ST2 is reviewed by then") | A condition carries to every follower |
| A stopped, cancelled or missing predecessor | No bar; the note says "waits for you: RX stopped"; followers have no bar either | Only the user can change it; any time would be invented |
| Held for its checkout, or at the limit on queues at once, now | Hatched from its earliest start, the note names the wait | Nexus waits by itself, for an unknown time |
| The limit and checkouts later on | Not modelled: the axis assumes the dependencies alone; the hint says so | Modelling them would be a second scheduler |
| The merge train (waiting to integrate after W) | Its remaining work after W's expected end, as one more predecessor | `train.after` is data the view has; nothing new is decided |
| Quota running out later | Not predicted | There is no data for it |
| A queue without an estimate | No bar: "after RX; no estimate"; followers placed "not before" what is known, or named only | A missing estimate is not 0 h |
| No estimates at all (fewer than five finished steps) | The axis keeps the clock and places only the set times (schedules, the usage window); the rest is named in its order, with a notice | `plan-time-unknown` |
| The estimates fail to load | The notice says they could not be loaded (and Retry); rows as without estimates | An error must not look like an empty plan |
| The plan or a queue changes | The estimates are fetched again with the files; old ones are not kept | `PlanView` keys the query on the files' changes today |
| Midnight | The ruler names the new day at its line ("Tue 00:00") | Night plans cross it |
| A loop | Its queues have no bar | As the critical path |

The ruler starts at now and ends a little after the plan's last expected end; a plan of more than a day scrolls sideways
on the desktop (detail for PVA4). The legend says: diamond, waits for your review; hatched, after a wait of unknown
length; dotted, waits by itself.

**The sign for an unknown wait** is the hatching, always with words beside it: the row's note names the condition, and a
bar that starts after one has no solid part before its own known start. Nothing hatched is ever shown as a clock time
without "if" or "not before".

## Edge cases across the modes

| Case | Critical path | What blocks | Lanes | Time axis |
|---|---|---|---|---|
| Empty plan (nothing planned) | The plan view is not shown (today's rule), so neither is the switcher | same | same | same |
| One queue only | Its own path | As any | One lane | One row |
| Two queues with two predecessors each, crossing | Longest by the sum | Each held by every root above it | Both in their lanes, lines between lanes | Latest predecessor's end |
| A predecessor done | Not drawn, not counted | Not a root | Not drawn | Not counted |
| A predecessor stopped | Counted with its estimate (work still to do) | It is a root, "Open the stop" | In its lane, resting state on the card | No bar for it or its followers |
| A predecessor cancelled or missing | The follower's chain starts at it | The follower is the root | The follower in its lane | No bar |
| A started queue resting (paused, held) | Counted from its column (PVA0) | Paused: a root; held: not | As in Columns | Held: hatched; paused: no bar until resumed |
| Away mode | Unchanged | Unchanged | Unchanged | Level 2 runs as 3: no review points from it (PVAR) |
| No orchestrator | Unchanged | Every review is the user's | Unchanged | Every step is a review point |
| Long title, narrow window | Full titles wrap (PB) | Buttons wrap inside the card | Full titles, compact cards | Labels wrap above the row on the phone |

## Open details for the user's review

Each has this step's recommendation, drawn in the mockups; the review decides.

1. Two groups (View, Mark) instead of PL's four equal toggles. Recommended: yes (see above).
2. The mode is remembered per device and project, not in the project's files. Recommended: yes.
3. A paused queue is a root of What blocks. Recommended: yes, since nothing resumes it by itself after a restart; the
   alternative is to treat it as "by itself" like the usage window.
4. Lanes' order by the project's area list, "No area" last, and a queue's own area deciding its lane. Recommended: yes.
5. On the phone, the lanes' cards keep their chips (there are no lines there), unlike PL's compact cards.
6. The time axis hatches everything after a wait for the user (approval, review), not only the approval as PL drew it.
   With Nexus's own plan this hatches most rows after 23:00: that is what the data says.
7. The critical path is disabled, not guessed, without estimates.

## As built in PVA2

Two points differ from the mockup, both to keep its own rules:

- The View group is not shown yet: with Columns the only view, it would be a choice of one. It joins the row with
  PVA3's lanes.
- What blocks' buttons and "holds up …" stand in a list under the Mark row, not on the cards, and a held card says
  "held by ST2" on its top line: words added inside the cards would make them taller and move the boxes below, which
  "nothing moves" rules out.

## What each step builds

| Step | Builds | Fills |
|---|---|---|
| PVA2 | The switcher (with only Columns as a view), Critical path and What blocks as marks, pure functions with tests (weights, ties, missing estimates, roots and followers), the exact item opened | PL's critical path and what blocks; the phone's marks |
| PVA3 | Lanes by area: grouping, order, compact cards, lines between lanes, the phone's groups | PL's lanes; many areas and none |
| PVA4 | The time axis by the contract above, with a fixed clock in tests; the view without estimates; the check of every mode | PL's time axis; the estimate's uncertainty shown |

## The pictures and their measure

Taken with `scripts/layout-faults.ts` (which also measures) on the mockup, and with `scripts/capture.ts` on a
development instance for today's view. Every mockup picture: 0 lines through boxes, 0 overlapping boxes, 0 texts cut
short, at 1440 × 900, 492 × 844 and 390 × 844 (390 in a frame, as the capture tool does).

| Key | Compared |
|---|---|
| `plan-view-modes@1440`, `@492`, `@390` | Today's view on the seed (before) with the base view and its switcher (mockup) |
| `plan-critical-path@…` | PL's design (before) with the critical path as a mark (mockup) |
| `plan-blocked-filter@…` | PL's design with What blocks: roots, buttons, "held up by" |
| `plan-area-lanes@…` | PL's design with the lanes, "No area" and a step in another area |
| `plan-time-axis@…` | PL's design with the axis by the contract |
| `plan-time-unknown@…` | New: the axis without estimates |

PL's designs at 492 and 390 px are its mockup at those widths: PL drew the phone only for the critical path, so the
others show its list with that feature's marks.
