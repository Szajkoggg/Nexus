# The dashboard

Part of [the design](../DESIGN.md).

## Back closes the topmost layer

Everything the dashboard opens over the queue list is a layer kept in the browser history, so the phone's back
button, the back gesture, the browser's Back and Escape all close the topmost one, and Back leaves the app only when
nothing is open. Each history entry Nexus writes carries `{hash, layers, depth}` in `history.state`: the hash is the
route (`#/<project>[/<queue>[/<step>[/<qid>]]]`, the queue or step drawer being the layer `item`), `layers` the open stack
(`chat`, `ideas`, `conversation:<id>`, `settings`, `remote`, `waiting`, `projects`, `viewer:<index>` for a review
image), `depth` how many entries Nexus
pushed, and the view (`tab`: the phone's tab, a desktop's middle column; see below). Opening pushes one entry; a close button goes back to it, so Back never reopens what was closed and no dead
entries pile up; switching within a kind (another step, another conversation) replaces the entry. Switching
projects is not a layer: it rewrites the entry in place. A page loaded with something open (a hash with a step,
`?chat`) has no entry to go back to, so closing it rewrites the entry instead. Review images open in an in-app
viewer for the same reason: a new browser tab, in an installed app on a phone, had no way back; moving to the next
image replaces the viewer's entry, so one Back always returns to the step. The rules are pure
(`apps/web/src/layers.ts`, unit tested); `nav.ts` applies them to `window.history`.

## Details beside the chat on a wide screen (replaced)

N2B.3 opened a queue or step in a panel on the left and the chat or Ideas in one on the right from 1280 px, the queue
list between them. **Chat-first (below) replaces it**: from 1024 px the chat is the middle column, not a panel. What
N2B.3 taught the history rules stays: switching or closing a layer that is not on top goes back to its entry and
opens the layers above it again (applied as one change, so what stays does not flicker), and a layer that belongs to
another (a conversation to Ideas, an image to its step) closes with it while the others stay. Its 1280 px breakpoint
(`WIDE`, `useWide`) is where the right rail of chat-first begins.

## The file viewer

Decided by the user on 2026-11-14 (queue CH3; docs/ideas/chat-improvements.md): a referenced file opens in the
dashboard's own read-only viewer, at the line: code highlighted, Markdown rendered, pictures in the picture viewer; it
works on the phone and starts no program. Files over 1 MB are cut with a note; binary files other than pictures are
not shown.

How it is built (`apps/web/src/fileview.ts`, pure and unit tested; `components/FileView.tsx`; the endpoint in
PROTOCOL.md, ["Files and commits"](../protocol/api.md#server-api)): the viewer is a layer in the history, `file:<line>:<path>` (`nav.file`), so Back
and Escape close it; `?file=<path>&line=<n>` opens it at load. It fetches the file once, and the server's
`X-Nexus-Kind` decides what it shows: a picture goes to the review's picture viewer (alone, "Original ↗" beside it),
a PDF or another binary gets a line with a link instead. Code is shown with line numbers, the line asked for marked
and scrolled to the middle. The highlighter is **lowlight** (highlight.js's grammars, returning a syntax tree rather
than an HTML string): the tree is flattened into lines of tokens and rendered as React text, so file content is
never injected as HTML; its classes take the theme's tokens (`.hl` in `index.css`), so every theme highlights
without a stylesheet of its own. Shiki was the alternative: TextMate grammars, nicer for some languages, but several
times the size and with fixed colour themes; Prism and plain highlight.js produce HTML strings. The highlighter is a
chunk of its own, loaded with the first code file, and so is the viewer; text over 512 KB is shown plain. The
language comes from the extension (unknown ones are plain text, never guessed). Markdown is rendered with
react-markdown and GitHub's extensions (remark-gfm: tables, task lists); raw HTML in it stays text. Its links to
other files of the project open them in the viewer (`..` is resolved in the browser, since the server follows none),
web links open a new tab, its own pictures come through the file endpoint and pictures from the web are not loaded.
Opened at a line, a Markdown file stays rendered and the block holding that line is marked and scrolled to; "Source"
shows it as code at the line. Smaller choices made while building, not by the user: the Rendered/Source switch, the
marked block, not loading web pictures, and a "Raw ↗" link to the file itself (sandboxed by the server).

**Open in editor** (decided by the user; `apps/web/src/editor.ts`, pure and unit tested): beside a text file in the
viewer, a link through the editor's own URL scheme opens the file at the line; the browser hands it to whatever the
system registered for the scheme, and no server action starts a program. The editor is a setting of this browser,
like the theme (`nexus.editor` in local storage; VS Code by default, Cursor, JetBrains, none). It shows only when the
dashboard is opened on the server machine (`local` from `GET /api/server`, the same test remote access uses) and not
in the phone layout: on another device the path would point nowhere. The path is the server's (`X-Nexus-Path`, links
followed), so a relative reference opens the right file. VS Code and Cursor take `vscode://file/<path>:<line>` and
`cursor://file/<path>:<line>`. JetBrains has no scheme of its own that takes an absolute path; the JetBrains Toolbox
App's `jetbrains://idea/navigate/reference?project=<name>&path=<path>:<line>` names a project, given as the project
root's folder name with the path within it, so a file outside the project gets no JetBrains link; the tool in it is
`idea` (IntelliJ IDEA). None of the links was opened while building (that starts a program); on the machine it was
built on only VS Code's scheme is registered, so the Cursor and JetBrains forms are untested.

## Colours are theme tokens

Every colour in the dashboard is a theme token: a CSS variable in `apps/web/src/index.css` (Tailwind's `@theme`),
used through Tailwind's utilities (`bg-surface`, `text-fg-2`, `border-line`, `text-warn`, `bg-review/15`). Tailwind's
own palette is switched off (`--color-*: initial`), so a palette class such as `text-zinc-400` produces no CSS: a
colour can only come from the scheme. The default values are the **Graphite** theme of the UX
proposals (`docs/ux/mockups/mock.css`, item 19); **Paper** and **Honey** set the same variables under
`html[data-theme="paper"]` and `html[data-theme="honey"]`, and every component follows without a change. The
values are the mockup's; `surface-4` (hover over `surface-3`) and `scrim` (black in all three) are additions.

| Token | Use |
|---|---|
| `canvas` | The page; text boxes and inputs; dark chips over pictures |
| `surface`, `surface-2`, `surface-3`, `surface-4` | Panels and cards; raised fills (info boxes, step cards); chips, quiet buttons, the current step; hover over those |
| `line`, `line-strong` | Dividers and card edges; inputs, buttons, a hovered edge (`fg-3/60`) |
| `fg`, `fg-2`, `fg-3` | Main text; secondary text (labels, descriptions); meta (ids, times, hints), still at about 4.5:1 on a surface |
| `accent`, `accent-strong`, `on-accent` | The one accent: actions, links, focus, selection, what is running; a primary button's fill and its text |
| `ok`, `warn`, `stop`, `review`, `info`, `danger` | Status colours: done; waiting and questions; stopped; in review (and the orchestrator's doings); approval and pending deliveries; failed, rejected and errors |
| `user-bubble`, `scrim` | The user's own chat messages; the dimming behind a drawer or menu |
| `series` | A chart's one series colour (the Stats views): the accent stepped into the lightness band the `dataviz` skill's validator allows for the mode (Graphite `#3f7cf5`, Paper `#2f6fec`, Honey `#c47e14`), checked against the cards' surface; a few-data group is `fg-3`, a value beyond a threshold `warn` with ⚠ |

Rules the components keep:

- **A status is a dot and a word** in its colour (`StatusBadge`, the run's state, the update pill), never a ring or a
  filled pill. Step cards are neutral (`surface-2`, the current one `surface-3`); the dot and word carry the status.
- **A kind is a tag**: what waits for the user (Question, Review, Needs approval, Stopped) is the kind's colour on a
  15 % fill of it, without a ring.
- **A callout** (a stop, a merge to confirm, a rejection) is a faint fill of its colour with a 30 % border of it.
- **One accent** for actions: primary buttons, links, focus, checkboxes. Information that is not an action (a
  pending delivery, a planned start) uses `info`.
- Opacity modifiers derive tints from tokens (`bg-warn/15`), so a theme defines each colour once.
- **Charts** (components/charts.tsx, the reasons per form in docs/ux/stats-mockups.md) follow Claude Code's `dataviz`
  skill: one series colour, never a status colour for a series; thin marks with a 4 px rounded end; hairline solid grid,
  dashed only for a reference line (a threshold, a target); text in the text tokens; a tooltip on hover and focus;
  and a table view beside every chart. Two measures of different units are two charts, never two y-axes.

## The interface texts in one place

Decided on 2026-11-14 (`docs/ideas/languages.md`): the dashboard is prepared for translation, English the source; the
translations themselves are a later queue. Every text the dashboard shows is a key in one catalogue,
`apps/web/src/messages/en.ts`, and components ask for it through `apps/web/src/i18n.ts`:

- **`t(key, params)`** returns the text in the interface language. `{name}` in a text is a parameter; a number is
  formatted for the locale (`1,234`). A text that depends on a number is a plural message, one form per plural
  category (`{ one, other }`, and `few`, `many`… where a language has them), chosen by the `count` parameter through
  `Intl.PluralRules`. A placeholder without a value stays as written, so a missing parameter shows.
- **`rich(key, params)`** is the same with elements as parameters (a `<code>`, a link): it returns the parts for React
  to render, so a sentence with markup inside stays one text a translator can reorder.
- **A translation** is a catalogue with any subset of the keys (`addLanguage`, `setLanguage`); a key it lacks falls
  back to English, with English plural rules. Keys are typed from the English catalogue, so a typo does not compile.
  A key is named by where its text is used (`rail.…`, `notify.…`, `common.…` for what is shared); a new meaning gets a
  new key, so a translation never keeps an old sense under a changed English text.
- **Dates and times** go through `Intl.DateTimeFormat` with the interface language's locale (`formatClock`,
  `formatDateTime`, `formatDate`, `formatTime`); English uses `en-GB`, the day-month order and 24-hour clock the
  dashboard already had. They follow the interface language, not the reader's language setting, so until a
  translation exists nothing changes (decided with the queue). A hover title that used the browser's own locale
  (`toLocaleString()`) now uses the interface language's too.
- **Durations and "ago"** (`formatDuration`, `timeAgo`) are composed from catalogue texts (`{h} h {m} min`), with the
  numbers through `Intl.NumberFormat`. `Intl.DurationFormat` and `Intl.RelativeTimeFormat` would write "1 hr, 12 min"
  and "5 minutes ago": longer than the dashboard's short forms, and the former is new in browsers; the catalogue keeps
  each language's short form in the translator's hands.

No library: react-intl or i18next would bring a provider, message syntax and a runtime of their own for what is a
lookup, a placeholder fill and `Intl.PluralRules`, about a hundred lines that are pure and unit tested
(`apps/web/test/i18n.test.ts`). The language is a module-level setting, not a React context: how a change of it reaches an
open page (a reload, a key on the root) is for the translation queue to choose.

Code never reads a translated text back: a status built from catalogue texts keeps its key and parameters beside
its words (`HonestStatus.says` in `queueStatus.ts`), and its shorter forms (the rail's few words) are chosen from the
key, not by matching the English label.

A test keeps it so (`apps/web/test/strings.test.ts`): it parses every component and fails on a literal with words
in JSX text or in a text prop (`title`, `aria-label`, `placeholder`, `alt`, and our components' `label`, `hint`,
`button`), naming the file and line. Its exceptions are listed in it with their reasons: product names (Nexus,
Claude Code, Codex), text inside `<code>` (commands, paths), and two path fragments.

Not in the catalogue: texts that come from the server (an action's error message, a run's reason, the stop's place)
and `packages/protocol/src/times.ts` (`retryLine`, the server's own times), which the server also uses; these stay
English until a queue decides how the server learns the interface language.

## One action bar

Every panel that asks something of the user is built the same way (UX proposals, item 13): `PanelHeader` (where it
is, what it is, its status, ✕ at the top right), `PanelBody` (scrolls), `ActionBar` (stays). The bar holds the main
action on the right, the second left of it, the rest under ⋯ (`Menu`), a short hint on the left; what an action
needs (a text, a reason, a confirmation) opens in the bar, above its buttons, so the button and its form are never
apart. A drawer with `panel` leaves all three to its content. One bar per panel: a step's bar is its review when it
waits for the user, else the answer to its first open question (a second open question keeps its box in its card); a
queue's bar is Continue on a stopped queue whose revision is approved, else Approve on one that is not. A form opens
by itself when its draft has text, so nothing typed earlier is hidden. `useDraftText` holds a box's draft, sending
and Ctrl+Enter for both `Composer` and the bars. The chats keep the rule in their top row (the switch left, ⋯ and ✕
right) and the viewer ends with the same bar. The menu closes on Escape without closing the panel: its handler runs
in the capture phase and stops the event before nav.ts sees it.

The theme is chosen per browser, not per project (settings, "This browser"): `localStorage` `nexus.theme`, one of
`graphite`, `paper`, `honey` or `system` (Paper when the system is light, Graphite when dark, following it while the
page is open); nothing stored, or anything else, is Graphite. Like drafts, it is the device's own matter, so it stays
out of `.nexus/`. `theme.ts` holds the rules (unit tested). So that a page never shows the wrong theme first, a small
inline script in `index.html` applies the same rules before the stylesheet paints; a test keeps the two in step.
Opacity modifiers compile to `color-mix()` on the token, with a fixed Graphite fallback only for browsers without
`color-mix()`.

## The phone

Below 1024 px (phones and narrow windows; `PHONE` in `apps/web/src/phone.ts`) the dashboard has a phone layout
(UX proposals, item 18): a top line and a bottom bar instead of the header. The top line is one row: the project
picker, what runs in the project ("SF running"), and settings (with "offline" while live updates reconnect). The
bottom bar has five tabs at the thumb: **Orchestrator** (the chat), **Waiting** (everything that waits in all
projects, with its count), **Queues** (the project's queues; what waits has its own tab), **Ideas** (the
conversations) and **Stats** (the project's metrics; queue ST3). The header's tools (the update, the usage, notifications, remote access) are in Settings there, at
the top, under "Nexus on this device". From 1024 px the desktop layout takes over (["Chat-first on a desktop"](chat.md#chat-first-on-a-desktop)).

The tab is not a layer. It is a field of the history entry (`Nav.tab`), and switching rewrites the entry it is on
(`switchTab` in `layers.ts`), so:

- **Switching tabs adds no history entry.** Back closes sheets and layers, then leaves the app; it never walks back
  through tabs.
- **What is open over a tab closes when the tab changes**, going back over the entries Nexus pushed for it, so none
  is left behind. Tapping the tab already shown closes what is over it (a conversation goes back to the list).
- **A sheet keeps the tab under it.** A queue or step, Settings, remote access, an image push entries as on the
  desktop; their entries carry the tab, so Back from a step opened on Queues shows Queues again.
- **A project switch shows the Waiting tab** (`switchProject`); the chat does not open by itself (on a desktop it
  does: see ["Chat-first on a desktop"](chat.md#chat-first-on-a-desktop)).
- **The chat, Ideas and the waiting list are tabs, not layers, on the phone.** Code that opens them as layers (a link
  with `?chat`, a window made narrow, "Chat about this" on a step) is shown through `phoneView`: such a layer stands
  for its tab, the topmost winning; a conversation stays a layer over the Ideas tab. `nav.ts` turns opening or raising
  them into a tab switch on the phone, and a conversation from a step's sheet closes the sheet, shows Ideas and opens
  the conversation over it (`openConversation`), so Back returns to the list.

On a tab, the chats are inline (`inline` in Chat.tsx): no panel row, since the bottom bar switches and nothing closes
a tab; the chat's ⋯ moves into its own header, and the Ideas tab shows the list or one conversation at a time.

**Sheets.** On the phone a queue or step, Settings and remote access open as full-screen sheets. A panel's header
becomes one row: ‹ (back to what was under the sheet), where it is, its place among what waits ("1 of 6 waiting")
and ✕; the title and status follow below it. Every sheet closes with ‹, ✕ or Back, and every button of a sheet's
header and action bar, the bottom bar and the waiting cards is at least 44 px high (Tailwind's `max-lg:`, the same
breakpoint as the phone layout).

**Questions.** A step with an open question opens on the phone as the question's sheet (`QuestionSheet` in
`components/details/questions.tsx`): the question first, what the orchestrator said passing it on, the options as 48 px
buttons, the user's own words, whether the worker may go on, then the step's details below; Answer in the action bar. An
option and words go together in one answer: the option, a blank line, the words. A waiting card shows a question's
options as buttons (the attention item carries `options`); a tap opens the sheet with that option chosen and the user
confirms there. The choice travels in memory (`chooseOption`), not in the URL: a reload opens the sheet with nothing
chosen. On the desktop the card has no option buttons and the step keeps its answer box in the action bar.

**Waiting cards** put the kind, where it is and when on one line and give the text the full width (three lines). The
phone's chat composer is one line that grows with the text (up to six) and a round Send.

**What waits, in order.** `waitingPosition` (`apps/web/src/waiting.ts`, pure, unit tested) tells where a place (a
project, queue and step) stands in the waiting list, newest first, and which item comes next: several items at one
place count as one; next skips them and wraps round to the first; a place no longer waiting (just answered) has no
position and its next is the first that waits. The phone's sheets show the place ("2 of 6 waiting") now; the next
item's button and the desktop's waiting rail build on it.

## A queue's steps as a list, with one honest status

A queue on the project page (UX proposals, 17B) is its header, a progress line with a segment per step coloured by its
status, and its steps one line each: a dot, the id, the title and the status. The step that matters (the one at work,
the stop, else the first not finished, once the queue has started) is tinted by its status and gets two lines more:
why it is where it is (the stop's reason, the question, its summary, its progress, why its run is paused) and its
action. A stop's is Continue right on its line (see "Continue at the stop" below); **Review…** and the questions
open the step. On the desktop the steps fill two columns, the left first, all of
them. On the phone (`foldSteps` in `apps/web/src/steplist.ts`, pure, unit tested) one column folds what does not
matter now: the leading run of done and skipped steps becomes one line ("W1 – W4b · 3 done, 2 skipped ▸"), and so do
the steps after the third that follow the step that matters ("+ W6, W7 ▸"); a fold of a single step is shown instead,
and a tap unfolds. The finished queues keep their own folded group at the bottom of the page (FQ).

One status per queue (`queueStatus` in `apps/web/src/queueStatus.ts`, pure, unit tested; survey Q3) replaces the
status, run and question chips that contradicted each other. It reads, first match wins: cancelled; stopped (at the
step that holds the stop); failed at a step (unless a run took it up again); waiting for the user's review (one step,
or how many); waiting for an answer (a question the worker waits on); the orchestrator reviews; then the run as it
really is: running, pausing after a step, waiting to retry, waiting for the usage window; done; a planned start (or
that it did not start); and a queue whose steps say they run while no run goes reads **paused**, with its run's reason.
Proposed reads "needs your approval". Open questions and the steps in review are counted beside it ("5 of 11 · 2 in
review"). The step lines follow the same rule: a step whose events say it runs while its run does not reads paused,
without a progress bar. The page's groups are unchanged here; the desktop layouts of the next queue use the same helper.

## Approving: the whole queue in one scroll

The approval (UX proposals, 15, and 13 left) has two forms of the same thing, both in `apps/web/src/components/
Approval.tsx`. The **full view**, a layer over the whole window, is what a desktop opens for a queue whose revision
waits for approval (`needsApproval`: not approved, neither done nor cancelled), from its waiting item and from the
queue, so reading and approving a 4-step queue takes 2 clicks (it took 7): the title with its status, run settings
(`runSettings`: the run's values, else its planned start's, else the project's) and who proposed it on one line; an
outline on the left (description, each step, stop conditions, checks) that follows the scroll, and keeps a part picked
in it marked while that part shows; every step's goal and acceptance in the page. The **compact list** is the queue's
drawer on a desktop and its sheet on the phone: one row per step, "N criteria ▾" opens the goal and acceptance in
place, the rest as folds. The phone opens the compact list; "Full view ⤢" and "Show as a panel" switch, remembered per
revision while the page lives (a choice, not history: Back closes the queue whichever form shows). On a desktop the
full view leaves the project sidebar in sight, and "Ask the orchestrator…" turns it into the panel beside the chat
(["Chat-first on a desktop"](chat.md#chat-first-on-a-desktop)).

Both forms share the approval (`useApprove`: the words under ⋯, the button, what it pins; Keep or Discard of a stopped
queue's revision through `stopDecision`, so Approve waits for the choice), Ctrl+Enter outside a text box, and "Ask the
orchestrator…", which puts "About queue X (revision N): " at the start of the orchestrator's composer (`putDraft`
tells an open composer) and raises its chat. The orchestrator's message is found in its chat (`draftOf`): the first
message after its last `nexus queue draft` of the queue's file; a draft from stdin or a queue imported by hand has
none, and the line says "imported from" or "proposed" instead. No server change.

## Continue at the stop

A stopped queue goes on from where its stop shows (UX proposals, quick fix 4): the stopped step's line in the queue's
card, the stop's waiting card (in the waiting list across projects, and on the project's page), and the queue's bar.
The reason is shown once per view: on the project's page the stopped step's line carries it, so the waiting card above
names the queue instead (unless the card shows no stopped step: a queue that never ran). Every place, the queue's
drawer and bar included, has one read of what the stopped step left (`useLeft`), one Continue (`useContinue`), both in
`apps/web/src/components/Stop.tsx`, and its buttons, their words and the hint from one pure decision
(`stopDecision`, `apps/web/src/stopDecision.ts`, unit tested), so no two places can disagree. With the
revision approved and nothing to decide, **Continue** lifts the stop at once; when the stopped step left commits of
its own, **Continue…** opens SC2's Keep or Discard in place (the commits, the uncommitted changes, the two choices,
then Continue or "Discard and ask for a revert"); once Discard is recorded no place offers Continue (the server would
ask for the choice again) and each says so instead: approving the orchestrator's revert lifts the stop. A revision not yet approved has **Approve revision N…**, which opens the
queue. What a stopped step left comes from git on the server, which takes a second or more on Windows: the places
showing one stop share one request per queue and version (its times) and show the last answer while reading anew.

## Reviewing: the pictures first, the decision in the viewer

A step that waits for the user's review opens on what to judge (UX proposals, 13 and 14): its summary, what the
orchestrator asks, then its pictures, large, two per row, each with its mark (✓ marked, ⇄ has a before, 💬 comments)
and "k marked"; links and sheets follow as one line of links. The checks are one line of ✓ and ✗ beside three folds,
Goal and acceptance (with what to prepare), Commits · N and Timeline, which open in place. Accept is in the action
bar, under the evidence. The step's other parts (its chat, notes, messages, activity) follow below. Steps that do not
wait for the user keep the usual order.

The viewer has a top bar (‹ back to the step, the picture, "picture 3 of 7" and where, After | Before | After |
Overlay, ✕), a filmstrip of all the step's pictures with their marks and the one shown framed, and the same action bar
as every panel: for the picture on the left its mark and a one-line comment (Enter sends), for the step on the right,
while it waits for the user, the drawer's decision (⋯ with Reject and a note, Fix it…, Accept the step), so the user
decides after the last picture without leaving the viewer. Both bars share one hook (`useReviewDecision`); each keeps
its own open forms, and Fix it's text is the same draft in both. The arrow keys move (not while typing in a box), and
a swipe moves in every view: the picture alone, before and after, and the overlay outside its slider.

## Layout faults (queue PL)

The user decided on 2026-11-15 that layout faults are part of the dashboard's design work, checked on the designs and
the pictures rather than found in use: a dependency line running through a queue's box (seen in the built plan view:
ST2 → ST3 crossed RX's box and read as a chain), boxes overlapping, and text cut short ("Statisztik…").

`scripts/layout-faults.ts` measures them on a page: a mockup file (served with its folder over http, its query kept)
or a development instance's dashboard (`--click` opens the view, e.g. "All queues of Nexus"). The page side
(`collector` in `scripts/capture/faults.ts`) gathers only geometry, so the judging is plain functions with a unit test:

- **Boxes** are `[data-plan-card], [data-box]`; **lines** `[data-edge]` (on the dashboard:
  `section[aria-label='The plan'] svg path`), each sampled every 2 px with `getPointAtLength` and the shape's screen
  matrix. A line with a point inside a box shrunk by 1 px is a fault, so a line ending on a box's edge is not.
- **Text cut short**: an element whose content is wider than it (`scrollWidth > clientWidth`), or taller where its
  overflow is hidden; only the innermost of a chain of ancestors. Found building it: the two are whole pixels, so a
  title 0.2 px too wide is cut with an ellipsis yet equal by them (the plan's "Small fixes from the user's notes of 14
  November" on the phone, 310.1 px in 309.9). The element's own text nodes are measured too, with a Range against
  its content box; its children's are not, since a child may sit in the padding on purpose (the ↩ of a chip, -2 px).
- **Crossings** of two lines are counted but are no fault: fewer is easier to read, and a layout can compare them.

On the plan view of the step's base commit (seed `scripts/capture/seed-plan-nexus.ts`, Nexus's own plan of 15 queues)
it found 6 lines through boxes and 15 titles or reasons cut short at 1440 px, and 9 cut texts at 390 px; on the PL1
mockups (`docs/ux/mockups/22-plan-layout.html`, variants A and B) none.

### The plan view's layout A (queue PB)

The user chose layout A (docs/ux/plan-view-options.md). It is built in `apps/web/src/plan.ts` as a pure function,
`drawPlan(layout, heights, width)`, with no library; `components/Plan.tsx` renders the cards at the column width,
measures their heights, and places them and the lines from the drawing. Decisions and findings:

- The order and the columns are `planLayout`'s, unchanged: the drawing only stacks each column from the top and adds
  gaps, so a queue is where it was.
- A gap goes before the first queue of its column that the line would otherwise run beside (the line's height in the
  column before is above that queue's bottom). On Nexus's own plan this reproduces the mockup's hand-placed gaps
  exactly (MX > RA at the top of Next and Then, ST2 > ST3 before CH, IO > DG before ST3).
- Ports are 10 px apart (less on a short card), sorted by where each line goes or comes from. Between two columns a
  line arriving at the height another leaves at would run along it: the arriving end moves within its card or gap
  (2 px steps) until it is 3 px from every other. Each line that changes height then gets a vertical track of its own
  in the gap between the columns (interval colouring, the tracks spread evenly).
- The arrowhead's tip is the line's end, a pixel before the card (`refX` at the tip, `userSpaceOnUse`): the old marker
  reached into the card.
- Unit tests check Nexus's plan at several widths and card heights and 300 random plans: no stretch inside a card, no
  two lines along each other, no slanted stretch, the order planLayout's.
- Measured with `scripts/layout-faults.ts` on a development instance with `seed-plan-nexus.ts`, the boxes and lines
  limited to `section[aria-label='The plan']`: 0 lines through boxes, 0 overlaps and no text cut short in the plan at
  1440 and 390 px (5 crossings at 1440, the mockup 3). Two cut texts outside the plan are older: the rail's "Running in
  Nexus" title at 1440 and the sessions table at 390.
- A line is clicked through a wider transparent band along it (12 px, `pointer-events: stroke`), drawn after the
  lines; the measured lines are the drawn ones (`svg path[data-edge]`), since the bands would count as crossings.
  The line's details open under the card it comes from, and the plan grows to hold them (the plan scrolls sideways,
  so anything below its box would be cut). On the phone an "after" chip opens them under the card, scrolled into view
  clear of the bottom bar. Dragging is the desktop's.
- The drop target splits only while a queue is dragged over it, into "instead" (a move, every dependency it replaces
  named, done ones too) and "also" (offered only to a queue with a place of its own that does not wait for the
  target already). A drop elsewhere on the card is a move, as before.
- The capture tool drags as the plan view takes it: HTML5 drag events dispatched in the page with one DataTransfer
  (`scripts/capture/drag.ts`), since a headless window cannot be driven to a native drag; React's handlers take them
  as a user's. Its click dispatches the event where an element has no `click()` (an SVG shape).

## Merge back where it waits (queue UF)

Asked by the user on 2026-11-16 (docs/ideas/parallel-worktrees-and-merge-back.md, 2026-11-16): the "Merging back"
waiting item opens the integration step, whose box says "Merge back on the queue's page", without a button and without
a way there; the one Merge into main… is in the queue panel's Worktree section (`WorktreeActions` in
`apps/web/src/components/details/git.tsx`). Designed in UF1 (mockups `docs/ux/mockups/25a-integration-step.html`,
`docs/ux/mockups/25b-waiting-merging-back.html`, compared with captures of `scripts/capture/seed-merge-wait.ts`), built
in UF2: `useMergeBack` in `apps/web/src/components/details/git.tsx` gives the button's question and action to the queue
panel, the integration box and the waiting card (`MergeRow` in `apps/web/src/components/Attention.tsx`); where it is
offered, `mergeBackInto` in `apps/web/src/details.ts`. One recommendation each:

- **On the integration step**: the box (`IntegrationBox`) gets **Merge into main…** under the merge back's state,
  wherever the queue panel offers it (a base branch to name, not merged yet, the queue done, not a survey run). It
  opens the queue panel's question in place, with its text, and posts to the same action
  (`POST /api/projects/:id/queues/:queue/merge`), so it goes through the same judgement, the same lock per queue and
  `merged.by: user`; nothing new on the server. Beside it a link, "Worktree and cleanup: queue W's panel ›", since the
  worktree, the branch and Clean up… stay there. The sentence "Merging back is yours here … on the queue's page" goes:
  the button says it. With `merge_back` on, "Nexus merges it back by itself once nothing holds it" stays, and so does
  the button (a run again past the limit waits for the user's Merge back).
- **From any step to its queue**: the panel's first line (the queue's id and title) becomes a link that opens the
  queue's panel, for every step and on the phone too. Built (UF2) as every switch within the drawer is: the queue
  replaces the step in place, so Back closes the drawer rather than returning to the step ("Back closes the topmost
  layer": switching within a kind replaces the entry), the same as a step opened from the queue's list. Recommended over a link in the integration box alone: the user looks for the
  queue from other steps as well, and the first line is where a breadcrumb is expected.
- **On the waiting item**: a card of kind `merge` gets its way on as a stopped queue's card has Continue: **Merge into
  main…** and **Open** (Open goes to the integration step, as a tap on the card does today). The question opens in the
  card; a refusal shows the server's words there (in red, as the stop's panel does), and a merge clears the item with
  the next state. The same row in the waiting list across projects (the phone's Waiting tab, the right rail) and in
  the project's waiting panel. One hook, as the stop has `useStopActions`, gives the button and its question to all
  three places, so they cannot word it differently.
- **When the button cannot help** (the checkout of main has uncommitted changes, a step is at work there): the button
  stays, and the server refuses with the same reason. Not disabled: the merge back is looked at again only every 30
  seconds, so a disabled button would stay disabled for up to half a minute after the user committed.

Effect on the protocol: no file, event or command changes. The waiting card needs the words of its question (which
branch goes into which base) where it has no queue at hand (the list across projects): the attention item of kind
`merge` gets an optional `merge: { into, branch }`, derived from `git.yaml` and the queue, a change to the state API
only (docs/protocol, the dashboard's state). The alternative, a card saying only "Merge back…", was rejected: a
question that moves a branch says which and where.
