# The chat

Part of [the design](../DESIGN.md).

## Chat-first on a desktop

From 1024 px (UX proposals 11A and 12A, the user's choice after queue UX) the dashboard is a chat app with a
project sidebar. The **sidebar** (`ProjectSidebar` in Projects.tsx) lists every project with its waiting count and a
dot while something runs (from the projects API; the list scrolls, so any number fit), and holds the global status at
its foot: an update going on, the usage windows one per row, notifications, the project's settings, remote access;
"live" or "offline" sits at its top. The **middle column** shows one of three views: the project's **orchestrator
chat** (the view a project opens on), **Ideas** (the conversations, the list beside the open one), or the project's
**queues** ("All queues": its queues, the finished ones, refused actions, sessions; below 1280 px also what waits in
it). Its header (`DeskHead` in Chat.tsx) is the Orchestrator / Ideas switch, what the view says about itself (the
chat's state, model and context, "Tool calls", ⋯ with "New conversation"), and below 1280 px "Waiting N". The chat's text keeps a chat app's measure, at most 780 px wide in the middle; the
orchestrator's and the partner's messages are text under a line saying who and when, Nexus's notices a line with a
rule at the left, the composer a card with Send at its right. The phone keeps its bubbles.

**The view is not a layer.** It is the history entry's `tab`, as on the phone, read through `viewOf(nav, "desk")`
(chat first) and switched by `switchTab(…, "desk")`; `nav.ts` picks the layout by the `PHONE` query and turns opening
the chat or Ideas into a view switch on both layouts. So:

- **Switching the view adds no history entry**, and neither does switching projects. Back closes what is open (a
  conversation, a queue or step, an image, Settings, the waiting list) and then leaves the app.
- **A project switch shows its orchestrator chat** (`switchProject` with the desk layout) and closes what was open.
- **What lies beside the column stays when the view switches.** A queue or step opens on the right (`Drawer beside`,
  no backdrop), in the rail's place (see "The right rail"); switching to Ideas or the queues keeps it open: Nexus
  goes back to the entry below it, rewrites that with the new view and opens it again, so Back still closes it and
  the view stays. A conversation belongs to the Ideas view and closes when another view shows; the Ideas switch with
  a conversation open shows the list again.
- **"Chat about this"** on a step shows Ideas and opens the conversation over it with the step still beside it
  (`openConversation`); Back closes the conversation, then the step.
- A `?chat` or `?ideas` link, or a phone's entry in a window made wide, is read as its view (a phone's Waiting tab
  shows the chat).

The approval's **full view** covers the window right of the sidebar. "Ask the orchestrator…" there turns it into the
compact list on the right (the form remembered for that revision, as "Show as a panel" does) and shows the chat
with the reference in its composer, so the queue and the chat are both in view: the full view used to leave a chat
open beside it its room, which no longer exists as a panel.

## The right rail

From 1280 px (`WIDE`) a rail stands at the right of the chat, 372 px wide as in mockup 11A (`RAIL`, `Rail.tsx`):

- **Waiting for you · N, all projects**: one card, an item a row (`WaitingCards` in Attention.tsx): its kind, where
  it is (with its project's name when it is not the current project) and when, the text in two lines; a stopped
  queue has Continue and Open, as on the waiting list. A tap opens the item in its project.
- **Running in <project>**: the project's queues whose run goes now, running or pausing after its step (`atWork` in
  `apps/web/src/rail.ts`, pure, unit tested; decided 2026-11-14, queue FU, after a planned queue showed here as
  "after CL"), each with its honest status from `queueStatus` as a dot and a few words (`shortStatus`: "1/3", steps
  closed of all, or "pausing"). Everything else is where it belongs: what waits for the user (a question, a review,
  an approval, a stop or failure) under Waiting for you; what waits on its own (a retry, the usage window), what is
  paused and what is planned in the project's queues (All queues).
- **Finished today · N**: the project's queues done or cancelled today, most recent first, with their time
  (`finishedToday`, built on `splitFinished`, so one that still waits for the user is not finished).
- **All queues of <project>** at its foot shows the queues in the middle (pressed while they show).

The rail scrolls as a whole: with many items waiting, what runs and what finished come below them.

**Items open over the rail** (quick fix 10): a queue or step, from the rail, the chat or the queues, is a drawer
exactly in the rail's place, so the chat never moves, and Back shows the rail again. On the queues page the project's
own waiting cards are left out from 1280 px, since the rail shows them. **Between 1024 and 1280 px** the rail folds
into "Waiting N" in the chat's header (N: what waits in all projects): it opens the same rail as a drawer in the
rail's place (the `waiting` layer, so Back closes it), and the column makes room for it, as it does for a queue or
step there, which opens over the drawer. Below 1024 px the phone has its Waiting tab instead.

## Refs in the chat

The ids of the project's queues and steps in a chat message ("SF", "UX2", "W4c", "W / W4c") are links that open
the item, on every screen size: over the rail on a desktop, as a sheet on the phone (`nav.item`, so Back closes it and
the chat is there again). They are drawn as a chip with the item's status dot (a queue's honest status, a step's
own: running, waiting, review, stopped, failed), as in the mockups, in the orchestrator's and the partner's messages
(their Markdown, through a rehype step), the user's messages and Nexus's notices; not in tool lines.

Which words are refs is `splitRefs` (`apps/web/src/refs.ts`, pure, unit tested), against an index of the project's
queues and steps (`refIndex`); nothing else counts, so a word that looks like an id is text unless the project has it:

- An id stands alone: no letter (accented ones too), digit or underscore around it; a hyphenated suffix ("SF-et",
  "W4c-nél") is fine. After `/`, `\`, `.` or `-`, or before a file extension or a path's next part, it is a path or a
  file name ("drafts/SC.yaml") and stays text. Code spans, code blocks and links keep their text.
- "Q/S" or "Q / S" is a ref to the step when S is Q's step; otherwise Q alone is.
- A bare step id is a ref when one queue has that step; when several have it, only "Q/S" links it.
- One-letter ids that are also words at a sentence's start (A, I, O) are refs only as "Q/S": a queue called A would
  otherwise turn every "A" into a link.
- Case matters: "ux2" is not "UX2".

Refs link only within the project whose chat it is; another project's ids ("Honeycomb · W/W4c") stay text.

**Files and commits** (decided by the user on 2026-11-14, queue CH3): a file path with a line
(`apps/server/src/engine.ts:138`, `C:\Code\Nexus\README.md:5`) opens the file viewer at the line (`nav.file`; "The
file viewer"), a commit hash opens the commit's details in a drawer (layer `commit:<hash>`, `?commit=<hash>` at load,
`components/Commit.tsx`). They are not checked against the repository while the message is drawn but when clicked: the
viewer and the drawer say "not found". So only their shape counts (`findFileRefs` in `refs.ts`, unit tested), and it is
kept strict:

- A path ends in a file name with an extension (one letter first), then `:line`, optionally `:column` or `-line` (the
  first line is taken). It may start with a drive (`C:\`, `C:/`), `/`, `./`, `../` or `~/`. A bare file name without
  a folder counts only with a known source or text extension, so `example.com:8080` stays text; times (`12:30`),
  versions, `localhost:4317` and `127.0.0.1:4318` have none. A path without a line stays text, as decided.
- A hash is 7 to 40 lowercase hex digits with at least one digit and one letter ("defaced", "1234567" stay text), not
  after `#`, `0x`, `/`, `.`, `-` or a letter, and not the first part of a UUID.
- Nothing inside a URL (`scheme://…`, `www.…`) counts, and both may take a Hungarian suffix after a hyphen
  (`engine.ts:138-ban`, `13118f1-ben`).
- In Markdown, an inline code span that is wholly one file or one commit (`` `src/files.ts:40` ``) is a link too, since
  agents write paths that way; code blocks and links keep their text.

They are drawn as plain links (accent colour, dotted underline), not chips: they carry no status. Relative paths are
the project root's (the endpoint's rule), so a worker's path relative to its own worktree may say "not found".

## The morning digest

"Since you last looked" (UX proposals 16, quick fixes 5 and 9; `Digest.tsx`) sits at the top of the right rail on a
desktop (in the folded rail's drawer between 1024 and 1280 px) and at the top of the Waiting tab on the phone. The
time is stored per device (`nexus.digest.seen` in local storage; the first time, a day ago). The digest shows when
something is new after it, a line of what happened or an item that came to wait (`hasNews`); "Mark as seen" stores now
and folds it until something new comes. It crosses projects through one small read-only API, `GET /api/digest?since=`
(PROTOCOL.md): steps done or failed, stops, queues done or cancelled with their report, refused actions and retries
(one line per step with how many); fetching each project's state would have missed the last two, which live in each
session's refusals and activity, and taken a request per project. It has, in a 372 px column:

- a greeting and the time it counts from; **Mark as seen**;
- **four numbers** (`digestTiles` in `apps/web/src/digest.ts`, pure, unit tested): steps finished (and queues done)
  and queues stopped since the time, then what waits now (by kind) and what runs now (the first with how long it has
  been at its step; by the rail's definition, `runsNow`, so a run waiting for a retry or the usage window is not
  counted: queue FU);
- **what happened, newest first**: time, the step or queue, the outcome in a word or two with its colour (`outcome`:
  "done", "stopped at W4c", "queue done", "2 refused actions", "retried twice"), its words and project; six lines,
  the rest one click away; a tap opens the item, a finished queue's report has "report ▸";
- **Go through them one by one**, when something waits. The waiting list is the one under the digest (the rail's, the
  Waiting tab's), not a copy.
- **the usage line** at its foot (decided 2026-11-14, queue FU; `usageLine` in `apps/web/src/digest.ts`, the numbers
  from `usageSince` in `packages/protocol/src/digest.ts`, both unit tested): "Usage: 5-hour window peak 82%, 7-day
  window now 41%, no waits" (or "2 waits (1 h 5 min in all)"). Its sources are the turn records (`turns.jsonl`) since
  the time: the peak is the highest 5-hour utilization a turn ended with, the 7-day value the latest one (the higher
  of Claude's and Codex's when both reported one); a wait is a turn that ended on a usage limit (until its session's
  next turn, or now while its run still waits) or a run in `usage_wait` now that no such turn explains (from when it
  began). A threshold wait that is already over leaves no record and is not counted. With no turn in the period the
  line says "no agent turns".

**One by one.** The button opens the first waiting item (newest first, as the list) and starts a round in App: once
the item open no longer waits (an answer, an acceptance, an approval, Continue), the next one opens in its place
(`moveOn` in `waiting.ts`, on `waitingPosition`: the first that still waits; an item still waiting at the same place,
such as a review after an answer, keeps it open). Closing the item, opening something else by hand, or the end of the
list ends the round. On the phone the sheet's "2 of 6 waiting" counts along.

## Drafts stay in the browser

Unsent text in the dashboard's boxes is kept in `localStorage` (`nexus.drafts`: one map from a target key to the
text and when it was last touched), not in `.nexus/`: a draft is the user's half-typed thought on one device, the
server has no use for it, and keeping it out of the files keeps "one writer per file" and the files' meaning intact.
The key names the project and the target (`<project>/orchestrator`, `/conversation/<id>`, `/message/<queue>/<step>`,
`/note/<queue>/<step>`, `/answer/<qid>`, `/approval/<queue>`), each part URI-encoded. `Composer` is keyed by it, so
moving from one step or conversation to another remounts the box with that target's own text instead of carrying
the text across. Drafts untouched for 14 days are pruned when the page loads.

## Each chat keeps its place

Decided by the user on 2026-11-14 (queue CH1). The chats are views (the desktop's middle column, the phone's tabs), so
switching unmounts one and mounts the other; each chat, the orchestrator's and every conversation, now keeps its place
in the browser's `localStorage` (`nexus.place:<project>/orchestrator`, `…/conversation/<id>`, like the drafts' keys;
`sessionStorage` until queue FU, which the user moved so the place outlasts a reload and a closed tab; another tab's
change reaches the unread markers through the storage event): the entry at the top of the view (its index in the whole chat, tool lines included, so showing or
hiding them keeps it) and how far past it, whether the view was at the end, and `seen`, the time of the latest entry
that has been in view. The rules are pure (`apps/web/src/chatPlace.ts`, unit tested); `usePlace` in Chat.tsx applies
them:

- **Opening waits for the chat to load** (`ready`: the fetched view is this chat's, not the one shown before), then
  goes to the place, or to the newest message when there is none (the first time in this session, or a chat started
  over and now shorter than the place).
- **Messages that came while away do not move the view**: they are below it, and a "N new ↓" button (messages of
  others after `seen`, not the user's own, not tool lines) jumps to the first of them.
- **While the chat is open and at its end, new messages keep it at the end**; scrolled up, they are counted by the
  button instead. Sending a message goes to the end.
- **Unread markers** come from the same state: a count on the orchestrator's side of the switch and on the phone's
  Orchestrator tab ("Orchestrator 2"), a dot on Ideas when any conversation's last entry is newer than its `seen`, and
  that conversation's dot in the list. A chat not opened in this session has nothing unread: it opens at its newest.

## Quoting in a chat

Decided by the user on 2026-11-14 (queue CH1; docs/ideas/chat-improvements.md). Two ways to quote a message into the
chat's box, both through `withQuote` (`apps/web/src/quote.ts`, pure, unit tested): the quote (`> ` on every line, a
bare `>` for an empty one) goes at the end, after any draft and a blank line, and a blank line follows it; the box
takes the focus with the cursor at the end, so the answer starts below the quote (`putDraftAndFocus` in drafts.ts,
which the open `Composer` hears).

- **A selection** in the messages shows a small floating **Quote** button (`QuoteSelection` in Quote.tsx, in a portal,
  fixed): on a desktop beside the selection's end (below its last line when there is no room beside it), on the phone
  below the selection, clear of the system's menu above it, and 44 px high. It keeps the selected text when it shows,
  so a tap that clears the selection still quotes it. **Alt+Q** does the same (Ctrl+Q and Cmd+Q close browsers on some
  systems). It hides when the selection leaves the chat's view. The browser's right-click menu is not touched.
- **Reply to this**: hovering a paragraph or a list item of a message (on a phone, tapping it) shows an icon at its
  right edge (`Replyable`, the Markdown's `p` and `li`); only the innermost hovered item shows one, and a list item's
  own paragraphs have none. A click quotes the item's **Markdown source**, not its rendered text: `sourceAt` cuts it
  from the message by the position react-markdown gives the node, and a nested item loses its own indentation, so
  "  - two steps\n    - SC1" quotes as "- two steps\n  - SC1". The test parses with mdast-util-from-markdown, the
  parser react-markdown uses, so the positions are the real ones.

## Long replies and message actions

Decided by the user on 2026-11-14 (queue CH4; docs/ideas/chat-improvements.md): a long reply gets a small table of
contents from its headings, and a "jump to the questions" button when it asks the user to decide; every message can be
copied as Markdown, every code block has a copy button, and every message shows its time. "Asks the user to decide" is
recognized from the text, with no new protocol: a heading with "Kérdés" or "Question" in it or ending in "?".

How it is built (`apps/web/src/messageTools.ts`, pure and unit tested; `components/MessageTools.tsx`): the reply is
parsed with mdast-util-from-markdown, the parser react-markdown uses, so the source lines it finds are the ones the
rendered elements carry (`data-md-line` on headings, paragraphs and list items, set in ChatMarkdown); Contents and the
jump scroll to that element (below the sticky line, `scroll-margin-top`) and flash it. Without a question heading, the
first paragraph or list item that asks ("…?", "Question: …") is where the questions start; code and quotes never are.
Copy puts the message's text on the clipboard as it is in chat.jsonl; over plain http (remote access on the home
network), where the Clipboard API is missing, a hidden text area and the copy command do it. Smaller choices made while
building, not by the user, for the orchestrator's review: a reply is long from 1500 characters, Contents needs two
headings or more, and both live on the reply's line, which is sticky (on a desktop the line over the reply sticks to
the top of the chat; on the phone the line under the bubble, with the time, sticks to the bottom), so they are in
reach wherever the reply is read; Copy shows on hover on a desktop and always on the phone; the time is the clock time
("14:02", with the date on another day; the full date on hover), also over the agent's replies and on Nexus's
notices, which showed "5 min ago" before. Finding from building: a sticky element sticks at the scroller's padding edge, so the chat's space at its ends
moved from the scroller's padding to its content; otherwise a strip of text scrolled past above the sticky line.

## Search in a chat, and pinned messages

Decided by the user on 2026-11-14 (queue CH4; docs/ideas/chat-improvements.md): search covers the whole chat, not only
what is loaded; a pin is keyed by the session and the line index in its append-only chat.jsonl, stored by the server in
`sessions/<id>/pins.json` (one writer), and a fresh orchestrator session starts without pins. The files and the API
are in PROTOCOL.md.

How it is built: `readJsonl` gives every entry its line (blank and broken lines counted), and the chat views send each
entry with it, so the dashboard keys entries, pins and matches by line, which never changes. The views still send only
the newest 300 (orchestrator) or 400 (conversation) entries; when a match or a pin is older, the chat loads the lines
from it up to the view's first (`GET …/sessions/:session/chat`) and puts them before (`useOlder` in Chat.tsx). Old
entries never change, so they are fetched once; when the view's window moves past them, the gap is filled. The search
runs on the server over every line (`searchChat` in `@nexus/protocol/chat`, pure and unit tested, shared with the
dashboard's `matchRanges`), a quarter of a second after the typing stops. Matching ignores case and accents ("kerdes"
finds "Kérdés"), on the message's Markdown source; the marks are put into the rendered text (a rehype step in
ChatMarkdown, and `Marked` for plain text), so a match that runs across formatting is counted but not marked.
Smaller choices made while building, not by the user, for the orchestrator's review: next and previous go from
message to message (all of a message's matches are marked, the current message's stronger), starting at the newest,
with "3 of 12" counted in chat order; tool lines are searched only while the chat shows them; the pins bar shows the
two most recently pinned and the others behind "N more pinned", each as who, when and the message's first words
(`excerpt`); the pin button sits beside Copy, and only a message (not a tool line or a notice) has one.

## Stopping a chat agent's turn

Decided by the user on 2026-11-14 (queue CH4; docs/ideas/chat-improvements.md): a stop button while a chat's agent is
working; a pure interrupt (Claude's interrupt control, Codex's turn/interrupt), not a message asking to stop; no text
from the stopped turn is added after it, the chat shows "stopped", the process goes idle, and user messages sent during
the turn and not yet delivered go in with the next turn. The protocol details are in PROTOCOL.md ("Stopping a chat
agent's turn").

Findings from building (probed live with haiku and gpt-6-luna, a few cents): Claude Code still writes the partial text
after its interrupt, and runs the `next` messages it had not read as a new turn right away, so on its own the process
would not go idle; Codex drops a steered message it had not taken in. So the stop lives in the adapters
(`AgentProcess.stop`): while it settles they emit no text, the Claude adapter interrupts the CLI's own follow-up turn and
holds new messages, and the Codex adapter carries what the turn never took in (it reports what it took in as
`userMessage` items). The roles only check that a turn runs and add the notice. Smaller choices made while building,
not by the user, for the orchestrator's review: the button sits above the message box on the right, shown only while
the agent works ("Stop", "Stopping…" once pressed); "Stopped." is a Nexus notice like the others; there is no
confirmation (a stop loses nothing that was written); a stopped hand-over of a conversation hands nothing over.

## Pictures in a chat message

Decided by the user on 2026-11-14 (queue CH2; docs/ideas/chat-improvements.md): pictures go into a chat message by
pasting, by dropping them on the chat, or with an attach button, in every chat composer (the orchestrator, each
conversation, the phone); PNG, JPEG, WebP or GIF up to 10 MB, judged from the bytes; a refused file shows "only PNG,
JPEG, WebP or GIF up to 10 MB" in the composer; the message gets the picture's absolute path on its own line; uploads
are kept. The upload and the runtimes are in PROTOCOL.md (["Uploads"](../protocol/api.md#server-api), and how Codex gets an image item).

How it is built (`apps/web/src/pictures.ts`, pure and unit tested; `components/Pictures.tsx`): `ChatColumn` holds the
pictures of its draft (`usePictures`) and hands them to the `Composer`. A picture is checked in the browser first (its
first bytes and its size, the server's rules), so a HEIC photo is refused without uploading it, and uploaded at once;
its thumbnail sits above the box, dimmed while the upload runs, with ✕ to remove it, and Send waits for running
uploads. A picture alone is a message (no text needed). The paths are kept beside the draft's text (the drafts'
store, key `<draft>/pictures`), so they survive a reload like the text. A paste that carries plain text stays a text
paste even when the clipboard holds an image too, since Word and Excel put a picture of copied text beside it. The
message is the text, an empty line and the paths, one per line (`withPictures`); a sent message shows its path lines
as the pictures below its bubble (`splitPictures`), served by the file endpoint, and a click opens the picture in a
new tab. Smaller choices made while building, not by the user: the paths surviving a reload, the click opening a new
tab rather than the review viewer, and the plain-text rule for pastes.

## Speaking into a chat

Decided by the user on 2026-11-14 (queue BI; docs/ideas/backlog-smaller-items.md): a microphone in every chat's box,
only where the browser has speech recognition (the Web Speech API: Chrome, Edge, Safari; not Firefox); it listens in
the reader's language as a BCP-47 tag, else the browser's language; what it hears goes into the box and is never sent
by itself; tapping it again or a silence stops it. Chrome and Edge send the sound to their maker's servers, so the
first use says so in a line under the box.

How it is built (`apps/web/src/voice.ts`, pure and unit tested with a fake recognition class; `components/Voice.tsx`):
`recognitionOf` finds `SpeechRecognition` or `webkitSpeechRecognition`; without either `useVoice` returns nothing and
no button is drawn. A `Dictation` runs one utterance (`continuous` off, interim results on): final text goes to the
draft through `useDraftText`'s `append` (after the text as it is then, a space between), interim text shows under the
box. The reader's language reaches the box through the page context (`page.ts`, the current project's effective
setting); `voiceLanguage` keeps the browser's region when it has one for that language ("en" with an en-GB browser:
en-GB), else uses a usual one (hu-HU, en-US…). Only the chat layouts (the card and the phone's line) show it; the
forms' plain boxes do not. Headless Edge has `webkitSpeechRecognition`, so the capture shows the button as it is; the
listening state is captured with `scripts/capture/fake-speech.js`, loaded through a view's `script` before the
dashboard. Smaller choices made while building, not by the user: the regions, en-US for English, a stop square on a red
button while it listens, and the notice remembered per browser (localStorage `nexus.voice.noticed`).
