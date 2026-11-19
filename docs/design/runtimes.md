# Runtimes and findings from building

Part of [the design](../DESIGN.md).

## Runtimes and authentication

- **Claude Code**: Nexus spawns the unmodified `claude` binary in print mode with stream-json input and output and
  a session id it chooses, signed in with the user's own Max subscription. It does **not** use the Agent SDK with
  subscription login (Anthropic's documentation does not cover that for personal tools; the SDK is for API keys).
- **Codex**: Nexus runs `codex app-server` over stdio (threads, turns, steer, interrupt, token usage). The
  app-server is marked experimental, so Nexus pins the Codex version it was tested with and generates its types
  from that version. Fallback: `codex exec --json` with `exec resume` (no steering; messages wait for the next
  step turn). Signed in with the user's ChatGPT login.
- **Unattended permissions**: each project sets the permission mode per role and runtime. Workers usually need
  edit and shell rights in their worktree, and write access to the main checkout's `.nexus/` (for Codex, an added
  writable root). A Codex worker in a queue's own worktree also gets that worktree's git paths as writable roots, so
  that it can commit there (see the findings).
- Hooks are installed per project only for the observe-only path and for session-start context; the Nexus-launched
  path does not depend on them.

## Findings from building phase 3

- **Context fill and usage limits are in the stream.** Every `assistant` message carries its usage (input, cache
  creation and cache read tokens: the context in use); the `result` gives the model's `contextWindow`; a
  `rate_limit_event` gives the 5-hour and 7-day windows' utilization and reset times.
- **A message with `priority: "next"` reaches a running turn** after its current tool calls, without interrupting it;
  a plain message sent during a turn becomes the next turn.
- **The CLI starts turns by itself** when a background task it started finishes. The engine therefore opens a step
  only when the session is idle, and re-decides after every turn.
- **Claude Code blocks long foreground `sleep`** and the agent moves such waits to the background. Nothing for Nexus
  to do, but it explains extra turns in the activity.
- **A killed server takes its `claude` children with it** (their stdin closes). On restart, any session process still
  alive is ended before a resume, and running queues come back paused.
- **Every write to a child's input needs an error listener** (queue CR). A process that has exited while the server
  has not yet seen its exit (the server busy) fails the next write with EPIPE, also a short line on Windows, emitted as
  an error event of its input; unheard, it ends the server. On 2026-11-18 the model list's `initialized` to a Codex
  that had answered and exited did so. Once the exit is seen, Node has destroyed the input and a write fails only to
  its callback; reading the output of an exited process ends it, no error.

- **Codex has the same moves.** `turn/steer` reaches a running turn (checked live), `thread/resume` continues a
  thread with its context (checked: the agent recalled the previous queue), token usage and the context window
  arrive per request, and the rate limits arrive as a weekly window.
- **Codex runs commands in PowerShell**, where npm's `nexus.ps1` is blocked by the execution policy: Nexus therefore
  puts its own `nexus.cmd` first on the agents' PATH. The sandboxed shell can run it and write to `.nexus/`.
- **Codex can commit in a worktree only with its git paths writable.** A linked worktree's git directory lies in the
  main checkout's `.git`, outside the worktree, so under `workspace-write` `git commit` failed on
  `.git/worktrees/<name>/index.lock` (probe with Codex 0.167.2 on Windows, `gpt-6-luna`). With exactly four paths
  added as writable roots it committed without an escalation request: the worktree's own git directory
  (`.git/worktrees/<name>`: index, HEAD) and the repository's `objects`, `refs` and `logs`. The rest of `.git`
  (config, hooks) stays read-only. Nexus asks git for the paths (`rev-parse --git-dir --git-common-dir`) and adds them
  only when the git directory lies outside the working directory; the roots work both in the thread's config
  (`sandbox_workspace_write.writable_roots`) and in a turn's sandbox policy, and Nexus sends both.

- **A turn's tokens and cost, per runtime** (probes 2026-11-14, two turns in one session each). Claude Code
  (2.1.323, haiku; $0.0066): `result.usage` is the turn's own (the second turn's output was 172 tokens while the
  cumulative `modelUsage` said 175), and `total_cost_usd` runs on through the process ($0.00325, then $0.00659), so a
  turn's cost is the difference from the previous result; a resumed process's total starts with turns this process
  never saw, so its first turn's cost is left unknown. `result.usage` covers the main agent loop only (subagents'
  tokens are in `modelUsage`). Codex (0.167.2, `gpt-6-luna`; about 34k tokens, mostly cached): every
  `thread/tokenUsage/updated` carries the thread's running `total` and `last`, the figures of one model request
  (a turn with tool calls has several), so a turn's tokens are the difference of `total` between its start and end;
  when the start is unknown (a resumed thread), the turn's `last` figures are summed. Codex reports no cost. The
  adapters normalize both to `input` (not from the cache), `output`, `cacheRead` and `cacheCreation`: Codex's
  `inputTokens` includes `cachedInputTokens`, Claude Code's `input_tokens` does not.

- **Workers cannot write under `.nexus` with their file tools, and only Claude Code workers** (decided 2026-11-13; a
  Honeycomb worker had edited a queue file by hand). Claude Code workers get deny rules for Edit and Write on the
  project's `.nexus` by its absolute path (`Edit(//c/…/.nexus/**)`, `Write(//c/…/.nexus/**)`). A probe (haiku,
  dontAsk, a temporary project, the rules from the code; $0.007) showed Write and Edit refused there ("File is in a
  directory that is denied by your permission settings."), both working elsewhere in the project, Read still allowed,
  and `nexus log` recording its event. File-tool rules do not cover the shell: a Bash redirection or a script can
  still write there. The project setting `defaults.protect_nexus` turns the rules off.
  Codex cannot be kept out, on this machine (probe with Codex 0.167.2 on Windows, `gpt-6-luna`, about 136k tokens,
  mostly cached): `workspace-write`, the sandbox mode Nexus uses, has no read-only subpath of its own (only `.git`,
  `.codex` and `.agents` are kept read-only), and a permission profile sent with it is ignored (the older sandbox
  settings win, as Codex's documentation says). A permission profile alone (Beta; `extends = ":workspace"`, `.nexus`
  read, the session's own folder write, because Codex sandboxes every process it starts, the nexus CLI included)
  made the Windows sandbox refuse every command: "windows elevated sandbox cannot reopen writable descendants under
  read-only carveouts directly; refusing to run unsandboxed". Without that carve-out the CLI could not record events.
  So Codex workers are unchanged.

- **An orchestrator on Codex can be kept to its drafts and its own event log, by a permission profile** (queue OC,
  decided by the user 2026-11-16). Probes with Codex 0.167.2 on Windows (elevated sandbox), a temporary project
  outside the temp folder (`:workspace` makes the system temp folder writable, so a project under it proves
  nothing): first `codex sandbox -P <profile>` with a script that tries every write (no model), then two `gpt-6-luna`
  turns that tried the same with the file tool (apply_patch) and the shell: `codex exec` (199k input tokens, 191k of
  them cached, 636 output) and `codex app-server` (118k input, 113k cached, 511 output; Codex reports no cost).
  - A profile with no writable ancestor works where the carve-out above failed: `extends = ":read-only"` and
    `filesystem = { "<root>/.nexus/drafts" = "write", "<root>/.nexus/sessions/<orchestrator>/events.jsonl" = "write" }`
    (a single **file** may be granted), the working directory the project's root. Writable: the drafts and that one
    file. Refused: the project's root and its files, `project.yaml`, the session's own `session.yaml` (its role) and
    `inbox.jsonl`, another session's inbox, `sessions/user/events.jsonl`, `queues/*/queue.yaml` (approvals, Continue),
    anything outside the project (`away.yaml` lives in NEXUS_HOME), and the temp folder. The `nexus` CLI works inside
    it (`queue draft --template`, an event appended), and `--session user` cannot write in another session's name. Raw
    lines in its own events.jsonl add nothing: the loader drops events that claim another session and user-only
    events from a session whose role is not `user`.
  - Through the app-server, Nexus's way: `thread/start` with `config: { default_permissions, "permissions.<name>.extends",
    "permissions.<name>.filesystem" }` and no `sandbox` (the older settings would win); the thread then reports
    `workspaceWrite` with exactly those two roots, and the working directory stays read-only. A turn must not send a
    `sandboxPolicy` either.
  - The elevated sandbox leaves its grant on the file as ACL entries (`CodexSandboxUsers` and a per-grant SID); a
    later `:read-only` or `:workspace` sandbox elsewhere still cannot write the file.
  - Rejected: `workspace-write` with `.nexus/drafts` as the working directory alone writes only the drafts (verified),
    but the CLI then needs `.nexus/sessions/<orchestrator>/` writable, and that folder holds `session.yaml`: the
    orchestrator could rewrite its role to `user` and act as the user.
  - **Loopback stays open in every Codex sandbox**: with `network.enabled = false`, and with `:read-only`, a public host
    was refused (EACCES) but `fetch("http://127.0.0.1:<port>/")` reached a test server, and a sandboxed script could
    send an `Origin` header of its choosing. The server's write guard (Origin's host equal to Host, JSON, no
    `Sec-Fetch-Site`) lets such a request through (read from the code; the live server was not probed). So any agent
    with a free shell on this machine (Codex workers, Claude Code workers, an orchestrator on Codex) can do the user's
    dashboard actions over HTTP; the orchestrator on Claude Code cannot (it runs only `nexus` and read-only git). The
    user decided: the gap is closed by a queue of its own, and the orchestrator is not switched to Codex until it is.
  - Built in OC2: `CodexOptions.permissions` (a profile in place of `sandbox` and `writableRoots`), the orchestrator's
    launch by `orchestrator.runtime`, its Codex briefing without helpers (it does their work itself, by their own
    checklists in short), and a fresh session at a runtime switch (no conversation moves between runtimes; the old
    chat stays above). A switch waits for the turn running then to end: two orchestrator processes at once could act
    twice. Building it found a lost message in the Codex adapter: a `turn/steer` refused because the turn had just
    ended came back after `turn/completed` had found the queue empty, so the message waited for a next one; it now
    starts its own turn.
  - **A resumed thread keeps the profile** (probed in OC2's review round, 2026-11-16, Codex 0.167.2, `gpt-6-luna` at
    effort low, a temporary project outside the temp folder): through Nexus's own `Orchestrator` against the real
    Codex, a wrapper logging the JSON-RPC lines. A turn on `thread/start`, the process ended, then a new
    `Orchestrator` (a restarted server) resumed the same session with `thread/resume`, sent with the same `config`
    and no `sandbox`; both answers reported `activePermissionProfile: nexus_orchestrator` (extends `:read-only`) and
    a `workspaceWrite` sandbox with exactly the two granted paths. In the resumed thread a file in the project's
    root (apply_patch: "writing outside of the project; rejected by user approval settings"; and `Add-Content`:
    access denied) and the session's `session.yaml` (access denied) were refused; the draft was written. The first
    run found that a fresh project has no `.nexus/drafts` and the sandbox cannot make it ("Failed to create parent
    directories"), so the server now makes the folder before Codex starts, as it does the events file. Cost: two
    runs, each a short turn (18.4k input tokens, 5 output) and a turn of four actions (113k input, 93k of them
    cached, 364 and 445 output); no cost reported.

- **Remote access needs no open port.** The server keeps listening on 127.0.0.1; Tailscale Serve relays the tailnet's
  https requests to it. Requests relayed by a proxy count as remote and need the access token; this machine does
  not. Push works through the browsers' own push services (Web Push with VAPID), so a phone gets notifications with
  Nexus closed once it is installed to the home screen.

- **Nexus updates itself between steps.** The live instance runs from its own worktree on a detached commit; an
  update holds every running queue at the end of its step, moves the worktree, builds and starts its successor,
  which waits for the port and resumes only the queues the update held. On Windows two details mattered: the
  server writes its own log (a shell's `>>` locks the file against the successor), and the line endings are fixed
  by `.gitattributes` (npm rewrites bin scripts, which made the worktree look changed).
- **A successor that is merely started is not up.** Until 2026-11-12 the predecessor started its successor and exited
  300 ms later, whatever became of it: a successor that crashed on start, could not load a project or never got the
  port left nothing running, and the successor recovered and resumed runs while the predecessor might still be
  writing. Now the successor proves it is up (a smoke check) before the predecessor goes, and it touches nothing until
  the predecessor has let go (see ["Updating Nexus"](updates.md#updating-nexus)). Checked end to end on a development instance: the predecessor
  exited about 0.3 s after the successor's ready signal, and the successor's update log showed both servers' lines.
- **Rolling back is fast, and the old server never has to restart.** A probe used a detached worktree of this
  repository as a live instance on port 4319 and updated it to a branch whose server throws at start. The successor
  crashed within a second. About 2 s later the instance answered on 4319 again, from the same process, on its
  previous commit, and the queue the update had held ran to its end. Three details mattered:
  - A crash is seen at once through the child's exit event, without waiting for the time limit.
  - `node_modules` has to be compared with the lock the update installed, not the one it started from.
  - On Windows a pid can still show as a process for a few seconds after it exits, so the probe recorded every pid
    and checked them again after killing.
- **The hand-over variable leaked to agents and their test servers.** After the live instance's first hand-over
  (2026-11-13, 00:22), it kept `NEXUS_HANDOVER` in its environment, and every agent it started inherited it. At
  00:24:52 a worker's test started `main.ts` with its own environment. `withdraw.test.ts` did that, and so did
  `handover.test.ts` for a plain start; which one ran then is not recorded. That test server took the
  live predecessor's folder (`%APPDATA%\Nexus\handover\…`) for its own, passed its smoke check, and overwrote
  `ready.json` there. No harm followed, because that hand-over was already released. But the test server then took
  over as if it were the live successor. During a real update it could have answered for the real successor. The
  same test on the old code, with `NEXUS_HANDOVER` pointing at a decoy folder, wrote `ready.json` into the decoy. The
  whole suite on the new code, inheriting the same decoy, wrote nothing there (see ["The variable is consumed once"](updates.md#updating-nexus)).
- **The predecessor named the wrong commit.** `predecessor.json` took its version after the worktree had moved, so
  the successor's log said "(was <the new commit>)". It now names the commit the update started from. The push probe
  showed it. That probe was a clone of this repository, not a worktree, because a worktree shares the real `origin`.
  The clone's `origin` was a temporary bare repository. The probe deployed to it, was rejected by it once someone else
  had pushed, and had the setting off.
- **Screenshots at phone width need an http parent page.** In a 390 px iframe inside a `file://` page, the settings
  panel rendered without its Nexus section: `/api/server` did not reach the dashboard there, while the project API
  did. The same iframe inside a page served over http from 127.0.0.1 shows it, so phone-width screenshots use an http
  parent.
- **Notices held by an update waited for the next write.** On 2026-11-13 the live instance updated from 6f7d2e6 to
  21bf813 while queue N3 ran. During the drain, the user approved SP (23:17 UTC) and N3 finished (23:22:05). Both
  notices were held, as they should be while draining. The successor took over at 23:22:05, but nobody told the
  orchestrator. Its notices only run in a project's change pass, and that pass ran only when a watcher saw a file
  change. The watchers ignore the files already there (`ignoreInitial`), so nothing ran until the user wrote in the
  chat at 23:23:22 ("did you get a notice about the update?"). That write delivered the held notices 77 s late, inside
  the user's own turn. Their turn did not start by itself.

  The same pass also told 19 approvals at once, some hours old, because approval notices were new in that version
  and nothing had marked old approvals as told. Now every server, once active, runs one pass over every project, and
  so does every update that settles (up and pushed, failed, cancelled). An orchestrator that ran the update is told
  its outcome, keyed by the update's id that `predecessor.json` carries. A new kind of notice still tells everything
  it covers since the orchestrator session began, the first time it runs.

- **Windows does not replace a file another process has open.** Nexus writes its files atomically (a temporary
  file, then a rename over the target). On Windows the rename fails with `EPERM` while any other process has the
  target open, even only to read it: an agent's `nexus` CLI reading `run.yaml`, a test polling it, the other server of
  an update, the search indexer. Measured on 2026-11-13: a rename onto a file another Node process held open failed
  with `EPERM`, and went through once it was closed. The engine took such a failure for an engine error and halted the
  run; under load (a full test suite beside CPU-bound processes) the server-process tests timed out now and then for
  this reason (queue SF, step SF3). Every such rename now tries again for up to 2 s (`renameRetrying` in
  `packages/protocol/src/store.ts`); other errors are thrown at once.
- **Queue drafts go through files, not heredocs.** On 2026-11-12 an orchestrator could not upload a long queue
  revision: `cd … && nexus queue draft - <<'EOF'` was refused in `dontAsk` mode (a chained command does not match
  `Bash(nexus:*)`), and the heredoc alone (about 8.5 KB; about 7 KB worked) broke in Claude Code's Bash wrapper on
  Windows, with YAML lines reaching the shell as commands. The orchestrator now writes `.nexus/drafts/<queue>.yaml`
  and runs `nexus queue draft` on that file, and the heredoc form left its briefing. A probe (Claude Code, `haiku`,
  `dontAsk`, the orchestrator's exact lists, about $0.02 for three runs) showed that `Edit(<path>/**)` alone also
  permits `Write` there, creating missing directories, while `Write(<path>/**)` alone permits nothing; Nexus keeps
  both rules so the allow list says what is meant. `Write` and `Edit` must not be disallowed, since a disallow rule
  beats an allow rule.
- **Git for Windows cannot remove a worktree with node_modules in it** unless `core.longpaths` is on: it drops the
  worktree from its list, deletes what it can and fails with "Directory not empty" on paths beyond 260 characters
  (seen 2026-11-14, the capture tool's base worktree under the temporary folder). The capture tool asks git a few
  times, then deletes the rest with Node's `rmSync` (long paths, retries; junctions not followed) and prunes.
- **Pictures in chat messages: Claude Code opens a path, Codex needs an image item.** Probed on 2026-11-14 (queue CH2)
  through Nexus's own adapters, with the chat roles' exact permissions, in a temporary project, with a PNG showing the
  number 47 at `.nexus/uploads/…png` and the message "What number is shown in this picture? … \n<path>". Claude Code
  2.1.323 (`haiku`, effort low, `dontAsk`) used `Read` on the path and answered "47", as the orchestrator and as a
  partner ($0.0044 each). Codex 0.167.2 (`gpt-6-luna`, effort low, a partner's `workspace-write` sandbox in the
  notes folder, approvals `never`) did not try to open it: "I can't access that image path from here" (about 17k
  input tokens). Given the same text with a `localImage` item for the path, it answered "47" (about 16k input tokens,
  mostly cached). So the message keeps the path on its own line for both, and the Codex adapter adds the item for
  every such line of an uploaded picture. An item whose file is missing does not fail the turn: the model is told the
file is missing ("I can't read the image because the file is missing"); the adapter leaves such a line as text only.
Total cost of the probes: about $0.009 of Claude usage (two turns) and, for Codex (gpt-6-luna, seven one-turn
threads), about 117k input tokens, about 90k of them cached, and under 100 output tokens.

## The web for thinking partners (queue WB)

Probed on 2026-11-15 with Claude Code 2.1.323 (`haiku`) and Codex 0.167.2 (`gpt-6-luna`), in temporary directories,
against a local test server on port 4391. Cost: about $0.07 of Claude usage (six short turns, $0.005 to $0.023
each) and seven short Codex turns on the ChatGPT subscription (20k to 40k tokens each, most of them cached).

- **Claude Code's deny rules hold, by name only.** `WebFetch(domain:localhost)`, `(domain:127.0.0.1)` and a wildcard
  `(domain:*.x)` refused the fetch (`permission_denied`, also inside a sub-agent). But a name that merely resolves to
  127.0.0.1 (`127.0.0.1.nip.io`) was not denied, and WebFetch connected to the local port (its upgrade to https failed
  the handshake there, which is luck, not protection). So `fetch` also gets a `PreToolUse` hook (web-guard.ts) that
  resolves the host and refuses local, private, Tailscale and the machine's own addresses; probed: the nip.io name and
  `[::1]` were refused by the hook, example.com was fetched. The machine's changing addresses are the hook's to check,
  not rules': a changed rule would restart the partner's process.
- **In Claude Code 2.1.323 the main agent has no WebFetch of its own**: it calls the `web-fetch` sub-agent, which
  fetches. The rules and the hook apply inside it, so nothing more is needed. WebSearch is a deferred tool the model
  loads with ToolSearch, which `dontAsk` allows.
- **A Codex thread searches the web without any setting** (Codex's default), and with `web_search: "disabled"` it still
  searched, through the `codex_apps` MCP server's search connector, an app of the user's ChatGPT account. Worse, the
  user's own MCP servers run outside the sandbox: `node_repl` fetched `http://127.0.0.1:4391` without an approval, so a
  Codex partner could already read the local API before this queue, whatever its sandbox. Thread config overrides
  turn them off: `features.apps: false`, `features.plugins: false` (the plugins' servers: computer use, Blender) and
  `mcp_servers.<name>.enabled: false` for each top-level server (`config/read` names them; an override for a name
  that does not exist fails the thread start: "invalid transport"). The user decided that partners run so at every
  level; workers and the orchestrator still got the user's tools then (see below, queue FX).
- **Codex's search modes**: `cached` searches; `live` also opens pages (an `openPage` action). Both run at OpenAI, so
  no local address is reachable through them. A webSearch item's query is empty when it starts; the chat line is
  written at its completion, from its action.

## The user's Codex tools for workers (queue FX)

Decided on 2026-11-15 with the queue's approval, after WB's probe: a Codex worker got the user's MCP servers,
plugins and apps from `~/.codex/config.toml`, and an MCP server runs outside the sandbox (WB saw `node_repl` fetch a
local port without an approval), so a Codex worker could reach this machine's Nexus API on port 4317.

- **Off by default, kept by name.** A Codex worker's thread starts as a partner's does (`withoutUserTools`):
  plugins and apps off, every MCP server `config/read` names off, except those the project lists in
  `runtimes.codex.mcp_servers` (project only, empty by default: a project whose Codex workers need one, Blender in
  Honeycomb, names it in its settings). Plugins and apps are never kept: a plugin's servers (computer use, Blender)
  come and go with the plugin, and the apps' connectors searched even with web search off.
- **An orchestrator on Codex keeps no server** (queue OC): its thread starts with every MCP server off, plugins and
  apps too, whatever `runtimes.codex.mcp_servers` says (that list is the workers'); a test guards it. A server runs
  outside the sandbox, and could reach the Nexus API for it.
- **Probed on 2026-11-15** with Codex 0.167.2 and `gpt-6-luna` (effort low, read-only sandbox, approval `never`), in
  a temporary project, through `CodexSession` with the worker's options. The probe's own MCP server (one tool,
  `fx_probe_echo`, noting its start) came in by `-c mcp_servers.fxprobe...` on a wrapper around `codex app-server`,
  so the user's `~/.codex/config.toml` was not touched; the user's own servers were turned off as above. Off by
  default: the server never started, and the model had no such tool ("NONE"). Kept by name: the server started and
  the model called `fxprobe.fx_probe_echo` (the call did not complete under the read-only sandbox with approval
  `never`, which is the probe's setting, not the subject). Cost: two short turns on the ChatGPT subscription,
  1910 + 8368 input tokens (24704 + 31872 cached) and 31 + 75 output tokens; no model call otherwise.
