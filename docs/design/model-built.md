# The derived model: what was built, and what is proposed

Part of [the design](../DESIGN.md).

See also: [The derived model](model.md), the plan these sections built and measured.

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
