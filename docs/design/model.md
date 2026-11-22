# The derived model (queue SM)

Status: planned in SM1 (2026-11-20); the model and its first readers built in SM3 ("Built in SM3", below), the rest
moved onto it in SM4 ("Built in SM4"). It follows the user's decision of 2026-11-18 on the
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
with the events and the indexes, not with the logs' text. Built in queue AQ ([archive.md](archive.md)): no summary file;
the dashboard's state holds a closed queue as its summary, and the logs no one reads are let go.

## How the watcher feeds it

The project's watcher (chokidar on `.nexus`, as today) passes each event's path and kind to the model instead of only
calling `changed()`. The server's own writes reach it at once, before the write returns: the store's write helpers
(`writeYaml`, `appendJsonl`, `renameRetrying`, the unlinks) report the path they wrote to the model of that store
(**write-through**), so a decision that writes and the next one that reads see the write, as they did through
`writeCount` before the model (the count is gone since: the write-through took its place). The watcher's event for the same write comes later and finds nothing new (a stat).

The watchers live in `apps/server/src/watchers.ts` (queue LH; before it, in `main.ts`): `watchProject` makes a
project's two watchers (Node's recursive one feeding the model, chokidar's), `watchHome` NEXUS_HOME's. Both take the
watchers from a `WatchFactory` (by default `realWatch`), so a test gives stand-ins and drives their reports and errors
without a server (`watchers.test.ts`).

Node closes a watcher's handle when it emits `error`, so a project's Node watcher is made again a second after its
error (and again while making it fails, also at the start); the model is read again whole after the error and once the
new watcher stands (queue LH: before, the dead watcher left chokidar alone to feed the model). NEXUS_HOME is watched as
a folder (depth 0, its four files by name), not as files named to chokidar, which reports nothing of one that did not
exist yet (away.yaml before away mode was first turned on). A change of settings.yaml or away.yaml, by hand too, is a
change of every project: its decisions run and its state goes out. A home watcher's error reads NEXUS_HOME's files
again and looks at every project and the registry again.

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
replaced, the version moved; the event is counted (`model.resets` in `/api/server/perf`, the process's work count
`resets`) and logged with the file's path (since queue LH; before it only the cache's own count moved). Nothing
else is read again: the state is derived from memory anyway.

A read refused for a moment (EBUSY, EPERM, EACCES, EMFILE, ENFILE: another process holds the file on Windows) is not
the file's content (queue LH): the open is tried again for up to 200 ms, and if it still fails a log keeps what was
read and is read on at its next read, and a YAML or JSON file is not kept (the error is thrown, the next read tries
again). Before, such a log stayed empty and such a file a parse error until the file's next change.

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

- **Read-only**: readers share one state object. A reader that changes it would change it for every other; the
  derived state is frozen deeply (SM4), so such a reader fails at once (in SM4's tests none did; the live server met
  one: "Its reads are read-only", below).
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

## Its reads are read-only

The rule (queue MF): **what the model hands out is never changed** — the derived state (`model.current()`, and
`loadProjectState` over a store reading through a model), every entry of a log read through the store
(`readEvents`, `readInbox`, `readDelivered`, `readApplied`, … : the arrays are copies, the entries are the model's,
including their `z.unknown()` fields such as `queue.drafted`'s `definition`), and a file's parsed value. All of it is
shared by every reader until the next change, and frozen deeply, so a change throws a `TypeError` in the server
(strict mode) instead of changing it for every other reader. The first such change reached the live server
(`read_at` set on a frozen inbox entry during the derivation, fixed in b94f28d).

How code gets an object of its own to change:

- **The derivation** writes only to objects it made: a view is a spread of what it read with new arrays
  (`{ ...m }` for an inbox entry, `notes.map((n) => ({ ...n }))`), never the read object itself. A frozen event may be
  kept by reference (a step's timeline), never written to.
- **The store's reads of whole files** (`readQueue`, `readSession`, `readGit`, `readChecks`, `readPlan`, …) go through
  a zod parse, which builds fresh objects: their result is the caller's to change and write back.
- **A caller that wants to change the state or a log entry** (a test bending a state into a case, a helper that
  normalises a draft) copies first: `structuredClone(x)` for a whole tree, a spread for one level. An in-place
  `.sort()`/`.reverse()` is a change too: sort a copy (`[...xs].sort(…)`).

How the checks keep it: every test run reads through the model (docs/design/tests.md, "The tests read through the
model (queue MF)").

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

The readers of the history in the server as SM1 found them, what each read then, and the step that moved it (all
moved: "Built in SM3" and "Built in SM4" below).

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
| Search | `GET …/search` (`search.ts`) | the whole history, on request | SM4 (reads the model's events; chats by their files) |
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

The start's figure is one queue's `releaseOrphanedSteps` measured and counted for every queue (each is the same whole
read; running all of them takes minutes at 4×). The same reads through the model (SM3), and the rules the gate holds
on them:

| Through the model | 1× | 4× | Rule |
|---|---|---|---|
| The start (one state for every queue) | 1,442 files, 5.7 MB, 1 derivation | 5,762 files, 23.3 MB, 1 derivation | one read of the project, one derivation |
| A request, nothing changed; the conversation list | nothing read | nothing read | nothing read, at any size |
| One activity line (93 bytes), the state, the session's activity | 157 bytes, no derivation | the same | the line and 64 bytes, nothing derived |
| One event line (138 bytes), the state | 202 bytes, 1 derivation | the same | the line and 64 bytes |
| A runtime record rewritten (context tokens), the state | that file, 1 derivation | the same | that file alone |

## Built in SM3

`packages/protocol/src/model.ts`: `FileCache` (a `Reader` over a folder's files, from memory) and `ProjectModel` (a
project's store reading through it, and its state derived once per version). `ProjectStore` takes a `Reader`
(`store.ts`): the files themselves by default (the CLI, the engine's own store), the cache in the model. The store's
writes report their paths (`onWrite`) as they are made; `wrote` takes the path of a write made outside it.
Everything the cache hands out is frozen.

Moved onto it: `stateOf` in `main.ts` (every route that read the state, and the snapshot the decisions in `changed()`
get; `changed()` moves the model's version as it cleared the snapshot before), the engine's recovery at the start
(`EngineOptions.state`; `releaseOrphanedSteps` takes the state as an option), the routes of the logs (activity, a chat's
range and search, refusals, the digest, the queue's git, a step's commits, what a stopped step left), the
conversations' list and views and the orchestrator's chat view (their `reads` store), and NEXUS_HOME's
`settings.yaml`, `away.yaml` and `turns.jsonl` (`useHomeReader`, watched for a change by hand; a write of the settings
or the away mode moves every project's version). The watcher passes each path to the model; an activity, chat or
refusals line, or a pin, is a log only: a `log` message (docs/protocol/api.md), which the dashboard counts apart
(`logsVersion` in `apps/web/src/query.ts`): the activity, refusals, chats and conversations are read at it, the state
and what spans projects are not.

What differs from the plan above, and why:

- **A log once opened is kept whole**, not as an index with its last entries: the activity's queue and step filter and
  the digest's retries need every entry, and a ranged read of the file would be a second way of reading it. A log no
  reader asked for is not read at all (most of a closed queue's); the memory of the opened ones (the digest opens every
  activity log) is the next thing to bound, with the archiving. Bounded in queue AQ: a log only no one asked for in two
  minutes is let go, and the digest opens only the logs written since its time ([archive.md](archive.md)).
- **The volatile logs** are the events of the sessions whose runtime record is not `exited` (the model reads them
  itself; the agent hosts are not asked), read on at each read of the state.
- **Still from the files**: the orchestrator view's switch records (its earlier sessions' applied and events, read by
  helpers its decisions share), the search, the ideas, the actions and every decision's own reads (SM4). Templates
  (`recurringOf`) are read at each derivation, uncounted, as before.
- **The equivalence** the stop condition asks for: the decisions read nothing new in SM3 (their own reads stay on the
  files); the snapshot they get is derived from what the files held when this process last wrote or the watcher last
  reported, as `stateOf`'s was, plus the live sessions' events read on. The recovery's one state is the state each
  queue's own rebuild saw (between two queues only a release writes, and the state is derived again after one). The
  fake runtimes' engine, orchestrator and conversation tests pass unchanged.

`packages/protocol/test/model.test.ts`: the model fed line by line and by write-through (an event, an activity line,
a queue rewritten, a note added and withdrawn, a new session, a run archived, another process's line) gives what
`loadProjectState` over the files gives and what a model built afresh gives, and the same logs; a line being written
waits for its newline, line numbers count blank and broken lines; a log rewritten under its position is read again
whole and counted; what it hands out cannot be changed; an activity line derives nothing; a live session's line is
read before the watcher reports it.

**SV1's measurement before and after** (`node scripts/perf-load.ts --minutes 3` on the user's machine, the same load
as SV1's quiet run; before: the code at SM2's commit, after: SM3's):

| | Before | After |
|---|---|---|
| Start until the first answer | 36.6 s | 1.1 s |
| Event loop delay p50 / p99 / max | 36 ms / 3.2 s / 3.7 s | 15 ms / 0.56 s / 3.5 s |
| A derivation of the state (`state big`, count, mean) | 186, 271 ms | 90, 42 ms |
| The decisions on a change (`engine (big)`, count, mean) | 160, 135 ms | 52, 213 ms |
| Notifications the dashboards got (each made them read 12 endpoints) | 316 | 854 (`log` messages too) |
| What a dashboard waited for `state` (mean / p95) | 327 ms / 1.6 s | 63 ms / 98 ms |
| … for `server` | 2.3 / 5.3 s | 0.42 / 1.7 s |
| … for the queue's git (mean / p95) | 3.7 / 8.2 s | 0.75 / 2.9 s |
| Steps done in 3 minutes | 9 | 11 |

The measuring script's dashboards read their 12 endpoints on every message, `log` ones included, as the old dashboard
did: they asked about 2.7 times as much as before and were still answered five times sooner. The decisions now run only
on a change of the state, a third as often; each costs more on average because the cheap ones (an activity line's)
are gone. The remaining blocks are the dashboards' queue git reads (several git processes per read, SV2's item left)
and the decisions' own state rebuilds (SM4).

## Built in SM4

Every reader in the server reads through the model. `main.ts` makes the project's store from its model (`Entry.store`
is `model.store`; only the migrations at the start, before the model, use a store over the files): the user's actions
(`act`, the protocol's actions with it), the routing of answers and send-backs, the engine (its own reads, the
scheduler, the recurring queues, the check runs, `accepted.ts`, `stopwork.ts`, `rulesfix.ts`), the coordinator's
`holders()` (it reads each member engine's store), the orchestrator and its review helpers, the merger, merge back,
the deploy plan's boundary (the state it is given), the conversations, the ideas and the search. The `reads` option of
the orchestrator and the conversations and the engine's `state` option are gone: their stores are the model's.

- **One derivation per change, for all of them**: `loadProjectState(store)` over a store reading through a model
  answers with the model's state (`Reader.state`; `deriveProjectState` is the derivation itself), so the ~80 calls
  that each rebuilt the whole state share one derivation from memory per change. The CLI's store reads the files and
  derives as before (the same rules: one piece of code). The shared state is frozen deeply.
- **As current as a read of the files** (above): the files another process writes that a decision reads are an agent's
  own `events.jsonl` (its `nexus`; the review files and reports are read from their files, not through the store).
  Each read of a live session's events (its runtime record not `exited`) first looks whether the file grew (a stat),
  as a read of the file would see a line the watcher has not reported yet; and a change of a session's runtime record
  (its agent started, reported, ended) marks its events to be read on at the next read, so an agent's last lines,
  written before its end is recorded, are read before anything decides on that end. `Engine.writeRun`'s read of the
  log before stamping a run's end is this read. A person's CLI by hand (an import, a note) is seen at its watcher event,
  a few milliseconds later than a read of the file, and that event runs the decisions again (`changed()`), as it ran
  them before.
- **Time**: the state's away mode (`state.away`, read by the orchestrator's away rule, its notices and the review
  level) is as old as the derivation. The away timer (`armAway`) writes the mode's end at its time (+50 ms), which
  moves every model's version; the model also derives again by itself once the away period of the state it holds has
  ended, so no decision reads a passed away mode. The recurring queues' `next_at` is shown only (their decisions compute
  their own times).
- **Templates**: while the project has recurring queues, the model derives again when a template file was added,
  removed or edited (`templatesStamp`: a listing of the three template folders and a stat per file, at each read of
  the state), so the recurring queues' views (their hash and status) are not older than the templates.
- **The watcher**: each project's model is also fed by Node's own recursive watcher of its `.nexus`
  (`ProjectModel.watched`; chokidar stays for the notes folder and as before). Chokidar on Windows dropped 7 of 40
  atomic rewrites of one file made a few tens of milliseconds apart (Node's watcher none of 100): before the model a
  dropped event only delayed a rebuild, but a model that misses one keeps the file's old copy until its next reported
  change (ideas-api's last wait for a queue rewritten by the test timed out 1 in 5 at SM3's code). A folder's own
  `change` report is skipped (its files report themselves), and the cache forgets what lies under a path only once the
  path is gone. A write that makes a folder (the first `recurring/<id>.yaml`) now also makes the folder's existence be
  asked again: since SM3 the cache kept the folder as missing until the watcher reported it.
- **The search** reads the events from the model (they are in memory for the state anyway); the chats, which the model
  keeps only once opened, and the reports are read from their files on the request, as before.

Readers left on their own reads, and why: the hand-over check (`handover.ts`, before the model exists); the CLI
(another process); the deploy plan's and the crash record's own files in `NEXUS_HOME` (one small file each, not the
history); the ideas' notes folder (outside `.nexus`; reconciled on a change and on its request, as before); the
templates (`recurringOf`, uncounted, as before); the review files, reports and check logs (read by their routes when
asked).

**The evidence that the decisions read the same** (the queue's stop condition): `apps/server/test/model-reads.ts`, a
preload (since queue MF loaded by every test run: "Its reads are read-only") that makes every store of a test
process read through a model of its folder, fed by the process's writes and by a watcher as `main.ts`'s, with
`loadProjectState` over it the model's frozen state. The fake runtimes' tests of the engine (`engine*.test.ts`), the
merger, merge back, the coordinator, the orchestrator (`orchestrator*.test.ts`, context care, the review helpers), the
conversations, reviews, questions, the plan, the schedules and the recurring queues pass both ways, over the files and
through the model. The tests that run a server process (the API tests) run through the model anyway: `main.ts` always
does.

The gate holds the decisions too: an event appended, then what every decision on a change reads (the state once per
decision, each queue's files, every session's files and logs, the ideas' hand-offs) reads that line and the 64 bytes
before it and derives the state once, the same at 1x and 4x. A runtime record rewritten now reads that record and its
session's events from their position (64 bytes).

**SV1's measurement before and after** (`node scripts/perf-load.ts --minutes 3`, the same load as SM3's; before: the
code at SM3's last commit, its source folders checked out into the tree and restored; after: SM4's):

| | Before (SM3) | After (SM4) |
|---|---|---|
| Start until the first answer | 1.4 s | 1.1 s |
| Event loop delay p50 / p99 / max | 15 ms / 1.0 s / 4.5 s | 16 ms / 0.37 s / 1.1 s |
| The decisions on a change (`engine (big)`, count, mean, max) | 48, 309 ms, 1.0 s | 62, 40 ms, 0.31 s |
| A derivation of the state (`state big`, count, mean) | 85, 64 ms | 89, 72 ms |
| Notifications the dashboards got (each made them read 12 endpoints) | 748 | 1,142 |
| What a dashboard waited for `state` (mean / p95) | 100 ms / 189 ms | 53 ms / 203 ms |
| … for `server` (mean / p95) | 644 ms / 3.4 s | 394 ms / 1.0 s |
| … for the queue's git (mean / p95) | 1.1 / 4.5 s | 0.69 / 1.7 s |
| Steps accepted in 3 minutes | 18 | 18 |

The decisions on a change cost an eighth of what they did: each read the state again from the files several times
(the engine's own `loadProjectState`, the orchestrator's on every change, the coordinator's per member); now they share
the one derivation. In the same three minutes the dashboards were answered 1.5 times as often, and the longest block
of the loop fell from 4.5 s to 1.1 s. What is left in the longest blocks is the dashboards' git reads (SV2's item) and
the derivation itself (about 70 ms here; a derivation per queue is the proposal below if it grows).

## Beyond the decision (proposals, not decided)

- **The model stays on the event loop in this queue; a worker thread later, if the measurement asks for it.** The
  decision puts the processing of agent output, the ingesting and the round of decisions on a worker thread. With the
  model, ingesting a line is a read of that line, and a derivation is from memory; the engine's decisions read and
  write synchronously by the user's decision of SV2B, so moving them would make every read across threads
  asynchronous, and the state copied between threads (several MB) on each change. Measured after SM4: proposed not
  to build it now (performance.md, "The measurement after the model, and the worker thread (queue SW)", with what to
  do instead).
- **Changes to the dashboard as deltas**: SM3 sends `log` beside `changed` (which reads to ask again). The decision's
  aim, the changes themselves with a sequence number and a full reload on a gap, is a queue of its own after SM4
  (planned in queue SD: [live.md](live.md)).
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
