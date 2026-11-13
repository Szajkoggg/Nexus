# Dashboard proposals with mockups

Queue UX, step UX2 (2026-11-13). Proposals for the items of the pick list in [survey.md](survey.md). UX1 was
accepted without a pick, so the worker asked; the user picked **all the larger changes, 11–19, with the quick fixes
1–4 folded in**. The other quick fixes (5–10) are shown inside these mockups too; see the table at the end.

The mockups are standalone HTML pages in [mockups/](mockups/) (open them in a browser; `mock.css` holds the three
themes, `phone.js` the phone's top line and bottom bar). The data is real: the queues, steps, questions and chat
messages of the user's two projects as they were today, plus three empty projects for the header. Pictures are in
[mockups/shots/](mockups/shots/), desktop at 1440 px, phone at 390 px (a real phone emulation); each is registered
as review material with the matching survey screenshot as its "before". 492 px windows would get the phone layout.

Shared by all of them: the **graphite** theme (a calmer dark: status as a dot and a word instead of coloured rings, one
accent colour for actions, readable meta text), **one action bar** at the bottom of every panel, and refs in the chat
(`UX2`, `W4c`) that open the item.

## 11. The chat as the main column on a desktop (pain point 1)

| Variant | Mockup | |
|---|---|---|
| A · Chat-first | [11a-chat-first.html](mockups/11a-chat-first.html), [picture](mockups/shots/11a-chat-first-1440.png) | Projects in a sidebar, the conversation in the middle (780 px of text, like a chat app), a right rail with what waits (all projects), what runs and what finished today. The Orchestrator / Ideas switch is the chat's own header. The project page (queues in full) opens from "All queues". |
| B · Split | [11b-split.html](mockups/11b-split.html), [picture](mockups/shots/11b-split-1440.png) | Today's page on the left in a compact form, the chat on the right at 760 px with a drag handle ("Wider" doubles it). Keeps the page as the home; the chat is no longer a narrow overlay. |

**Recommendation: A.** The conversation is where the user spends the day, and A answers the decided "switching to a
project opens its orchestrator chat" without a special case: the chat *is* the project's first view. What waits stays
in sight on the right; an item opens as a drawer over the rail, so the chat never moves. B is the smaller step if A
feels too big a change.

*Touches:* `App.tsx` (layout, routes: the chat becomes the default view of a project, the page a second view),
`Chat.tsx` (from a fixed panel to a column; refs as links), `Attention.tsx` (the rail), `layers.ts`/`nav.ts` (the chat is
no longer a layer on wide screens). Server: none.

## 12. The header (pain point 3)

[12-header-variants.html](mockups/12-header-variants.html), [picture](mockups/shots/12-header-variants-1440.png):
three variants with the same five projects, the usage meter and an update going on.

- **A · Project sidebar**: any number of projects, each with its waiting count and a dot when something runs; global
  status (update, usage, notifications, connection) at the sidebar's foot.
- **B · Two-row header**: row 1 global status and tools, row 2 project tabs only, the full width.
- **C · Status footer**: the header keeps the project and its actions; projects and global status in a slim bar at the
  bottom, as in an editor.

**Recommendation: A** (it comes with 11A). B if 11B is chosen: it is the least change and fits about eight projects.
On the phone, none of these: the project picker stays on the top line and the tools move into the bottom bar (18).

*Touches:* `App.tsx` header, `Projects.tsx` (tabs → sidebar list with "running" from the projects API, which already
has `running`), `Settings.tsx` (UpdatePill, usage meter into the sidebar foot).

## 13. One action bar everywhere (pain point 2)

[13-action-bar.html](mockups/13-action-bar.html), [picture](mockups/shots/13-action-bar-1440.png): the approval,
review and question panels built the same way. Header: where it is, what it is, its status, ✕ always top right. Body:
what to read, the evidence first. **Action bar at the bottom, always visible: the main action on the right, the second
left of it, everything else under ⋯** (Reject, Withdraw, settings). The chat headers follow the same rule: the switch
on the left, ⋯ on the right, "New conversation" inside ⋯ (quick fix 6). The viewer (14) has the same bar.

One variant only: there is one good answer here, the question is only the side (right, as most of Windows does, and
where the thumb is on a phone).

*Touches:* a shared `ActionBar` in `ui.tsx`; `Details.tsx` (approval, review, stop, question sections), `Chat.tsx`
headers, `Viewer.tsx`. Behaviour unchanged.

## 14. Reviewing: the pictures first, the decision in the viewer

[13-action-bar.html](mockups/13-action-bar.html) (middle panel) and
[14-review-viewer.html](mockups/14-review-viewer.html), [picture](mockups/shots/14-review-viewer-1440.png). The
review drawer opens on the summary and large pictures (two per row, with their marks), checks and commits as one
line, the goal folded; Accept is in the action bar, not above the evidence. The viewer gets a filmstrip of all the
step's pictures (marks shown), ← → to move, and the step's decision on the right of its bar: after the last picture
the user accepts without leaving it (today: close, scroll up, Accept).

*Touches:* `Details.tsx` (order of the review section), `Viewer.tsx` (filmstrip, the step's actions); the accept and
send-back APIs exist.

## 15. Approving: the whole queue in one scroll

[15-approval.html](mockups/15-approval.html), [picture](mockups/shots/15-approval-1440.png), and the left panel of
[13](mockups/shots/13-action-bar-1440.png). Every step's goal and acceptance in the approval view itself, an outline
on the left, run settings on one line under the title, the orchestrator's message one click away; "Approve revision 1"
in the action bar with what it pins. Reading and approving a 4-step queue: 1 click to open, scrolling, 1 to approve
(today 7 clicks; on the phone about 11 taps). Two forms: the full view (15) for a desktop, the compact list with
expandable criteria (13, left) for the drawer and the phone.

*Touches:* `Details.tsx` (queue section), the queue's steps are already in the state. Server: none.

## 16. The morning digest

[16-morning-digest.html](mockups/16-morning-digest.html), [picture](mockups/shots/16-morning-digest-1440.png).
"Since you last looked" (stored per device): four numbers (finished, stopped, waiting, running), what happened
newest first across projects with outcomes and report links (refused actions and retries included, so they leave the
project page: quick fix 5), and the waiting list with **"Go through them one by one"**, which opens the first item and
moves to the next after each answer or decision (quick fix 9). It shows when there is something new; "Mark as seen"
folds it.

With 11A it is the right rail's top on the first visit of the day; with 11B, the top of the page.

*Touches:* a new `Digest.tsx`; the events are already in the state; a "last seen" time in local storage; a "next
waiting item" helper shared with the drawers. Server: none (a small API for events across projects would make it
cheaper).

## 17. Long queues: the step that matters in view

[17-long-queues.html](mockups/17-long-queues.html), [picture](mockups/shots/17-long-queues-1440.png), and the phone
form [17-long-queues-phone.html](mockups/17-long-queues-phone.html),
[picture](mockups/shots/17-long-queues-390.png). Honeycomb's W has 11 steps; today the stopped W4c is cut off at the
right edge on a desktop and 1½ cards show on a phone.

- **A · Folded rail**: the done and skipped steps before the current one fold into one chip ("3 done · 2 skipped,
  W1–W4b ▸"); the rail starts at the step that matters, which gets a wider card with its reason, Continue and its
  questions; later steps stay small, the rest as "+ W5 · W6 · W7".
- **B · Step list**: one line per step in two columns under a progress line (a segment per step, coloured by status);
  the current step highlighted with its action. On the phone the same list in one column, the finished run folded,
  later steps after the third folded.

**Recommendation: B.** It shows the whole queue at once without sideways scrolling, reads the same on a desktop and a
phone, and is shorter than today's card row for queues up to about 12 steps. A keeps today's cards if the user likes
them, at the cost of a second form for the phone.

*Touches:* `QueueRow.tsx` (the step row becomes a list; folding of closed steps), `Run.tsx` (the progress line). The
step order and statuses are already in the state.

## 18. The phone: a bottom bar

[18a-phone-waiting.html](mockups/18a-phone-waiting.html), [18b-phone-chat.html](mockups/18b-phone-chat.html),
[18c-phone-question.html](mockups/18c-phone-question.html);
pictures [18a](mockups/shots/18a-phone-waiting-390.png), [18b](mockups/shots/18b-phone-chat-390.png),
[18c](mockups/shots/18c-phone-question-390.png). Four tabs at the thumb: **Orchestrator, Waiting (with the count),
Queues, Ideas**; switching chats is one tap (pain point 4, also SC4). The top line is one row: the project picker,
what runs, settings. Waiting cards put the kind, the place and the time on one line and give the text the full width
(quick fix 2); a question's options are buttons right in the card. An item opens as a full-screen sheet with Back, ✕
and "1 of 6", the question first, the options as 48 px buttons and the action bar at the bottom (quick fix 1). The
composer is one line with a round Send.

*Touches:* `App.tsx` (a phone layout under 640 px: bottom bar, tabs as routes), `Attention.tsx` (card layout, option
buttons), `Details.tsx` (sheet form), `Chat.tsx` (composer). The header's icon row goes away on the phone.

## 19. A visual identity, three themes side by side

[19-themes.html](mockups/19-themes.html), [picture](mockups/shots/19-themes-1440.png): the same screen in
**Graphite** (the calmer dark), **Paper** (light, warm off-white) and **Honey** (warm dark, amber accent). Common to
all: a status is a dot and a word, never a ring; one accent for actions; meta text at a readable contrast; step lists
without empty card middles; the stopped step highlighted in its row with Continue next to it (quick fix 4).

**Recommendation: Graphite as the default, Paper as the second**, chosen in settings or following the system's
light/dark; Honey if the user wants more character. The themes are CSS variables (`mock.css`), so a switch is cheap
once the colours in the components go through variables.

*Touches:* `index.css` (variables per theme), Tailwind classes across `components/` replaced by theme tokens
(the bulk of the work: some 450 lines with colour classes in 13 files), `Settings.tsx` (the switch).

## The other items, where they are shown

| Item | Shown in |
|---|---|
| 1 Question options as buttons, opening on the clicked question | 13 (right), 18A, 18C |
| 2 Waiting cards that read well on a phone | 18A |
| 3 Honest statuses: one per queue, Running apart from Waiting | 11A rail, 11B page, 16 |
| 4 A Continue button on a stop, the reason once | 11A rail, 18A, 19 |
| 5 Refused actions and Sessions off the main page | 11B (folded links), 16 (in the digest) |
| 6 "New conversation" into ⋯ | 11A, 11B chat headers |
| 7 Phone: close in every sheet, 44 px targets | 18A–18C |
| 8 The dead Orchestrator click | 11A/11B switch, 18 bottom bar (SC4 builds the switch) |
| 9 Next waiting item | 13 (question), 16, 18C |
| 10 Panels from consistent sides | 11A: drawers open over the right rail only |

## Suggested order for an implementation queue

1. Themes as variables and the action bar (19, 13): everything later builds on them, and they change no behaviour.
2. The phone layout with the bottom bar, the waiting cards and the step list (18, 17, quick fixes 1, 2, 7).
3. Review and approval views (14, 15, quick fixes 4, 9).
4. The desktop layout: chat-first with the project sidebar (11A, 12A) and the digest in its rail (16).
