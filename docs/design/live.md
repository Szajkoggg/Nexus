# The dashboard gets the changes (queue SD)

Status: planned in SD1 (2026-11-21); built in SD2 ("Built in SD2", below). It follows the user's decision of 2026-11-18 on the server's
responsiveness (the user's notes, "Server responsiveness: one read layer over the files"): the server sends the changes
themselves, not only "changed" ("aim for the best"), and the views apply them; in many places this is worth doing now.
It builds on the derived model of queue SM ([model.md](model.md)). The messages and replies are in
[the protocol](../protocol/live.md).

## What the dashboard does today

Every `changed` message (a file of a project's state changed, or the server changed it; at most one per project every
150 ms) bumps the project's version in `apps/web/src/query.ts` (`bump`), and every open read keyed on it is asked
again: the project's state, the project list, the orchestrator's chat, the estimates, a queue's git and its step's
commits, and, through `all`, the server's state, the digest, the usage and the capacity. A `log` message (a line of
an agent's activity, a chat or a refusal: queue SM) asks again the reads of that project's logs: a step's activity,
the conversations and their chats, the refusals.

What that costs, from the measurement after SM4 (docs/design/performance.md, "The measurement after the model, and the
worker thread (queue SW)"): the dashboards' reads are the largest load on the server's loop, 45 s of synchronous time
in three minutes for two dashboards reading 12 endpoints on each of 1,077 notifications. The state alone is 7.3 MB
serialized at the synthetic history's 1× (shaped like Nexus's own; 30 MB at 4×), serialized again for every dashboard
on every change (`state` 16 ms a read), and sent whole even when only one session's context tokens moved. On a phone
over Tailscale those megabytes are the wait.

## The principle

**A view holds what it shows and applies what changed; it reads in full only when it starts and when it cannot be
sure it has every change.** The changes come from the model's own changes: the server compares what it last sent with
what the model holds now, and sends the parts that differ. The server, not the dashboard, derives: no rule of the
state is copied into the browser (the state's rules stay one piece of code, docs/design/model.md, "Derivation").

Three kinds of change, each sent as the model already sorts it:

- **The state** (`ProjectState`, derived once per change): the parts that differ from the state last sent.
- **A log** (activity, chat, refusals, pins): the lines appended since the last message about it. The model reads only
  the appended lines anyway (incremental loading); the message carries them.
- **A chat agent's head** (its process state, runtime record, model and effort, and for a conversation its item in the
  list): what the orchestrator's and a conversation's views show beside their chat.

Reads that are not worth a delta now are asked again as before, but only when something they show can have changed
(below, "The views"), not on every change of the project.

## The state's delta

The server keeps, per project, the state it last published as **parts**, each serialized once:

- **Whole parts**, replaced whole when their text differs: `project`, `away`, `tags`, `metrics`, `attention`,
  `warnings`, `generated_at`. They are small (attention and warnings at most a few dozen items), or rarely change.
- **Keyed lists**, sent member by member: `queues` (by `id`), `sessions` (by `id`), `questions` (by `qid`), `recurring`
  (by `id`). A member whose text differs, or which is new, is sent whole; one that is gone is named; the list's order
  (its ids) is sent when it changed (a member added or gone, or moved).

A queue is the unit, not a step: a running queue's view changes on every event of its worker, and is about 50 KB on
average (7.3 MB over 137 queues); one queue a change is two orders of magnitude below the whole state. A step as the
unit is a proposal for when a measurement asks for it (below, "Beyond the decision").

**Comparing by text.** The derivation makes new objects on every change (only the frozen events are shared), so
identity says nothing. The server serializes each part and each member of the new state once (`JSON.stringify`, the
same order every time: one piece of derivation code), compares the texts with those it kept, and keeps the new ones.
The full read of the state (`GET …/state`) is answered from the kept texts, joined, without serializing again: a change
costs one serialization however many dashboards read, where today each read serializes the whole state (16 ms at 1×).
A difference that is not one (a key in another order) would only cost bytes, never a wrong view.

**Too large to be worth it**: a delta whose text is larger than half the full state's (a change of the global settings
moves every queue's effective values; a rebuild after a failed watcher) is not sent; the message says `reload` and the
views read the state in full. So no delta ever costs more than a full read.

**The project list's line** (`ProjectSummary`: name, counts, attention) is computed from the state at the same time;
when it differs from the one sent, it goes with the state's delta, and the list replaces that project's line. A
project added or removed is still the `projects` message, and the list is read again.

**When nobody listens**: with no socket open nothing is published (no serialization for nobody); the kept texts are
dropped. The project's sequence number keeps counting, so a dashboard that connects later starts from a full read.

## Logs

A log message carries the entries appended to one session's log since the last message about it, as the model read
them: activity entries, chat entries with their `line` (the line numbers the chat's addressing uses: blank and broken
lines counted), refusal entries; for pins (`pins.json`, rewritten whole) the whole pin list. They keep today's pace:
at most one message per session and log every 150 ms (`logChanged` in `main.ts`), each holding everything appended in
that time.

A view applies the entries it shows: a step's activity takes those of its queue and step and keeps its newest 300 (the
route's limit); a chat view appends and keeps its window (older entries are still read by range, `…/chat?from=&to=`);
the refusals take theirs. A log the model reads again from its start (it contradicted its position: docs/design/model.md,
"When a file contradicts its position") is a `reload` message for that log: its views read it in full.

A log message larger than 256 KB (a chat line holding a long tool output, many lines at once) is sent as a `reload` of
that log instead, for the same reason as the state's limit.

## A chat agent's head

The orchestrator's view and a conversation's view show, beside their chat, what the state does not hold in the same
shape: the process state of the agent (working, idle, exited: the host's, in memory), its runtime record, model and
effort; a conversation's list item holds its last time and message count. When one of these differs from what was last
published for that session, a `session` message carries the new head (and for a conversation its list item). The
server computes it only for the sessions touched by the change (a session in the state's delta, a chat's log message),
never for every conversation on every change (the conversation list costs 10 ms a request today).

A head whose session is no longer the orchestrator's current one (context care switched it) makes the orchestrator's
view read in full: its earlier sessions changed with it.

## Order and gaps: one sequence per project

Within one WebSocket connection nothing is lost or reordered (TCP); a gap comes from somewhere else: the full read and
the socket are two channels, a socket closes and opens again, the server starts anew. So:

- **Every message about a project carries the project's sequence number** (`seq`): state, log and session messages
  alike, one counter per project, moving by one per message, starting at 0 when the server process starts. The
  server-wide messages (`server`, `projects`) carry none: they only make reads be asked again.
- **The process's epoch**: the socket's first message (`hello`) names the server process (`epoch`) and every project's
  current `seq`. A new process has a new epoch.
- **Every full read a view applies deltas to names where it stands** in the stream: the state, the project list (each
  line its project's), a log read (activity, refusals), the orchestrator's and a conversation's view, the conversation
  list. Before answering, the server publishes what is pending for that project (the state's delta if its version
  moved, the logs' messages waiting for their 150 ms), then answers from the same model in the same synchronous turn:
  the reply holds exactly the changes up to the `seq` it names, and every later change comes as a message with a
  higher one.
- **A write publishes before it answers.** A user's write (`act` in `main.ts`) publishes its project's pending changes
  before its answer, and the answer names the `seq` reached. The control that wrote stays in progress until the views
  it shows stand at that `seq` or beyond (it replaces DF1's wait for "the reads asked after the write",
  docs/design/state.md, "The order of reads after a write"; still at most ten seconds). The decisions on the change
  (`changed()`) run after it as today, and their writes come as later messages.

The page keeps one stream per project (`apps/web/src/query.ts` grows it in place of `Versions`):

- It knows the last `seq` it received for each project. A message whose `seq` is not the next one is a **gap**: every
  view of that project reads in full. (On one connection this happens only if the server dropped messages: it never
  does; it closes a socket that falls too far behind instead, below.)
- It keeps each project's messages from the moment a full read is asked until it lands. A read that lands at `seq` S
  takes the kept messages after S, in order, then the ones that come. A read at S below the `seq` the socket's `hello`
  named for the project (it was answered before this socket's start, and the messages between were sent before the
  socket listened) is asked again.
- **A full reload** of every view: the socket opens (first time or again: `reconnected` today), the epoch changes, a
  gap. Of one part: a `reload` message (the state's, a log's). Of one view: a new URL (another step, session, project),
  or a message it cannot apply (a member it should hold missing where the delta assumes it: never by construction,
  but a view that meets one reads in full rather than show a guess).
- **A socket that falls behind**: the server checks the socket's `bufferedAmount` before sending; above 8 MB (a phone
  on a slow link while a run streams) it closes that socket. The page reconnects and reads in full, which costs one
  state, not a queue of stale deltas.

Why a per-project sequence and not the model's version: the model's version moves on every state input, several per
published change (the 150 ms coalesce), and does not count logs; a counter of what was sent is what a view can check
for gaps. Why per project and not per socket: a future page that subscribes to one project (below) still sees every
message of that project, so the same check holds.

## The views

Where it is worth doing now, by what each read costs and how often it is asked today. **Delta**: the view holds its
answer and applies the messages. **Narrowed**: asked again in full, but only on the messages named. **As today**:
unchanged.

| Read | Shown by | Asked today | After SD | Why |
|---|---|---|---|---|
| `GET /api/projects/:id/state` | every project page (`App.tsx`); `IdeaLinks` asks its own | every `changed` | **Delta** (state); `IdeaLinks` uses the page's held state | 7.3 MB and 16 ms a read, on every change: the largest single read |
| `GET /api/projects` | the project list, the waiting items (`App.tsx`) | every `changed` and `projects` | **Delta** (the summary in the state's message); full on `projects` | asked on every change of every project |
| `GET …/sessions/:s/activity?queue&step` | a step's activity (`Run.tsx`) | every `log` and `changed` of the project | **Delta** (activity log) | the most frequent messages are activity lines |
| `GET …/orchestrator` | the orchestrator's chat (`Chat.tsx`) | every `changed` | **Delta** (its chat, pins, head) | 300 entries and the earlier sessions' on every change |
| `GET …/conversations` | the chat list (`App.tsx`, `Chat.tsx`, `IdeaOnward`, `Search`) | every `log` and `changed` | **Delta** (the conversations' items in `session` messages) | reads every conversation's chat (10 ms) on every log line |
| `GET …/conversations/:id` | an open conversation (`Chat.tsx`) | every `log` and `changed` | **Delta** (its chat, pins, head) | 400 entries on every log line of any session |
| `GET …/refusals?queue&step`, `GET …/refusals` | a step's refusals, the project's (`Refusals.tsx`) | `log` / `changed` | **Delta** (refusals log) | reads every session's refusals |
| `GET …/queues/:q/git`, `…/steps/:s/commits` | a queue's branch, a step's commits (`details/git.tsx`) | every `changed` | **Narrowed**: when that queue's view is in the state's delta | several git processes each; another queue's change, a session's runtime record, need not ask them |
| `GET …/estimates` | the plan (`Plan.tsx`) | every `changed` | **Narrowed**: a delta that changes a queue | reads every project's turns and states |
| `GET …/metrics` | the project's statistics (`ProjectStats`) | every `changed` | **Narrowed**: a delta that changes a queue or `metrics` | |
| `GET …/settings` | project settings (`Settings.tsx`) | every `changed` | **Narrowed**: a delta that changes `project` | changes only with the settings |
| `GET /api/server` | the header, updates, away (`useServer`) | every message but a log | **Narrowed**: `server`, and a delta that changes a queue (`running` steps) | 300 to 600 ms with its git calls (`version()`) |
| `GET /api/digest` | the digest (`Digest.tsx`) | every message but a log | **Narrowed**: a delta that changes a queue, a question or `attention`; `server` | spans projects; a session's runtime record does not change it |
| `GET /api/usage`, `/api/capacity` | the usage line, a queued step's slot | every message but a log | **Narrowed**: `server` (capacity already sends it), and a delta that changes a queue | |
| `GET /api/stats`, `/api/usage/days` | the statistics (`Stats.tsx`) | its calm version | **Narrowed**: a delta that changes a queue | |
| `GET …/ideas`, `…/ideas/handoffs`, `…/ideas/links`, `…/ideas/statuses` | the ideas views | every `changed` | **As today**, on every state delta | the notes folder lies outside the model's parts (a note's change is a `changed` with no part of the state moved); shown only on the Ideas view |
| `GET …/removal`, `…/rules`, `/api/remote` | danger zone, rules, remote access | `changed` / their own ticks | **As today**, on every state delta (`/api/remote` as today) | rare views, cheap enough |
| `GET /api/settings`, `/api/models/*`, `…/templates` | settings, pickers | not live | **As today** | |

"A delta that changes a queue" is one whose `upsert`, `remove` or `order` names `queues`. The frequent delta that
changes only `sessions` (a streaming agent rewrites its runtime record on most messages: docs/design/model.md, "The two
findings of the measurement") then asks nothing again but what applies it. SD2 checks each narrowed read against what
it shows; one that shows a session's live facts is keyed on `sessions` too.

What this should do to the measurement (SD2 measures it: requests a dashboard sends in a minute of an active run,
before and after): of the 12 endpoints asked on every message today, the seven largest are no longer asked at all
after their first read, and the rest only on the deltas that change a queue, a fraction of the messages while agents
stream.

## How it is built and tested (SD2)

- **One pure diff and apply, shared**: `diffState(sent, now)` and `applyState(held, delta)` in `@nexus/protocol`
  (used by the server and the dashboard alike), with a unit test: for states from the fake runtimes' scenarios,
  `applyState(a, diffState(a, b))` deep-equals `b`, also across a member added, removed and moved, a whole part
  replaced, and the `reload` limit.
- **The server's publisher** in `main.ts` beside `broadcast`: the kept texts per project, `publish(id)` (the state's
  delta, the summary, the pending logs, the heads), called at the end of `changed()`'s debounce in place of
  `broadcast({ type: "changed" })`, by `logChanged`'s timer in place of the `log` message, before a full read is
  answered and before a write answers. Not lifecycle code: the decisions in `changed()` keep their order and run as
  before; only what is broadcast after them changes.
- **The page's stream** in `query.ts`, free of React and tested like `Query`: the per-project `seq`, the kept messages,
  the gap and the reloads; `Query` gets a variant that holds a reply and applies messages (the state, a log, a chat
  view, the conversation list).
- **The acceptance test**: a dashboard client in a test (a WebSocket and the fake runtimes running a queue) applies
  every message and, after each, holds the same state, activity, chat and conversation list as a full read at the same
  `seq`; a dropped message (the test skips one) and a reconnect make it read in full.

## Built in SD2

As planned above, with these differences and findings:

- **The reload limit has a floor**: a state delta goes as a reload only when it is larger than half the state *and*
  than 64 KB. On a small project one queue's view is half the state, and the first version reloaded on every step's
  change (the API test showed it).
- **A state message may carry the summary alone**, and the first publication after no socket was open is a `reload`
  (nothing to diff against); a page's first reads ask after it, so it costs nothing.
- **Every read and write under `/api/projects/:id/` publishes** (a middleware), not only the live views' reads: a read
  then names where the stream stood, a write where it left it. When nothing changed this costs a comparison of the
  same state object and of the orchestrator's head.
- **Logs are sent only once a reply has read them** (`LiveStream.opened`): the stream keeps for each such log how far the
  views hold it, and a log no reply read cannot be held by any view, so its lines are not sent (the measurement's
  streaming sessions sent 8 log messages a minute instead of 179).
- **A reply can land before the socket brings the messages up to where it stands** (the HTTP answer overtakes the
  socket): the view waits for them (`Stream.reached`) before it is fed. Without it the view was shown but never fed.
- **The project list** is read at its version (a reconnect, `projects`) and overlaid with the summaries the state
  messages bring, each newer than the line's `seq`; it is not a `LiveView` because it spans projects.
- **One view per URL**, shared by every component that shows it (`useLiveRead` in `api.ts`): the state is read once
  for the page and `IdeaLinks`, the conversation list once for its four readers. The first build let a remount's
  cleanup drop the URL's entry while another view held it: every landing made a new view and read again (10,000
  requests a minute in the measurement); the cleanup now lets go only of its own view.
- **The heads** are `Orchestrator.head()` and `Conversations.head(id)`, the views without their chats (the views are
  built from them), and `Conversations.item(id)` the list's line of one conversation.

Tests: `packages/protocol/test/live.test.ts` (the diff and apply over a derived state changing, and every list case),
`apps/web/test/live.test.ts` (the stream and its views: fed after the reply, messages during a read, a gap, a new hello,
a reply from before the socket or another server, a reload, a write's wait, a reply before its messages; the
appliers), `apps/web/test/query.test.ts` (what each message bumps), `apps/server/test/live-api.test.ts` (a real server
running a queue on the fake runtimes: a client applying every message holds, at each sequence number, the state and the
activity a full read at that number holds; no gap on one socket; a write's outcome shows where its answer stands).

**The measurement** (the user's question: requests a dashboard sends in a minute of an active run). `node
scripts/perf-load.ts --minutes 2 --dashboards 0 --page`: the generated project the size of Nexus's own, two queues
running on the fake runtimes (20-second steps, accepted as they come), an agent's activity appended every 400 ms, and
the real dashboard in headless Edge at 1440 px on a running step, its fetches and socket messages counted in the page
after it settled. Before: SD1's code (`9bcace6`, the dashboard built from it); after: SD2's.

| | Before | After |
|---|---|---|
| Requests a minute | 834 | 87 |
| … the state, the orchestrator's chat, the conversations, a step's activity and refusals | 20 + 179 + 179 + 179 + 179 | 0 (applied); 1 activity and 1 refusals read at a step's switch |
| … the project list | 20 | 0 |
| … the server, the digest, the usage | 20 each | 23 each (on a queue's change) |
| … a step's commits | 20 | 15 (its queue's changes only) |
| Bytes of the replies a minute | 68.6 MB | under 0.05 MB |
| Socket messages a minute | 183 (`changed`, `log`) | 55 (47 state deltas, 8 activity lines of the held log) |
| Steps done in 2 minutes | 10 | 10 |
| Event loop delay p50 / p99 | 15.9 / 85.5 ms | 15.9 / 100.9 ms |

The page asks a tenth of what it asked, and the bytes fall from about a megabyte a second to nothing worth counting:
the state is no longer sent whole on a change. The loop's figures are the run's step boundaries (their synchronous
git, performance.md), unchanged; the server's own share of the reads fell with them (`GET …/state` was 38 a minute of
about 10 ms each, `conversations` 343 of 7 ms). What is left are the narrowed reads that span projects (`server`,
`digest`, `usage`) on every queue change, about once every two seconds here: "Not modified" below would take most of
them.

## Beyond the decision (proposals, not decided)

- **Subscriptions**: every socket gets every project's messages today, and after SD with their content. A page could
  say what it shows (its project, the sessions of its open views) and get only those; the per-project `seq` already
  allows it. Worth it with several projects or a phone on a slow link.
- **A step as the unit of a queue's delta**: a running queue's whole view (about 50 KB) goes out on each of its events.
  If the measurement shows these dominate, a queue's steps become a keyed list of their own.
- **The state without closed queues' details**: the 7.3 MB a page reads at its start is mostly closed queues'
  timelines, which a list does not show. Their summaries in the state, their details read when a queue is opened, as
  the archiving decision says for logs (docs/design/model.md, "What it holds"). The largest remaining cost of a full
  read, and so of every reconnect. Built in queue AQ ([archive.md](archive.md)): 7.4 MB became 1.5 MB on the
  synthetic tree at 1×, 30.1 MB 6.2 MB at 4×.
- **Compression**: `permessage-deflate` on the socket and gzip on the full reads (JSON of this shape shrinks several
  times); mostly for the phone over Tailscale.
- **Git as a change**: the queue git and commits reads are narrowed to their queue's deltas, but commits move without a
  state change (a worker commits mid-step). The server could notice a queue's checkout's HEAD moving (the step
  boundary already reads it) and send a `git` message for that queue, so those reads are asked only when commits moved.
- **"Not modified" for the narrowed reads**: `estimates`, `digest`, `server` could answer 304 for a `seq` they already
  answered (performance.md, "The dashboards' reads keyed on the version").
- **A check of the held state**: each state delta could carry a hash of the full state it leads to, and a development
  build compare it with the held state's, so a drift between the diff and the apply shows at once rather than as a
  wrong view. The SD2 test covers the rules; this would cover what the tests do not reach.
- **Identity in place of text**: a derivation per queue that reuses an unchanged queue's view (docs/design/model-built.md,
  "Beyond the decision") would let the diff compare by identity instead of serializing every part on every change.
- **Coalescing for a slow socket** instead of closing it: the pending deltas merged into one (later members replace
  earlier ones), so a slow link gets one delta rather than a full read.
- **Ideas as deltas**, once the notes folder is a part of the model.
