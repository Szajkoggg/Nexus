# Required review decisions

Part of [the design](../DESIGN.md). Queue RVD, step RVD1: the contract and the screens. **Status: a proposal for the
user's review**. The user decided D1–D4 on 2026-11-26, each as recommended (below). **Built so far**: RVD2, the protocol and the server; RVD3, the commands, the briefings, the review helper's packet and the orchestrator's notice (docs/protocol/review.md,
"Review decisions").

**Found in RVD3.** The commands are `nexus decide` (with `--none`, `--withdraw`, `--id`) and `nexus review decide`, as
proposed; `--for` defaults to `user`, so a decision the worker does not classify is never one a reviewer may settle. A
review helper's answer was counted as its verdict (RVD2 put `review.decided` among `HELPER_VERDICTS`): a helper that
answered and then ended without a verdict would have held the step; the verdicts and what a helper may write are now
two sets. "Decisions from earlier reviews" is in every step opening, not in the fresh session's seed: the opening always
follows the seed, so it would say the same twice. The fake runtimes declare none before every `nexus step done` that
declared nothing (`FAKE-DECIDE` lines declare decisions): a server marks every project it starts, the test servers too.

**Found in RVD2.** The mark `review_decisions_since` is written by the server from RVD3 on, not at RVD2's first start:
until the CLI lets workers and reviewers declare a list, a mark would make every new step's list `missing` and hold the
orchestrator's and the helper's acceptances with no way to declare one. A project without the mark reads a step
without a list as `legacy` (unlike `review_levels_since`, whose absence means the new rule). The send-back does not
carry the saved answers in its inbox entry yet: the answers stay in the decision's history, and RVD3's prompt reads
them from there. A user's answer is accepted whoever holds the review (the user may answer before a hand-over). RVD2 (protocol and server), RVD3 (CLI, review helper, orchestrator,
briefings) and RVD4 (dashboard) build what the user accepts here. The mockups are
`docs/ux/mockups/27-review-decisions.html`, drawn over the data of `scripts/capture/seed-review-decisions.ts`.

## The problem

At a design step's review the user often cannot tell what they are being asked to decide. Today the worker writes its
choices into the summary's prose ("For your decision: which layout (I recommend B); whether Snooze…"), and the review
offers only Accept, Fix it… and Reject. Accepting such a step says nothing about the choices: the next worker gets no
answer, and an Accept is read as "yes to everything the worker recommended", which the user never said.

A **review decision** is one concrete question attached to a step's review round, with options, a recommendation and
the material that helps. Every decision the step needs is answered before the step can be accepted. Answering is not
accepting, and neither Fix it nor Reject needs an answer.

Review decisions are not questions (`nexus ask`, docs/design/questions.md). A question is asked while the worker works,
holds the worker (the question barrier, QA4) and is answered so that the work can go on. A review decision is part of
the finished step's review: it never holds or wakes a worker, its answers are not delivered to the step's own session,
and a step with open decisions is simply a step whose review is not over. The two share the answer components of QA3
(one optional choice, optional words, an explicit save, the recommendation never pre-chosen), not their life cycle.

## Concepts

- **Decision list** of a step's round: zero or more decisions, or the explicit statement that there is nothing to
  decide (**none**, with a one-line reason). A list that was never declared is **missing**; it is not the same as
  none.
- **Decision**: `id` (stable within the step: `D1`, `D2`, … in the order written; never reused), `version` (1, then +1
  at each material change), `text` (the question, what is decided), `options` (two or more; each a `label` and an
  optional `effect`: `fix` marks an option that means the work must change), `recommended` (one option's label, or
  none), `material` (review item keys or paths: what helps decide), `why` (the consequences, one or two sentences),
  `for` (`user`: the user's judgement, the look, the feel, the scope, what the project's rules give the user;
  `reviewer`: decidable from the step's evidence by a reviewer), `by` (the worker, or the orchestrator who added it),
  and the `round` it was declared in.
- **Answer**: `decision` (id), `version` and `round` it answers, `choice` (an option's label, or none), `text` (the
  reason or an addition; required when there is no choice: "none of these, instead …"), `by` (`user`, `orchestrator`,
  `helper`), `at`, the event's id. Every save is a new answer; the latest valid one is current, the others are its
  history.
- **Current answer** of a decision: the latest valid answer to its current version in the step's current round.
- **The list is complete** when every decision has a current answer from someone allowed to give it (see the table).

## Who writes the list, and when

**The worker** declares the list before `nexus step done` (RVD3 names the commands; the proposal is `nexus decide
<step> "<question>" --option … --option … [--recommend …] [--material <key|path>]… [--for user|reviewer] [--why …]
[--fix-option …]`, once per decision, and `nexus decide <step> --none "<why>"`). The worker proposes; it never
answers. A design step's briefing asks for concrete choices bound to material; any step's briefing says when a list
is empty (nothing in the step is the user's to choose and nothing deviates from the plan) and that a real decision
must not hide behind a general "nothing to decide".

**`nexus step done` refuses** a step whose current round has neither a list nor none ("Record the review's decisions
first: nexus decide <step> … for each, or nexus decide <step> --none "<why>"."), for every step the new CLI ends
(the user's decision D3: every step, not only design and level-1 steps). Rounds after the first keep the earlier round's list: the
worker may add decisions or change one (a new version) in the new round, and need not declare again.

**The orchestrator** completes the list while it holds the review (level 2 or 3, `review_with: orchestrator`): it adds
a decision the worker missed (`by: orchestrator`), raises a `reviewer` decision to `user`, or drops one that is not a
decision (with why; kept in the history). It never lowers a `user` decision to `reviewer`: only the user's own answer
settles those. A missing list is completed by the reviewer before it may accept: it declares none or adds the
decisions. **The review helper** does not change the list; a list it finds incomplete or wrong is passed on (reason
`decision`).

**The user** does not edit decisions. An answer with no choice and words ("none of these: …") is how the user says
the options are wrong.

## What counts, version by version and round by round

- A change of a decision's text, options, recommendation, `for` or material is a new **version**. Answers to an earlier
  version are not current: the decision shows "You answered an earlier version (B); the question changed" and counts as
  open. A review picture added (or added again) under a key the decision names, after an answer in the same round,
  makes that answer earlier too. A change of `why` alone or of wording the worker marks as a typo fix is still a
  version: Nexus does not judge what is material.
- A **send-back** (Fix it, an orchestrator's or the helper's) opens a new round. Every answer of the earlier round
  becomes **history**: shown under the decision ("Round 1: you chose B"), never current. In the new round the decision
  is open again; one click on "Same as round 1: B" saves it again as a new answer, nothing is pre-chosen.
- The **send-back carries the answers saved so far** to the worker (the decision, the choice, the words, who): they
  tell it what the user already chose. They are information for the fix, not an acceptance.
- **Withdrawing** a decision (the orchestrator, or the worker in a new round) removes it from what must be answered;
  its answers stay in the history.

## Accept and the other actions

| Action | Who | Needs the list complete? | Notes |
|---|---|---|---|
| Save an answer | user, orchestrator, helper (by the table) | no | never accepts, never starts or wakes a worker; refused (409) when the decision's version or round moved since the page read it |
| Accept (`review.accepted`) | user, orchestrator (level 2/3), helper (level 2), Nexus (MI) | **yes**, every decision answered by someone allowed for that acceptor | the request names the answers it saw; a different current set is refused (409) |
| Provisional (`review.provisional`) | orchestrator, level 3 or away | **yes**, its own answers to `user` decisions allowed | the step goes into the return batch with those answers |
| Fix it (`review.sent_back` / `review.fix_asked`) | user | no | its own rules: text not empty; the criteria-override confirmation |
| Reject (`review.rejected`) | user | no | its own rule: reason optional |
| Send back | orchestrator, helper | no | counts toward the send-back limit as before |
| Ask the user (`review.asked_user`) | orchestrator; the helper for `user` decisions (below) | no | the text says which decisions are the user's |
| Pass on (`review.passed_on`) | helper | no | new reasons `decision`, `user_decision` |
| Confirm a provisional acceptance | user only | — | confirms the orchestrator's answers with the step |

**A required answer is not a forced yes.** Every decision accepts any of its options, or none with words. An answer
that chooses an option marked `fix` makes Accept unavailable with the reason "Your answer to D2 asks for a change: Fix
it sends your answers to the worker"; Fix it is offered. An answer never makes acceptable work that contradicts the
acceptance criteria: the reviewer (helper, orchestrator) judges the criteria as before and answers do not replace that
judgement; an orchestrator whose answer contradicts a criterion sends the step back instead of accepting it. The user's
Accept stays the user's judgement of the whole step.

**Accept is checked in one place for every path**: the server's action and the derivation of `review.accepted` and
`review.provisional` both use one predicate (`decisionsComplete(step, acceptor, at)` in `status-rules.ts`), so the
dashboard, a direct HTTP request, an older client and an agent's event are held alike. An acceptance event that fails it
is ignored with a warning naming the open decisions; the HTTP action refuses with 409 and the list ("2 decisions are
open: D2, D3"), writes nothing and forwards no note. Nexus's own acceptance of a clean integration (MI) needs a step
without a list, or with none, or complete.

## Rights: who answers what

Each answer is checked against the step's state **at the answer's time** (`at`), the way `review.provisional` already
is for away mode: the level (the user's level, drafted level, queue's), whether the step waits for the orchestrator or
the user (`review_with`, the user's `asked_user`), whether the user is away (`awayAt`), and whether a helper still has
the round. Replays keep the verdict: a later change of level, a hand-over or the end of away mode does not make an
earlier valid answer invalid, and does not make an earlier refused one valid. A save is also checked when it is made:
the CLI and the server refuse what derivation would ignore.

The worker of the step never answers its own decisions, never accepts and never confirms (the CLI refuses
`nexus review decide` from a worker session; derivation ignores the answer events of worker sessions).

| Case | Review helper | Orchestrator | User | Accept / provisional |
|---|---|---|---|---|
| **Level 1** | — (no helper) | answers nothing; sees the list | answers every decision | the user's Accept, every decision answered by the user |
| **Level 2**, helper on | answers `reviewer` decisions with its reasons; passes on (`decision`) what it cannot settle; hands `user` decisions to the user (`review.asked_user`, the decisions named) when every criterion it could check is met | answers the `reviewer` decisions passed on, completes the list, then accepts or hands over the `user` decisions (`nexus review ask-user`) | answers the `user` decisions; may answer a `reviewer` decision again (the user's wins) | the helper or orchestrator accepts only with no `user` decision; else the user's Accept, with the reviewers' `reviewer` answers counting |
| **Level 2**, no helper | — | as above, all of it | as above | as above |
| **Level 3** (or **away**, level 2) | answers `reviewer` decisions; passes on (`level`, `user_decision`) the rest | answers `reviewer` decisions and, provisionally, `user` decisions, each with why | confirms in the return batch, or Fix it | the orchestrator's provisional acceptance, complete with its own answers; the return batch holds the step |
| **Away ends** during the review (level 2) | as level 2 | its answers to `user` decisions given while away stay as proposals ("given while you were away"); a provisional acceptance after the end is ignored (today's rule); it hands the step over | answers the `user` decisions; one click adopts the orchestrator's proposal as the user's own answer | the user's Accept |
| **The user sets level 1**, or **ask-user** | its verdicts after that are ignored; a running helper is ended | its answers after that are ignored; its earlier valid `reviewer` answers count | as level 1, the reviewers' earlier `reviewer` answers shown and counting | the user's Accept |
| **The user sets level 3** while the orchestrator holds it | as level 3 | as level 3 from that time | — | as level 3 |
| **The send-back limit** reached | — | — | as level 1 | the user's Accept |
| **Return batch** (after a provisional) | — | never confirms | Confirm (the step and the orchestrator's answers), Fix it (with "instead: A" for a decision), or Confirm all | confirmation is the user's only |

The helper's new reasons to pass on (docs/protocol/review.md, "The review helper", **Verdicts**): `decision` (a
`reviewer` decision it cannot settle from the packet, or a list it finds incomplete or wrong) and `user_decision`
(level 3: decisions that are the user's, which the orchestrator answers provisionally). At level 2 the helper hands
`user` decisions to the user itself instead of passing them on, so that the orchestrator spends no turn on forwarding
(`nexus review ask-user` becomes a helper command for that case only; the CLI refuses it while a `reviewer` decision is
open or a criterion was not judged).

## Missing lists and old data

- **Reviews closed before the change keep their meaning.** The server marks once, at its first start with review
  decisions, when the project's steps began to declare them (`review_decisions_since` in `project.yaml`, as
  `review_levels_since`). A `step.done` before that time has no list and needs none: an acceptance, provisional
  acceptance or confirmation it got stays valid; nothing about it is shown or told.
- **A review open at the change** (its `step.done` before the mark) has no list. It is accepted as before; the
  orchestrator may add decisions to it, and the decisions it adds must then be answered.
- **A worker that started before the change** ends its step with the new CLI, which asks for the list; its refusal text
  says how. A `step.done` after the mark without a list (written by an older CLI, or by hand) is **missing**: the review
  shows "The worker declared no decision list", the reviewer must declare none or add decisions before accepting, and
  the user may accept (the user sees that nothing was declared).
- **A steady file format**: decisions and answers are events in session logs (one writer per file: the worker's and
  orchestrator's and helper's own logs, the server's user session for the dashboard); no old event is changed. Their
  readers give a missing list for steps without them.

## The return batch and group confirmation

The return batch item of each provisionally accepted step lists the orchestrator's answers under the step: the
decision, the answer, its why and time, marked `provisional` and "while you were away" where it was. For each step the
user Confirms (the step and every answer with it) or asks Fix it; next to a decision, **Instead…** opens Fix it with
"D1: I choose A instead of B (the orchestrator's choice)." written in, which the user can extend. The step's work stays,
as with any Fix it of a provisional acceptance; the orchestrator drafts a revision that fixes it.

**Confirm all** (the user's decision D4) confirms every step listed, after a confirmation that lists each step's orchestrator
answers to `user` decisions. The request names each step and the provisional acceptance it saw; if any changed (a
confirmation or Fix it elsewhere, a new provisional), nothing is written and the list is shown again.

## What the next worker gets

The answers a step's review accepted (and those accepted provisionally, marked so) are the queue's decisions. The
opening of every later step of the queue, and a fresh session's seed, carries them in a short section, "Decisions from
earlier reviews": the step, the question, the answer, its words, who answered (the user; the orchestrator, provisional
or confirmed). A Fix it's revision step gets the answers the user gave in the batch. `nexus status` shows a step's
decisions and its open count; the orchestrator's review notice and the helper's packet list the decisions, the answers,
what is open and who may answer it.

## The screens (mockups)

`docs/ux/mockups/27-review-decisions.html` draws the step panel of the seed's WT1 at 1440, 492 and 390 px, over
today's panel (captured as `review-decisions@…` before):

- **review-decisions**: "Your decisions · 1 of 3 answered" at the top of the panel, before the summary. Each decision is
  a card: the question, what follows from it, the options as buttons (the recommendation marked, never chosen), the
  material as links ("View A and B" opens the viewer on that pair), words, and **Save** on the card. D1 is saved
  ("Saved · you · 04:58"), D2 has a choice not yet saved, D3 is open. The action bar's Accept is disabled with "2
  decisions open"; Fix it… and ⋯ (Reject, Add note) work as today.
- **review-decisions-complete**: all three saved; the cards fold to one line each (the question, the answer, Change);
  Accept is enabled ("Accept and go on"), still a separate click.
- **review-decisions-return**: the waiting list's return batch, one provisionally accepted step with the orchestrator's
  three answers (each with why and time, "while you were away"), Confirm, Fix it, Instead… beside a decision, and
  "Confirm all 2".

The picture viewer's action bar shows the same count beside its disabled Accept, and a **Decisions (1 of 3)** button
that opens the same cards as a sheet over the viewer, with the decisions whose material is the shown picture first;
Fix it and Reject stay available. RVD4 adds the viewer as `review-decisions-viewer@492` and a Fix it without answers as
`review-decisions-fix@390`.

## Decided in this design (technical; the designer's)

- Decisions and answers are events (`review.decision`, `review.decisions_none`, `review.decided`; RVD2 fixes the
  names), derived like the other review events; the one predicate gates every acceptance path.
- Answers pin decision `version` and `round`; a stale tab is refused with 409, never overwrites.
- Rights are checked at the answer's time; replay keeps the verdict.
- A send-back opens a new round; earlier answers are history and travel with the send-back as information.
- The list never holds, wakes or answers a worker; the question barrier (QA4) is untouched.
- `review_decisions_since` keeps old steps valid; a missing list is distinct from none.
- The helper may hand `user` decisions to the user at level 2.
- Answers of accepted reviews go to the next steps' openings and fresh-session seeds.

## The user's decisions (RVD1)

Asked with `nexus ask` at RVD1, each with its material; the user answered all four on 2026-11-26, each as recommended.
The options not taken stay here as the record of what was weighed.

- **D1 Layout**: (A) the decisions first, as cards above the summary (the mockups); (B) a short strip at the top
  ("3 decisions · 1 answered · Go to them") with the cards after the pictures, next to their material
  (`review-decisions-layout@1440` variant-a and variant-b). Recommended: A, because the complaint is that the user does
  not see what to decide; B keeps the pictures first, as the review has them since UX proposal 13. **Decided: A.**
- **D2 Saving**: (A) each card has its own Save (as the question cards of QA3); (B) choices are drafts and one "Save
  answers" saves all. Recommended: A: a partial save is natural, a stale tab is refused for one card only, and the
  dashboard has one way of answering. **Decided: A.**
- **D3 Which steps declare a list**: (A) every step ends with a list or an explicit none; (B) only design steps and
  level-1 steps must, the others may. Recommended: A: the cost is one command, and a code step's deviation or a
  user's judgement shows up as a decision instead of in the summary's prose. **Decided: A.**
- **D4 Group confirmation in the return batch**: (A) per step only; (B) Confirm all, after a confirmation listing the
  orchestrator's answers to `user` decisions; (C) Confirm all only for steps without such answers. Recommended: B.
  **Decided: B.**
