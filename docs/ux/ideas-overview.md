# The ideas overview: statuses, areas, matching (proposal, queue IO step IO1)

What the user decided on 2026-11-15 is in `docs/ideas/ideas-overview.md` (Decided) and in queue IO's description. This
proposal settles what was left open there: the statuses and where each comes from, where a note's area and a
project's sub-groups come from, and how the existing queues are matched to the notes once. The mockups are
[22-ideas-overview.html](mockups/22-ideas-overview.html) (`?view=entry`, `?view=matching`; `?theme=paper|honey`).
The points marked **(ask)** went to the user with `nexus ask`; their answers are at the end, and the
proposal follows them.

## What was found

- 52 of the 84 queues of Nexus name a note in their description (`docs/ideas/<file>.md`), almost always with the date
  of the decision in the same sentence ("A felhasználó 2026-11-14-i döntése (docs/ideas/backlog-smaller-items.md)").
  One names an entry exactly (`docs/ideas/tags.md#2026-11-14`). The matching can lean on that.
- Decided entries are not always unique by date: `queue-plan-view.md` has two `### 2026-11-15` headings, others have
  `### 2026-11-14 (later)` or `### 2026-11-14: the work of a stopped step`; `side-panels-and-waiting-list.md` nests
  them as `#### 2026-11-13` under a `### Decided` per topic; two notes write `### … (decided 2026-11-14)`.
- `docs/ideas` is not tracked in git; the notes are read where they are (the project's notes folder).

## The unit: a dated entry

An **entry** is everything under one date in a note's Decided section(s): the headings that begin with a date
(`2026-11-14`, `2026-11-14 (later)`, `2026-11-14: …`) or end with `(decided 2026-11-14)`, at any heading level under
a heading named Decided. Entries of the same date in one note are **one entry**, shown with their own headings
inside. The reference is `docs/ideas/<file>.md#<date>`, as already decided; it stays valid when the partner adds a
"(later)" heading on the same day. An entry is shown by its date and the bold lead of its first bullet ("A view that
lists the ideas in a hierarchy…"), and how many decisions it holds.

## Statuses

Per entry, in their order (the least advanced first):

| Status | Meaning | Comes from |
|---|---|---|
| **decided** | under Decided, nothing has happened since | the note (the entry exists) |
| **handed over** | a hand-over to the orchestrator covered it | the hand-over record: `nexus covers <file>#<date> …`, which the partner runs before its summary (IO2b), kept in its own session's events |
| **queued** | a queue names it, from its upload on (proposed, approved, running, stopped) | the queue's `source` list (or an accepted match, below); the line shows the queue's own state |
| **built** | every queue that names it (cancelled ones aside) is finished | the queues' finish, with the last commit of each |
| **dropped** / **replaced** | the user dropped it, or a later entry replaced it | the note: a line `**Dropped:** <date>: <why>` or `**Replaced by:** <file>#<date>` right under the entry's heading, written by the partner **(ask)** |

- A **topic** (a note) shows the least advanced status of its entries, dropped and replaced ones left out; with no
  Decided entry at all it is **being worked out**. Its Open questions are a count beside the status ("2 open"), not a
  status: a built topic can have new open questions.
- **Dropped and replaced win over every other status**, whenever they come: an entry can be dropped after a queue
  ran with it, even after it was built (it turned out not to be feasible, or was taken back). The history keeps the
  queues' lines and ends with the drop.
- A queue that is cancelled or withdrawn no longer counts; the entry falls back to handed over (or decided).
- Nothing is kept by hand: every status is derived again from the files whenever they change. A status the records
  cannot show (a hand-over before `nexus covers` existed) is simply skipped in the history ("handed over: before the
  records").
- The **history** of an entry, newest last: decided (the date), handed over (time, the conversation), queued (time,
  the queue, and its approval and start as faint lines), built (time, commit), dropped or replaced (date, why).

## Areas and sub-groups

- **A note's area** is a line under its Summary: `**Area:** dashboard`, optionally with a sub-group:
  `**Area:** dashboard / chats`. One area per note: the main one; a topic that touches several names the one it is
  mostly about **(ask)**. The partner writes it (the README's convention and the partner's briefing say so; the
  existing 32 notes get theirs from the partner, like their Summaries). The area must be one of the project's areas.
- **Without an Area line**, the view takes the area most of the note's queues' steps carry; failing that, the note
  is under **Unsorted** (with a hint: "the partner adds `**Area:**`").
- **Sub-groups** are part of the project's tag lists (`.nexus/tags.yaml`): `nexus tags propose --area
  dashboard/chats`, accepted by the user in Settings like any area. Only the notes use them (a step's area stays the
  area) **(ask)**. A note naming a sub-group that is not on the list is shown under it anyway, marked "not on the
  list".
- The hierarchy: area → sub-group → note → entries. Areas in the order of the project's list, Unsorted last.

## The view

- The Ideas panel's header gets a switch **Conversations | Overview**. The overview fills the middle column; the
  status filter (one choice: All, or one status, with counts) and a text filter are above the list; the area groups
  fold.
- Each note is a row (title, Summary on one line, its status, open questions); its entries are lines under it with
  their own status and queue. Filtering by status shows only the entries with that status (and their notes).
- **Opening a note** shows it where a step opens on a desktop: in the rail's place, so the list does not move
  **(ask)**. There: the Summary, the area, the entries with their statuses and histories, the Open questions, the
  queues with their states, and a link to the file. On the phone the note opens over the list (Back returns).
- Clicking a queue opens it as today; a commit opens the commit view.

## Matching the existing queues (once)

- The server writes **suggestions** for every queue without a `source`, from the references in its title,
  description and step goals: an exact `<file>#<date>` (exact); a file with a date in the same sentence that is
  one of the note's entry dates (date in text); a file alone (file only: the note's entries dated on or before the
  queue's creation, not yet matched elsewhere). `docs/ideas/README.md` is not a note and is skipped.
- They go to a server-written file, `.nexus/idea-matches.yaml` (queue, reference, kind, the quoted sentence; then the
  user's decision and its time). The closed queues are not touched.
- In the overview a button **To match · N** opens the suggestions, one card per queue with its quoted sentence and
  its suggested entries; each is **Accept** or **Reject**; **Accept the exact and dated ones (N)** takes the exact
  and date-in-text suggestions at once (file-only ones are decided one by one). An accepted match counts like the queue's `source`. Only the user decides: the dashboard's request, never
  an agent's CLI.
- The button stays while undecided suggestions remain; later queues have their `source` from the orchestrator and
  need no matching. Linking a queue to an entry by hand (no suggestion) is not part of IO **(ask)**.

## Answers of the user

Asked on 2026-11-15 with `nexus ask`; the user took the recommended option each time.

1. **Statuses**: as proposed (the order, queued from the upload, built when every naming queue is finished, entries
   of one date in a note are one entry). The user added: an entry can be dropped even after a queue ran with it
   (it turned out not to be feasible); hence "dropped and replaced win over every other status".
2. **Dropped and replaced**: a line in the note (`**Dropped:**` / `**Replaced by:**`), written by the partner.
3. **A note's area**: one main area per note.
4. **Sub-groups**: in `.nexus/tags.yaml`, proposed by the orchestrator and accepted by the user in Settings.
5. **Where a note opens on a desktop**: in the rail's place, like a step. Linking a queue to an entry by hand was
   not asked for: it stays out of IO.

What the steps cannot do themselves: the `**Area:**`, `**Dropped:**` and `**Replaced by:**` lines, and the README's
convention for them, are the thinking partner's to write (`docs/ideas` is the partner's; no IO step writes there).
IO2b's briefing tells the partner; the existing notes get their Area lines from the partner.
