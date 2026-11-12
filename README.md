# Nexus

A local dashboard and orchestrator for AI-driven development. Nexus shows each project's queues of work, drives
Claude Code and Codex sessions through them step by step, and carries notes, messages and questions between the
user, a per-project orchestrator agent and the working agents.

- [docs/DESIGN.md](docs/DESIGN.md): concepts, architecture, decisions, phases
- [docs/PROTOCOL.md](docs/PROTOCOL.md): the `.nexus/` files, events and the `nexus` CLI

**Ideas.** Beside the orchestrator, each project has conversations with a thinking partner (the bulb icon): one
session per topic, for thinking something through (gameplay design, the look, what to build next) without starting
any work. A partner reads the whole project and writes only in the project's notes folder (settings: "Ideas"), so it
can record what you decide; "Hand to orchestrator" has it summarize the conversation into the orchestrator's chat,
which turns it into queues.

**Drafts.** Text typed but not sent (to the orchestrator, in a conversation, to a running agent, a step's note, an
answer, the words with an approval) stays in its box when you close the panel, open something else, switch project
or reload, also when a phone's browser drops the tab. Each box keeps its own text; sending clears it, a failed send
keeps it. Drafts live in that browser only (not on the server, not on your other devices) and are dropped after 14
days untouched.

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
the subscription's usage windows.

Per project, the dashboard's settings panel (the gear icon) sets the default runtime; for Claude Code workers the
model, effort, permission mode and extra allowed tools (the project's own `.claude/settings.json` applies as well);
for Codex workers the model, effort, sandbox and what happens when an agent needs to leave the sandbox; the
orchestrator's model and effort; and the defaults. For unattended runs, Claude Code's `auto` permission mode and
Codex's auto review are the recommended settings: routine actions run, risky ones are refused, nobody is asked.
A run can override model and effort when it starts, and the orchestrator chooses them when it starts runs.

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
panel). Running steps finish first and no new step starts meanwhile; then the live worktree moves to `main`,
installs what changed, builds and restarts itself, and the queues it held go on by themselves. Queues paused by you,
stopped by a stop condition, waiting for an answer or for the usage window stay as they are. `--now` stops the
running steps instead of waiting (they continue where they were); `nexus server cancel` gives up waiting. If the
update fails, the old version keeps running and the held queues go on. That includes a new version that does not
come up (it crashes, fails its start-up check or gives no sign within 60 seconds): the old server stops it, moves
the live worktree back, rebuilds and takes the port again. The settings panel then shows "update failed" with the
reason and "rolled back to <commit>", and your devices get a notification. There is nothing to undo by hand: fix the
commit and update again. After a restart the server writes its log to `%APPDATA%\Nexus\server.log`.

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
switch. A small amber dot on the closed picker means another project waits for you.

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
