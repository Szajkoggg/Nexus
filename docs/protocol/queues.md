# Queues

Part of [the protocol](../PROTOCOL.md).

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
integration: true                      # written only by the server: the queue works in a worktree of its own, so it ends with the integration step (below; a survey run has none)
source:                                # optional: where it came from (see "Where a queue came from" below)
  - docs/ideas/queue-plan-view.md#2026-11-15   # a note reference: a thinking partner's dated Decided entry; pinned by the approval
  - { path: QUEUE.md, imported_at: 2026-11-12T00:00:00Z }   # written by nexus import: the file it was read from; not pinned
user_levels: { W3: 1 }                 # levels the user set on steps; written only by the server (see "Review")
legacy_policies: { W1: continue }      # each step's review policy from before review levels; written only by the server
stop_conditions:                       # in addition to the project defaults
  - The climb probe finds a way up a wall of two levels or more that two attempts within the step do not remove.
checks:                                # run for every step
  - npm test                         # a command only (see "Checks run by Nexus"); a check in words is refused
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
    # continued_in: [FL4, FL5]         # a skip's mark: where the step's work went on (steps, QX/QX2, queues; see below)
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
(see ["Runtime, model and effort per step"](runtimes.md#runtime-model-and-effort-per-step)). A draft is refused when a step names Claude Code with an effort it does
not take (`ultra`); an effort without a runtime is checked when a run starts.

**A revision changes only what has not started.** A draft may add, change, remove or reorder pending steps (a skipped
step that never ran counts as pending here). A *started* step is one that has segments (it has been at work) or whose
status is neither `pending` nor `skipped`, an imported `done` included. A draft is refused when it changes a started
step's `title`, `goal`, `acceptance`, `review`, `runtime`, `model`, `effort`, `fallback` or inherited tags, drops it (keep it and skip it), or
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
  answers `{ step, commits, uncommitted: [{ status, path }], uncommitted_note, stopped_at, discarded }` (`stopped_at`:
  when the stop it was read for came, its `queue.stop`; `discarded`: the Discard recorded for this stop, or null), or
  null when the queue is not stopped at a step.
- When the step left commits of its own, the lift takes a choice, `work: keep | discard` in the body of `continue` and
  `approve`; without it they are refused (409, naming the step and the number of commits). With none nothing is asked.
  What the lift itself would refuse (a run still going; Continue on an unapproved revision; approving an approved
  one) is refused first, so no choice is recorded for a lift that does not happen. The step's work is read (git)
  before the lift checks and records anything; a queue stopped at another step by the time it decides is refused (409,
  "now stopped at another step; try again"), and so is one stopped again at the same step since the read (409,
  "stopped again since its work was read; try again", queue LH), with nothing recorded.
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
| `--step S skipped --continued-in R,…` | as above; or S is `skipped` already (also in a done or cancelled queue): then only the mark is set. Each reference names a step of the queue (`FL4`), a step of another queue (`QX/QX2`) or a queue (`QX`) of the project, any status, and not S | as above, with `continued_in` (the references, trimmed, without repeats); from `skipped` to `skipped` for the mark alone. S's view carries `continued` (`in`, `at`, `by`, `reason`) from its latest such entry while it stays skipped (docs/design/continued.md) |
| `finished` | the queue's run is `halted` and every step is done or skipped (the closing refactoring step too) | `kind: run`, `from: halted`, `to: finished`; the server also writes `run.yaml` `finished` |
| `cancelled` | the queue is not done or cancelled and its run is not `running`, `pausing`, `usage_wait` or `retry_wait` | `kind: status`, `from` (the queue's status), `to: cancelled`: the queue is `cancelled` with the reason; a later stop leaves it so. The user gets a push notification; nothing goes into the waiting list |
| `propose-lift` | the queue is `stopped` | `kind: proposal`, `from: stopped`, `to: lift proposed`: the queue's view carries `lift_proposal` (`at`, `reason`) until a lift, a later `queue.stop` or a later approval |

Refused, with the reason: `done` (a step whose own work is done while the rest goes on elsewhere, or whose work another
step or queue did, is skipped with `--continued-in` naming where), `--continued-in` with any status but `skipped`, approving, lifting
a stop (`lift`, `approved`, `running` or `pending` for a queue), reopening a finished step (`pending`, `running`),
skipping a step at work, and any other status. The engine reads a step's status again before it opens a step, so
skipping a pending step of a running queue takes effect: the step is never opened. A cancelled queue is neither
started nor resumed.

**Where a queue came from** (`source`, decided by the user 2026-11-15, queue IO; docs/ux/ideas-overview.md). A list:
note references, set by the orchestrator in a draft, and the record of the Markdown file `nexus import` read the queue
from. An older file's single `{ path, imported_at }` reads as a list of one. A note reference is
`<notes folder>/<file>.md#<YYYY-MM-DD>`: a note in the project's `conversations.notes_dir` (subfolders allowed, the
README is not a note) and the date of one of its Decided entries; every Decided heading of that date in the note is the
one entry it names (`2026-11-15` and `2026-11-15 (later): …` alike). A queue may name several entries, and an entry may
be named by several queues. A draft that brings a new reference is refused, with the reason, when it is not one, when
the project has no notes folder, when the file is outside the folder or missing, or when the note has no entry of that
date (the refusal lists its dates); a reference the queue already had is not checked again. Left out of a revision's
draft, the source stays; given, its note references replace the queue's, and the import record stays. The note
references are part of what an approval pins, in their order, only when there are any: the hash of a queue without
them (an imported one included) is the one it had before the list, and a revision that changes them needs the user's
approval again.

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
- **It is the last step** (in a queue with a worktree of its own, the last before the integration step), so its
  opening asks for the queue's report (see ["The step turn"](sessions.md#the-step-turn)), the queue is `done` and the run `finished` only after it, and the orchestrator's notices that speak of a queue's last step mean it.
- **A fresh session with the queue's commit range.** When it is next and the run's session has worked before (any
  event of its own), the engine goes on in a fresh session the way context care does (see ["Context care"](runtimes.md#context-care)), with
  `switches[].why: refactor`, no summary asked for, and a seed that gives the queue's description and its steps'
  summaries. Its opening names the queue's work as a commit range, from the first `start` of a round of the queue's
  own steps in `git.yaml` to the last `end` (the closing step's own rounds left out), with `git diff --stat` of it (at
  most 60 files and the summary line); the diff itself is not in the text, the worker reads it with git. Without git
  records it says so.
