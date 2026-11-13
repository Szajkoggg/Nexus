# Dashboard survey: the everyday uses

Queue UX, step UX1 (2026-11-13). The dashboard was walked use by use, not screen by screen, on a copy of the real
projects' data, at 1440, 492 and 390 px. The pictures are in [survey/](survey/); every problem below names its
pictures. At the end there is a numbered list to pick from for UX2.

## How it was done

- **Data.** The `.nexus/` folders of both registered projects (honeycomb, nexus) were copied (read only, twice over to
  pick up files that changed mid-copy; no read errors) into a temporary folder outside every git repository, one
  folder per project, each `git init`-ed with no remote.
- **Paths.** Every real root was rewritten to the temporary folders in all 166 files (92 changed): `project.yaml`
  `root`, `defaults.worktree_dir` (set to `<copy>.worktrees`), the UX queue's `worktree`, every session's `cwd`, and
  the paths inside logs and drafts, in all forms (`C:/…`, `C:\…`, JSON-escaped `C:\\…`, `/c/…`, `//c/…`). A final
  search for any real root (`C:\Code`, `C:/Code`, `/c/Code`, `//c/Code`, the D: backup, case-insensitive) found
  none; what remained were the example path `//c/Code/P/.nexus` in a transcript and Claude memory folder names, which
  were neutralised as well. `defaults.push_accepted: false` in both.
- **Runtime files.** All 15 `sessions/*/runtime.json` set to `exited` with no pid (three were `idle`, one
  `working`). No `run.yaml` had `resume_after_restart`, `retry_wait` or `usage_wait`; the copied UX run was
  `running` and the server paused it at start ("the Nexus server restarted").
- **Server.** A development instance on port 4318 with its own `NEXUS_HOME` registering only the copies,
  `NEXUS_CLAUDE`/`NEXUS_CODEX` pointing at the fake runtimes, and `NEXUS_HANDOVER`, `NEXUS_DIR`, `NEXUS_SESSION`,
  `NEXUS_LOG` removed. The only agent it started was the fake Claude (checked by its command line).
- **States made for the walk** with the `nexus` CLI against the copies: two questions from the W worker in
  honeycomb, escalated by its orchestrator; review material, a check and `step done` on UX1 and UX2 after setting the
  UX queue to "wait for my review" from the dashboard. Proposed queues (SC, SF) and a stopped queue (W) were already
  in the data. For the header, three empty projects were added to the copy registry and the update pill was put in
  the header by script (its own class list), as the live instance shows it during an update.
- **Pictures.** Headless Edge driven over the DevTools protocol. 390 px is a real phone emulation (touch, device
  pixel ratio 2), not an iframe. Clicks are real mouse events at the element's centre, so a button that is covered
  counts as unreachable.
- Nothing was approved, accepted, merged, pushed, updated or continued in the instance. One question was answered and
  one chat message sent to the fake orchestrator.

## The user's own pain points first

All four were seen.

1. **The chat is small on a desktop.** The orchestrator chat is a 480 px panel at the right of a 1440 px screen; the
   rest is the project page, which repeats what the waiting list already says
   ([e1](survey/e1-orchestrator-chat-1440.png), [e2](survey/e2-orchestrator-sent-1440.png)). On a phone it is a full
   screen with the composer and its Send button taking a fifth of it ([e4-390](survey/e4-chat-orch-390.png)).
2. **Buttons dropped wherever there was room.** Each panel places its actions differently: Approve is a blue button at
   the top of the queue drawer ([b1](survey/b1-approve-drawer-1440.png)); a review has "Accept and go on" and
   "+ Add a note" on one line, "Reject…" on its own line, then a "Fix it" form that is always open
   ([d1](survey/d1-review-drawer-1440.png)); a question has its Answer button under each question
   ([c1](survey/c1-question-open-1440.png)); the orchestrator chat has a "tool calls" checkbox and "New conversation"
   next to Close, an Ideas chat has "Hand to orchestrator" and a "More…" select there instead
   ([e4](survey/e4-chat-orch-1440.png), [e5](survey/e5-chat-ideas-conv-1440.png)); the viewer has "Mark accepted"
   bottom left ([d4](survey/d4-viewer-before-1440.png)).
3. **The header runs out of room.** With five projects, the usage meter and the update pill, the project tabs get
   155 px of the 611 they need at 1440 px: only "Project Honeycomb" shows, and the current project (Nexus) is not
   visible at all ([g1-1440](survey/g1-header-5-projects-update-1440.png)). On a phone the header is two rows
   (105 px) and three during an update (144 px), mostly unlabelled 28 px icons
   ([g1-390](survey/g1-header-5-projects-update-390.png), [g1-492](survey/g1-header-5-projects-update-492.png)).
4. **Switching between the orchestrator and Ideas.** On a desktop, from an Ideas conversation the header's
   "Orchestrator" button does nothing (four clicks, the open layers stayed `chat, ideas, conversation`;
   [e6-1440](survey/e6-chat-back-to-orch-1440.png)); the way back is closing twice. On 492 and 390 px the chat covers
   the header, so the Ideas button cannot be reached without closing the chat, and an Ideas conversation on the phone
   has no close button at all, only Back ([e5-390](survey/e5-chat-ideas-conv-390.png)). Queue SC (step SC4, proposed)
   already covers the switch.

## The uses, walked

| Use | Desktop (1440) | Phone (390) | Pictures |
|---|---|---|---|
| Morning look | page 2.9 screens long; half of it is Refused actions and the Sessions table | 4.6 screens | a0, a1, a2, a3, a4, a5 |
| Approve a queue, having read its steps (SC, 4 steps) | 7 clicks: queue, 4 steps, back, Approve | about 11 taps: each step needs close, horizontal scroll, tap | b1–b4 |
| Approve without reading | 2 clicks | 2 taps | b1 |
| Answer a question | 3 (card, type, Answer); the box is 772 px down, a second question's 2531 px | 3 taps plus a scroll: the box is 947 px down on an 844 px screen | c1–c3 |
| Review a step with pictures | card, scroll 1216 px to 171 px thumbnails, viewer, close, scroll up, Accept: 4 clicks and 2 scrolls | the same, the material at 1463 px | d1–d4 |
| Orchestrator → Ideas conversation → back | 2 + 2, plus a dead click on "Orchestrator" | 3 + 3 (close, Ideas, conversation; Back, Close, chat) | e1–e6 |
| Switch project | 1 click, when its tab is visible | 2 taps; 3 with a drawer open | f1–f3, g1 |

### The morning look

What happened overnight is not in one place. The waiting list is good (cards with a kind, the step and a time), but
the rest is scattered: finished queues are folded into "Finished (21)" with a time and a duration and no outcome
([a4](survey/a4-finished-1440.png)); "In progress 4" in honeycomb mixes the stopped W with DW and B, which have waited
for days ([a2](survey/a2-honeycomb-1440.png)); Refused actions and an eight-row Sessions table fill the bottom of the
page ([a1-full](survey/a1-nexus-full-1440.png)), and on a phone the table is 656 px wide in a 356 px box
([a5-390](survey/a5-page-bottom-390.png)).

Statuses contradict each other. After the server restart the UX queue showed "running" next to "Nexus: paused", and
UX1 "running" with a progress bar while nothing ran ([a0](survey/a0-after-restart-1440.png)); later it showed
"waiting" and "0/2 steps" with both steps done and in review ([a1](survey/a1-nexus-1440.png)). In honeycomb the
stopped W carries "stopped", "Nexus: halted" and "2 questions" chips, and its stop reason appears in full three times:
the waiting card, the queue header and the step drawer ([a2](survey/a2-honeycomb-1440.png),
[c1](survey/c1-question-open-1440.png)). "Continue possible: open the queue to lift the stop" is a sentence that
tells the user where to go, not a button.

Long queues overflow sideways: W has 11 steps in one row, and W4c, the stopped step that matters, is cut off at the
right edge on a desktop ([a2](survey/a2-honeycomb-1440.png)); on a phone 1½ cards show
([a2-390](survey/a2-honeycomb-390.png)).

On a phone the waiting cards give a third of their width to the badge, so the text is cut after two short lines and a
question cannot be read in the list ([a2-390](survey/a2-honeycomb-390.png), [a3-390](survey/a3-inbox-390.png)). The
"Waiting for you" panel opens from the right, a queue or step drawer from the left, the chats from the right again
([a3](survey/a3-inbox-1440.png), [b1](survey/b1-approve-drawer-1440.png)).

### Approving a queue

The queue drawer says "Approving pins revision 1: its steps, acceptance criteria, checks and stop conditions", but it
does not show the steps or their acceptance: only the approval box, run settings, the description (folded), stop
conditions and checks ([b1](survey/b1-approve-drawer-1440.png), [b2](survey/b2-approve-drawer-scrolled-1440.png),
[b3](survey/b3-approve-drawer-end-1440.png)). The steps are cards on the page with titles cut to two lines; reading a
goal means opening each step ([b4](survey/b4-step-of-proposed-1440.png)). On a phone the step drawer covers the page,
so every step is close, scroll the strip sideways, tap; its close button overlaps the breadcrumb
([b4-390](survey/b4-step-of-proposed-390.png)). The Approve button comes first, before anything to read.

### Answering a question

Clicking the "Which seed…" card opened the step drawer with the stop reason (a long orange paragraph) first, then the
other question, then the clicked one ([c1](survey/c1-question-open-1440.png)). The question's options ("Smooth it
now", "Leave it for later") are a plain bullet list: the answer must be typed. The orchestrator's framing and
recommendation come after the question in grey. Answering worked and the waiting count dropped at once
([c3](survey/c3-question-answered-1440.png)); then nothing leads to the next waiting item. On a phone the first answer
box is below the first screen ([c2-390](survey/c2-question-answerbox-390.png)).

### Reviewing a step

The decision comes before the evidence: "Accept and go on", "Reject…" and an open "Fix it" form sit at the top; the
goal, acceptance, review material (two 171 px thumbnails, 1216 px down), checks and timeline follow
([d1](survey/d1-review-drawer-1440.png), [d2](survey/d2-review-drawer-scrolled-1440.png)). The viewer itself is good:
After, Before and after, Overlay, a mark and a comment per picture ([d3](survey/d3-viewer-1440.png),
[d4](survey/d4-viewer-before-1440.png)). But it has no step decision, so after the last picture the user closes it and
scrolls back up to Accept. On a phone, before and after stack small and the comment box takes a quarter of the screen
([d4-390](survey/d4-viewer-before-390.png)); the Before/After labels lie over the picture.

### Chatting and switching chats

Reading is comfortable on a phone and cramped on a desktop (above). "New conversation" sits right beside Close in
the orchestrator's header, one slip from starting over ([e1](survey/e1-orchestrator-chat-1440.png)). The chat shows
no link to the queues or steps it talks about. The Ideas list is two lines in an otherwise empty panel
([e3](survey/e3-ideas-over-orchestrator-1440.png), [e3-390](survey/e3-ideas-list-390.png)). Switching: see pain
point 4.

### Switching projects

On a desktop a tab click, as long as the tab is visible (pain point 3). On a phone a picker with each project's
waiting count ([f1-390](survey/f1-switch-menu-390.png)); with a drawer open it must be closed first
([f3-390](survey/f3-switch-with-drawer-390.png)). Neither shows whether something runs in a project, only how much
waits. Opening the orchestrator chat on switching (decided) is not there yet.

### Looks

Dark and calm, but busy in the details: many coloured rings and chips per row, meta text (times, durations, the
"▣ 2" material count) in small low-contrast grey, step cards of fixed height with an empty middle, mono-spaced ids
mixed with proportional titles. The touch targets in the phone header are 28 × 28 px (22 px high for one), under the
usual 44.

## Ranked problems

Ranked by how often the use comes up and how much the problem hurts. Clicks are from the table above.

### Quick fixes (small, local changes)

| # | Problem | Often | Hurts | Pictures |
|---|---|---|---|---|
| Q1 | Question options are not buttons; the drawer opens on the stop reason, not on the clicked question | each question | typing what could be a tap; the question is a screen down on a phone | c1, c2 |
| Q2 | Waiting cards on a phone: the badge takes a third of the width, the text is cut after two lines | every visit on the phone | questions and summaries unreadable in the list | a2-390, a3-390 |
| Q3 | Contradicting statuses: "running" with "Nexus: paused", a running step after a restart, "0/2 steps" with both in review, "In progress" holding queues that wait for days | every look | what really runs is not visible | a0, a1, a2 |
| Q4 | "Continue possible: open the queue to lift the stop" is a sentence, not a button; the stop reason is shown in full three times | each stop | the main action of a stop is hidden | a2, c1 |
| Q5 | Refused actions and the Sessions table fill the bottom of every project page; the table overflows on a phone | every look | the page is twice as long as what matters | a1-full, a5-390 |
| Q6 | "New conversation" next to Close in the orchestrator chat | each chat | one slip starts the conversation over | e1 |
| Q7 | Phone: no close button in an Ideas conversation; a drawer's close overlaps its title; header icons are 28 px and unlabelled | daily on the phone | mis-taps, hunting for the way out | e5-390, b4-390, g1-390 |
| Q8 | The header's Orchestrator button does nothing when the orchestrator lies under Ideas (already in SC4) | each switch | a dead click | e6-1440 |
| Q9 | After answering or accepting nothing leads to the next waiting item | each item | back to the list every time | c3 |
| Q10 | Panels open from different sides (waiting list right, drawer left, chats right) | every panel | the eye has to search | a3, b1, e1 |

### Larger changes

| # | Problem | Often | Hurts | Pictures |
|---|---|---|---|---|
| L1 | The chat is a narrow side panel on a desktop (user's pain point) | all day | the main activity gets a third of the screen | e1, e2, e4 |
| L2 | The header: project tabs vanish with more projects or an update (the current one included); two to three rows on a phone (user's pain point) | every visit | cannot see or reach projects | g1 |
| L3 | One consistent place and order for actions in every panel (user's pain point) | every action | each panel must be learned | b1, d1, c1, e4, e5, d4 |
| L4 | Reviewing: the decision before the evidence, small thumbnails, no Accept in the viewer | several times a day | 4 clicks and 2 long scrolls per review | d1–d4 |
| L5 | Approving: the queue drawer does not show the steps and their acceptance | each queue | 7 clicks on a desktop, about 11 taps on a phone, to read a 4-step queue | b1–b4 |
| L6 | No morning digest: what finished, stopped or failed since the last visit, with outcomes, in one place | daily | the night's work must be pieced together | a1, a2, a4 |
| L7 | Long queues overflow sideways and hide the step that matters; on a phone 1½ steps show | each look at a long queue | the stopped or running step is off-screen | a2 |
| L8 | Phone layout of its own: a bottom bar for the few things used most (orchestrator, waiting, queues, Ideas) instead of the header rows | daily on the phone | header and chat switching | g1-390, e4-390 |
| L9 | A new visual identity, possibly switchable themes (calmer chips, readable meta text, cards that use their space) | always | looks busy and dim | all |

## Pick list

Pick by number for UX2 (proposals with mockups). Q-items are small enough to need no mockup unless you want one.

1. Q1: question options as one-tap buttons, and the drawer opening on the clicked question.
2. Q2: waiting cards that read well on a phone.
3. Q3: honest statuses: one chip per queue, "Running" apart from "Waiting", steps in review counted.
4. Q4: a Continue button on a stop, and the stop reason shown once.
5. Q5: Refused actions and Sessions moved off the main page (folded, or into settings).
6. Q6: "New conversation" moved into a menu.
7. Q7: phone fixes: close in an Ideas conversation, the drawer's close, 44 px header targets with labels.
8. Q8: the dead Orchestrator click (already SC4).
9. Q9: "Next waiting item" after an answer, approval or acceptance.
10. Q10: panels from consistent sides.
11. L1: the chat as the main column on a desktop (variants: chat-first layout; chat beside the details; a wider resizable panel).
12. L2: the header (variants: a project sidebar; a two-row header; a footer).
13. L3: one action bar, same place and order, in every panel and the viewer.
14. L4: review redesign: evidence first, large pictures, Accept / Fix it / Reject in the viewer.
15. L5: approval view that shows every step's goal and acceptance in one scroll.
16. L6: a morning digest at the top of the page (or of the waiting list).
17. L7: queues with many steps: a vertical list on the phone, the current step in view on a desktop.
18. L8: a phone bottom bar.
19. L9: a new visual identity, with themes side by side.
