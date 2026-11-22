# Done here, continued elsewhere (queue UF)

Asked by the user on 2026-11-18: a step whose work was done, but whose fix went on in later steps or another queue,
reads "skipped", which says "not done". Designed in UF1 (mockup `docs/ux/mockups/25c-step-list-done-elsewhere.html`:
the step list and the digest, and with `?panel=detail` the step), to be built in UF2 once the user has decided, since
the recommendation changes a file format and a command (UF's stop condition).

## The case

Queue FL, 2026-11-18. FL2 and FL3 were to find why tests failed and, when the cause lay in the product, to describe
it and stop before fixing it. Both did: they stopped at that stop condition with the cause written up (FL3 also with a
commit the user kept). The user approved the next revisions, which planned the fixes as new steps (FL4, FL5; FL6 to
FL8), and the orchestrator closed FL2 and FL3 with `nexus queue set FL --step FL2 skipped --reason "…; the fix is
planned as FL4 (design) and FL5 (code)"`. That is the only way it has: the orchestrator never marks a step done ("work
done elsewhere is skipped, with the reason saying where", docs/protocol/queues.md, "queue.yaml").

What the user sees today: a grey dot and "skipped" in the step lists, the title dimmed, the same as a step dropped
without ever running; the progress line's grey segment; nothing in the morning digest (a skip is no event; the stop
before it is the last line there, so the digest never says the stop was resolved); in the step itself, "skipped" and
the reason only in its changes. The statistics count FL2 and FL3 as stops that were neither accepted nor failed.

Two kinds of step share the need: (a) the step did its own work and what it found goes on elsewhere (FL2, FL3), and
(b) the step's work was done by another step or queue (a duplicate). A step simply dropped stays "skipped".

## Options

- **A. A new step status `continued`.** Honest wherever a status is read, but every rule that says "done or skipped"
  must learn a third word, and one forgotten is a bug that does not show until it bites (a queue that never finishes,
  a planned queue that never starts): the queue's own status and `finished`, `doneForPlan` and the merge train, the
  levels' closed set, the attention items, `nexus status`, the statistics, the dashboard's tones, `foldSteps` and
  `queueStatus`, about thirty places. An older CLI or dashboard meeting the new word shows it as unknown.
- **B. A mark on `skipped` (recommended).** The status stays `skipped`, so everything that closes a step, finishes a
  queue or lets a plan go on is unchanged; the entry that skips the step also says where its work went on. Only the
  places that show a step learn to read the mark.
- **C. Nothing in the files: the dashboard finds step ids in the reason.** No protocol change, but a reason is prose:
  "replaced by FL4" and "FL4 failed, so" read alike. Rejected.

**Recommendation: B**, with the user's words: the user asked for "done, fixed elsewhere"; the interface says
**continued** rather than "done", since "done" in Nexus means accepted at its review, and these steps were not. The
step's own box says "Its own work is done", which is what the user wanted read.

## The mark (B)

- **The file**: a `changes` entry of `kind: status`, `to: skipped` gets an optional `continued_in`, a list of where the
  work went on: a step of the same queue (`FL4`), a step of another queue (`QX/QX2`), or a queue (`QX`).
- **The command** (the orchestrator's housekeeping): `nexus queue set <queue> --step <step> skipped --continued-in
  FL4,FL5 --reason "…"`, its event `status.set` carrying `continued_in`. The server checks that each reference names a
  step or queue of the project (pending or proposed is fine: the work is planned there) and not the step itself; the
  closing and integration steps are refused as skipping them is. Allowed from the statuses skipping allows, and also
  on a step already skipped without a mark (an entry from `skipped` to `skipped`), so FL2 and FL3 can be marked after
  the fact. Without `--continued-in` skipping is as today.
- **Derived**: the step view gets `continued` (`in`, `at`, `by`, `reason`) from its last entry with the mark, gone
  when the step's status changes again.
- **The orchestrator's briefing**: "marking a step done (work done elsewhere is skipped, with the reason saying where)"
  becomes: a step whose own work is done while its fix or rest goes on elsewhere, or whose work another step or queue
  did, is skipped with `--continued-in` naming where; a step dropped is skipped without it. The refusal of `done` says
  the same. An `Agents:` line in the commit.
- **Consent stays the user's**: the mark is no acceptance and no "done"; the step stays unaccepted in the statistics,
  and the step's box says so ("not a review: the step was not accepted"). The user asks the orchestrator in the chat
  to set or change a mark; no dashboard control for it in UF2.

## Where it shows

| Place | Today (skipped) | With the mark |
|---|---|---|
| Step lists (the queue card, the queue panel; `StepRow`) | grey dot, "skipped", title dimmed | a ring in the done colour, "→ FL4, FL5" (three or more in a row of one queue: "FL6 – FL8"; the tooltip names them all), title not dimmed |
| Progress line | grey segment | the done colour, hatched |
| The phone's fold (`foldSteps`) | "FL1 – FL4 · 2 done, 2 skipped" | "FL1 – FL4 · 2 done, 2 continued" |
| The queue's count ("4 of 9") | closed | closed (unchanged) |
| The step (panel) | "skipped", the reason in its changes | the badge "continued in FL4, FL5", and first a box: "Its own work is done; what it found went on in" with each step or queue as a link, its title and its status, then the reason and "Closed by the orchestrator · time · not a review" |
| Morning digest | nothing | a line at the mark's time: "continued in FL4 FL5 · <reason>", after the step's stop line |
| `nexus status` | `skipped` | `skipped → FL4, FL5` |
| Statistics | a stop, neither accepted nor failed | unchanged in the counts; the step stats get `continued`, and the stops column's tooltip says how many of the stopped steps continued elsewhere, so a stop by design does not read as a step lost |

## Effect on the protocol (for the user's decision)

- `queue.yaml`: the `changes` entry's optional `continued_in` (docs/protocol/queues.md, "queue.yaml", the
  orchestrator's housekeeping table).
- The event `status.set`: optional `continued_in`.
- The CLI: `nexus queue set … skipped --continued-in <refs>`, its help and its refusals.
- The state API: the step view's `continued`; the digest's item kind `continued`.
- The orchestrator's briefing (`apps/server/src/prompts.ts`).
- No new status, no new event type. An older server rewriting `queue.yaml` drops unknown fields (its schema strips
  them), so the mark is only written once the CLI and the server that know it are deployed together; an older CLI
  refuses `--continued-in` as an unknown option, which says so.
