# Nexus protocol

Status: **draft 1**, `protocol: 1`, 2026-11-12. The concepts behind it are in [DESIGN.md](DESIGN.md).

This is the contract between Nexus, the agents and the user: the files under a project's `.nexus/` directory, the
events agents append, and the `nexus` CLI that writes them. It does not depend on any runtime: anything that can run
a shell command can take part.

## Rules

1. **One writer per file.** A session appends only to its own `events.jsonl`. The Nexus server is the only writer of
   `project.yaml`, `queue.yaml`, notes, inboxes and `state.json`. Agents change anything else only by appending an
   event that asks for the change.
2. **Append-only logs.** JSONL files are only appended to, one complete JSON object per line, written in a single
   write. A reader ignores a final line without a newline (it is still being written).
3. **Rebuildable state.** `state.json` is a cache derived from the other files; deleting it loses nothing.
4. **Ids**: queues and steps have short human ids unique in their scope (`W`, `W2b`); sessions, events, notes,
   messages and questions have ULIDs (sortable by time). Times are ISO 8601 UTC.
5. **Versioned.** Every YAML file has `protocol: 1`; every event carries `v: 1`. Readers reject a higher major version.
6. **English** in every file Nexus writes itself. The dashboard shows the user's words verbatim in whatever language
   they were written. What agents write is in the languages of the settings (see "Languages").

## Layout

```
<main checkout>/.nexus/                 git-ignored
  project.yaml                          server
  tags.yaml                             server: the project's tag lists (areas, own activities, renames, proposals)
  metrics.yaml                          server: the project's metrics (unit, how shown, target, warning threshold)
  orchestrator/summary.md               server: the orchestrator's latest summary for a fresh session (its context care)
  drafts/<queue-id>.yaml                the orchestrator: its queue drafts (also `nexus queue draft --template`)
  recurring/<id>.yaml                   server: a recurring queue (template, values, schedule, standing approval)
  static-analysis.yaml                  server: the static analysis reminder's last time and the user's last no
  queues/
    <queue-id>/
      queue.yaml                        server: definition, revisions, approvals
      notes/<step-id>/<note-id>.md      server: notes for a step (front matter + body)
      report.md                         `nexus report`: the queue's report, copied from where the worker wrote it
      review/<step-id>/<file>           `nexus review add`: a step's review files, copied from where the worker wrote them
  sessions/
    <session-id>/
      session.yaml                      server: runtime, native id, role, cwd
      events.jsonl                      that session only (through `nexus`)
      inbox.jsonl                       server: messages, answers, notes delivered to it
  uploads/
    <yyyymmdd>-<hhmmss>-<hash>.<ext>    server: pictures added to chat messages (see "Uploads" under "Server API")
  state.json                            server: derived cache
```

Review files are copied here by `nexus review add` (into `queues/<queue>/review/<step>/`, its only writer) and the
event points to the copy by its absolute path; a link stays a URL. Material added before this (a path anywhere in the
project, a worktree or a session's working directory, as the event names it) is shown and served where it is.

## `project.yaml`

The project's own settings and state. A setting that is global with a project override (see "Global settings"
below) is in the file only when the project has its own value of it; absent, it follows the global value. The example
is a project with its own stop conditions, push, threshold, permission mode and Codex approvals:

```yaml
protocol: 1
id: honeycomb
name: Project Honeycomb
root: C:/Code/GameDev/ProjectHoneycomb
follows_global: true                   # this file is in the form below (absent: from before global settings, migrated once)
review_levels_since: 2026-11-14T15:00:00Z   # set once by the server; steps done before it keep their old review policy (see "Review")
defaults:
  stop_conditions:                     # every queue inherits these
    - A decision that is the user's comes up (the look, gameplay, a final number).
    - A required asset is missing.
  push_accepted: true                  # push the commit an accepted step was reviewed at (see "Pushing what was accepted")
  usage_pause_threshold: 0.85          # share of the 5-hour window at which no new step turn starts
  worktree_dir: C:/Code/GameDev/ProjectHoneycomb.worktrees   # project only
  worktree_setup: npm ci               # project only: run once in each new worktree Nexus makes (see "Worktree setup")
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

## Global settings

`<NEXUS_HOME>/settings.yaml` holds the global settings, which every project follows where it has no value of its
own. Written only by the server; created at its first start with the built-in defaults (below), so nothing changes
for a project then. Same paths as in `project.yaml`:

```yaml
protocol: 1
defaults: { stop_conditions: [], review_level: 2, review_send_back_limit: 2, context_reuse_threshold: 0.6,
            context_care: true, protect_nexus: true, push_accepted: false, provisional_counts: true,
            merge_back: false, resolve_conflicts: false, usage_pause_threshold: 0.9, max_running: 2 }
runtimes:
  default: claude
  claude: { permission_mode: acceptEdits }            # model, effort: none (the runtime's default)
  codex:  { sandbox: workspace-write, approval_policy: never }   # model, effort, approvals_reviewer: none
conversations: { runtime: claude, web: search }       # model, effort: none
orchestrator: { runtime: claude, notify: true, context_threshold: 0.85 }   # model, effort: none
languages: {}                                         # reader: none (the language the user writes in)
kinds:                                                # each kind's runtime, model, effort and fallback (see "Kinds and their defaults")
  mechanical: { runtime: claude, model: claude-sonnet-5-5, effort: low, fallback: [{ runtime: codex, model: gpt-6-luna, effort: low }] }
  code:       { runtime: claude, model: claude-opus-5-5, effort: high, fallback: [{ runtime: codex, effort: high }] }
  # debugging and research as code; docs: claude-sonnet-5-5, medium, fallback codex medium; design: claude-opus-5-5, high, fallback [wait]
```

**The effective value** of a setting in a project is its own value where `project.yaml` has one, else the global
value. A setting without a default (a model, an effort, `approvals_reviewer`) may have the project's own `null`: "none,
the runtime's default", even where the global value names one. `ProjectStore.readProject` gives the effective
settings, the form every reader uses; `readStoredProject` gives the file as it is.

**Writing.** Every writer of `project.yaml` (the settings action, the allow rule from a refusal, the orchestrator's
model, effort and session, `nexus import`) goes through `ProjectStore.updateProject`: a setting the change gives
another effective value becomes the project's own; one it leaves alone keeps its state, following or own. The settings
action's `follow` (a list of keys, `runtimes.claude.model`) makes those settings follow the global value again. A
change of a global value reaches every project that follows it at once.

**Running sessions** get changed settings at their next step or message, never inside a turn:

- A worker: its run's values from the defaults are resolved again when the next step opens (above). Settings its
  process was started with (Claude Code's permission mode, allow rules and the `.nexus` protection; Codex's sandbox,
  approval policy and reviewer; a model or effort it took from the defaults) are compared with the effective ones then;
  if they differ, the idle process is ended and the session resumed with them before the step opens (Claude Code
  `--resume`, Codex `thread/resume`). A model or effort of its own changes as in "Runtime, model and effort per step".
- The orchestrator runs on the project's effective `orchestrator.model` and `effort`; its session records them. Before
  a message, a process started with other settings is replaced: at once when idle; when working, after its turn (that
  message still goes into the running turn).
- A thinking partner runs on its own model and effort if its creation named them, else on the project's effective
  `conversations.model` and `effort` (when it runs on `conversations.runtime`). It is replaced before a message in the
  same way. An effort its runtime does not take refuses the message, with the reason.

**The migration** turns a `project.yaml` without `follows_global` into this form once, when the server starts (before
anything reads the project): the file's values meant what the built-in defaults made of them; each that equals the
global value then follows it, each that differs becomes the project's own (a missing model or effort against a global
one: `null`). The effective settings do not change. It writes only such a file, and a second run writes nothing.

**Which kind each setting is:**

| Kind | Settings |
|---|---|
| Global, with a project override | `defaults`: `stop_conditions`, `review_level`, `review_send_back_limit`, `context_reuse_threshold`, `context_care`, `protect_nexus`, `push_accepted`, `provisional_counts`, `merge_back`, `resolve_conflicts`, `usage_pause_threshold`, `max_running` (see "One queue per checkout, and a limit"). `runtimes`: `default`; `claude`: `model`, `effort`, `permission_mode`; `codex`: `model`, `effort`, `sandbox`, `approval_policy`, `approvals_reviewer`. `conversations`: `runtime`, `model`, `effort`, `web`. `orchestrator`: `runtime`, `model`, `effort`, `notify`. `languages`: `reader`. `kinds.<kind>`: `runtime`, `model`, `effort` (a model or effort may be the project's own `null`: the project's for that runtime), `fallback` |
| Project only | `name`, `defaults.worktree_dir`, `defaults.worktree_setup`, `defaults.checks`, `runtimes.claude.allowed_tools` (the project's own allow rules), `runtimes.codex.mcp_servers` (the user's Codex MCP servers, by name, that Codex workers keep; empty by default), `conversations.notes_dir`, `languages.working` (`id` and `root` identify the project) |
| Global only | Remote access (`<NEXUS_HOME>/auth.json`, `push.json`), the deploy push (`deploy.json`), the server; each stays in its own file |
| State, not a setting | `orchestrator.session` |

The orchestrator's settings count only for a project that has an orchestrator section (it has had one); the section
is made with its first session.

### Languages

Two settings say which language what is written is in. Each is one of the offered languages, stored by its code:
`hu` Hungarian, `en` English, `da` Danish, `de` German, `es` Spanish, `fr` French, `pl` Polish, `it` Italian
(`packages/protocol/src/languages.ts`, `LANGUAGES`).

- **`languages.reader`, the reader's language** (global, with a project override): what everything written to the
  user is in: chat replies, step summaries, questions, progress lines, notifications, and the text of queues (title,
  description, goals, acceptance; ids and YAML keys stay English). It has no default: none means "the language the
  user writes in", today's behaviour. A project's own `null` is that too, where the global value names a language.
- **`languages.working`, the working language** (project only, default `en`): what the project's agents work in:
  files, code, comments, commits, context cards, notes. It must agree with the project's own rules (its AGENTS.md):
  the setting is what Nexus tells the agents, the project's rules are the project's.

**How agents are told** (`apps/server/src/prompts.ts`, from the project's effective settings):

- **With the defaults** (no reader's language, working language English) every text is as it was before these
  settings: the orchestrator and partners reply in the language the user writes in, and what they write into files
  and queues is in English; the worker's texts name no language.
- **The worker**: its briefing ends with a language line ("write what is meant for the user in <reader's language>:
  step summaries, questions, progress lines, stop and failure reasons, labels of review material; work in <working
  language>: files, code, comments, commit messages, context summaries"). With no reader's language set, the line
  says "the language the user writes in". A briefing is fixed when its process starts, so the same line also ends
  each step's opening and each inbox message as delivered: a change reaches a running worker with its next message or
  step. A changed briefing also counts as a changed launch setting, so the worker is resumed in a new process before
  its next step ("Running sessions").
- **The orchestrator**: replies, and the text of the queues it drafts (title, description, goals, acceptance, stop
  conditions, checks, review notes; ids and YAML keys stay English), are in the reader's language; everything else it
  writes into files is in the working language. With no reader's language set, queue text is in the working language
  (as before). It tells its queue-reviewer which language the queue's text is to be in; the reviewer checks it. A
  change reaches it at its next message: its process is resumed with the new briefing.
- **A thinking partner** replies in the reader's language (none: the language the user writes in) and writes its notes
  in the working language; its hand-over summary for the orchestrator is in the working language. A change reaches it
  at its next message, as for the orchestrator.

## `queue.yaml`

```yaml
protocol: 1
id: W
title: Variant B made a system
track: cliffs-v2
worktree: C:/Code/GameDev/ProjectHoneycomb      # where the worker runs; `auto` = Nexus creates one
branch: v2/cliffs                      # with `worktree: auto`, the new branch's name
base: null                             # with `worktree: auto`, the commit or branch to start from
revision: 3                            # increases on every change to steps, criteria or stop conditions
status: running                        # mirrors the derived state; the event logs are authoritative for progress
review_level: 2                        # optional: the level of steps that set none (see "Review")
coding: true                           # optional: the queue contains coding; Nexus adds a closing refactoring step (below)
maintenance: survey                    # optional: a maintenance queue's mode, survey or fix_small (see "Recurring queues"); pinned by the approval
kind: code                             # optional tags, the defaults of its steps (see "Tags"): kind, activities, area, size, origin
origin: user
runtime: claude                        # optional: the runtime, model, effort and fallback of its steps that name none
fallback: [{ runtime: codex, effort: high }, wait]   # (see "Kinds and their defaults")
integration: true                      # written only by the server: the queue works in a worktree of its own, so it ends with the integration step (below)
user_levels: { W3: 1 }                 # levels the user set on steps; written only by the server (see "Review")
legacy_policies: { W1: continue }      # each step's review policy from before review levels; written only by the server
stop_conditions:                       # in addition to the project defaults
  - The climb probe finds a way up a wall of two levels or more that two attempts within the step do not remove.
checks:                                # run for every step
  - Core tests (v1 fingerprints unchanged), rock tests, climb probe, bench pictures.
steps:
  - id: W1
    title: Voronoi fracture
    goal: |
      The rock cut into the cells of seed points instead of a lattice of three plane families...
    acceptance:
      - The parallelism measure separates the two characters clearly (canyon well above grassland).
      - Every body closed; the same rock on one thread and many; build time per fixture measured.
    review:
      prepare: Pictures of both characters on the bench, gameplay view first.
      level: 1                         # optional: the step's review level, as drafted (1, 2 or 3)
    kind: design                       # optional tags (see "Tags"): exactly one kind; each left out is the queue's
    activities: [feature, hc:terrain]  # Nexus's activities, or the project's own (with its prefix)
    area: terrain                      # from the project's list (tags.yaml)
    size: L                            # S, M or L, as planned
  - id: W2
    title: Bodies shaped
    goal: ...
    acceptance: [...]
    review: { prepare: ..., rounds: 3 }
  - id: W3
    title: Fixture sheet
    goal: ...
    runtime: codex                     # optional: claude | codex; this step only
    model: gpt-6-luna                  # optional
    effort: low                        # optional: low, medium, high, xhigh, max (Claude Code); Codex: the model's levels
    fallback: [wait]                   # optional: its fallback chain (see "Kinds and their defaults")
approvals:
  - revision: 3
    at: 2026-11-12T09:14:00Z
    words: "Rendben, előrehozhatjuk a shadert, illetve a kettes ponttal is egyet tudok érteni."
    hash: sha256:...                   # of the revision's steps (with their drafted levels), checks and stop conditions
withdrawals:                           # approvals the user took back before the queue ever ran
  - revision: 3
    at: 2026-11-12T10:02:00Z
    reason: "The art is not ready yet." # optional
    approvals: 1                       # how many approval records there were then
history:                               # previous revisions, kept for the record
  - { revision: 2, hash: sha256:..., replaced_at: 2026-11-12T09:10:00Z }
changes:                               # status changes made through Nexus; written only by the server
  - at: 2026-11-13T09:40:00Z
    kind: lift                         # lift | status | run | proposal | work (see below)
    by: user_approval                  # user_approval (approving a new revision) | user_continue | orchestrator | nexus
    from: stopped
    to: approved
    reason: "the art is missing: W4 needs the cliff textures"   # the stop's own reason, as it was derived
    revision: 3                        # the revision the change was made on
  - at: 2026-11-13T09:40:00Z
    kind: work                         # the user's choice about a stopped step's work (see "The work a stopped step left")
    by: user_continue
    step: W4
    from: stopped
    to: kept                           # kept | discarded
    commits: [4e1a2c9..., 9b07d31...]  # the step's own commits the choice was about
    revision: 3
  - at: 2026-11-14T08:12:00Z
    kind: status                       # a step a revision change left open goes back to pending
    by: nexus
    step: W4e
    from: running                      # running | waiting
    to: pending
    reason: its run was replaced by revision 4   # or: its run was replaced by a new start
    revision: 4
```

A step's `runtime`, `model` and `effort` are part of what is approved. Each one a step leaves out is the run's
(see "Runtime, model and effort per step"). A draft is refused when a step names Claude Code with an effort it does
not take (`ultra`); an effort without a runtime is checked when a run starts.

**A revision changes only what has not started.** A draft may add, change, remove or reorder pending steps (a skipped
step that never ran counts as pending here). A *started* step is one that has segments (it has been at work) or whose
status is neither `pending` nor `skipped`, an imported `done` included. A draft is refused when it changes a started
step's `title`, `goal`, `acceptance`, `review`, `runtime`, `model` or `effort`, drops it (keep it and skip it), or
changes the relative order of the started steps (pending steps may move anywhere between them); the refusal names
each step and what changed, and says that a change to a started step goes to its worker as a message or with
`nexus review send-back`. Once the queue has a run (a `run.yaml`, or any started step) a draft that changes its
`worktree`, `branch` or `base` is refused too, naming the field, the queue's value and the draft's (left out, they
stay). A draft never changes an existing step's `status` either: that is `nexus queue set`'s.

A queue is runnable only when its latest approval's hash matches its current revision and no withdrawal came
after that approval (a withdrawal's `approvals` is not below the number of approvals). Withdrawing sets the queue
back to `proposed`; the approvals stay as they were, and a later approval makes it runnable again. Only a queue
that never ran can be withdrawn (no `run.yaml`, no step started); a started one is paused or stopped instead.

**Changes and lifting a stop.** `changes` records the status changes made through Nexus, oldest first, written only
by the server; nobody edits statuses in the file. Derivation applies each entry in time order among the events (an
event at the same time goes first), so a later event can still change the status again. A `lift` makes a `stopped`
queue `approved` and its `stopped` steps `pending` again (their reason cleared); a stop before the lift, whether a
`queue.stop` event or a `stopped` status an import wrote into the file, no longer counts. A stop after it does.

**A new revision of a running queue never stops the running step.** A revision changes only steps that have not
started (see above), so the step at work goes on to its end through its turns, questions, answers and nudges; only the
step's end (done or skipped) looks at the approval. A step waiting for an answer or for its review, and a failed or
stopped one, behave as without a revision. At the step's end:
- the queue's current revision approved: the run goes on in the same session (no new start) and its `revision` moves
  to the current one;
- not approved: the run becomes `approval_wait` (`reason: waits for approval of revision N`), keeping its session and
  its checkout, and goes on by itself, in that session, once the user approves; the orchestrator's approval notice
  says that the run continues by itself. A run the user asked to pause becomes `paused` instead (the user's pause
  wins; a resume later goes on, or waits again while the revision still waits). While the run waits, the queue's
  derived status is `waiting` (`status_reason: waits for approval of revision N`), and the user's attention list has an
  item of kind `approval` ("The run waits for approval of revision N after step S; it goes on by itself once you
  approve"), which is pushed like any new item. A revision that removed every remaining step: the queue is not `done`
  while it waits (`waiting` as above, also while its run is paused); on approval the run finishes, and a queue planned
  after it starts only then. A planned start after the queue says `queue A waits for approval of revision N (after
  S)` and is `blocked` (it waits on the user). The dashboard shows the queue as "waits for approval of revision N ·
  after S" (the approval colour) and its run as "waiting for approval", with Pause.

While a run is `approval_wait`, a start of the queue, a start in its session by another queue (a planned start waits
for the session) and a cancel of the queue are refused; Pause and Stop now pause it. An update's drain does not hold
it (it is not going) and nothing continues it while the update drains: after the restart, or a cancelled drain, a run
whose revision was approved meanwhile goes on; one still waiting waits on. A plain restart leaves it waiting too.

**A step a revision change left open** with no run record holding it goes back to `pending` through a `status` entry
`by: nexus` (`from: running` or `waiting`, `to: pending`, `reason: its run was replaced by revision N`; derivation
clears the step's reason), so a start begins at the first pending step, which is that one when it comes first. The
server writes it when a run starts and at server start, for every `running` or `waiting` step opened (its latest
stretch at work began) before the current revision replaced the one before, unless the queue's run record has that
step open, whatever its revision (a halted or paused run too: resume continues it). A start also releases the step of
the run record it replaces (`reason: its run was replaced by a new start`). A step opened since the last revision
change (by a run, or by hand with no run) is left alone. So a queue never shows two running steps.

Approving a revision of a stopped queue lifts the stop: the server appends the approval and a `lift` by
`user_approval` with the stop's derived reason (`condition: reason` for an event stop, the file's `status_note` for
an imported one), writes the queue `approved`, and archives the queue's `run.yaml` as `run.<time>.yaml` beside it
(the time of archiving in ISO 8601 with `-` for `:` and `.`, e.g. `run.2026-11-13T09-40-00-123Z.yaml`), so a start
begins at the first pending step, which is the stopped step itself unless the new revision says otherwise. An
archived run record is read by nothing; it is kept for the record. Approving a stopped queue whose run is still
going is refused.

**Continue** is the user's other way to lift a stop, for when the cause was outside the queue and no new revision is
needed: only a stopped queue whose current revision is approved (otherwise approving that revision lifts the stop),
and only from the dashboard (`POST /api/projects/:id/queues/:q/continue`; no CLI command, no event). The server
appends a `lift` by `user_continue` with the stop's derived reason, writes the queue `approved`, and goes on: its run
resumes (one of an older revision too), reopening the step it last opened in its session with a turn that says the
user lifted the stop (when the orchestrator skipped that step, the next pending one opens); with no `run.yaml` (an
imported stop) or a finished run, the queue starts afresh at its first pending step (or, with nothing left to run, is
done). With `skip_closing: true` the user also skips the queue's closing refactoring step (see "The closing
refactoring step"). The orchestrator is told once. The dashboard shows the stop with the orchestrator's proposal (`lift_proposal`) beside Continue, and the
queue's and each step's `changes`: who, when, what and why.

**The work a stopped step left.** Where a stop is lifted (Continue, or approving a new revision of a stopped queue),
the user decides about what the stopped step (`stop_step`) left (`apps/server/src/stopwork.ts`):
- The server works it out, reading git only (no network, `status` without optional locks): the step's own commits from
  `git.yaml` (every round), leaving out those marked foreign; and the uncommitted changes of the queue's checkout
  (`git status`), labelled "in the checkout, not necessarily this step's". `GET /api/projects/:id/queues/:q/left`
  answers `{ step, commits, uncommitted: [{ status, path }], uncommitted_note, discarded }` (`discarded`: the Discard
  recorded for this stop, or null), or null when the queue is not stopped at a step.
- When the step left commits of its own, the lift takes a choice, `work: keep | discard` in the body of `continue` and
  `approve`; without it they are refused (409, naming the step and the number of commits). With none nothing is asked.
  What the lift itself would refuse (a run still going; Continue on an unapproved revision; approving an approved
  one) is refused first, so no choice is recorded for a lift that does not happen.
- **Keep** appends a `work` change (`to: kept`, `commits`, `by`) and lifts as before. The commits stay, and go out
  with the next accepted commit when the project pushes what was accepted.
- **Discard** appends a `work` change (`to: discarded`, `commits`) and does not lift: Continue does not go on, and the
  approval is not recorded. The orchestrator is told once per project (key `notify:discard:<queue>:<index of the
  change>` in any orchestrator session's `applied.jsonl`), like a chat message of the user: whatever `notify` says,
  starting it if it has no session, with the commits; it drafts a revision whose first pending step reverts exactly
  them. Once a Discard is recorded for the present stop (after its `queue.stop`), approving a revision lifts the
  stop without asking again.
- Uncommitted changes are shown, never cleaned: neither Nexus nor a revert step removes files it cannot attribute to
  the step; the orchestrator asks the user about them. The worker's briefing asks a worker that stops to commit what
  is consistent and leave the working tree clean.

**Where a stop is, and the ways out shown.** The queue's view keeps `stop_step`, the step the latest `queue.stop` named
(or, for a queue imported as stopped, its last stopped step), until a lift. While that step is not finished the stop is
"at step W4b"; once the orchestrator skips it, the stop is the queue's: "stopped (the stop came from W4b, now
skipped)" (`stopPlace`). The engine's refusal of start and resume and its halt on a stopped queue name the place and
both ways out: Continue in the dashboard, or approving a new revision. The attention item of a stopped queue (kind
`stopped`, a queue whose status is `stopped`, not a halted run) carries `lift`: `place`, `continue` (the current
revision is approved, so Continue lifts the stop; else approving revision `revision` does) and the orchestrator's
`proposal` (`at`, `reason`) when there is one; its `step` is the stop's step only while that step holds it, and its
time is the later of the queue's last change and the proposal. Such an item is keyed by its queue alone (a skip is no
new notification), and opens the queue, whose stop box has Continue. `nexus status` prints, under a stopped queue,
`stopped<place>; the user lifts it with …` and `proposal to lift (orchestrator, <time>): <reason>`; the
orchestrator's "Waiting for the user" shows the same under the item.

**Housekeeping by the orchestrator** (`nexus queue set`, event `status.set`). The server checks each request against
the derived state and records it as an entry `by: orchestrator` with the request's `reason` and the queue's
`revision`:

| Request | Allowed when | Entry, and what derivation does |
|---|---|---|
| `--step S skipped` | S is not the closing refactoring step; S is `pending`, `stopped` or `failed`, or `running` while no live run (`running`, `pausing`, `usage_wait`, `retry_wait`) has it open, and the queue is not done or cancelled | `kind: status`, `step`, `from` (S's status), `to: skipped`: S becomes `skipped` with the reason; when every step is then done, skipped or failed the queue is `done`. A stop is not lifted by it |
| `finished` | the queue's run is `halted` and every step is done or skipped (the closing refactoring step too) | `kind: run`, `from: halted`, `to: finished`; the server also writes `run.yaml` `finished` |
| `cancelled` | the queue is not done or cancelled and its run is not `running`, `pausing`, `usage_wait` or `retry_wait` | `kind: status`, `from` (the queue's status), `to: cancelled`: the queue is `cancelled` with the reason; a later stop leaves it so. The user gets a push notification; nothing goes into the waiting list |
| `propose-lift` | the queue is `stopped` | `kind: proposal`, `from: stopped`, `to: lift proposed`: the queue's view carries `lift_proposal` (`at`, `reason`) until a lift, a later `queue.stop` or a later approval |

Refused, with the reason: `done` (work done elsewhere is skipped, with the reason saying where), approving, lifting
a stop (`lift`, `approved`, `running` or `pending` for a queue), reopening a finished step (`pending`, `running`),
skipping a step at work, and any other status. The engine reads a step's status again before it opens a step, so
skipping a pending step of a running queue takes effect: the step is never opened. A cancelled queue is neither
started nor resumed.

**Drafts do not change statuses.** In a draft of an existing queue a step's `status` may be left out or be the one in
the file; any other value refuses the whole draft, listing the steps. A new step has no status or `skipped`. A draft
that leaves out a step that has started or stopped (one with a stretch at work, or a status other than `pending` or
`skipped`) is refused: keep the step and skip it with `nexus queue set`.

### The closing refactoring step

A queue with `coding: true` contains coding, and ends with a step Nexus keeps (`packages/protocol/src/closing.ts`).
The orchestrator sets the field in the draft (its briefing says when: a step writes or changes code); the user sees
the step in the approval view like any other.

- **Outside the list of steps.** It is not in `queue.yaml`'s `steps`: derivation adds it after them (`stepDefs`), so
  it is always the last, also when a revision adds steps. Its id is reserved: `<queue>.refactor` (e.g. `W.refactor`);
  a draft with a step of that id is refused. Its events (`nexus step start W.refactor`, …), its rounds in `git.yaml`
  and its notes use that id like any step's; the state marks it with `closing: true`.
- **Its text is Nexus's standard** (`CLOSING_TITLE` "Closing refactoring", `CLOSING_GOAL`, `CLOSING_ACCEPTANCE`):
  refactor what the queue changed and the code closely tied to it, never the codebase at large; behaviour unchanged
  (no new features, the queue's checks pass before and after); small commits, each saying what it simplified; a
  change too small to be worth refactoring is a valid outcome, reported done with the reasons in the summary. A
  project's own rules go in a "Refactoring" section of its AGENTS.md: the step's opening says whether the queue's
  checkout has one (a Markdown heading `Refactoring` of any level) and to follow it too; without one, the standard
  text alone applies.
- **Review level 2** (its criteria can be checked), as if drafted with `review.level: 2`; the user may set another
  (`user_levels`), and a revision keeps it.
- **Part of what an approval pins.** `coding: true` is in the revision hash (`coding` counts only when true, so a queue
  without it keeps the hash it had); setting or clearing it makes a new revision. A draft that leaves it out keeps the
  queue's value; `coding: false` takes it back only before the queue has started (no `run.yaml`, no started step):
  after, the draft is refused.
- **It cannot be bypassed by agents.** `nexus queue set Q --step Q.refactor skipped` is refused; `nexus queue set Q
  finished` is refused while it is not done (the refusal names it). A stopped queue gets it when the stop is lifted
  and the run goes on; a cancelled one never.
- **Only the user skips it, at Continue or with the approval of a stopped queue's new revision.** Continue on a
  stopped queue (`skip_closing: true`; the dashboard's checkbox "Skip the closing refactoring" in the queue's bar,
  shown while the step has not run) records, after the `lift` and at its time, a `changes` entry `kind: status`,
  `by: user_continue`, `step: Q.refactor`, `from: pending`, `to: skipped`, with the reason "the user skipped the
  closing refactoring at Continue; the stop was: <the stop's reason>". The approval of a stopped queue's new revision
  (`skip_closing: true` on the approval; the same checkbox beside Approve, in the queue's bar and in the full approval
  view) records the same entry after its `lift`, `by: user_approval`, with the reason "the user skipped the closing
  refactoring with the approval of revision <N>; the stop was: <the stop's reason>"; on a queue that is not stopped
  the skip is refused (409) and nothing is recorded, the approval neither. Only a closing step that has not run
  (`pending`, or `stopped` itself) is skipped; a request to skip any other is refused before anything is recorded. The skip holds when the
  stopped step goes on (a skipped closing step is not set back to pending by later work); the queue is `done` without
  it. `nexus status` shows it on the step (`Q.refactor skipped (… closing refactoring skipped by the user: <reason>)`)
  and beside a finished queue (`finished: Q (closing refactoring skipped by the user: <reason>)`).
- **Runs again after new work.** Once it has run, a step of the queue's own that starts afterwards (a revision added
  it) sets it back to `pending` (derivation, at that `step.started`): it runs again at the end, over the queue's
  whole work. New steps that are only skipped leave it as it was, and so does the user's skip.
- **It is the last step**, so its opening asks for the queue's report (see "The step turn"), the queue is `done` and
  the run `finished` only after it, and the orchestrator's notices that speak of a queue's last step mean it.
- **A fresh session with the queue's commit range.** When it is next and the run's session has worked before (any
  event of its own), the engine goes on in a fresh session the way context care does (see "Context care"), with
  `switches[].why: refactor`, no summary asked for, and a seed that gives the queue's description and its steps'
  summaries. Its opening names the queue's work as a commit range, from the first `start` of a round of the queue's
  own steps in `git.yaml` to the last `end` (the closing step's own rounds left out), with `git diff --stat` of it (at
  most 60 files and the summary line); the diff itself is not in the text, the worker reads it with git. Without git
  records it says so.

### The integration step

A queue with a worktree of its own ends with a second step Nexus keeps, after the closing refactoring step and
whatever `coding` says (`packages/protocol/src/closing.ts`, `integrationStep`): in the queue's worktree a worker merges
the current base into the queue's branch and runs the queue's checks there, so that the queue's work and what reached
the base meanwhile are tested together. The base then only moves forward to that result (a fast-forward), so nothing
new arises on the base itself.

- **Which queues.** One with `worktree: auto`, or one the server marked `integration: true` in `queue.yaml` when it
  first gave the queue its worktree (an auto worktree it made, or a path the queue names that is not the project's
  checkout). The mark is the server's: a draft cannot set it (it is dropped), a revision keeps it, and it is not part
  of what an approval pins. A queue that worked in a worktree before the step existed (a path, no mark) has none.
- **Kept like the closing step.** Not in `queue.yaml`'s `steps`; derivation adds it last (`stepDefs`), so it stays last
  when a revision adds steps. Its id is reserved: `<queue>.integrate` (a draft with a step of that id is refused); the
  state marks it with `integration: true`. Its text is Nexus's standard (`INTEGRATION_TITLE` "Integration",
  `INTEGRATION_GOAL`, `INTEGRATION_ACCEPTANCE`). Review level 2, as if drafted so; the user may set another.
- **It cannot be bypassed by agents.** `nexus queue set Q --step Q.integrate skipped` is refused; `nexus queue set Q
  finished` is refused while it is not done.
- **It is the last step**: its opening asks for the queue's report, the queue is `done` and the run `finished` only
  after it, and the orchestrator's notices that speak of a queue's last step mean it.
- **Runs again after new work.** Once it has run, any other step that starts afterwards (a revision's new step, or the
  closing step running again) sets it back to `pending`: the base is merged again into what the branch has become. Its
  own start leaves the closing step as it is.
- **Its opening** (`apps/server/src/integration.ts`, `prompts.ts`) names the queue's branch and the base to merge: the
  branch the worktree was made from (`git.yaml` `base`, when it is a branch), else the branch the project's checkout is
  on, with that branch's commit now. The worker runs `git merge --no-edit <base>`, never rebases or pushes, and changes
  neither the base nor another checkout. Without a conflict (or when the branch contains the base already) it runs the
  checks, fixes on the branch what the two sides break together, and reports done with the resulting HEAD. On a
  conflict, with the project's `resolve_conflicts` on, it resolves it, commits the merge, runs the checks and names the
  conflicting files and how it resolved each (the step's review judges it); with it off, or when it cannot resolve one
  with confidence, it aborts the merge (`git merge --abort`) and stops: `nexus stop Q.integrate --condition "The
  integration found a conflict that it does not resolve" --reason "<files, why>"` (`INTEGRATION_CONDITION`). The queue
  then waits for the user, who resolves it (in the worktree, or with a new revision) and goes on with Continue; the
  step runs again. Without a base branch to name, the opening says so and the worker stops the same way.

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

## Events: `sessions/<id>/events.jsonl`

Every line:

```json
{"v":1,"id":"01JD...","at":"2026-11-12T10:05:00Z","session":"01JD...","type":"step.started","queue":"W","step":"W3", ...}
```

| Type | Fields | Meaning |
|---|---|---|
| `step.started` | `queue`, `step` | The worker begins the step |
| `step.progress` | `queue`, `step`, `text`, `pct?` | A short status line for the dashboard |
| `step.interrupted` | `queue`, `step`, `text` | User only: Stop at once interrupted the worker and paused its run. Closes the current work segment and records the explanation on the timeline; leaves the step without an outcome so Resume can reopen it in the same session. Written by the server to the user's session, never by the worker |
| `review.added` | `queue`, `step`, `items: [{path or url, label, kind?, before?, key?, role?, size?}]`, `round?` | Review material, `kind` = image, sheet, doc, data, link; `before`: the path of the picture this one is compared with; `key` (a view key), `role` (before, mockup, after, variant-a, variant-b, result) and `size` (`width`, `height` in pixels): a keyed picture, always with its `round` (see "Review pictures") |
| `review.marked` | `queue`, `step`, `path`, `accepted` | User only: a review picture marked accepted (or the mark taken back). A mark only: it does not accept the step |
| `review.commented` | `queue`, `step`, `path`, `text`, `to` (`send_back`, `note`, `orchestrator`), `note_step?` | User only: a comment on a review picture, and where it went (see "Review pictures") |
| `check.result` | `queue`, `step`, `name`, `ok`, `summary`, `duration`, `commit?` | One check's outcome; `duration`: how long it ran, in seconds (optional, non-negative), which is also the metric `check:<name>`; `commit`: the HEAD of the session's checkout when it was reported (see "Project metrics") |
| `step.done` | `queue`, `step`, `summary`, `commit?`, `warning?`, `activities?` | Acceptance met; the step's work is finished. `warning`: what `nexus step done` warned about at the step's end (see the CLI). `activities`: what the worker actually did (`--activities`), from the same lists as a draft (see "Tags") |
| `step.failed` | `queue`, `step`, `reason` | The step cannot be finished as written |
| `queue.stop` | `queue`, `step`, `condition`, `reason` | A stop condition was met; the engine halts the queue. `condition`: the condition met, as the queue words it; `reason`: what happened, short. The derived queue keeps them apart in `stop` (`{ condition, reason }`, until a lift) besides `status_reason` ("<condition>: <reason>"); the stopped waiting item's `text` is the reason and its `condition` the condition. A stop known only as one text (a queue imported as stopped) has no `stop`, and shows its `status_reason` |
| `question.asked` | `queue?`, `step?`, `qid`, `text`, `options?`, `recommended?`, `can_continue` | A question; `can_continue` says whether independent work remains; `recommended`: the asker's recommendation, one of `options` (the CLI refuses another; the state drops it with a warning) |
| `question.withdrawn` | `qid`, `reason` | No longer needed |
| `answer.given` | `qid`, `text`, `escalate?`, `recommended?` | Orchestrator only: an answer, or an escalation to the user with its framing. With `escalate`, `recommended` is the orchestrator's recommendation, one of the question's options; it replaces the asker's on the derived question (`QuestionView.recommended`, and the waiting item's `recommended`), whose button the dashboard marks |
| `note.read` | `note` | A note was received |
| `message.read` | `message` | An inbox message was received |
| `context.summary` | `text`, `topics: []`, `files: []` | What a successor or continuation needs to know; written at the end of each step |
| `queue.report` | `queue`, `path`, `summary`, `findings?` | The worker's report of the whole queue, written when it ends (done or stopped). `path` is the copy in the queue's folder (`.nexus/queues/<queue>/report.md`), which `nexus report` writes. `findings`: a maintenance queue's number of findings (`--findings`, a whole number from 0; see "Recurring queues") |
| `change.proposed` | `queue`, `patch`, `reason` | A proposed change to a queue definition (needs a new approval) |
| `queue.drafted` | `queue`, `definition` | Orchestrator only: a new or changed draft queue |
| `session.request` | `action` (start, resume, pause, stop, cancel_start), `queue`, `use_session?`, `runtime?`, `model?`, `effort?`, `after?`, `next?`, `start_at?`, `reason` | Orchestrator only: asks the engine to act on a queue's run (`use_session` continues an existing session). `start` with `after` (a list of queue ids; one id from an older CLI): put the queue into the plan, it starts when those are done (see "The plan"); with `next: true`: into the plan with none before it; with `start_at` (ISO 8601, or `usage-reset`): start at that time (a schedule, see "Schedules"); `cancel_start`: take the queue out of the plan (its predecessors and its schedule) |
| `plan.proposed` | `queue`, `after` (ids), `reason` | Orchestrator only: proposes to the user a new list of predecessors for the queue that changes dependencies the user set (see "The plan") |
| `tags.proposed` | one of `area`, `activity`, `rename` (`from`, `to`); `reason?` | Orchestrator only: proposes a change to the project's tag lists; the server records it in `tags.yaml`'s proposals and answers in `applied.jsonl` (see "Tags") |
| `recurring.set` | `recurring`, `template`, `params`, `every?` or `after_queues?`, `maintenance?`, `reason?` | Orchestrator only: sets a recurring queue (`nexus recurring set`); the server checks it, writes `recurring/<id>.yaml` (taking the standing approval away) and answers in `applied.jsonl`. It carries no approval (see "Recurring queues") |
| `static_analysis.declined` | `reason` | Orchestrator only: the user declined the `static-analysis` template (`nexus static-analysis decline`); the server notes it in `static-analysis.yaml`, rests the reminder for 90 days and answers in `applied.jsonl` (see "Static analysis reminder") |
| `metric.defined` | `name`, `unit?`, `show?`, `target?`, `warn_above?`, `warn_below?` | Orchestrator only: defines one of the project's metrics, or changes it (the whole definition); the server checks it, writes `metrics.yaml` and answers in `applied.jsonl` (see "Project metrics") |
| `metric.recorded` | `queue`, `step`, `name`, `value`, `unit`, `commit?` | Worker only (the loader ignores it from any other session): a value of one of the project's metrics for the step, with the metric's unit then and the HEAD of the worker's checkout (see "Project metrics") |
| `review.sent_back` | `queue`, `step`, `text` | Orchestrator or user only: a step in review goes back to its worker with what to fix (see "Sending a step back") |
| `review.rejected` | `queue`, `step`, `text?` | User only (the loader ignores it from any other session, the orchestrator's included): rejects a step waiting for the user's review (see "Reject") |
| `review.asked_user` | `queue`, `step`, `text` | The orchestrator's: a step waiting for its review goes to the user, with why. Also the server's from the user's session, when the user sets such a step's level to 1 (see "The user's level"): then taken for a step in review whoever its level gives it to, and marked `by: user` |
| `review.provisional` | `queue`, `step`, `text?` | Orchestrator only (the loader ignores the user's too): a step of review level 3 waiting for its review is accepted provisionally, `text` what the user should look at; the run goes on (see "Provisional acceptances") |
| `review.confirmed` | `queue`, `step` | User only: confirms a provisional acceptance |
| `review.fix_asked` | `queue`, `step`, `text` | User only: Fix it on a provisional acceptance; the orchestrator drafts a revision with a step that fixes it |
| `status.set` | `queue`, `step?`, `to` (`skipped`, `finished`, `cancelled`, `propose-lift`), `reason` | Orchestrator only: housekeeping; the server checks it and records an entry in the queue's `changes` (see `queue.yaml`). A worker's is ignored by derivation, and the server applies only the orchestrator's own requests |
| `log` | `level`, `text` | Anything else worth keeping |

The server validates every event against the writer's role and ignores (and reports) what that role may not do.

**Step times** are derived from these events. A step's `started_at` is its first `step.started`; each `step.started`
opens a stretch at work (`segments` in the state), which ends at the step's `step.done` or `step.failed`, at a
`queue.stop` of its queue, at the run's `ended_at` when the run stopped going with the step still open, or, when the
step is started again without any of these, at the step's last event before the new start. The dashboard shows the
duration from the first start to the end (elapsed while at work) and, for a step started more than once, the working
time as the sum of the stretches (`packages/protocol/src/times.ts`).

## Server-owned runtime files

Written only by the server's queue engine; agents never touch them.

| File | What |
|---|---|
| `queues/<id>/git.yaml` | The HEAD of the queue's checkout around each step's work (`src/gitinfo.ts`): `base` (an auto worktree's: `ref`, the branch or commit it was made from, its `sha`, `at`), `base.branch` (whether `ref` names a branch: only a branch can be merged back into), `merged` (`at`, `into`, `path`, `sha`, `fast_forward`, `by`: `nexus` or `user`, absent on older records), `cleaned` (`at`, `path`, `branch`), `merge` (Nexus merging back by itself: `waiting` (`reason`, `since`: what keeps it, told to the user and the orchestrator; `released`: the queues whose runs Nexus held for this merge back and let go on when it could not go), `reintegrations` (runs of the integration step again since the user's last Merge back), `reintegrating` (when the last was asked for, until the step opens)), `setup` (the worktree setup command for the worktree Nexus made: `command` (the last one run), `at` (when the worktree was made), `done_at` (once it succeeded), `failed` (`at`, `reason`: its last failure)), `steps.<step>` (rounds, oldest first: `session`, `start` (HEAD when the step opened, or when a send-back reopened it), `started_at`, `end` (HEAD at the end of the turn in which the step got its outcome: done, review, failed or stopped), `ended_at`; a sha is null outside a git repository). A continued step keeps its open round. One writer: the server. See "Git on the dashboard" |
| `queues/<id>/push.yaml` | Pushing what was accepted: `review` (per step, the HEAD of the checkout when it entered review: `sha` or null, `finished_at`, `at`), `steps` (per accepted step: `acceptance`, `sha`, `result` (`pushed`, `failed`, `skipped`, `held`), `text`, `at`, `held_by?`), `pushed` (the last success: `sha`, `step`, `at`, `remote`, `branch`), `error` (the last failure until a success). One writer: the server. See "Pushing what was accepted" |
| `queues/<id>/plan.yaml` | The queue's place in the plan (see "The plan"): `by`, `reason?`, `after` (the queues it waits for, each with `queue`, `by`, `at`, `reason?`), `created_at`, `updated_at`, `started_at?`, `proposal?`, `decisions`. One writer: the server; it stays after the queue starts (marked `started_at`), and taking the queue out of the plan removes it |
| `queues/<id>/start.yaml` | The queue's next start as planned (see "The plan" and "Schedules"): `at?` (a schedule: the time, ISO 8601; with `usage`, `claude` or `codex`, when that is the usage window's reset plus the margin; without `at`, the options of a start by the plan; `after` only in files from before the plan, moved into `plan.yaml` at the server's start), the start's `runtime?`, `model?`, `effort?`, `session?` (a session to continue), `by` (`user` or `orchestrator`), `reason?`, `revision` (the queue's when planned), `created_at`, `failed?` (`at`, `reason`, `missed?`: it came due and the queue could not start; `missed`: a schedule more than 15 minutes late, the server not running at its time), `held?` (`since`, `kind`: `approval`, `checkout` or `limit`, `reason`: it came due but waits for the approval of the queue's current revision, for its checkout or for a place under the limit, and starts by itself; see "The plan" and "One queue per checkout, and a limit"). One writer: the server; a start of the queue or a cancel removes it |
| `queues/<id>/run.yaml` | The engine's intent for a queue: `session`, `after` (started by the plan: the queues that were done, a list; one id in older records), `state` (`running`, `pausing`, `paused`, `halted`, `finished`, `usage_wait`, `retry_wait`: a turn failed for a passing reason and is tried again at `resume_at`, `approval_wait`: a step ended while a newer revision waits for the user's approval, and the run goes on by itself once approved, see "A new revision of a running queue never stops the running step"; `running`, `pausing`, `usage_wait`, `retry_wait` and `approval_wait` hold the run's session and checkout: `runGoing` in the protocol's `status-rules.ts`), `reason`, the `step` it last opened, `nudged`, `resume_at` (when a usage wait or a retry goes on), `retries` (turns failed in a row for a passing reason; cleared by a turn that ends well or a new step), `failure` (the runtime's code for the failure being retried or that halted the run, e.g. `overloaded`), `resume_after_restart`, `runtime`, `model` and `effort` (the run's own as its start resolved them: the start's choice, else the continued session's, else the project's effective defaults; a missing model or effort is the runtime's default), `from_defaults` (which of the three came from the project's defaults: resolved again when each step opens; see "Runtime, model and effort per step"), `started_at`, `ended_at` (when it last stopped going: set when it becomes `finished`, `halted` or `paused`, kept while it stays so, removed when it goes on; older files without it fall back to `updated_at`), `summary_asked` (context care: the step whose context summary Nexus asked for; asked once), `switches` (each fresh session, oldest first: `at`, `from` and `to` session, `step` the new session began with, `why`: `context` (context care; a record without `why` is this), `runtime` (the step runs on another runtime), `refactor` (the closing refactoring step, see "The closing refactoring step") or `usage` (in the middle of a step, on its fallback: see "Fallback when usage runs out"), `fill` of the old one from 0 to 1 when known, `summary`: `written` by the worker, `asked` and then written, or `fallback`), `revision` (the queue's revision the run goes by: written at the start, moved to the current approved one at the end of a step), `checks` (the project's `defaults.checks` as they were at the start, when there were any: every step of the run runs them before the queue's own; see "The project's checks"), `fallbacks` (each step that opened on its fallback, and each that opened on its own values again after one did, oldest first: `at`, `step`, `runtime`, `model`, `effort` it opened on, `from` (its own values), `reason`, `back: true` for a switch back; see "Fallback when usage runs out"). Start refuses a `stopped` queue, naming the step and the stop's reason, and writes `revision`; it also refuses while the run holds its session (`approval_wait` included). Resume refuses a stopped or cancelled queue, an unapproved revision unless the run is of an older one (`revision` below the queue's; a run record without `revision` is older when a revision was replaced, in `history`, after its `started_at`: such a run goes on mid-step while the newer revision waits), and an `approval_wait` run until its revision is approved. A run of an older revision is resumed like any: a revision changes no started step. Archived records are `run.<time>.yaml` (see "Changes and lifting a stop") |
| `sessions/<id>/runtime.json` | A launched session's live facts: process state (`working` from a turn's start to its end, `idle` between turns, `exited`) and pid, model, context tokens and window, turns, cost; `interrupted` (`at`, `asked`, `handoff?`): a chat turn an update's hand-over cut off, until the next server goes on with it (see "The chats during an update") |
| `sessions/<id>/briefing.md` | A Claude Code session's briefing as its process last started with it (`--append-system-prompt-file`): rewritten at every start, read by the CLI as it starts. One writer: the server |
| `sessions/<id>/delivered.jsonl` | What the server handed to the session (notes put into a step turn, inbox entries injected or sent as a turn, or `carried` into the first turn of the session `to` that took over); counts as read |
| `sessions/<id>/refusals.jsonl` | One line per action the agent wanted but was refused: `at`, `session`, `runtime`, `by` (`permissions`: Claude Code's permission mode or rules; `nexus`: Nexus declined a Codex approval request; `auto_review`: Codex's auto reviewer), `tool` (Claude Code's tool name; for Codex `command`, `file_change`, `network`, `mcp`, `permissions`, …), `input` in short (the command, path or host, at most 300 characters), `reason` when the runtime gave one, `ref` (the runtime's id for the call: one record per refusal), `queue`, `step` |
| `sessions/<id>/activity.jsonl` | A condensed record of the agent's stream: turns, tool calls, texts (clipped to 600 characters), tool errors, exits, and retries (`retry`: the runtime's own and the engine's), tagged with queue and step |
| `sessions/<orchestrator>/applied.jsonl` | The server's result for each orchestrator request (`queue.drafted`, `session.request`, `status.set`), and the notices it has sent the orchestrator; the CLI waits for the result and prints it. Its context care's records: `context:asked` (its summary asked for; `message`: the context fill then, 0 to 1) and `context:first` (a fresh session's fill at the end of its first turn); see "The orchestrator's context care" |
| `sessions/<orchestrator>/chat.jsonl` | The chat shown in the dashboard: the user's messages, the orchestrator's texts (whole, however long) and tool calls, Nexus notices. Append-only: an entry's **line** is the index from 0 of its line in the file (blank and broken lines counted, never shown), and stays its line for good |
| `sessions/<orchestrator or conversation>/pins.json` | The chat's pinned messages: `{ pins: [{ line, at }] }`, `line` the message's line in that session's chat.jsonl, `at` when it was pinned; in chat order. A tool line cannot be pinned. A fresh session (a new orchestrator conversation) starts without pins; the old session's file stays with it. One writer: the server, on `POST …/sessions/:session/pins` from the dashboard |
| `<NEXUS_HOME>/settings.yaml` | The global settings, which projects follow where they have no value of their own (see "Global settings") |
| `<NEXUS_HOME>/usage.json` | The subscription's windows (5-hour, 7-day: utilization and reset time) from the latest `rate_limit_event` (Codex: `account/rateLimits`) of any session. Every session's turns count toward usage, workers', orchestrators' and thinking partners' alike (one subscription), so the usage display and the usage pause see them all |
| `<NEXUS_HOME>/turns.jsonl` | One line per agent turn of every project and role, appended by the server (AgentHost, its one writer) when the turn ends, or when its process ends first: `v`, `at` (the end), `started_at` (the runtime's turn start, or the first thing it streamed after the previous turn's end), `duration_ms`, `project`, `session`, `role` (`worker`, `orchestrator`, `conversation`), `runtime`, `model`, `effort`, `queue` and `step` (a worker's run, when any), `tags` (that step's tags as planned when the turn ended: its own over its queue's, renamed names read as the new ones; absent when it has none, see "Tags"), `fallback` (a turn of a step that runs on its fallback: `from`, the runtime it would have run on, and `reason`, its full window; see "Fallback when usage runs out"), `outcome` (`ok`; a failure's kind `passing`, `lasting` or `usage`, with `failure`, the runtime's code; `interrupted`: no result, because Nexus interrupted the turn or its process ended: a kill, an update's drain, a crash), `tokens` (the turn's own, its main loop's: `input` not from the cache, `output`, `cache_read`, `cache_creation`), `subagent_tokens` (what the turn's sub-agents used, in the same four figures, apart from `tokens`: Claude Code turns only, zeros when none ran; absent where unknown: a Codex turn, the first turn of a resumed process, an older record; read from the growth of `result.modelUsage`, the process's running total, less `result.usage`, see DESIGN.md "Sub-agent tokens"), `cost_usd` (the turn's own, where the runtime reports cost and it is known: Claude Code, not the first turn of a resumed process), `windows_start` and `windows_end` (the turn's runtime's usage windows, `utilization` and `resets_at`, as the server knew them when the turn began and ended; left out when none was known). In one file because the windows are the account's, across projects; statistics are computed from it when read. A turn's use of the windows is estimated when read (`usageEstimates`, `packages/protocol/src/usage-estimate.ts`, free of Node): per window, the window's growth between the turn's two readings times the turn's weighted tokens (sub-agents' included) over the weighted tokens of every turn of the same runtime within that stretch, each overlapping turn with the part of its tokens spent within it; `{ share }` (in utilization, 0 to 1) or `{ none }`: `missing` (no reading at the start or the end), `reset` (the window reset between them), `tokens` (the turn's tokens unknown). The token weights (`TOKEN_WEIGHTS`) and the method: DESIGN.md, "Estimating a turn's use" |
| `<NEXUS_HOME>/away.yaml` | The user's away mode: `current` (`since`, `until`) while on, `past` periods (`since`, `until`, `ended`, `why`: `expired` or `off`). One writer: the server, on `POST /api/server/away` and when a period's time comes. See "Away mode" under "Review" |
| `<NEXUS_HOME>/limits.json` | `{ max_running: number }`: where the limit on queues running at once was kept before it became the global setting `defaults.max_running` (decided 2026-11-15, queue OP). A server whose `settings.yaml` has no `defaults.max_running` (from before it, or rewritten by an older server) takes a valid value from here into it at its start. The file stays: the server writes the global limit into it with every write of the global settings, so an older server (an update rolled back) reads the current limit. One writer: the server |
| `<NEXUS_HOME>/deploy.json` | `{ push_on_deploy: boolean }` (default `true` when the file is missing). One writer: the server, on `POST /api/server/settings` from the dashboard |
| `<NEXUS_HOME>/deploy-plan.json` | The planned deploy, if any: `plan?` (`id`, either `after` (`project`, `queue`, `step?`: none, the whole queue) or `at` (ISO 8601) with `deadline?`, `ref?`, `by?` (`project`, `session`: the orchestrator that planned it), `created_at`, `warning?`, `waiting_for?` (`queue/step`: the unconfirmed provisional work it waits for), `held?` (`project`, `queue`: the run it holds while it waits), `started?` (`at`, `update`: the id of the update it started)), and the last plan that ended, `ended?` (`plan`, `at`, `why`: `carried-out`, `dropped`, `update-failed` or `cancelled`, `reason`, `by?`). One writer: the server. See "Planned deploys" |
| `<NEXUS_HOME>/deploy-changes.jsonl` | One line per successful deploy with changes for agents: `key` (`deploy-changes:<new sha>`), `at`, `from`, `to` (full shas), `changes` (`commit`, `text`: the commits' `Agents:` lines, oldest first). One writer: the server that took over (a successor, once per deploy) |

A session launched by Nexus has `launched_by: nexus`, `runtime: claude`, `native_id` (Claude's session UUID, chosen
by Nexus) and the `model` it was started with. A queue may also say `worktree: auto`: Nexus then creates the worktree
and branch when it starts the queue and writes their paths back into `queue.yaml`.

**The project's checks.** A project's `defaults.checks` (project only, a list of commands; empty by default; in Nexus
`npm run lint`) are checks every step of every queue of the project runs, before the queue's own `checks`. A run fixes
them when it starts (`checks` in `run.yaml`): a change of the setting reaches a queue at its next start, not its next
step, and a resume goes on with what its run fixed; a run from before the setting has none. The step's opening lists
them first under "Checks for every step", then the queue's own; a check both name (compared trimmed) is listed and
run once. The orchestrator's review notice counts a missing one like a missing check of the queue. The settings API
stores them trimmed, without empty or repeated entries. The approval view and the queue's details show them before
the queue's own, marked "(project)": the run's while it has one that has not finished, else the setting now.

**Worktree setup.** A project's `defaults.worktree_setup` (project only; none by default; in Nexus `npm ci`) is a
command run once in each new worktree Nexus makes for a queue (`worktree: auto`), so the worktree can build and test
(its own `node_modules`, for example). When Nexus makes the worktree it records `setup` in the queue's `git.yaml`; the
engine runs the command through the shell in the worktree before the run's first step opens (no step opens while it
runs, at most 30 minutes) and records `done_at`. A failure (an exit code other than 0, or the time limit) halts the run
with the reason, `the worktree setup command (<command>) failed: exit code <n>; its output ends: <output>`, and records
it under `failed`; when the run goes on (Continue, resume), the project's command as it is then runs again in the same
worktree. A worktree the queue names by path, an existing one, and the project's own checkout get no setup.

**Merging back by itself and resolving conflicts** (`defaults.merge_back`, `defaults.resolve_conflicts`; global, with a
project override; both off by default, so a new project merges back only by the user's hand until the user turns
them on): with `merge_back`, Nexus merges a queue with a worktree of its own back by itself, when all its steps are
accepted, the merge has no conflict and its integration step's checks pass; with `resolve_conflicts`, the integration
step's worker tries to resolve a conflict with the current base, judged by the checks and the step's review, and only
one it cannot resolve waits for the user (see "The integration step"). How the base then moves: "Merge back and clean
up".

The event `review.accepted` (`queue`, `step`, `text?`, `to?`), written by the user or an orchestrator, accepts a step
held in `review`.

**Accept with a note** (the user's). The note is optional; empty means a plain accept. `to` says where it went:
- `next` (the default): the next pending step of the queue gets it as a note from the user (`notes/`), delivered when
  that step starts, like any note on a pending step.
- `orchestrator`: the note stays on the event, and the orchestrator is told it once per project, like a chat message
  of the user: it starts an orchestrator that has no session and is told whatever `notify` says (but not while an
  update drains; then after the restart). The key `notify:note:<event id>` in any orchestrator session's
  `applied.jsonl` marks it told, so a reset orchestrator is not told again. The chat shows the note.
- On the queue's last step (no pending step after it) the note always goes to the orchestrator.
An acceptance with a note pushes like any other (see "Pushing what was accepted").

**Reject** (the user's only, `POST …/steps/:s/reject` with an optional `text`; only on a step waiting for the user's
review). The server writes `review.rejected` as the user's session and pauses the run (`run.yaml`: `state: paused`,
the reason, `rejected: <step>`). Nothing is reverted.
- The step's status is `rejected` (its `reason` is the text). It is never run again.
- The derived queue has `rejection` (`step`, `at`, `text?`, `revision`: the revision current when it came) and is
  `paused`, with the reason, until the user approves a newer revision. Then the rejection lifts.
- Once the rejection lifts, the rejected step counts as closed, like a skipped one (`stepClosed`): it keeps its
  status `rejected` and its reason, start and resume run what is pending, and the queue is `done` when every other step
  is finished (the run ends `finished`).
- The orchestrator is told once per project, like a note on an acceptance: whatever `notify` says, starting it if it
  has no session (key `notify:reject:<event id>`). It proposes what follows as queue revisions for the user's
  approval: a revert as a step, changes to the remaining steps, or a new queue (then the user can stop this one).
- While the rejection holds, start and resume are refused, and nothing of the queue is pushed (no push of an
  acceptance, no Push again). After the approval, resume goes on at the first pending step: a run paused by a
  rejection may resume although it is of an older revision (it takes the new one).
- The orchestrator's approval notice for such a queue says to resume it.

### Review

Every step is reviewed when it is done; there is no level without review. A step's **review level** says who:

- `1`: the user reviews. The step is held in `review` for the user; the queue is `waiting`.
- `2`: the orchestrator reviews what can be checked; what is the user's (the look, the feel, what the project's rules
  give the user) goes to the user. The step is held in `review` for the project's orchestrator; the queue is
  `waiting`. The orchestrator accepts it (`review.accepted`), sends it back (`review.sent_back`) or hands it to the
  user (`review.asked_user`, with why).
- `3`: the orchestrator judges everything and the queue goes on. The step is held for the orchestrator as at level 2;
  it accepts what has nothing of the user's (`review.accepted`), accepts provisionally what has
  (`review.provisional`: the run goes on, see "Provisional acceptances"), or sends it back. Beyond the limit of
  send-backs the step goes to the user as at level 2, and its queue waits at that step. It may still hand the review
  to the user (`review.asked_user`) when it cannot decide.

**Provisional acceptances.** A `review.provisional` (only the orchestrator's, only of a level-3 step waiting for its
review; any other is ignored with a warning) makes the step `done` with `provisional` (`at`, `event`, `text?`) on the
derived step, and the run goes on. Until the user deals with it, it is in the **return batch**: one item of kind
`provisional` in the attention list ("N provisional acceptances wait for your confirmation"), with `provisional`, the
steps oldest first (`queue`, `step`, `title`, `at`, `text?`, `summary?`); a finished queue's steps too. For each the
user either confirms it (`review.confirmed`, `POST …/steps/:s/confirm`; `provisional.confirmed`) or asks a fix
(`review.fix_asked`, **Fix it**: the same `POST …/steps/:s/send-back`; `provisional.fix` with `text` and `at`). Both
are the user's only: the orchestrator never confirms, and the CLI has no command for either. A Fix it does not reopen
the step: the step and its work stay, and the orchestrator is told (whatever `notify` says) to draft a revision with a
step that fixes it. A queue that went on waits for that revision's approval at its running step's end
(`approval_wait`, see "A new revision of a running queue never stops the running step"); a finished queue gets a revision the user approves and starts.

**Away mode.** The user may mark that they are away until a time. It is global (all projects), the user's only, and
kept in `<NEXUS_HOME>/away.yaml` (written only by the server): `current` (`since`, `until`) while it is on, and `past`
periods (`since`, `until`, `ended`, `why`: `expired` or `off`). The user turns it on with `POST /api/server/away`
(`until`: a local time "8:00", the next such time, or an ISO 8601 time ahead; again with a new `until` moves its end)
or `nexus server away on --until 8:00`, and off with `{ until: null }` or `nexus server away off`; the CLI refuses
both from any agent session (`NEXUS_SESSION` set), the orchestrator's included, and there is no event for it.
`GET /api/server` and the derived state (`away`: `on`, `since?`, `until?`) say whether it is on now. It ends at
`until` by itself: the server keeps a timer (armed again at its start) that records the end (`expired`); a period
past its `until` reads as off at once.
- While it is on, a level-2 step is reviewed as level 3 (`levelNow` in `away.ts`): its review notice gives the level-3
  choices, and the orchestrator may accept it provisionally (`nexus review provisional`; the CLI checks the level as
  it is now). A `review.provisional` of a level-2 step is valid when its time lies in an away period, so it stays
  valid after the period ends. Level-1 steps are not touched. Without an orchestrator, or with its notices off, it
  changes nothing (those steps go to the user anyway).
- The orchestrator is told when it comes on or its end moves (key `notify:away:on:<since>:<until>`, "The user is
  away until HH:MM."), when it ends (`notify:away:end:<since>`, "Away mode ended at its time." or "The user turned
  away mode off."), and, while it is on, of each queue that waits for the user at a step (level 1, the send-back limit,
  or handed to the user; key `notify:awaywait:<queue>:<step>:<time>`): the queues next in the plan, which Nexus starts
  by itself, each with what it waits for (or that nothing else is in the plan), and the paused queues that could go on
  (`Engine.startable`). Meanwhile only the plan's next queues start: the orchestrator starts no queue outside the plan
  and puts no approved queue into it (see "The plan").

A step in review has finished its turn: a pause asked for while it ran (the user's, or an update's drain) takes
effect then (`pausing` becomes `paused`), and the review goes on meanwhile. A worker's process that ends on its own
while its run's step is in review is no failed turn: the run waits for the review, then finishes if nothing is left,
or starts a process that resumes the session for the next step or a send-back.

Levels 2 and 3 go to the user instead when the project has no orchestrator (`project.yaml` has no `orchestrator`) or
its notices are off (`orchestrator.notify: false`); this is derived, so turning notices off hands every step waiting
for the orchestrator to the user.

**Where a step's level comes from** (`reviewLevelOf` in `state.ts`; the derived step has `level` and `level_from`):
the level the user set on it (queue's `user_levels`, `user`), else the one it was drafted with (`review.level`,
`step`), else its queue's (`review_level`, `queue`), else the project's effective `defaults.review_level` (its own
value, else the global one, built-in 2; `project`). The orchestrator writes each step's level into its draft: criteria
that can be checked (tests, measurements, numbers) give 2, a criterion that is the user's judgement (the look, the
feel) gives 1.

**The user's level** of a step (`PUT …/steps/:s/level`, `setStepLevel`) goes into the queue's `user_levels`, written
only by the server. It is not part of what an approval pins (the `hash` in `approvals`: steps, checks and stop conditions), so it asks for no new approval; a
later revision keeps it for the steps it keeps, and a draft cannot bring levels of the user's (its `user_levels` is
ignored). `null` clears it: the step's drafted level applies again. The queue's own `review_level` (`PATCH
…/queues/:q`) is not pinned either. Both change also after approval, until the step's review is over: a step that is
`done` (also accepted provisionally), `skipped`, `failed` or `rejected` keeps its level, and a request to change it is
refused (409). A step waiting for the orchestrator's review whose level a change of the user's makes 1 (its own, or
the queue's it takes) goes to the user: the server writes `review.asked_user` from the user's session ("The user set
the step's review level to 1: they review it themselves."), the step's `asked_user` gets `by: user`, and the
orchestrator is told once ("The user set the review level of step S of queue Q to 1 while it waited for your
review…"); the user's item shows the step's summary. A step the user's change sets to 3 keeps waiting for the
orchestrator: nothing is accepted by itself. The level a step's review goes by is read when the state is derived, so
the user's `review.asked_user` is what keeps such a review the user's should the level change again.

**Before review levels** there were review policies: `review_policy` on the queue, `review.policy` on a step and
`defaults.review_policy` in the settings, with `continue` (no review), `wait` and `orchestrator`. Every reader takes
them as levels (`withLevel` in `schemas.ts`): `continue` and `orchestrator` became 2, `wait` 1; a level beside one
wins. Files keep the old keys until their next write, which writes the level; drafts from an older briefing are read
the same way. An approval of the old form stays valid: when `queue.yaml` is read (`parseQueue` in `store.ts`), an
approval of the current revision whose hash is that of the same content in the old form (each step's review with its
`policy`) is taken as pinning the new form, and written so at the queue's next write.

**Steps done before review levels keep their meaning.** The server records once, at its first start with review
levels, when the project's steps began to be reviewed by level (`review_levels_since` in `project.yaml`;
`ProjectStore.markReviewLevels`). A `step.done` from before that time is derived by the old policy of its step: its
own, else its queue's, kept from the old fields as `legacy_policies` in `queue.yaml` when the file is first read in the
new form (and kept by later revisions for the steps they keep). `continue`: the step is done, with no review; `wait`:
it waits for the user; `orchestrator`: for the orchestrator (an acceptance it gave then stands). A step without an old
policy (its queue had none, or the file lost the old fields) reads `wait` from level 1, else `continue`, the old
built-in default. A `step.done` after that time, and every one in a project without the mark (a new one), goes by its
level. So queues finished before the change stay finished, and nothing about them is told.

The derived step has `review_with` (`orchestrator` or `user`) while in `review`, `asked_user` (`text`, `at`) after a
hand-over in the current round, and `sent_back` (each `id`, `text`, `at`, `by`, `round`, `delivered`, `to_user?`). Only a step waiting for the user is in the
user's attention list (kind `review`, with the orchestrator's reason as its text when it handed it over); the queue
shows `waiting` in both cases. An orchestrator's `review.accepted` or `review.asked_user` on a step that waits for the
user is ignored (with a warning); the user may accept either. Workers may write none of the three events.

### Sending a step back

One server action (`sendBack` in `packages/protocol/src/actions.ts`) sends a step in review back to its worker, with
who sends it (`orchestrator` or `user`) and the text. The orchestrator's comes from `nexus review send-back` (its
`review.sent_back` event, which the server carries out and answers in `applied.jsonl`); the user's is **Fix it** in
the dashboard (`POST …/steps/:s/send-back`), for which the server writes `review.sent_back` as the user's session, the
text verbatim (it must not be empty). Picture comments (N8.3) are a user's Fix it.

- The orchestrator sends back only a step waiting for its review; Fix it is only for a step waiting for the user.
- The server **routes send-backs** like answers: each accepted one goes once into the inbox of the session that worked
  on the step, as `send_back` (`id` `send-back-<event id>`, `ref`, `queue`, `step`, `text`, `round`, `from`). That
  entry reopens the step: derivation sets it `running` again as round `round` (its `step.done`s so far plus one). The
  engine hands the entry to the same session as the next turn; on a paused or halted run it waits, and the resume
  opens the turn with it. The worker's prompt names the round, the text, the step's criteria, and, for a Fix it,
  that the user's words win over the acceptance criteria where they conflict. No new queue revision is made.
- The orchestrator's send-backs of a step beyond `defaults.review_send_back_limit` (default 2) are not delivered: the
  step goes to the user (`review_with: user`, `asked_user` saying so with the text), and the entry is `to_user`. The
  user's Fix it does not count toward the limit.
- After a Fix it the step's next round waits for the user, whatever the level (`user_fix` on the derived step).

### Git on the dashboard

The server reads git for the dashboard (`apps/server/src/gitinfo.ts`), only locally: `rev-parse`, `log`, `rev-list`,
`reflog`. It never fetches, so remote-tracking refs are as old as the last fetch anyone made.

- **Commits per step.** `git.yaml` records the HEAD of the queue's checkout when a step opens (or a send-back reopens
  it), before its worker is told of it, and at the end of the turn in which it got its outcome (at the latest when the
  next step opens); the step's commits are those between (`start..end`), with
  their subject, author, time, and files and lines changed. A round still at work runs to the present HEAD.
- **Foreign commits.** In the project's main checkout others may commit too. A commit whose time lies outside every
  turn of the worker's session on that step (its runtime's `turn_start` .. `turn_end` in `activity.jsonl`, with two
  seconds' slack) is marked `foreign`. In a worktree of the queue's own nothing is marked.
- **The branch.** The queue's `branch` (else the checkout's current one): ahead and behind of its base (an auto
  worktree's recorded `base`, else the queue's `base`) and of its remote-tracking ref (its upstream, else
  `origin/<branch>`), with `at`, when that ref last changed (its newest reflog entry).
- A project that is not a git repository shows none of it.

### Review pictures

The standard for review material is `nexus help review` (`packages/cli/src/help.ts`): formats, view keys, roles,
pairing, rounds, fixed-viewport captures, the process. It ships with Nexus, so every project has the current text
after a deploy; a project's own conventions stay in its AGENTS.md and its steps' `review.prepare`.

- **Where the files go.** `nexus review add` copies every file it is given (the picture and `--before` alike) into
  `.nexus/queues/<queue>/review/<step>/` and records the copy's absolute path; URLs are recorded as they are. The
  source may be anywhere outside the working tree (the worker's file tools may not write under `.nexus`; untracked
  files in a worktree block its cleanup); the help and the worker's briefing name the system's temporary folder
  (`<temp>/nexus-review/<step>/`), and `scripts/capture.ts` writes there by default
  (`<temp>/nexus-review/<queue>/<step>/`). The source is left as it is. A file already in the folder is recorded as
  it is; one of the same name and the same bytes is not copied again; one of a taken name with other bytes is copied as
  `<name>-2.<ext>`, `-3`, … (an earlier round's picture is never overwritten). Everything is checked before anything is
  copied: a refused command (a missing file, a folder, a wrong pair) leaves nothing behind.
- **View keys and roles.** `nexus review add <step> <picture> --key KEY --role ROLE` adds one picture (PNG, JPEG, GIF
  or WebP; kind image or sheet) with its view key and role. A key is the view's subject and state in lowercase words
  joined by hyphens (dots allowed), `@`, and the window's width in CSS pixels: `waiting-tab@492`
  (`VIEW_KEY` in `packages/protocol/src/pictures.ts`). The label is a caption only. Roles: `before` (the old state),
  `mockup` (the design), `after` (the new state), `variant-a` and `variant-b` (two alternatives), `result` (a new view
  with nothing to compare). The item records `key`, `role`, `size` (read from the file) and the round: `--round`, else
  the step's current one (the round its latest delivered send-back opened, else 1). `--key` and `--role` go together,
  with one picture, and not with `--before`.
- **Keyed pairs** (`counterpartOf`, the same rule for the check and the viewer), among the items added before it:
  an `after` pairs with the latest `before` or `mockup` of its key; without one, with the latest `after` or `result`
  of its key from the latest earlier round (`round N`; a new screen added as a result in round 1 and taken again as an
  after in round 2); a `variant-b` with the latest `variant-a` of its key. `before`, `mockup`, `variant-a` and
  `result` have no counterpart of their own.
- **Checked pairs.** `nexus review add` refuses a keyed picture (exit 2, nothing recorded) whose key is not a view
  key; an `after` or `variant-b` with no counterpart of its key (naming the step's same view at another width, "another
  key", or else what the step has); and a picture whose counterpart has other pixel dimensions. Every refusal says
  why and ends with `See: nexus help review`.
- **Pairs without a key** (older material): a picture is compared with the one its item names (`before`, from
  `nexus review add <step> <picture> --before <path>`, one picture at a time), else the latest earlier unkeyed
  picture with the same label from an earlier round (without round numbers: the latest earlier one with that label).
  Nothing checks them.
- **The viewer** shows a picture and its counterpart beside each other (stacked when the screen is upright) or
  overlaid with a slider; `pairPictures` (`apps/web/src/review.ts`) finds the other side and `comparisonOf` names the
  comparison, under the picture's title before its key and round ("before → after", "mockup → after", "variant A /
  variant B", "round 1 → round 2"; a keyed picture shown alone by its role, e.g. "result"), and the two sides
  (Before, Mockup, Variant A, Round N; After, Variant B, Round M). Unkeyed pairs keep Before and After.
- **How agents learn the standard.** The worker's briefing has its essentials (keys, roles, the same conditions, a
  refused pair) and the pointer to `nexus help review`; the orchestrator's briefing asks for review.prepare with keys
  and roles. The opening of a step with a `review.prepare` and every send-back repeat the pointer.
- **Marks.** The user may mark a picture accepted (`review.marked`, by its path), and take the mark back. It is a
  mark only: the step is not accepted by it. The derived step has `pictures.<path>` (`accepted`: when, while marked;
  `comments`).
- **Comments.** A comment on a picture goes, while the step waits for the user's review, back to the worker with a
  send-back (a user's Fix it, see "Sending a step back"); while the orchestrator holds the step in review, to the
  orchestrator, as a note for it on that step (`to: orchestrator`, see "Notes"; `review.commented` `to: orchestrator`);
  otherwise it becomes a note from the user on the next pending step after it, delivered when that step starts. With
  none of these it is refused. The text sent says which picture
  (`About the picture "<label>" (<path>): …`); `review.commented` records the user's own words and where they went.

### Merge back and clean up

A finished queue (`done`) with a worktree of its own is merged back into its base and cleaned up by the server with
local git (`apps/server/src/mergeback.ts`, `merger.ts`): by Nexus itself when the project's `merge_back` is on, else by
the user's two actions in the dashboard, each confirmed first. There is no CLI command or event for either, and the
HTTP writes take only the dashboard's own requests, so neither the orchestrator nor a worker can trigger them.

**A queue with an integration step** goes back one way only, whoever asks: its base moves forward to the integrated
commit (the end of the integration step's last round in `git.yaml`), `git merge --ff-only`, never a merge commit on
the base. The server and the user's Merge back judge it the same way (`judgeMerge`) under one lock per queue, so they
never race; whoever comes second finds it merged. Nexus does it by itself (`merge_back` on) when, after any change:

judged in this order:

1. every step is closed and none waits for its review; unconfirmed provisional work holds it only with
   `provisional_counts` off; the integration step's last round is closed (a round still open within a minute of the
   step's end is still ending: nothing is judged yet); the queue's branch is still at the integrated commit; the
   integration step's checks in its last round passed, and, when the base moved on, the step has run again fewer than
   twice by itself (`merge.reintegrations`); the base is checked out somewhere, not only detached, not in the live
   worktree. Else it waits and tells, and holds nothing;
2. a step at work in the base's checkout (running, waiting for an answer, or a pause waiting for the step's end) is
   held at its step's end first: the engine holds such a run (the boundary a planned deploy uses; `run.yaml` paused,
   `resume_after_restart`), so its uncommitted work is not judged as a dirty checkout;
3. the base's checkout has no uncommitted changes to tracked files (untracked files never keep it), else it waits and
   tells;
4. when the base moved on (it is no longer an ancestor of the integrated commit), the integration step goes back to
   `pending` (a `changes` entry `kind: status`, `by: nexus`, with the reason; the queue is no longer `done`) and the
   queue's run starts again: a new round, reviewed again. The base's checkout stays held meanwhile: a run there that
   reaches its step's end is held too. After two such runs by itself it waits for the user, whose Merge back runs it
   once more and starts the count anew (`merge.reintegrations` back to 0);
5. the fast-forward; then the runs held for it go on (`releaseHold`).

A hold lasts at most one run of the integration step (its checks and its review included). Whenever the merge back
cannot go once a run is held (a dirty checkout, failed checks, the limit, a run again that halts, waits, or cannot
start), the held runs go on at once, and the wait is recorded with them (`merge.waiting.released`), so the user and the
orchestrator are told; nothing stays held. Nothing moves while an update, a deploy or a hand-over is under way.

What keeps it waiting that the user should know of is recorded in `git.yaml` `merge.waiting` (once per reason, and
again when held runs went on: `released`, their queues): the user's waiting list has an item of kind `merge` with the
reason (and, with `released`, "; the run of queue M, held at its step's end for this merge back, goes on"), and the
orchestrator is told the same (`notify:mergewait:…`); a merge back Nexus did is told to it too
(`notify:merged:…`). While something waits it is looked at again every 30
seconds, since git can change what holds it without a file of the project changing. Nothing is pushed: the base goes
out with the next deploy, and a deploy planned after such a queue waits for its merge back (see "Planned deploys").

With `merge_back` on, the cleanup follows the merge (by anyone) once no provisional acceptance of the queue waits for
the user; a Fix it until then runs in the worktree and goes through the integration step again. A cleanup that is
refused waits and tells like the merge.

**A queue from before the integration step** (no `integration` mark) keeps the user's merge as it was:

- **The base** is recorded when Nexus makes an auto worktree: `git.yaml` `base.ref` (the queue's `base`, else the
  branch the project's checkout was on) and whether it is a branch.
- **Merge** (a queue without an integration step) runs in the worktree where the base branch is checked out: `git merge
  --no-edit <branch>`, a fast-forward when possible, else a merge commit. Refused when the base is checked out nowhere (or only detached), when that
  worktree has uncommitted changes to tracked files, when a run is going there, or when it is this server's own live
  worktree. On a conflict the merge is aborted (`git merge --abort`) and the refusal names the conflicting files;
  nothing is left half-done. A branch already in the base is reported as such. Nothing is pushed.
- **Cleanup** checks first, and removes nothing when refused: the worktree must have no uncommitted changes
  (untracked files included), and the branch must be merged (into its upstream if it has one, else into the base's
  checkout, as `git branch -d` decides). Then `git worktree remove` (never `--force`; a few tries), and what Git for
  Windows cannot delete (paths beyond 260 characters without `core.longpaths`) is deleted by Node and the worktree list
  pruned; then `git branch -d` (never `-D`).
- Both are recorded in `git.yaml` (`merged` with `by`, `cleaned`) and shown on the queue.

### Removing a project

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

### A project's rules files

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

### Pushing what was accepted

With `defaults.push_accepted` on, an accepted step's work is pushed by the server, not by an agent
(`apps/server/src/accepted.ts`):

- When a step enters review, the server records the HEAD of the queue's checkout (its worktree, else the project's
  checkout) in `push.yaml` (`review.<step>`: `sha`, the round's `finished_at`). Recorded with the setting off too, so
  turning it on later finds the commits.
- When a step is accepted (`review.accepted`, by the orchestrator or the user), the server pushes, in the background,
  that commit, never the branch tip: `git push <remote> <sha>:refs/heads/<branch>`. The branch is the queue's
  `branch`, else the checkout's current one; the remote is the branch's upstream, else `origin`. A branch missing on
  the remote is created there. As with the push on deploy: a plain push (git refuses anything but a fast-forward,
  never forced), `GIT_TERMINAL_PROMPT=0` and `GCM_INTERACTIVE=never`, at most 60 s. A commit of the next step made
  before the push is not pushed.
- Only the queue's newest acceptance is pushed; its commit includes the earlier ones. One push at a time per queue;
  an acceptance during a push is taken up after it.
- A provisional acceptance (`review.provisional`) is an acceptance here when `defaults.provisional_counts` is on (the
  default). With it off, a push waits while its commit contains provisional work the user has not confirmed: a step
  of the project with a provisional acceptance waiting for the user, whose recorded review commit is the commit or an
  ancestor of it, and that made commits of its own (its first round in `git.yaml` did not start at that commit). The
  step is then recorded `held`, with `held_by` (`queue/step`, what holds it); the push is tried again once one of those
  is confirmed or sent to a fix (the user has seen it; the fix is a step reviewed on its own), or the setting is turned
  on. So neither the provisional work nor anything built on it (an accepted step after it, in its queue or another
  in the same history) is pushed until then.
- The outcome goes in `push.yaml` `steps.<step>` (`acceptance`, the event's id; `sha`; `result` `pushed`, `failed`,
  `skipped` or `held`; `text`; `at`; `held_by?`). A failure also sets `error` (`text`, `at`, `sha`, `step`) until a push succeeds; it does
  not undo the acceptance. It is tried again at the next acceptance, whose commit includes the failed one (which then
  shows as pushed with it), and with **Push again** (`POST …/queues/:q/push`), which pushes the step of `error`
  again. Without a remote (no upstream, no `origin`) nothing is pushed, and the step says so (`skipped`).
- With the setting off nothing is pushed.

## The user's session

The server keeps one session with id `user` and role `user` for what the user does in the dashboard. Its event log
holds the user's answers (`answer.given`). Like an orchestrator, it may write the events workers may not.

## Inbox: `sessions/<id>/inbox.jsonl`

Written by the server, read by the session's adapter or hook. A `message` may name the `queue` and `step` it is
about, so the dashboard shows it on that step. The server **routes answers**: every final `answer.given` (not an
escalation), from the orchestrator or the user, is appended to the asking session's inbox once, with the id
`answer-<event id>`. An orchestrator session that went on in a fresh one (`continued_by`, see "The orchestrator's
context care") has its answers appended to the newest session of that line instead, unless one of them has it already.
The orchestrator gets an answer in its inbox as a turn of its own (or into the running one), once; the chat shows it. It routes send-backs the same way (`send_back`, see "Sending a step back"). The session records
each entry it has seen with `message.read`; `nexus status` shows the unread ones and records them.

```json
{"v":1,"id":"01JD...","at":"...","type":"message","from":"user","text":"Use the grassland settings for the bench too."}
{"v":1,"id":"01JD...","at":"...","type":"answer","qid":"01JD...","from":"orchestrator","text":"...","continue":true}
{"v":1,"id":"01JD...","at":"...","type":"stop","from":"user","text":"Stop after this check."}
{"v":1,"id":"send-back-01JD...","at":"...","type":"send_back","from":"user","ref":"01JD...","queue":"W","step":"W2","text":"Blue, not red.","round":2}
```

`delivered_at` is recorded by the server in `state.json` once the runtime has accepted the message (stdin write,
`turn/steer` result, or a hook's output).

## `session.yaml`

```yaml
protocol: 1
id: 01JD...
project: honeycomb
role: worker                           # worker | orchestrator
runtime: claude                        # claude | codex | external
native_id: 6f1c...                     # Claude session uuid / Codex thread id
cwd: C:/Code/GameDev/ProjectHoneycomb
branch: v2/cliffs
launched_by: nexus                     # nexus | external
created_at: ...
forked_from: null
continues: 01JD...                     # context care (a worker's, the orchestrator's): the session this one took over from
continued_by: 01JD...                  # context care: the session that took over from this one
about:                                 # a conversation about a step (role conversation only); not `queue`
  queue: W
  step: W3
  seeded: { status: review, at: ... }  # the step's status when the partner last got its context
```

## The `nexus` CLI

The only interface agents use. It finds its session from the `NEXUS_SESSION` and `NEXUS_DIR` environment variables
(set by Nexus when it launches a session, or by `nexus attach` for a session started by hand), validates the
arguments against the protocol and appends one event.

```
nexus status                                   # the current queue, step, notes and unanswered questions, as text
nexus step start W3
nexus step progress W3 "Support graph built; probing fixtures"
nexus review add W3 $TEMP/nexus-review/W3/sheet.png --label "Sheet, round 1"   # copied into .nexus/queues/<q>/review/W3/
nexus review add W3 $TEMP/nexus-review/W3/cliff@1280.before.png --key cliff-lit@1280 --role before --label "Cliff, before"
nexus review add W3 $TEMP/nexus-review/W3/cliff@1280.png --key cliff-lit@1280 --role after --label "Cliff, lit"   # pairs by key
nexus review add W3 $TEMP/nexus-review/W3/lit.png --before $TEMP/nexus-review/W3/unlit.png --label "Lighting"   # older: no key
nexus help review                              # the standard for review material (nexus help: the topics)
nexus help summaries|questions|refusals|commits   # the other standards
nexus check W3 "npm test" --ok --summary "548 passed" --duration 190   # the name exactly as "Checks for every step" lists it (another counts as not reported); how long it ran, in seconds: the metric check:npm test
nexus metric record bundle-kb 512 [--step W3]  # worker only: a value of a project metric for the step at work, with HEAD
nexus metric list                              # the project's metrics (any session)
nexus stats [--by model|effort|kind|activity|area|size|origin] [--project <id>] [--since <date>]   # see "Statistics"
nexus step done W3 --summary "No floating body on any fixture" [--commit 1a2b3c] [--activities feature,test]   # warns at an unclean end; --activities: what was actually done (refused: a name on no list)
nexus step failed W3 --reason "..."
nexus stop W3 --condition "user decision" --reason "..."   # the condition as the queue words it; the reason short (shown first)
nexus ask "Canyon joints: vertical only, or also inclined?" [--option ...] [--recommend <option>] [--can-continue]
                                               # --recommend: one of the --option values, by text or number (1 = first)
nexus context --topics rock,support --files Runtime/Core/Rock/* <<< "summary text"
nexus report W --file <temp>/nexus-reports/<project>/W.md --summary "..." [--findings 3]   # copied to .nexus/queues/W/report.md; --findings: a maintenance queue's
nexus propose-change W --file patch.yaml --reason "..."
nexus template list | show <id>                # the queue templates in effect (see "Queue templates")
nexus recurring list                           # the recurring queues and their state (see "Recurring queues")
nexus static-analysis [status]                 # the stacks and static analysis Nexus sees, and the reminder's state (see "Static analysis reminder")
# orchestrator only
nexus queue draft --file queue.yaml
nexus queue draft --template bugfix --set issue="..." --set area=engine [--id BF]   # writes .nexus/drafts/BF.yaml to complete and upload
nexus recurring set weekly --template maintenance [--set scope=...] (--every "mon 03:00" | --after-queues 5) [--maintenance survey|fix_small] [--reason ...]   # through the server; the user approves it
nexus static-analysis decline --reason "..."  # the user's no to the static-analysis template: no reminder for 90 days
nexus answer <qid> "..." [--escalate [--recommend <option>]] [--continue|--wait]
                                               # --recommend only with --escalate: one of the question's options
nexus session start|resume|fork|pause|stop ...
nexus tags propose --area <name> | --activity <prefix:name> [--reason ...]   # a proposal for the project's tag lists
nexus tags rename <old> <new> [--reason ...]    # the user accepts it (see "Tags"); `nexus tags` lists them (any session)
nexus metric define bundle-kb --unit KB [--show line|bar|number] [--target 400] [--warn-above 500 | --warn-below=-1]
                                               # a project metric, or a change to one (see "Project metrics")
nexus attach                                   # register a hand-started session as external
# setup (the user)
nexus project add <path> [--id] [--name]       # creates .nexus/ (self-ignoring), registers the project, prints the rules files' check;
                                               # a kept .nexus/ (a project removed from Nexus) brings it back under its id
nexus import <file.md> [--prefix X]            # one-time import of queues written as Markdown tables
nexus note <queue> <step> <text>               # until the dashboard can add notes
nexus server away [on --until <8:00|ISO> | off]  # the user's away mode (refused from any agent session); no argument: its state
nexus server update --after <queue>[/<step>] [--ref <ref>]   # plan a deploy for after a step or queue of this project (the user, or an orchestrator the user asked)
nexus server update --at <HH:MM|"YYYY-MM-DD HH:MM"> [--deadline <time>] [--ref <ref>]   # plan a deploy for a time, with an optional deadline
nexus server cancel-plan                       # cancel the planned deploy (and the drain it started)
```

`nexus status` prints each step of a queue on a line of its own (id, status, title); a step that names its own
runtime, model or effort ends with them, `[on Codex · gpt-6-luna · low effort]` (what it leaves out is the run's).
The orchestrator's overview adds the same after the step in its `steps:` line, where each step also shows its review
level, `W1 pending (level 2)`, with `, set by the user` for a level the user set.
A step with checks reported gets a line under it with the latest result of each check (a check run again replaces
its earlier result) and its time when it was given: `checks: npm test ok (3 min 10 s), npm run typecheck ok (12 s)`.
The dashboard shows each check's time on the step, and the orchestrator's review notice gives it with the check
(`npm test: ok, 3 min 10 s (548 passed)`); the statistics will read the times from the `check.result` events.
A queue with a planned start gets a line `planned start after A; now: <waiting>` (or `at <local time>`), ending in
`(it starts by itself)` when the plan came due and waits for its checkout or for the limit (`held`); the
orchestrator's overview shows a held schedule the same way (`its time came, now: <waiting>`).

`nexus status`, run by a session with a queue, prints that queue's undelivered notes and records them as read
(`note.read`): being shown to the agent is the delivery.
Without a session (or with one that has no queue) it lists the queues at work (running, waiting, stopped), then the
approved ones not running, each with its steps and, when it is not running, the run left behind (`run: halted at W3
(...)`). An orchestrator or a thinking partner gets the overview of every queue instead.

`nexus report <queue> --file <path> --summary <text>` copies the file into `.nexus/queues/<queue>/report.md` (the one
writer of that file; a path that is already that file is left as it is) and records `queue.report` naming the copy, so
the dashboard and the run digest read it there. Workers may not write under `.nexus` with their file tools
(`protect_nexus`), and a report left in a working tree would block the cleanup of a worktree, so the last step's
prompt asks for the report in the project's **folder for reports**, outside every working tree and repository:
`<system temporary directory>/nexus-reports/<project>/<queue>.md` (`reportFile`; a Codex worker gets that folder as a
writable root). Once copied, a source in that folder is removed; a source anywhere else is kept.

`nexus step done` checks the step's end by the `commits` standard and **warns, never refuses**: in the session's
working directory (when it is a git repository), tracked files with uncommitted changes (untracked files do not count,
nor the thinking partners' notes folder, `conversations.notes_dir`, since the main checkout also holds the user's own
notes), and a HEAD that moved since the step started (the round's `start` in `queues/<id>/git.yaml`) while no
`--commit` is given. The warning names the files or the commits and says what to do; it is printed after `ok:` and
recorded as `warning` on the `step.done` event (the session's own log). Nothing else changes: the step is done.

`nexus help <topic>` prints one of Nexus's standards (needs no session or project, records nothing); `nexus help`
alone prints the commands and the topics. The topics live in `packages/cli/src/help.ts`:

| Topic | The standard |
|---|---|
| `review` | Review material: formats, view keys, roles, pairing, rounds, captures, the process |
| `summaries` | A step summary (`nexus step done --summary`) in four parts: what changed; how it was verified; what was left out or differs from the plan; what comes next, if anything |
| `questions` | A question (`nexus ask`) in three parts: what it blocks; the options; the asker's recommendation |
| `refusals` | A refused action: no workaround through another tool or command that reaches the same end; one retry in a simpler form at most; then report what was needed and why |
| `commits` | A clean working tree at every step's end: everything the step did committed (its own files only) and named with `nexus step done --commit`, so every commit belongs to one step |
| `tests` | Running tests while working: only the affected test files, stopping at the first failure (in Nexus's repository `npm run test:files -- <files>`); the whole suite once at the step's end, as the queue's checks; a test that fails now and then is fixed at its cause, not run again until it passes |

The briefings carry these in a few lines each with the pointer: the worker's all four; the orchestrator's the refusal
rule and the summary and question shapes as it reads them (and escalates in); the thinking partner's the refusal
rule.

Step states also include `stopped` (the step a `queue.stop` named, when it was not finished).

Output is short plain text so it reads well inside an agent's transcript. Exit code 0 on success, 2 on a protocol
violation (with the reason on stderr).

## The step turn

The engine opens each step with one message to the worker:

```
[Nexus] Queue W (revision 3, approved 2026-11-12), step W3 of W1–W7: Support.
Goal: ...
Acceptance: ...
Checks: <project's checks, as the run fixed them> + <queue's own>, each once
Review to prepare: <review.prepare>               # only with one, followed by the pointer to `nexus help review`
Stop conditions: <project defaults> + <queue's own>
Notes for this step (2): ...
Answers to your earlier questions: ...
Report with `nexus`. End the step with `nexus step done`, `nexus step failed` or `nexus stop`.
```

The template is a project setting, so each project can phrase it in its own terms.

## Server API

The replies the dashboard reads are typed once, in the protocol's types-only module `@nexus/protocol/api`
(`ProjectSummary`, `StepCommitsView`, `BranchView`, `LeftView`, `CommitDetail`, `ModelInfo`): the server builds them as
these types and the dashboard reads them as the same, so a change on one side fails the other's typecheck.

Reads: `GET /api/projects` (with each project's "waiting for you" list; a question's item carries its `qid` and its
`options`, if it has any), `GET /api/projects/:id/state`,
`GET /api/projects/:id/file?path=` (files under the project, its worktree directory or a session's directory only;
see "Files and commits" below), `GET /api/projects/:id/commits/:hash` (one commit; see there too),
`GET /api/projects/:id/rules` (the rules files' check: `{ state, agents, claude, unseen_by?, fix?: { changes: [{ file,
action, before?, after }], imports }, version, root }`; see "A project's rules files").
Live: a WebSocket at `/ws` sends `{"type":"changed","project":id}` and `{"type":"projects"}`.

Writes (JSON bodies only; a request with a foreign `Origin` is refused). Every write is a user action and is taken
only from the dashboard's own page: the request must carry this server's `Origin` and, if it sends one,
`Sec-Fetch-Site: same-origin`; anything else is refused (403). Agents change things through the `nexus` CLI, which
writes files. The only exceptions are `POST /api/server/update`, `POST /api/server/cancel`, `POST /api/server/plan`,
`POST /api/server/cancel-plan` and `POST /api/server/away`, which `nexus server` sends (see the CLI; it refuses `away`
from every agent session, and the others from every session but an orchestrator's).

| Request | Body | Effect |
|---|---|---|
| `POST /api/projects/:id/queues/:q/steps/:s/notes` | `text` | A note from the user for the step |
| `DELETE /api/projects/:id/queues/:q/steps/:s/notes/:note` | | Withdraws a note not yet delivered |
| `POST /api/projects/:id/sessions/:session/messages` | `text`, `queue?`, `step?` | A message to a session's inbox |
| `POST /api/projects/:id/queues/:q/approve` | `words?`, `work?` (`keep` or `discard`), `skip_closing?` (boolean) | Approves the current revision; for a stopped queue it also lifts the stop (see `queue.yaml`). `work` is required when the stopped step left commits of its own and no Discard is recorded; with `discard` nothing is approved (see "The work a stopped step left"). `skip_closing: true` skips the queue's closing refactoring step with the lift; refused (409), before anything is recorded, when the queue is not stopped, has no closing step or it has run (see "The closing refactoring step") |
| `POST /api/projects/:id/queues/:q/withdraw` | `reason?` | The user takes back the approval of a queue that never ran. There is no CLI command and no event for it |
| `PATCH /api/projects/:id/queues/:q` | `review_level` (1, 2, 3 or null: the project's) | Queue settings; not pinned by an approval |
| `PUT /api/projects/:id/queues/:q/steps/:s/level` | `level` (1, 2, 3 or null: the step's drafted level) | The user's review level of a step (`user_levels`); asks for no new approval, and later revisions keep it |
| `POST /api/projects/:id/questions/:qid/answer` | `text`, `continue?` | The user's answer, routed to the asker |
| `POST /api/projects/:id/queues/:q/run` | `action` (`start`, `pause`, `resume`, `stop`, `stop_at_once`, `cancel_start`), `runtime?`, `model?`, `effort?`, `session?`, `after?`, `next?`, `at?` | Runs the queue through a Nexus-launched session (`session` continues an existing one). `start` with `after` (a queue id or a list): the user's place for the queue in the plan, it starts when those are done; with `next: true`: in the plan with none before it (`{message}`; see "The plan"); with `at` (ISO 8601, or `usage-reset`): a schedule (`{message}`); `cancel_start` takes the queue out of the plan (`{message}`). `stop` pauses and sends the existing Stop now message (`text?` supplies the reason). `stop_at_once` pauses, interrupts the turn and kills only this queue's worker process, waiting for its exit before success; keeps uncommitted changes and the session, writes `step.interrupted`. No worker, a finished run, a stop already in progress or a session reused by another queue: 409. Resume during exit: 409; afterwards it continues the step in the same session. No CLI or orchestrator request action exposes `stop_at_once` |
| `GET /api/projects/:id/estimates` | | Expected times of the project's open queues, as estimates (`{ samples, min, queues: { <id>: { steps, ms? } } }`): `steps` the steps left (not closed), `ms` their expected time, absent while fewer than `min` (5) steps are finished. A finished (done) step's time is the sum of its worker turns' `duration_ms` in `turns.jsonl` (send-back rounds included, the wait for its review not), over every project the server has; a step to come takes the average of those on its model and effort, else its model, else all, each from at least 5 steps |
| `GET /api/projects/:id/metrics` | | The project's metrics and their values (`ProjectMetrics`: `metrics`, its own definitions and every check's time seen, `check:<name>`; `values`, oldest first, each a `StepView.metrics` entry with its `queue` and `step`); see "Project metrics". Unknown project: 404 |
| `GET /api/stats?by=&project=&since=&kind=&activity=&area=&size=&origin=` | | The statistics (`StatsReport`, see "Statistics"): every registered project, or one (`project`; unknown: 404), grouped by `by` (`model`, `effort`, `kind`, `activity`, `area`, `size`, `origin`; default `model`; another: 400), the steps whose last outcome is at or after `since` (a date or a time; unreadable: 400), narrowed to the steps under each tag value given (`kind=code`, `area=p/engine` across projects; the value as the groups name it) |
| `GET /api/usage/days?since=` | | The usage windows day by day for the global Stats view (`UsageDays`, see "Statistics") from `since` (a date or a time; default 30 days ago; unreadable: 400) to today, with `threshold`, the global `defaults.usage_pause_threshold` |
| `POST /api/projects/:id/tags/:proposal` | `action` (`accept`, `decline`) | The user's decision on the orchestrator's proposal for the project's tag lists (see "Tags"); only the user: no CLI command or event does it (`{message}`) |
| `GET /api/projects/:id/templates` | | The queue templates in effect for the project (`TemplatesResponse`: `templates`, each with `id`, `title`, `description?`, `layer`, `replaces`, `params` and a maintenance template's `maintenance`; `problems`, the files not used with why), for "New queue from template" (see "Queue templates") |
| `POST /api/projects/:id/recurring/:rid` | `action` (`approve`, `pause`, `resume`) | The user's standing approval of a recurring queue as it is now (its hash), a pause or its end (see "Recurring queues"); only the user: no CLI command or event does it. Already approved, already paused or not, or a recurring that cannot run (its template gone or not filling): 409; unknown: 404 (`{message}`) |
| `DELETE /api/projects/:id/recurring/:rid` | | The user removes a recurring queue; the queues it made stay (`{message}`) |
| `POST /api/projects/:id/queues/:q/plan` | `action` (`move`, `accept`, `decline`, `hand_back`), `after?` | The user's plan: `move` the queue after `after` (a queue id; `null`: with no queue before it), as in a list (see "The plan"); accept or decline the orchestrator's proposal; hand a dependency the user set (`after`; without it, all of them) back to the orchestrator (`{message}`) |
| `POST /api/projects/:id/queues/:q/steps/:s/pictures/mark` | `path`, `accepted` | The user's mark on a review picture (`review.marked`) |
| `POST /api/projects/:id/queues/:q/steps/:s/pictures/comment` | `path`, `text` | The user's comment on a review picture: a send-back or a note (see "Review pictures"); answers `{ ok, result: { message } }` |
| `POST /api/projects/:id/queues/:q/steps/:s/reject` | `text?` | Reject (the user's): the step is rejected, the run pauses until a newer revision is approved; answers `{ ok, result: { message } }` |
| `POST /api/projects/:id/queues/:q/steps/:s/confirm` | | The user confirms a provisional acceptance (`review.confirmed`); answers `{ message }`. Fix it on one is `…/send-back` (`review.fix_asked`) |
| `POST /api/projects/:id/queues/:q/steps/:s/accept` | `text?` (the note), `note_to?` (`next` or `orchestrator`) | Accepts a step waiting in review (and, with `push_accepted`, pushes it); answers where the note went (`to`, `step`) |
| `GET /api/projects/:id/queues/:q/steps/:s/commits` | | A step's commits per round: `{ rounds: [{ session, start, end, open, commits: [{ sha, subject, author, at, files, insertions, deletions, foreign }] }] }`, newest first; an open round runs to HEAD; null outside a git repository or with nothing recorded |
| `GET /api/projects/:id/queues/:q/git` | | The queue's branch: `{ branch, base?: { ref, ahead, behind }, upstream?: { ref, ahead, behind, at? } }`; null outside a git repository, before an auto worktree exists, or on no branch |
| `POST /api/projects/:id/queues/:q/merge` | | Merge back a finished worktree queue's branch into its base (see "Merge back and clean up"); answers `{ ok, result: { message } }` |
| `POST /api/projects/:id/queues/:q/cleanup` | | Clean up a finished worktree queue: the worktree removed, its branch deleted with `-d`; answers `{ ok, result: { message } }`. Refused while the worktree has uncommitted changes; the refusal names them as git status does (`?? tmp/`, `M a.txt`, up to 20) |
| `POST /api/projects/:id/rules/fix` | `version` (the check's) | The fix of the rules files as the check showed it (see "A project's rules files"); answers `{ ok, result: { message } }`. Commits nothing |
| `POST /api/projects/:id/queues/:q/push` | | Push again: the step of the queue's last failed push; answers `{ ok, result: { message } }` at once, the push runs in the background |
| `POST /api/projects/:id/queues/:q/steps/:s/send-back` | `text` (required, kept verbatim) | Fix it: sends a step waiting for the user's review back to its worker; on a provisional acceptance it asks the orchestrator for a fix (`review.fix_asked`); answers `{ ok, result: { message } }` |
| `POST /api/projects/:id/queues/:q/continue` | `work?` (`keep` or `discard`), `skip_closing?` (boolean) | Continue: lifts the stop of a stopped queue whose current revision is approved and goes on (see "Continue" under `queue.yaml`); refused (409) otherwise. `work` is required when the stopped step left commits of its own; `discard` records it and does not go on. `skip_closing: true` skips the queue's closing refactoring step with the lift; refused (409), before anything is recorded, when the queue has none or it has run (see "The closing refactoring step") |
| `GET /api/projects/:id/queues/:q/left` | | What a stopped queue's stopped step left (see "The work a stopped step left"); null when not stopped at a step |
| `GET /api/projects/:id/sessions/:session/chat` | query `from`, `to` (lines) | A chat's entries with lines from `from` up to, not including, `to`: `{ chat: [entry + line] }`; what is older than a chat view's window. Only the orchestrator's or a conversation's session (404 otherwise) |
| `GET /api/projects/:id/sessions/:session/chat/search` | query `q`, `tools` (`1`: tool lines too) | Search over the whole chat.jsonl, not only a view's window: `{ lines }`, the lines of the entries that contain `q`, oldest first; case and accents ignored, the query's spaces collapsed (`searchChat` in `@nexus/protocol/chat`) |
| `GET /api/projects/:id/search` | query `q`, `kinds`, `since`, `limit`, `tools` | The project's whole history searched, from its files without an index: `{ hits, total, more }`, newest first; see "Searching a project" below. Refused (400): no words, an unknown kind, an unreadable time, a limit out of range |
| `POST /api/projects/:id/sessions/:session/pins` | `line`, `pinned` (true or false) | Pins or unpins a message of the orchestrator's or a conversation's chat (sessions/<id>/pins.json); answers `{ ok, result: { pins } }`. Refused (400): a line that holds no entry or a tool line (when pinning), a line that is not a whole number |
| `POST /api/projects/:id/orchestrator/messages` | `text` | A chat message to the orchestrator (starts or wakes it) |
| `POST /api/projects/:id/orchestrator/reset` | | The next message starts a new orchestrator session |
| `POST /api/projects/:id/orchestrator/stop` | | Stops the orchestrator's running turn (see "Stopping a chat agent's turn" under "The orchestrator"); refused (409) when it is not in a turn |
| `POST /api/projects/:id/orchestrator/settings` | `model`, `effort` (empty: the default) | The orchestrator's model and effort, from its next message on |
| `PATCH /api/projects/:id/settings` | `name`, `runtimes`, `defaults`, `conversations`, `languages` (`reader`, `working`), `orchestrator` (`notify`, `model`, `effort`, `context_threshold`) (an empty value clears a field), `own?`, `follow?` (lists of setting keys, `runtimes.claude.model`) | Project settings, checked against the schema (see "Global settings"): a setting given another value, or named in `own`, becomes the project's own (in `own` also when it equals the global value); one named in `follow` follows the global value again; naming one in both is refused |
| `GET /api/projects/:id/settings` | | `own` (the keys of the settings the project has its own value of) and `global` (the global settings) |
| `GET /api/settings`, `PATCH /api/settings` | the global settings, nested as in `settings.yaml` (null or empty clears an optional one) | The global settings (`global`; GET also `keys`, every setting with a global value). PATCH writes `<NEXUS_HOME>/settings.yaml`, checked against the schema; every project that follows a changed value has it at once |
| `POST /api/projects/:id/uploads` | `data` (the picture, base64, optionally as a `data:` URL) | Saves a picture for a chat message under `.nexus/uploads/` and answers `{ ok, result: { path, type, bytes } }`: `path` absolute (forward slashes), `type` `png`, `jpeg`, `webp` or `gif`. See "Uploads" below |
| `GET /api/projects/:id/removal` | | Whether the project may be removed now, and what goes with it or stays (`RemovalView`, see "Removing a project"): `name`, `blockers` (one sentence each; empty: it may go), `planned` (`queue`, `after`) and `scheduled` (`queue`, `at`) starts and open `questions` (`qid`, `queue?`, `step?`, `text`), which go with it; `worktrees` (`queue`, `path`, `branch?`, `exists`), which stay; `nexus_dir`, the folder Delete deletes, and `delete_refused?`, why it may not |
| `POST /api/projects/:id/remove` | `delete_data?` (boolean), `name` (with `delete_data`: the project's name as typed) | Removes the project from Nexus; with `delete_data` its `.nexus/` folder is deleted too (see "Removing a project"). Answers `{ ok, result: { removed, nexus_dir? or deleted?, worktrees } }`. Refused: 409 with `blockers` while anything runs, 409 when the folder may not be deleted (`delete_refused`) or the project is not registered in this server's NEXUS_HOME, 400 without the name. The user's only: no CLI command does it |
| `POST /api/projects/:id/settings/allow-rule` | `rule` | Adds an allow rule for Claude Code workers to `runtimes.claude.allowed_tools` in `.nexus/project.yaml` (once; a rule already there is left as it is), typically from a refusal. A tool name, optionally with a specifier in parentheses, on one line. Like every write, only from the dashboard's own page: an agent must not widen its own permissions. Nothing else is written, not the project's `.claude/settings.json` or `AGENTS.md` |

Also `GET /api/projects/:id/sessions/:session/activity?queue=&step=&limit=`, `GET /api/projects/:id/refusals?queue=&step=`
(the refused actions of every session of the project, oldest first; optionally only a queue's or a step's), `GET /api/projects/:id/orchestrator`
(its session, state, chat: the newest 300 entries, each with its `line`, and `pins`: each pin's `line`, `at` and `entry`,
wherever in the chat it is; a fresh session has none; and `earlier`: the sessions it went on from by its context care,
oldest first, each `{ session, created_at, chat, switch: { at, fill, summary } }`, its newest entries in what the 300
leave over, at least 60, `fill` from 0 to 1 or null and `summary` its `{ text, topics, files, at }` or null; the
dashboard shows them above the current chat, a "Fresh session" line at each switch), `GET /api/digest?since=` (below), `GET /api/usage` and `GET /api/models/:runtime`: the models a runtime offers, asked from the runtime itself
(Claude Code: an `initialize` control request on its stream-json input; Codex: `model/list`), with each model's
name, description and effort levels; the dashboard offers only these.

`GET /api/digest?since=<ISO 8601>` is the morning digest across every registered project (`packages/protocol/src/digest.ts`):
`{ since, events, running, usage }`. `since` is the time asked for (an unreadable or missing one means the last 24 hours).
`events`, newest first and at most 200, is what happened after it, each `{ at, project, project_name, kind, queue?,
step?, text, count?, report? }`: `done` and `failed` (a `step.done` or `step.failed` event, with its summary or
reason), `stopped` (a `queue.stop`, with its reason), `queue_done` and `queue_cancelled` (a queue whose status is done
or cancelled and whose last step finished, else whose run ended, after the time; `text` its title, `report` the path
of its report, for the file endpoint), `refused` (refusals, one line per queue and step with `count`, `text` the tool
and input of the latest) and `retried` (activity entries of kind `retry`, one line per step with `count`, `text` the
latest). `running` lists the queues that run now (`runsNow`, the same as the dashboard's "running" status and the
rail's "Running in", queue FU): the run is running or pausing, and no review, blocking question or revision waiting
for approval holds it (a run waiting for a retry, the usage window or an approval is not running), each
`{ project, project_name, queue, step?, since? }` (`since`: when the step's latest stretch at work began). `usage` is
the usage line's numbers since the time (`usageSince`), from `<NEXUS_HOME>/turns.jsonl` and the runs now:
`{ turns, peak_5h?, now_7d?, waits, wait_ms }`: how many turns ended in the period; the highest 5-hour utilization
(0 to 1) a turn ended with (`five_hour`, `codex_5h`); each 7-day window's latest value, the higher of them
(`seven_day`, `codex_7d`); and the waits for a usage window with their time in all: a turn with outcome `usage`, until
its session's next turn (or now while that session's run is in `usage_wait`), and a run in `usage_wait` now that no
such turn explains, from its file's last write (not before `since`). Read-only.

**Searching a project.** `GET /api/projects/:id/search?q=&kinds=&since=&limit=&tools=` searches everything a project
has recorded (queue SR), reading its files as they are, without an index (`apps/server/src/search.ts`; the pure part,
what each entry offers, whether it matches and the excerpt, is `@nexus/protocol/search`). Matching ignores case and
accents (`Kérdés` matches `kerdes`); a query of several words matches an item that holds every one of them, anywhere,
in any order, also inside longer words. `kinds`, comma-separated (every kind when missing):

| Kind | What is searched | Its place |
|---|---|---|
| `queue` | each queue.yaml's title with its description, and each step's title with its goal (time: the queue's `updated_at`) | `queue`, and `step` for a step's goal |
| `step` | a step's outcome: `step.done`'s summary, `step.failed`'s reason, `queue.stop`'s condition and reason | `queue`, `step` |
| `question` | `question.asked`'s text and `answer.given`'s; an answer gets its question's `queue` and `step` | `qid`, `queue`, `step` (none for a question not about a step) |
| `chat` | every entry of the orchestrator's and the conversations' chat.jsonl; a tool line only with `tools=1`, as in a chat's own search | `session`, `line` (the entry's line in chat.jsonl, from 0, as the chat views number them) |
| `report` | each queue's report.md, whole (time: the file's last write) | `queue`, `path` (absolute, for the file endpoint) |
| `review` | the text of the review events the user (or the orchestrator holding a review) wrote: `review.accepted`, `sent_back`, `rejected`, `commented`, `asked_user`, `provisional`, `fix_asked` | `queue`, `step` |
| `note` | each step note's body (notes/<step>/<id>.md) | `queue`, `step` |

`since` (ISO 8601) leaves out what is older; `limit` (1 to 500, 50 when missing) is how many hits are sent. A hit is
`{ kind, at, excerpt, ranges, queue?, step?, session?, line?, path?, qid?, from?, title?, tool? }`: `excerpt` is one line
around the first match (Markdown's line marks dropped, whitespace collapsed, about 160 characters, cut at words with `…`), `ranges` the
`[start, end)` spans of the words in it for the highlight; `from` who wrote it where known (a chat entry's `from`, a
note's author); `session` the session whose file holds it; `title` the queue's title, or the conversation's; `tool`
true on a chat's tool line.
`total` counts every match and `more` says there were more than `limit`. Worker activity (activity.jsonl), inboxes
and refusals are not searched. A JSONL log is read line by line in 64 KB chunks, a line is parsed only when every word
occurs in it raw, a file last written before `since` is not read (events.jsonl still is when questions are searched,
for an answer's place), and only the newest `limit` hits are kept while reading: newest first means every file is
read. Measured on 2026-11-15 on a copy of the Nexus project's own `.nexus` (320 files, 4.7 MB searched): a search of
every kind took 120 to 200 ms, of the chats alone 45 ms.

**Uploads.** A browser does not reveal a file's path, so a picture added to a chat message travels in the request,
base64 in a JSON body like every other write (and behind the same rules: the dashboard's own `Origin`, the token for
a request not from this machine). The body may be at most 14 MiB, checked before anything is read or parsed (from
`Content-Length`, or while a body without one streams in); a larger one gets 413 and the connection is closed. The
picture itself may be at most 10 MiB once decoded (413). Its type is judged from its first bytes, never from a name
or a declared type: PNG, JPEG, WebP and GIF only; anything else (an iPhone HEIC photo, SVG) gets 415. Both refusals
say `only PNG, JPEG, WebP or GIF up to 10 MB`. The server names the file: the UTC time it was taken
(`yyyymmdd-hhmmss`), the first 10 hex digits of the SHA-256 of its bytes, and the detected type's extension (`.png`,
`.jpg`, `.webp`, `.gif`); a name the client sends is ignored. The same picture in the same second is the same file.
The server is the only writer of `.nexus/uploads/` (each file written whole, then renamed into place), changes to it
do not reload the project's state, and nothing removes the files: they stay until the user deletes them. The
dashboard puts the returned path into the message, on its own line, and the file endpoint serves it back. Claude
Code opens the picture from the path with `Read` (the orchestrator's and a partner's allow lists hold a bare
`Read`); Codex does not open a path from the text, so the adapter adds the picture as a `localImage` input item (see
"How the engine runs a Codex session").

**Files and commits.** `GET /api/projects/:id/file?path=` serves a file to the dashboard (its file viewer, review
material, reports). A relative path is taken relative to the project's root (never the server's working folder). The
file must lie under the project's root, its worktree directory or a session's working directory, both as written and
with its links followed (a symlink or junction pointing out is refused, 403); a path with a `..` segment, and a UNC
or device path (`\\server\share`, `\\?\…`, `//…`), are refused (403) before anything touches the disk; a missing file is
404. Every response carries `X-Content-Type-Options: nosniff`, `Cache-Control: no-cache`, `X-Nexus-Size` (the whole
file's bytes), `X-Nexus-Kind` (`text`, `picture`, `pdf` or `binary`), `X-Nexus-Path` (the file's absolute path with
its links followed, URI-encoded; the dashboard's "Open in editor" uses it) and a `Content-Security-Policy`:
`default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox` for everything but PDFs, which get
the same without `sandbox` (a sandboxed document cannot use the browser's PDF viewer; `default-src 'none'` still lets
nothing in it run). So an SVG or HTML file opened from the dashboard's origin runs no script. Pictures (`.png`,
`.jpg`, `.jpeg`, `.gif`, `.webp`, `.svg`) and PDFs are served whole with their types. Any other file is text unless
its first 8 KB hold a NUL byte: text is served as `text/plain; charset=utf-8` (`.md` as `text/markdown`, `.json` as
`application/json`; `.html` is plain text), and text over 1 MiB is cut at the last line end within the first 1 MiB,
with `X-Nexus-Truncated: 1`. A binary file is served as `application/octet-stream` with `Content-Disposition:
attachment`: a download, never shown.

`GET /api/projects/:id/commits/:hash` answers one commit of the project's repository (local git only):
`{ sha, subject, author, at, files: [{ path, insertions, deletions }], insertions, deletions }` (`at` ISO 8601, the
author date; a binary file's `insertions` and `deletions` are null; a merge's files are against its first parent).
The hash must be 7 to 40 lowercase hex digits (else 400, before git runs); it is passed to git as `<hash>^{commit}`,
so an unknown or ambiguous hash, or one naming something other than a commit, is 404.

**Remote access.** A request is local when it comes from a loopback address without proxy headers
(`X-Forwarded-For`, `Forwarded`, `X-Forwarded-Host`, `Tailscale-User-Login`). Anything else, pages, API and the
WebSocket alike, needs the `nexus_auth` cookie holding the token from `<NEXUS_HOME>/auth.json`, set by
`POST /login` (form field `token`) or `GET /login?token=`. `GET /api/remote` gives the Tailscale address, the devices
receiving push and, to local requests only, the token, a sign-in link and its QR code; `POST /api/remote/rotate`
(local only) replaces the token.

**Push.** `GET /api/push/key` (the VAPID public key), `POST /api/push/subscribe` (`subscription`, `label`),
`POST /api/push/unsubscribe` (`endpoint`), `POST /api/push/test`. Keys and subscriptions are in
`<NEXUS_HOME>/push.json`. Whatever newly appears in a project's "waiting for you" list is pushed to every device; the
list as found when the server starts is the baseline.

**Nexus itself.** `GET /api/server` gives the version (`commit`, `subject`, `live`, `branch`, `root`), `local` (whether
this request came straight from this machine, as remote access judges it: the dashboard shows "Open in editor" only
then) and `update`:
`phase` (`idle`, `draining`, `updating`, `restarting`, `failed`, or `updated` on a server that took over from an
update), `held`, `waiting`, `log`, `error?`, and after a deploy `push?` (`result`: `pushed`, `failed` or `skipped`,
`text`, `at`), `id` (the update's id), `by?` (`project`, `session`: the orchestrator that asked for it) and, on a
successor, `up` (`commit`, `subject`, `previous?`). It also gives `push_on_deploy`, `max_running` (the global `defaults.max_running`: the limit on queues
running at once), `away` (the away mode now: `on`, `since?`, `until?`), `plan` (the planned deploy, as in
`deploy-plan.json`, with `waiting?`: what it waits for, in a sentence; null when none) and `running`: the steps running
now, per project (`project`, `name`, `steps`: `queue`, `step`, `title`, `session`, `run`), which `nexus server status`
prints. `POST /api/server/update` (`now?`, `ref?`, `by?`) and `POST /api/server/cancel` start and cancel an update.
`by` is sent by `nexus server update` run in an orchestrator session (from `NEXUS_SESSION` and its project); the
server keeps it only for an orchestrator session of a registered project. The dashboard sends none. `POST
/api/server/plan` (`after`: `project`, `queue`, `step?`; or `at` and `deadline?`: "HH:MM" (its next occurrence; a
deadline's next one after `at`), "YYYY-MM-DD HH:MM" in the server machine's time, or ISO 8601; `ref?`, `by?` as for
update) plans a deploy, answering
`text`, `plan` and `update`; `POST /api/server/cancel-plan` (`by?`) cancels it, answering `text` (409 with the reason
when refused; see "Planned deploys"). `POST
/api/server/away` (`until`: a local time "8:00", an ISO 8601 time, or null for off; it answers `away`) switches the
user's away mode; like update and cancel it is taken from `nexus server away` without an `Origin`, and the CLI refuses
it from every agent session. `POST /api/server/settings` (`push_on_deploy?`: boolean, `max_running?`: a whole number
from 1 to 20, written as the global `defaults.max_running`; at least one of them; it answers both values) is the
user's only: like withdrawing an approval, it is refused without the dashboard page's own `Origin`. A server waiting
to take over answers every `/api/projects…` request, and every write under `/api/server/`, with 503.

**Planned deploys.** Instead of at once, a deploy can wait for a step or a queue of a project, or for a time (decided
by the user on 2026-11-14, docs/ideas/deploy-timing.md). `nexus server update --after <queue>[/<step>]` plans it for a
queue of the project the CLI runs in (an orchestrator's own); `--at <time> [--deadline <time>]` for a time. Like
`update`, the CLI refuses these, and `cancel-plan`, from every session but an orchestrator's, and the orchestrator does
it only when the user asks. One plan at a time: a second is refused until the first is cancelled, and so is a plan
while an update is under way.

- **When it is in.** A step is in when it is `done` (one waiting for its review, once accepted; one accepted
  provisionally is `done`) or `skipped`. A queue is in when it is done: every step closed (done, skipped, or rejected
  and released by a revision), its closing step included.
- **After a step.** The moment the step is in, the update starts (with the plan's `ref` and `by`). The engine asks at
  every step's end, before it opens the next step or finishes the run, so the update's drain holds the step's queue
  right there, even when the turn ends before the file watcher looks: nothing of the next step slips in. Steps running
  elsewhere are waited for as with any update, and the held queue goes on after the restart.
- **After a queue.** The update starts once the queue is done; a stopped or failed step means it is not. A queue with
  a worktree of its own (an integration step) is in once its work is merged back too (`git.yaml` `merged` after the
  integration step ended), by Nexus or the user: its work reaches main only with the fast-forward.
- **At a time.** At `at` the update starts: from then no new step starts, and it waits for the running ones (without
  a deadline, as long as they take). At `deadline`, a drain still waiting goes on as with `--now`: the running steps
  are interrupted, held, and continue after the restart (the update log says "the deadline came"). A time that has
  passed, or a deadline not after the time, is refused. Across a restart the timers are armed again; a time passed
  while no server ran starts the update at once.
- **Provisional work.** With a project's `provisional_counts` on (the default), a step the orchestrator accepted
  provisionally is in like any. Off (the global value or the project's own), the plan's own step counts only once the
  user confirmed it, and the deploy waits while the commit it would deploy (`ref`, default `main`, in the server's
  checkout) holds provisional work of that project the user has not confirmed: a step with a provisional acceptance
  waiting for the user whose recorded review commit is in it and that made commits of its own, as for the push of
  accepted work, so also under a step accepted for good that builds on it. It is then due but waits: `waiting_for`
  lists that work, and only the plan's own queue is held, at the step's end (its run `paused` with
  `resume_after_restart`, `held` in the plan); everything else goes on, and no drain starts. Once the user confirms it
  (or sends it to a fix), the update starts; the held queue goes on after the restart, or at once when the plan ends
  without its deploy. A plan at a time that waits so starts its drain only then; a deadline already passed interrupts
  the running steps at once.
- **Dropped.** The plan is dropped, without a deploy, when its step fails, stops or is rejected, or (after a queue) a
  step fails or stops, or the queue is stopped, cancelled or gone. A plan whose target will not be in is refused when it
  is set; one whose target is already in starts the update at once.
- **The update it started.** The plan records the update's id (`started`). The hand-over ends the plan
  (`carried-out`) before the successor starts, so the successor never deploys again. A failed update (before the
  hand-over, or by a rollback) ends it as `update-failed`; cancelling the update (`nexus server cancel`) ends it as
  `cancelled`; `cancel-plan` of a plan whose update still drains cancels the drain too (the held queues go on); once
  the update is past its drain, the plan can no longer be cancelled.
- **Across a restart.** The plan file stays: a plain restart finds the plan and waits on. A plan marked `started`
  whose update never handed over (the server stopped mid-drain) waits again, and starts its update once its target is
  in.
- **A worktree branch.** When the step's queue runs on a worktree of its own and its branch is not merged back
  (`git.yaml` `merged`), setting the plan warns that its work is in the deploy only once merged into main.
- **Told.** A dropped plan pushes a notification to the user's devices ("Nexus: planned deploy dropped"), and so does
  a plan that starts to wait for provisional work ("Nexus: planned deploy waits", once for each set of work). The
  orchestrator that planned it, else the target project's orchestrator (a plan at a time the user set tells none), is
  told once, key `notify:deploy-plan:<plan id>:<why>`: when it is dropped ("The deploy planned after … will not
  happen: …"), when its update failed (only for a plan the user set: the orchestrator that planned it is told the
  update's own outcome), and when the user cancelled an orchestrator's plan; and with key
  `notify:deploy-plan:<plan id>:waits:<work>` when it waits for the user's confirmation ("The deploy planned … waits:
  it would include provisional work the user has not confirmed (…)"). The planning session is told even with `notify`
  off.

**Push on deploy.** A successor that took over a live instance (`live: true`) pushes what it runs once it is up, if
`push_on_deploy` is on and the update's ref was `main`. It runs
`git push <main's upstream remote> <deployed sha>:refs/heads/main`, a plain push and so fast-forward only, never forced,
with `GIT_TERMINAL_PROMPT=0` and `GCM_INTERACTIVE=never` and a 60-second limit. A prompt or a hang counts as a failed
push. The result goes into `update.push` and the update log. A failed push (no upstream, rejected, network,
credentials, time-out) leaves the deploy as it is. A deployed ref other than `main`, an unknown ref (a predecessor from
before this), a development checkout, or the setting off: no push, and the log says why.

**The hand-over after an update.** The two servers talk through files in `<NEXUS_HOME>/handover/<id>/` (JSON, each
written whole and renamed into place, one writer each). The predecessor removes the folders of earlier hand-overs
when it starts one.

| File | Writer | When |
|---|---|---|
| `predecessor.json` | predecessor | `pid`, `commit`, `subject` (the version it ran), `at`, `update` (`id`, `by?`, `from`, `to`: the full commits the update went from and to); before it stops its agents and starts the successor |
| `ready.json` | successor | `pid`, `commit`, `subject`, `at`; it listens, its API (and the dashboard, if built) answers, every registered project's state loads |
| `failed.json` | successor | `pid`, `at`, `reason`; the smoke check failed or the port never came free; it exits with code 1 |
| `released.json` | predecessor | `at`, `log` (the update's log so far), `ref` (what the update deployed); it saw `ready.json`, writes nothing more, and exits |

The predecessor starts the successor with `NEXUS_HANDOVER=<that folder>` (and `NEXUS_WAIT_PORT=60`). It waits up to
60 seconds for `ready.json` or `failed.json`, or for the successor to exit. A successor started with `NEXUS_HANDOVER`
stays read-only until `released.json` appears or the predecessor's process is gone. A server started without it is
active at once, as before. Without `ready.json` the predecessor rolls back: it stops the successor's process tree,
puts a live worktree back on the commit it came from (`npm install` if the lock file differs, then a dashboard
build), listens on the port again and resumes the held queues. The update then ends with `phase: failed` and an
`error` of the form `<reason>; rolled back to <commit>` (a development checkout: `<reason>; this server goes on
(a development checkout is not moved)`). A push notification titled "Nexus: update failed" goes to every device.

A successor removes `NEXUS_HANDOVER` from its environment as soon as it starts, and no agent's environment ever
contains it. A folder that is not inside `<NEXUS_HOME>/handover` is refused: the successor logs
`refusing to take over: …` and exits with code 1, writing nothing.

**The chats during an update** (decided 2026-11-15, queue OP). The orchestrator's chat and the conversations stay open
while an update waits, with `--now` too: the user's messages (`POST …/orchestrator/messages`,
`…/conversations/:cid/messages`, `…/handoff`) are taken and answered, and the drain waits only for the workers' turns
(`update.waiting` lists the projects with a worker still in a turn). What stays refused while an update is under way
(`draining`, `updating`, `restarting`) is a run's start, resume and Continue (409, "Nexus is updating; …"), from the
dashboard and from `nexus run`; the orchestrator's notices wait as before. At the hand-over, after it stops taking
requests, the predecessor stops (interrupts) every chat turn still running and records it in the session's
`runtime.json` as `interrupted`: `at`, `asked` (what the turn answered: the user's messages sent into it, without a
step's context, or the notice that started it; empty for a turn the runtime began by itself) and `handoff` (a
conversation's hand-over turn). Every server, once active (a successor, or a predecessor that took the port back after a
rollback), goes on with each such turn in the same session (the runtime resumes it): the chat gets the line "Nexus
restarted while answering; it goes on." (from `nexus`), and the agent the message "[Nexus] The server restarted while
you were answering this message:" followed by `asked`, each line quoted with `> `, and "Answer it again. The cut-off
turn may have done part of it: check before you repeat anything." (several messages: "these messages", "them"; none:
"The server restarted during your turn, which was cut off; go on where you left off."). A hand-over's turn is the
hand-over's again: its reply goes to the orchestrator. Then `interrupted` is dropped.

## Conversations

`project.yaml` holds `conversations: { notes_dir?, runtime, model?, effort?, web }`. A conversation is a session with
role `conversation`: a thinking partner the user talks with about the project, one session per topic, with its chat
in `chat.jsonl` (`from: partner` for its replies, whole). It reads the whole project and writes only in `notes_dir`
(relative to the root, checked to lie inside it): Claude Code runs it in `dontAsk` mode allowed `Read`, `Grep`,
`Glob`, `nexus status`, `nexus help` and read-only git (`git log`, `git status`, `git diff`, `git show`) on both shell
tools (`Bash(nexus status:*)` and `PowerShell(nexus status:*)`, and so on), and `Edit(<notes_dir>/**)` only; Codex runs it
with `notes_dir` as its working directory in a `workspace-write` sandbox (`read-only` without a notes folder), approval
`never`, where its commands (`nexus help` among them, which only reads) run in the sandbox. Its briefing points it to
`nexus help` for how Nexus works (decided 2026-11-15, queue OP). It starts no work. An idle partner's process ends after 15 minutes; the next message resumes the conversation.

**The web** (`conversations.web`, global with a project override, decided by the user 2026-11-15): `off`, `search`
(the default) or `fetch`. A changed level applies from the partner's next message (a new process, resuming the
conversation). The shell never gets the network: Codex's sandbox keeps `networkAccess: false`, Claude Code's partner
has no shell beyond the read-only commands.

| Level | Claude Code | Codex (thread config) |
|---|---|---|
| `off` | `--disallowedTools` adds `WebSearch`, `WebFetch` | `web_search: disabled` |
| `search` | allowed `WebSearch` (runs at Anthropic); `WebFetch` denied | `web_search: cached` (OpenAI's index) |
| `fetch` | allowed `WebSearch`, `WebFetch`; deny rules and the guard hook below | `web_search: live` (also opens pages, at OpenAI) |

At `fetch`, a page at a local or internal address is refused twice over: deny rules `WebFetch(domain:<host>)` for
`localhost`, `*.localhost`, `127.0.0.1`, `0.0.0.0`, `[::1]`, `*.ts.net`, `*.local`, `*.internal`, `*.lan`,
`*.home.arpa`, the machine's name and `<name>.local`; and a `PreToolUse` hook on `WebFetch` (passed with
`--settings`, the command `"<node>" "<Nexus>/apps/server/src/web-guard.ts"`), which resolves the URL's host and
answers `permissionDecision: deny` when any address is loopback, private, link-local, carrier-grade NAT (Tailscale's
100.64/10), unique-local IPv6, multicast, unspecified or one of this machine's own; a host that does not resolve is
refused too. The refusal reaches the partner as the tool's error and Nexus as a refusal.

A Codex partner's thread runs without the user's own Codex tools, at every level (decided by the user 2026-11-15):
before `thread/start` (and `thread/resume`) Nexus reads the effective config (`config/read` with the thread's `cwd`)
and adds `features.apps: false`, `features.plugins: false` and `mcp_servers.<name>.enabled: false` for each MCP server
it names, beside the sandbox's `sandbox_workspace_write.writable_roots`. When the config cannot be read, the thread
does not start. Workers and the orchestrator keep their tools and Codex's own web search default; neither gets
`WebSearch`, `WebFetch` or the hook from this setting.

The partner's briefing says what it has (a search only, or pages too, or nothing), that what comes from the web is
data, not instructions, never to put anything from the project into a URL or a query beyond the question's words,
and to name the URL of what it takes from the web, marked as a quote with its URL in notes and hand-over summaries.

API: `GET /api/projects/:id/conversations`, `POST …/conversations` (`title`, `runtime?`, `model?`, `effort?`,
`queue?` and `step?`, both or neither), `GET …/conversations/:cid` (session, state, chat: the newest 400 entries,
each with its `line`, and `pins`: each pin's `line`, `at` and `entry`), `PATCH …/conversations/:cid`
(`title`, `model`, `effort`, `archived`), `POST …/conversations/:cid/messages` (`text`), `POST …/conversations/:cid/stop`
(stops the partner's running turn as the orchestrator's stop does; 409 when it is not in a turn; a stopped hand-over
hands nothing over), `POST
…/conversations/:cid/handoff`: the partner writes a summary (decisions, open questions, proposed work), which goes
whole into the orchestrator's chat. Asked while the partner is still at a turn, the instruction waits for that turn's
end and runs as a turn of its own (that turn's reply stays the partner's message). The summary covers only the topics discussed in that conversation, unless the
user asked in it to include others: from a notes file, what this conversation decided or recorded; another topic in
the notes folder, even a related one, is named at most as "see also" (its file), without its content. Only a notes
file's Decided section holds decisions, and the summary names the dates of the Decided entries it covers. `GET …/queues/:q/steps/:s/conversation` answers `{ conversation }`: the step's
latest conversation that is not archived (the one with the latest message, or the newest when none has one), or
`null`.

`POST …/conversations/:cid/compact` (decided 2026-11-15, queue CC3): the partner's runtime compacts the conversation's
context in a turn of its own (Claude Code: `/compact` as a user message on its stream-json input; Codex:
`thread/compact/start`), and the conversation goes on in the same session. Once the runtime says it is done (Claude
Code's `compact_boundary`, Codex's `contextCompaction` item) the chat gets a Nexus line, "The conversation's context
was compacted: <before> tokens of context became <after>" (the figures only where the runtime gives them: Claude
Code); a compaction that ends without it gets an error line. Refused (409) while the partner is at a turn, for a
conversation with no reply yet, and for a runtime that cannot compact. `GET …/conversations/:cid` says which:
`compact` (true where its runtime compacts on request; the dashboard offers Compact only then).

**A conversation about a step** ("Chat about this"): `queue` and `step` are kept in `session.yaml` as `about`, never as
`queue` (which makes a session a worker of the queue: `nexus status` would deliver the queue's notes to it and mark
them read). The default title is `<step>: <step title>`. Creating it starts no model turn and changes nothing in the
run (a step in review keeps waiting); `nexus status` from it prints the orchestrator's overview and writes no event.
The server builds the step's context, the **seed**, and sends it with the user's first message (the chat keeps the
user's words only), by the step's state: `pending` and `skipped`: goal, acceptance criteria and notes (and the reason
of a skip); `running` and `waiting`: also the progress so far; `review`, `done`, `failed`, `stopped` and `rejected`:
also the summary, the reason, commits, send-backs, checks and review material; open questions of the step in every
state. It records the step's status in `about.seeded`. When the step's status differs at a later message, a short
"since then" addition (the change, and the outcome or progress of the new state) goes with that message, once.

## The orchestrator

`project.yaml` holds `orchestrator: { runtime, session, model?, notify, context_threshold }` (`context_threshold`: see
"The orchestrator's context care"). The orchestrator is a Claude Code session
launched in the project's checkout with `--permission-mode dontAsk`, allowed only `Read`, `Grep`, `Glob`, `Agent`,
`nexus` and read-only git commands (`git log`, `git status`, `git diff`, `git show`, `git branch`, `git worktree list`)
on both shell tools (`Bash(nexus:*)` and `PowerShell(nexus:*)`, and so on), and `Write(.nexus/drafts/**)` and
`Edit(.nexus/drafts/**)`, and with
`NotebookEdit` and `MultiEdit` disallowed: anything else, writes outside `.nexus/drafts/` included, is refused without
a prompt. (`Write` and `Edit` are not disallowed: a disallow rule would beat the drafts rules.) Its briefing
(appended system prompt) explains its role, the commands and the queue YAML.

- `.nexus/drafts/<queue>.yaml` holds the orchestrator's queue drafts; the orchestrator is its only writer. It writes a
  draft there, uploads it with `nexus queue draft .nexus/drafts/<queue>.yaml` (relative to the project's root, its
  working directory), and keeps the file to edit for later revisions. The server reads only the path it is given.
  The briefing tells it to run `nexus` and git commands on their own, with nothing before the command name: a chained
  command (`cd …`, `&&`, a pipe) or an option before the subcommand (`git -C <path> show`) does not match the rules
  and is refused, on Bash and PowerShell alike. The workers' and the thinking partners' briefings say the same.

- `nexus queue draft <file|->` sends a queue definition (YAML) as `queue.drafted`. The server writes it: a new queue
  becomes `proposed` (or `draft`); a change to an existing queue's steps, checks or stop conditions makes a new
  revision, which needs the user's approval again. A revision changes only what has not started (see "A revision
  changes only what has not started" under `queue.yaml`); a refused draft prints the reason.
- `nexus run <queue> start|pause|resume|stop --reason … [--use-session <id>] [--runtime claude|codex] [--model <m>] [--effort <e>] [--after <queue>... | --next | --at <time>]`
  sends `session.request`; `start --after A [--after C]` puts the queue into the plan, to start when A (and C) are
  done; `start --next` puts it in with none before it (see "The plan"); `start --at "YYYY-MM-DD HH:MM"` (this
  machine's local time; sent as ISO 8601 in `start_at`) or `--at usage-reset` plans it for a time (a schedule);
  `nexus run <queue> cancel-start --reason …` takes it out of the plan (not a queue the user put in).
- `nexus plan propose <queue> [--after <queue>]... --reason …` sends `plan.proposed`: a proposal to the user that
  changes dependencies the user set (see "The plan").
- `nexus tags propose --area <name> | --activity <prefix:name> [--reason …]` and `nexus tags rename <old> <new>
  [--reason …]` send `tags.proposed` and wait for the server's result; `nexus tags` (any session) prints Nexus's lists
  and the project's, with the renames and the proposals waiting. `nexus tags accept|decline` is refused: the
  decision is the user's (see "Tags").
  Starting an unapproved revision is refused.
- `nexus review accept <queue> <step> [--note <text>]`, `nexus review send-back <queue> <step> <what to fix>` and
  `nexus review ask-user <queue> <step> <why>` write `review.accepted` (the note as its `text`), `review.sent_back`
  and `review.asked_user`; `nexus review provisional <queue> <step> [--note <text>]` writes `review.provisional`
  (refused for a step not at review level 3). The CLI refuses them from any session but an orchestrator, and for a
  step that is not waiting for the orchestrator's review. The orchestrator's overview marks a step accepted
  provisionally: waiting for the user's confirmation, confirmed, or with the fix the user asked. `send-back` waits for the server's result and prints it ("sent back to its
  worker as round N", or that the step goes to the user beyond the limit).
- `nexus queue set <queue> [--step <step>] skipped|finished|cancelled|propose-lift --reason …` sends `status.set`
  and prints the server's result: housekeeping (see "Housekeeping by the orchestrator" under `queue.yaml`). A worker
  session is refused by the CLI.
- With `notify` on, the server tells the orchestrator (starting it if needed) when a worker asks a question, when the
  user approves a revision of a queue ("Queue X revision N approved.", with the instruction to start it, or to resume
  its paused or halted run, also one of an older revision, if the plan puts it next; a running run, or one waiting for the approval, continues by itself: nothing to start), when the user withdraws an approval, when the user lifts a stop with Continue ("The user lifted the stop of queue X with Continue (the stop was: …); its run goes on.", told once), when a run reaches a
  requested pause ("Run of X paused after step S.": a pause asked for by the user or the orchestrator, not a stop now,
  nor the pause of a server restart or of an update), when a step waits for its review ("Step S of queue X is done and
  waits for your review: <summary>", with the step's goal, acceptance, the checks reported this round and those of the
  queue not reported, the review material of the round, the commits, and the commands: accept, send back, ask the
  user, and at review level 3 also `nexus review provisional`; key
  `notify:review:<queue>:<step>:<finished_at>`, once per round and session, also for a step that entered review before
  the session started, so a reset orchestrator is told; a step waiting for it starts an orchestrator that has no
  session), and when a run halts or finishes. Whatever `notify` says, like a rejection, it is told the user's Fix it on
  a step it accepted provisionally (key `notify:fix:<event id>`; "The user asked a fix of step S of queue X, which you
  accepted provisionally: …", with the instruction to draft a revision with a step that fixes it). The chat shows only the fact;
  the instruction goes to the orchestrator alone. Each notice is told once, recorded in `applied.jsonl` (`notify:…`
  keys; approvals and withdrawals by their position in the queue's `approvals` and `withdrawals`, so approving a
  withdrawn revision again is told again). Nothing older than the orchestrator session is told, except a step waiting
  for its review.
- Nothing is held back across a restart. While an update drains, notices wait. Every server, once active, runs one
  pass over every project, as after a change: plain starts, successors after their hand-over, and a predecessor that
  took the port back after a rollback. The same pass runs whenever an update settles: it is up and its push done, it
  failed, or it was cancelled. So what came up meanwhile is told right then, and it starts the orchestrator's turn.
- The orchestrator session that ran `nexus server update` (`update.by`) is told the outcome once, even with `notify`
  off. After the restart: "Nexus was updated as asked: <commit> "<subject>" is up (was <commit>).", with the push
  result. If it failed, before the hand-over or by a rollback: "The Nexus update you ran failed: <reason>. Still
  running: <commit> "<subject>"; the queues it held (…) go on.". The keys are `notify:update:<id>:updated` and
  `notify:update:<id>:failed`, and the successor knows the id and the asker from `predecessor.json`. An update the
  user started tells no orchestrator about itself.
- **What changed for agents.** A commit that changes something agents rely on carries `Agents: <what changed>` in
  its message (a line, possibly wrapped onto the following lines up to a blank line or a trailer).
  - **Collecting:** at a successful deploy (not a rollback), the successor collects these lines from `from..to` with
    local `git log`, and records them in `deploy-changes.jsonl`. Nothing is collected, and the update log says why,
    when `from` is missing (a predecessor older than this), unknown, or not an ancestor of `to`, or when there are
    no lines.
  - **Who gets them:** every project's orchestrator session that is older than the deploy, once, with the key
    `deploy-changes:<to>` in its `applied.jsonl`. A session started after the deploy gets nothing.
  - **When:** with `notify` on, as a notice, which starts its turn. With `notify` off, held: they go in front of the
    next message it gets (the user's, or its update outcome), without waking it, and the key is recorded only then.
    Several held deploys go in together, oldest first.
  - **How:** the orchestrator that ran the update gets them in the same message as its outcome. The user's chat
    never shows them.


### Stopping a chat agent's turn

The stop button of a chat (`POST …/orchestrator/stop`, `POST …/conversations/:cid/stop`; decided by the user on
2026-11-14, queue CH4) is a pure interrupt through the runtime's own control, not a message asking the agent to stop.
The chat gets a Nexus notice "Stopped." at that point; nothing the turn writes after it reaches the chat (texts, tool
calls); the process stays and goes idle; the turn's record in `turns.jsonl` says `interrupted`. Messages the user sent
during the turn that the agent had not taken in go in with the next turn:

- **Claude Code**: the `control_request` `{ subtype: "interrupt" }` on its stream-json input. Claude Code 2.1.323
  answers at once, still writes the text the model had begun, ends the turn with a result `error_during_execution`
  (`terminal_reason: aborted_streaming`), and then runs the `next` messages it had not read as a turn of its own. Nexus
  shows none of it and interrupts that turn as it starts, so those messages are in the conversation before the next
  one. Messages sent while a stop settles wait and go as new turns after it (a stop with unread messages settles 1.5 s
  after the stopped turn's result, or after the result of the turn the CLI started).
- **Codex**: `turn/interrupt`. Codex 0.167.2 drops a message steered into the turn (`turn/steer`) that it had not
  taken in yet (taken in: an `item/completed` of type `userMessage` with its text); Nexus carries such messages, and
  those waiting for the turn to end, into the next turn's message, before its text. A message sent during the stop
  starts that turn at once.

Both were probed live with small models (haiku, gpt-6-luna) on 2026-11-14; the fakes behave so (fake-claude.ts,
fake-codex.ts).
## The `nexus` command inside agents

The server writes `<NEXUS_HOME>/bin/nexus.cmd` (for cmd and PowerShell, where npm's `.ps1` shim is blocked when
scripts are disabled, as in Codex's shell) and `<NEXUS_HOME>/bin/nexus` (for Git Bash), both running this checkout's
CLI with the server's Node, and puts that directory first on every launched agent's `PATH`.

## The plan

The plan says which queue starts after which. A queue is in it when it has a place: `queues/<id>/plan.yaml` (the
queues it waits for; none: "starts as soon as it may"), or a schedule in `queues/<id>/start.yaml` (see "Schedules").
Nexus starts by itself only a queue in the plan; an approved queue outside it waits. The user puts a queue into the
plan from the dashboard (the start form's "When"), the orchestrator with `nexus run B start --after A [--after C]...`
or `--next` (none before it). Both carry the options of a start (runtime, model, effort, a session to continue), kept
in `start.yaml`.

- `plan.yaml`, written only by the server: `by` (who put the queue into the plan), `reason?`, `after` (each queue it
  waits for: `queue`, `by` (`user` or `orchestrator`: who set it), `at`, `reason?`), `created_at`, `updated_at`,
  `started_at?` (it started since, by the plan or directly: the plan is used, and stays for the view until the queue is
  planned again; a start of a queue in the plan marks it), `proposal?` (the orchestrator's proposal: `at`, `after`, the
  whole new list, `reason`), `decisions` (the user's answers, oldest first: `at`, `kind` (`accepted`, `declined`,
  `handed_back`), `after?` and `reason?` (the proposal's), `queues?` (those handed back)).
- It starts when every queue in `after` is done, and its current revision is approved (a revision of the queue
  proposed meanwhile waits for the user: the start is `held` with kind `approval`, "waits for approval of revision N",
  and comes once approved; it is not a failed start). "Done" is the queue's status `done` with every step closed (done
  or skipped; the closing refactoring step too) and, in a project whose `provisional_counts` is off, no provisional
  acceptance waiting for the user's confirmation. A queue whose predecessors are all done already starts at once (if
  its checkout and the limit allow, see "One queue per checkout, and a limit"; else it waits and starts by itself).
- A predecessor that halts, pauses or waits for an approval: the queue waits, `blocked` (on the user or the
  orchestrator). One that is stopped, cancelled or does not exist: the queue waits too, the user gets an attention
  item of kind `plan` ("Queue B waits, but queue A is stopped: …"; `plan.predecessor`, `plan.cause`), and the
  orchestrator is told once ("Queue B waits in the plan, but …"). Dependencies reach no other project.
- Setting a queue's predecessors replaces its list. Refused: a queue after itself, an unknown or cancelled
  predecessor, a loop through the plans (following every predecessor of every unused plan: "that would be a loop in
  the plan: B waits for C, C waits for B"), a queue that is done, cancelled or running, an effort the runtime does not
  take, a session that is not a worker session Nexus launched. The queue need not be approved yet.
- A dependency the user set is the user's. The user's list is wholly theirs (every entry `by: user`). The
  orchestrator's list must keep every predecessor the user set (refused otherwise: "queue C waits for A by the user's
  decision: you may not change that; keep it (--after A), or propose the change to the user: …"); entries it keeps
  stay as they were, new ones are its own. The orchestrator may not take out of the plan (`cancel-start`) a queue the
  user put in or made wait. Its own dependencies it changes freely.
- The user reorders the plan as a list (decided 2026-11-14; `POST …/queues/:q/plan` with `move`, from the
  dashboard's "After…" or by dragging): moving B after Y makes Y B's only predecessor, and every queue whose unused
  plan waited for B waits for B's old predecessors instead (keeping its other ones; no repeats), those entries the
  user's; `after: null` puts B first, with none before it. B's start options stay; a schedule goes. Refused like a
  plan (B done, cancelled or running; Y unknown or cancelled; B after itself; a loop in the plan as it will be).
- To change the user's, the orchestrator proposes: `nexus plan propose B [--after X]... --reason …` (event
  `plan.proposed`), the whole new list; refused when it drops no predecessor the user set ("set it yourself"). A new
  proposal replaces one waiting. The user gets an item of kind `plan` (`plan.proposal`: `after`, `reason`, `current`)
  and answers with one action (`POST …/queues/:q/plan`): `accept` (the list becomes the proposal's; the entries it
  keeps stay as they were, new ones are the orchestrator's), `decline` (the plan stays), or `hand_back` (a predecessor
  the user set, or all of them, becomes the orchestrator's; a proposal that no longer changes anything of the user's
  goes). Each answer is recorded in `decisions` and told to the orchestrator once. A start of the queue drops a
  waiting proposal.
- A plan that continues a session waits while that session runs another queue, and fires when it is free (A's own
  session is free once A's run is finished): one session never runs two queues.
- At the moment it fires, B starts as a start does: it must not be stopped or have a rejected step. If it cannot
  start, its `start.yaml` gets `failed` and the user an attention item of kind `start` ("Did not start after A: …");
  it is not tried again by itself. Starting B or taking it out of the plan ends it.
- Nothing fires while an update drains: the plans stay in their files, and the next server (or a cancelled update)
  looks at them once it is up. The server looks at the plans after every change to the project's files and 1.5 s
  after it starts.
- When the queues B waits for are done but B's checkout is held by another queue, or as many queues run as the limit
  allows, B waits and starts by itself once it may; `waiting` then says why, e.g. "queue A is done; waits for the
  checkout: queue C runs there". Queues waiting for the same A in one checkout so run one after the other, the plan
  made first first.
- The run B gets records `after` (the predecessors, a list; one id in older records). The state shows on B its `plan`
  (each predecessor with `done`, `waiting`, `blocked`, `cause?`; `used`, `ready`, `approval`, `waiting`, `blocked`)
  and on each predecessor `starts_next`.
- While the user is away (see "Away mode"), only the plan's next queues start, and Nexus starts them itself: the
  orchestrator's direct start of a queue is refused unless the queue is in the plan, its predecessors done and it is
  approved, and so is putting an approved queue that is not in the plan into it (an unapproved one may be planned: it
  waits for the user anyway). Its notice when a queue waits for the user lists the plan's next queues with what each
  waits for.
- Before the plan, a chain was `start.yaml` with `after` (one queue). The server moves such a file into `plan.yaml` at
  its start (the predecessor set by whoever made the chain; `start.yaml` keeps the options); until then the state reads
  it as that plan.

## Schedules

"Start B at night", "start B when the usage window resets": a planned start with `at`, in `queues/B/start.yaml`, set
from the dashboard's start form ("When": at a time, or when the usage window resets) or with `nexus run B start --at
…`. A schedule puts the queue into the plan; it replaces the start's options but keeps the queue's predecessors (a
queue with both starts at its time once they are done), and putting the queue after others (`--after`) replaces a
schedule.

- `--at usage-reset` takes the reset time from the latest usage data (`<NEXUS_HOME>/usage.json`) of the runtime the
  start would run on (the session's to continue, else the start's runtime, else the project's default): Claude Code's
  5-hour window; for Codex, of its windows not yet reset, the last to reset among those at or above the pause
  threshold, else the first to reset. The plan's `at` is that time plus the usage margin (60 s), and `usage` names the
  runtime. Without usage data of that runtime the request is refused. A time in the past (more than a minute) is
  refused.
- At its time the queue starts as a start does. Its current revision not approved, it waits for the approval
  (`held`, kind `approval`) and starts once approved. If it cannot start (stopped, …) or its session to continue runs
  another queue (a schedule does not wait), the plan stays with `failed` and the user gets an item of kind `start`
  ("Did not start at 22:00: …").
- More than 15 minutes late (the server was not running at the time; it looks at the plans 1.5 s after it starts), the
  queue does not start: `failed` with `missed: true`, an item for the user, and the orchestrator is told once. Less late,
  it starts.
- At its time, a queue waiting for its approval, whose checkout is held by another queue, or that would pass the
  limit on queues running at once, waits (`held`) and starts by itself once it may; a waiting schedule is never
  missed, however long it waits.

## Queue templates

A template is a queue skeleton with parameters: a queue's YAML (as an orchestrator drafts it) with two more keys,
`template:` and `params:`, and `{{name}}` placeholders in its texts (`packages/protocol/src/templates.ts`).

```yaml
template:
  id: bugfix                   # 1-40 lowercase letters, digits and dashes
  title: Bug fix
  description: Reproduce a bug with a failing test, find its cause and fix it.   # optional
params:
  - name: issue                # lowercase letters, digits and underscores
    description: what goes wrong and how it shows
  - name: area
    description: the part of the project where it shows
    default: the engine        # optional: without one the parameter must be given
title: "Fix: {{issue}}"
coding: true
steps:
  - id: "{{id}}1"
    title: "Reproduce and find the cause: {{issue}}"
    goal: |
      ...
```

- A placeholder is `{{name}}` (spaces inside the braces allowed) in any string value, never in a key. `{{id}}` is
  always there: the queue's id, given when the template is filled (step ids are written `"{{id}}1"`); a parameter may
  not be named `id`. A placeholder that names no parameter is refused when the template is read, since it would stay
  unfilled. A template has at least one step; a top-level `id` in it is ignored.
- Filling puts each value in as it is (a `{{…}}` inside a value is not filled again), takes the defaults for what is
  not given, and drops `template:` and `params:`; the queue's id comes first. Refused: a parameter without a default
  that is not given (named with its description), a parameter the template does not have, a placeholder left unfilled,
  and a result that is not a valid queue definition. The rest of the draft path's checks (tags against the project's
  lists, a queue of that id) apply when the draft is uploaded.
- **A maintenance template** has a top-level `maintenance: survey|fix_small`, its default mode. A step marked
  `maintenance: fix_small` is there only in that mode. Filled in survey mode, the queue leaves those steps out and gets
  `coding: false` (no closing refactoring step); in fix_small mode it keeps them (the marks dropped); either way the
  queue carries `maintenance: <mode>` (queue.yaml; part of what an approval pins when set). The mode is given with
  `--maintenance` (`nexus queue draft --template`, `nexus recurring set`: the project's mode over the template's);
  refused for a template that is not a maintenance one, and a template is refused that marks a step without the
  top-level key, or keeps no step in survey mode. The shipped `maintenance` template surveys `{{scope}}` and, in
  fix_small mode, fixes `{{small_fixes}}` (by default patch-level dependency updates whose checks pass, and typos in
  documentation).

**Three layers**, weakest first; for the same template id the stronger replaces the weaker:

| Layer | Folder | |
|---|---|---|
| `nexus` | `templates/` in Nexus's repository | shipped with Nexus: `bugfix`, `ui-change`, `spike`, `refactor`, `maintenance`, `static-analysis`, and the maintenance templates `dependencies`, `security-audit`, `dead-code`, `test-health`, `performance`, `docs-freshness`, `notes` |
| `global` | `<NEXUS_HOME>/templates/` | the user's own, for every project |
| `project` | `nexus-templates/` in the project's repository root | versioned with the project and seen by its agents (not under `.nexus/`, which git ignores) |

Every `*.yaml` and `*.yml` file of a folder is read; a file that is not a valid template, or a second file of one
layer with an id already taken there (the first by path is used), is listed as not used, with the reason.

- `nexus template list` (any session, or none: outside a project only the `nexus` and `global` layers) prints each
  template in effect, `bugfix (project, over nexus and global): Bug fix (params: issue [area])` (a parameter with a
  default in brackets), then the files not used.
- `nexus template show <id>` prints its layer and file, what it replaces, its parameters (required, or the default),
  and the file's YAML.
- `nexus queue draft --template <id> [--set name=value]... [--id <queue-id>]` fills it and writes the result into
  `.nexus/drafts/<queue-id>.yaml`, with a comment at the top naming the template and what to complete (the goals'
  details, the project's checks, tags such as the area, the texts in the queue's language). It records no event and
  uploads nothing: the orchestrator completes the file and uploads it with `nexus queue draft .nexus/drafts/<id>.yaml`,
  and the queue then goes as any other, through the user's approval. Without `--id` the queue's id is the template's
  id in capitals (letters and digits, at most 12), numbered from 2 when a queue or a draft file has it (`SPIKE2`).
  Refused before anything is written: a missing or unknown parameter, `--set` without `name=value` or given twice, an
  unknown template (or one whose file is not used, with the reason), a queue of that id that exists already, and a
  draft file of that name.

## Recurring queues

A recurring queue is a template (see "Queue templates") with its parameters' values and a schedule. At each time of
the schedule Nexus makes the queue from the template and starts it, while the user's **standing approval** holds: the
user approves a recurring once, and its runs start by themselves as long as it stays as approved.

`.nexus/recurring/<id>.yaml`, written only by the server (`RecurringFile`):

```yaml
protocol: 1
id: weekly                     # 1-16 letters, digits, dashes or underscores
template: maintenance
params: { scope: dependencies }
every: mon 03:00               # daily HH:MM | <mon..sun> HH:MM | monthly <1-31> HH:MM, the server machine's local time
after_queues: 5                # or this instead of every: after every 5 queues of the project that are done
baseline: [A, B]               # after N queues: the queues done when the count began
maintenance: fix_small         # the project's mode for a maintenance template, over the template's
set_by: orchestrator           # or user; with reason
approval: { hash: sha256:..., at: 2026-11-15T10:00:00Z }   # the user's standing approval
paused: true                   # the user paused it
handled: 2026-11-16T02:00:00Z  # the times up to this one have been looked at; the next comes after it
last: { queue: weekly-20261116-0300, at: ..., due: ... }  # the last queue it made
skipped: { due: ..., at: ..., kind: previous, reason: its previous run weekly-20261109-0300 is still stopped }
created_at: ...
updated_at: ...
```

- **Setting it**: `nexus recurring set <id> --template <t> [--set name=value]... (--every "<when>" | --after-queues
  <n>) [--maintenance survey|fix_small] [--reason]` (orchestrator only) records `recurring.set`; the server checks the
  id, the schedule (exactly one of the two; refused: another form, a number outside 1-1000) and that the template fills
  with the values and the mode (refused: a missing or unknown parameter, an unknown template, a mode for a template
  that is not a maintenance one), writes the
  file with the schedule in its one written form (`Mon 3:00` becomes `mon 03:00`) and answers. **Any set takes the
  standing approval away**, whatever it changes: the recurring waits for the user's approval again. A set counts the
  times from then on (`handled` is the set's time), so it never starts a time that has passed.
- **The standing approval's hash** (`recurringHash`) covers the resolved, filled template (after the three layers,
  filled with the recurring's id as the queue id), the values, the schedule, the effective maintenance mode and
  `coding`, hashed as JSON with sorted keys. Switching survey to fix_small (or back) thus asks for the approval again.
  A project template that replaces the shipped one with other content, a deploy that changes the shipped one,
  an edited project or global template, another value or schedule: each gives another hash, and the approval no
  longer holds (the state shows `needs_approval`) until the user approves again. The approval is the user's action
  (`POST /api/projects/:id/recurring/:rid`, `approve`); no CLI command or event approves, pauses or removes one, and
  `nexus recurring approve|pause|resume|remove` are refused from every session.
- **At each time** the server looks again, and makes and starts the queue only when the recurring is not paused, its
  template resolves and fills, its standing approval's hash is the hash it has at that moment, the time is not missed,
  and its previous run has closed. Otherwise the time passes without a run and `skipped` says why: `approval`,
  `template`, `missed`, `previous` or `failed`. A paused recurring's times pass without a record. A monthly day past
  the month's end (31 in November) is the month's last day.
- **The queue** gets the id `<id>-<yyyymmdd>-<hhmm>` (the time, local; `-2`, `-3`, ... when taken), the template filled
  with that id, and goes through the draft path's checks (tags, step ids). It is written approved, with one approval
  of its own revision hash marked `standing: { id, approved_at, hash }` (the recurring, when the user approved it,
  and the hash approved). Then it is put into the plan with no queue before it (`by: user`, the reason naming the
  recurring), so it starts at once or waits for its checkout, the limit or an update as any planned queue.
- **The previous run**: while the last queue it made is not done or cancelled (running, waiting, stopped), a time
  passes without a run (`skipped.kind: previous`), and the user gets an item. A removed queue counts as closed.
- **After N queues** (`after_queues`): it counts the project's queues that are done (removed queues are gone, so they
  do not count) and were not done when the count began (`baseline`), leaving out every recurring's own runs (a queue
  whose approval is marked `standing`), so two such recurrings never start each other. The count begins at the set,
  at the approval, and whenever its N-th queue comes and is looked at (whether a run starts or the time passes for
  one of the reasons above). The server counts at every change of the project. `ProjectState.recurring` shows
  `counted` for it, and no `next_at`.
- **Maintenance runs** (a queue with `maintenance`): the worker's prompt asks for the number of findings with the
  report (`nexus report ... --findings <n>`, 0 when there were none). When the run finishes, the orchestrator is told
  once when the report has findings, with the report's path ("Maintenance queue weekly-20261116-0300 (survey) finished
  with 3 findings. Report: <path>"), to propose a queue to the user from it; without findings the run closes quietly,
  without the usual notice of its end (a halted run is told as any). A survey run is told to change nothing; when one of
  its steps reports its end (done, or waiting for its review), the engine checks once that the step left no commit
  since its round began and no changed tracked file in the queue's checkout (untracked files do not count), and
  otherwise stops the queue with the condition "Nexus: a survey run leaves no commit and no changed tracked file" and
  what it left (a `queue.stop` in the user's session, which the server writes), before the step's review.
- **Missed times**: once the server is up (with the planned starts) it looks at each recurring's times since
  `handled`: one more than 15 minutes ago (`MISSED_MS`, as for schedules) passes (`missed`, when it would have run),
  and the next time comes; one less late comes now.
- **The state** (`ProjectState.recurring`, `RecurringView`) adds `status` (`approved`, `needs_approval`, `paused`,
  `waiting_previous`, `broken`), the current `hash`, the template's title and layer, `problem` when broken, and
  `next_at`. Attention items of kind `recurring` (`recurring`: its id): one waits for the user's approval ("Recurring
  weekly (Maintenance, mon 03:00) waits for your approval", with `approvable: true`: the waiting list offers Approve),
  cannot run (its template), or a time passed without a run
  while its previous run is still open (with `queue`: that run), after a failure, or missed.
- `nexus recurring list` (any session) prints each with its template, values, schedule, state, next and last run, and
  the last time that passed without one.
- The user pauses it and lets it go on (`pause`, `resume`) and removes it (`DELETE`); the queues it made stay.
- **The dashboard**: "Recurring" on the project's queues (below the plan and the queues in progress and planned) lists
  each with its state, schedule, values, mode, next and last run, and the user's Approve (while it waits for that),
  Pause or Resume, and Remove. "New queue from template" (at the top of the page) picks a template (`GET /api/projects/:id/templates`), takes its parameters (the required ones before it can
  be sent), a maintenance template's mode and the user's own words, and sends them as the user's message to the
  orchestrator (`POST /api/projects/:id/orchestrator/messages`), with the `nexus queue draft --template` command that
  writes the draft; the orchestrator drafts the queue, which waits for the user's approval as any.

### The notes template and reading outside the project

The `notes` template's worker reads the Claude sessions' memory folder (`memory_dir`), which is outside the project. Probed
2026-11-15 (Claude Code, `haiku`, effort low, a temporary project with the folder beside it; about $0.01 in all): in
`--permission-mode auto` the `Read` tool opens a file there; in `dontAsk` it is refused ("denied because the session is
running in don't ask permission mode"). With the rule `Read(//c/<path>/**)` in `--allowedTools` `dontAsk` reads it, and a
`Write` to the same folder is still refused: the rule gives reading of that folder only. So in a project whose
`permission_mode` is not auto, the user adds that rule to `runtimes.claude.allowed_tools` (the dashboard's Allow rule on the
refusal; a template cannot carry it, since a queue has no permission rules and an agent must not widen its own). The
template's stop conditions tell the worker to report a refused read as a finding with the rule to add.

## Static analysis reminder

Nexus ships a `static-analysis` template (`templates/static-analysis.yaml`, for any stack): survey the stack and ask the
user which tools to use, set them up with the existing findings as a baseline, and propose the lines for the project's
`defaults.checks` (which the user sets). While a project has none, its orchestrator is reminded of it once a month.

- **Detection** (`@nexus/protocol` static-analysis.ts, `detectStaticAnalysis`: pure, on a list of the project's files
  and a reader; `listProjectFiles` skips `node_modules`, `.git`, `.nexus`, `Library`, `Temp`, `Logs`, `obj`, `bin`,
  `dist`, `build`, `out`, `.vs`, `.idea`, `UserSettings`, at most 6 folders deep and 20000 files). Stacks: Node (a
  `package.json`), .NET (a `.csproj`, `.fsproj`, `.vbproj`, `.sln` or `.slnx`), Unity
  (`ProjectSettings/ProjectVersion.txt`; its generated projects do not make it .NET). Static analysis: for Node a linter
  config (ESLint, Biome, oxlint, JSHint, TSLint), `eslintConfig` in a package.json or a `lint` script; for .NET
  `EnableNETAnalyzers`, `AnalysisLevel`, `AnalysisMode` or `EnforceCodeStyleInBuild` in a project or
  `Directory.Build.props`, an analyzer package, or `dotnet_diagnostic.` rules in an `.editorconfig` or `.globalconfig`;
  for Unity a DLL whose `.meta` carries the label `RoslynAnalyzer`, an analyzer in a `csc.rsp`, or such rules. A
  project of no known stack is never reminded.
- **The note**: `.nexus/static-analysis.yaml` (`StaticAnalysisNote`), written only by the server
  (apps/server/src/static-reminder.ts): `reminded_at`, the last reminder; `declined` (`at`, `reason`, `session?`),
  the user's last no.
- **The reminder**: the engine looks at its start and then on its clock: when due (a month, 30 days, after
  `reminded_at`, and not before 90 days after `declined.at`) and the project has none, it writes `reminded_at`. The
  orchestrator is told that latest reminder once (also a session started after it), unless the user declined since:
  "This project has no static analysis set up ...", with the instruction to recommend the template in one sentence. A
  project that has static analysis is looked at again a month later.
- **The user's no**: `nexus static-analysis decline --reason "..."` (orchestrator only) records
  `static_analysis.declined`; the server writes `declined` and answers in `applied.jsonl` ("noted: ... no reminder
  until <time>"). `nexus static-analysis [status]` (any session) prints the stacks, what was found, and the note.

## One queue per checkout, and a limit

Queues run side by side only in worktrees of their own, never two in one checkout, and no more at once than the
limits: the global one across all projects, and a project's own for its queues (both hold).

- A queue's checkout is its worktree (`worktree`: a path; with `auto`, the folder Nexus creates for it, under
  `defaults.worktree_dir`), else the project's own checkout (`root`). Paths are compared without regard to case or
  the kind of slash.
- A checkout is held by a queue whose run is `running` (also with a step waiting for a review or an answer),
  `pausing`, `paused`, `usage_wait`, `retry_wait` or `approval_wait`: it will go on there. A halted or finished run
  holds none.
- The limits are the setting `defaults.max_running` (a whole number from 1 to 20, default 2; see "Global settings";
  decided 2026-11-15, queue OP). The global value limits the queues running at once across all projects; a project's
  own value limits its own queues as well, and a start must keep within both. A project that follows the global value
  has it as its own limit too, which adds nothing to the global one. Each limit counts the queues whose run is
  `running` or `pausing` (across all projects, or in the project), except a queue waiting for a review or an answer
  (its status `waiting`). Runs waiting for the usage window, a retry or an approval do not count.
- A start from the dashboard or the CLI (`nexus run Q start`, also a Continue that starts afresh) is refused with
  409 and the reason: "queue B cannot start: its checkout is in use, queue A runs there" ("… queue A is paused there";
  "… queue A of <project> runs there" for another project's queue), "queue B cannot start: 2 queues run, the limit
  is 2", or for the project's own limit "queue B cannot start: 1 queue of <project> runs, its limit is 1".
- Resuming a halted run, continuing a stopped queue whose run halted and accepting a review of a step whose run halted
  check the checkout the same way ("cannot go on", "cannot continue"); the limit does not apply to them. A paused or
  waiting run already holds its checkout and goes on as before.
- A planned start (by the plan or a schedule) that came due but may not start waits instead: its `start.yaml` gets
  `held` (`since`, `kind`: `checkout` or `limit`, `reason`: "waits for the checkout: queue A runs there", "waits: 2
  queues run, the limit is 2", "waits: 1 queue of <project> runs, its limit is 1"), shown in the plan's `waiting`. It starts by itself once it may; a held schedule is
  never missed. A plan that is no longer due (A opened again) loses `held`.
- The server has one coordinator over all projects' engines. It looks at the planned starts of every project after
  any change to a project's files (a project's own limit among them), after a run stops going (finished, halted,
  paused, waiting) and after the global limit changes. It takes the due plans of all projects in the order they were made (`created_at`) and looks again after
  each start, so one pass never starts two queues into one checkout or past the limit.
- Runs that were going before this rule came are left alone.
- The engine's long timers (schedules, usage waits, retries) are armed in pieces of at most a day, each looking at the
  clock again, so a time weeks ahead neither fires at once (Node's `setTimeout` does beyond 2^31-1 ms) nor early. A
  restart arms them again from the files; nothing fires while an update drains.
- The dashboard shows the plan with its time and how long until it, and a chip "starts at 22:00" on the row; Cancel
  ends it.

## Tags

A step's tags are facets, each answering one question (decided 2026-11-14, docs/ideas/tags.md;
`packages/protocol/src/tags.ts`). They are what statistics count by, and the kind will choose the runtime, model,
effort and fallback.

- `kind`: exactly one per step, the dominant kind of thinking: `mechanical`, `code`, `debugging`, `design`,
  `research`, `docs`. What else the step does goes into its activities. A list (or `code, docs`) is refused.
- `activities` (a list): what the step does. Nexus's own: `feature`, `bugfix`, `refactor`, `test`, `performance`,
  `security`, `migration` (data, schema, protocol), `dependency`, `ui`, `i18n`, `capture` (pictures and review
  material), `integration` (merging), `cleanup`, `build` (build and configuration); for games `assets`, `tuning`,
  `content`. A project's own carry its prefix (`hc:terrain`); statistics across projects compare Nexus's only.
- `area`: the part of the project, from the project's list.
- `size`: `S`, `M` or `L`, as planned; the time and use are measured, so estimate and outcome can be compared.
- `origin`: `user`, `maintenance` (a recurring or housekeeping queue; Nexus's own closing and integration steps),
  `orchestrator`, `fix` (a revision after a send-back or the user's Fix it), `ci` (a failing check or a bug found by a
  failure).

Each is optional in `queue.yaml`, so older queues stay valid; the orchestrator's briefing has new drafts always give
kind, size and origin. On the queue they are its steps' defaults: a step inherits each one it does not set (its own
`activities` replace the queue's). The steps Nexus keeps have their own: the closing step `code`, `[refactor]`,
`maintenance`; the integration step `code`, `[integration]`, `maintenance` (area and size: the queue's). Part of what
an approval pins: a step's tags are in its definition, and a queue's are in the revision hash only when set, so a
queue without them hashes as before. A started step keeps its tags (also those it inherits): a draft that would change
them is refused.

No free text: when a queue is drafted, every name must be on Nexus's lists or the project's as they are now; an unknown
one is refused with what to do (`nexus tags propose`), so is one proposed and not yet accepted, and one renamed since
("use the new name"). Tags a revision leaves as they were are not checked again. Files are never checked when read: a
queue with an unknown or renamed name still reads.

The project's lists, `.nexus/tags.yaml` (`TagsFile`), written only by the server: `prefix` (fixed by the first project
activity accepted), `areas` and `activities` (`name`, `at`, `reason?`), `renames` (`from`, `to`, `at`, oldest first),
`proposals` (`id`, `at`, `kind`: `area`, `activity` or `rename`, `name` (the new name), `from?` (a rename's old
name), `reason?`, `session?`) and `decisions` (`at`, `accepted`, `proposal`). Missing: empty lists.

- The orchestrator proposes with `nexus tags propose` or `nexus tags rename` (event `tags.proposed`); the server checks
  it (an area is lowercase words joined by hyphens; a project activity is `<prefix>:<name>` with the project's prefix;
  a new name is on no list, not proposed, not renamed away; only the project's own names are renamed) and adds it to
  `proposals`. Its first list is proposed the same way, and its briefing has it ask the user in the chat once whether
  the list is right, and again when it would extend it.
- Each proposal is an item of kind `tags` in the user's waiting list (`tags`: the proposal; text "New area terrain:
  <reason>", "Rename area engine to core"). Only the user decides (`POST /api/projects/:id/tags/:proposal`, `accept` or
  `decline`): accepting puts the name on its list (or renames the entry and records the rename); either way the
  decision goes into `decisions` and the orchestrator is told once (`notify:tagdecision:<id>`).
- A rename: every reader reads the old name as the new one (`renamedTag`, followed through a chain), in the step views,
  `nexus status` and the turn records; the files that carry the old name are never rewritten, so the history does not
  split. The old name is not used again.

Planned and observed: the orchestrator plans a step's tags; at `nexus step done --activities a,b` its worker says which
activities it actually did (checked like a draft's: a name on no list, or not accepted yet, is refused and nothing is
recorded). `StepView.observed_activities` is what the step's `step.done` events reported, over every round, renamed
names read as the new ones; absent while none was reported. `activityDifference(planned, observed)` gives `both`,
`unplanned` (done, not planned) and `skipped` (planned, not reported); the difference is itself a measure. The worker's
briefing asks for `--activities`, and a step's opening names its planned tags.

Where they show: `StepView.tags` (the step's as they read now), `ProjectState.tags` (the lists), the worker's `nexus
status` (a `tags:` line under each step), the orchestrator's overview (`{kind size}` after each step), and each worker
turn's record in `turns.jsonl`. The dashboard (`apps/web/src/components/Tags.tsx`): the step's details (a Tags section:
kind, size, area and origin, then the activities planned beside those done, planned-not-done struck through,
done-not-planned marked +), the queue card (its own steps' kinds and areas in a quiet line), the project's settings
(a Tags section: the proposals waiting, with Accept and Decline, the areas, own activities and renames, and Nexus's own
lists on request), and the waiting list (a `tags` item has Accept and Decline; on the project's page it opens the
settings). The pure part of the module (`@nexus/protocol/tags`) is free of Node; the proposals and decisions, which
write `tags.yaml`, are in `tag-proposals.ts`.

## Project metrics

What a project measures, beside its checks' times (decided 2026-11-14, docs/ideas/statistics.md;
`packages/protocol/src/metrics.ts`): the orchestrator names the metrics, the workers record their values, and every
value belongs to its step and the commit it was measured at. The statistics' views (queue ST3) and `nexus stats` read
them.

`.nexus/metrics.yaml` (`MetricsFile`), written only by the server: `metrics`, in the order they were first defined,
each `name`, `unit`, `show` (`line`, `bar` or `number`: how the views show it; default `line`), `target?` (the value
aimed at), `warn_above?` or `warn_below?` (the warning threshold, one at most), `at` (when it was last defined) and
`session?` (the orchestrator session). Missing: no metrics.

- The orchestrator defines one with `nexus metric define <name> --unit <unit> [--show …] [--target <n>]
  [--warn-above|--warn-below <n>]` (event `metric.defined`). The CLI checks it and the server checks it again, writes
  it and answers in `applied.jsonl`: a name is lowercase words and digits joined by hyphens, dots or underscores
  (`bundle-kb`, `fps.p95`, at most 64 characters); a unit is one short word (at most 16 characters); numbers are
  finite; one threshold at most. Defining a known name again replaces its whole definition (what it leaves out is
  gone), in its place. A worker cannot define (the CLI refuses it, and the loader ignores the event from any session
  but an orchestrator's or the user's).
- A worker records a value with `nexus metric record <name> <value> [--step <step>]` (event `metric.recorded`, among
  its own events): for its one step at work (`--step` names another of its queue), with the metric's unit as it is
  then and the HEAD of the session's checkout (`commit`; absent outside a git repository). Refused, with nothing
  written: a value that is no finite number, a name the project has not defined (the refusal lists those it has), a
  check's time, no step at work, or any session but a worker's (the loader ignores a `metric.recorded` from any other
  session, with a warning). The orchestrator says in a step's goal what its worker should measure; the worker's
  briefing names the command.
- A check's time is a metric without a definition: `check:<the check's name, as reported with nexus check>`, in
  seconds, from `check.result`'s `duration`; `nexus check` records the HEAD commit with it. The orchestrator may define
  `check:<name>` for a target or a threshold (its unit is `s`, the only one taken). It is never recorded by hand.

Derived: `ProjectState.metrics` is the file; `StepView.metrics` the step's values over every round, oldest first, each
`name`, `value`, `unit`, `at`, `event` (the event's id), `session`, `commit?`, and `warn` (`side`: `above` or `below`,
`limit`) when the value is strictly beyond its metric's threshold as the metric is defined now. A value beyond the
threshold that was recorded after the threshold was defined (and after the orchestrator session began) is told to the
orchestrator once (`notify:metric:<event>`: "Step W3 of queue W: bundle-kb is 900 KB, above its warning threshold of
500 KB (at 1a2b3c4)."), and its review notice lists the round's recorded values ("Metrics recorded this round"), each
beyond its threshold marked. The dashboard does not show metrics yet (queue ST3); `nexus metric list` lists them.

## Statistics

How steps went, by group, for two readers (decided 2026-11-14, docs/ideas/statistics.md): the orchestrator choosing a
model and effort, the user watching the use of the subscription. One computation, free of Node
(`packages/protocol/src/stats.ts`), read by `nexus stats` from the files and by `GET /api/stats` (and the project's
metrics by `GET /api/projects/:id/metrics`) for the Stats views.

- **The steps counted** (`stepStats`): every step with an outcome in its timeline (`step.done`, `step.failed`, a
  `queue.stop` at it), with its worker turns from `turns.jsonl` (`role` worker, its project, queue and step). `rounds`:
  how many times it was reported done; `accepted`: its status is done; `first`: accepted with one round; `decided`:
  accepted, rejected or failed; `stops` and `failures`: its `queue.stop` and `step.failed` events; `work_ms`: the sum of
  its worker turns' `duration_ms` (its own work, never the wait for a review); `model`, `effort`, `runtime`: its last
  worker turn's; `fallback`: a worker turn of it ran on a fallback (`TurnRecord.fallback`); `usage`: the estimated use
  of each window (`<runtime>:<window>`, in utilization, 0 to 1) summed over its worker turns (`usageEstimates`, see
  `turns.jsonl`), and `usage_missing`, its turns without an estimate. `--since` compares its last outcome.
- **Groups** (`statsReport`), by `model`, `effort`, or a tag facet: `kind`, `activity` (a step is in the group of each
  activity it planned or reported), `area`, `size`, `origin`. A step without the facet (older queues), or without a
  worker turn's model, is `untagged`; one with a model and no effort is `default`. A project's own names, its areas and
  prefixed activities, count only within it: across projects they read `<project>/<name>`; Nexus's activities are
  compared across projects as they are.
- **Each group** (`StatGroup`): `steps`; `few` when fewer than 5 (`FEW_STEPS`: read with care); `decided`,
  `first_accepted` and `first_rate`; `avg_rounds` (of the steps reported done); `stops`, `failures`; `median_ms`,
  `p25_ms`, `p75_ms` (the working time of its accepted steps; by size, how the planned size came out); `usage` and
  `usage_missing` (an estimate, and labelled so); `fallback` (steps with a turn on a fallback); by activity also
  `activities`: `planned` (steps that planned it), `observed` (that reported it), `unplanned`, `skipped` (planned, and
  the step reported other activities). Largest group first. Also `runtimes` (of its steps' last worker turns) and
  `usage_steps` (by window, its steps with an estimate in it: what a use per step divides by).
- **The report** (`StatsReport`): `by`, `project?`, `since?`, `filter?` (the tag values it was narrowed to: `kind`,
  `activity`, `area`, `size`, `origin`, one each; a step passes when it is in that facet's group of the value),
  `steps`, `groups`, `total` (every step counted, once, as one group keyed `all`) and `facets` (by facet, the values the
  steps in the range and project have before the tag filter, sorted: what the view's filters offer).
- **The windows day by day** (`usageDays`, `GET /api/usage/days`): `days` (local dates of the server, oldest first)
  and `windows`, each `{ runtime, window, kind, values }` for the 5-hour (`kind` `5h`) and weekly (`7d`) windows with
  a reading in the period (Claude Code's first). The readings are every turn's `windows_start` and `windows_end` in
  `turns.jsonl`. A 5-hour window's value is the day's highest reading (null on a day without one); a weekly window's
  the last reading by the day's end, 0 once its `resets_at` has passed, null before its first reading.
- **`nexus stats`** prints a line per group (`statsText`): "- opus: 5 steps; accepted in the first round 3 of 4
  (75 %); 1.2 rounds on average; 1 stop, 0 failures; median work 30 min (25 min to 33 min 45 s); estimated use
  claude:five_hour 1 %; 1 on a fallback", with "(few data)" after a small group's count and a closing line that says
  the use is estimated. It reads the registered projects (and the one it runs in, if not registered) and
  `<NEXUS_HOME>/turns.jsonl`, and writes nothing. `--since` takes a date (from that day's start, local time) or a time.
- The orchestrator's briefing asks it to look at `nexus stats --by model` and `--by effort` (and `--by kind`) before it
  chooses a model or effort other than the kind's, or proposes changing a kind's values, and to cite the figures it goes
  by; a few-data group is no evidence.

## Fallback when usage runs out

When a step's runtime is beyond the usage threshold, the work goes on on a fallback instead of waiting (decided with
queue FB, 2026-11-14). Nexus switches by rules (the settings and the queue YAML), not by the orchestrator's judgement;
the orchestrator is told afterwards.

**Beyond the threshold** (`routing.ts`, `overThreshold`): any of the runtime's windows in `<NEXUS_HOME>/usage.json`
(Claude Code's `five_hour` and `seven_day`, and any other it reports; Codex's `codex_*`) at or above the project's
`defaults.usage_pause_threshold`. A window the runtime has not reported is free; one whose `resets_at` has passed counts
as reset, without a fresh reading; one without a reset time counts as free (nothing to wait for). With two full
windows, the later reset counts.

**At a step boundary** (`chooseRoute`), before the next step opens: its own values (see "Kinds and their defaults")
while their runtime is free; else the first entry of its fallback chain whose runtime is free (an entry on a full
runtime is passed over; an entry's model or effort left out is the project's for that runtime); a `wait` entry waits
(`usage_wait` until the reset); a chain with no free entry left (or none) waits until the earliest reset among the
runtimes it tried, so with both full the run waits for the one that comes back first. The switch is at the threshold,
not the limit, so no turn is cut off. A step on another runtime than the session's opens in a fresh session given the
previous step's context summary (asked for first, as for any change of runtime; "Runtime, model and effort per step").
At the next boundary after its own runtime is free again, a step opens on its own values again (back), the same way. A
first step whose runtime is full at the start opens on its fallback at once (its session is made there).

**In the middle of a step** (the engine's `usageGate`): before every turn within a step, that is a nudge of a turn
without an outcome, an answer, a send-back (the user's Fix it or the orchestrator's), and a message to an idle session (not a
continue after a wait or a retry, which goes on as before), the engine looks at the session's runtime. Beyond the threshold, the step goes by
its chain as at a boundary: on the first free entry (or on its own values again, when the session runs on a fallback
that is full now), the old session ends and a fresh one continues the step (`switches[].why: usage`, a `fallbacks`
entry for the step). Its first text (`midStepSeed`) says why and gives the step's progress lines, its commits since its
round began (`git log` from the round's start in `git.yaml`), and the uncommitted changes in the checkout
(`git status`, `git diff --stat`), which stay where they are: the new session is told to keep them and go on from
them. Then the step's opening ("Continue this step"), then the old session's unread inbox entries (the answer, the
send-back, the message that was due); a carried send-back opens its round. At a `wait` entry, or with no free entry,
the run waits (`usage_wait`) in the middle of the step, its session kept, and continues it after the reset. A turn that is running is never cut off: an entry for a working session goes into its running
turn as before, and the gate looks only when the session is idle. A turn that failed on the usage limit (a `usage`
failure with its reset time) goes the same way: its runtime counts as full until that reset, and the step goes on on
the next entry of its chain instead of waiting (`fallbacks[].reason`: "the usage limit was reached (…)").

**The words**: why a runtime counts as full is said one way everywhere (`windowReason`): "Claude Code's 7-day window at
96 % (limit 90 %)", "Codex's 5-hour window at 100 % (limit 90 %)"; a run's `usage_wait` reason, a fallback's `reason`
and the orchestrator's notice use it, and the dashboard shows a step's switches as "On Codex (gpt-6-luna, low effort):
<reason>" and "Back on Claude Code: its usage is below the limit again" (in its details, and for the step on the
queue card: a line under the step that matters, a ⇄ with the text as its title on the others). A turn refused for the
limit keeps its own reason ("the usage limit was reached (…)").

**The record**: each step that opened on its fallback, and the step that opened on its own values again, is an entry
in `run.yaml` `fallbacks` (once per step), with an activity line; `StepView.usage_switch` is the step's latest entry,
and each turn of a step on its fallback has `fallback: { from, reason }` in `turns.jsonl`, so statistics can tell them
apart.

**The orchestrator** is told of each entry (`notify:fallback:<queue>:<step>:<at>`: "Step Q2 of queue Q runs on its
fallback, Codex, …, instead of Claude Code: <reason>"; a switch back likewise). While its own runtime (Claude Code) is
beyond the threshold, no notice starts its turn: each goes into its inbox (`sessions/<id>/inbox.jsonl`, id
`notice-<key>`, from `nexus`), not told yet; the reviews it would do (levels 2 and 3) wait meanwhile. At the first
change after that runtime is free (a timer looks again just after the reset), every held notice is told, and its inbox
entry counts as delivered. The user's own messages to it are not held.

## Kinds and their defaults

Each kind (see "Tags") has its own runtime, model, effort and fallback chain in the settings (`kinds.<kind>`, global
with a project override, edited per kind in the settings panel's "Kinds of work"). They replace the project's one
model as the only default (decided with queue FB, 2026-11-14). As shipped (the user changes them at any time):

| Kind | Runtime | Model | Effort | Fallback |
|---|---|---|---|---|
| mechanical | Claude Code | claude-sonnet-5-5 | low | Codex, gpt-6-luna, low |
| code, debugging, research | Claude Code | claude-opus-5-5 | high | Codex, the project's Codex model, high |
| docs | Claude Code | claude-sonnet-5-5 | medium | Codex, the project's Codex model, medium |
| design | Claude Code | claude-opus-5-5 | high | wait |

A kind's model or effort left out (or the project's own `null`) is the project's for that runtime
(`runtimes.<runtime>`). A fallback chain is a list: each entry a runtime with an optional model and effort (left out:
the project's for that runtime), or `wait`; `wait` ends the chain. Checked where it is written: a draft, the settings
(an effort the runtime does not take, an entry after `wait`, an unknown key are refused).

**The precedence** (`packages/protocol/src/routing.ts`, `routeStep`), strongest first:

1. The step's own `runtime`, `model`, `effort`, `fallback` in the queue YAML.
2. The queue's `runtime`, `model`, `effort`, `fallback` (part of what an approval pins when set).
3. What the run's start named explicitly: `--runtime`, `--model`, `--effort` (the dashboard's start the same), or all
   three when it continues a session. Those it took from the project's defaults (`run.yaml` `from_defaults`) are not
   this level.
4. The step's kind's defaults: the project's own values, else the global ones.
5. The project's defaults: `runtimes.default`, and `runtimes.<runtime>.model` and `effort`.

The runtime is the strongest level's that names one. A model or effort comes from the strongest level that names one
and belongs to that runtime: the step's always; the queue's when the queue names no runtime or the same one; the
start's and the kind's only when their runtime is the step's (the start's runtime is the one it resolved, explicit or
from the defaults); else the project's for that runtime. So the kind overrides only what the start took from the
defaults (a run started with `--model X` runs a mechanical step on X, at the kind's effort), and with an explicit
runtime the kind's model and effort count only when the kind's runtime is the same one; else the run's values. The
fallback chain is the strongest level's that names one (step, queue, kind; an empty list is a choice too); none: the
run waits for the usage window, as before. A step without a kind gets the project's defaults. The orchestrator may
depart from this for a run or a step (`--model`, the step's own values) and says why. The estimates
(`queueEstimate`) use the same precedence.

## Runtime, model and effort per step

A run records its own runtime, model and effort when it starts (`run.yaml`). Those its start chose (or took from the
session it continues) stay for the whole run. Those it took from the project's defaults are listed in `from_defaults`
and resolved again from the project's effective settings (its own values, else the global ones) when each step opens,
so a changed default reaches a running queue at its next step. Which values a step runs on follows "Kinds and their
defaults" above: its own, its queue's, the start's, its kind's, the project's, never the previous step's. A model or
effort chosen at the start belongs to the runtime the run started on: a step on another runtime takes what it does not
name from its kind (when the kind is on that runtime) or the project's defaults for that runtime. The values are
checked when the step opens: an effort the resolved runtime does not take halts the run, naming the step and the reason
(`step Q2: Claude Code takes effort …`).

Starting a run checks every step still to run: one that would run on Claude Code at an effort Claude Code does not take
refuses the start, naming the step and the reason; nothing is written. A run that continues a session (`session`,
`use_session`) must begin with a step on that session's runtime. Before opening each step the engine makes the session
fit it:

- **Another runtime** than the session's (also back to one used before): a fresh session, seeded as below
  (`switches[].why: runtime`).
- **The same runtime, another model or effort**: the same session. Claude Code takes them only at start, so the engine
  ends the idle process and starts it again with `--resume`, the new `--model` and `--effort`, then opens the step
  (a process that has not exited after 10 seconds is killed). Codex takes them per turn: `turn/start` carries `model`
  and `effort` ("for this turn and subsequent turns"); going back to a value the step left out names what the thread
  started with (`model` and `reasoningEffort` of the `thread/start` or `thread/resume` result). `session.yaml` holds
  the values in use.

## Context care

With `defaults.context_care` on (the default), at the end of a step whose session's context fill (`context_tokens`
/ `context_window` in `runtime.json`) is above `context_reuse_threshold`, and when a next step remains, the engine
goes on in a fresh session. Without a known context window it goes on in the same session. A fresh session for another
runtime is made the same way, and so is one for the closing refactoring step (`why: refactor`: no summary is asked
for, and the seed gives none; see "The closing refactoring step").

1. It looks for a fresh summary: a `context.summary` from that session at or after its latest `step.started` of the
   step that ended. If there is none, it asks once with a turn ("… write your context summary with `nexus context`
   …, then end your turn") and records `summary_asked` in `run.yaml`; after that turn it goes on with or without one.
2. It writes the new `session.yaml` (the next step's runtime, model and effort, the same working directory; `continues`) and sets
   `continued_by` on the old one, closes the old process, points `run.yaml` at the new session and appends to
   `switches`.
3. The new session's first turn is a seed, then the step turn, then the old session's unread inbox entries (recorded
   in the old session's `delivered.jsonl` as `carried`). The seed names the queue and the old session's fill, gives
   the summary (text, topics, files) or says there was none, and lists the queue's description and its steps with
   their states and the finished steps' summaries.

```
[Nexus] You take over queue W "Variant B made a system" in a fresh session: the session that ran the queue so far
had its context 82% full. You have not seen its work, only what follows.

Its context summary at the end of W2:
...
Topics: rock, support

The queue:
...

Its steps:
- W1 Voronoi fracture: done. <its summary>
- W2 Bodies shaped: done. <its summary>
- W3 Support: yours now

[Nexus] Queue W "Variant B made a system" (revision 3, approved), step W3 (3 of 7): Support.
...
```

## The orchestrator's context care

The orchestrator is not compacted: it goes on in a fresh session started from a summary it writes on purpose (decided
by the user on 2026-11-15; DESIGN.md, "The orchestrator's context care"). `orchestrator.context_threshold` (global
with a project override, 0 to 1, default 0.85) is the fill (`context_tokens` / `context_window` in its
`runtime.json`) at which this happens.

1. **The request.** When the server looks at a change (`Orchestrator.onChange`) and the orchestrator's process is idle
   (between turns) with its fill above the threshold, it asks once, with a turn: "[Nexus] Your context is N % full (the
   threshold is T %): Nexus goes on with you in a fresh orchestrator session … Write that summary now with `nexus
   context …`: the decisions made with the user and why, the open items, the plan …, and what you promised the user
   … Then end your turn". It records `context:asked` in the session's `applied.jsonl` (the fill as its `message`), and
   the chat shows a Nexus line. Never while a turn runs; not while the orchestrator's runtime is beyond the usage
   threshold; not while an update drains. Without a known context window, nothing happens.
2. **Meanwhile** nothing else reaches the session: notices and the user's notes wait for the fresh session, and a
   message the user sends shows in the chat and waits in the session's inbox (`say-<id>`, a `message` from the user).
3. **The switch**, once that turn is over (or the process has ended): the summary is the session's latest
   `context.summary` at or after the request. If there is one, the server writes `.nexus/orchestrator/summary.md`
   (replaced whole: a heading, which session wrote it when and at what fill, which session started from it, the text,
   its topics and files). It writes the new `session.yaml` (`continues`) and sets `continued_by` on the old one, marks
   the old session's unread inbox entries (not held notices) `carried` in its `delivered.jsonl`, closes the old process
   and points `orchestrator.session` at the new session. The old chat gets "The orchestrator goes on in a fresh session
   (<id>).", the new one a line that says whether it starts from the summary or, without one, from its current briefing
   and `nexus status` only.
4. **The fresh session's first message**: who it is and why (the old fill); the summary (text, topics, files) or the
   line that there was none; that its briefing (the system prompt, the current one) holds over the summary and the files
   are the truth; the messages carried over (`formatInbox`); and the project's state as `nexus status` shows it in an
   orchestrator's session (`orchestratorOverview` in the protocol's `overview.ts`, which the CLI prints too).
5. **Afterwards** the fresh session is told what no session of its line was told, since the first of them (the
   `notify:…` keys of every session it continues); deploy changes only those after its own start. A fresh session
   whose fill is above the threshold at the end of its first turn is not switched again (`context:first`): another
   would be no emptier.

## How the engine runs a Codex session

`codex app-server` over stdio: JSON-RPC requests and notifications, one JSON object per line, no `jsonrpc` field.
After `initialize` (with `experimentalApi`) and `initialized`, `thread/start` (or `thread/resume` with the stored
thread id) with the working directory, model, sandbox mode, approval policy (`never`: Nexus runs unattended; any
approval request that still comes is declined) and the worker briefing as `developerInstructions`. The thread id
becomes the session's `native_id`.

A worker's thread starts without the user's own Codex tools (queue FX): before `thread/start` (or `thread/resume`)
Nexus reads the effective config (`config/read` with the working directory) and adds to the thread's `config`
`features.apps: false`, `features.plugins: false` and `mcp_servers.<name>.enabled: false` for every MCP server it
names, except those in the project's `runtimes.codex.mcp_servers` (left as the user's config has them). A name that
is not a bare key is quoted (`mcp_servers."odd.name".enabled`). When the config cannot be read, the thread does not
start. A thinking partner's thread starts so too, keeping none. The orchestrator always runs on Claude Code (its
`orchestrator.runtime` counts only for the usage threshold); should it run on Codex, it would keep none either.

- a step turn: `turn/start` with `input: [{type: "text", text, text_elements: []}]`, the session's `effort` (and,
  once a step changed them, `model` and `effort`) and, in `workspace-write`, a `sandboxPolicy` whose writable roots include the project's `.nexus/` when the worktree is elsewhere
- a message while the agent works: `turn/steer` with the running turn's id
- a picture uploaded for a chat message: each line of a message (of either request) that is the absolute path of an
  existing `.png`, `.jpg`, `.jpeg`, `.webp` or `.gif` file in a `.nexus/uploads/` folder also goes in as
  `{type: "localImage", path}` after the text item; the text keeps the path (see "Uploads" under "Server API")
- stop now: `turn/interrupt`, then the message as the next turn

It reads `turn/started` and `turn/completed` (the turn's status), `item/started` and `item/completed`
(`commandExecution`, `fileChange`, `agentMessage`, `mcpToolCall`, `webSearch`, `subAgentActivity`),
`thread/tokenUsage/updated` (the last request's input tokens are the context in use; `modelContextWindow`) and
`account/rateLimits/updated` (stored as `codex_<window>` in `usage.json`, e.g. `codex_7d`). Only notifications of the
session's own thread count: a sub-agent's thread sends its own turns and items over the same connection, and they are
ignored. Background work (DESIGN.md, "Background work"): a `commandExecution` item still open when its turn has
completed, and a sub-agent from its `subAgentActivity` `started` (or `interacted`) until its `completed` (or
`interrupted`). Checked against Codex CLI 0.167.2.

## How the engine runs a Claude Code session

`claude -p --input-format stream-json --output-format stream-json --verbose --session-id <uuid>` (or `--resume
<uuid>` for a session that ran before), with the project's permission mode, `--allowedTools Bash(nexus:*)
PowerShell(nexus:*)` plus the project's list (as it is: its rules get no PowerShell pair), the model, and a worker briefing as `--append-system-prompt-file <.nexus>/sessions/<id>/briefing.md`
(every Claude Code session's briefing, the orchestrator's and a thinking partner's too, goes in that file, written by the
server at each start: the command line stays short of Windows' 32,767 characters). With `defaults.protect_nexus` on (the
default), `--disallowedTools Edit(//<.nexus>/**),Write(//<.nexus>/**)` names the project's `.nexus` by its absolute
path in Claude Code's rule form (`//` and forward slashes, the Windows drive letter as the first segment:
`C:\Code\P\.nexus` is `//c/Code/P/.nexus`), so it holds from a worktree too; deny rules win over the allow list. The
nexus CLI, which writes the worker's events there, is a process, not a file tool, and keeps working. Orchestrators
and thinking partners keep their own rules. Codex workers start without the user's own Codex tools but the MCP servers
the project names (see "How the engine runs a Codex session"). Environment: `NEXUS_SESSION`,
`NEXUS_DIR`. The process stays alive across turns; stdin carries user messages:

- a step turn: `{"type":"user","message":{"role":"user","content":"…"},"parent_tool_use_id":null}`
- a message while the agent works: the same with `"priority":"next"` (read after its current tool calls, no interrupt)
- stop now: `"priority":"now"` (interrupts the turn)

From stdout it reads `system/init` (a turn starts), `assistant` (tool calls, text, context usage),
`user` tool results (errors), `rate_limit_event` (usage windows), `system/background_tasks_changed` (the whole list
of background tasks: a Bash command or a sub-agent started with `run_in_background`; when one ends, the CLI starts a
turn by itself with its notification) and `result` (the turn ended; the context window from `modelUsage`). After a
turn ends it decides the next move from the step's state: next step, wait (question, review, background work: see
DESIGN.md, "Background work"), nudge once if the step has no outcome, or halt.
