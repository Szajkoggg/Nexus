# Ideas

Part of [the design](../DESIGN.md).

## Ideas relationships: persisted corrections (IC2)

The accepted IC1 contract uses origin-level overlays in `idea-matches.yaml`, with append-only logical action
history and immutable legacy matches. A correction snapshots known identities and keeps inactive records, so a
missing queue/date does not erase the explanation. A replace and its undo each write one complete file. Source
overrides are explicit operations; neither a rejected match nor any idea action edits an approved queue.

A revision covers both the stored decisions and current note/queue inputs. The server holds an exclusive file
lock across re-read, comparison and atomic replacement; request IDs retrieve saved results before revision checks.
Undo checks touched origin IDs across later history, so unrelated actions do not block it and a newer decision
cannot be silently reversed. A crash-left lock fails closed; no time-based lock stealing. This preserves the
one-writer contract across overlapping server requests and accidental overlapping server processes.

Outcome excerpts quote current accepted StepView rounds or the recorded queue-report summary, with source hashes,
event/round/commit links, sampling counts and missing-evidence warnings. Old reported rounds remain explicitly
historical; they never supply current acceptance. Closing-only fallback recognizes reused closing summaries and
explicit closing labels; it makes no semantic promise about arbitrary report prose. No model runs when a page opens.
The expanded manager/status/chat UI remains in IC3–IC5; IC2 only adapts the existing matching client's save tokens.

IC2 review found two places where an old observation could appear current. Pending relationship snapshots now
stand apart from freshly derived suggestion evidence, and the revision includes that live evidence even for a
previously decided edge. Stored decisions keep their original evidence; missing references retain historical
identity with diagnostics. Queue report excerpts likewise keep their immutable event identity. The CLI records
the exact registered report bytes' SHA-256 in that event; reads compare the file to it and explicitly distinguish
current, outdated, unverifiable legacy and missing sources. Hashing only today's file cannot establish that an old
summary belongs to it, so no historical fingerprint is invented at read time.

## Ideas corrections: design boundary (IC1)

[The IC1 design](../ux/ideas-corrections.md) specifies origin-specific relationship corrections,
separate implementation confirmation, precedence over legacy note markers, and scoped conversation/handoff
actions. The server remains the only writer of Nexus decisions; the partner remains the only writer of notes.
The current `built` derivation is work completion, not evidence that a whole dated decision is implemented or
deployed. The user chose a new conversation on each Chat about this action. IC1 records the design and review
fixtures only; subsequent IC steps implement the approved contract and update the protocol with their changes.

## Ideas dispositions and assessment validity (IC3)

The server owns `idea-statuses.yaml`; the partner remains the sole note writer. A dated entry has three independent
axes: effective disposition, explicit user assessment and linked work. The original `built` compatibility field
never becomes a full assessment. UI dispositions override their observed legacy markers; later marker edits are
conflicts, with reasoned keep/adopt actions. Restoring the first override restores today's legacy fallback.

Assessments retain complete normalized content and a deterministic work/evidence snapshot. Snapshot equality is
intentionally stricter than human semantic equality. Source origins and link reasons do not enter the effective
edge set. The existing queue/step derivation supplies acceptance, including provisional reviews, skipped work,
reopened results and integration caveats; Ideas does not invent another acceptance state. A full assessment is
blocked by unfinished work, missing targets or required merge/review, while cancellation and skipped steps require
an explicit coverage explanation. No work at all requires an external evidence reference.

Invalidation must survive a revert. The server records observed divergence for every assessment in current records
and history, including ones temporarily revoked or suspended; undo cannot revive an assessment invalidated while
it was hidden. Notes are watched with symlink following disabled after boundary validation. Reconciliation also runs
on startup and before reads, and synchronously around link writes so quick remove/undo cannot hide the changed edge.
Only observed states can be retained: edits reverted entirely while the server is offline leave no recoverable
intermediate state. Source observations preserve missing queue identity without deciding a match. Status operations
have revision/request-ID checks and compensating before/after history; they never alter a queue, run or start plan.

The read-only `nexus ideas status` command gives agents the same effective state and conflicts as the API. The
partner's and orchestrator's instructions now combine that state with dated note content. IC4 owns the controls,
labels and filters; IC5 owns the new idea conversation and direct handoff workflow.

Queue ND made its default a text summary: the JSON carries every entry's snapshot (its whole text and its queues'
evidence), and on the Nexus project it had grown to 2,522,476 bytes (49 entries), which an agent read whole at every
planning or hand-over. The summary (per note and entry: the reference, the effective decision, the linked queues, the
problems) is 4,910 bytes there; one entry's JSON is `nexus ideas status <file>.md#<date>` (about 36 KB), its text
`nexus doc <file>.md#<date>`, everything `--full`.

The same queue shortened an orchestrator's `nexus status`: on the Nexus project it was 87,368 bytes (20 open and 113
finished queues, 176 worker sessions, whose cards were 78.7 KB of it), run many times a day. By default it now names
only the open queues, counts the finished ones, and shows of the worker sessions the live ones, those of open queues
and the 10 latest others with cards cut to 300 characters: 13,498 bytes there. `--all` prints what it printed before,
which is also what a fresh orchestrator session still starts from (its first message keeps every session, so it can
choose one to continue without another command); `--queue <id>` one queue with its sessions and what waits about it.
Both now end with the machine's lines, which the orchestrator's status had left out.

## Ideas correction controls (IC4)

The overview and entry consume the same server `effective` state, never interpreting legacy `built` as a user
assessment. The note roll-up and Needs attention count come from the server; the pure filter helper selects those
same dated entries. Open sits below Summary and above Decided, with Related work collapsed. Work excerpts retain
their scope and report freshness; provenance and historical evidence are secondary details. Manage links remains
available independently of pending counts and even before the first match decision.

Relationship forms select an origin, not a whole queue, and preview the exact date being changed. Queue and dated
decision pickers are searchable and show the complete selected text. Status forms act on one complete date. Each
draft pins the read revision, keeps its fields across errors and explicit refresh, and retries an uncertain write
with the same request ID. Saving waits for the refreshed Ideas read; failure to read after an acknowledged write
is labelled separately from a failed write. Undo uses the API's compensating actions with its concurrency checks.

The note and dated status form are navigation layers; Back from the manager or a work/report returns to the note.
The overview's filter, search and scroll position survive those transitions and reload in this browser session.
The note header opts into wrapping and keeps its close control inside its measured bounds. Titles, questions and
action labels are not clamped. The capture fixture clears only its own stored list position for reproducible views.

`scripts/verify-ideas-ui.ts` drives the actual dashboard with the capture browser and layout-faults engine against
temporary projects. It covers the correction guide, atomic replacement/undo, accepted/rejected undo, zero-pending
reopening, a project never matched, an uncertain response after a committed save, date-specific confirmation and
stale drafts after a concurrent note change. It verifies all 12 agreed view/size combinations and initial Open
visibility. The UI keeps chat/handoff for IC5, including the accepted always-new-chat rule.

The overview's replacement arrow, like the status form's current target, reads `effective.replacement` only while
`effective.disposition` is `replaced`. The legacy `replaced_by` field is source metadata, never a fallback for a
current target. Original markers remain in the explicitly historical/conflict-labelled details; the API's dated
decision content already excludes these disposition markers.
`scripts/verify-idea-replacements.ts` checks the rendered row and assessment after UI Reopen, B-to-C replacement,
and replacement without a note marker, including reload and Back. All three dates have no linked queues.

### Idea conversations and direct handoffs (IC5)

The accepted always-new-chat choice in IC1 supersedes the queue's earlier latest-chat wording. IC5 round 2 narrows
the UI to one note-level Chat about this / Hand to orchestrator pair, with neither action on dated entries or
their operation menus. New chats cover the entire note: Summary, all Decided dates with current states and
relationships, and undecided Open/Ideas. Date selection belongs only to the handoff preview. Historical dated
chats keep their scope and readable history; dated status controls remain unchanged. A stable creation
request ID distinguishes a retry from a deliberate new click. The session's topic is a compatible union: the old
queue/step link or an exact idea file/optional date. Context is supplied only on a real message and refreshed by
its content/status/provenance fingerprint. The existing own model/effort selection is preserved; CM owns further
model-choice UI. Archived and missing-source conversations remain readable and cannot silently change scope.

Direct handoff uses no partner/model summary. The server composes a preview from one note and explicit dates,
with effective state and undecided sections separated. Terminal or fully confirmed entries are context only;
requesting new work first requires an explicit Reopen. The handoff's intent is saved before enqueueing; its stable
ID joins an immutable snapshot, existing orchestrator inbox entry and visible chat row. Retrying can complete a
partially persisted delivery without appending another inbox message, even across session switches/restarts.
Delivery means queued and visible, not read or executed. Pending/failed attempts stay visible and retryable.
There is no distributed exactly-once claim about model processing: the existing runtime/inbox lifecycle owns
turn delivery, while this feature guarantees idempotent enqueue and visible delivery identity.

The server alone writes handoff records, session metadata, inbox and chat rows. It never writes a partner's events
or notes. A delivery contributes historical handover evidence without replacing later user corrections. The
preview fingerprint is deliberately distinct from implementation confirmation: Open/Summary changes refresh the
preview/context, while the IC3 confirmation rule remains unchanged. New server messages and briefings repeat the
no-approval/no-start/no-plan-change boundary. Note/chat/handoff navigation preserves the note and overview's
position on Back; uncertain creation/delivery requests retain their IDs through browser reload.

`scripts/verify-ideas-onward.ts` checks all nine capture/layout scenes and the browser workflows against isolated
fake-runtime projects: direct handoff without a chat, exact dates/full-date exclusion, stale preview, uncertain
delivery and creation responses, reload/restart idempotence, deliberately new chats, changed/missing source,
and Back with the overview filter preserved. History assertions wait for the asynchronously loaded receipt,
not merely the mounted details summary. Exact preformatted payloads use `white-space: break-spaces` so preserved
trailing spaces cannot hang outside the box, including when details are expanded.

IC5 validation exposed existing timing-sensitive tests at default file concurrency on a 16-thread host; the
same cases passed unchanged in isolation. Full-suite verification uses the normal lock runner and complete
test-file set with bounded file concurrency:
`node scripts/test-lock.ts --test --test-concurrency=4 packages/*/test/*.test.ts apps/*/test/*.test.ts scripts/test/*.test.ts`.
All 1,237 tests passed without skips; process inspection confirms four direct test-file children.
The Node option must precede file patterns:
appending it with `npm test -- --test-concurrency=4` did not apply the limit. No assertions, per-test timeouts,
internal concurrency scenarios or repository runner configuration change; review reports retain the failed
attempts alongside the final verification result.
