# The `.nexus` files

Part of [the protocol](../PROTOCOL.md).

## Rules

1. **One writer per file.** A session appends only to its own `events.jsonl`. The Nexus server is the only writer of
   `project.yaml`, `queue.yaml`, notes, inboxes and the runtime files, apart from the commands that write their own file directly: the setup commands (`nexus import`, `nexus note`, `nexus attach`), `nexus report`, `nexus review add` and the orchestrator's drafts. Agents change anything else only by appending an
   event that asks for the change.
2. **Append-only logs.** JSONL files are only appended to, one complete JSON object per line, written in a single
   write. A reader ignores a final line without a newline (it is still being written).
3. **Rebuildable state.** What the server shows is derived from the files, in memory; it keeps no cache file (an older `state.json` is not read), so nothing is lost with it.
4. **Ids**: queues and steps have short human ids unique in their scope (`W`, `W2b`); sessions, events, notes,
   messages and questions have ULIDs (sortable by time), except the fixed sessions `user` and `nexus` and the inbox entries whose id is derived (`answer-`, `send-back-`, `check-failed-` and the like, see "Inbox" in sessions.md). Times are ISO 8601 UTC.
5. **Versioned.** Every YAML file has `protocol: 1`; every event carries `v: 1`. Readers reject a higher major version.
   A file that is there but cannot be read is never taken for a missing one, nor written over: the reader names it in
   an error or a warning, and the server sets it aside as `<file>.corrupt` before writing it anew (`<file>.corrupt.2`,
   `.3`, … when an earlier damage's copy is there; put back in its place when the new write then fails)
   ([design/state.md](../design/state.md#missing-and-unreadable-files-queue-cha)).
6. **English** in every file Nexus writes itself. The dashboard shows the user's words verbatim in whatever language
   they were written. What agents write is in the languages of the settings (see ["Languages"](settings.md#languages)).

## Layout

```
<main checkout>/.nexus/                 git-ignored
  project.yaml                          server
  tags.yaml                             server: the project's tag lists (areas, own activities, renames, proposals)
  metrics.yaml                          server: the project's metrics (unit, how shown, target, warning threshold)
  idea-matches.yaml                     server: the user's decisions on matching earlier queues to the notes' entries
  idea-statuses.yaml                    server: user dispositions, assessments, history and observed invalidations
  idea-handoffs.yaml                    server: immutable scoped payloads and delivery attempts/receipts
  idea-proposals.yaml                   server: agents' idea-link proposals (from their ideas.links_proposed) and the user's decisions
  orchestrator/summary.md               server: the orchestrator's latest summary for a fresh session (its context care)
  drafts/<queue-id>.yaml                the orchestrator: its queue drafts (also `nexus queue draft --template`)
  recurring/<id>.yaml                   server: a recurring queue (template, values, schedule, standing approval)
  static-analysis.yaml                  server: the static analysis reminder's last time and the user's last no
  clock.json                            server: its latest time, read by `nexus` before it writes (see "Times and order")
  queues/
    <queue-id>/
      queue.yaml                        server: definition, revisions, approvals (and `nexus import`, which writes a queue it imports itself)
      notes/<step-id>/<note-id>.md      server: notes for a step (front matter + body); `nexus note` writes one itself
      report.md                         `nexus report`: the queue's report, copied from where the worker wrote it
      review/<step-id>/<file>           `nexus review add`: a step's review files, copied from where the worker wrote them
  sessions/
    <session-id>/
      session.yaml                      server: runtime, native id, role, cwd (`nexus attach` writes a hand-started session's)
      events.jsonl                      that session only (through `nexus`)
      inbox.jsonl                       server: messages, answers, send-backs and check failures delivered to it (notes are not: they come in a turn, recorded in `delivered.jsonl`)
  uploads/
    <yyyymmdd>-<hhmmss>-<hash>.<ext>    server: pictures added to chat messages (see "Uploads" under "Server API")
```

Review files are copied here by `nexus review add` (into `queues/<queue>/review/<step>/`, its only writer) and the
event points to the copy by its absolute path; a link stays a URL. Material added before this (a path anywhere in the
project, a worktree or a session's working directory, as the event names it) is shown and served where it is.

## `project.yaml`

The project's own settings and state. A setting that is global with a project override (see ["Global settings"](settings.md#global-settings)
below) is in the file only when the project has its own value of it; absent, it follows the global value. The example
is a project with its own stop conditions, push, threshold, permission mode and Codex approvals:

```yaml
protocol: 1
id: honeycomb
name: Project Honeycomb
root: C:/Code/GameDev/ProjectHoneycomb
follows_global: true                   # this file is in the form below (absent: from before global settings, migrated once)
review_decisions_since: 2026-11-27T08:00:00Z   # set once by the server; a step.done before it (or without it) needs no review decision list
review_levels_since: 2026-11-14T15:00:00Z   # set once by the server; steps done before it keep their old review policy (see "Review")
defaults:
  stop_conditions:                     # every queue inherits these
    - A decision that is the user's comes up (the look, gameplay, a final number).
    - A required asset is missing.
  push_accepted: true                  # push the commit an accepted step was reviewed at (see "Pushing what was accepted")
  usage_pause_threshold: 0.85          # share of the 5-hour window at which no new step turn starts
  worktree_dir: C:/Code/GameDev/ProjectHoneycomb.worktrees   # project only
  worktree_setup: npm ci               # project only: run once in each new worktree Nexus makes (see "Worktree setup")
  worktree_setup_inputs: ["**/package-lock.json"]   # project only: their change runs the setup again (default: the common lockfiles)
  checks: [npm run lint]               # project only: every step of every queue runs them first (see "The project's checks")
runtimes:
  claude: { permission_mode: auto, allowed_tools: [] }       # allowed_tools: project only
  codex:  { model: null, approval_policy: on-request, approvals_reviewer: auto_review }   # null: its own "none"
  # codex.mcp_servers: [blender]       # project only: the user's Codex MCP servers Codex workers keep (default: none)
conversations:
  notes_dir: Dev/Concepts/Gameplay     # project only
orchestrator:
  session: 01JD...                     # state: its current session id
  effort: high
languages:
  working: en                          # project only (see "Languages")
```

## Notes: `notes/<step-id>/<note-id>.md`

```markdown
---
id: 01JD...
step: W3
from: user                             # user | orchestrator
at: 2026-11-12T10:02:00Z
to: orchestrator                       # optional: only on a note for the orchestrator's review (see below)
---
Keep the debris as it is; only the wall bodies need support.
```

Delivered as part of the step's opening turn. The worker acknowledges with a `note.read` event.

A note the user writes on a step the orchestrator holds in review (status `review`, `review_with: orchestrator`) is
written with `to: orchestrator`. It goes to the orchestrator, never to a worker: the orchestrator is told it once per
project (key `notify:stepnote:<note id>` in any orchestrator session's `applied.jsonl`), like a chat message of the
user, whatever `notify` says and starting it if it has no session, with the queue, the step and the text, and the
instruction to weigh it in its acceptance and send the step back if it asks for a fix. Telling it records a delivery
(`kind: note`) in the orchestrator session's `delivered.jsonl`, so the note shows as delivered. Notes on other steps
behave as before.

## Removing a project

The user removes a project from Nexus on the server's API, from the dashboard only (`src/removal.ts`); there is no CLI
command for it, and no agent can do it (the write guard refuses a request without the dashboard's `Origin`, a remote
request needs the access token). Two levels, neither touching the project's own files:

- **Remove from Nexus**: the project leaves `<NEXUS_HOME>/projects.yaml`; its `.nexus/` stays, so `nexus project add
  <path>` brings it back as it was (under the id its `project.yaml` has).
- **Delete Nexus's data**: the same, and its `.nexus/` folder is deleted. The request names the project (`name`, as the
  user typed it); the server checks it against the project's name.

Either one only while **nothing runs** in the project; else 409 with the reasons (`blockers`): a run that started and
did not finish (running, pausing, paused, held, waiting for the usage window, a retry or an approval, halted or
stopped) of a queue that is not done or cancelled; a merge back in progress (Nexus waiting on a checkout for a
fast-forward, an integration step asked again) or waiting (`merge.waiting` in `git.yaml`); a deploy planned after a
step or queue of the project; the orchestrator or a thinking partner in a turn; an update under way. Planned and
scheduled starts and open questions do not keep it: they go with the project (and come back with it), and the
confirmation lists them. The worktrees and branches Nexus made stay (they belong to the project's git repository);
the confirmation lists them too.

On a removal the server takes the project off the registry, then out of itself in the same moment (its engine,
orchestrator, thinking partners and merger shut down, their processes ended and waited for; its watcher closed; the
coordinator no longer counts it). An entry taken off `projects.yaml` by hand is dropped the same way. The registry
has two writers, both the user's: `nexus project add` and this removal; each writes the whole file at once (a
temporary file renamed over it).

What Delete deletes is guarded in code: only `realpath(<the project's root>)/.nexus`, only a folder of its own (not a
link or junction, found with `lstat` and checked again by its own real path), only one holding a `project.yaml`, only
of a project registered in this server's NEXUS_HOME under that root, and not when a worktree of one of its queues lies
inside it. A link or junction inside the folder is removed as a link; what it points to is not touched. The folder is
checked again right before it is deleted.

## A project's rules files

Nexus's convention: a project's rules are in its `AGENTS.md` (Codex reads it), and its `CLAUDE.md` pulls them in with
a line `@AGENTS.md` (Claude Code reads `CLAUDE.md` only). The check is pure, from the two files' contents
(`packages/protocol/src/rules.ts`, `checkRules`): `CLAUDE.md` is **linked** when a line `@AGENTS.md` or `@./AGENTS.md`
(surrounding blanks allowed) stands anywhere in it outside code fences.

| Files | State | Who would not see the rules | The fix |
|---|---|---|---|
| both, linked | `linked` | | |
| neither (or only a `CLAUDE.md` that holds nothing but the link) | `neither` | | |
| only `AGENTS.md` | `only-agents` | Claude Code | create `CLAUDE.md` as the line `@AGENTS.md`, in `AGENTS.md`'s line endings |
| only `CLAUDE.md` | `only-claude` | Codex | move `CLAUDE.md`'s content, byte for byte (BOM, line endings), into a new `AGENTS.md` (its link lines left out), and leave `CLAUDE.md` as `@AGENTS.md` with its BOM and line endings; the @imports in the moved text (`@path` outside code), which Codex does not follow, are listed |
| both, not linked | `unlinked` | Claude Code | add `@AGENTS.md` as the first line of `CLAUDE.md` (after its BOM, in its line endings) |

`nexus project add` prints the check's result. The dashboard shows it on the project's page, with the fix as the
user's action: the change is shown (each file's lines removed and added) before it is made. The server
(`apps/server/src/rulesfix.ts`) writes the files and commits nothing; the user commits them. It is refused (409) while
a run in the project's own checkout holds it (a run state of the checkout's, paused included: see "One queue per
checkout"), when either file changed since the change was shown (the check's `version`), when there is nothing to fix,
and when a file to rewrite is not UTF-8. There is no CLI command or event for the fix.
