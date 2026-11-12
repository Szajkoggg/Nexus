# Nexus

A local dashboard and orchestrator for AI-driven development. Nexus shows each project's queues of work, drives
Claude Code and Codex sessions through them step by step, and carries notes, messages and questions between the
user, a per-project orchestrator agent and the working agents.

- [docs/DESIGN.md](docs/DESIGN.md): concepts, architecture, decisions, phases
- [docs/PROTOCOL.md](docs/PROTOCOL.md): the `.nexus/` files, events and the `nexus` CLI

**Status: phase 4** (orchestrator chat). Each project has an orchestrator in the dashboard's chat: it reads the
project, drafts queues for your approval, starts and steers runs (choosing to continue a session that has the
right context, or a fresh one), answers workers' questions whose answer is settled and passes the rest to you, and
tells you when a run halts or finishes. It can read everything and edit nothing.

Phase 3 (Claude Code adapter and queue engine): An approved queue can be started from the dashboard:
Nexus launches Claude Code (with your own subscription login), drives it step by step, puts your notes into each
step's opening, delivers messages and answers into the running turn, holds on questions and reviews, and pauses,
stops and resumes on request. The dashboard shows the agent's activity per step, each session's context fill and
the subscription's usage windows. The orchestrator chat comes in phase 4.

Per project, `runtimes.claude` in `.nexus/project.yaml` sets the default `model`, the `permission_mode`
(default `acceptEdits`) and extra `allowed_tools` for launched sessions; the project's own `.claude/settings.json`
applies as well.

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

## Running

```sh
npm start        # builds the dashboard, serves it and the API on http://127.0.0.1:4317
npm run dev      # development: API on :4317, dashboard with hot reload on http://localhost:5173
npm test         # protocol, importer, engine and orchestrator tests (the last two run a fake `claude`)
npm run typecheck
```

`NEXUS_PORT` and `NEXUS_HOST` change where the server listens (default `127.0.0.1:4317`, this machine only).

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
