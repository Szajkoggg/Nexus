# Conversations

Part of [the protocol](../PROTOCOL.md).

See also: [Stopping a chat agent's turn](orchestrator.md#stopping-a-chat-agents-turn).

## Conversations

`project.yaml` holds `conversations: { notes_dir?, runtime, model?, effort?, web }`. A conversation is a session with
role `conversation`: a thinking partner the user talks with about the project, one session per topic, with its chat
in `chat.jsonl` (`from: partner` for its replies, whole). It reads the whole project and writes only in `notes_dir`
(relative to the root, checked to lie inside it): Claude Code runs it in `dontAsk` mode allowed `Read`, `Grep`,
`Glob`, `nexus status`, `nexus ideas status`, `nexus help`, `nexus doc`, `nexus tags` and read-only git (`git log`, `git status`, `git diff`, `git show`) on both shell
tools (`Bash(nexus status:*)` and `PowerShell(nexus status:*)`, and so on), and `Edit(<notes_dir>/**)` and `nexus covers`
(which appends to its own events) only with a notes folder; Codex runs it
with `notes_dir` as its working directory in a `workspace-write` sandbox whose one other writable root is its own session
folder, for `nexus covers` (`read-only` without a notes folder), approval
`never`, where its commands (`nexus help` among them, which only reads) run in the sandbox. Its briefing points it to
`nexus help` for how Nexus works (decided 2026-11-15, queue OP). It starts no work. An idle partner's process ends after 15 minutes; the next message resumes the conversation.

**The ideas overview** (`ideas.ts`, `ideas-read.ts` in the protocol package; docs/ux/ideas-overview.md). The notes in
`notes_dir` are read, never written, as topics: the title (the first `# ` heading), the `**Summary:**` line and the
`**Area:** <area> [/ <sub-group>]` line under it, the Open questions and the Ideas (top-level bullets under headings
named so), and the dated Decided entries. A Decided section is a heading named "Decided" at any level, up to the next
heading of its level or above; in it a heading that begins with a date, or ends with `(decided <date>)`, starts that
date's entry (a heading `… (decided <date>)` is one anywhere), a deeper heading without a date goes on with it, and the
headings of one date are one entry. An entry's lines `**Dropped:** <date>: <why>` and `**Replaced by:**
<file>#<date>`, written by the partner, mark it so. The partner's briefing asks for these lines (the Summary, one
Area from the project's list, dated Decided entries, Dropped and Replaced by instead of deleting an entry); the
orchestrator's asks it to name the entries a queue carries out in the queue's `source`. The original compatibility `status` field (superseded by IC3's `effective` fields below) is derived: `decided` (nothing
since), `handed_over` (a hand-over record covers it), `queued` (a queue that is not cancelled names it in its `source`,
from the upload on), `built` (every such queue is done), and `dropped` or `replaced`, which win over every other, even
after a queue built it. A topic shows its least advanced live entry, `worked_out` with no entry at all (only dropped or
replaced ones: dropped, else replaced). Its history is in time order: decided (the entry's date), handed over, and each
naming queue's queued (created), approved, started, finished (with its last commit) or cancelled, then dropped or
replaced. A note without an Area line takes the area most of its queues' steps carry. A queue's reference to a note or
an entry that is not there is listed apart (`unknown_refs`).

**Matching the earlier queues** (queue IO4). A queue whose `source` names no note (one from before the field) gets
suggestions, derived on each request from its title, description and step goals, sentence by sentence: a mention of
`<notes folder>/<file>.md` (a note; the README and missing files skipped) with `#<date>` of one of its entries is
`exact`; else the dates of its entries in the same sentence are `dated` (one each); else its latest entry dated on or
before the queue's creation is `file`. One suggestion per queue and entry, the strongest kind, with the sentence it
came from; cancelled queues get none. The user decides in the dashboard (Ideas, Overview, "Manage links"): accept, reject,
or take back; the decisions go to `.nexus/idea-matches.yaml`, written only by the server from the user's request:

```yaml
protocol: 1
matches:
  - queue: PV
    ref: docs/ideas/queue-plan-view.md#2026-11-14
    kind: dated                        # exact | dated | file: how the suggestion was found
    quote: "A felhasználó 2026-11-14-i döntései: docs/ideas/queue-plan-view.md (csak a Decided rész döntés)."
    accepted: true                     # false: rejected
    at: 2026-11-16T08:00:00Z
```

An accepted match counts like the queue's `source` in the derivation (the entry is queued, or built once the queue is
done, with its commit); a rejected one does not. The queues themselves are never changed. No agent decides: `nexus
ideas matches` only lists the suggestions and decisions, and `nexus ideas accept|reject` is refused as the user's.

**Relationship corrections (IC2).** The legacy `protocol: 1, matches: [...]` format remains readable. Its original
accepted and rejected records (including quote, kind and time) are retained as the immutable baseline; saves add
optional `records` and `history` arrays in the same file. There is no destructive migration and no invented old
undo history. A new source and a historical match of the same queue/date are separate origins. Rejecting the match
cannot suppress the source. Effective edges are the union of linked origins after overlays, deduplicated by
queue/date for progress. Queue YAML, approvals, run state and the partner's notes are never written by these actions.

`records` retain each origin's `id`, `queue`, `ref`, `origin` (`source|match|manual`), `state`
(`linked|rejected|pending|removed|ignored`), last-known queue `title`, optional `note_title` and `lead`, its own
`quote`, optional `kind`, evidence `location` (`source`, `title`, `description`, `steps/<index>/title|goal`) and `at`.
Source/match IDs are opaque stable identifiers; manual IDs derive from the request ID. Never construct IDs in a
client: use those returned by GET links. Historical records without evidence location keep that absence.
An `exact|dated|file` kind describes reference syntax only, including example and context mentions. It does not
measure implementation certainty. The API returns each relationship's own sentence, never the queue's first quote.

Match-origin reads (GET links and GET matches) separate live evidence from stored observations:
`current_suggestion` is the freshly derived suggestion (`queue`, `ref`, `kind`, `quote`, `location?`), or null when
the queue no longer provides that reference. `recorded_evidence`, when present, is the stored decision or last-known
snapshot, explicitly historical. For a pending origin with a live suggestion, the top-level quote/kind/location
come from that live suggestion and `evidence_status` is `current`; a stored snapshot cannot override them. Decided
origins keep the evidence recorded with their decision and `evidence_status: historical`; the current suggestion
is separately available. An absent suggestion keeps its last-known quote/identity as historical, with a diagnostic,
never as current evidence. These read-only fields are not persisted as part of a record. Saves refresh pending
observations, while decided evidence remains in records and immutable action before/after history. An explicit new
acceptance uses the current suggestion when one exists; absent references can still be deliberately decided from
their visibly historical evidence, provided any linked target exists.

Each `history` action stores `id` (request ID), `request` (canonical payload hash), `at`, `actor: user`, `reason`,
`operation`, optional `undo` action ID and `changes: [{ before, after }]`. `before: null` means a new manual origin.
All known origins are snapshotted on a successful save; removed targets retain the last identity observed there.
Deleting an unsaved source before any correction cannot reconstruct its vanished title/evidence; legacy matches
still retain their stored queue/ref/quote. Read errors propagate; they are not an empty successful link list.

Operations (all require a nonempty reason, the current revision token and a stable request ID):

| operation | additional fields | effect |
|---|---|---|
| `add` | `queue`, `ref` | Add a manual origin to an existing queue and actual Decided date; reject an already effective edge |
| `replace` | `origin`, `ref` | Remove one linked match/manual origin and add its queue's manual target atomically |
| `remove` | `origin` | Remove only that linked match/manual origin, even when its old target disappeared |
| `ignore-source` | `origin` | Explicitly suppress this source's effective contribution, keeping the original queue source visible |
| `correct-source` | `origin`, `ref` | Atomically ignore this source and add its queue's manual target |
| `decide` | `decisions: [{ origin, accept }]` | Match origins only; accept true, reject false, return to pending null; source/manual origins stay independent |
| `undo` | `action` | Append a compensating action; restore all touched origins atomically, only if none was touched since |

New/restored linked targets must exist in this project's configured notes folder and contain the date. Traversal,
absolute paths and symlink escapes are refused; symlink entries are not notes. A missing queue/source/note/date is
returned in `diagnostics`; removal does not need the old target. Undo cannot restore a now unavailable linked target.
GET matches now also returns `revision`, per-item `diagnostics` and optional `location`; a missing queue has
`status: missing`. GET ideas adds the same `links` response so the overview and agent reads share the effective edges.
`nexus ideas matches` also lists each origin's state, effectiveness, diagnostics and history count. It gains no write
action. The existing dashboard matching client supplies revision/request ID and retains the ID for a failed retry.

The revision hashes the stored file and current relationship inputs (notes, queue identities/sources and the freshly
derived suggestions, including their own quotes and locations). Editing description/goal evidence or removing its
reference invalidates the old revision even when a stored snapshot or prior decision exists for the same edge. Under an
exclusive `idea-matches.lock`, the server re-reads, checks the revision and writes overlay + history in one atomic
YAML replacement. Lock contention fails with 409; it never overwrites a concurrent decision. The lock is removed in
`finally`; an abruptly killed writer may leave it behind. Such a lock fails closed and requires removal only after
the writer is confirmed stopped; it is never stolen based on elapsed time. A committed request ID is checked before
locking and again under the lock, before revision/target validation. Retrieving a committed result is read-only, so
a retry can retrieve it even if the project subsequently changed or a crashed writer left its lock behind.

**User dispositions and implementation assessments (IC3).** The date remains the unit; there is no
per-bullet identifier or migration. GET ideas now also returns `statuses` (the statuses endpoint's response),
`entries[].content` (complete normalized dated content), `entries[].effective` (the matching status view), and each
note's `implementation` roll-up and `needs_attention` count. Consumers must use `effective.disposition`,
`effective.implementation` and `effective.work` independently. The compatibility `status: built` means only the
old linked-work calculation; it is never a user confirmation. No old data creates an assessment.

`.nexus/idea-statuses.yaml` has `protocol: 1`, `records`, `history` and `invalidations` (absent file: empty arrays).
A record identifies `ref`, an optional `disposition` (`state: active|dropped|replaced`, optional `target`, and the
legacy `marker` snapshot seen by that user), and an optional `assessment` (`id`, `kind: partial|full`, `at`,
`reason`, `evidence_refs`, optional `caveat_reason`, and `snapshot`). A snapshot keeps the full normalized
`content`, sorted unique effective queue IDs in `links`, and deterministic serialized acceptance-relevant
`evidence` (queue/step states, goals/acceptance, result summaries/commits/review events, merge state and report
identity/freshness). Exact comparisons are conservative; no model judges semantic equivalence.

Every user history action has `id`, request fingerprint, `at`, `actor: user`, `reason`, `ref`, `operation`,
nullable `before`/`after`, and optional `undo`. Each invalidation has `assessment`, `ref`, `at` and exact `reasons`.
A single atomic YAML replacement under `idea-statuses.lock` persists each action. Request-ID retries return the
original action before revision checking, including after restart; a different payload with that ID is 409.
The revision fingerprints the complete current status inputs and link revision. A changed screen cannot overwrite
a newer decision. As with the relationship lock, a crashed writer's lock fails closed; it is never stolen.

| Operation | Extra input | Effect |
|---|---|---|
| `drop` | ? | Set Dropped, suspend any assessment, preserve work and handoffs |
| `replace` | `target` | Set Replaced with an existing note/date; reject self-reference and cycles through UI or legacy replacements |
| `reopen` | ? | Set Active and remove the current assessment; no queue reopening or new work |
| `partial` | optional `evidence_refs` | Record the reason describing what exists and remains, with the current snapshot |
| `confirm` | `evidence_refs` required without linked queues; `caveat_reason` required for cancelled work/skipped steps | Explicit full assessment of the complete date; unavailable with unfinished/stopped/failed work, missing linked queues, provisional review or a required pending/failed merge |
| `revoke` | ? | Remove the current assessment, preserving it in history |
| `keep` | ? | Keep the effective disposition and acknowledge the current legacy marker snapshot |
| `adopt-marker` | ? | Explicitly adopt the current legacy marker, validate its replacement, and clear the current assessment |
| `undo` | `action` | Append a compensating action restoring before, only if no later action touched this entry; restored assessment validity is rechecked |

All operations require a nonblank reason. Legacy markers remain the fallback until a UI disposition exists;
Replaced takes precedence over Dropped and conflicting/invalid markers remain visible with diagnostics. A UI
disposition wins; edits to the marker afterward produce `marker_status: conflict` (Note and decision differ).
An unchanged overridden marker is historical, not a new alarm. Undo of the first override returns to the current
legacy fallback. Neither these actions nor their undo remove the historical `ideas.covered` records.

Content includes every heading, list, link and code line under all headings of that date. Normalize CRLF and
trailing line whitespace; exclude only recognized disposition metadata outside code. Summary/Open/Ideas/Area
changes do not invalidate assessments. Any other dated-content change does, as do effective edge changes and
changes to acceptance/results/reports/merge evidence. Origin/reason/order changes with the same edge set do not.
The server reconciles observed changes at startup, from its `.nexus` and validated notes-folder watchers, before
Ideas/status GETs and around relationship saves. It records the first divergence for every saved assessment,
including historical/revoked ones: reverting inputs or undoing revocation cannot resurrect it. A transient edit
that is made and reverted while no server observes it cannot be reconstructed from files alone. No new agent
writer is introduced; the CLI read does not persist observations. On observing sources, the server also remembers
previously unseen queue-source identities in `idea-matches.yaml` so deleted queues remain visible, without accepting
any suggestion or changing a source override.

Entry `implementation` is `unconfirmed|partial|full|needs_review|suspended`; `assessment` retains the prior
explanation and snapshot. `stale_reasons`, `diagnostics`, full-confirmation `blockers`, and coverage `caveats` are
separate. `work.state` is `none|linked|some_finished|finished`, with each queue's exact status (or `missing`) and
issues. Cancelled work is retained and never counted finished. Notes exclude dropped/replaced dates from progress,
roll up the least assessment (unconfirmed before partial before full), and retain a separate attention count even
when all dates are inactive. No dated entries: `worked_out`; no active dates: Dropped if any, otherwise Replaced.

`nexus ideas status --full` prints the same effective statuses as JSON, read-only from files; without it, a short text summary (or, given a reference, that entry's JSON: see ["The `nexus` CLI"](cli.md#the-nexus-cli)). There is no CLI status-write
operation. Partner/orchestrator briefings and conversation handoffs require this effective state together with the
notes; they do not treat Markdown markers as the only authority or work completion as confirmation. IC4 supplies
the new dashboard controls and renders these fields.

**Outcome excerpts (IC2).** Each existing queue reference in GET ideas carries `outcome`: `kind`
(`queue-report|accepted-steps|unavailable`), `text`, `report` (project-relative full-report `path`, `available`, current
content `hash`, event-bound `source_hash?`, `source_status`, report-event `at` and `event` when present), `excerpts`, all current `accepted` step summaries,
`historical` reported rounds, `sampled_steps`, `substantive_steps` and `warnings`. QueueView's `report` also retains
its event ID and optional `source_hash`. A step excerpt identifies step, round (the step.done ordinal), event, commit when supplied and source
hash. Historical rounds are labelled reported history, not current accepted evidence; their step/event links lead
to the original review timeline. No second acceptance state is maintained: current StepView status and provisional
confirmation determine the accepted evidence; reopened or unconfirmed rounds cannot borrow old acceptance.

With an available report and a recorded queue.report summary, quote its first two complete sentences and label it
as a whole-queue report excerpt. A summary identical to a closing step's, or explicitly beginning with closing
refactoring/integration/merge wording, uses the substantive fallback. This is deterministic source selection, not
semantic certification of prose. Otherwise sample one complete sentence from each of up to two distinct accepted
substantive steps in queue order; closing/integration steps remain separately readable. The counts expose the sample.
Incomplete/empty summaries produce no invented sentence: `No substantive outcome summary available`. The full report
path and accepted summaries remain available. Missing reports and unfinished/skipped/provisional evidence produce
warnings; a report never upgrades acceptance or confirms implementation.

A queue-report quotation is attributed to the immutable `queue.report` event, not re-extracted from arbitrary file
edits. Its excerpt hash covers that event's identity, time, summary and registered source hash; changing report.md
alone never gives the old quotation a new source identity. The response independently fingerprints the current file
bytes (`report.hash`) and compares them to the event's `source_hash`. `source_status` is `current` only when both
hashes match, `outdated` when they differ, `unverifiable` when the file exists but no event-bound hash is available,
or `missing` when the file is absent. Changed and unverifiable sources have explicit warnings. An available old
summary may still be quoted with that status, as an event quotation, never as a verified current-file excerpt.
Missing files use the accepted-step fallback. Legacy events are not backfilled with a hash of today's file and
cannot prove freshness, even on the first read. A fresh `nexus report` records the new bytes, summary and event;
the next read uses that event and recalculates freshness. `current` proves byte equality to registration only, not
semantic accuracy or full implementation. No model or additional session-log writer is involved.

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
file's Decided section holds decisions, and the summary names the dates of the Decided entries it covers. With a notes
folder the instruction also asks the partner to record those entries first with `nexus covers` (an `ideas.covered`
event among its own events), for the ideas overview. `GET …/queues/:q/steps/:s/conversation` answers `{ conversation }`: the step's
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

**A conversation's model and effort** (queue CM; the design: docs/design/chat.md, "Model and effort of a
conversation"). `model` and `effort` in `session.yaml` are the conversation's own; an absent one follows the project's
`conversations` setting when the conversation runs on that runtime, else the runtime's default, also when the project's
setting changes later. `PATCH …/conversations/:cid` with `model` and/or `effort` sets its own; `null` or `""` drops it
(the inherited value again). The pair the next turn would run on (own, else inherited) is checked before anything is
written, and both are written together or neither: 400 for an effort the runtime does not take (Claude Code: `low`,
`medium`, `high`, `xhigh`, `max`), one the model does not take where the runtime's own model list names its levels (the
list `GET /api/models/:runtime` gives, as last asked; a model it does not name is left to the runtime), an unknown
effort, or a `model` that is no string. A save starts no turn and ends no process: the conversation's next turn runs on
the new values in a new process that resumes the same native session (Claude Code's `--resume`, Codex's
`thread/resume`). A process at a turn, or settling after one (a message sent into that turn may still run as a turn of
its own), finishes it first, a hand-over's turn already queued in it included; a message (or a hand-over) sent
meanwhile waits on the server and goes to the new process once the old one has exited, in order, so two processes of
one conversation never run a turn at once. Compact in that moment is refused (409) like at a turn. The same holds when
the project's settings the conversation follows change. Waiting input keeps the conversations busy for an update's
drain, and an update's cut-off keeps it in the runtime record's `interrupted.asked`, for the next server to answer.

`GET …/conversations/:cid` and the live stream's `session` message carry `settings` (`ConversationSettings` in
`packages/protocol/src/api.ts`): `running`, the model and effort the running process was started with (null without a
process; a null value: the runtime's default); `next`, those the next turn runs on, with `model_from` and
`effort_from` (`own`, `project` or `runtime`); `changes`, whether they differ; `inherited`, what each value would be
without its own (the project's setting on its runtime, else the runtime's default as null), with `model_from` and
`effort_from` (`project` or `runtime`), so the dashboard can name the default a choice goes back to. `state` is
`working` while input waits for the new process. `model` and `effort` beside them stay the conversation's own values.

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

## Idea conversation scope and direct delivery (IC5)

`POST /api/projects/:id/conversations` also accepts `idea: { file, date? }` and a required stable `request_id`
for this creation mode, mutually exclusive with `queue`/`step`. The exact file must be a discovered note inside
the configured notes boundary and the date, if supplied, must exist. The server saves
`about: { idea: { file, date?, seeded? } }` plus `creation_request: { id, fingerprint }` in `session.yaml`.
The legacy `about: { queue, step, seeded? }` remains readable and behaves unchanged. An identical creation retry
returns the same session, even after restart; reusing an ID with different parameters is 409. A new deliberate
idea click uses a new ID: no automatic latest-chat reuse. Existing and archived chats remain individually readable.

The dashboard's single note-level action pair always creates a chat with `idea: { file }`, without a date picker:
all Decided dates, their current states/relationships, Summary and Open/Ideas are included. There are no chat or
handoff actions under dated entries or in their operation menus; their status actions remain. Optional `date`
stays compatible for historical scoped sessions/API clients; reading those chats does not migrate their scope.
The note-level handoff button opens the existing preview, where delivery dates can still be selected.

Creation does not launch a process or send a turn. At the first actual message the server includes Summary,
complete selected Decided dates, effective dispositions/assessments, provenance/conflicts and full Open/Ideas
sections labelled as undecided. `about.idea.seeded` is the snapshot fingerprint last submitted to the runtime;
changed context is included again. The visible chat records the user's words only. Missing note/date rejects a
new message before recording it (404), exposes `idea_context_error` on the conversation view, and leaves old
messages readable. An archived idea chat refuses new messages until restored (409). Existing own model/effort
values survive context refresh. Idea-scoped chats reject the old summary-based `/handoff` endpoint (409); their
dashboard handoff opens the direct preview instead.

The direct handoff endpoints use the normal local/same-origin, JSON-only write guards:

| Endpoint | Input/result |
| --- | --- |
| `POST …/ideas/handoffs/preview` | `{ file, dates, purpose: plan\|context, instruction? }`; returns selection, source revision, scoped snapshot and exact payload |
| `POST …/ideas/handoffs` | `{ request_id, revision, selection }`; saves immutable intent and attempts delivery, returning the durable record |
| `GET …/ideas/handoffs` | All historical records, including failed/interrupted attempts |
| `POST …/ideas/handoffs/:hid/retry` | Retries that existing immutable payload/ID; a delivered record is returned unchanged |

Planning requires at least one active date without a current full confirmation. Full/dropped/replaced dates are
allowed only with `purpose: context`; no dates is also context only. The payload never includes another note's
body or a chat's unrelated turns. Every payload states that it grants no approval/start permission, changes no
queue or start plan and lifts no start prohibition. A stale source revision is 409 before saving intent. The
fingerprint includes selected dated content, summary, undecided sections, effective states and relationship
provenance. It is separate from implementation-confirmation validity: an Open/Summary edit refreshes chat/handoff
context without invalidating a dated implementation assessment.

`.nexus/idea-handoffs.yaml` is a server-only atomic YAML file with `protocol: 1` and `records` (absent: empty).
Each record retains `id`, request fingerprint, `created_at`, exact `file`/`dates`, `purpose`, `instruction`, source
`revision`, immutable `payload`, `state: pending|failed|delivered`, append-only `attempts: [{ at, error? }]` and an
optional `delivery: { at, session, line, inbox }`. Failed delivery returns a failed record, not a success receipt.
An interrupted pending request is explicitly retryable; restart does not silently generate another request.
Retries of saved intent retain the original snapshot even if its sources have since changed. Corrections are new
previewed requests; delivered history is never erased or overwritten with newer content.

`Orchestrator.enqueueIdea` uses the existing server-owned inbox and chat: `idea-<request_id>` is the stable inbox ID
and the chat entry's optional `message_id`. It searches historical orchestrator sessions before appending, writes
the inbox first and completes a missing chat row on retry. Thus a crash between inbox, chat and handoff receipt
can be recovered without enqueueing twice, including after an orchestrator session switch. The ordinary pending
inbox path delivers these messages and existing session continuation carries unread messages. The receipt means
durably queued **and visible**, not model acknowledgement. Runtime failure after enqueue does not erase the inbox.
No partner event log is written: delivered dated handoffs are read alongside legacy `ideas.covered` events by the
Ideas history. Pure context-only handoffs without dates remain in note-level handoff history.
