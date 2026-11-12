# Nexus

A local dashboard and orchestrator for AI-driven development. Nexus shows each project's queues of work, drives
Claude Code and Codex sessions through them step by step, and carries notes, messages and questions between the
user, a per-project orchestrator agent and the working agents.

- [docs/DESIGN.md](docs/DESIGN.md): concepts, architecture, decisions, phases
- [docs/PROTOCOL.md](docs/PROTOCOL.md): the `.nexus/` files, events and the `nexus` CLI

**Status: phase 1** (protocol and read-only dashboard). Agents started by hand can report through `nexus`; the
dashboard shows every registered project's queues live. Launching agents, notes from the dashboard and the
orchestrator chat come in the next phases.

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
npm test         # protocol and importer tests
npm run typecheck
```

`NEXUS_PORT` and `NEXUS_HOST` change where the server listens (default `127.0.0.1:4317`, this machine only).

## Reporting from an agent (until Nexus launches them itself)

```sh
nexus attach --runtime claude --queue W --title "cliffs worker"   # prints a session id
export NEXUS_SESSION=<id>                                           # or pass --session <id> each time
nexus status
nexus step start W3
nexus step progress W3 "Support graph built" --pct 40
nexus review add W3 tmp/review/w3/sheet.png --label "Sheet, round 1"
nexus step done W3 --summary "No floating body on any fixture"
```

`nexus --help` lists every command.

## Layout

| Path | What |
|---|---|
| `packages/protocol` | Schemas of every file and event, the store (reading and writing `.nexus/`), state derivation |
| `packages/cli` | The `nexus` command and the Markdown queue importer |
| `apps/server` | HTTP API, file watching, live change notifications over WebSocket |
| `apps/web` | The dashboard (React, Vite, Tailwind CSS) |
