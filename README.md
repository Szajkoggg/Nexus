# Nexus

A local dashboard and orchestrator for AI-driven development. Nexus shows each project's queues of work, drives
Claude Code and Codex sessions through them step by step, and carries notes, messages and questions between the
user, a per-project orchestrator agent and the working agents.

- [docs/DESIGN.md](docs/DESIGN.md): concepts, architecture, decisions, phases
- [docs/PROTOCOL.md](docs/PROTOCOL.md): the `.nexus/` files, events and the `nexus` CLI

**Ideas.** Beside the orchestrator, each project has conversations with a thinking partner (the bulb icon): one
session per topic, for thinking something through (gameplay design, the look, what to build next) without starting
any work. A partner reads the whole project and writes only in the project's notes folder (settings: "Ideas"), so it
can record what you decide; "Hand to orchestrator" (under ⋯ in the conversation) has it summarize the conversation
into the orchestrator's chat, which turns it into queues. **Compact** (also under ⋯) has the partner's runtime
compact a long conversation: it replaces what the partner holds of the conversation so far with a summary, so it has
room to go on in the same conversation. The chat keeps every message and says when it was compacted; details the
summary leaves out are no longer in the partner's context. It waits for the partner's turn to end.

**What became of the ideas.** The Ideas panel's switch at the top (**Conversations** | **Overview**) shows the notes
the partners keep, grouped by area and the project's sub-groups (each note's `**Area:**` line; a note without one is
under Unsorted). Each dated decision separates its disposition, linked work and your implementation assessment.
**Linked work finished** means the associated work finished; full implementation still needs your explicit review
of the entire date. Old **built** data does not supply that confirmation. Filters and counts use the same effective
state as the entry, including **Needs attention**. The overview keeps its search, filter and scroll position on Back.

Open a note for **Summary**, expanded **Open** questions, **Decided** dates and a closed **Related work** section.
Each date has **Change status** (or **Review implementation**) and **History**. You can drop, replace, reopen,
assess partial/full implementation, revoke an assessment and undo an action with a reason. A replacement selects
an existing note/date. These decisions do not start, stop or approve queues, and do not edit the note. Changes to
the dated decision, effective links or accepted work make earlier assessments need review; Summary/Open edits
alone do not. The note shows the least advanced active date; previous decisions and handovers remain in history.
Expand Related work for short, explicitly scoped outcome excerpts and **Full report**, with provenance below them.
An outdated or unverifiable report excerpt is labelled; completion and confirmation do not prove deployment.

**Manage links** is always available on the overview and note, even with no pending suggestions. Search for a
queue or note, add a missing link to a selected date, decide a historical suggestion, change its target or remove
it. Each operation affects one origin: rejecting a historical match leaves an independent queue source intact;
use **Ignore source** or **Correct source** for that origin. **Correction history** records before/after, reason
and undo. Missing targets retain their identity and a visible diagnostic. Reference labels describe syntax, not
proof of implementation. A failed save retains your draft; **Retry the same save** is safe after an uncertain
response. **Refresh and review** loads concurrent changes before a new decision.

The [tested MT/IO/ST2 correction guide](docs/ux/ideas-corrections-guide.md) identifies the exact origins and dates
to review; it changes no real data. `nexus ideas matches` and `nexus ideas status` let agents read effective links,
dispositions, assessments, conflicts and history as JSON. Server-owned user decisions supplement the note;
agents read both and cannot make those decisions.

**Continue from an idea.** On a note or one dated decision, **Chat about this** always opens a new, empty
conversation with that exact scope. Opening it makes no model request. The first message carries the Summary,
selected Decided content, effective status and separately labelled Open/Ideas; relevant changes refresh that
context on later messages. Back returns to the note and its saved position. **Conversations and handoff history**
opens earlier chats individually, including archived ones; restore an archived chat before sending. If its note
or date disappears, the chat remains readable and shows why a new scoped request cannot be sent.

**Hand to orchestrator** opens a preview without needing a chat. Choose exact dates and **Discuss / plan next
work**, or deliberately select **Context only**. Fully confirmed, dropped and replaced dates are context only;
reopen them explicitly before requesting new work. Open/Ideas stay undecided. Add your instruction, refresh the
preview after changes and inspect **Exact message** before Send. An idea chat's handoff menu opens this same
scoped preview, independently of any running reply; ordinary unscoped chats retain their summary-based handoff.
**Delivered to orchestrator** means the exact snapshot is durably queued and visible at **View message**. It does
not mean read, implemented, approved or started, and does not change a start plan or lift a start prohibition.
An uncertain response or failed delivery can be retried with the same saved ID, including after reload or restart.
History retains the payload, selected dates, status at send, time and failed attempts. A delivered message cannot
be unsent: a correction is a separate, explicitly reviewed handoff.

For synthetic browser verification, build the web workspace and run
`node scripts/verify-ideas-onward.ts <temporary report directory>`. It captures the nine idea/chat/handoff scenes,
checks layout and exercises scoped requests, lost responses, reload, restart and Back using its own fake projects.

**The web in Ideas.** Settings → "Ideas (conversations)" → **Web** (global, or the project's own): **off**, **web
search** (the default: partners search and name their sources, but open no page) or **web search and reading pages**.
Reading pages carries a risk: a page can hide instructions that lead a partner to put something from the project into
an address it opens, and so send it out. In every level, pages on this machine and its network are refused, and what
a partner takes from the web is quoted with its URL in its notes and hand-overs. A change applies from a
conversation's next message.

**Chat about a step.** Every step, in every state, has "Chat about this": it opens the step's latest conversation (an
archived one does not count) or starts one, and "New conversation" beside it starts another. The partner gets the
step's context with your first message: its goal, acceptance criteria and notes, its progress while it runs, and its
summary, checks, review material, commits and reason once it has an outcome. When the step's state changes later, the
next message tells the partner what changed. Talking changes nothing in the run: a step in review keeps waiting for
you. The step lists its conversations, and a conversation shows its step ("about step W/W3"), a link back to it.

**Back.** The back button (on a phone also the back gesture) closes what is open on top: a conversation, Settings, a
queue or step, a review image, the waiting list. Switching between the orchestrator chat, Ideas and the queues, and
switching projects, are not steps for Back. With nothing open it leaves Nexus. Escape does the same on a computer.

**On a computer** (a window of 1024 px and more) the projects are in a sidebar on the left, each with what waits for
you in it and a dot while something runs; any number fit, the list scrolls. At its foot: an update going on, the
usage, notifications, the project's settings and remote access; "live" at its top says whether updates arrive. The
middle is the conversation: clicking a project opens its orchestrator chat. The chat's header switches between
**Orchestrator**, **Ideas** (with how many conversations there are) and **Stats** (the project's metrics, below); "Tool calls" shows the tool lines, ⋯ has "New
conversation". On the right, from 1280 px, a rail lists what waits for you in all projects (a stopped queue with
Continue right there), what runs in the project with one honest status each ("1/3", "review", "after SF"), and what
finished today; **All queues of <project>** at its foot shows the project's queues in the middle. In a narrower window
the rail is folded into **Waiting N** at the right of the chat's header. In the chat, the project's queue and step
ids ("SF", "UX2", "W / W4c") are links with the item's status dot: a click opens the queue or step (on a phone too).
When something happened since you last looked on this device, the top of the rail (on a phone, of the Waiting tab)
greets you with four numbers (steps finished, queues stopped, what waits, what runs), what happened newest first across
projects (outcomes, reports, refused actions, retries) and **Go through them one by one**, which opens the first waiting
item and the next one by itself after each answer or decision; **Mark as seen** folds it until something new comes. A queue or step opens on the right, over the
rail, and the chat stays where it is and usable: switching to Ideas or the queues keeps it open, and "Chat about this" opens the
conversation in the middle with the step still beside it. A queue waiting for approval opens in full beside the
sidebar; "Ask the orchestrator…" there turns it into the panel on the right and puts the queue's reference in the
chat's box.

**On a phone** (and in any window narrower than 1024 px) a bar at the bottom has five tabs: **Orchestrator** (the
chat), **Waiting** (what waits for you in all projects, with the count), **Queues**, **Ideas** and **Stats**. One tap switches.
The top line has the project picker, what runs in the project, and the settings gear; the update, the usage,
notifications and remote access are in Settings there. Switching tabs is not a step for Back: Back closes what is
open (a step, Settings, a conversation) and then leaves. After switching projects the Waiting tab shows. A step or
queue opens as a full-screen sheet with ‹ and ✕ at the top and says where it stands ("2 of 6 waiting"). A question's
options are buttons right in its waiting card: a tap opens the question with that option chosen, and **Answer**
confirms it (words of your own can go with it). The option the worker, or the orchestrator passing the question to
you, recommends is marked: ✓ on its button in the card, "recommended" beside it in the question (on a desktop, in the
question's list of options). The chat's box is one line with a round Send.

**Each chat keeps its place** while the browser is open: switching between the orchestrator, Ideas and other views,
or between conversations, brings you back where you were. Messages that came meanwhile do not move the view; a
**"N new ↓"** button jumps to them. A chat opened for the first time opens at its newest message. The switch (on a
phone the bottom bar) shows what you have not read: "Orchestrator 2", a dot on Ideas and on the conversation in its list.

**Quoting.** Select text in a chat and a small **Quote** button appears beside it (on a phone below it); a click, or
**Alt+Q**, adds it to your message as a quote, after what you had typed, with the cursor below it. Hovering a
paragraph, a list item or a table of a message shows a **reply** icon at its right edge: one click quotes that item
as it was written (its Markdown).

**Tables.** The chats and the dashboard's texts (goals, descriptions, notes) show GitHub's Markdown: tables,
~~strikethrough~~, task lists, and bare web addresses as links; a table wider than the window scrolls sideways on its
own.

**Long replies and copying.** Every message shows its time. A long reply with headings has **Contents** on its line
(over it on a desktop, under it on a phone), a menu of its sections; when it asks you to decide, **Jump to the
questions** goes to them. The line stays in sight while you read the reply. The copy icon copies a message as it was
written (its Markdown); on a desktop it shows when you hover the message. A code block has its own copy icon at its
top right.

**Search and pins.** The magnifier in a chat's header searches the whole chat, also what is older than what the chat
shows: the matches are marked, the newest first; ↑ (Enter) goes to older ones, ↓ (Shift+Enter) to newer ones, Esc
closes. The pin beside a message's copy icon pins it to the top of the chat (on a desktop it shows on hover; a pinned
message's pin stays, filled): the two most recently pinned show there, the others behind "N more pinned"; a click goes
to the message, ✕ unpins it. Pins belong to the conversation: a new orchestrator conversation starts without them.

**Searching the whole project.** **Search history…** in the project's header (Ctrl+K on a desktop; the magnifier at the
top on the phone, where it opens full screen) searches everything the project has recorded: queues and their goals,
step outcomes, questions and answers, the orchestrator's and the thinking partners' chats, reports, review comments and
step notes. Case and accents do not matter; with several words, each must occur. The hits come newest first, each with
its kind, its place, its time and the words marked; the chips above them keep one kind, and **Tool calls** adds the
chats' tool calls. A click goes to the hit's place: a step's or queue's details, the chat scrolled to the message (an
older orchestrator session's message only while the chat still shows it), a report in the file viewer. The search
opens again with your last query.

**A fresh orchestrator session.** The orchestrator's long chat is not compacted. When its context is fuller than its
threshold (85 % by default: "Fresh session at" in the settings' Orchestrator section) at the end of a turn, Nexus asks
it for a summary of the decisions, open items, the plan and what it promised you, and goes on in a fresh session that
starts from that summary, its current briefing and the project's state. You need do nothing: a message you send
meanwhile waits for the fresh session. The chat stays one chat: the earlier session's messages stay above a **Fresh
session** line, which says how full the old context was; **Show its summary** opens what it wrote, and **summary.md**
opens the file it is kept in (`.nexus/orchestrator/summary.md`, the latest one). Search and pins cover the current
session.

**The orchestrator on Codex.** The settings' Orchestrator section (global, or a project's own) chooses its
**Runtime**: Claude Code (the default) or Codex; the model and effort lists follow it, and a change of runtime clears
them. A new runtime takes effect with the next message: the orchestrator goes on in a fresh session on it (a
conversation cannot move between the two), which starts from its briefing and the project's state; the earlier chat
stays above. The line under the choice says how the protection differs: on Codex a sandbox lets it write only its
queue drafts and its own event log, but its shell runs any program, and a program can reach Nexus on this machine and
do what you do in the dashboard, which Claude Code's orchestrator cannot. Until that gap is closed, keep it on Claude
Code.

**An orchestrator fallback.** In the same Orchestrator section, **Runtime**, **Model** and **Effort** choose the
primary. **Fallback** chooses one backup, with its own runtime, model and effort; by default there is none. These
settings can be global or the project's own. When the primary reaches the project's usage threshold, Nexus switches
to the backup between turns, then returns after the primary's window resets. The chat says which window caused the
switch and when it resets. Different runtimes start a fresh session with the latest saved context summary, current
briefing, project state and waiting messages; earlier chats stay readable. If there is no saved summary, the chat
says so. If both runtimes are full, messages and notices wait. Two models of the same runtime share its quota, so
that fallback waits too. Codex has the same protection limits whether primary or backup; selecting a backup does
not change the primary setting.

**Stop.** While the orchestrator or a thinking partner is in a turn, **Stop** shows above the message box. It
interrupts the turn at once: the chat says "Stopped.", nothing more of that turn appears, and the agent waits. What
you sent during the turn goes in with your next message.

**Pictures.** Paste a screenshot (Ctrl+V), drop a picture on the chat, or use the paperclip beside the box, in the
orchestrator's chat, in a conversation and on the phone. PNG, JPEG, WebP or GIF up to 10 MB; anything else (an
iPhone HEIC photo, say) shows "only PNG, JPEG, WebP or GIF up to 10 MB". The picture shows as a thumbnail above the
box (✕ removes it) and goes with your message; a picture alone is a message too. The agent gets its path and opens
it; the chat shows the picture, and a click opens it full size. Pictures are kept in the project's
`.nexus/uploads/`.

**Speaking.** Where the browser recognises speech (Chrome, Edge, Safari; not Firefox), a microphone beside the
message box lets you speak instead of typing, in the orchestrator's chat, in a conversation and on the phone. It
listens in the reader's language (Settings, "Reader's language"; without one, the browser's), shows what it hears under
the box, and stops at a pause or when you tap it again. What it heard goes into the box after what is there; nothing
is sent until you send it. Chrome and Edge recognise speech on Google's and Microsoft's servers, so the sound goes
there; the first use says so. The browser asks once for the microphone; on the phone this needs the https address
(Tailscale Serve, below).

**A queue** on the project page shows one status ("running · SF3", "paused · B2", "stopped at W4c", "waiting for
your review · UX2"…), a progress line with a segment per step, and its steps one line each, in two columns on a
computer. "Running" means a run is really at work; a queue whose run is paused says so. The step that matters is
highlighted with why and its action (**Continue…**, **Review…**, its questions). On a phone the list is one column, the
finished steps before it and the steps after the next three are folded into one line each; a tap unfolds them.

**One action bar.** Every queue and step panel ends with the same bar, always in sight however long the panel is:
the main action on the right (Accept and go on, Approve revision N, Continue, Answer), the second left of it (Fix
it…), and everything else under ⋯ (Reject, a note with the acceptance, your words with an approval, Withdraw
approval, the queue's review level). What an action needs (Fix it's text, a reason) opens just above the bar.
The header says where you are, what it is and its status, with ✕ at the top right. A conversation in Ideas has its
actions under ⋯; the orchestrator's "New conversation" (which makes it start over) is under the chat's ⋯.

**Reviewing a step** opens on its summary and its pictures, large, two per row, with your marks; the checks, the
goal and acceptance, the commits and the timeline are one line below, folded. A picture opens in the viewer: full
screen, two fingers to zoom (double-tap on a computer), swipe, the arrow keys or the filmstrip at the bottom to move
between the step's pictures; "Open the original" under ⋯ opens the file in a new tab. Review material that is no picture
(a report, a table, notes) opens in the same file viewer (below), formatted; Ctrl+click opens it in a new tab, and the
viewer's **Raw** link shows the file itself. A picture with a "before" (the
same label in an earlier round, or one the worker named with `--before`) can be seen beside it or overlaid with a
slider. The viewer's bar: **✓ Mark this picture** (a mark for that picture only; it does not accept the step) and a
comment (Enter sends it), which goes back to the worker as a Fix it while the step waits for your review, and
otherwise becomes a note on the next pending step; on the right the step's own **Fix it…** and **Accept the step**, so
you can decide after the last picture without leaving the viewer.

**Finished queues** (done or cancelled) are no longer cards in the list: they fold into one line at the bottom of
the project page, "Finished (N)", closed until you open it (the browser remembers that, per project). Open, it lists
one compact line per queue, the most recently finished on top, with when it finished and how long it ran; tap one
for its details. A finished queue that still waits for you (a step in review, an open question) stays in the list
above until nothing waits.

**Approving a queue.** On a desktop a queue that waits for your approval opens in a full view, from its waiting
item and from the queue: every step's goal and acceptance in one scroll, an outline on the left that follows it and
jumps on a click, the run settings on one line under the title (steps, branch, what it starts after, runtime, model
and effort, what happens after each step, the steps on their own runtime or model), and who proposed it, with the
orchestrator's message one click away ("▸ its message"). **Approve revision N** is in the action bar, beside what it
pins; Ctrl+Enter approves too. **Ask the orchestrator…** opens its chat with "About queue X (revision N): " at the
start of the composer, the full view still beside it. On the phone, and in the queue's panel, the same approval is a
compact list: one row per step with its goal's first lines and "N criteria ▾" to open the whole goal and its
acceptance in place, and the description, stop conditions, checks and the orchestrator's message as folds. "Full
view ⤢" and "Show as a panel" (under ⋯) switch between the two. A stopped queue's new revision shows its stop box with
Keep or Discard first: Approve waits for the choice.

**The closing refactoring step.** A queue that contains coding (the orchestrator marks it) ends with a step Nexus adds
and keeps: **Closing refactoring**, tagged "⟲ by Nexus" (hover the tag for what it is). It shows after the queue's
steps wherever they are listed: in the approval (its own framed section in the full view, with a line on what it is),
in the queue's card and in the step list, where the ⟲ mark stands in for its id (`<queue>.refactor`). You approve it
with the queue, and may set its review level (2 by default). It runs last, in a fresh session over the queue's
commits, also again after steps a later revision adds, and it writes the queue's report; it may find that nothing is
worth refactoring. Agents cannot skip it. You can: when you Continue a stopped queue whose closing step has not run,
the queue's bar has a checkbox **Skip the closing refactoring** beside Continue, and when you approve a stopped
queue's new revision the same checkbox stands beside Approve (in the queue's bar and in the full approval view); the
skip is recorded with the stop's reason.

**Withdrawing an approval.** A queue approved but not started yet has "Withdraw approval…" under ⋯ in its bar (with
an optional reason): it goes back to proposed and waits for your approval again; the earlier approval stays on record.
Once a queue has started, pause or stop it instead. Only you can do this, from the dashboard.

**Drafts.** Text typed but not sent (to the orchestrator, in a conversation, to a running agent, a step's note, an
answer, the words with an approval) stays in its box when you close the panel, open something else, switch project
or reload, also when a phone's browser drops the tab. Each box keeps its own text; sending clears it, a failed send
keeps it. Drafts live in that browser only (not on the server, not on your other devices) and are dropped after 14
days untouched.

**Themes.** Settings (the gear icon), Global, "This browser", Theme: **Graphite** (dark, the default), **Paper** (light),
**Honey** (warm dark), or **Follow the system** (Paper when the system is light, Graphite when it is dark, changing
with it). It applies at once and is kept in that browser only, for every project; your phone and your PC each keep
their own.

**Files and commits in the chat.** A file path with a line in a message (`apps/server/src/engine.ts:138`) and a commit
hash (`13118f1`) are links. A file opens in the dashboard's own read-only viewer at that line: code highlighted,
Markdown rendered, JSON indented, CSV (and TSV) as a table with its header (the first 1000 rows; the rest in the raw
file), each with **Source** beside it; YAML highlighted; pictures in the picture viewer; it works on the phone too
and starts no program. Opened at a line, JSON and CSV show their source, where the line is. A commit opens
its subject, author, date and changed files. Both are checked when you click: "not found" if the file or commit does
not exist. On the PC Nexus runs on, the viewer has **Open in editor**, which opens the file at the line in your
editor through its link scheme: Settings, Global, "This browser", Editor: **VS Code** (the default), **Cursor**,
**JetBrains** (through the JetBrains Toolbox App, for files inside the project), or **None**. Kept in that browser
only; on another device the link is not shown, since the path would point nowhere there.

**Status: phase 6** (remote access). Nexus can be used from a phone while the PC is on: through Tailscale (your own
devices only, no open ports), signing in once with an access token (a QR code on the PC does it), installable as an
app, with push notifications when something waits for you. See "Remote access" below.

Phase 5 (Codex adapter): Runs can use Codex as well as Claude Code: the runtime is chosen per run (or
by the project's default), and everything works the same way: step turns, notes, messages into the running turn
(`turn/steer`), questions, stop and resume, continuing a session's thread, context fill and the Codex usage window.
Needs the Codex CLI (`npm i -g @openai/codex`), signed in with `codex login`.

Phase 4 (orchestrator chat): Each project has an orchestrator in the dashboard's chat: it reads the
project, drafts queues for your approval, starts and steers runs (choosing to continue a session that has the
right context, or a fresh one), answers workers' questions whose answer is settled and passes the rest to you, and
tells you when a run halts or finishes. It can read everything and edit nothing.

Phase 3 (Claude Code adapter and queue engine): An approved queue can be started from the dashboard:
Nexus launches Claude Code (with your own subscription login), drives it step by step, puts your notes into each
step's opening, delivers messages and answers into the running turn, holds on questions and reviews, and pauses,
stops and resumes on request. The dashboard shows the agent's activity per step, each session's context fill and
the subscription's usage windows. A turn that fails for a passing reason (the service overloaded, the network, a
crashed runtime) is tried again by itself after 1, 2, 4, 8 and 16 minutes ("waiting to retry"); a usage limit waits
for its window; anything else, or a sixth failure in a row, halts the run with the reason. Pausing or stopping
cancels a pending retry.

In the run controls, **Stop now** asks the worker to leave its work consistent and end its turn. **Stop at once**
interrupts the turn and ends that worker's process immediately, pausing the run. It records the interruption on
the step's timeline and leaves all uncommitted changes in the checkout or worktree. **Resume** reopens the step in
the same session after the process has exited. Stop at once is also available while a worker is still working after
Stop now.

On Windows, Nexus removes a worker's remaining child processes when its step ends, including while the step waits
for review. The runtime stays for the next step; ending the session or using Stop at once removes its whole process
tree. Finish commands and collect their results within the step: a worker cannot leave a development server or a
background command running for the next step. Orchestrators and thinking partners are unaffected.

A new revision of a running queue never stops the step at work: it goes on to its end, questions and answers
included. A revision may change only steps that have not started. At the step's end the run goes on under the new
revision in the same session if you have approved it; otherwise it waits for your approval (keeping its session) and
goes on by itself once you approve. Pausing it meanwhile wins: Resume then goes on. While it waits, the queue reads
"waits for approval of revision N · after S", its run "waiting for approval", and it is in "Waiting for you" (and
pushed, with notifications on) as Needs approval.

A queue stopped by a stop condition shows the worker's short reason for the stop on the stopped step's line, in the
step, in the stop box and on its waiting card; the stop condition it met is behind "more" (an older stop recorded as
one text shows that text, as before). It goes on only when you lift the stop. Either approve a new revision the
orchestrator drafted (a start then begins at the first pending step), or, when the cause was outside the queue,
press Continue: the stopped step runs again in its session. Continue is right where the stop shows: on the stopped
step's line in the queue's card (with the stop's reason, shown there once), on the stop's card in the waiting list,
and in the queue's bar; a queue whose revision is not approved has "Approve revision N…" there instead, which opens
the queue. The orchestrator may propose continuing; its proposal shows on the stop's waiting card and in the queue. It does housekeeping itself: it skips a step a new revision replaced or that was
done elsewhere, closes a halted run whose steps are all done, and cancels a queue that is no longer needed (you get a
notification). Each queue and step lists these changes: who, when and why. Approving, lifting a stop, marking work
done and reopening a finished step stay yours.

The stop box shows what the stopped step left: its own commits, and the uncommitted changes in the checkout (which
are not necessarily that step's, and which Nexus never cleans). When the step committed, Continue and the approval
of a new revision ask you first: **Keep** (the commits stay; with "push accepted steps" on they go out with the next
accepted step's push, otherwise they stay local in the branch) or **Discard** (the stop stays, and the orchestrator
proposes a revision whose first step reverts those commits; approving it lifts the stop). The button then reads
"Continue…" and opens that choice in place, with the step's commits; with nothing to decide, Continue lifts the stop
at once. A worker that stops
commits what is consistent and leaves no uncommitted changes behind.

The settings panel (the gear icon) has two tabs. **Global** holds the settings every project follows: the default
runtime; for Claude Code workers the model, effort and permission mode; for Codex workers the model, effort, sandbox
and what happens when an agent needs to leave the sandbox; the orchestrator's model, effort, notices and the context fill at which it goes on in a fresh session; the thinking
partners' runtime, model and effort; the reader's language; and the defaults, among them the **stop conditions** every
queue gets besides its own (a list: add, edit, remove; an empty one cannot be saved) and the **send-backs before you**
(how many times the orchestrator may send a step back to its worker before the step goes to you; 0 or more). It
also has what belongs to Nexus as a whole: the server section (updates, pushing on deploy, queues at once), this browser's theme and editor, and on the phone this device's
notifications and remote access. **The project's tab** shows the same settings, each with a switch: **Global** (the
global value, greyed and marked "global") or **Own** (a value for this project only); switching back to Global makes
it follow the global value again. Only the project's tab has what is the project's alone: its name, its extra allowed
tools for Claude Code (the project's own `.claude/settings.json` applies as well), the MCP servers its Codex workers
keep, its notes folder, its working
language and where its worktrees go.

**Languages** (a section in both tabs). The **reader's language** is what the agents write to you in: chat replies,
step summaries, questions, progress lines, notifications, and the text of queues (ids and keys stay English). Choose
one of Hungarian, English, Danish, German, Spanish, French, Polish and Italian, or leave it at "the language you write
in" (the default). It is global, and a project may have its own. The **working language** (the project's tab only,
English by default) is what the agents work in: files, code, comments, commits, context cards and notes; keep it in
line with the project's own rules (its AGENTS.md). A changed global value reaches every project that follows it at once; running queues pick it up at
their next step, the orchestrator and thinking partners at their next message. A run keeps the model and effort it
was started with explicitly; what it took from the defaults follows changes. For unattended runs, Claude Code's `auto` permission mode and
Codex's auto review are the recommended settings: routine actions run, risky ones are refused, nobody is asked.
Claude Code workers may not write under the project's `.nexus` folder with their file tools ("Keep out of .nexus",
on by default; the `nexus` command still records their reports; shell commands are not covered); Codex workers
cannot be kept out, as its Windows sandbox refuses it.
Codex workers start without your own Codex MCP servers, plugins and apps (from your `~/.codex/config.toml`): an
MCP server runs outside the sandbox, with your rights, and could reach Nexus on this machine. A project whose Codex
workers need one (Blender, say) names it under **MCP servers kept** in the project's tab (Codex workers section; one
per line, as your Codex config names it). Plugins and apps stay off; thinking partners keep no server.
What was refused shows in each step's detail and, grouped by kind with counts, under "Refused actions" on the project
page; from a Claude Code refusal, "Allow for this project…" adds a rule (prefilled, editable) to these settings.
A run can override model and effort when it starts, and the orchestrator chooses them when it starts runs.
With context care on (the default, under Defaults), a run whose session is fuller than "Reuse a session up to" at
the end of a step goes on in a fresh session of the same runtime, model and effort, given the previous session's
context summary; the run's panel lists each such switch.
A queue can be started when another one is done, at a time, or when the usage window resets: "When" in the start
form (or the orchestrator's `nexus run B start --after A [--after C]`, `--at "2026-11-14 22:00"`, `--at usage-reset`).
This is the plan, shown at the top of a project's queues: what runs now, then what follows, with a line from each queue
to those that wait for it (on the phone an ordered list), and on each queue its whole title, what it waits for and how long its steps
left are expected to take ("about 2 h (estimate)", from finished steps on the same model and effort; "no estimate"
until five steps are finished). The lines run at right angles around the queues, each on its own track, and a line
that skips a column passes through a gap kept free for it, so none runs behind a queue. Nexus starts by itself
only the queues in it, each once the queues it waits for are done and it is
approved; an approved queue outside the plan waits. A schedule missed while Nexus was not running does not start late;
it appears under "Waiting for you". The plan shows on both queues and can be cancelled; if A halts it waits and says
why, and if B is not approved when A is done, B waits for your approval and starts once you give it. If A is stopped
or cancelled, B waits and it appears under "Waiting for you". What you set in the plan is yours: the orchestrator
builds around it and may only propose a change, which appears under "Waiting for you" too.
To change the order, use "After…" on a queue in the plan (or drag it onto another; onto "Next" to put it first): the
queue then waits for the one you chose, and the queues that waited for it wait for what it waited for before, as when
you move an item in a list. Dragging a queue onto another splits the target in two: "After B instead of A" (the move,
naming every dependency it replaces) and "Also after B (and A)" (one more dependency, the others kept); drop it on the
half you mean. Click a line (on the phone, tap an "after" chip) to see that dependency: who set it and when, "Remove
'after A'" (only that dependency goes; if it was the queue's last one, the details say the queue then starts as soon
as it may) and, for one you set, "Let the orchestrator decide". A dependency you remove is your decision: the
orchestrator may propose to put it back, not do it. After a move, an "also after" or a removal, a bar under the plan
says what changed, with Undo for 10 seconds; a queue the change lets start waits until then. An approved queue
outside the plan is listed under it, with "After…" to put it in. The orchestrator's proposal shows on the queue and in
"Waiting for you" with Accept and Decline; ↩ on a dependency you set ("after A · set by you") hands it back to the
orchestrator.
Queues run side by side only in worktrees of their own (the orchestrator gives independent work one, and runs queues
that touch the same code one after another): never two in one checkout, and no more at once, across all
projects, than "Queues running at once" in the settings panel's Nexus section (Global tab) (2 by default; a queue waiting for your
review or an answer does not count). A project can have a limit of its own as well: "Queues running at once" in its
settings (Defaults), switched from Global to Own. Both limits hold: with the global limit at 3 and a project's own at
1, that project runs one queue at a time while other projects may start theirs. An older `limits.json` is taken over
into the global setting at the first start. A queue paused or waiting keeps its checkout. Starting a queue whose checkout
another queue holds, or over a limit, is refused with the reason. A planned queue or a schedule that comes due then waits
instead: its row and the rail say "waits for the checkout" or "waits: limit reached", the plan on the queue (and
`nexus status`) says which queue holds the checkout or how many run, and it starts by itself once it may, in the order
the plans were made. A schedule waiting this way is not missed.
A step in a queue may name its own runtime, model and effort (`runtime`, `model`, `effort` in the queue YAML, shown
on the step); a step without them runs on the run's. Another runtime runs the step in a fresh session given the
previous step's summary; another model or effort keeps the session.
**Kinds of work.** Each kind of step (mechanical, code, debugging, design, research, docs) has its own runtime, model,
effort and fallback in the settings panel's "Kinds of work" (global, and per project with Global or Own, like the other
settings): as shipped, mechanical steps run on claude-sonnet-5-5 at low effort, code, debugging and research on
claude-opus-5-5 at high, docs on claude-sonnet-5-5 at medium, design on claude-opus-5-5 at high. What a step runs on,
strongest first: what the step names in the queue YAML, what its queue names, what you or the orchestrator named when
starting the run (--runtime, --model, --effort), its kind's settings, the project's defaults. So a run started with a
model of your choice keeps it, and a step without a kind runs on the project's defaults. The fallback (where a step
goes on when its runtime's usage runs out: a runtime with an optional model and effort, or wait) is written as a line,
e.g. `codex gpt-6-luna low, wait`.
**When usage runs out.** A step whose runtime is beyond "Pause new steps at" (any of its windows: Claude Code's 5-hour
and 7-day ones, Codex's) does not wait any more: it goes on on its fallback, at a step boundary, and also in the middle
of a step before its next turn (a nudge, an answer, a Fix it, a message), in a fresh session that is given the step's
progress, commits and uncommitted changes; a turn already running is never cut off. Back on its own runtime at the
next step once that is free again. A fallback of `wait`, or every runtime of the chain full, waits for the window that
resets first. The step's details and its line on the queue card say where it ran and why ("On Codex (gpt-6-luna, low
effort): Claude Code's 5-hour window at 96 % (limit 90 %)", "Back on Claude Code: its usage is below the limit
again"), and a waiting run names the window that is full in the same words. The orchestrator is told; while Claude
Code itself is full, what it is told (and its reviews) waits until it is free.
**Tags.** The orchestrator tags every step it plans: one kind (mechanical, code, debugging, design, research or docs),
its activities, its area of the project, a size (S, M or L) and where the work came from. The step's details show
them, with the activities planned beside those its worker reported doing (planned and not done struck through, done
and not planned marked +); a queue's card shows its kinds and areas in a quiet line. The project's areas and its own
activities are lists you keep: the orchestrator proposes additions and renames, which appear under "Waiting for you"
with Accept and Decline (and in the settings panel's Tags section, beside the lists); a draft may use a name only
once you accepted it. A renamed tag reads as its new name everywhere, so what was counted under the old name stays
together.

**Queue templates.** "New queue from template" at the top of a project's queues (the Queues tab on a phone) lists
the templates: Nexus's own (bug fix, UI change with pictures, spike, refactor, maintenance, static analysis setup and the seven maintenance templates below), yours for every project
(in `<NEXUS_HOME>/templates/`, `%APPDATA%\Nexus\templates\` by default) and the project's (`nexus-templates/` in its
repository, versioned with it); a project's template replaces one of yours with the same id, and yours replaces
Nexus's. Pick one, fill in what it asks (a maintenance template also asks its mode) and add anything else; "Send to
the orchestrator" sends it as your message, and the orchestrator drafts the queue and fills in the rest. You approve
it as any queue. A template is a queue's YAML with a `template:` header, `params:` and `{{name}}` placeholders
(docs/PROTOCOL.md, "Queue templates"); `nexus template list` shows the ones in effect.

**Maintenance templates.** Ten templates survey a project and report; none depends on a stack, the commands are
parameters with Node and .NET/Unity examples. `dependencies` lists the outdated dependencies (minor and patch; in
fix_small mode it applies the patch-level ones whose tests pass). `security-audit` runs the project's audit and only
reports. `dead-code` finds unused code and lint findings (fix_small removes what is surely unused).
`test-health` runs the suite several times for flaky tests, times it for the slow ones and looks for redundant
tests (duplicates found with a clone finder, `clone_command`, which may be left empty, then compared one by one;
every candidate with the places of both tests, the reasoning and a degree of certainty); it never changes or deletes
a test, in any mode. `performance` measures with the project's command and compares with earlier values.
`docs-freshness` compares the documents with the code (fix_small fixes typos only). Each report ends with
"Recommended additions": what the project's stack supports but is not set up, for the orchestrator to offer you.
A seventh, `notes`, is meant to recur: it keeps the notes true. It reads the Claude sessions' memory notes (the
`memory_dir` parameter, outside the project), the ideas notes and the project documents against the code, and reports what
is stale, built but unmarked, or untrue. Only the clear typos in the project documents are fixed in fix_small mode; the
memory and ideas notes are only reported.
`agent-contract` checks that the agents' instructions, the command line and its help, the file schemas and the
protocol's description agree (fix_small fixes only clear slips in the description). `git-hygiene` reports the
worktrees and branches that closed queues left behind and untracked files that belong nowhere, in the checkouts you
name, never in the places you exclude; it deletes nothing, in any mode (removing is yours, as a queue). `lifecycle`
reports, for a change you name (commits or a queue), how well the tests cover interrupting, continuing, restarting
and the failures; it has no schedule: the orchestrator offers it in a sentence when a queue that touched the project's
run control or lifecycle code is done (your AGENTS.md may say which code that is).
Nexus's own instances, filled in for this repository, are in `nexus-templates/`. They run in a worktree of their own
(`worktree: auto`, which any template or project instance may carry), so a run never holds the main checkout. A survey
there has nothing to merge back: once it is done Nexus removes its worktree, whether merging back by itself is on or
not; if files are left in it, the worktree stays and "Waiting for you" gets a "Cleanup" item naming them (look, then
Clean up on the queue's page). A stopped survey keeps its worktree as evidence. In fix_small mode the run ends with
the integration step and is merged back like any worktree queue.

**Static analysis setup.** The `static-analysis` template sets up static analysis for any stack (ESLint or Biome
for Node, the .NET analyzers and `dotnet format` for .NET and Unity): it asks you which tools to use, takes the
existing findings as a baseline and proposes the lines for your project's checks. While a Node, .NET or Unity project
has no linter or analyzers, its orchestrator recommends the template once a month; say no and it stays quiet for 90
days.

**Recurring queues.** The orchestrator can set a template to recur, at a time (every day, a weekday or a day of the
month, the PC's local time) or after every N queues of the project are done; it proposes one in the chat first. Each
appears under "Recurring" on the project's queues (below the plan and the queues in progress and planned) with its schedule, values, mode, next and last run. You approve it
once (Approve, also in "Waiting for you"): its runs then start by themselves while it stays as it is. Anything that
changes it (the orchestrator's change, an edited or replaced template, a Nexus update that changes Nexus's template)
asks for your approval again, and until then nothing runs. Pause and Remove are yours too; the queues it made stay.
While its previous run is still open (running, waiting or stopped), its next time passes without a run and tells you.
A time missed while the PC (or Nexus) was off is made up for once when Nexus starts again: the latest missed time runs
then, under the same conditions as on time (your approval, the previous run closed), and its "Last run" says "made up
for the missed time"; older missed times pass. A maintenance template either only surveys and
reports (survey: Nexus stops a run that leaves a commit) or also fixes the small findings it names (fix_small); a run
with findings goes to the orchestrator, which proposes a queue from the report, and one without closes quietly.

**Stats.** "Stats · all projects" under the projects in the sidebar (on a phone at the foot of the project list that
opens from the project's name) shows, across every project: the **usage windows day by day** (Claude Code's 5-hour
window as the highest reading of each day, its 7-day window and Codex's weekly window at each day's end, with the
pause threshold), then **how steps went by model or effort**: the steps, the share accepted in the first round, the
median working time and the estimated use of the weekly window per step, and per group the same four side by side
(**Columns**), as a dot per group of first-round rate against working time (**Scatter**), or as a **Table**; the
choice is kept in that browser. The range (7, 30, 90 days, all) is at the top; the project and the tags (kind,
activity, area, size, origin) narrow the steps, not the windows. Use is an estimate and says so (≈); a group of fewer
than 5 steps is marked "few data"; ↺ counts steps with a turn on a fallback. Every chart has a table view beside it.

**A project's Stats** (the **Stats** tab beside Orchestrator and Ideas; on a phone the fifth tab) shows what the
project measures: the metrics the orchestrator defined (`nexus metric define`) and the checks' times, one card each
in the form it gave: a line over the steps, bars, or the latest number with its change and a small trend. The target
is a dashed line, the warning threshold a dashed line marked ⚠; a value beyond it is drawn in the warning colour with
⚠ and its value. Hovering a value says its step, commit and day; a click (or Enter) opens the step, and "last … ·
<step> →" under each card opens the latest. A metric no worker has recorded yet says how one is recorded. The range
(7, 30, 90 days, all) is at the top; every card has a table view. **A step's details** list the metrics its worker
recorded (the latest of each); one beyond its threshold is in the warning colour with the threshold in words, and the
step's header says "⚠ 1 metric beyond its threshold".

## Requirements

Node.js 24 or later (TypeScript runs natively; only the dashboard is built, with Vite).

## Setup

```sh
npm install
npm link -w @nexus/cli          # puts `nexus` on the PATH
```

Register a project and, optionally, import queues written as Markdown tables:

```sh
cd C:/Code/GameDev/ProjectHoneycomb
nexus project add . --id honeycomb --name "Project Honeycomb"
nexus import docs/QUEUE.md
nexus import Dev/Workflow/QUEUE.md --prefix D       # a second file whose queue ids would clash
```

`project add` creates `.nexus/` in the project with its own `.gitignore`, so the project's files are untouched. It also
says whether both runtimes would see the project's rules: Nexus's convention is that they are in `AGENTS.md` (Codex
reads it) and `CLAUDE.md` pulls them in with the line `@AGENTS.md` (Claude Code reads only `CLAUDE.md`). When one
would not, the project's page in the dashboard warns and offers the fix: it shows the change to the two files, and
makes it when you confirm (not while a queue runs in the project's own checkout). Nexus does not commit it: you do.
The list of registered projects is in `%APPDATA%/Nexus/projects.yaml` (`NEXUS_HOME` overrides the directory).

To take a project off Nexus, use the Danger zone at the bottom of its settings in the dashboard (there is no command
for it, and no agent can do it). **Remove from Nexus** takes it off the list and stops its agents; its `.nexus/`
stays, and `nexus project add <path>` brings it back under the id it had, with everything as it was. **Delete Nexus's
data** also deletes its `.nexus/` folder (queues, sessions, chats, notes, review material); you confirm it by typing
the project's name. Neither touches the project's own files, nor the worktrees and branches Nexus made for its queues
(remove those with git when you no longer need them). Both are off while anything runs in the project (a queue
running, paused, waiting or stopped, a merge back, a planned deploy after its work, the orchestrator or a thinking
partner in a turn): the zone says what. Planned and scheduled starts and open questions go with the project; the
confirmation lists them, and what stays.

Pictures added to chat messages are kept in the project's `.nexus/uploads/`, named by the time and a short hash. Nexus
never deletes them: clear the folder by hand when you no longer need them.

## Running: a live instance, and development beside it

The Nexus that serves real projects runs from its own worktree, so working on Nexus never interrupts an agent:

```sh
powershell -ExecutionPolicy Bypass -File scripts/live.ps1    # creates C:/Code/Nexus-live (a worktree on main), installs, builds
cd ../Nexus-live && npm start                                 # the live instance on http://127.0.0.1:4317
```

To bring a new version to it: commit to `main` here, then `nexus server update` (or "Update Nexus" in the settings
panel), or ask the orchestrator in its chat to deploy. The orchestrator does it only when you ask, never on its own.
First it tells you which steps are running and will be waited for, and that it restarts with Nexus. After the
restart it tells you which version came up, or why the update failed. Running steps finish first and no new step starts meanwhile; then the live worktree moves to `main`,
installs what changed, builds and restarts itself, and the queues it held (also those waiting to retry) go on by
themselves. Queues paused by you,
stopped by a stop condition, waiting for an answer or for the usage window stay as they are. `--now` stops the
running steps instead of waiting (they continue where they were); `nexus server cancel` gives up waiting. If the
update fails, the old version keeps running and the held queues go on. That includes a new version that does not
come up (it crashes, fails its start-up check or gives no sign within 60 seconds): the old server stops it, moves
the live worktree back, rebuilds and takes the port again. The settings panel then shows "update failed" with the
reason and "rolled back to <commit>", and your devices get a notification. There is nothing to undo by hand: fix the
commit and update again. After a restart the server writes its log to `%APPDATA%\Nexus\server.log`.

While an update waits, you can go on talking with the orchestrator and the thinking partners. An answer still being
written when Nexus restarts is cut off; after the restart the chat says "Nexus restarted while answering; it goes on",
and the same conversation answers your message again.

A deploy can also wait. Ask the orchestrator to deploy after a step ("deploy once PD3 is in"), after a whole queue,
or at a time ("deploy at 6:00, and by 7:00 at the latest"), or plan it yourself: `nexus server update --after
<queue>[/<step>]`, or `--at <HH:MM|"YYYY-MM-DD HH:MM"> [--deadline <time>]`. One plan at a time.
- After a step: the deploy starts the moment the step is done (or, if it waits for your review, once accepted). Its
  queue opens no next step until the deploy is done, then goes on by itself.
- After a queue: only once every step is closed, its closing step included. A stopped or failed step means no deploy.
- At a time: from then no new step starts and the deploy waits for the running ones. At the deadline, steps still
  running are interrupted and continue after the restart; without a deadline it simply waits.
- With provisional work set not to count, a planned deploy waits until you have confirmed the provisional work it
  would include; meanwhile only its own queue waits.

The plan shows at the top of the right rail (the Waiting tab on the phone) and in the Nexus section of the global
settings: what it waits for, and Cancel plan. If its step fails, stops or is rejected, or the update fails, the plan
is dropped and you get a notification. It stays across a restart of the server; `nexus server status` shows it, and
`nexus server cancel-plan` cancels it.

Once an update of `main` is up, Nexus pushes the deployed commit to GitHub, to the upstream of `main`. It never
forces: if GitHub's `main` has commits the deployed one lacks, the push is refused. It never asks for credentials:
git must already be able to push without a prompt, or the push counts as failed after at most 60 seconds. The settings
panel shows the result above the update log: "Pushed: <commit> is now origin/main", "Push failed: <reason>", or "Not
pushed: <why>". A failed push leaves the update in place; fix the cause and push or update again. To stop pushing,
untick "Push the deployed main to GitHub after an update" in the settings panel (Global tab). Only you can change it, from the
dashboard. An update to anything other than `main` is never pushed, and agents never push.

After a deploy, every project's orchestrator is also told what changed for agents. A commit that changes something
agents rely on carries a line `Agents: <what changed>` in its message, and the deploy collects those lines from the
new commits. With the orchestrator's notifications on, it gets them right away; with them off, they go in with your
next message to it. They are for the orchestrator only; your chat does not show them. Only commits from 2026-11-13
on carry these lines, so a deploy that starts from an older version tells nothing about what came before.

```sh
npm start        # builds the dashboard, serves it and the API on http://127.0.0.1:4317
npm run dev      # development, apart from the live instance: API on :4318 with data in %APPDATA%\Nexus-dev,
                 # dashboard with hot reload on http://localhost:5173
npm test         # protocol, importer, engine and orchestrator tests (the last two run a fake `claude`)
npm run test:files -- apps/server/test/engine.test.ts   # while working: only these files, stops at the first failure
npm run test:times   # the whole suite, then how long each file took, slowest first
npm run typecheck
npm run lint     # ESLint (correctness rules, with types) and dependency-cruiser (module boundaries); about 15 s
npm run knip     # unused files, exports and dependencies (closing refactoring steps and maintenance)
node scripts/load-tests.mjs --burners 12 --copies 4 --rounds 5 apps/server/test/review.test.ts   # tests under load
```

One full run at a time on the machine: `npm test` and `npm run test:times` take a lock in the system's temporary
folder first (`scripts/test-lock.ts`). When another checkout's full run holds it, they wait, saying once a minute
what for, and after 15 minutes run anyway; a lock left by a run that died, or held for more than 20 minutes (longer
than a full run takes), is taken over at once. A full run ends with whatever started it: when the shell or the
command that ran `npm test` is killed (a background command's time limit, a closed terminal), the run's test processes
end and its lock goes. `npm run test:files` never waits. `NEXUS_TEST_LOCK` names another lock file,
`NEXUS_TEST_LOCK_MAX_MS` another longest wait, `NEXUS_TEST_LOCK_STALE_MS` another age at which a lock is stale.

The tests that run fake runtimes or servers wait 10 s for what they expect (`NEXUS_TEST_WAIT_MS` sets it, e.g. higher
on a slow machine; `apps/server/test/wait.ts`), so a change that breaks many of them fails the suite in minutes.
A test that fails only now and then usually fails on a busy machine: `scripts/load-tests.mjs` runs the files given
several times at once beside busy-loop processes and reports each run, its failures and its slow tests.

`npm run lint` checks what the compiler does not: a promise nobody awaits, an async function where a void callback is
expected, a `switch` over a union that leaves a member out (a `default` does not count), the rules of React hooks, and
the module boundaries (the protocol imports nothing from `apps/`, neither the dashboard nor the CLI imports the
server). There are no style rules and no formatter. Fix a finding rather than silence it; a promise left alone on
purpose takes `void`. `npm run knip` lists files nothing loads, exports nothing imports and dependencies nothing uses;
a file loaded only by its path (a seed of `scripts/capture`, a fake runtime) is an entry in `knip.json`. The rules
and their reasons: [docs/DESIGN.md](docs/DESIGN.md), "Static analysis".

`NEXUS_PORT` and `NEXUS_HOST` change where the server listens (default `127.0.0.1:4317`, this machine only).

### Pictures of the dashboard for review

`scripts/capture.ts` takes the review pictures of a change to the dashboard: one fixed-viewport picture per view (the
window, not the whole page), each with its view key, and the same views as they were before the change.

```sh
node scripts/capture.ts scripts/capture/examples/dashboard.yaml --step RS/RS3   # befores at the step's base commit
node scripts/capture.ts views.yaml --base 8800a05 --out $TEMP/review-X1        # or a commit of your choice
node scripts/capture.ts views.yaml --no-before                                  # afters only (new screens: results)
```

The view list names a seed script that writes the test projects (`scripts/capture/seed-demo.ts`, a demo project
with a step waiting for review) and the views: a key such as `viewer-before-after@390` (the width comes from it),
a route such as `#/demo/UI/UI1`, a label, and a few setup actions (click a button by its text or an element by a CSS
selector (an SVG shape too), type, press a key, scroll a heading to the top by its text, drag one element over others
(HTML5 drag and drop, `drag: {from, to, drop?}`; without `drop` the picture shows the drag in progress), wait). A view's `script` (a `.js` file) runs in the page before the dashboard does, for
that view only: `scripts/capture/fake-speech.js` stands in for the browser's speech recognition, so a picture can show
the microphone listening without a microphone. The format is in `nexus help review` and `scripts/capture/views.ts`. The tool builds this checkout's dashboard,
seeds a development instance (port 4318 and up, its own data in a temporary folder, the fake runtimes, and
`NEXUS_DIR`, `NEXUS_HANDOVER` and `NEXUS_SESSION` cleared) and takes the afters with headless Edge. For the befores
it makes a temporary git worktree at the base commit (the step's first start, from `.nexus/queues/<queue>/git.yaml`),
installs and builds it (a few minutes), runs the same seed and views against it, and removes it. Pictures go to
`<temp>/nexus-review/<queue>/<step>/` (the system's temporary folder, outside the working tree; `--out` names another)
as `<key>.png` and `<key>.before.png`. At the end it prints the `nexus review add` commands, befores first; that
command copies each picture into `.nexus/queues/<queue>/review/<step>/`. It also lists any view it could not take, and why: take those by hand. A seed that does not fit the
older code also shows up there. It never stops the step. Views narrower than Edge's 492 px are shown in a frame of
their width. `NEXUS_CAPTURE_BROWSER` points it to another Edge or Chrome.

`scripts/layout-faults.ts` measures a page's layout faults: lines running through boxes, overlapping boxes and text
cut short (and counts where lines cross). It takes a mockup file or a development instance's URL, never port 4317:

```sh
node scripts/layout-faults.ts "docs/ux/mockups/22-plan-layout.html?v=b" --width 390 --shot $TEMP/plan@390.png
node scripts/layout-faults.ts http://127.0.0.1:4318/#/nexus --click "All queues of Nexus" --lines "section[aria-label='The plan'] svg path"
```

Exit code 1 when it finds a fault; the list says which line, box or text. Details: [docs/DESIGN.md](docs/DESIGN.md),
"Layout faults".

## Remote access

The server listens on this PC only. Everything from this PC works without signing in; anything that comes through a
proxy or from another address needs the access token once (it sets a cookie for a year).

The sign-in page and the installation files (icons, manifest and service worker) are available before signing in.
A missing installation file returns 404 instead of opening the dashboard; normal dashboard links still work after
sign-in.

1. Install Tailscale on the PC and sign in (`winget install tailscale.tailscale`); install the Tailscale app on the
   phone and sign in with the same account.
2. In the Tailscale admin console, under DNS, turn on MagicDNS and HTTPS certificates.
3. Publish Nexus to your tailnet only: `tailscale serve --bg 4317` (not `funnel`, which would make it public).
4. On the PC, open the dashboard's Remote access panel (the phone icon at the foot of the project sidebar): it shows the address, the
   token and a QR code. Scan it with the phone: it opens Nexus and signs in.
5. On the phone, add Nexus to the home screen (iPhone: Share, Add to Home Screen), open it from there and turn on
   the bell: notifications arrive even with Nexus closed. "Send a test notification" in the panel checks it.

**Which notifications a device gets** is chosen on that device, in Settings, Global, "This browser", Notifications:
a switch for each kind (a question, a stopped queue, a step to review, a failed update of Nexus…; all on at first),
quiet hours (for example 22:00 to 07:00, in the device's own time zone; off at first) and "Urgent breaks through",
which lets a stopped queue, a failed step and a failed update of Nexus through the quiet hours. What the quiet hours
hold back does not come later; the waiting list and the morning digest show it. A change applies at once. With push
on, the settings go with the device's subscription, so the phone and the computer each keep their own; without it,
the open tab's notifications follow them. The test notification always comes.

On a narrow screen the project sidebar gives way to a picker: the current project's name at the top left, with its
"waiting for you" count and running dot. Tap it for the list of all projects (each with its count and dot), tap one to
switch.

The rail (or Waiting N on a narrower computer, the Waiting tab on a phone) counts what waits for you in all projects (questions, approvals, steps in review,
halted runs, failed steps). It opens one list of them, newest first, each with its project; tap an item to open it.

Every step is reviewed when it is done. Its **review level** says by whom: 1, you review it; 2, the orchestrator
reviews what can be checked and hands you what is yours (the look, the feel), with why; 3, the orchestrator judges
everything and the queue goes on. The orchestrator drafts each step's level from its acceptance criteria (checkable
ones give 2, your judgement gives 1); a step without one takes its queue's, else the project's "Review level" (in
Settings; 2 unless you change it). In the approval view each step has **Review 1 · 2 · 3**: pick another before you
approve; after approval the same control stays in the step's panel and in the queue's panel ("Review levels", the steps
whose review is still to come: pending, running, waiting for review, stopped), so you can decide later that you review
a step yourself. A new level asks for no new approval, stays when the orchestrator revises the queue, and shows "set by
you" with Reset; a step whose review is over (accepted, skipped, failed, rejected) keeps its level. A step waiting for
the orchestrator's review that you set to 1 comes to you at once, as if the orchestrator had handed it over, and the
orchestrator is told; set to 3, it keeps waiting for the orchestrator (nothing is accepted by itself). The queue's own
level (⋯ in its bar) works the same way. A step's line on the queue shows its level when it is not 2 (L1, L3), and the
step's panel always does. A step says whom it waits for ("review: orchestrator" or "review: you"); only those for you are in the inbox.
Without an orchestrator, or with its notices off, levels 2 and 3 wait for you too.

At level 3 the orchestrator accepts what has nothing of yours, and **accepts provisionally** what has: the step reads
"accepted provisionally" and the queue goes on. These wait for you in one item of the waiting list, "N provisional
acceptances wait for your confirmation", each with what to look at, **Confirm** and **Fix it…** (also in the step's
panel). Confirm, and it is accepted. Fix it keeps the step done and its work: the orchestrator drafts a step that fixes
it, as a new revision (a queue that went on waits for your approval at its running step's end; a finished one is
approved and started). Whether provisional work is pushed like accepted work is "Provisional work" in Settings (on by
default; off, nothing built on unconfirmed provisional work is pushed until you confirm it).

**Away mode**: "Away…" at the foot of the sidebar (in Settings on a phone) turns it on until a time (08:00 by default,
the next such time); "Away until 08:00" then shows there and at the top of the right rail (in the header on a phone),
with Turn off. Meanwhile level-2 steps run as level 3, so the queues go on and what is yours waits in the batch;
level-1 steps still wait for you. When a queue waits for you, the orchestrator is told which other approved queues can
start (never two in one checkout). It ends by itself at its time. From a terminal: `nexus server away on --until 8:00`
or `off` (never from an agent's session).

A step waiting for you can be accepted, with a note if you like (⋯, "Add a note to the acceptance"): the note goes to the next step of
the queue, which gets it when it starts, or to the orchestrator, for the plan, later queues or the project's rules
(on the queue's last step, always to the orchestrator; it reaches the orchestrator even with its notifications off).
Or it can be sent back with **Fix it…**: write what you want instead, and the step goes
back to its worker in the same session as its next round. Your words win over the step's acceptance criteria where
they conflict; when the step has criteria, Nexus lists them and asks before sending. The round after a Fix it comes
back to you. The orchestrator may send a step back twice (`review_send_back_limit` in the project's defaults); its
third send-back hands the step to you instead.

**Reject** ("I want something else", "I don't want this", under ⋯) is the third action on a step waiting for you, with an
optional reason. The run pauses and nothing is reverted; the orchestrator is told (even with its notifications off)
and proposes what follows, a revert as a step, changed steps or a new queue, as revisions for you to approve. The
queue goes on only once you approve a new revision, at its first pending step; the rejected step is not run again,
and nothing of the queue is pushed in between.

**Commits and the branch.** A step lists the commits made while it was at work (subject, files and lines changed),
per round; in the project's own checkout, a commit not made during its worker's turns is marked ◆. A queue shows its
branch: how far ahead and behind of its base and of its remote-tracking branch, as last fetched (Nexus never fetches).

**The integration step.** A queue with a worktree of its own ends with a step Nexus keeps (⇄ "Integration", by
Nexus), after the closing refactoring step: its worker merges the current main into the queue's branch in the worktree
and runs the checks there, so main only ever moves forward to a tested result. A conflict stops the queue for you,
unless Settings → Merging back → "Conflicts" lets the worker resolve it (then the step's review judges the
resolution); resolve it in the worktree, or with a new revision, and press Continue: the step runs again.

**Merge back and clean up.** A finished queue that ran in a worktree of its own offers "Merge into <base>…" and
"Clean up…". Each asks first. For a queue with an integration step, Merge moves main forward to the commit the
integration step tested (a fast-forward, never a merge commit); if main moved on since, the integration step runs
again instead. It refuses while the checkout of main has uncommitted changes or a step is at work there. Clean up
removes the worktree and deletes the branch, only if nothing is uncommitted and the branch is merged. Nothing is
pushed. (A queue from before the integration step merges as before: a fast-forward when possible, else a merge commit;
a conflict is aborted.)

**Interrupted worktree cleanup.** Retry Clean up after resolving the reported filesystem error. A cleanup that
started with this version records the verified folder identity and contents before deletion, so it can continue
even after `.git` or the worktree registration disappeared, including after a server restart. New, changed or
replaced contents stop the retry; Nexus never treats unreadable Git state as a clean folder. An already completed
cleanup is harmless to retry.

For an older partial cleanup (including PT/WK) with no saved proof, the missing evidence cannot be reconstructed
from a successful merge alone. Preserve the **entire remaining folder at a separate backup path**, leaving the
original worktree path absent. Inspect that backup against the queue's merged commit in an independent checkout;
recover modified, untracked and ignored work before deciding whether to discard anything. Then retry Clean up:
Nexus can prune the old registration and delete the still-merged branch without deleting the backup. If that
branch is also gone and there is no proof, first identify its original tip from the merge record/reflog and verify
that it is contained in the intended base, then restore that branch at the verified commit. If its tip cannot be
established, keep the backup and ask for a repository review; do not guess. Never recreate `.git`, manufacture a
cleanup proof, or use a forced recursive delete to bypass this refusal. An EPERM identifies a failed operation,
not the process responsible; identifying a lock or permissions problem may still need separate investigation.

**Merging back by itself** (Settings → Merging back, global with a project override, off by default): Nexus does the
merge back and the cleanup itself, once every step is accepted and the integration step's checks pass. If the checkout
of main has uncommitted changes, main is checked out nowhere, the checks failed, or main moved on again after two runs
of the integration step, it waits and tells you: an item "Merging back" in Waiting for you, which opens the integration
step with the reason. A step at work in the main checkout is held at its end for the moment of the fast-forward. The
integration step's page says who merged it back ("Merged back by Nexus"). The cleanup waits until you have confirmed
the queue's provisional acceptances. Turn it on where the project's checks are strong: everything then rests on them.
"Worktree setup" (project only) is a command run once in each new worktree before its first step, for example `npm ci`;
if it fails, the run stops with the reason.

**Checks for every step** (Settings → Defaults, project only, empty by default): commands every step of every queue
of the project runs before the queue's own checks, one per line, for example `npm run lint`; a check the queue names
too runs once. Approving a queue shows them first, marked "(project)". A queue that is running gets a change at its
next start, not its next step. For Nexus itself set it to `npm run lint` once the static analysis (queue SA) is
deployed: then every queue, also the ones already approved, runs it.

**Push accepted steps** (Settings, off by default): when a step is accepted, by you or the orchestrator, Nexus pushes
the commit the step was reviewed at (not later work) to the branch the queue runs on, at its upstream remote or
origin. Never forced, never with a prompt. The step shows "Pushed: …" or "Push failed: …"; a failed push leaves the
step accepted, is tried again with the next accepted step, and has a "Push again" button. Without a remote the step
says it was not pushed.

"Replace token" in the panel signs every remote device out. To have Nexus start with Windows, without a console
window, run from the live instance: `powershell -ExecutionPolicy Bypass -File C:\Code\Nexus-live\scripts\autostart.ps1`
(`-Remove` undoes it; the log goes to `%APPDATA%\Nexus\server.log`). To start it once without a window:
`wscript C:\Code\Nexus-live\scripts\start-hidden.vbs`.

## Reporting from an agent started by hand

```sh
nexus attach --runtime claude --queue W --title "cliffs worker"   # prints a session id
export NEXUS_SESSION=<id>                                           # or pass --session <id> each time
nexus status
nexus step start W3
nexus step progress W3 "Support graph built" --pct 40
nexus review add W3 $TEMP/nexus-review/W3/sheet.png --label "Sheet, round 1"   # copied into .nexus/queues/W/review/W3/
nexus review add W3 $TEMP/nexus-review/W3/lit.png --before $TEMP/nexus-review/W3/unlit.png --label "Lighting"
nexus step done W3 --summary "No floating body on any fixture"
```

`nexus status` is also how a hand-started agent receives what the user sends: notes for its queue's steps, messages
and answers to its questions. Each is shown once and recorded as delivered. `nexus --help` lists every command.

## Layout

| Path | What |
|---|---|
| `packages/protocol` | Schemas of every file and event, the store (reading and writing `.nexus/`), state derivation |
| `packages/cli` | The `nexus` command and the Markdown queue importer |
| `apps/server` | HTTP API, file watching, live change notifications over WebSocket |
| `apps/web` | The dashboard (React, Vite, Tailwind CSS) |
