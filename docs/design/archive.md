# Closed queues: their summary at hand, their details when opened (queue AQ)

Part of [the design](../DESIGN.md).

Status: built in AQ1 (2026-11-22). It follows the archiving of the user's decision on the read layer
([model.md](model.md#what-it-holds): a closed queue's summary stays at hand, its detailed logs are read when it is
opened) and the third proposal of the live stream's measurement ([live.md](live.md#beyond-the-decision-proposals-not-decided):
the state without closed queues' details).

## What was measured before

On the synthetic tree at 4× (`node scripts/synthetic-nexus.ts <folder> --scale 4`: 548 queues, 536 of them done, 1,034
sessions, 17 MB of events, 35 MB of activity), the code at LH's last commit:

- **The state the dashboard reads was 30.1 MB** (7.4 MB at 1×, the 7.3 MB the live stream's measurement saw on
  Nexus's own project), and 25.8 MB of it were the closed queues: their steps' timelines (13.1 MB), summaries (3.3),
  goals (2.2), messages (1.3), checks (1.0), metrics (0.7), review items (0.6). Every full read sent it, the live stream
  kept it as text (one JSON text per queue, serialized again on every change) and diffed it on every change.
- **The model kept every log it had opened** (SM3, "A log once opened is kept whole"), and the digest opened every
  activity and refusals log of the project on each of its reads, to find the retries and refusals of the last day: 47
  MB more heap at 4× after the first digest, for the server's life.

## The decision

**No new file.** The goal allowed a summary written at a queue's close (a protocol change, and a migration at the
start). It is not needed, and it would cost more than it saves:

- The summary a list needs is already in the model: the state is a fold over the events, which the model holds anyway
  (they are the state's input, and the statistics, the estimates, the review statistics and the search read a closed
  queue's timeline from it). A closed queue's summary is a projection of its view, not something to read.
- A closed queue still changes: a provisional acceptance confirmed, a note, a push, a revision approved after a stop.
  A summary file would be a second record of the same facts with a writer to keep in step, and the CLI (another
  process, which derives the state from the files) would have to derive the same from it.
- What made a closed queue expensive was not its events but its logs (kept once read) and its details on the wire.

So the files stay as they are, nothing under `.nexus/` is moved or deleted, and the stop condition of the queue (a move
or a deletion under `.nexus/`) does not come up.

### The state the dashboard reads

`shownState` (`packages/protocol/src/archive.ts`) is the state the live stream publishes and the full read answers: a
closed queue that waits for nothing (`isArchived`: done or cancelled, no step in review or with a provisional acceptance
to confirm, no open question, no attention item) is its summary, `archived: true`, its steps with their status, title,
times, tags and level and with their details empty (the list of fields is in
[the protocol](../protocol/api.md#server-api), "Closed queues"). These are exactly the queues the project page folds
into "Finished" (`apps/web/src/finished.ts`), whose lines show the id, title, status and times, so the list shows each
from its summary alone. `shownState` gives the same object for the same state, so the stream's comparison by identity
(nothing changed: nothing sent) holds.

Opening such a queue (the dashboard's `App.tsx`, `apps/web/src/archived.ts`) reads its whole view from
`GET /api/projects/:id/queues/:queue` at the queue's version (it moves with that queue's changes), and shows the
queue's or step's details once it lands. A queue in the active list is whole in the state, as before; one that leaves
"Finished" again (a question opened on it) comes whole in the next state message.

Only the dashboard's state is narrowed. The model's state stays whole: the decisions, the statistics
(`GET /api/stats`, `nexus stats`), the estimates, the digest, the search and the CLI read it as before, and the
statistics of a closed queue never read its logs.

### The logs in memory

A log only (activity, chat, refusals, pins; the logs no state is derived from) is let go by the model when no one has
asked for it for `LOG_IDLE_MS` (2 minutes; `FileCache.release`, looked at on the reads at most every 30 s). Asked again,
it is read from its file. Letting go is no change: the version stays, nothing is derived, no message goes out. The
events stay (they are the state's input). A log someone reads (a chat open on a page, the orchestrator's chat, the
activity of a step being watched) is asked for on each of its messages and stays.

The digest reads a session's activity and refusals only when the log was written since its time
(`digestInput` in `packages/protocol/src/digest.ts`, `ProjectStore.logModified`): a log last modified before
`since - CLOCK_AHEAD_MS` holds no line after `since` (a line's time is at most that far ahead of the clock that wrote
it). The modification time is a stat the model keeps until the file's change is reported (write-through or the
watcher), so the next digest asks nothing. A closed queue's logs are then never opened unless its activity or chat is.

## The measurement

`node --expose-gc scripts/state-memory.ts <folder>/.nexus --age`: the model as the server makes it (`new ProjectModel`, its state, the stream's texts of the
state it publishes, the digest of the last 24 hours twice, then opening a closed queue and letting its logs go), on the
synthetic tree with each log's modification time set to its last line's time (as a log last written then would have
it). Before: the code at LH's last commit (`dad14bd`); after: AQ1's. Heap after two collections.

| | 1× before | 1× after | 4× before | 4× after |
|---|---|---|---|---|
| The state the dashboard reads (full read, the stream's texts) | 7.4 MB | 1.5 MB | 30.1 MB | 6.2 MB |
| Serializing it into the stream's texts (on every change) | 11 ms | 4 ms | 46 ms | 18 ms |
| The start: the model's read and the first derivation | 0.62 s | 0.61 s | 2.0 s | 2.0–2.1 s |
| Heap after the start (the model, its state, the texts) | 38 MB | 33 MB | 90 MB | 69 MB |
| The first digest of the last day | 112 ms | 18 ms | 360 ms | 66 ms |
| Logs held after it | every activity and refusals log | none | every one | none |
| Heap after it | 50 MB | 33 MB | 137 MB | 69 MB |

Opening a closed queue at 4× (Q0001: its whole view, 72 KB, and its two workers' activity, 300 lines) took 17 ms;
2 minutes later both logs were let go.

What did not move is the start: it reads every event and derives the whole state once (a fold over all sessions'
events in file order), and both are the same with or without the summaries. A start that skips closed queues' events
needs the derivation per queue (model-built.md, "Beyond the decision") or a checkpoint of the model, below.

## Tests

`packages/protocol/test/archive.test.ts` (on a synthetic project: the closed queues are summaries with no details and
what the list reads unchanged, open queues the same objects; the statistics from the model are those from the files and
no activity, chat or refusals log is read for the state, the list or the statistics; an opened closed queue's activity
is read, kept while asked, let go after the idle time without a change of the version, and read again; the digest opens
no log not written since its time and finds what reading every log finds, and a line written now),
`apps/web/test/archived.test.ts` (the Finished group, the rail's finished today and the honest status are the same from
the summaries as from the whole views; an opened summary shows the whole view of the same queue once read),
`apps/server/test/archive-api.test.ts` (a real server: the state's full read holds a done queue as its summary and an
open one whole, `GET …/queues/:queue` gives the whole view, 404 for an unknown queue or project).

## Beyond the decision (proposals, not decided)

- **A start without the closed queues' events**: the derivation per queue (model.md) would let a closed queue's view
  be kept from one derivation to the next, and a checkpoint of those views would let the start skip their events; the
  start is the one figure this step left as it was (2 s at 4×).
- **The events of closed sessions as an index**: the events (17 MB of text at 4×) are now most of what the model holds;
  a closed queue's timeline could be read from its file when opened, as its logs are, once the derivation no longer
  folds them.
- **Letting go of other files' parsed values** (a closed queue's `queue.yaml`, its notes) on the same idle rule: small
  today (3.6 MB of queue files at 4×).
