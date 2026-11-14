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
into the orchestrator's chat, which turns it into queues.

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
**Orchestrator** and **Ideas** (with how many conversations there are); "Tool calls" shows the tool lines, ⋯ has "New
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

**On a phone** (and in any window narrower than 1024 px) a bar at the bottom has four tabs: **Orchestrator** (the
chat), **Waiting** (what waits for you in all projects, with the count), **Queues** and **Ideas**. One tap switches.
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
paragraph or a list item of a message shows a **reply** icon at its right edge: one click quotes that item as it was
written (its Markdown).

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

**Stop.** While the orchestrator or a thinking partner is in a turn, **Stop** shows above the message box. It
interrupts the turn at once: the chat says "Stopped.", nothing more of that turn appears, and the agent waits. What
you sent during the turn goes in with your next message.

**Pictures.** Paste a screenshot (Ctrl+V), drop a picture on the chat, or use the paperclip beside the box, in the
orchestrator's chat, in a conversation and on the phone. PNG, JPEG, WebP or GIF up to 10 MB; anything else (an
iPhone HEIC photo, say) shows "only PNG, JPEG, WebP or GIF up to 10 MB". The picture shows as a thumbnail above the
box (✕ removes it) and goes with your message; a picture alone is a message too. The agent gets its path and opens
it; the chat shows the picture, and a click opens it full size. Pictures are kept in the project's
`.nexus/uploads/`.

**A queue** on the project page shows one status ("running · SF3", "paused · B2", "stopped at W4c", "waiting for
your review · UX2"…), a progress line with a segment per step, and its steps one line each, in two columns on a
computer. "Running" means a run is really at work; a queue whose run is paused says so. The step that matters is
highlighted with why and its action (**Continue…**, **Review…**, its questions). On a phone the list is one column, the
finished steps before it and the steps after the next three are folded into one line each; a tap unfolds them.

**One action bar.** Every queue and step panel ends with the same bar, always in sight however long the panel is:
the main action on the right (Accept and go on, Approve revision N, Continue, Answer), the second left of it (Fix
it…), and everything else under ⋯ (Reject, a note with the acceptance, your words with an approval, Withdraw
approval, the queue's "After each step"). What an action needs (Fix it's text, a reason) opens just above the bar.
The header says where you are, what it is and its status, with ✕ at the top right. A conversation in Ideas has its
actions under ⋯; the orchestrator's "New conversation" (which makes it start over) is under the chat's ⋯.

**Reviewing a step** opens on its summary and its pictures, large, two per row, with your marks; the checks, the
goal and acceptance, the commits and the timeline are one line below, folded. A picture opens in the viewer: full
screen, two fingers to zoom (double-tap on a computer), swipe, the arrow keys or the filmstrip at the bottom to move
between the step's pictures; "Open the original" under ⋯ opens the file in a new tab. A picture with a "before" (the
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
Markdown rendered, pictures in the picture viewer; it works on the phone too and starts no program. A commit opens
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
and what happens when an agent needs to leave the sandbox; the orchestrator's model, effort and notices; the thinking
partners' runtime, model and effort; the reader's language; and the defaults. It also has what belongs to Nexus as a whole: the server
section (updates, pushing on deploy, queues at once), this browser's theme and editor, and on the phone this device's
notifications and remote access. **The project's tab** shows the same settings, each with a switch: **Global** (the
global value, greyed and marked "global") or **Own** (a value for this project only); switching back to Global makes
it follow the global value again. Only the project's tab has what is the project's alone: its name, its extra allowed
tools for Claude Code (the project's own `.claude/settings.json` applies as well), its notes folder, its working
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
What was refused shows in each step's detail and, grouped by kind with counts, under "Refused actions" on the project
page; from a Claude Code refusal, "Allow for this project…" adds a rule (prefilled, editable) to these settings.
A run can override model and effort when it starts, and the orchestrator chooses them when it starts runs.
With context care on (the default, under Defaults), a run whose session is fuller than "Reuse a session up to" at
the end of a step goes on in a fresh session of the same runtime, model and effort, given the previous session's
context summary; the run's panel lists each such switch.
A queue can be started when another one is done, at a time, or when the usage window resets: "When" in the start
form (or the orchestrator's `nexus run B start --after A`, `--at "2026-11-14 22:00"`, `--at usage-reset`). A schedule
missed while Nexus was not running does not start late; it appears under "Waiting for you". The plan shows on both queues and can be cancelled; if A halts it waits and says why,
and if B is not approved when A is done, B does not start and the item appears under "Waiting for you".
Queues run side by side only in worktrees of their own: never two in one checkout, and no more at once, across all
projects, than "Queues running at once" in the settings panel's Nexus section (Global tab) (2 by default; a queue waiting for your
review or an answer does not count). A queue paused or waiting keeps its checkout. Starting a queue whose checkout
another queue holds, or over the limit, is refused with the reason. A chain or a schedule that comes due then waits
instead: its row and the rail say "waits for the checkout" or "waits: limit reached", the plan on the queue (and
`nexus status`) says which queue holds the checkout or how many run, and it starts by itself once it may, in the order
the plans were made. A schedule waiting this way is not missed.
A step in a queue may name its own runtime, model and effort (`runtime`, `model`, `effort` in the queue YAML, shown
on the step); a step without them runs on the run's. Another runtime runs the step in a fresh session given the
previous step's summary; another model or effort keeps the session.

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
npm run typecheck
```

`NEXUS_PORT` and `NEXUS_HOST` change where the server listens (default `127.0.0.1:4317`, this machine only).

### Pictures of the dashboard for review

`scripts/capture.ts` takes the review pictures of a change to the dashboard: one fixed-viewport picture per view (the
window, not the whole page), each with its view key, and the same views as they were before the change.

```sh
node scripts/capture.ts scripts/capture/examples/dashboard.yaml --step RS/RS3   # befores at the step's base commit
node scripts/capture.ts views.yaml --base 8800a05 --out tmp/review/X1          # or a commit of your choice
node scripts/capture.ts views.yaml --no-before                                  # afters only (new screens: results)
```

The view list names a seed script that writes the test projects (`scripts/capture/seed-demo.ts`, a demo project
with a step waiting for review) and the views: a key such as `viewer-before-after@390` (the width comes from it),
a route such as `#/demo/UI/UI1`, a label, and a few setup actions (click a button by its text or an element by a CSS
selector, type, press a key, wait). The format is in `nexus help review`. The tool builds this checkout's dashboard,
seeds a development instance (port 4318 and up, its own data in a temporary folder, the fake runtimes, and
`NEXUS_DIR`, `NEXUS_HANDOVER` and `NEXUS_SESSION` cleared) and takes the afters with headless Edge. For the befores
it makes a temporary git worktree at the base commit (the step's first start, from `.nexus/queues/<queue>/git.yaml`),
installs and builds it (a few minutes), runs the same seed and views against it, and removes it. Pictures go to
`tmp/review/<step>/` as `<key>.png` and `<key>.before.png`. At the end it prints the `nexus review add` commands,
befores first. It also lists any view it could not take, and why: take those by hand. A seed that does not fit the
older code also shows up there. It never stops the step. Views narrower than Edge's 492 px are shown in a frame of
their width. `NEXUS_CAPTURE_BROWSER` points it to another Edge or Chrome.

## Remote access

The server listens on this PC only. Everything from this PC works without signing in; anything that comes through a
proxy or from another address needs the access token once (it sets a cookie for a year).

1. Install Tailscale on the PC and sign in (`winget install tailscale.tailscale`); install the Tailscale app on the
   phone and sign in with the same account.
2. In the Tailscale admin console, under DNS, turn on MagicDNS and HTTPS certificates.
3. Publish Nexus to your tailnet only: `tailscale serve --bg 4317` (not `funnel`, which would make it public).
4. On the PC, open the dashboard's Remote access panel (the phone icon at the foot of the project sidebar): it shows the address, the
   token and a QR code. Scan it with the phone: it opens Nexus and signs in.
5. On the phone, add Nexus to the home screen (iPhone: Share, Add to Home Screen), open it from there and turn on
   the bell: notifications arrive even with Nexus closed. "Send a test notification" in the panel checks it.

On a narrow screen the project sidebar gives way to a picker: the current project's name at the top left, with its
"waiting for you" count and running dot. Tap it for the list of all projects (each with its count and dot), tap one to
switch.

The rail (or Waiting N on a narrower computer, the Waiting tab on a phone) counts what waits for you in all projects (questions, approvals, steps in review,
halted runs, failed steps). It opens one list of them, newest first, each with its project; tap an item to open it.

"After each step" (in Settings for the project, under ⋯ in a queue's bar for that queue) can also be "wait for the orchestrator's
review": the orchestrator then checks each step and accepts it, sends it back, or hands it to you with why. A step
says whom it waits for ("review: orchestrator" or "review: you"); only those for you are in the inbox. Without an
orchestrator, or with its notices off, such steps wait for you.

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

**Merge back and clean up.** A finished queue that ran in a worktree of its own offers "Merge into <base>…" and
"Clean up…". Each asks first. Merge runs where the base branch is checked out (a fast-forward when possible, else a
merge commit) and refuses if that checkout has uncommitted changes or a run going; a conflict is aborted, leaving
everything as it was. Clean up removes the worktree and deletes the branch, only if nothing is uncommitted and the
branch is merged. Only you can do either, from the dashboard; nothing is pushed.

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
nexus review add W3 tmp/review/w3/sheet.png --label "Sheet, round 1"
nexus review add W3 tmp/review/w3/lit.png --before tmp/review/w3/unlit.png --label "Lighting"
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
