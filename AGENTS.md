# Nexus: working rules

For every person and AI tool working on Nexus. Rules and pointers only; the design is in
[docs/DESIGN.md](docs/DESIGN.md), the file protocol in [docs/PROTOCOL.md](docs/PROTOCOL.md), what is planned in
[docs/BACKLOG.md](docs/BACKLOG.md).

## The one rule that protects everything else

Nexus is developed with Nexus. The agents working on this repository are run by the **live instance**
(`C:\Code\Nexus-live`, port 4317), a separate worktree. If it stops, they stop.

- Never edit, check out, build or delete anything in `C:\Code\Nexus-live`.
- Never stop, restart or update the server on port 4317, and never run `nexus server update` or `nexus server cancel`:
  deploying is the user's decision.
- For anything you need to try by hand, start a development instance of your own: another port (4318 or above) and its
  own data, `NEXUS_HOME` in a temporary directory, with test projects there, never the user's registered projects.
  Stop it when you are done.

## Who decides what

| Matter | Decided by |
|---|---|
| What Nexus should do, its look and behaviour as the user sees it | The user |
| What to do next | The user approves queues |
| Code structure, naming, tests, refactors | Whoever does the work, said in the report |
| Deploying to the live instance, pushing to GitHub | The user |

## How work is done

- **Language**: every file (code, comments, docs, commit messages, UI text) in English. The user talks in Hungarian;
  agents that talk with the user reply in the user's language.
- **Commits**: on `main` in this checkout, one or more per step, each with a subject line and a body that says why.
  Stage explicit paths (never `git add -A`). Do not push.
- **Before every commit**: `npm run typecheck` and `npm test` pass. If the dashboard changed: `npm run build -w @nexus/web`.
- **Tests**: behaviour in the engine, orchestrator, conversations or lifecycle gets a test against the fake runtimes
  (`apps/server/test/fake-claude.ts`, `fake-codex.ts`, steered by `fake-behaviour.ts`); protocol logic gets a unit
  test. Tests never call a model.
- **Real runtimes**, only when a fake cannot answer the question (a new CLI flag, a protocol detail): the smallest probe,
  with a small model (Claude: `haiku`; Codex: `gpt-6-luna`), in a temporary directory, and say what it cost.
- **Documentation**: a change to a file format, event, API or CLI updates PROTOCOL.md in the same commit; a design
  decision or a finding from building goes to DESIGN.md; what the user does differently goes to README.md.
- **Screenshots** of the dashboard: headless Edge against a development instance. Its narrowest window is 492 px; for
  a phone's width, put the page in a 390 px iframe.

## Rules the code keeps

- **The files are the contract.** Everything durable is a file under a project's `.nexus/`; the server can be
  restarted at any time and rebuilds its view from them.
- **One writer per file.** A session appends only to its own logs; the server writes queue definitions, inboxes and
  the runtime files. Do not add a second writer to any file.
- **Agents never call the server.** They use the `nexus` CLI, which writes files. Only `nexus server …` talks HTTP.
- **Unattended means unasked.** Nothing may wait for a human prompt inside an agent: permissions are set so that a
  refusal is reported, never asked.
- **Remote access stays closed.** Requests that do not come straight from this machine need the access token; writes
  are JSON-only and same-origin. Do not weaken either.
- **Windows first.** The user's machine is Windows: paths with backslashes, PowerShell and Git Bash, `npm.cmd`, CRLF.
  `.gitattributes` keeps LF in the repository.

## Where things are

| Path | What |
|---|---|
| `packages/protocol` | Schemas, the store (`.nexus/` files), state derivation, the user's actions |
| `packages/cli` | The `nexus` command and the Markdown queue importer |
| `apps/server` | HTTP API, the queue engine, the Claude Code and Codex adapters, orchestrator, conversations, updates |
| `apps/web` | The dashboard (React, Vite, Tailwind CSS) |
| `scripts` | `live.ps1` (the live worktree), `autostart.ps1` and `start-hidden.vbs` (start without a window), `dev.ts` |
