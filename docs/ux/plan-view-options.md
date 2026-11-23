# The plan view: two layouts, the features, and what to build with

Queue PL (2026-11-15) designs the Queues view's plan before the build, as the user decided
(docs/ideas/queue-plan-view.md, "Decided 2026-11-15"). Every mockup draws Nexus's own plan: 15 queues, 3 of them
finished, 3 running now and 9 planned, several with two predecessors and lines that skip one or two columns. The
seed `scripts/capture/seed-plan-nexus.ts` writes the same plan for the dashboard.

- Layouts (PL1): `mockups/22-plan-layout.html?v=a` and `?v=b`.
- Features on A (PL2): `mockups/23-plan-features.html?f=critical|blocked|line|drag|undo|lanes|time|folded`, and
  `?f=phone` at 390 px.
- Both take `?theme=paper|honey`. They are drawn by `mockups/plan-mock.js` and `mockups/plan-features.js` and
  measured by `scripts/layout-faults.ts` (see docs/design/dashboard.md, "Layout faults").

**The user's choice (PL1 review, 2026-11-15): layout A**, at 1440 px and at 390 px.

PB built layout A, a line's details, dragging and Undo. The four features it left (critical path, what blocks, lanes by
area, time axis) are fitted to the built view and its data in [plan-view-modes.md](plan-view-modes.md) (queue PVA),
with the mockup `mockups/26-plan-modes.html`.

## The two layouts

| | A: today's columns, lines routed around | B: layered graph (dagre-like) |
|---|---|---|
| What it is | Now, Next, Then columns with the queues stacked from the top in today's order. A line that skips a column passes through a gap kept free for it. Between the columns the lines run at right angles, each on its own track. | Columns are ranks. A long line gets a placeholder in each rank it crosses. The order within a rank cuts crossings, and each queue sits at the height of its neighbours. Lines are curves. |
| Strengths | Reads like today's view: order and places stay put, so the user finds a queue where it was. Compact at the top. Lanes and a fixed order are easy (it is our own grid). Right-angle tracks never overlap. | Fewer crossings and straighter lines on larger plans. Related queues sit side by side. On the phone it shows the lines too (a gutter beside the list). |
| Weaknesses | Crossings are not minimised (3 on the test plan, B 2). A plan with many long lines needs many gaps, and the columns grow taller. | Queues move when the plan changes (a new dependency reorders a rank), so the user loses their place. Uses more height (755 px against 700 px on the test plan). The phone gutter is busy (20 crossings). Lanes would fight the ordering. |
| Measured (lines through boxes / overlaps / cut text) | 0 / 0 / 0 at 1440 and 390 | 0 / 0 / 0 at 1440 and 390 |
| Today's view, for comparison | 6 lines through boxes, 15 texts cut short at 1440 px; 9 cut short at 390 px | |

## What to build with

| | dagre (`@dagrejs/dagre` 3.1.3) | ELK (`elkjs` 0.12.1) | Our own (as in the mockups) |
|---|---|---|---|
| Licence | MIT | EPL-2.0 or GPL-3.0-or-later | ours |
| Size in the dashboard | `dagre.min.js` 49 KB, 17 KB gzipped (graphlib included) | `elk.bundled.js` 1.6 MB, 477 KB gzipped (a GWT build; best in a web worker) | about 80 lines for A's layout and routing (`layoutA`, `orthogonal` and the tracks in `desktop()`); about 70 more for B (`layoutB`) |
| What it does | Layered layout: ranks, placeholders, crossing reduction, coordinates, and edge points through the placeholders | Layered layout with orthogonal edge routing, a fixed order (`considerModelOrder`) and lanes (`partitioning`); many options | Exactly what A needs: fixed columns and order, gaps for skipping lines, tracks between the columns |
| Fit for A | Poor: it decides the order and the heights itself, which A keeps | Possible with constraints, but heavy: 477 KB gzipped is about twice the whole dashboard's main bundle today (802 KB, 236 KB gzipped) | Good |
| Fit for B | Good | Good | Workable (the mockup's version), less tested than dagre |

Sizes come from the npm packages of 2026-11-15, measured on their minified files (gzip -9). The dashboard's bundle
is the PL1 build of `apps/web`.

## The features, on A

Each has a mockup (key in brackets) and was measured at 0 faults.

- **Critical path** (`plan-critical-path@1440`): the longest chain by the estimates, from now to the end of the
  plan: MX → RX → ST3 → DG, about 8 h. Its queues and lines are drawn in the warning colour; the rest is dimmed. The
  hint line says the chain and its length.
- **What blocks** (`plan-blocked-filter@1440`): the queues that wait for the user (ST2's review, CH's approval) are
  framed in their colour. Each says what it holds up and has its action button. What they hold up stays visible, and
  the rest is dimmed. The layout does not change, so nothing jumps.
- **A line's details** (`plan-line-details@1440`): a click on a line marks it and opens a panel. The panel says who
  set the dependency and when, and has Remove and "Let the orchestrator decide" there. That makes the chips' ↩
  unnecessary; the chips can stay for now.
- **"Also after…" by dragging** (`plan-also-after-drag@1440`): dragging a queue onto another splits the target in
  two: "After ST2 instead of RX" (today's move) and "Also after ST2 (and RX)" (a further predecessor).
- **Undo** (`plan-undo@1440`): after the drop the new line is lit, and a bar under the plan says what changed. It
  offers Undo for a few seconds, with a countdown.
- **Lanes by area** (`plan-area-lanes@1440`): a band per area tag with the label at the left; the columns stay. Lines
  run between the bands through the gaps. To fit three lanes in the window, the cards drop their "after" chips: the
  lines and a click on one say the same.
- **Time axis** (`plan-time-axis@1440`): a view of its own, because A's columns are not proportional to time. A row
  per queue with its expected start and end from the statistics. A queue starts when the last of its predecessors
  ends, and NB starts at 22:00. CH waits for approval, so it and what follows it are hatched ("if approved now").
  This view has no lines: the starts show the order.
- **Finished queues folded** (`plan-finished-folded@1440`, the page scrolled to its end): the finished queues stay
  where they are today, folded into "Finished (3)" at the bottom of the page, under what is in progress. The plan
  shows only what runs and what is planned; a finished predecessor is still named on its follower's chip ("after PW
  · done"). The user decided this in PL2's review (rounds 2 and 3): nothing about the finished queues moves.
- **On the phone** (`plan-features@390`): the same tools as chips that wrap. The critical path is marked on the list. Tapping an "after" chip opens the line's details under the card. Dragging stays
  on the desktop (the phone has "After…").

## Recommendation

Build A with our own code in `apps/web/src/plan.ts`: no library. Use pure functions for the columns, the gaps and the
tracks, with unit tests that check no line runs through a box. Add `scripts/layout-faults.ts` on a development
instance with `seed-plan-nexus.ts` as an acceptance of the build. dagre would only pay off for B, and ELK costs more
than the rest of the dashboard together.

Order for the build queue (IO):

1. The routing and the full titles: this ends the faults the user saw.
2. A line's details, "also after" by dragging, Undo.
3. The critical path and "what blocks".
4. (The finished queues: nothing to build; they stay folded at the page's end, as today.)
5. Lanes by area.
6. The time axis, once the estimates have enough samples (queue ST3).

Points for the build, the user's to decide in the review if they want otherwise:

- The right rail stays on the Queues view, so the plan has 788 px at 1440. Without the rail it would have about
  1160 px, with wider boxes and fewer lines per title.
- Lanes use compact cards (no chips).
- The time axis is a view of its own, with no lines.
