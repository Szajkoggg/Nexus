# Ideas: done but not confirmed, agents' link proposals, long-paused queues (IWS1)

The design step of queue IWS, for the user's review (level 1). The later steps build what the user accepts here:
IWS2 parts (a) and (b), IWS4A and IWS4B part (d), IWS3 part (c). No application code changes in IWS1.

Mockup: [28-idea-work-signals.html](mockups/28-idea-work-signals.html), `?v=overview|entry|entry-proposal|links|
waiting-links|waiting-paused|settings&w=1440|492|390`. It is drawn over today's dashboard as captured from
`scripts/capture/seed-idea-work-signals.ts` (the ideas notes of `seed-ideas-corrections.ts`, one entry confirmed, one
partially implemented, and queue AD paused by the user four days ago); new parts have a dashed outline. The view list
for the befores (and the later steps' afters) is `scripts/capture/examples/idea-work-signals.yaml`.

## What was found

- An entry's state has three axes (docs/design/ideas.md, "Ideas dispositions and assessment validity (IC3)"):
  disposition, the user's implementation assessment (`unconfirmed`, `partial`, `full`, `needs_review`, `suspended`)
  and the linked work (`none`, `linked`, `some_finished`, `finished`). Queue completion never sets an assessment.
- The dashboard shows the last two side by side: "Linked work finished" (blue, the same colour as a link) and
  "Implementation not confirmed" (grey). The blue word reads as the result; the grey one is easy to miss. The note's
  roll-up shows only "Implementation not confirmed", the same as for a note with no work at all. Of the overview's
  filters, "Work finished" mixes confirmed, partial and unconfirmed entries, and "Unconfirmed" mixes entries with no
  work, open work and finished work. The 41 entries of the request are nowhere listed by themselves.
- `nexus ideas status` prints `active; unconfirmed; queues PD done`: nothing says that every queue is done.
- The orchestrator's notice of a finished queue (`runEndNotice`) says nothing about the queue's ideas.
- A user's pause is a run state (`paused`, reason "paused by the user", `ended_at` from the moment it stopped). It is
  not an attention item: nothing waits for the user, nothing re-derives over time, and the orchestrator is told once,
  when it pauses. AD stood seven days that way.
- Agents propose plans and tags through events in their own `events.jsonl` that only the orchestrator's code takes in
  (`Orchestrator.applyRequests`); idea links have no proposal path. The CLI refuses `nexus ideas accept|reject` for
  every role, and the link writer (`changeIdeaLinks`) takes origin ids (`["source","Q1","docs/ideas/x.md#…"]`,
  `manual:<request id>`), which `nexus ideas matches` does not print.

## (a) Queues done, implementation not confirmed

**One signal per entry.** Where today two words stand side by side, the entry shows one badge, chosen in this order:

| Effective state | Badge | Look |
|---|---|---|
| assessment `full` (valid) | Fully implemented | green, filled dot |
| assessment `partial` (valid) | Partially implemented | blue-green, half dot |
| `needs_review` | Previously confirmed · needs review (or Previously assessed …) | as today |
| work `finished`, assessment `unconfirmed` | **Queues done · not confirmed** | amber, hollow dot (new) |
| work `some_finished` / `linked` | Some linked work finished / Work linked | as today |
| work `none` | Decided / Handed over | as today |

The queue ids and their states stay beside the badge ("PD · done"). The amber colour is the one Nexus uses for "waits
for you"; the hollow dot says "the user's part is missing". Confirmed and partial show no work word: the user's
assessment is the statement, and the queues are listed beside it.

- **Overview**: the badge on every entry line; a note's roll-up shows "Queues done · not confirmed" when that is its
  least advanced active entry (the roll-up order becomes: unconfirmed without finished work, queues done · not
  confirmed, partial, full). A new filter **Queues done, not confirmed · N** right after All (amber), selecting active
  entries with all linked work finished and no valid assessment (`needs_review` counts here too: its confirmation is
  no longer valid). The other filters stay. Views `ideas-overview@1440/492/390` (before → mockup).
- **Entry card** (an opened note): the badge in the card's head, and one new line under the lead: "Linked queues: PD
  done (1 of 1). Done queues do not show that the decision is implemented: only you confirm it." A confirmed entry
  says by whom, when and why: "Confirmed by you · 26 Nov: “…”". Views `ideas-entry@1440/492/390` (before → mockup).
- **The confirmation's place stays where it is**: the entry card's action, which opens the existing status form
  (`IdeaStatusForm`: Confirm fully implemented / Mark partially implemented / …, with its blockers and caveat rules
  unchanged). In this state the action becomes a button **Review and confirm…**, and the form opens with "Confirm fully
  implemented" chosen when nothing blocks it (no blocker, no caveat); otherwise as today. Decision D2.
- **`nexus ideas status`**: the implementation word of an entry follows the same order:

  ```text
  12 decided entries in 9 note(s): 11 active, 0 dropped, 1 replaced; 7 queues done but not confirmed; 2 with problems; 3 user action(s)
  docs/ideas/deploy-timing.md
    #2026-11-13  active; fully implemented (confirmed by the user 2026-11-26); queues PD done
    #2026-11-14  active; queues done, not confirmed; queues PD done
  docs/ideas/parallel-worktrees-and-merge-back.md
    #2026-11-15  active; partially implemented (the user's assessment); queues PW done
  docs/ideas/queue-plan-view.md
    #2026-11-15  active; unconfirmed; queues PB running
  ```

  The JSON (`--full`, one entry) gets `effective.implementation_signal: "queues_done_unconfirmed"` beside the existing
  fields; nothing existing changes meaning. The orchestrator's and the partner's briefings name the phrase.

Nothing here changes the confirmation rule: the derivation only names a combination that exists already.

## (b) The orchestrator, when an idea-linked queue ends

When a queue that is linked to one or more dated entries (by source, accepted match or manual link) finishes, the
orchestrator's finish notice (`runEndNotice`, `apps/server/src/prompts.ts`; sent from `orchestrator.ts`) gets one line
per linked entry, with the entry's state after this finish:

```text
Queue IWS finished. Report: …
Ideas linked to IWS:
- docs/ideas/ideas-overview.md#2026-11-24: every linked queue is done (IWS); implementation not confirmed.
- docs/ideas/ideas-overview.md#2026-11-26: linked work open: IWX running.
Tell the user briefly, with what you propose next. For each entry whose linked queues are all done, offer the
confirmation: only the user confirms, in the dashboard (Ideas → the note → the date → Review and confirm…); you
cannot. If the report or the steps show that part of the decision was left out, say what, and suggest "Mark
partially implemented" instead. Do not offer it for an entry with linked work still open.
```

What the orchestrator says to the user (an example; it speaks the user's language):

> IWS is done: by its report the two meanings of an idea's state, the link proposals and the paused-queue warning are
> built. Every queue linked to `ideas-overview.md#2026-11-24` is done; whether the decision is really implemented only
> you can confirm: Ideas → "An overview of the ideas" → 2026-11-24 → Review and confirm…. IWX is still working on the
> 2026-11-26 entry.

- A maintenance queue's finish (`maintenanceFindingsNotice`) gets no offer: its work is a survey, not an
  implementation.
- An entry that is already confirmed, dropped or replaced is named with its state, without an offer.
- Once per entry and finish: the notice's key is the queue's run end, as today; a later finish of another linked queue
  of the same entry brings its own line.
- When a finished queue names a note in its description but has no link at all, the line says so ("no idea linked;
  its description names docs/ideas/x.md"), and the briefing says the orchestrator may propose the link (part d).

## (c) A queue paused for long

**The item.** A new attention kind `paused` ("Paused for long", amber), one per queue whose run is `paused` and waits
for the user longer than the deadline (decision D4 says which pauses count). Its time (`at`) is the moment the deadline
passed, so a new warning comes in at the top of the newest-first list; the card's text says how long it has stood:

> **Paused for long** · Nexus · AD · 1 d ago
> Agent digest in the morning
> Paused by you 4 days ago, before step AD2 (Summarize). Nothing runs until you resume it.
> [Resume] [Open] [Remind me in 3 days]

For the other pauses the second line names the cause: "Stopped by you 4 days ago, at step AD2.", "Paused when the
Nexus server restarted, 4 days ago.". **Resume** is the run's existing resume (`POST …/queues/:queue/run`, action
`resume`), **Open** opens the queue, **Remind me in N days** puts the warning off by the deadline once more (decision
D5). Views `waiting-paused@1440/492/390` (before → mockup): the desktop's rail and the phone's Waiting tab. The item
goes away when the run resumes, the queue is cancelled, or it is put off; the notifications (push and in-tab) come as
for every other kind, with "Paused for long" in the notification settings' kinds.

`nexus status` (orchestrator and partner) lists it under "Waiting for the user": `- paused AD: paused by the user 4
days ago at step AD2; nothing runs until it is resumed`. The orchestrator also gets a one-time notice when the warning
comes up ("Queue AD has been paused by the user for 4 days; it now waits in the user's Waiting list. Mention it once;
resume it only if the user asks.").

**The deadline.** A setting in Settings → Defaults, **Paused queue warning · [3] days**, global with a project's own
value (the Global/Own switch every default has), default 3, whole days, 0 turns the warning off. Hint: "A queue you
paused waits for you in Waiting after this many days, so it is not forgotten; Remind me puts it off by as many days
again. 0: never." Views `settings-defaults@1440/492/390` (before → mockup). Stored as `defaults.paused_warning_days`
(schema `DefaultsShape`, listed in `OVERRIDABLE` and the settings form's keys).

**Where the server notices it, outside the run-control files.** The item is derived when the state is read
(`attentionOf` in `packages/protocol/src/state.ts`): run `paused`, the cause counts, `ended_at` (else `updated_at`)
plus the deadline is past, and no put-off reaches beyond now. Nothing re-derives by itself over time, so a new
server module (`pause-warning.ts`, beside `static-reminder.ts`) is one more decision of the change pass in `main.ts`:
it finds the next moment a warning comes due (or a put-off ends) and sets one timer for it, which calls the change pass
again; the attention watch then raises the notification. `engine.ts`, `scheduler.ts` and the run's own file are not
touched (the run-state reader is only read). The put-offs are a new server-written file,
`.nexus/attention-snoozes.yaml` (`{protocol: 1, items: [{key: "paused:AD:<ended_at>", until, at}]}`): keyed by the
pause's own end, so a new pause of the same queue starts afresh; listed in docs/protocol/files.md.

## (d) Agents' link proposals

**The command.**

```text
nexus ideas propose add     --queue <Q> --ref <note>.md#<date> --reason "…" [--evidence "…"]...
nexus ideas propose remove  --queue <Q> --ref <note>.md#<date> --reason "…" [--evidence "…"]...
nexus ideas propose replace --queue <Q> --ref <note>.md#<date> --to <note>.md#<date> --reason "…" [--evidence "…"]...
nexus ideas propose --file <proposals.yaml>      # a batch: [{op, queue, ref, to?, reason, evidence?}], one event
```

- `--ref` and `--to` are a note path (as `nexus ideas status` prints them) and a Decided date; `--reason` is required
  (one or two sentences, shown to the user); `--evidence` is optional and repeatable (a quote with where it is from:
  "IWS description: …", a report path and section, a commit). A batch shares one reason line at its head ("From the
  notes survey's report …") and each item keeps its own.
- The CLI checks what it can before writing (the queue exists, the note is in the notes folder and has the date, an
  add is not already effective, a remove/replace is) and refuses with the reason; a valid call prints
  `proposed: 3 idea link(s), P-01M…; nothing changes until the user accepts (Ideas → Manage links)`.
- **Who may run it**: the orchestrator (role `orchestrator`), a thinking partner (role `conversation`) and a worker
  of a maintenance queue: the CLI reads the worker's session (`queue`) and that queue's `maintenance` field (`survey`
  or `fix_small`, set by a maintenance template; the `origin: maintenance` tag is not used, because closing steps of
  ordinary queues carry it too). Everyone else: "only the orchestrator, a thinking partner or a worker of a
  maintenance queue may propose idea links". The server checks the same again when it takes the event in.
- `nexus ideas accept|reject` stay refused for every role; there is no command that accepts a proposal (D12).

**The event**, in the proposer's own `events.jsonl` (the session's log, its one writer):

```yaml
type: ideas.links_proposed
reason: From the notes survey's report (notes-20261124-0113, Recommended additions).   # optional, the batch's
items:
  - { op: add, queue: N4, ref: docs/ideas/deploy-timing.md#2026-11-14, reason: "…", evidence: ["…"] }
  - { op: remove, queue: PS, ref: docs/ideas/queue-plan-view.md#2026-11-14, reason: "…" }
  - { op: replace, queue: PB, ref: docs/ideas/queue-plan-view.md#2026-11-15, to: docs/ideas/queue-plan-view.md#2026-11-14, reason: "…" }
```

The proposal's id is the event's id (each item: `<event id>/<n>`); the proposer is the event's session (role, title,
and for a worker its queue and step).

**Where the server takes it in**, for every role alike and outside the run-control files: one more decision of the
change pass in `apps/server/src/main.ts` ("idea link proposals", before "orchestrator", so the orchestrator's notices
see its result), in a new module of its own. It reads the sessions' events of type `ideas.links_proposed` whose id the
proposals file does not hold yet (so it is idempotent across restarts, with no `applied.jsonl` of its own), checks the
role, resolves each item and records it. The `.nexus` tree watcher already reports every session's event writes;
neither `orchestrator.ts`'s request list nor `engine.ts` is involved.

**The file**: a new server-written `.nexus/idea-proposals.yaml`, its one writer the server, with its own lock
(`idea-proposals.lock`, like `idea-matches.lock`):

```yaml
protocol: 1
proposals:
  - id: 01M…/1
    event: 01M…
    by: { session: 01M…, role: orchestrator, title: Orchestrator }      # a worker: queue, step too
    at: 2026-11-26T10:42:00Z
    batch_reason: From the notes survey's report …
    op: remove
    queue: PS
    ref: docs/ideas/queue-plan-view.md#2026-11-14
    reason: PS is about checkouts, not the plan view; the source names the wrong note.
    evidence: ["…"]
    state: pending            # pending | accepted | declined | outdated | refused (at intake: unknown queue, bad role…)
    decided: { at, action: <link action id>, note?: "…" }   # accepted: the link action it wrote; declined/outdated: why
```

`idea-matches.yaml` and `idea-statuses.yaml` are not written when a proposal comes in (IWS4A's test compares their
bytes). They are written only by an acceptance, through the existing link writer (`changeIdeaLinks`, with its lock and
revision check), and each written action records the proposal: `actor: user` as always, plus `proposal: {id, by}`.

**How an edge-level proposal becomes origin-level actions** (decision D7): the agent names the edge (queue and note
date); the server shows, and applies at acceptance, what that means for the edge's origins as they are then:

| Proposed | The edge's origins | The action(s) at acceptance | Shown to the user |
|---|---|---|---|
| add | none effective | `add` (a manual link, the proposer's reason) | "Adds a manual link." |
| remove | accepted match / manual | `remove` of each | "Removes the historical match." |
| remove | the queue's source | `ignore-source` | "This is the queue's own source: ignores it (the queue file does not change)." |
| remove | source and a match | both, in one write | both lines |
| replace | match / manual | `replace` to the new date | "Changes the target." |
| replace | source | `correct-source` (ignore + manual link to the new date) | "Corrects the queue's source …" |

**Outdated** (D8): checked again at acceptance, not bound to the revision of the moment it was proposed: the queue,
the note and the date(s) exist; an add's edge is not effective yet; a remove's or replace's edge still is; a replace's
target is not yet linked. A proposal that fails this is shown greyed with its reason ("Outdated: this link already
exists (Historical match, accepted 16 Nov).") and a **Dismiss**; the intake marks it at once when it already fails.

**Accepting** (D9, D10): **Accept** on one item, or **Accept all N** on a batch (only its valid items; "Accept the
valid one(s)" when some are outdated), is one request: `POST /api/projects/:id/ideas/proposals` with `{decisions:
[{id, accept: true|false, note?}], revision, request_id}`. The server re-checks each item; the valid ones are written
together in one write of `idea-matches.yaml` (one link action per item, so each can be undone alone), the outdated
ones are left as `outdated`; the answer lists both ("2 accepted; 1 outdated: the link already exists"). A changed page
(another revision) gets the usual "Changed since you opened this; review the newer decision". **Decline** and
**Decline all** need no reason (an optional note).

**Where the user sees them.**

- **Manage links**: a filter **Proposed · N**, and above the list (in every filter) a box "Proposed by agents · N —
  Nothing changes until you accept. Each is checked again when you accept it.", one group per batch (proposer, time,
  the batch's reason, Accept all / Decline all) and one row per item: the operation (ADD / REMOVE / CHANGE TARGET), the
  queue, the date(s), the reason, the mapping line, Evidence (folded), Accept / Decline. Views
  `idea-links@1440/492/390` (before → mockup).
- **Waiting**: a new attention kind `links` ("Link proposals", violet), one card per pending batch: who proposes how
  many, the batch's reason, up to three items on a line each ("+4 more"), **Accept all N**, **Review…** (Manage links,
  Proposed), **Decline all**. Views `waiting-link-proposals@1440/492/390` (before → mockup).
- **The entry**: an opened note's date card shows the proposals that touch that date, each with Accept / Decline.
  Views `ideas-entry-proposal@1440/492/390` (before: the same note today → mockup).

**Who hears of the decision** (D11): the orchestrator, one notice per decision request ("The user accepted 2 and
declined 1 of the orchestrator's idea-link proposals (P-01M…): …"), whoever proposed. A partner or a survey worker is
not told: its session may be over; the partner sees the new state at its next message through its context.

## Decisions for the review

Each is declared with `nexus decide IWS1` (D1 …), with the material that shows it; the recommendation first.

1. **D1 (a) The entry's signal**: one combined badge "Queues done · not confirmed" (recommended; the mockup) / keep
   the two words side by side and add only the filter.
2. **D2 (a) The confirmation's button**: "Review and confirm…", with Confirm chosen when nothing blocks it
   (recommended) / as today ("Review implementation", Mark partially implemented chosen).
3. **D3 (b) When the orchestrator offers the confirmation**: when every linked queue of the entry is done
   (recommended) / at every linked queue's finish.
4. **D4 (c) Which pauses count**: every paused run that waits for the user (Pause, Stop now, Stop at once, the server
   restart's pause; recommended) / only the user's Pause. Rejected steps (their review item), the update hold and the
   usage wait (they resume by themselves) never count.
5. **D5 (c) Putting the warning off**: Remind me in N days, by the deadline again (recommended) / no put-off: the
   warning stays until Resume.
6. **D6 (c) The deadline's place**: Settings → Defaults, global with a project's own value, 3 days, 0 off
   (recommended) / the global settings only.
7. **D7 (d) How a proposal names an existing link**: by queue and note date; the server works out the origin and
   shows it (recommended) / by the origin's id, which `nexus ideas matches` would then print.
8. **D8 (d) Outdated**: checked again at acceptance (recommended) / bound to the revision when proposed.
9. **D9 (d) A batch with an outdated item**: the valid items are written together, the outdated ones reported
   (recommended) / all or nothing.
10. **D10 (d) The reason in the history**: the proposer's reason, with the proposal's id and proposer beside `actor:
    user` (recommended) / the user writes a reason at acceptance.
11. **D11 (d) Who is told of the decision**: the orchestrator, whoever proposed (recommended) / nobody (agents read
    it from `nexus ideas status`).
12. **D12 (d) The orchestrator accepting on the user's word in the chat**: no, the dashboard only; `nexus ideas
    accept|reject` stays refused (recommended) / yes, with a command for it.
13. **D13 (d) Status proposals (partially implemented, dropped, recommended for confirmation)**: not now, links only;
    a later queue if wanted (recommended) / in this queue too.
14. **D14 (d) The notes survey**: a later small queue changes the notes template so its survey step proposes the
    missing and wrong links itself (recommended; the recurring notes queue then waits for approval again, and the
    template's survey stop condition changes) / no template change: the orchestrator turns the survey's report into
    proposals.
15. **D15 (d) Waiting cards**: one per proposer's batch (recommended) / one per project, all pending proposals.

## Run control and lifecycle code

None of the steps needs a run-control file (AGENTS.md's list): (b) is `prompts.ts` and `orchestrator.ts`; (c) is the
state derivation (`packages/protocol`), a new server module wired in `main.ts`, the settings and the dashboard; (d) is
the CLI, a new server module wired in `main.ts`, the protocol's link writer and the dashboard. If building shows that
`watchers.ts`, `engine.ts` or `scheduler.ts` must change after all, the step asks first (the queue's stop condition).
