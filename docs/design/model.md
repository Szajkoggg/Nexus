# The derived model (queue SM)

Status: **the plan** (SM1, 2026-11-20), built in SM3 and SM4. It follows the user's decision of 2026-11-18 on the
server's responsiveness (the user's notes, "Server responsiveness: one read layer over the files"): no change of tech
stack; one read layer; every appended line read once; nothing long on the event loop; the model can be thrown away and
built again from the files, which stay the one source of truth (the model lives in memory only). It builds on what the
measurement of queue SV found ([performance.md](performance.md#the-first-measurement-2026-11-20)).

No file format changes. Everything below reads the files as they are; the stop condition of the queue (a format change
only when the model cannot be built without one) is not met.

## What the model is

One model per project, in the server's process, made when the project is loaded and dropped with it. It has two
layers:

- **The file layer**: each file a reader uses, parsed once, with what is needed to go on reading it. A JSONL log keeps
  its entries (or an index of them, below) and the byte position up to which it was read; a YAML or JSON file its
  parsed value and the stat it was read at; a folder the list of its entries. It answers what `ProjectStore`'s read
  methods answer today, from memory.
- **The derived layer**: the project's state (`ProjectState`, by today's `loadProjectState` rules, unchanged),
  derived from the file layer when it is asked for and something it depends on has changed since, and the indexes the
  readers of logs need (a chat's lines, a session's activity by queue and step, the refusals, the turns).

One server-wide part beside the projects' models holds what lies in `NEXUS_HOME`: `turns.jsonl` (the statistics,
estimates, usage days, the digest's usage line), `settings.yaml` and `away.yaml` (inputs of every project's state).

Every reader in the server asks the model: the routes, the decisions on a change (engine, orchestrator, merger, the
deploy plan, the routing of answers and send-backs, the idea reconciliation), the engine's actions, the coordinator,
the conversations. None reads the history itself. The CLI is a separate process and reads the files as before (agents
never call the server); so does the hand-over check of a server taking over (one read of each project before it is
loaded).

## What it holds

| Part | From | Fed by | Kept |
|---|---|---|---|
| Queues | `queues/<id>/queue.yaml`, `run.yaml`, `git.yaml`, `push.yaml`, `checks.yaml`, `start.yaml`, `plan.yaml`, `notes/<step>/*.md` | whole file again on its change | parsed |
| Sessions | `sessions/<id>/session.yaml`, `runtime.json` | whole file again on its change | parsed |
| Events | `sessions/<id>/events.jsonl` | appended lines | every entry (the state's fold needs them all) |
| Inboxes and deliveries | `inbox.jsonl`, `delivered.jsonl` | appended lines | every entry |
| What the orchestrator was told | `applied.jsonl` | appended lines | every entry (small; its decisions read the `event` keys) |
| Questions, steps, runs, attention, the plan, the merge train | derived from the above | derived again when asked after a change of a state input | the `ProjectState` |
| Chats | `chat.jsonl`, `pins.json` | appended lines | an index per line (byte offset, kind, from, at, `message_id`); the last 400 entries; older ones read by byte range when asked |
| Activity | `activity.jsonl` | appended lines | an index per line (byte offset, queue, step, kind, at); the last 300 entries per session; the `retry` entries (the digest's) |
| Refusals | `refusals.jsonl` | appended lines | every entry (few) and the set of `ref`s |
| Project files | `project.yaml`, `tags.yaml`, `metrics.yaml`, `recurring/*.yaml`, `idea-*.yaml`, `static-analysis.yaml` | whole file again on its change | parsed |
| Ideas | the notes folder (`conversations.notes_dir`, outside `.nexus`), `idea-*.yaml`, the `ideas.covered` events | whole note file again on its change | parsed notes |
| Templates | the shipped, global and project template folders (read by `recurringOf` on every rebuild today) | whole file again on its change | parsed |
| Turns (server-wide) | `NEXUS_HOME/turns.jsonl` | appended lines | every entry |
| Settings, away (server-wide) | `NEXUS_HOME/settings.yaml`, `away.yaml` | whole file again on its change | parsed |
| Statistics | derived from the states and the turns | when asked, from memory | nothing of its own |

What a closed queue keeps at hand (the decision's archiving): its files' parsed values and its events stay (the state
is a fold over all events, and lists and statistics need its steps, dates, costs and summaries); its detailed logs
(activity, chat beyond the last entries) are an index only, and read from the file when opened. The model's size grows
with the events and the indexes, not with the logs' text.

## How the watcher feeds it

The project's watcher (chokidar on `.nexus`, as today) passes each event's path and kind to the model instead of only
calling `changed()`. The server's own writes reach it at once, before the write returns: the store's write helpers
(`writeYaml`, `appendJsonl`, `renameRetrying`, the unlinks) report the path they wrote to the model of that store
(**write-through**), so a decision that writes and the next one that reads see the write, as they do today through
`writeCount`. The watcher's event for the same write comes later and finds nothing new (a stat).

- **A JSONL log**: the model keeps the byte position of the end of the last complete line it read. On a change it
  reads from that position to the end of the file in one read, takes the complete lines (a final line without a
  newline is being written: it is left for the next change, as `readJsonl` leaves it today), parses each once, adds
  them to its part and moves the position past the last newline. A line's number is its index in the file counted from
  0 with blank and broken lines, as today: the model counts the newlines it passes, never the entries (chat lines and
  pins are addressed so). A broken line becomes the same warning text, with the same line number, as today.
- **The clock** (docs/design/state.md, "Clock steps"): a log whose reads are `observed` today (events, inbox, applied)
  has each new line's time observed once, as it is read. A time too far ahead to be taken up now (`observe` ignores
  one beyond `CLOCK_AHEAD_MS`) is kept and offered again at each derivation until it is taken up or falls behind the
  mark: a whole read today offers it again on every rebuild.
- **A YAML or JSON file** is replaced whole (an atomic rename by its one writer): on a change it is read and parsed
  again, whole; the model keeps its stat (size, modification time, file id). One that is gone is kept as missing, so
  the 15 s of `existsSync` the start's profile showed become a lookup.
- **A folder** (`queues/`, `sessions/`, a queue's `notes/<step>/`, `recurring/`): its list is kept and changed by the
  watcher's add and unlink events (and by the server's own writes).
- **What is ignored stays ignored**: uploads, `clock.json`, `*.tmp`, `*.lock`, as today; review files and check logs
  are read by their routes when asked, not kept.

Each change is then sorted by what it changes:

- **A state input** (every file of the state: the YAML files, `runtime.json`, events, inbox, deliveries, applied, the
  notes, the settings): the model's **version** moves. The state is derived again the next time it is asked for, and
  `changed()` runs the decisions and tells the dashboards, as today.
- **A log only** (`activity.jsonl`, `chat.jsonl`, `refusals.jsonl`, `pins.json`): the line goes into its index, the
  version does not move, no decision runs, and the dashboards get a `log` message naming the project and session (and
  the log), so only the reads of that session's activity or chat are asked again. No decision reads these files (the
  list below); the step that brings it (SM3) proves it with the fake runtimes.

## Being as current as a read of the files

Today a decision's own `loadProjectState` reads every file as it is at that moment, also a line an agent's `nexus`
has just appended and the watcher has not reported yet. The model sees another process's write when the watcher
reports it. Two rules keep the decisions' results as they are:

- **Files only this server writes are always current** (write-through): every YAML file of a queue, `runtime.json`,
  inbox, deliveries, applied, activity, chat, refusals, turns. Another process writes only an agent's own
  `events.jsonl`, the review files, and by hand the user's CLI (`nexus queue import`, `nexus note`, a session file,
  the registry).
- **Before a decision reads, the model syncs the logs other processes append to now**: the `events.jsonl` of every
  session with a live process in this server's hosts (workers, orchestrator, partners, helpers), and of a session whose
  process ended since the watcher last reported it. A sync is a stat per file and a read of what grew: a handful of
  stats, under a millisecond. So the engine at a turn's end sees the worker's `step.done` written just before it, as
  today. What a person's CLI writes by hand (an import, a note, an external session's events) is seen at its watcher
  event, as it is for today's snapshot between decisions ("The cost of rebuilding state" in state.md: a write by another process is seen at the next change
  notification).

`Engine.writeRun`'s read of the session's log before stamping a run's end (to take up its times) becomes this sync of
that session's log.

## When a file contradicts its position

A log is append-only by the protocol, but a person may edit one, a tool may truncate it, a backup may restore an older
copy. The model reads a log's tail from 64 bytes before its position (in the same read) and compares those bytes with
what it read there before; it also compares the file id. The file **contradicts** its position when it is shorter than
the position, the 64 bytes differ, or the id changed. Then that file alone is read again from its start, its part
replaced, the version moved; the event is counted (`model resets` in `perf`) and logged with the file's path. Nothing
else is read again: the state is derived from memory anyway.

A YAML or JSON file rewritten is the ordinary case, not a contradiction: it is parsed again whole. A file whose stat
did not change while the watcher reported a change is parsed again all the same (a write within the modification
time's resolution).

## Derivation

The state is derived by today's code: `loadProjectState` with its file reads served by the file layer (a reading
interface the store's read methods implement, over the files for the CLI and over the model in the server). Its rules,
the fold over the events in file order, the passes after it, stay one piece of code, so the model cannot drift from
what the CLI derives. The derivation is memoized per version: asked twice at one version, it is made once, and the
same object is returned; `generated_at` then moves only when the state did (the dashboard keys a step's and a queue's
reads on it).

- **Read-only**: readers share one state object. A reader that changes it would change it for every other; in the
  tests the derived state is frozen deeply, so such a reader fails there (today `stateOf`'s snapshot is shared the same
  way, the engine's own reads are not).
- **Time**: what the derivation computes from the clock (the away mode's `awayNow`, the recurring queues' due times in
  `recurringOf`, the "at 14:00" texts of planned starts and skips) is as old as the derivation. Today the snapshot of
  `stateOf` is as old as the last change, and timers (`armAway`, the coordinator's wake, the engine's schedules) call
  `changed()` when such a time comes; the engine's own reads are fresh. Such a timer moves the model's version too. SM3
  lists each clock read of the derivation with the timer that covers it; one without is a finding of the step, and is
  moved out of the derived state into a function of the state and the time, which its reader calls.
- **Cost**: a derivation from memory costs the fold and its passes, without the reading and parsing that made up
  about four fifths of a rebuild in the start's profile (15 s `existsSync`, 17 s YAML, 5 s reading of 45 s). SM2's gate
  counts it; if it shows in the measurement after SM4, the next step is a derivation per queue (below, beyond the
  decision).

## Rebuilding

- **At the start**: the model is built by one read of every file, once per project, before the engine recovers its
  runs; the hand-over check, the migrations at the start, the recovery and the first requests all use it.
- **On a contradiction**: the file alone (above).
- **On demand**: the model can be thrown away and built again at any time (a test does it after every step of a
  scenario and compares: the model fed line by line and the model built from the files give the same state and the
  same indexes). A server of another version starts with a fresh model: nothing of it is kept across a restart (no
  checkpoint; beyond the decision, below).
- **A whole rebuild when the watcher fails** (its `error` event, or a folder it lost on Windows): the model is
  marked stale and built again at the next read, and the event is logged.

## The two findings of the measurement, and the step that removes each

**(1) The start: one state per queue (36 s, 124 s beside the test suite, at every deploy).** `recoverAfterRestart`
calls `releaseOrphanedSteps` for each queue, and each rebuilds the whole state. **In SM3**: the model's one read at the
start replaces them. `releaseOrphanedSteps` takes the queue's view from the state the recovery passes it (a parameter;
the CLI and the start of a run keep calling it without one); after a queue it changed (an orphaned step: rare) the
state is derived again from memory, with no read of the files. This is the same as today: at the start no agent runs,
and the state between two queues changes only by such a write. The gate counts one full read at the start, the same at
1× and 4× the queues.

**(2) Every activity line: a whole rebuild and every decision (about 800 ms a line, three quarters of the server's
time).** **In SM3**: an activity line (the agent host's append, or the watcher's event for `activity.jsonl`) is a log
only: it goes into the activity index, the version does not move, no rebuild, no decision, and the dashboards are told
with a `log` message instead of `changed`, so their dozen state reads are not asked again either. Chat and refusal
lines likewise. **In SM4**: the decisions on a change that does move the state read the model instead of rebuilding:
today `Orchestrator.onChange` rebuilds once more on every change, the coordinator's `holders()` once per project on
every pass (`checkStarts`, after every engine decision), the scheduler and the recurring queues their own; after SM4 a
change costs one derivation from memory however many decisions read it.

Not in the measurement: a streaming agent also rewrites its `runtime.json` on most messages (`AgentHost.facts`: the
context tokens, the cost), about as often as it appends activity. The measuring script appended activity only.
`runtime.json` is a state input (the coordinator reads `live.state`, the orchestrator's context care the tokens), so it
still moves the version after SM3; after SM4 that costs a derivation from memory and the decisions. Whether a facts-only
rewrite (tokens, cost, model) may skip the decisions is a question for SM4's evidence (beyond the decision, below).

## Today's readers

The readers of the history in the server, what each reads now, and the step that moves it.

| Reader | Where | Reads now | Moves in |
|---|---|---|---|
| The project's state for requests and decisions | `main.ts` `stateOf` | `loadProjectState` after each write or change | SM3 |
| The engine's recovery at the start | `engine.ts` `recoverAfterRestart`; `actions.ts` `releaseOrphanedSteps` | a state per queue, then one more | SM3 |
| Project list, state, estimates, metrics | `GET /api/projects`, `…/state`, `…/estimates`, `…/metrics` | `stateOf`; `readTurns()` whole | SM3 |
| Digest | `GET /api/digest` | `stateOf`; every session's events, refusals and activity whole; turns whole | SM3 |
| Statistics, usage days | `GET /api/stats`, `/api/usage/days` | every project's `stateOf`; turns whole | SM3 |
| Refusals | `GET …/refusals` | every session's `refusals.jsonl` | SM3 |
| Activity | `GET …/sessions/:session/activity` (`Engine.activity`) | the session's `activity.jsonl` whole | SM3 |
| Chats | `GET …/chat`, `…/chat/search`, pins (`chats.ts`); the orchestrator's chat view | the session's `chat.jsonl` whole | SM3 |
| Conversations | `Conversations.list`, `view`, `compact` | every session file; every conversation's chat whole, on each request | SM3 |
| Queue git, step commits, stopped work | `…/queues/:queue/git`, `…/commits`, `…/left`; `gitinfo.ts` (activity for a round's turns) | `stateOf`; the session's activity whole | SM3 |
| Files the dashboard may open | `GET …/file` (`allowedRoots`) | `stateOf` | SM3 |
| The user's actions on queues and steps | `actions.ts` (approve, answer, send back, notes, status, pictures, plan …), `plan.ts`, `idea-*-actions.ts`, `rulesfix.ts`, `stopwork.ts`, `accepted.ts`, the Continue route | a fresh `loadProjectState` inside each | SM4 |
| Routing answers and send-backs | `routeAnswers`, `routeSendBacks` in `changed()` | the snapshot | SM4 |
| The engine | `engine.ts`: start, resume, advance, the turn's end, review, release at the limit, usage and retry waits, switches (about 30 calls) | a fresh `loadProjectState` at each; activity and refusals whole | SM4 |
| The scheduler, the recurring queues | `scheduler.ts`, `recurring.ts` | a fresh state at each plan read | SM4 |
| The coordinator | `coordinator.ts` `holders()` | a state per project on every pass | SM4 |
| The orchestrator | `orchestrator.ts` `onChange`, requests, notices, context care, idea hand-offs | a fresh state on every change; events, applied, inbox and chat of its sessions whole | SM4 |
| Review helpers | `review-helper.ts` | fresh states; events, applied, refusals whole | SM4 |
| Merger, merge back, deploy plan | `merger.ts` `onChange`, `mergeback.ts`, `deploy-plan.ts` | the snapshot; fresh states in merge back | SM4 |
| Ideas | `GET …/ideas`, `…/matches`, `…/links`, `…/statuses`; `ideas-read.ts`; the reconciliation in `changed()` | the snapshot; every session's events (hand-overs); the notes folder | SM4 |
| Search | `GET …/search` (`search.ts`) | the whole history, on request | SM4 (reads the model's events; logs by their files, off the loop) |
| The hand-over check | `handover.ts` | one state per project, before loading | stays (before the model exists) |
| The CLI | `packages/cli` | the files | stays (another process) |

## The order of moving the readers

The readers that only show come first, the decisions last, so that until SM4 no decision reads anything new:

1. **SM3, the model and its feeding**: the file layer, write-through, the watcher's paths, the sorting of a change
   into a state input or a log, the `log` message and the dashboard's reads keyed on it, the rebuild on demand and its
   test.
2. **SM3, `stateOf`** reads the model's state: every route that used it, and the snapshot the decisions get in
   `changed()`, with no change to the decisions themselves.
3. **SM3, the start**: the one read, the recovery with one state (finding 1).
4. **SM3, the routes of logs**: activity, chats and pins, refusals, the digest, the conversations, the turns for
   estimates, statistics and usage days, the git routes' activity.
5. **SM4, the protocol's actions and the routing**: `loadProjectState(store)` inside them reads the model's state
   when the store is the server's (the same call; the CLI's store reads the files). They decide and write synchronously
   as before.
6. **SM4, the engine, the scheduler, the recurring queues, the coordinator** (lifecycle code: the fake runtimes'
   tests of the engine's decisions run against both, the files and the model, and compare what they write).
7. **SM4, the orchestrator and the review helpers**, then **the merger, merge back and the deploy plan**.
8. **SM4, the ideas and the search.**

Every step keeps the decisions' order and atomicity: reads stay synchronous where they are today, the model answers
from memory. A move that would make the engine, the merger or the orchestrator see something else than today stops the
queue with the evidence (its stop condition).

## The gate

The store counts the work of its reads (`workCounts` in `packages/protocol/src/store.ts`): files read whole and their
bytes, probes (a file's existence asked), folder listings, and whole derivations of a state (`loadProjectState`).
Reads outside the store (templates, the ideas' notes) are not counted. `packages/protocol/test/synthetic.ts` builds a
synthetic `.nexus` from a fixed seed (no clock, no random ids: the same tree for the same seed, which a test holds),
shaped like Nexus's own as counted on 2026-11-20 (only its sizes: queues, steps, sessions by role, the logs' lines and
bytes, the server's files) and scalable; `node scripts/synthetic-nexus.ts <folder> --scale 4` writes one. Its 1× is
within 15% of Nexus's on every count (a test holds that too): 137 queues, about 360 steps, 260 sessions, about 6,000
events (4.3 MB), 37,000 activity lines (9.3 MB), 6,400 chat lines; it takes about 2 s to write, 8 s at 4×.

`packages/protocol/test/work-gate.test.ts` measures today's reads at 1× and 4× (SM2, before the model):

| | 1× | 4× |
|---|---|---|
| A whole rebuild (a request after a change) | 1,442 files, 5.7 MB, 2,403 probes | 5,762 files, 23.3 MB, 9,561 probes |
| The start (the recovery: a state per queue, then one) | 138 rebuilds, 199,000 files, 791 MB | 549 rebuilds, 3.2 million files, 12.8 GB |
| One activity line (93 bytes) and its change | a whole rebuild | a whole rebuild |
| One event line (138 bytes) and its change | a whole rebuild | a whole rebuild |
| The conversation list (`Conversations.list`'s reads) | 271 files, 0.77 MB | 1,078 files, 3.1 MB |

It holds these as they are now (the start rebuilds once per queue and once more; a line makes a whole read; a rebuild
reads about four times as much at 4×). The gate's rules are written beside them as skipped tests, which SM3 turns on
for the readers it moves: one appended line reads that line and the 64 bytes before it, and rebuilds nothing; the
start reads the project once; a request makes no whole read; the counts are the same at 1× and 4×. The start's figure
is one queue's `releaseOrphanedSteps` measured and counted for every queue (each is the same whole read; running all of
them takes minutes at 4×). The generator does not rewrite `runtime.json` as a streaming agent does yet (above): that
belongs with the scenario of a streaming agent in SM3's gate.

## Beyond the decision (proposals, not decided)

- **The model stays on the event loop in this queue; a worker thread later, if the measurement asks for it.** The
  decision puts the processing of agent output, the ingesting and the round of decisions on a worker thread. With the
  model, ingesting a line is a read of that line, and a derivation is from memory; the engine's decisions read and
  write synchronously by the user's decision of SV2B, so moving them would make every read across threads
  asynchronous, and the state copied between threads (several MB) on each change. Measure after SM4 first.
- **Changes to the dashboard as deltas**: SM3 sends `log` beside `changed` (which reads to ask again). The decision's
  aim, the changes themselves with a sequence number and a full reload on a gap, is a queue of its own after SM4.
- **A derivation per queue**: only if the derivation from memory shows in SM4's measurement; the fold over events in
  file order across sessions and the passes across queues (plan, train, attention) make it a larger change.
- **A `runtime.json` rewrite of facts only** (tokens, cost, model) skipping the decisions: SM4 measures how often it
  comes and which decision reads which fact (the orchestrator's context care reads the tokens).
- **A checkpoint of the model for the start**: not needed while the start is one read (about 260 ms on the measured
  size); revisit when the history grows, together with archiving closed queues' events.
- **Ideas without a write on a read**: `GET …/ideas` and `…/statuses` reconcile (and may write) on each request; the
  reconciliation already runs in `changed()`.
- **The idea hand-off's chat line**: `Orchestrator.enqueueIdea` returns `entries.length` as the new message's line,
  which is not its line when the chat has a broken line (lines count blank and broken lines). The model keeps today's
  answer; a fix is a change of behaviour for the user to decide.
- **The CLI's own whole reads**: every `nexus` command builds the whole state from the files (another process, on a
  busy machine: CPU beside the server). Out of this queue's scope.
- **Templates read on every rebuild** (`recurringOf`): the model caches them; a project with no recurring queue need not
  read them at all.
