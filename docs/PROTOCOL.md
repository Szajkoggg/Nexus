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
runtimes:
  claude: { permission_mode: auto, allowed_tools: [] }       # allowed_tools: project only
  codex:  { model: null, approval_policy: on-request, approvals_reviewer: auto_review }   # null: its own "none"
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
            usage_pause_threshold: 0.9 }
runtimes:
  default: claude
  claude: { permission_mode: acceptEdits }            # model, effort: none (the runtime's default)
  codex:  { sandbox: workspace-write, approval_policy: never }   # model, effort, approvals_reviewer: none
conversations: { runtime: claude }                    # model, effort: none
orchestrator: { runtime: claude, notify: true }       # model, effort: none
languages: {}                                         # reader: none (the language the user writes in)
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
| Global, with a project override | `defaults`: `stop_conditions`, `review_level`, `review_send_back_limit`, `context_reuse_threshold`, `context_care`, `protect_nexus`, `push_accepted`, `provisional_counts`, `usage_pause_threshold`. `runtimes`: `default`; `claude`: `model`, `effort`, `permission_mode`; `codex`: `model`, `effort`, `sandbox`, `approval_policy`, `approvals_reviewer`. `conversations`: `runtime`, `model`, `effort`. `orchestrator`: `runtime`, `model`, `effort`, `notify`. `languages`: `reader` |
| Project only | `name`, `defaults.worktree_dir`, `runtimes.claude.allowed_tools` (the project's own allow rules), `conversations.notes_dir`, `languages.working` (`id` and `root` identify the project) |
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
  while it waits (`waiting` as above, also while its run is paused); on approval the run finishes, and a chain after
  the queue fires only then. A planned start after the queue says `queue A waits for approval of revision N (after
  S)` and is `blocked` (it waits on the user). The dashboard shows the queue as "waits for approval of revision N ·
  after S" (the approval colour) and its run as "waiting for approval", with Pause.

While a run is `approval_wait`, a start of the queue, a start in its session by another queue (a chain's start waits
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
imported stop) or a finished run, the queue starts afresh at its first pending step. The orchestrator is
told once. The dashboard shows the stop with the orchestrator's proposal (`lift_proposal`) beside Continue, and the
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
| `--step S skipped` | S is `pending`, `stopped` or `failed`, or `running` while no live run (`running`, `pausing`, `usage_wait`, `retry_wait`) has it open, and the queue is not done or cancelled | `kind: status`, `step`, `from` (S's status), `to: skipped`: S becomes `skipped` with the reason; when every step is then done, skipped or failed the queue is `done`. A stop is not lifted by it |
| `finished` | the queue's run is `halted` and every step is done or skipped | `kind: run`, `from: halted`, `to: finished`; the server also writes `run.yaml` `finished` |
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
| `review.added` | `queue`, `step`, `items: [{path or url, label, kind?, before?, key?, role?, size?}]`, `round?` | Review material, `kind` = image, sheet, doc, data, link; `before`: the path of the picture this one is compared with; `key` (a view key), `role` (before, mockup, after, variant-a, variant-b, result) and `size` (`width`, `height` in pixels): a keyed picture, always with its `round` (see "Review pictures") |
| `review.marked` | `queue`, `step`, `path`, `accepted` | User only: a review picture marked accepted (or the mark taken back). A mark only: it does not accept the step |
| `review.commented` | `queue`, `step`, `path`, `text`, `to` (`send_back`, `note`, `orchestrator`), `note_step?` | User only: a comment on a review picture, and where it went (see "Review pictures") |
| `check.result` | `queue`, `step`, `name`, `ok`, `summary` | One check's outcome |
| `step.done` | `queue`, `step`, `summary`, `commit?`, `warning?` | Acceptance met; the step's work is finished. `warning`: what `nexus step done` warned about at the step's end (see the CLI) |
| `step.failed` | `queue`, `step`, `reason` | The step cannot be finished as written |
| `queue.stop` | `queue`, `step`, `condition`, `reason` | A stop condition was met; the engine halts the queue. `condition`: the condition met, as the queue words it; `reason`: what happened, short. The derived queue keeps them apart in `stop` (`{ condition, reason }`, until a lift) besides `status_reason` ("<condition>: <reason>"); the stopped waiting item's `text` is the reason and its `condition` the condition. A stop known only as one text (a queue imported as stopped) has no `stop`, and shows its `status_reason` |
| `question.asked` | `queue?`, `step?`, `qid`, `text`, `options?`, `recommended?`, `can_continue` | A question; `can_continue` says whether independent work remains; `recommended`: the asker's recommendation, one of `options` (the CLI refuses another; the state drops it with a warning) |
| `question.withdrawn` | `qid`, `reason` | No longer needed |
| `answer.given` | `qid`, `text`, `escalate?`, `recommended?` | Orchestrator only: an answer, or an escalation to the user with its framing. With `escalate`, `recommended` is the orchestrator's recommendation, one of the question's options; it replaces the asker's on the derived question (`QuestionView.recommended`, and the waiting item's `recommended`), whose button the dashboard marks |
| `note.read` | `note` | A note was received |
| `message.read` | `message` | An inbox message was received |
| `context.summary` | `text`, `topics: []`, `files: []` | What a successor or continuation needs to know; written at the end of each step |
| `queue.report` | `queue`, `path`, `summary` | The worker's report of the whole queue, written when it ends (done or stopped). `path` is the copy in the queue's folder (`.nexus/queues/<queue>/report.md`), which `nexus report` writes |
| `change.proposed` | `queue`, `patch`, `reason` | A proposed change to a queue definition (needs a new approval) |
| `queue.drafted` | `queue`, `definition` | Orchestrator only: a new or changed draft queue |
| `session.request` | `action` (start, resume, pause, stop, cancel_start), `queue`, `use_session?`, `runtime?`, `model?`, `effort?`, `after?`, `start_at?`, `reason` | Orchestrator only: asks the engine to act on a queue's run (`use_session` continues an existing session). `start` with `after`: start when that queue is done (a chain, see "Chains"); with `start_at` (ISO 8601, or `usage-reset`): start at that time (a schedule, see "Schedules"); `cancel_start`: cancel the queue's planned start |
| `review.sent_back` | `queue`, `step`, `text` | Orchestrator or user only: a step in review goes back to its worker with what to fix (see "Sending a step back") |
| `review.rejected` | `queue`, `step`, `text?` | User only (the loader ignores it from any other session, the orchestrator's included): rejects a step waiting for the user's review (see "Reject") |
| `review.asked_user` | `queue`, `step`, `text` | Orchestrator only in practice (the loader takes it from an orchestrator or the user): a step waiting for the orchestrator's review goes to the user, with why |
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
| `queues/<id>/git.yaml` | The HEAD of the queue's checkout around each step's work (`src/gitinfo.ts`): `base` (an auto worktree's: `ref`, the branch or commit it was made from, its `sha`, `at`), `base.branch` (whether `ref` names a branch: only a branch can be merged back into), `merged` (`at`, `into`, `path`, `sha`, `fast_forward`), `cleaned` (`at`, `path`, `branch`), `steps.<step>` (rounds, oldest first: `session`, `start` (HEAD when the step opened, or when a send-back reopened it), `started_at`, `end` (HEAD at the end of the turn in which the step got its outcome: done, review, failed or stopped), `ended_at`; a sha is null outside a git repository). A continued step keeps its open round. One writer: the server. See "Git on the dashboard" |
| `queues/<id>/push.yaml` | Pushing what was accepted: `review` (per step, the HEAD of the checkout when it entered review: `sha` or null, `finished_at`, `at`), `steps` (per accepted step: `acceptance`, `sha`, `result` (`pushed`, `failed`, `skipped`, `held`), `text`, `at`, `held_by?`), `pushed` (the last success: `sha`, `step`, `at`, `remote`, `branch`), `error` (the last failure until a success). One writer: the server. See "Pushing what was accepted" |
| `queues/<id>/start.yaml` | A planned start of the queue (see "Chains" and "Schedules"): either `after` (the queue it waits for) or `at` (the time, ISO 8601; with `usage`, `claude` or `codex`, when that is the usage window's reset plus the margin), the start's `runtime?`, `model?`, `effort?`, `session?` (a session to continue), `by` (`user` or `orchestrator`), `reason?`, `revision` (the queue's when planned), `created_at`, `failed?` (`at`, `reason`, `missed?`: it came due and the queue could not start; `missed`: a schedule more than 15 minutes late, the server not running at its time), `held?` (`since`, `kind`: `checkout` or `limit`, `reason`: it came due but waits for its checkout or for a place under the limit, and starts by itself; see "One queue per checkout, and a limit"). One writer: the server; a start of the queue or a cancel removes it |
| `queues/<id>/run.yaml` | The engine's intent for a queue: `session`, `after` (started by a chain: the queue that was done), `state` (`running`, `pausing`, `paused`, `halted`, `finished`, `usage_wait`, `retry_wait`: a turn failed for a passing reason and is tried again at `resume_at`, `approval_wait`: a step ended while a newer revision waits for the user's approval, and the run goes on by itself once approved, see "A new revision of a running queue never stops the running step"; `running`, `pausing`, `usage_wait`, `retry_wait` and `approval_wait` hold the run's session and checkout: `HOLDING_RUN_STATES` in the protocol), `reason`, the `step` it last opened, `nudged`, `resume_at` (when a usage wait or a retry goes on), `retries` (turns failed in a row for a passing reason; cleared by a turn that ends well or a new step), `failure` (the runtime's code for the failure being retried or that halted the run, e.g. `overloaded`), `resume_after_restart`, `runtime`, `model` and `effort` (the run's own as its start resolved them: the start's choice, else the continued session's, else the project's effective defaults; a missing model or effort is the runtime's default), `from_defaults` (which of the three came from the project's defaults: resolved again when each step opens; see "Runtime, model and effort per step"), `started_at`, `ended_at` (when it last stopped going: set when it becomes `finished`, `halted` or `paused`, kept while it stays so, removed when it goes on; older files without it fall back to `updated_at`), `summary_asked` (context care: the step whose context summary Nexus asked for; asked once), `switches` (each fresh session, oldest first: `at`, `from` and `to` session, `step` the new session began with, `why`: `context` (context care; a record without `why` is this) or `runtime` (the step runs on another runtime), `fill` of the old one from 0 to 1 when known, `summary`: `written` by the worker, `asked` and then written, or `fallback`), `revision` (the queue's revision the run goes by: written at the start, moved to the current approved one at the end of a step). Start refuses a `stopped` queue, naming the step and the stop's reason, and writes `revision`; it also refuses while the run holds its session (`approval_wait` included). Resume refuses a stopped or cancelled queue, an unapproved revision unless the run is of an older one (`revision` below the queue's; a run record without `revision` is older when a revision was replaced, in `history`, after its `started_at`: such a run goes on mid-step while the newer revision waits), and an `approval_wait` run until its revision is approved. A run of an older revision is resumed like any: a revision changes no started step. Archived records are `run.<time>.yaml` (see "Changes and lifting a stop") |
| `sessions/<id>/runtime.json` | A launched session's live facts: process state (`working` from a turn's start to its end, `idle` between turns, `exited`) and pid, model, context tokens and window, turns, cost |
| `sessions/<id>/delivered.jsonl` | What the server handed to the session (notes put into a step turn, inbox entries injected or sent as a turn, or `carried` into the first turn of the session `to` that took over); counts as read |
| `sessions/<id>/refusals.jsonl` | One line per action the agent wanted but was refused: `at`, `session`, `runtime`, `by` (`permissions`: Claude Code's permission mode or rules; `nexus`: Nexus declined a Codex approval request; `auto_review`: Codex's auto reviewer), `tool` (Claude Code's tool name; for Codex `command`, `file_change`, `network`, `mcp`, `permissions`, …), `input` in short (the command, path or host, at most 300 characters), `reason` when the runtime gave one, `ref` (the runtime's id for the call: one record per refusal), `queue`, `step` |
| `sessions/<id>/activity.jsonl` | A condensed record of the agent's stream: turns, tool calls, texts (clipped to 600 characters), tool errors, exits, and retries (`retry`: the runtime's own and the engine's), tagged with queue and step |
| `sessions/<orchestrator>/applied.jsonl` | The server's result for each orchestrator request (`queue.drafted`, `session.request`, `status.set`), and the notices it has sent the orchestrator; the CLI waits for the result and prints it |
| `sessions/<orchestrator>/chat.jsonl` | The chat shown in the dashboard: the user's messages, the orchestrator's texts (whole, however long) and tool calls, Nexus notices. Append-only: an entry's **line** is the index from 0 of its line in the file (blank and broken lines counted, never shown), and stays its line for good |
| `sessions/<orchestrator or conversation>/pins.json` | The chat's pinned messages: `{ pins: [{ line, at }] }`, `line` the message's line in that session's chat.jsonl, `at` when it was pinned; in chat order. A tool line cannot be pinned. A fresh session (a new orchestrator conversation) starts without pins; the old session's file stays with it. One writer: the server, on `POST …/sessions/:session/pins` from the dashboard |
| `<NEXUS_HOME>/settings.yaml` | The global settings, which projects follow where they have no value of their own (see "Global settings") |
| `<NEXUS_HOME>/usage.json` | The subscription's windows (5-hour, 7-day: utilization and reset time) from the latest `rate_limit_event` (Codex: `account/rateLimits`) of any session. Every session's turns count toward usage, workers', orchestrators' and thinking partners' alike (one subscription), so the usage display and the usage pause see them all |
| `<NEXUS_HOME>/turns.jsonl` | One line per agent turn of every project and role, appended by the server (AgentHost, its one writer) when the turn ends, or when its process ends first: `v`, `at` (the end), `started_at` (the runtime's turn start, or the first thing it streamed after the previous turn's end), `duration_ms`, `project`, `session`, `role` (`worker`, `orchestrator`, `conversation`), `runtime`, `model`, `effort`, `queue` and `step` (a worker's run, when any), `outcome` (`ok`; a failure's kind `passing`, `lasting` or `usage`, with `failure`, the runtime's code; `interrupted`: no result, because Nexus interrupted the turn or its process ended: a kill, an update's drain, a crash), `tokens` (the turn's own: `input` not from the cache, `output`, `cache_read`, `cache_creation`), `cost_usd` (the turn's own, where the runtime reports cost and it is known: Claude Code, not the first turn of a resumed process), `windows_start` and `windows_end` (the turn's runtime's usage windows, `utilization` and `resets_at`, as the server knew them when the turn began and ended; left out when none was known). In one file because the windows are the account's, across projects; statistics are computed from it when read |
| `<NEXUS_HOME>/away.yaml` | The user's away mode: `current` (`since`, `until`) while on, `past` periods (`since`, `until`, `ended`, `why`: `expired` or `off`). One writer: the server, on `POST /api/server/away` and when a period's time comes. See "Away mode" under "Review" |
| `<NEXUS_HOME>/limits.json` | `{ max_running: number }`: how many queues may run at once across all projects, a whole number from 1 to 20 (default `2` when the file or the value is missing). One writer: the server, on `POST /api/server/settings` from the dashboard |
| `<NEXUS_HOME>/deploy.json` | `{ push_on_deploy: boolean }` (default `true` when the file is missing). One writer: the server, on `POST /api/server/settings` from the dashboard |
| `<NEXUS_HOME>/deploy-changes.jsonl` | One line per successful deploy with changes for agents: `key` (`deploy-changes:<new sha>`), `at`, `from`, `to` (full shas), `changes` (`commit`, `text`: the commits' `Agents:` lines, oldest first). One writer: the server that took over (a successor, once per deploy) |

A session launched by Nexus has `launched_by: nexus`, `runtime: claude`, `native_id` (Claude's session UUID, chosen
by Nexus) and the `model` it was started with. A queue may also say `worktree: auto`: Nexus then creates the worktree
and branch when it starts the queue and writes their paths back into `queue.yaml`.

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
  or handed to the user; key `notify:awaywait:<queue>:<step>:<time>`): the approved queues of the project that can
  start (or resume) now by the one-queue-per-checkout rule and the limit (`Engine.startable`), or that none can.

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
…/queues/:q`) is not pinned either.

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

For a finished queue (`done`) with a worktree of its own, the user, and only the user, can merge its branch back and
clean up: two separate actions in the dashboard, each confirmed first, carried out by the server with local git
(`apps/server/src/mergeback.ts`). There is no CLI command or event for either, and the HTTP writes take only the
dashboard's own requests, so neither the orchestrator nor a worker can trigger them.

- **The base** is recorded when Nexus makes an auto worktree: `git.yaml` `base.ref` (the queue's `base`, else the
  branch the project's checkout was on) and whether it is a branch.
- **Merge** runs in the worktree where the base branch is checked out: `git merge --no-edit <branch>`, a fast-forward
  when possible, else a merge commit. Refused when the base is checked out nowhere (or only detached), when that
  worktree has uncommitted changes to tracked files, when a run is going there, or when it is this server's own live
  worktree. On a conflict the merge is aborted (`git merge --abort`) and the refusal names the conflicting files;
  nothing is left half-done. A branch already in the base is reported as such. Nothing is pushed.
- **Cleanup** checks first, and removes nothing when refused: the worktree must have no uncommitted changes
  (untracked files included), and the branch must be merged (into its upstream if it has one, else into the base's
  checkout, as `git branch -d` decides). Then `git worktree remove` (never `--force`) and `git branch -d` (never `-D`).
- Both are recorded in `git.yaml` (`merged`, `cleaned`) and shown on the queue.

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
`answer-<event id>`. It routes send-backs the same way (`send_back`, see "Sending a step back"). The session records
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
continues: 01JD...                     # context care: the session this one took over from
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
nexus check W3 core-tests --ok --summary "548 passed"
nexus step done W3 --summary "No floating body on any fixture" [--commit 1a2b3c]   # warns at an unclean end
nexus step failed W3 --reason "..."
nexus stop W3 --condition "user decision" --reason "..."   # the condition as the queue words it; the reason short (shown first)
nexus ask "Canyon joints: vertical only, or also inclined?" [--option ...] [--recommend <option>] [--can-continue]
                                               # --recommend: one of the --option values, by text or number (1 = first)
nexus context --topics rock,support --files Runtime/Core/Rock/* <<< "summary text"
nexus report W --file <temp>/nexus-reports/<project>/W.md --summary "..."   # copied to .nexus/queues/W/report.md
nexus propose-change W --file patch.yaml --reason "..."
# orchestrator only
nexus queue draft --file queue.yaml
nexus answer <qid> "..." [--escalate [--recommend <option>]] [--continue|--wait]
                                               # --recommend only with --escalate: one of the question's options
nexus session start|resume|fork|pause|stop ...
nexus attach                                   # register a hand-started session as external
# setup (the user)
nexus project add <path> [--id] [--name]       # creates .nexus/ (self-ignoring), registers the project, prints the rules files' check
nexus import <file.md> [--prefix X]            # one-time import of queues written as Markdown tables
nexus note <queue> <step> <text>               # until the dashboard can add notes
nexus server away [on --until <8:00|ISO> | off]  # the user's away mode (refused from any agent session); no argument: its state
```

`nexus status` prints each step of a queue on a line of its own (id, status, title); a step that names its own
runtime, model or effort ends with them, `[on Codex · gpt-6-luna · low effort]` (what it leaves out is the run's).
The orchestrator's overview adds the same after the step in its `steps:` line, where each step also shows its review
level, `W1 pending (level 2)`, with `, set by the user` for a level the user set.
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
Checks: ...
Review to prepare: <review.prepare>               # only with one, followed by the pointer to `nexus help review`
Stop conditions: <project defaults> + <queue's own>
Notes for this step (2): ...
Answers to your earlier questions: ...
Report with `nexus`. End the step with `nexus step done`, `nexus step failed` or `nexus stop`.
```

The template is a project setting, so each project can phrase it in its own terms.

## Server API

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
writes files. The only exceptions are `POST /api/server/update`, `POST /api/server/cancel` and `POST
/api/server/away`, which `nexus server` sends (see the CLI; it refuses `away` from every agent session).

| Request | Body | Effect |
|---|---|---|
| `POST /api/projects/:id/queues/:q/steps/:s/notes` | `text` | A note from the user for the step |
| `DELETE /api/projects/:id/queues/:q/steps/:s/notes/:note` | | Withdraws a note not yet delivered |
| `POST /api/projects/:id/sessions/:session/messages` | `text`, `queue?`, `step?` | A message to a session's inbox |
| `POST /api/projects/:id/queues/:q/approve` | `words?`, `work?` (`keep` or `discard`) | Approves the current revision; for a stopped queue it also lifts the stop (see `queue.yaml`). `work` is required when the stopped step left commits of its own and no Discard is recorded; with `discard` nothing is approved (see "The work a stopped step left") |
| `POST /api/projects/:id/queues/:q/withdraw` | `reason?` | The user takes back the approval of a queue that never ran. There is no CLI command and no event for it |
| `PATCH /api/projects/:id/queues/:q` | `review_level` (1, 2, 3 or null: the project's) | Queue settings; not pinned by an approval |
| `PUT /api/projects/:id/queues/:q/steps/:s/level` | `level` (1, 2, 3 or null: the step's drafted level) | The user's review level of a step (`user_levels`); asks for no new approval, and later revisions keep it |
| `POST /api/projects/:id/questions/:qid/answer` | `text`, `continue?` | The user's answer, routed to the asker |
| `POST /api/projects/:id/queues/:q/run` | `action` (`start`, `pause`, `resume`, `stop`, `cancel_start`), `runtime?`, `model?`, `effort?`, `session?`, `after?`, `at?` | Runs the queue through a Nexus-launched session (`session` continues an existing one). `start` with `after`: a chain, the queue starts when that one is done (`{message}`); with `at` (ISO 8601, or `usage-reset`): a schedule (`{message}`); `cancel_start` cancels the planned start (`{message}`) |
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
| `POST /api/projects/:id/queues/:q/continue` | `work?` (`keep` or `discard`) | Continue: lifts the stop of a stopped queue whose current revision is approved and goes on (see "Continue" under `queue.yaml`); refused (409) otherwise. `work` is required when the stopped step left commits of its own; `discard` records it and does not go on |
| `GET /api/projects/:id/queues/:q/left` | | What a stopped queue's stopped step left (see "The work a stopped step left"); null when not stopped at a step |
| `GET /api/projects/:id/sessions/:session/chat` | query `from`, `to` (lines) | A chat's entries with lines from `from` up to, not including, `to`: `{ chat: [entry + line] }`; what is older than a chat view's window. Only the orchestrator's or a conversation's session (404 otherwise) |
| `GET /api/projects/:id/sessions/:session/chat/search` | query `q`, `tools` (`1`: tool lines too) | Search over the whole chat.jsonl, not only a view's window: `{ lines }`, the lines of the entries that contain `q`, oldest first; case and accents ignored, the query's spaces collapsed (`searchChat` in `@nexus/protocol/chat`) |
| `POST /api/projects/:id/sessions/:session/pins` | `line`, `pinned` (true or false) | Pins or unpins a message of the orchestrator's or a conversation's chat (sessions/<id>/pins.json); answers `{ ok, result: { pins } }`. Refused (400): a line that holds no entry or a tool line (when pinning), a line that is not a whole number |
| `POST /api/projects/:id/orchestrator/messages` | `text` | A chat message to the orchestrator (starts or wakes it) |
| `POST /api/projects/:id/orchestrator/reset` | | The next message starts a new orchestrator session |
| `POST /api/projects/:id/orchestrator/stop` | | Stops the orchestrator's running turn (see "Stopping a chat agent's turn" under "The orchestrator"); refused (409) when it is not in a turn |
| `POST /api/projects/:id/orchestrator/settings` | `model`, `effort` (empty: the default) | The orchestrator's model and effort, from its next message on |
| `PATCH /api/projects/:id/settings` | `name`, `runtimes`, `defaults`, `conversations`, `languages` (`reader`, `working`), `orchestrator` (`notify`, `model`, `effort`) (an empty value clears a field), `own?`, `follow?` (lists of setting keys, `runtimes.claude.model`) | Project settings, checked against the schema (see "Global settings"): a setting given another value, or named in `own`, becomes the project's own (in `own` also when it equals the global value); one named in `follow` follows the global value again; naming one in both is refused |
| `GET /api/projects/:id/settings` | | `own` (the keys of the settings the project has its own value of) and `global` (the global settings) |
| `GET /api/settings`, `PATCH /api/settings` | the global settings, nested as in `settings.yaml` (null or empty clears an optional one) | The global settings (`global`; GET also `keys`, every setting with a global value). PATCH writes `<NEXUS_HOME>/settings.yaml`, checked against the schema; every project that follows a changed value has it at once |
| `POST /api/projects/:id/uploads` | `data` (the picture, base64, optionally as a `data:` URL) | Saves a picture for a chat message under `.nexus/uploads/` and answers `{ ok, result: { path, type, bytes } }`: `path` absolute (forward slashes), `type` `png`, `jpeg`, `webp` or `gif`. See "Uploads" below |
| `POST /api/projects/:id/settings/allow-rule` | `rule` | Adds an allow rule for Claude Code workers to `runtimes.claude.allowed_tools` in `.nexus/project.yaml` (once; a rule already there is left as it is), typically from a refusal. A tool name, optionally with a specifier in parentheses, on one line. Like every write, only from the dashboard's own page: an agent must not widen its own permissions. Nothing else is written, not the project's `.claude/settings.json` or `AGENTS.md` |

Also `GET /api/projects/:id/sessions/:session/activity?queue=&step=&limit=`, `GET /api/projects/:id/refusals?queue=&step=`
(the refused actions of every session of the project, oldest first; optionally only a queue's or a step's), `GET /api/projects/:id/orchestrator`
(its session, state, chat: the newest 300 entries, each with its `line`, and `pins`: each pin's `line`, `at` and `entry`,
wherever in the chat it is; a fresh session has none), `GET /api/digest?since=` (below), `GET /api/usage` and `GET /api/models/:runtime`: the models a runtime offers, asked from the runtime itself
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
successor, `up` (`commit`, `subject`, `previous?`). It also gives `push_on_deploy`, `max_running` (the limit on queues
running at once), `away` (the away mode now: `on`, `since?`, `until?`) and `running`: the steps running
now, per project (`project`, `name`, `steps`: `queue`, `step`, `title`, `session`, `run`), which `nexus server status`
prints. `POST /api/server/update` (`now?`, `ref?`, `by?`) and `POST /api/server/cancel` start and cancel an update.
`by` is sent by `nexus server update` run in an orchestrator session (from `NEXUS_SESSION` and its project); the
server keeps it only for an orchestrator session of a registered project. The dashboard sends none. `POST
/api/server/away` (`until`: a local time "8:00", an ISO 8601 time, or null for off; it answers `away`) switches the
user's away mode; like update and cancel it is taken from `nexus server away` without an `Origin`, and the CLI refuses
it from every agent session. `POST /api/server/settings` (`push_on_deploy?`: boolean, `max_running?`: a whole number
from 1 to 20; at least one of them; it answers both values) is the
user's only: like withdrawing an approval, it is refused without the dashboard page's own `Origin`. A server waiting
to take over answers every `/api/projects…` request, and every write under `/api/server/`, with 503.

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

## Conversations

`project.yaml` holds `conversations: { notes_dir?, runtime, model?, effort? }`. A conversation is a session with
role `conversation`: a thinking partner the user talks with about the project, one session per topic, with its chat
in `chat.jsonl` (`from: partner` for its replies, whole). It reads the whole project and writes only in `notes_dir`
(relative to the root, checked to lie inside it): Claude Code runs it in `dontAsk` mode allowed `Read`, `Grep`,
`Glob`, `Bash(nexus status:*)`, read-only git and `Edit(<notes_dir>/**)` only; Codex runs it with `notes_dir` as its
working directory in a `workspace-write` sandbox (`read-only` without a notes folder), approval `never`. It starts no
work. An idle partner's process ends after 15 minutes; the next message resumes the conversation.

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

`project.yaml` holds `orchestrator: { runtime, session, model?, notify }`. The orchestrator is a Claude Code session
launched in the project's checkout with `--permission-mode dontAsk`, allowed only `Read`, `Grep`, `Glob`, `Agent`,
`Bash(nexus:*)`, read-only git commands, and `Write(.nexus/drafts/**)` and `Edit(.nexus/drafts/**)`, and with
`NotebookEdit` and `MultiEdit` disallowed: anything else, writes outside `.nexus/drafts/` included, is refused without
a prompt. (`Write` and `Edit` are not disallowed: a disallow rule would beat the drafts rules.) Its briefing
(appended system prompt) explains its role, the commands and the queue YAML.

- `.nexus/drafts/<queue>.yaml` holds the orchestrator's queue drafts; the orchestrator is its only writer. It writes a
  draft there, uploads it with `nexus queue draft .nexus/drafts/<queue>.yaml` (relative to the project's root, its
  working directory), and keeps the file to edit for later revisions. The server reads only the path it is given.
  The briefing tells it to run `nexus` commands on their own: a chained command (`cd …`, `&&`, a pipe) does not match
  `Bash(nexus:*)` and is refused.

- `nexus queue draft <file|->` sends a queue definition (YAML) as `queue.drafted`. The server writes it: a new queue
  becomes `proposed` (or `draft`); a change to an existing queue's steps, checks or stop conditions makes a new
  revision, which needs the user's approval again. A revision changes only what has not started (see "A revision
  changes only what has not started" under `queue.yaml`); a refused draft prints the reason.
- `nexus run <queue> start|pause|resume|stop --reason … [--use-session <id>] [--runtime claude|codex] [--model <m>] [--effort <e>] [--after <queue> | --at <time>]`
  sends `session.request`; `start --after A` plans the start for when queue A is done (a chain); `start --at
  "YYYY-MM-DD HH:MM"` (this machine's local time; sent as ISO 8601 in `start_at`) or `--at usage-reset` plans it for
  a time (a schedule); `nexus run <queue> cancel-start --reason …` cancels either.
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

## Chains

"When queue A is done, start B": a planned start, `queues/B/start.yaml`, set by the user in the dashboard (the start
form's "When") or by the orchestrator (`nexus run B start --after A`), with the options of a start (runtime, model,
effort, a session to continue). One per queue: a new plan replaces the old one. Refused: a queue after itself, a
loop through other plans, an unknown or cancelled A, a B that is done, cancelled or running, an effort the runtime does
not take, a session that is not a worker session Nexus launched. B need not be approved yet.

- It fires when A is done (every step done or skipped; its run finished). If A already is, B starts at once.
- If A's run halts, pauses or waits for the approval of A's new revision, or A is stopped or cancelled, the plan
  waits; the dashboard shows why (`waiting`, `blocked` in the state).
- At the moment it fires, B starts as a start does: its current revision must be approved, and it must not be stopped
  or have a rejected step. If it cannot start, the plan stays with `failed` and the user gets an attention item of kind
  `start` ("Did not start after A: …"); it is not tried again by itself. Starting B or cancelling the plan ends it.
- A plan that continues a session waits while that session runs another queue, and fires when it is free (A's own
  session is free once A's run is finished): one session never runs two queues.
- Nothing fires while an update drains: the plans stay in their files, and the next server (or a cancelled update)
  looks at them once it is up. The server looks at the plans after every change to the project's files and 1.5 s
  after it starts.
- When A is done but B's checkout is held by another queue, or as many queues run as the limit allows, B waits and
  starts by itself once it may (see "One queue per checkout, and a limit"); `waiting` then says why, e.g. "queue A is
  done; waits for the checkout: queue C runs there". Two queues chained after the same A in one checkout so run one
  after the other, the plan made first first.
- The run B gets records `after: A`. The dashboard shows the plan on B (with Cancel) and on A ("When this queue is
  done, B starts"), and a chip on B's row.

## Schedules

"Start B at night", "start B when the usage window resets": a planned start with `at`, in the same
`queues/B/start.yaml` (one plan per queue, chain or schedule), set from the dashboard's start form ("When": at a time,
or when the usage window resets) or with `nexus run B start --at …`.

- `--at usage-reset` takes the reset time from the latest usage data (`<NEXUS_HOME>/usage.json`) of the runtime the
  start would run on (the session's to continue, else the start's runtime, else the project's default): Claude Code's
  5-hour window; for Codex, of its windows not yet reset, the last to reset among those at or above the pause
  threshold, else the first to reset. The plan's `at` is that time plus the usage margin (60 s), and `usage` names the
  runtime. Without usage data of that runtime the request is refused. A time in the past (more than a minute) is
  refused.
- At its time the queue starts as a start does. If it cannot (its current revision not approved, stopped, …) or its
  session to continue runs another queue (a schedule does not wait), the plan stays with `failed` and the user gets an
  item of kind `start` ("Did not start at 22:00: …").
- More than 15 minutes late (the server was not running at the time; it looks at the plans 1.5 s after it starts), the
  queue does not start: `failed` with `missed: true`, an item for the user, and the orchestrator is told once. Less late,
  it starts.
- At its time, a queue whose checkout is held by another queue, or that would pass the limit on queues running at
  once, waits (`held`) and starts by itself once it may; a waiting schedule is never missed, however long it waits.

## One queue per checkout, and a limit

Queues run side by side only in worktrees of their own, never two in one checkout, and no more at once than a limit.

- A queue's checkout is its worktree (`worktree`: a path; with `auto`, the folder Nexus creates for it, under
  `defaults.worktree_dir`), else the project's own checkout (`root`). Paths are compared without regard to case or
  the kind of slash.
- A checkout is held by a queue whose run is `running` (also with a step waiting for a review or an answer),
  `pausing`, `paused`, `usage_wait`, `retry_wait` or `approval_wait`: it will go on there. A halted or finished run
  holds none.
- The limit (`max_running` in `<NEXUS_HOME>/limits.json`, default 2) counts the queues whose run is `running` or
  `pausing` across all projects, except a queue waiting for a review or an answer (its status `waiting`). Runs
  waiting for the usage window, a retry or an approval do not count.
- A start from the dashboard or the CLI (`nexus run Q start`, also a Continue that starts afresh) is refused with
  409 and the reason: "queue B cannot start: its checkout is in use, queue A runs there" ("… queue A is paused there";
  "… queue A of <project> runs there" for another project's queue), or "queue B cannot start: 2 queues run, the limit
  is 2".
- Resuming a halted run, continuing a stopped queue whose run halted and accepting a review of a step whose run halted
  check the checkout the same way ("cannot go on", "cannot continue"); the limit does not apply to them. A paused or
  waiting run already holds its checkout and goes on as before.
- A planned start (a chain or a schedule) that came due but may not start waits instead: its `start.yaml` gets
  `held` (`since`, `kind`: `checkout` or `limit`, `reason`: "waits for the checkout: queue A runs there", "waits: 2
  queues run, the limit is 2"), shown in the plan's `waiting`. It starts by itself once it may; a held schedule is
  never missed. A plan that is no longer due (A opened again) loses `held`.
- The server has one coordinator over all projects' engines. It looks at the planned starts of every project after
  any change to a project's files, after a run stops going (finished, halted, paused, waiting) and after the limit
  changes. It takes the due plans of all projects in the order they were made (`created_at`) and looks again after
  each start, so one pass never starts two queues into one checkout or past the limit.
- Runs that were going before this rule came are left alone.
- The engine's long timers (schedules, usage waits, retries) are armed in pieces of at most a day, each looking at the
  clock again, so a time weeks ahead neither fires at once (Node's `setTimeout` does beyond 2^31-1 ms) nor early. A
  restart arms them again from the files; nothing fires while an update drains.
- The dashboard shows the plan with its time and how long until it, and a chip "starts at 22:00" on the row; Cancel
  ends it.

## Runtime, model and effort per step

A run records its own runtime, model and effort when it starts (`run.yaml`). Those its start chose (or took from the
session it continues) stay for the whole run. Those it took from the project's defaults are listed in `from_defaults`
and resolved again from the project's effective settings (its own values, else the global ones) when each step opens,
so a changed default reaches a running queue at its next step. A model or effort chosen at the start belongs to the
runtime the run started on: when a runtime taken from the defaults resolves to another one, that runtime's defaults
apply. The values are checked when the step opens: an effort the resolved runtime does not take halts the run, naming
the step and the reason (`step Q2: Claude Code takes effort …`). A step runs on its own values where it names them and
on the run's where it does not, never on the previous step's. A step on another runtime than the run's
takes a model or effort it does not name from the project's defaults for that runtime (`runtimes.<runtime>`): the
run's model belongs to the run's runtime.

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
runtime is made the same way.

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

## How the engine runs a Codex session

`codex app-server` over stdio: JSON-RPC requests and notifications, one JSON object per line, no `jsonrpc` field.
After `initialize` (with `experimentalApi`) and `initialized`, `thread/start` (or `thread/resume` with the stored
thread id) with the working directory, model, sandbox mode, approval policy (`never`: Nexus runs unattended; any
approval request that still comes is declined) and the worker briefing as `developerInstructions`. The thread id
becomes the session's `native_id`.

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
<uuid>` for a session that ran before), with the project's permission mode, `--allowedTools Bash(nexus:*)` plus the
project's list, the model, and a worker briefing as `--append-system-prompt`. With `defaults.protect_nexus` on (the
default), `--disallowedTools Edit(//<.nexus>/**),Write(//<.nexus>/**)` names the project's `.nexus` by its absolute
path in Claude Code's rule form (`//` and forward slashes, the Windows drive letter as the first segment:
`C:\Code\P\.nexus` is `//c/Code/P/.nexus`), so it holds from a worktree too; deny rules win over the allow list. The
nexus CLI, which writes the worker's events there, is a process, not a file tool, and keeps working. Orchestrators
and thinking partners keep their own rules. Codex workers are not restricted (see DESIGN.md). Environment: `NEXUS_SESSION`,
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
