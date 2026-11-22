# Questions

Part of [the design](../DESIGN.md).

## Questions: worker ↔ orchestrator ↔ user

A worker's question goes to the orchestrator first, not straight to the user. The worker states whether it can
continue with independent work meanwhile. The orchestrator then:

- answers it itself when the answer is already settled (in the approved queue, the project rules, earlier decisions),
- or escalates it to the user, with its own framing and a recommendation, and tells the worker whether to wait or
  to go on with independent work.

Whether to block is thereby decided between the worker and the orchestrator for each question, not by a global
rule. Questions that are the user's by the project's rules (the look, gameplay, final numbers in Honeycomb) are
always escalated; the orchestrator never answers on the user's behalf there.

The user sees every question and answer in the dashboard, including those the orchestrator settled, and can
override an answer.

## Question navigation identity (QA1 finding)

Waiting-list identity includes a question's qid, but the baseline navigation address carries only project,
queue and step. StepDetail consequently chooses the first open question for its main answer form, even
after the user clicked another question. Existing qid-based React and draft keys do not repair that earlier
loss of identity. The API and inbox route the qid they receive correctly. Preserve explicit question identity
through navigation and refresh; a generic step link can keep its first-open default. Do not infer current
question state from historical prose. The original incident, isolated browser traces, separate desktop-option
gap and smallest correction are documented in [the QA1 reproduction](../qa/question-target-reproduction.md).


## Preserving the selected question (QA2)

An optional qid is now part of the dashboard address, waiting position and sequential
navigation. StepDetail resolves it within the selected step's questions. Explicit
question links take precedence over step review controls, show the selected question
first, and retain an answered/withdrawn target or show an unavailable message. Only
plain step links keep the first-open fallback. A normal answer leaves the selected
question visible with its recorded answer and the other questions still present;
the explicitly requested sequential mode advances to the next distinct waiting item.

Answer components and option handoffs are scoped by project and qid. In-flight sends
capture their own text, option and continuation flag; existing draft handling retains
words edited during a send or a failed save. The desktop action bar labels the question
it answers. Desktop option buttons remain QA3; requiring all answers before work
resumes remains QA4. No API, answer event or inbox contract changes in QA2, including
the existing support for additional answers to an answered question.

The committed `scripts/question-target.mjs` preserves QA1's clicked-BRAVO regression.
After building the dashboard, run it with an optional output directory outside the
checkout. It uses temporary projects, fake-runtime server configuration and external
fixture workers, with real browser requests. It checks all three widths, reload and
Back, project isolation, reordered/new questions, failed/slow saves, another browser
answering the target, withdrawal, missing targets, sequential navigation and the
desktop action bar. Request, answer event and worker inbox identities are asserted.
No model is called; answer delivery code has not changed.

The initial QA2 probe stopped after three harness failures; its source and observations
remain review history. On user-authorized resumption, the second-page scenario uses
an actual second browser instead of a Node POST without Origin. The server's existing
same-origin write restriction remains intact. A real browser also preserves the
additional-answer contract when its first page is stale.

## Clickable question answers on every layout (QA3)

The phone sheet and every desktop question's card share `useAnswer` and `AnswerFields`.
Each form has one optional choice, optional words and one explicit send action, bound to its project and qid.
Recommendations never choose for the user. Choosing again clears the choice; arrow keys, Home and End move it.
The choice stays in memory while that form is mounted; words keep the existing per-question persisted draft.
A reload restores words without inventing a selection. Failed saves preserve both; a synchronous submit guard
prevents repeated clicks or keys from sending twice before the busy state renders. The option cannot change
during a send; words edited during it remain a draft. All forms post only to the question-answer endpoint.

In QA3 round 2 the user replaced the desktop answer bar with complete per-question cards. An explicit question
link puts that card first and scrolls it into view; the phone keeps its sheet and bottom Answer action. Closed
questions keep their option lists. Labels inside option buttons wrap so that long options remain readable.

The same round explicitly brought the all-questions prerequisite into this step: partial answers are saved and
routed durably, but the engine holds their delivery, ordinary messages and subsequent work while any question for
the current queue and step is open or escalated. The barrier is scoped by queue and step rather than session,
so it survives a session change without blocking another queue. The last answer releases accumulated answers
together in one turn. State derivation also keeps the waiting status until the last question closes. A withdrawal
counts as closure; the existing continuation checkbox instruction remains intact. Fake-runtime tests cover three
questions, a nonblocking question, another queue, partial saves, Resume and restart with both adapters.

`scripts/question-options.mjs` checks three widths against isolated fake-runtime instances: separate selection and
send, primary and secondary forms, exact request/event/inbox targets, continuation flags, free text with and without
options, project/target switches, reload, reordered live data, failed/slow saves, duplicate submission and keyboard
input. It also runs the layout-faults CLI. The raw collector includes boxes outside their scroll viewport, so the
probe additionally asserts non-overlap of visible option rectangles and records their clipping geometry.

## Completing the question barrier (QA4)

The baseline reproduced a second hole: after two `continue:true` partial answers, a final `continue:false`
still opened a worker turn on both fake runtimes. The old flag was only prompt wording. `questionBarrier` now
derives both the remaining count and the latest answer's wait decision from durable events, scoped to queue and
step. `can_continue` only describes independent work inside the asking turn; even those questions show waiting.
The same predicate gates delivery, nudges, step openings, advancement, fallback and finishing after an exit.

Explicit Resume records the released answer id in `run.yaml.answers_resumed`. Automatic recovery, usage retries
and approval resumes do not grant it. A later answer is a new decision. The question barrier does not replace
pause, stop, approval or review. Resume prefers pending answers over a new step-opening prompt: otherwise a
paused worker asks its questions again instead of seeing the saved replies (reproduced with both fakes).

All accumulated answers and ordinary messages are delivered in one turn after the asking turn ends. Each answer
names its qid. The server rereads the question state immediately before delivery/opening; a question recorded
with the last answer keeps the barrier closed. Fallback records delivery after sending, retaining unread entries
in the replacement inbox if its opening is held. Answer routing follows replacement worker sessions as well as
orchestrator sessions; no historical log is edited. Repeated identical HTTP user answers are idempotent, while
different additional answers remain supported.

The desktop cards, phone sheet and run controls share the remaining-count and permission text. Answer remains
available while questions remain; Resume cannot promise a start with outstanding questions. The honest queue
status and digest also treat all open questions as waiting. Captures use two saved answers and one open question,
plus the all-answered state, at 1440/492/390 px. Protocol, fake-runtime, HTTP and browser regressions cover the
saved state separately from actual turns, runtime work markers and delivery traces.
The step panel uses the existing bounded-header option on desktop: this removes the old 8 px negative close-button
margin reported by layout-faults. The phone header is unchanged; both capture states have zero layout faults at
all three widths.
An additional reuse probe found that selecting the first queue with a matching session could pick an older halted
run and apply its questions to the current queue. Inbox ownership now prefers the going run, then the session's
current queue. Both fake adapters cover an old halted run and its open question sharing the current session id.
