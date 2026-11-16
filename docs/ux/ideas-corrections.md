# Ideas: corrections, status and onward work (IC1)

Design accepted by the user during IC1, 2026-11-16/17. This document supersedes the matching and status
rules of [IO's design](ideas-overview.md) for subsequent IC implementation. No production behaviour changes in IC1.
The unit stays **one note + one Decided date**, including all headings with that date. No decision-item migration.

## Findings and boundaries

Read: AGENTS.md; IC revision 1; the note `ideas-overview.md` (Open audit, 2026-11-16);
IO's report; MT/IO/ST2/FB definitions and stored matches. Read-only originals are in the main project's
notes and `.nexus`, not this checkout. The audit identifies MT's umbrella-note match and IO/ST2's tags
matches as corrections for the user, not permission for a worker to change them.

Current implementation: `ideas.ts` unions source and accepted matches and calls every finished set
`built`; cancelled queues are excluded. `ideas-read.ts` omits matches whose queue disappeared.
`decideIdeaMatches` overwrites/removes a decision, with no retained correction history.
`IdeaMatchesFile` stores accepted/rejected suggestions only. `IdeasOverview` hides its matching entry
point at zero pending suggestions; `NoteBody` puts Decided before Open; matching uses a queue's first
quote rather than each relationship's evidence. Conversations already create step chats without a
model turn and can find the most recent unarchived chat; idea identity and direct handoff are missing.

Only the server records dashboard decisions in Nexus-owned files. The partner alone writes notes.
No operation here changes a queue definition, approval, run, start plan, commit, deployment or another
entry. No agent can accept a relationship or confirm implementation. Closed queues are immutable.
Read APIs and agent briefings must expose the same effective decisions and visible conflicts.

## Relationships: scope, precedence and undo

Always show **Manage links**, including with zero suggestions, zero links or no previous matching run.
The manager has All / Pending / Linked / Rejected / Needs attention filters, queue and note/date search,
and **Add link**. Pending counts are not total-link counts. A queue may link to several dates and vice versa.

| Action | Exact scope and effect | History / undo / exclusions |
|---|---|---|
| Accept / reject suggestion | One suggestion identified by queue, note/date and origin | Save its own quote, reference format, time and decision. Rejection does not suppress a source or a manual link. |
| Add link | Choose an existing queue, note and actual Decided date; show its text; require a reason | New manual origin. No suggestion is required (MT → queue-templates.md#2026-11-15). Do not duplicate an already effective edge; explain existing origins. |
| Change target | Select an origin on one edge, choose a valid new note/date and reason; preview before → after | One atomic correction removes that origin's contribution and adds a manual target; keep other origins, queue links and history. |
| Remove link | Remove the selected accepted-match/manual origin, with reason | If another origin still supports the edge, say “Still linked by queue source”; offer that separate operation. |
| Ignore source / correct source | Explicitly name the queue-source origin and the effective override | Server-side overlay only; queue source remains visible and unchanged. Separate from rejecting a match. Correction can atomically ignore source + add manual target. |
| Undo | Show the previous effective state and the exact action being reversed | Append a compensating action, never delete history. Only if its touched records have not changed since; otherwise show the newer change. A replaced edge is restored atomically. |
| Fix missing target | Old missing note/date/queue remains visible with last known identity and evidence | Removal is allowed even if the old target is gone. A replacement must exist; restoration of an unavailable target is refused with an explanation. |

Each origin is visible separately: **Queue source**, **Historical match** (accepted/rejected/pending),
**Manual link**, **Source ignored by you**. Effective edges are their union after the applicable
overrides; duplicates count once for work progress. A format badge (exact/dated/file-only) describes
the reference syntax, never certainty that a queue implemented the decision. Examples and context
references are not implementation evidence. Evidence details use that origin's own quote/location,
or its source-list item, or the user's manual reason. Never borrow the first quote of a queue.

New targets must be in this project's configured notes folder, resolve safely inside that boundary,
and contain the chosen date; no traversal, symlink escape, other project or invented date. Missing
queue/source/note/date is a visible diagnostic, not an empty successful result. Store last-known
identity and provenance so deletion cannot erase the record. Read failure is not “no links”.

All saves use a revision token and stable request ID. A changed screen gets “Changed since you opened
this; review the newer decision”, with the draft reason preserved. Retry returns the same saved action;
a failed save retains input and does not display success. History has time, actor, reason, before/after
and undo target. Import existing accepted/rejected records losslessly; do not invent older undo history.

## State and action table

Show **disposition**, **implementation confirmation**, and **linked work** separately. Queue completion
is evidence for review, never a user confirmation or proof of live deployment. Old `built` becomes
“Linked work finished · Implementation not confirmed”, without fabricating confirmation.

| Situation / action | Display / permitted decision | What must survive |
|---|---|---|
| No Decided date | Being worked out; chat and context-only handoff available | Open/Ideas never become decisions. |
| Active, no work | Decided; Handed over when delivery is recorded | A historical handoff is retained after corrections. |
| One or several queues still open | Work linked; show every queue's actual state | A finished queue does not cover other unfinished queues or every bullet of the date. |
| Some accepted work, some unfinished / cancelled | Some linked work finished; implementation unconfirmed | Do not infer a percentage or “fully implemented”. A cancellation is not completed work. |
| All linked work finished | Linked work finished; Review implementation | Still no automatic full confirmation. |
| Deleted queue / broken reference | Needs attention; work evidence incomplete | Show last-known queue and reason; missing is not cancelled or finished. |
| Stopped / failed / cancelled queue | Its exact state; accepted results may still be inspected | No automatic drop of the idea and no silent removal of work history. |
| Skipped step | Work has a skipped step; coverage needs review | A finished run is not enough to assert all intended outcomes. |
| Provisional review | Awaiting final review | Provisional acceptance is not final evidence. |
| Awaiting merge / merge failed | Awaiting merge / Merge needs attention | Finished worktree work is distinct from integration and deployment. |
| Mark partially implemented | User describes what exists and what remains, against this dated entry | Store explanation and evidence references; no per-bullet checklist. |
| Confirm fully implemented | User reviews the entire date, work reports and caveats, and records a reason | Explicit decision, date/content/link/evidence snapshot; never inferred from completion. |
| Drop | Require reason; set Dropped even after completion | Old confirmations, links and work remain in history. Does not stop work. |
| Replace | Require reason and existing replacement note/date | Replaced by…; reject self-link and cycles; no transfer of queues or confirmation. |
| Reopen | Return a dropped/replaced/confirmed entry to Active, implementation unconfirmed | Preserve decisions, links and handoffs; require reason. No queue reopening, retry or new work request. |
| Undo status action | Restore prior disposition/assessment with a new history action | Revalidate restored confirmation against current content/links/evidence; never resurrect stale “full”. |

Full confirmation is unavailable while a linked queue is running/proposed/stopped, a target is missing,
a review is provisional or a required merge is pending. Resolve or explicitly correct the relationship
first; never silently exclude a cancelled queue. A cancelled queue or skipped step remains a coverage
caveat: the user can confirm only after explicitly explaining why the date is nevertheless fully met.
An entry implemented outside linked queues can be confirmed with an explicit evidence reference and
reason; absence of queues alone proves nothing. Partial assessment has the same snapshot validity rules.

The note roll-up excludes dropped/replaced entries from active progress, shows the least advanced
remaining entry (unconfirmed before partial before full), and retains work-state counts separately.
With no active entries show Dropped if any are dropped, otherwise Replaced; with none dated show Being
worked out. A Needs attention count is always visible and does not disappear behind those roll-ups.
Filters and badges use the same derivation as the entry, never independent client guesses.

### Legacy markers and confirmation validity (user decision required)

Without a UI disposition, use the note's legacy `Dropped` / `Replaced by` marker. A valid Replaced by
wins if both occur, matching today's reading; show a conflicting-markers warning. An invalid replacement
keeps its literal historical label but is flagged, not silently converted to an active entry.
After an explicit UI disposition (including Reopen), that decision wins. Store the marker snapshot seen
then. Later marker edits do not silently override it: show both statements and “Note and decision differ”.
The user may keep the UI decision or explicitly adopt the note marker in a new reasoned action.
Unchanged legacy text after a known override is shown as an overridden historical marker, not as a new
alarm. Undoing the first UI override returns to the current legacy fallback, with any difference previewed.

A confirmation covers the complete dated Decided content, not just the first bullet, plus the effective
set of queue → date edges. Compute a deterministic content fingerprint: normalize CRLF and trailing
line whitespace; exclude recognized disposition metadata; keep headings, text, lists, links and code.
Any remaining change (including another heading on the same date) needs review. Do not pretend to judge
semantic equivalence with a model. Formatting-only changes beyond those two normalizations conservatively
need review. Summary/Open/Ideas/Area changes alone do not invalidate this confirmation.

Edge addition/removal/change invalidates; sorting, a reason edit, or an origin change that leaves the
effective edge set unchanged does not. Missing evidence, revoked acceptance, changed accepted results,
new/reopened work or changed merge outcome also needs review, even with unchanged edges. Dropping or
replacing suspends the current assessment. Store every former assessment and the exact reason it became
stale. Display “Previously confirmed · Needs review”, not “Fully implemented”. Reverting files does not
automatically reactivate it: require a new user check. Deployment is always an independent fact.

## The note and its work summaries

Order: header (title/file), **Summary → Open → Decided → Related work (closed)**. Open is expanded;
each dated entry has its own status and Change status / History. Keep Chat about this and Hand to
orchestrator in an accessible action area. Manage links remains on both overview and note. Titles,
questions, reasons and action labels wrap. At 390/492 × 844 and 1440 × 900 a 1–3 sentence Summary and
two short questions fit on the initial screen. Long content scrolls naturally; do not promise that
all questions or all dates fit, and do not hide text with ellipses to make the promise appear true.

Expanding Related work shows one row per queue: actual state, 1–2 sentences of outcome and a **Full report**
link. Below that, optional Evidence and link history. A report about a whole queue is labelled as such;
it is not a claim that the entire date was implemented. The refactor/integration closing summary alone
must never stand for all the feature steps.

Verifiable extraction, without a page-open model call:

1. Use the existing queue report (`queue.report` event, `QueueView.report.summary/path/at`,
   `.nexus/queues/<id>/report.md`) and `StepView` summaries from accepted rounds of **all** steps.
   There is no dedicated queue-report endpoint at this baseline. Preserve source
   identifiers (queue, step, round, event, commit, report section/hash). Select only actual outcome text,
   not goals, plans, checks or the last event by timestamp. Use each step's latest final accepted round
   still in force; a reopened/unaccepted round cannot borrow its predecessor's acceptance. Older
   accepted results remain available as explicitly historical evidence.
2. Prefer the queue report event's summary (explicit whole-queue scope), quoting its first 1–2 complete
   sentences, labelled “Queue report excerpt”; link the full report and accepted-step evidence. If the
   report changed since extraction, mark the excerpt outdated and regenerate deterministically.
   A summary about only closing refactor/integration is not a whole-queue outcome: use the substantive
   step fallback instead, even when that closing text was recorded as a queue report summary.
3. Otherwise select up to two complete outcome sentences from distinct accepted substantive steps in
   queue order, before closing refactor/integration steps. Label “Accepted step excerpts · 2 of N steps”
   with each step/round link. This is visibly a sample, never a synthesized whole-queue claim. Offer all
   accepted summaries in Full report. If only closing-step text exists, say “No substantive outcome
   summary available”; the closing result can still be read separately.
4. Missing/unaccepted/empty summaries: explicitly say what is unavailable. Do not invent prose from the
   queue title or link quote. Sentences can wrap across many lines; 1–2 sentences is not a line clamp.
   Disagreeing report/accepted state gets a warning; the report cannot upgrade provisional work.

IC2 must use the existing state's acceptance/round information, not create a second competing notion
of accepted results. A report file without a recorded summary uses the step fallback. Persistence/caching is an implementation choice, keyed
by source hashes, with no extra writer to session logs.

## Conversation and direct handoff

**Chat about this always opens a new conversation**, as the user chose for IC1, scoped to the exact
project/note (or exact note/date for a dated-entry action). Open an empty composer and create a session
without starting a turn. Disable repeated clicks while creating and use a stable request ID so a retry
does not create two sessions. A later deliberate click creates another conversation. Existing chats
remain individually available in the conversation list/history, with their scope shown; no automatic
reuse of the latest chat. Note-wide and date-specific scopes never substitute for each other. Archived
chats are available through history but not auto-reopened. Missing note: keep existing chat readable,
show the missing-context warning, require fixing the reference before a new idea-context request.

On the first actual user message, give the partner Summary, selected Decided content, Open/Ideas clearly
labelled as undecided, effective status, provenance and conflicts. Refresh on relevant changes before
subsequent messages. Do not reset an existing chat's model/effort selection (CM owns further model UI).
Back returns to the same note, list filter and scroll position. Opening/closing never calls a model.

**Hand to orchestrator** works without a chat; it sends a server-composed, reviewable message through
the existing orchestrator inbox, not a conversation-wide model summary. Preview includes:

- One project, exact note path/title; explicit checked dates with full decision text expandable.
  Entry action preselects that date; note action preselects active unconfirmed dates only. Nothing
  chosen is disabled until a date is selected or Context only is deliberately chosen.
- A purpose: **Discuss / plan next work** (active dates) or **Context only**. Full/dropped/replaced dates
  default unselected and may be included only as context, visibly labelled with their disposition.
  To request new work for them first Reopen explicitly; sending them does not imply reimplementation.
- Summary, selected dated decisions and statuses; Open/Ideas in a separate “Not decided” section.
  No content from other notes or unrelated chat turns; see-also references do not inline their topic.
- User instruction, delivery destination, and “Does not approve or start a queue”. Display exact payload
  before Send; stale content/links/status requires refreshing the preview before sending.

No dated decisions: offer Context only, with Summary and undecided questions. On Send store a durable
request ID and immutable payload snapshot owned by the server; deliver that same ID to the existing
inbox idempotently. “Sending” is not success. “Delivered to orchestrator · time · View message” means
durably enqueued/visible there, not read or implemented. A delivery failure stays Retry with the same ID;
double click, timeout and restart do not enqueue twice. Show historical handoffs with exact dates and
status-at-send. Corrections append history, never erase past delivery. Already delivered messages
cannot be unsent; a correction is a separately previewed follow-up. A running chat continues independently
and cannot have its ordinary reply mistaken for this payload. No second writer to an agent's log.

## Review and implementation boundary

Mockup: [24-ideas-corrections.html](mockups/24-ideas-corrections.html), `?view=entry-open|matching-empty|
matching-correction|entry-status|handoff-preview`. English UI, synthetic data only. Existing views use
the same `seed-ideas-corrections.ts` fixture for before and mockup: Chat improvements (two dates/two
questions), and the overview with zero undecided matches. The empty matching view is its entry point,
because the existing screen has no visible link at zero pending; the design adds that missing entry.
The other three scenes add synthetic correction, stale-confirmation and context-only handoff states;
their displayed decisions and times are examples, not observations about the real project.

All five views at 1440/492/390; first two have before + mockup. Captures are fixed viewport, scale 1,
1440×900 or 492/390×844 (390 in iframe). Baseline is IC1 start `3b6f542`; no application source changes
precede capture, so `capture.ts --no-before` can capture the unchanged checkout as before without a
second install. Static mockups are outside capture.ts's hash-route support, so layout-faults.ts's Edge
capture takes them under the same dimensions. Record results and any limitations below.

Implementation: IC2 links/provenance/excerpts; IC3 state/confirmation; IC4 UI/correction guide; IC5 chat
and handoff; closing queue steps cover integration/refactoring. IC1 does not change schemas, endpoints,
agent instructions or real data. Tests in later steps cover each table row with fake runtimes where needed.
The user's always-new-chat answer supersedes IC5's earlier latest-chat-reuse wording; implement the
accepted behaviour above, retaining manual access to existing conversations.

## User decisions and verification

User answers received during IC1:

- Question `01M7K8MY00WAYC30V3K9S98TA4`: origin-specific correction, with separate source override.
- Reply attached to `01M7K8MZJ3GHFAB254R3YDZHK4`: “Always a new chat, but the same direct handoff
  preview”. Applied to conversation behaviour; it does not answer the status question. The now-redundant
  chat question `01M7K8N1564NQ9DS8ZR193RDJV` was withdrawn with that explanation.
- Status clarification `01M7K94P9RRDSQ3FKTSPQGWREH`: the user accepted the specified precedence,
  validity and reopening rule. Final visual/plan review `01M7K98FKJ9SWPTZKK4013HWNK`: the user
  accepted the plan and screens. All product questions are resolved.

Verification so far: capture.ts took all six original views using the isolated seed and fake runtimes.
Two initial restricted-environment Edge launches timed out at Page.enable; the authorized capture
outside that restriction succeeded. Static mockups use layout-faults.ts's built-in Edge capture (the
capture tool itself accepts dashboard hash routes only). All 15 mockup view/size combinations report
zero crossed boxes, overlapping boxes and cut text. Inspected original and mockup images visually;
long correction forms scroll, while both short Open questions fit on the first screen in all sizes.
All six befores and 15 mockups are registered. Screenshots/reports live outside the checkout.
An additional temporary three-sentence Summary fixture also passed layout-faults at all three widths;
its two Open questions remain fully visible on the initial viewport (including 390 px).

Typecheck, lint and web build pass. The initial restricted full suite passed 1200/1204; three failures
were process-query/lifecycle checks and one was rollback successor cleanup. With process queries
available, both affected files passed (18 test-lock + 3 rollback tests), then the full suite passed
1204/1204 with no skips (728.26 s wall time). No code fix or test change was needed. The initial run's
remaining fake processes were identified by their exact fixture paths and stopped; the live instance
was untouched. The web build retains its existing large-chunk
warning. No application code, API, schema, agent briefing, real note or real relationship was changed.
