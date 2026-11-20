# Server API

Part of [the protocol](../PROTOCOL.md).

See also: [Dashboard question links](sessions.md#dashboard-question-links).
See also: [Removing a project](files.md#removing-a-project).

## Server API

The replies the dashboard reads are typed once, in the protocol's types-only module `@nexus/protocol/api`
(`ProjectSummary`, `StepCommitsView`, `BranchView`, `LeftView`, `CommitDetail`, `ModelInfo`): the server builds them as
these types and the dashboard reads them as the same, so a change on one side fails the other's typecheck.

Reads: `GET /api/projects` (with each project's "waiting for you" list; a question's item carries its `qid` and its
`options`, if it has any), `GET /api/projects/:id/state`,
`GET /api/projects/:id/file?path=` (files under the project, its worktree directory or a session's directory only;
see "Files and commits" below), `GET /api/projects/:id/commits/:hash` (one commit; see there too),
`GET /api/projects/:id/rules` (the rules files' check: `{ state, agents, claude, unseen_by?, fix?: { changes: [{ file,
action, before?, after }], imports }, version, root }`; see ["A project's rules files"](files.md#a-projects-rules-files)).
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
| `POST /api/projects/:id/queues/:q/approve` | `words?`, `work?` (`keep` or `discard`), `skip_closing?` (boolean) | Approves the current revision; for a stopped queue it also lifts the stop (see `queue.yaml`). `work` is required when the stopped step left commits of its own and no Discard is recorded; with `discard` nothing is approved (see ["The work a stopped step left"](queues.md#queueyaml)). `skip_closing: true` skips the queue's closing refactoring step with the lift; refused (409), before anything is recorded, when the queue is not stopped, has no closing step or it has run (see ["The closing refactoring step"](queues.md#the-closing-refactoring-step)) |
| `POST /api/projects/:id/queues/:q/withdraw` | `reason?` | The user takes back the approval of a queue that never ran. There is no CLI command and no event for it |
| `PATCH /api/projects/:id/queues/:q` | `review_level` (1, 2, 3 or null: the project's) | Queue settings; not pinned by an approval |
| `PUT /api/projects/:id/queues/:q/steps/:s/level` | `level` (1, 2, 3 or null: the step's drafted level) | The user's review level of a step (`user_levels`); asks for no new approval, and later revisions keep it |
| `POST /api/projects/:id/questions/:qid/answer` | `text`, `continue?` | The user's answer, routed to the asker |
| `POST /api/projects/:id/queues/:q/run` | `action` (`start`, `pause`, `resume`, `stop`, `stop_at_once`, `cancel_start`), `runtime?`, `model?`, `effort?`, `session?`, `after?`, `next?`, `at?` | Runs the queue through a Nexus-launched session (`session` continues an existing one). `start` with `after` (a queue id or a list): the user's place for the queue in the plan, it starts when those are done; with `next: true`: in the plan with none before it (`{message}`; see ["The plan"](planning.md#the-plan)); with `at` (ISO 8601, or `usage-reset`): a schedule (`{message}`); `cancel_start` takes the queue out of the plan (`{message}`). `stop` pauses and sends the existing Stop now message (`text?` supplies the reason). `stop_at_once` pauses, interrupts the turn and kills only this queue's worker process, waiting for its exit before success; keeps uncommitted changes and the session, writes `step.interrupted`. No worker, a finished run, a stop already in progress or a session reused by another queue: 409. Resume during exit: 409; afterwards it continues the step in the same session. No CLI or orchestrator request action exposes `stop_at_once` |
| `GET /api/projects/:id/estimates` | | Expected times of the project's open queues, as estimates (`{ samples, min, queues: { <id>: { steps, ms? } } }`): `steps` the steps left (not closed), `ms` their expected time, absent while fewer than `min` (5) steps are finished. A finished (done) step's time is the sum of its worker turns' `duration_ms` in `turns.jsonl` (send-back rounds included, the wait for its review not), over every project the server has; a step to come takes the average of those on its model and effort, else its model, else all, each from at least 5 steps |
| `GET /api/projects/:id/ideas/matches` | | The suggestions for matching the earlier queues to the notes' entries (`IdeaMatchesResponse`: `items`, in the queues' order, each with `queue`, `ref`, `kind`, `quote`, the queue's `title`, `status`, `finished_at?` and `commit?`, the entry's `lead?`, and the user's `decision?` (`accepted`, `at`)); a decided match whose suggestion is gone stays listed (see ["Conversations"](conversations.md#conversations), matching). Unknown project: 404 |
| `POST /api/projects/:id/ideas/matches` | `items` (`[{ queue, ref }]`), `accept` (true, false, or null to return to pending), `revision`, `request_id` | The user's decision on suggestions, recorded with history in `idea-matches.yaml`; an item that is no suggestion (nor decided before) is 404. The revision comes from GET matches or links. Same-origin JSON; stale revision or reused ID with different payload: 409 |
| `GET /api/projects/:id/ideas/links` | | `IdeaLinksResponse`: `revision`, `items` (each origin, effective state, own evidence and diagnostics), `history` (reasoned before/after actions). Includes missing queues/notes/dates and inactive origins |
| `POST /api/projects/:id/ideas/links` | `request_id`, `revision`, `reason`, `operation`, operation-specific fields below | Dashboard-only atomic relationship correction. Returns the saved action in `result`; identical retry returns that action, even after restart. Invalid input/target: 400; missing queue/origin/action: 404; stale revision, concurrent save, duplicate edge, newer touched origin or request-ID collision: 409 |
| `GET /api/projects/:id/ideas/statuses` | | Effective dated-entry dispositions, assessments, work states, diagnostics, snapshots, history, invalidations, missing records and a revision token (`IdeaStatusesResponse`) |
| `POST /api/projects/:id/ideas/statuses` | `request_id`, `revision`, `ref`, `reason`, `operation`; optional fields below | Dashboard-only reasoned status action, returned in `result`. Same-origin JSON. Invalid input/target/blocker: 400; missing dated entry/action: 404; stale/concurrent save, newer entry action or conflicting request ID: 409. No queue, run, plan or note writes |
| `GET /api/projects/:id/ideas` | | The ideas overview (`IdeasResponse`: `notes_dir`, null without a notes folder; `notes`, each with `file`, `title`, `summary?`, `area?`, `group?`, `area_from?` (`note` or `queues`), `open` and `questions` (its Open questions' text), `ideas`, `status` and `queues`, and its `entries`, each with `ref`, `date`, `headings`, `lead`, `decisions`, `dropped?`, `replaced_by?`, `status`, `queues` and `history`; `unknown_refs`, queues' references to nothing; `to_match`, the suggestions for earlier queues still to decide: `suggestions` and `queues`). Derived on each request from the notes, the queues and the hand-over records; the notes are only read (see ["Conversations"](conversations.md#conversations)). Unknown project: 404 |
| `GET /api/projects/:id/metrics` | | The project's metrics and their values (`ProjectMetrics`: `metrics`, its own definitions and every check's time seen, `check:<name>`; `values`, oldest first, each a `StepView.metrics` entry with its `queue` and `step`); see ["Project metrics"](stats.md#project-metrics). Unknown project: 404 |
| `GET /api/stats?by=&project=&since=&kind=&activity=&area=&size=&origin=` | | The statistics (`StatsReport`, see ["Statistics"](stats.md#statistics)): every registered project, or one (`project`; unknown: 404), grouped by `by` (`model`, `effort`, `kind`, `activity`, `area`, `size`, `origin`; default `model`; another: 400), the steps whose last outcome is at or after `since` (a date or a time; unreadable: 400), narrowed to the steps under each tag value given (`kind=code`, `area=p/engine` across projects; the value as the groups name it); with `reviews` (`ReviewStats`, see ["The review helper"](review.md#the-review-helper)), for the same project and `since` |
| `GET /api/usage/days?since=` | | The usage windows day by day for the global Stats view (`UsageDays`, see ["Statistics"](stats.md#statistics)) from `since` (a date or a time; default 30 days ago; unreadable: 400) to today, with `threshold`, the global `defaults.usage_pause_threshold` |
| `POST /api/projects/:id/tags/:proposal` | `action` (`accept`, `decline`) | The user's decision on the orchestrator's proposal for the project's tag lists (see ["Tags"](stats.md#tags)); only the user: no CLI command or event does it (`{message}`) |
| `GET /api/projects/:id/templates` | | The queue templates in effect for the project (`TemplatesResponse`: `templates`, each with `id`, `title`, `description?`, `layer`, `replaces`, `params` and a maintenance template's `maintenance`; `problems`, the files not used with why), for "New queue from template" (see ["Queue templates"](planning.md#queue-templates)) |
| `POST /api/projects/:id/recurring/:rid` | `action` (`approve`, `pause`, `resume`) | The user's standing approval of a recurring queue as it is now (its hash), a pause or its end (see ["Recurring queues"](planning.md#recurring-queues)); only the user: no CLI command or event does it. Already approved, already paused or not, or a recurring that cannot run (its template gone or not filling): 409; unknown: 404 (`{message}`) |
| `DELETE /api/projects/:id/recurring/:rid` | | The user removes a recurring queue; the queues it made stay (`{message}`) |
| `POST /api/projects/:id/queues/:q/plan` | `action` (`move`, `add`, `remove`, `undo`, `accept`, `decline`, `hand_back`), `after?`, `change?` | The user's plan: `move` the queue after `after` (a queue id; `null`: with no queue before it), as in a list (see ["The plan"](planning.md#the-plan)); `add` a predecessor `after`, or `remove` one; `undo` the change `change` within its window; accept or decline the orchestrator's proposal; hand a dependency the user set (`after`; without it, all of them) back to the orchestrator. `move`, `add` and `remove` answer `{message, undo: {change, until, queues}}`, the others `{message}` |
| `POST /api/projects/:id/queues/:q/steps/:s/pictures/mark` | `path`, `accepted` | The user's mark on a review picture (`review.marked`) |
| `POST /api/projects/:id/queues/:q/steps/:s/pictures/comment` | `path`, `text` | The user's comment on a review picture: a send-back or a note (see ["Review pictures"](review.md#review-pictures)); answers `{ ok, result: { message } }` |
| `POST /api/projects/:id/queues/:q/steps/:s/reject` | `text?` | Reject (the user's): the step is rejected, the run pauses until a newer revision is approved; answers `{ ok, result: { message } }` |
| `POST /api/projects/:id/queues/:q/steps/:s/confirm` | | The user confirms a provisional acceptance (`review.confirmed`); answers `{ message }`. Fix it on one is `…/send-back` (`review.fix_asked`) |
| `POST /api/projects/:id/queues/:q/steps/:s/accept` | `text?` (the note), `note_to?` (`next` or `orchestrator`) | Accepts a step waiting in review (and, with `push_accepted`, pushes it); answers where the note went (`to`, `step`) |
| `GET /api/projects/:id/queues/:q/steps/:s/commits` | | A step's commits per round: `{ rounds: [{ session, start, end, open, commits: [{ sha, subject, author, at, files, insertions, deletions, foreign }] }] }`, newest first; an open round runs to HEAD; null outside a git repository or with nothing recorded |
| `GET /api/projects/:id/queues/:q/git` | | The queue's branch: `{ branch, base?: { ref, ahead, behind }, upstream?: { ref, ahead, behind, at? } }`; null outside a git repository, before an auto worktree exists, or on no branch |
| `POST /api/projects/:id/queues/:q/merge` | | Merge back a finished worktree queue's branch into its base (see ["Merge back and clean up"](git.md#merge-back-and-clean-up)); answers `{ ok, result: { message } }` |
| `POST /api/projects/:id/queues/:q/cleanup` | | Clean up a finished worktree queue: the worktree removed, its branch deleted with `-d`; answers `{ ok, result: { message } }`. Refused while the worktree has uncommitted changes; the refusal names them as git status does (`?? tmp/`, `M a.txt`, up to 20) |
| `POST /api/projects/:id/rules/fix` | `version` (the check's) | The fix of the rules files as the check showed it (see ["A project's rules files"](files.md#a-projects-rules-files)); answers `{ ok, result: { message } }`. Commits nothing |
| `POST /api/projects/:id/queues/:q/push` | | Push again: the step of the queue's last failed push; answers `{ ok, result: { message } }` at once, the push runs in the background |
| `POST /api/projects/:id/queues/:q/steps/:s/send-back` | `text` (required, kept verbatim) | Fix it: sends a step waiting for the user's review back to its worker; on a provisional acceptance it asks the orchestrator for a fix (`review.fix_asked`); answers `{ ok, result: { message } }` |
| `POST /api/projects/:id/queues/:q/continue` | `work?` (`keep` or `discard`), `skip_closing?` (boolean) | Continue: lifts the stop of a stopped queue whose current revision is approved and goes on (see ["Continue"](queues.md#queueyaml) under `queue.yaml`); refused (409) otherwise. `work` is required when the stopped step left commits of its own; `discard` records it and does not go on. `skip_closing: true` skips the queue's closing refactoring step with the lift; refused (409), before anything is recorded, when the queue has none or it has run (see ["The closing refactoring step"](queues.md#the-closing-refactoring-step)) |
| `GET /api/projects/:id/queues/:q/left` | | What a stopped queue's stopped step left (see ["The work a stopped step left"](queues.md#queueyaml)); null when not stopped at a step |
| `GET /api/projects/:id/sessions/:session/chat` | query `from`, `to` (lines) | A chat's entries with lines from `from` up to, not including, `to`: `{ chat: [entry + line] }`; what is older than a chat view's window. Only the orchestrator's or a conversation's session (404 otherwise) |
| `GET /api/projects/:id/sessions/:session/chat/search` | query `q`, `tools` (`1`: tool lines too) | Search over the whole chat.jsonl, not only a view's window: `{ lines }`, the lines of the entries that contain `q`, oldest first; case and accents ignored, the query's spaces collapsed (`searchChat` in `@nexus/protocol/chat`) |
| `GET /api/projects/:id/search` | query `q`, `kinds`, `since`, `limit`, `tools` | The project's whole history searched, from its files without an index: `{ hits, total, more }`, newest first; see "Searching a project" below. Refused (400): no words, an unknown kind, an unreadable time, a limit out of range |
| `POST /api/projects/:id/sessions/:session/pins` | `line`, `pinned` (true or false) | Pins or unpins a message of the orchestrator's or a conversation's chat (sessions/<id>/pins.json); answers `{ ok, result: { pins } }`. Refused (400): a line that holds no entry or a tool line (when pinning), a line that is not a whole number |
| `POST /api/projects/:id/orchestrator/messages` | `text` | A chat message to the orchestrator (starts or wakes it) |
| `POST /api/projects/:id/orchestrator/reset` | | The next message starts a new orchestrator session |
| `POST /api/projects/:id/orchestrator/stop` | | Stops the orchestrator's running turn (see ["Stopping a chat agent's turn"](orchestrator.md#stopping-a-chat-agents-turn) under ["The orchestrator"](orchestrator.md#the-orchestrator)); refused (409) when it is not in a turn |
| `POST /api/projects/:id/orchestrator/settings` | `model`, `effort` (empty: the default) | The orchestrator's model and effort, from its next message on |
| `PATCH /api/projects/:id/settings` | `name`, `runtimes`, `defaults`, `conversations`, `languages` (`reader`, `working`), `orchestrator` (`runtime`, `notify`, `model`, `effort`, `fallback`, `context_threshold_tokens`) (an empty value clears a field), `own?`, `follow?` (lists of setting keys, `runtimes.claude.model`) | Project settings, checked against the schema (see ["Global settings"](settings.md#global-settings)): a setting given another value, or named in `own`, becomes the project's own (in `own` also when it equals the global value); one named in `follow` follows the global value again; naming one in both is refused |
| `GET /api/projects/:id/settings` | | `own` (the keys of the settings the project has its own value of) and `global` (the global settings) |
| `GET /api/settings`, `PATCH /api/settings` | the global settings, nested as in `settings.yaml` (null or empty clears an optional one) | The global settings (`global`; GET also `keys`, every setting with a global value). PATCH writes `<NEXUS_HOME>/settings.yaml`, checked against the schema; every project that follows a changed value has it at once |
| `POST /api/projects/:id/uploads` | `data` (the picture, base64, optionally as a `data:` URL) | Saves a picture for a chat message under `.nexus/uploads/` and answers `{ ok, result: { path, type, bytes } }`: `path` absolute (forward slashes), `type` `png`, `jpeg`, `webp` or `gif`. See "Uploads" below |
| `GET /api/projects/:id/removal` | | Whether the project may be removed now, and what goes with it or stays (`RemovalView`, see ["Removing a project"](files.md#removing-a-project)): `name`, `blockers` (one sentence each; empty: it may go), `planned` (`queue`, `after`) and `scheduled` (`queue`, `at`) starts and open `questions` (`qid`, `queue?`, `step?`, `text`), which go with it; `worktrees` (`queue`, `path`, `branch?`, `exists`), which stay; `nexus_dir`, the folder Delete deletes, and `delete_refused?`, why it may not |
| `POST /api/projects/:id/remove` | `delete_data?` (boolean), `name` (with `delete_data`: the project's name as typed) | Removes the project from Nexus; with `delete_data` its `.nexus/` folder is deleted too (see ["Removing a project"](files.md#removing-a-project)). Answers `{ ok, result: { removed, nexus_dir? or deleted?, worktrees } }`. Refused: 409 with `blockers` while anything runs, 409 when the folder may not be deleted (`delete_refused`) or the project is not registered in this server's NEXUS_HOME, 400 without the name. The user's only: no CLI command does it |
| `POST /api/projects/:id/settings/allow-rule` | `rule` | Adds an allow rule for Claude Code workers to `runtimes.claude.allowed_tools` in `.nexus/project.yaml` (once; a rule already there is left as it is), typically from a refusal. A tool name, optionally with a specifier in parentheses, on one line. Like every write, only from the dashboard's own page: an agent must not widen its own permissions. Nothing else is written, not the project's `.claude/settings.json` or `AGENTS.md` |

Also `GET /api/projects/:id/sessions/:session/activity?queue=&step=&limit=`, `GET /api/projects/:id/refusals?queue=&step=`
(the refused actions of every session of the project, oldest first; optionally only a queue's or a step's), `GET /api/projects/:id/orchestrator`
(its session, state, chat: the newest 300 entries, each with its `line`, and `pins`: each pin's `line`, `at` and `entry`,
wherever in the chat it is; a fresh session has none; and `earlier`: the sessions it went on from by its context care,
oldest first, each `{ session, created_at, chat, switch: { at, fill, tokens, summary } }`, its newest entries in what the 300
leave over, at least 60, `fill` from 0 to 1 or null, `tokens` its context tokens or null (unknown before queue CT) and `summary` its `{ text, topics, files, at }` or null; the
dashboard shows them above the current chat, a "Fresh session" line at each switch), `GET /api/digest?since=` (below), `GET /api/usage`, `GET /api/capacity` (the capacity coordinator's file, see ["The capacity coordinator"](checks.md#the-capacity-coordinator)) and `GET /api/models/:runtime`: the models a runtime offers, asked from the runtime itself
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
`Content-Length`, or while a body without one streams in); a larger one gets 413 and the connection is closed. Before
it answers, the server reads the rest of a refused body and throws it away (RFC 9112, 9.6), so that the close is clean
and the client receives the 413 rather than a reset: at most 64 MiB in all (a body declared larger is answered at
once) and for at most 5 s from the refusal; past either bound it answers and closes, and the client may then see a
reset instead. The
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
["How the engine runs a Codex session"](runtimes.md#how-the-engine-runs-a-codex-session)).

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

The public exceptions are `/login`, `/manifest.webmanifest`, `/sw.js` and paths under `/icons/`, classified using
Hono's routed path. Public file requests end at the static handler: a missing file or an encoding the adapter
rejects returns **404**, `text/plain`, body `404 Not Found`, never the dashboard's `index.html`. This also applies
to signed-in and direct local requests. No extra decoding is performed by Nexus. If normalization instead produces
a protected path, the access guard still runs first (302 to `/login` for pages, 401 for API requests without a token).
The authenticated `/`, `/index.html` and other dashboard deep links retain their SPA fallback. Login, token cookies,
WebSocket authorization and the API's Origin/JSON requirements are unchanged.

**Push.** `GET /api/push/key` (the VAPID public key), `POST /api/push/subscribe` (`subscription`, `label`,
`timezone?`: the device's IANA time zone), `POST /api/push/unsubscribe` (`endpoint`), `POST /api/push/test`
(`endpoint?`), `GET /api/push/settings?endpoint=` (a device's notification settings: `{ settings }`, the defaults for
a device that has none; 404 for an endpoint not subscribed) and `PUT /api/push/settings` (`endpoint`, `settings`:
replaces them; 400 with what is wrong, 404 for an endpoint not subscribed; answers `{ settings }` as stored). Keys and
subscriptions are in `<NEXUS_HOME>/push.json`, written by the server only:

```json
{ "vapid": { "publicKey": "…", "privateKey": "…" },
  "subscriptions": [{ "endpoint": "https://…", "keys": { "p256dh": "…", "auth": "…" }, "label": "Android", "added_at": "…",
    "notify": { "off": ["review"], "quiet": { "on": true, "from": "22:00", "to": "07:00" }, "urgent": true, "timezone": "Europe/Budapest" } }] }
```

Whatever newly appears in a project's "waiting for you" list is pushed; the list as found when the server starts is
the baseline. Every push has a kind, and each device gets it only when its `notify` lets it through
(`@nexus/protocol` notify.ts, `shouldNotify`): the waiting list's kinds (`question`, `stopped`, `approval`, `review`,
`failed`, `start`, `provisional`, `plan`, `merge`, `tags`, `recurring`, `cleanup`), `update_failed` (an update of Nexus failed),
`deploy` (a planned deploy waits or was dropped), `cancelled` (the orchestrator cancelled a queue), and `test`, which
always goes. `off` lists the kinds turned off (a kind not listed is on). Within the quiet hours (`quiet.on`; `from` up
to `to`, `HH:MM` in the device's `timezone`, over midnight when `from` is later; none when they are equal) nothing
goes, except `stopped`, `failed` and `update_failed` when `urgent` is true; what they hold back is not sent later (the
waiting list and the digest show it). A subscription without `notify` (from before them), or with values that do not
parse, gets the defaults: every kind, no quiet hours, `urgent` false. Subscribing the same endpoint again keeps its
`notify`; a `timezone` sent with it replaces the zone. The in-tab notifications (where push is not available) filter
the same way with settings kept in the browser's localStorage (`nexus.notify.settings`, the same shape).

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
prints. A step is running now when the derivation says `running` and its queue's run is going, or it has none (a session Nexus did not start works on it) (`stepWorkedOn`,
status-rules.ts; queue EF): a run the user stopped (paused, "stopped by the user") keeps its step `running` in the
derivation, as the step it goes on with at Resume, and its queue `running` too, but no agent works on it, so it is
not listed here, an update neither holds nor waits for it, and `GET /api/projects` does not count it in `running`
(`queueWorkedOn`); the dashboard shows such a queue as paused, and `nexus status` prints its `run:` line. `POST /api/server/update` (`now?`, `ref?`, `by?`) and `POST /api/server/cancel` start and cancel an update.
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

**The server's measurements of itself** (docs/design/performance.md). `GET /api/server/perf` (read-only, also while a
successor stands by) gives what the server measured since its start: `since`, `block_ms` (200), `loop` (the event
loop's delay: `mean_ms`, `p50_ms`, `p99_ms`, `max_ms`) and `loop_window` (the same since the last summary in the log,
with its `since`); `routes`, each `route` ("GET /api/projects/:id/state") with `count`, `total_ms`, `mean_ms`,
`max_ms`, `sync_max_ms` (the longest synchronous part), `slow` (requests of `block_ms` or more) and `statuses` (count by
status), the most total time first; `spans`, the measured synchronous operations by their path ("GET
/api/projects/:id/queues/:queue/git > git rev-parse", "state <project>", "engine (<project>)", "engine start
<project>"), each with `count`, `total_ms`, `mean_ms`, `max_ms`, at most 40, the most total time first; `blocks`, the
latest 50 times the loop was blocked `block_ms` or more, newest first, each `at`, `ms` and `during` (the longest five
spans that ended in it, `what` and `ms`; empty when nothing measured ran). The same blocks and the requests of
`block_ms` or more are written to the server's log as they happen (`perf: …` lines), with a summary every 10 minutes.

**Server crash.** An uncaught exception still ends the server (it logs the stack and exits with 1); it also writes
`<NEXUS_HOME>/crash.json` first (docs/protocol/files.md). `GET /api/server` gives `crash`: the latest crash as `at`
and `error` (its first line), until the user closes its notice; null otherwise. `POST /api/server/crash/dismiss`
(`at`: the crash's time) closes it in every dashboard, answering `crash` (null); 400 without `at`, 409 when that is no
longer the latest crash. Every project's orchestrator session that ran before the crash is told it once
(`notify:crash:<at>` in its `applied.jsonl`), whether or not the user closed the notice. A rejected promise nobody
handled is no crash (queue LF, F1): it is logged (`unhandled rejection (the server goes on): <stack>`) and the server
goes on, as one background chain's failure belongs to its run, not to every worker.

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
