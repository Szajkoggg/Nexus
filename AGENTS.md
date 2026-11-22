# Nexus: working rules

For every person and AI tool working on Nexus. Rules and pointers only; the design is in
[docs/DESIGN.md](docs/DESIGN.md), the file protocol in [docs/PROTOCOL.md](docs/PROTOCOL.md), what is planned in
[docs/BACKLOG.md](docs/BACKLOG.md).

## The one rule that protects everything else

Nexus is developed with Nexus. The agents working on this repository are run by the **live instance**
(`C:\Code\Nexus-live`, port 4317), a separate worktree. If it stops, they stop.

- Never edit, check out, build or delete anything in `C:\Code\Nexus-live`.
- Never stop, restart or update the server on port 4317, and never run `nexus server update` or `nexus server cancel`:
  deploying is the user's decision. (The orchestrator may run them when the user asks for it in the chat, and only
  then; workers and thinking partners never may, and the CLI refuses them.)
- For anything you need to try by hand, start a development instance of your own: another port (4318 or above) and its
  own data, `NEXUS_HOME` in a temporary directory, with test projects there, never the user's registered projects.
  Stop it when you are done.

## Who decides what

| Matter | Decided by |
|---|---|
| What Nexus should do, its look and behaviour as the user sees it | The user |
| What to do next | The user approves queues |
| Code structure, naming, tests, refactors | Whoever does the work, said in the report |
| Deploying to the live instance, pushing to GitHub | The user (a deploy pushes the deployed main; agents never push) |

## How work is done

- **Language**: every file (code, comments, docs, commit messages, UI text) in English, Nexus's working language,
  with one exception the user decided: the text of queues (title, description, goals, acceptance, stop conditions,
  checks, review notes) follows the reader's language set in Nexus's settings, because the user reads and approves it;
  ids and YAML keys stay English. What agents write to the user (chat, step summaries, questions, progress lines)
  follows the reader's language too. The user talks in Hungarian; with no reader's language set, agents that talk with
  the user reply in the language the user writes in.
- **Commits**: one or more per step, each with a subject line and a body that says why. Stage explicit paths (never
  `git add -A`). Where they go depends on the queue: a queue without a worktree of its own commits on `main` in this
  checkout; a queue with its own worktree commits on its own branch in that worktree, its integration step merges the
  base into that branch, and the base then only moves to the result by a fast-forward. A survey-only run commits
  nothing. Agents never rebase and never push.
- **Before every commit**: `npm run typecheck`, `npm run lint` and the tests of the files you changed pass
  (`npm run test:files -- <files>`). If the dashboard changed: `npm run build -w @nexus/web`. Fix a lint finding rather
  than silence it (docs/design/checks.md, "Static analysis"). The whole suite (`npm test`) is no commit's check: it runs at the
  end of a step, as the queue's checks, and Nexus runs them itself after the worker's `nexus step done`, waiting for the
  machine as long as another full run takes; the worker neither runs nor waits for them, and gets their output only when
  one fails (a check-fix round, docs/protocol/checks.md "Checks run by Nexus"). Only where a step's opening does not say Nexus
  runs its checks (a step an older server opened, work started by hand) does the worker run them at the step's end and
  report them with `nexus check`; its full run waits for another checkout's to end, never starting beside it.
- **Run control and lifecycle code** (after a queue that touched it the orchestrator offers the `lifecycle` template):
  the engine, the scheduler and the runtime adapters, in `apps/server/src`: `engine.ts`, `scheduler.ts`,
  `agent-host.ts`, `claude.ts`, `codex.ts`, `recurring.ts`, `lifecycle.ts` (updates, restarts), `handover.ts` (the
  hand-over), `deploy-plan.ts` (the planned update), `check-runs.ts` (the checks Nexus runs, resumed after a restart),
  `capacity.ts` (the machine's grants to processes, freed when a process ends) and `integration.ts` (the merges Nexus
  makes without a model).
- **Load tool**: `node scripts/load-tests.mjs` runs test files repeatedly beside busy-loop processes (README.md, "Running");
  it is Nexus's tool for reproducing a failure under load, and the one Nexus's own fix queues use.
- **Tests**: behaviour in the engine, orchestrator, conversations or lifecycle gets a test against the fake runtimes
  (`apps/server/test/fake-claude.ts`, `fake-codex.ts`, steered by `fake-behaviour.ts`); protocol logic gets a unit
  test. Tests never call a model.
- **Real runtimes**, only when a fake cannot answer the question (a new CLI flag, a protocol detail): the smallest probe,
  with a small model (Claude: `haiku`; Codex: `gpt-6-luna`), in a temporary directory, and say what it cost.
- **Documentation**: a change to a file format, event, API or CLI updates the protocol in the same commit; a design
  decision or a finding from building goes to the design; what the user does differently goes to README.md.
  PROTOCOL.md and DESIGN.md are indexes with a table of contents; the text is in topic files
  (docs/protocol/, docs/design/). New text goes into the topic file its section belongs to (find it in the contents,
  or `nexus doc docs/DESIGN.md` or `nexus doc docs/PROTOCOL.md` and the file named there). A new topic goes into a new file, listed in the
  contents. A topic file that has grown past about 40 KB is split along its headings, and the contents with it.
  `scripts/test/doc-layout.test.ts` checks the contents and every relative link and anchor, and warns about a
  large file; it also checks the prose (outside code blocks): a backticked repository path (`scripts/capture.ts`) must exist,
  and a backticked `nexus <command> [<subcommand>]` must be one the CLI's help names. A name the text means although it
  does not exist (another project's file, a layout not taken) goes into `ABSENT_ON_PURPOSE` in `scripts/doc-layout.ts`,
  with why. Cite a section as `docs/protocol/<file>.md, "Section"` (or docs/design/) or `<file>#anchor`, never by line number.
- **Agents: lines**: a commit that changes something agents rely on (a CLI command, a briefing, the protocol, or a
  file an agent reads or writes) carries a line `Agents: <what changed>` in its message, one per change, written for
  an orchestrator whose briefing is older. At a deploy, every project's orchestrator is told these lines.
- **Screenshots** of the dashboard: `node scripts/capture.ts <views.yaml>` takes the listed views, the afters and
  (from the step's base commit) the befores, each on its own development instance with the fake runtimes; headless
  Edge by hand only for a view it cannot take. Widths: 492 px (the narrowest window), 390 px in an iframe for a
  phone, 1440 px for a desktop. Register them as `nexus help review` says (keys and roles).
- **Layout faults** (lines through boxes, overlapping boxes, text cut short) are checked on designs and pictures, not
  left to be found in use: `node scripts/layout-faults.ts <mockup file | dev instance URL>` (README.md).

## Refactoring

The closing refactoring step of a queue also runs `npm run knip` and fixes its findings in the files the queue changed
(`git diff <base>..HEAD --name-only`): an export nothing imports loses `export`, or goes if nothing uses it; a file
loaded only by its path becomes an entry in `knip.json`. Findings in other files are reported, not fixed: they belong
to a maintenance queue.

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
