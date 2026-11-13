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

**Back.** The back button (on a phone also the back gesture) closes what is open on top: a chat, the Ideas panel or
a conversation in it, Settings, a queue or step, a review image. With nothing open it leaves Nexus. Escape does the same on a
computer.

**On a phone** (and in any window narrower than 1024 px) a bar at the bottom has four tabs: **Orchestrator** (the
chat), **Waiting** (what waits for you in all projects, with the count), **Queues** and **Ideas**. One tap switches.
The top line has the project picker, what runs in the project, and the settings gear; the update, the usage,
notifications and remote access are in Settings there. Switching tabs is not a step for Back: Back closes what is
open (a step, Settings, a conversation) and then leaves. After switching projects the Waiting tab shows. A step or
queue opens as a full-screen sheet with ‹ and ✕ at the top and says where it stands ("2 of 6 waiting"). A question's
options are buttons right in its waiting card: a tap opens the question with that option chosen, and **Answer**
confirms it (words of your own can go with it). The chat's box is one line with a round Send.

**A queue** on the project page shows one status ("running · SF3", "paused · B2", "stopped at W4c", "waiting for
your review · UX2"…), a progress line with a segment per step, and its steps one line each, in two columns on a
computer. "Running" means a run is really at work; a queue whose run is paused says so. The step that matters is
highlighted with why and its action (**Continue…**, **Review…**, its questions). On a phone the list is one column, the
finished steps before it and the steps after the next three are folded into one line each; a tap unfolds them.

**On a wide screen** (1280 px and more) a queue or step opens on the left and the orchestrator or Ideas on the
right, both at once, with the queue list between them: click another step and the chat stays open.

**One action bar.** Every queue and step panel ends with the same bar, always in sight however long the panel is:
the main action on the right (Accept and go on, Approve revision N, Continue, Answer), the second left of it (Fix
it…), and everything else under ⋯ (Reject, a note with the acceptance, your words with an approval, Withdraw
approval, the queue's "After each step"). What an action needs (Fix it's text, a reason) opens just above the bar.
The header says where you are, what it is and its status, with ✕ at the top right. The chats follow the same rule:
Orchestrator | Ideas on the left, ⋯ and ✕ on the right; "New conversation" (which makes the orchestrator start over)
and showing the tool calls are under ⋯.

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

**Withdrawing an approval.** A queue approved but not started yet has "Withdraw approval…" under ⋯ in its bar (with
an optional reason): it goes back to proposed and waits for your approval again; the earlier approval stays on record.
Once a queue has started, pause or stop it instead. Only you can do this, from the dashboard.

**Drafts.** Text typed but not sent (to the orchestrator, in a conversation, to a running agent, a step's note, an
answer, the words with an approval) stays in its box when you close the panel, open something else, switch project
or reload, also when a phone's browser drops the tab. Each box keeps its own text; sending clears it, a failed send
keeps it. Drafts live in that browser only (not on the server, not on your other devices) and are dropped after 14
days untouched.

**Themes.** Settings (the gear icon), "This browser", Theme: **Graphite** (dark, the default), **Paper** (light),
**Honey** (warm dark), or **Follow the system** (Paper when the system is light, Graphite when it is dark, changing
with it). It applies at once and is kept in that browser only, for every project; your phone and your PC each keep
their own.

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

A queue stopped by a stop condition goes on only when you lift the stop. Either approve a new revision the
orchestrator drafted (a start then begins at the first pending step), or, when the cause was outside the queue,
press Continue on the queue: the stopped step runs again in its session. The orchestrator may propose continuing;
its proposal shows beside Continue. It does housekeeping itself: it skips a step a new revision replaced or that was
done elsewhere, closes a halted run whose steps are all done, and cancels a queue that is no longer needed (you get a
notification). Each queue and step lists these changes: who, when and why. Approving, lifting a stop, marking work
done and reopening a finished step stay yours.

The stop box shows what the stopped step left: its own commits, and the uncommitted changes in the checkout (which
are not necessarily that step's, and which Nexus never cleans). When the step committed, Continue and the approval
of a new revision ask you first: **Keep** (the commits stay; with "push accepted steps" on they go out with the next
accepted step's push, otherwise they stay local in the branch) or **Discard** (the stop stays, and the orchestrator
proposes a revision whose first step reverts those commits; approving it lifts the stop). A worker that stops
commits what is consistent and leaves no uncommitted changes behind.

Per project, the dashboard's settings panel (the gear icon) sets the default runtime; for Claude Code workers the
model, effort, permission mode and extra allowed tools (the project's own `.claude/settings.json` applies as well);
for Codex workers the model, effort, sandbox and what happens when an agent needs to leave the sandbox; the
orchestrator's model and effort; and the defaults. For unattended runs, Claude Code's `auto` permission mode and
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

`project add` creates `.nexus/` in the project with its own `.gitignore`, so the project's files are untouched. The
list of registered projects is in `%APPDATA%/Nexus/projects.yaml` (`NEXUS_HOME` overrides the directory).

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
untick "Push the deployed main to GitHub after an update" in the settings panel. Only you can change it, from the
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

## Remote access

The server listens on this PC only. Everything from this PC works without signing in; anything that comes through a
proxy or from another address needs the access token once (it sets a cookie for a year).

1. Install Tailscale on the PC and sign in (`winget install tailscale.tailscale`); install the Tailscale app on the
   phone and sign in with the same account.
2. In the Tailscale admin console, under DNS, turn on MagicDNS and HTTPS certificates.
3. Publish Nexus to your tailnet only: `tailscale serve --bg 4317` (not `funnel`, which would make it public).
4. On the PC, open the dashboard's Remote access panel (the phone icon in the header): it shows the address, the
   token and a QR code. Scan it with the phone: it opens Nexus and signs in.
5. On the phone, add Nexus to the home screen (iPhone: Share, Add to Home Screen), open it from there and turn on
   the bell: notifications arrive even with Nexus closed. "Send a test notification" in the panel checks it.

On a narrow screen the project tabs give way to a picker: the current project's name at the top left, with its
"waiting for you" count and running dot. Tap it for the list of all projects (each with its count and dot), tap one to
switch. The header's tools move to a second row there.

The inbox button in the header counts what waits for you in all projects (questions, approvals, steps in review,
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
