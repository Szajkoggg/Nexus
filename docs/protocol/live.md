# The live stream

Part of [the protocol](../PROTOCOL.md).

See also: [Server API](api.md#server-api).

## The live stream (WebSocket)

**Status: planned (queue SD, step SD1); built with SD2.** Until then the stream is the one
[Server API](api.md#server-api) names: `changed`, `log`, `projects` and `server`, with no content. The reasons are in
DESIGN.md, ["The dashboard gets the changes"](../design/live.md).

A WebSocket at `/ws` (the same authorization as the API: docs/protocol/api.md, remote access) sends the changes
themselves; the dashboard holds what it shows and applies them. Agents never read it.

### Messages

Every message is one JSON object with a `type`. Every message about a project carries `project` and `seq`: the
project's sequence number, one counter per project in the server process, moving by one per message about that project,
starting at 0 when the process starts.

| `type` | Fields | Meaning |
|---|---|---|
| `hello` | `epoch`, `projects` (`{ <id>: <seq> }`) | The socket's first message: the server process (`epoch`, new for every process) and each project's `seq` now |
| `state` | `project`, `seq`, then either `reload: true` or `set?`, `upsert?`, `remove?`, `order?`, `summary?` | The project's state changed (below) |
| `log` | `project`, `seq`, `session`, `log` (`activity`, `chat`, `refusals`, `pins`), then `entries` (`pins` for `pins`) or `reload: true` | Lines appended to one session's log since the last message about it, as the files hold them (a chat entry with its `line`); at most one per session and log every 150 ms; `pins` the whole pin list; `reload` when the log was read again from its start or the lines exceed 256 KB |
| `session` | `project`, `seq`, `session`, `head` (`state`, `runtime`, `model`, `effort`), `conversation?` | A chat agent's head changed: its process state (`working`, `idle`, `exited`), runtime record, model or effort; for a conversation also its list item (as `GET …/conversations` lists it) |
| `projects` | | The project list changed (a project added or removed): read it again |
| `server` | | The server's own state changed (update, plan, away, capacity): read `GET /api/server` and its neighbours again |

The `changed` message goes; so does `log` without content.

**A state message** holds the parts of `ProjectState` (`@nexus/protocol`) that differ from the state of the project's
previous `state` message:

- `set`: the whole parts replaced: any of `project`, `away`, `tags`, `metrics`, `attention`, `warnings`,
  `generated_at`.
- `upsert`: `{ queues?, sessions?, questions?, recurring? }`, each a list of whole members (a `QueueView`, a
  `SessionView`, a `QuestionView`, a `RecurringView`) that are new or changed; a member replaces the one with its key
  (`id`; `qid` for questions) or is added.
- `remove`: `{ queues?, sessions?, questions?, recurring? }`, each a list of keys gone.
- `order`: `{ queues?, sessions?, questions?, recurring? }`, each the list's keys in their order, sent when members were
  added, removed or moved; without it the order stays (an added member without an order would not happen).
- `summary`: the project's line in `GET /api/projects` (`ProjectSummary`), when it changed.
- `reload: true` in place of all of these: the change is too large to be worth a delta (larger than half the state);
  read the state in full.

Applying a state message to the state held at the previous `seq` gives the state the server holds at this one.

### Where a reply stands

The replies a view applies messages to name the stream position they hold, in a response header:
`Nexus-Seq: <epoch> <seq>` (the project's), for `GET /api/projects/:id/state`, `…/sessions/:s/activity`,
`…/refusals`, `…/orchestrator`, `…/conversations`, `…/conversations/:id`; `GET /api/projects` gives each line its own
in `ProjectSummary.seq` (and the `epoch` in the header alone: `Nexus-Seq: <epoch>`). Before answering, the server sends
what is pending for the project (its state's message if the state changed, the log messages waiting for their 150 ms);
the reply then holds every change up to the `seq` it names and none after.

A user's write (every `POST`, `PUT`, `PATCH`, `DELETE` of a project under `/api/projects/:id/…`) sends its project's
pending messages before it answers, and the answer carries `Nexus-Seq` too: the dashboard's control shows the write's
outcome once its views stand at that `seq` or beyond.

### The dashboard's rules

- Apply a project's messages in `seq` order, each to what was held at the one before. A `seq` that is not the next one
  is a gap: read every view of the project in full.
- A reply at `seq` S takes the messages after S. A reply at S below the `seq` the socket's `hello` named for the project
  is read again (messages between were sent before the socket listened).
- Read every view in full when the socket opens (first time or again) or the `epoch` changes; a part's views on its
  `reload`.
- The server closes a socket whose unsent data passes 8 MB; reconnecting reads in full.
