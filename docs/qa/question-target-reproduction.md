# Question target reproduction (QA1)

Baseline: `51e57228265de7908a7ff21f495ea460c7f1bb84`, 2026-11-17.
This step documents the fault; it changes no application behaviour.

## Finding

A waiting item's `qid` is lost when the dashboard opens its step. `stepLayout` then
selects the first open question in the step's question array. That is the target of
the phone's `QuestionSheet` and the desktop's bottom `AnswerBar`, irrespective of
which question the user clicked. The request, event and worker inbox agree with
that replacement target. The server does not rewrite a correctly addressed answer.

This is distinct from the desktop's missing option controls, from a temporarily stale
page, and from another question genuinely awaiting a separate decision.

## Original evidence and its limits

Read-only sources: the IC1 worker/orchestrator/user event logs and the screenshot
attached to the orchestrator chat at `2026-11-16T23:02:10.929Z`,
`.nexus/uploads/20261116-230153-8c3b1d9f08.png`. Times below are UTC.

| Question | ID | Evidence |
| --- | --- | --- |
| Original status rules | `01M7K8MZJ3GHFAB254R3YDZHK4` | At 22:54:14.492, user answer `01M7K92WYWMJGE6X1CSTRBWHC3` says “Mindig új chat, de ugyanez a közvetlen átadási előnézet”. The text concerns chat, but the event targets status rules. |
| Chat behaviour | `01M7K8N1564NQ9DS8ZR193RDJV` | Separate question; later withdrawn after the worker retained the user's chat decision. |
| Status clarification | `01M7K94P9RRDSQ3FKTSPQGWREH` | User answered at 22:56:51.145 and again at 22:59:54.616. It was already answered when the screenshot was sent. |
| Screen/plan approval | `01M7K98FKJ9SWPTZKK4013HWNK` | Asked at 22:57:17.428, escalated at 22:58:04.948, answered only at 23:07:52.480. This is the one question shown in the screenshot. |

The screen/plan question's historical prose says that a separate status clarification
is still open. That prose is not its current state. At the screenshot's time the
screen/plan decision really was outstanding; the image does not prove a stale status
badge. At QA1 inspection both status clarification and screen approval are answered.

The historical logs contain no browser click trace or HTTP request capture. They prove
the mismatched text/target, but do not prove the exact historical click sequence. The
isolated browser reproduction below proves the current code's target-selection fault
without retroactively claiming access to that missing trace.

## Minimal reproduction

Create one started step with three blocking questions, in this event order:

| qid | Question | Options |
| --- | --- | --- |
| q1 | ALPHA: choose a color | Red, Blue |
| q2 | BRAVO: choose a layout | Grid, List |
| q3 | CHARLIE: choose a sound | Bell, Chime |

The waiting list is newest first: q3, q2, q1. The step's questions remain in event
insertion order: q1, q2, q3.

1. At 390 or 492 px, click BRAVO (the second waiting card), or its `2 · List` button.
2. The sheet opens `#/qa-repro/Q/Q1` and shows **ALPHA**, with Red/Blue controls.
   The selected List option is not shown. The position says `1 of 3 waiting`.
3. Enter `Draft intended for BRAVO` in the main answer box and press Answer.
4. Observe `POST /api/projects/qa-repro/questions/q1/answer` with
   `{"text":"Draft intended for BRAVO","continue":true}`.
5. `answer.given` carries q1 and that same text. The asking worker's inbox has one
   `answer-<event id>` entry with q1 and that same text. q2 and q3 still wait.

The extended run adds q4 before this send: its remaining list is q4, q3, q2. The
recorded slow-send request, event and inbox therefore retain q1 while all three other
questions remain unanswered. `observations.json` contains each snapshot and event ID.

At 1440 px the waiting rail opens the same step, with all three question cards but
the bottom answer bar still targets q1. A second desktop fixture clicked q6/FOXTROT;
the bottom bar posted q5/ECHO. Answering the explicit q7/GOLF card instead posted q7
correctly. These are separate forms, and the card's correct target does not make the
bottom bar's implicit target safe.

## Code path

| Stage | Baseline behaviour |
| --- | --- |
| `packages/protocol/src/attention.ts` | `attentionKey` includes qid; `mergeAttention` sorts newest first. List identity is present. |
| `components/Attention.tsx` | `WaitingList`, `WaitingCards`, `AttentionPanel` pass the clicked item, including qid. `attentionTarget` returns only the step. |
| `App.tsx` | `openWaiting` calls `nav.closeThenItem` with project/queue/step. The project's attention callback also passes only those fields. `chooseOption` remembers qid but navigation does not. |
| `nav.ts`, `hash.ts` | `item`, `closeThenItem`, `itemHash`, `parseHash` represent project/queue/step only. Reload and notifications cannot recover a selected question. |
| `waiting.ts`, `App.tsx` | `Place`, `waitingPosition`, `moveOn` identify a place by project/queue/step. Several questions there count as one place, and sequential navigation skips their separate identities. |
| `details.ts` | `stepLayout` uses `questions.find(isOpenQuestion)` when not reviewing/read-only. It has no selected-qid input. |
| `components/details/StepDetail.tsx` | `Question`, `QuestionSheet` and `AnswerBar` are already keyed by qid. The wrong question is chosen before these keys are applied. |
| `components/details/questions.tsx` | `useAnswer` binds URL and draft to its actual `q.qid`; it posts to `/questions/<qid>/answer`. The main bar/sheet receives the first open question. |
| `ui.tsx`, `drafts.ts` | `useDraftText` initially reads the supplied key. Keyed callers and `ComposerBox` remount for a different target; draft keys include project and qid. Slow completion clears only an unchanged draft. |
| `apps/server/src/main.ts:493` | Passes path qid and body text/continue straight to `answerAsUser`. |
| `packages/protocol/src/actions.ts` | `answerAsUser` finds that exact qid, rejects unknown/withdrawn questions, appends `answer.given`; `routeAnswers` routes the same qid/text once per answer event to the asker's inbox. |
| `packages/protocol/src/state.ts` | Looks up the event qid in the question map, appends the answer and updates that question. No selection by list index or text. |
| `components/Notify.tsx`, server `remote.ts`, `public/sw.js` | In-tab and push links omit qid. The service worker navigates to the supplied step URL; it cannot restore question identity. Source-inspected; no external push service was called. |

## Browser observations

The development instances used free ports 4318/4319, temporary NEXUS_HOME, and the
repository's fake Claude/Codex runtime configuration. Fixture sessions were external
workers, so delivery was checked in their durable inboxes without starting a model or
letting a fake worker finish the fixture. Browser requests used the real local HTTP API.

| Case | Result |
| --- | --- |
| Waiting cards at 390 and 492 px; desktop rail at 1440 px | Clicking q2 or q3 opens the first open question. Clicking the third displayed row, q1, happens to match. |
| Go through them one by one, all three widths | The newest waiting item is q3; the opened primary answer is q1. |
| Waiting-card option | List is stored under q2 in the in-memory option map; the q1 sheet shows no selection. |
| Phone selection | Red can be selected and combined with free text. It is not confused with List. |
| Back, reopening another card, full refresh | Free text remains under `qa-repro/answer/q1`. The selected radio option is lost on remount; text does not move to another qid. |
| New q4 arrives, waiting list positions change | The open sheet stays q1; clicking q2 again still opens q1. |
| Reverse the question array in a browser-intercepted state response | The primary sheet changes q1 to q3; q1's draft stays in its own card. Restoring order restores the q1 sheet and draft. This is a synthetic order perturbation, not a server write. |
| 1.6-second delayed POST, typing during save | Original text/q1 are sent; new words remain in q1's stored draft. After refresh the primary form becomes q2 and reads q2's draft. |
| Another browser page answers q2, original page's GET refreshes held | The original page still shows q2. A second q2 answer is accepted and delivered as a second answer event. Releasing refreshes changes the form to q3, without bringing q2 text into q3. |
| q3 withdrawn while refreshes held | The stale q3 form sends q3 and displays “the question was withdrawn”; no answer event or delivery is created. Releasing refreshes shows q4. Withdrawal was a fixture agent event: there is no browser question-withdraw API. |
| Two synchronous clicks before React's busy render | Two requests/events/inbox entries for q4, both with the same text. A later click while busy adds no request. This synthetic same-task double click is stronger than an ordinary human double click. |
| Desktop bottom bar versus per-card AnswerBox | Bottom bar targets the first open question; a specifically located card's AnswerBox targets that card correctly. |

The concurrent-page probe used independent browser profiles sharing the same server;
it exercises server updates and stale views, not shared-profile storage events. The
timing controls delayed requests/refreshes in the browser, not production server code.
No claim is made that the original incident involved either timing fault.
The exploratory final `queue-step-row-open` record did not verify a matching queue-row
button (`QUEUE BUTTONS []`); it is not used as evidence. The sequential entry point
above was verified through its actual “Go through them one by one” button.

### Desktop options are a separate gap

`Question` renders options as a plain `ul/li`. `AnswerBar` and `AnswerBox` accept only
text, whereas `QuestionSheet` implements a radiogroup and combines choice with words.
There are zero question-option radios at 1440 px, versus two at 390/492 px. The desktop
review-level radios are unrelated and were excluded from the count. Missing option
buttons do not explain why navigation discards qid; QA3 should address them separately.

### Continuation is a separate backend issue for QA4

The q1 answer with `continue:true` moves the step to running although q2/q3/q4 remain
open. `state.ts`'s `resume` does not check the other open questions. This observation
does not imply that QA1 started a worker; no queue run was launched. QA4 owns the
all-answers prerequisite and its engine/fake-runtime coverage.

## Regression and review artifacts

Review material is outside the working tree, registered through `nexus review add`.
The source `probe.mjs` can run the full observation matrix or `--regression`. The latter
starts a fresh isolated fixture, clicks q2 at 390 px and asserts its actual heading.
On this baseline it fails with expected BRAVO, actual ALPHA, after successful fixture,
server and browser setup. It stops at that first assertion and closes its resources.
The failing regression is review material only, not part of the committed test suite.

`scripts/capture.ts` took `question-second@390`, `@492`, `@1440` on this unchanged
baseline using the registered seed/views files. They are registered as **before**
images: the capture tool's `--no-before` run called its current side “after”, but no
application change has been made. The extended probe also captured the waiting list
and the states after answers/withdrawal. Its timing/network observations cannot be
expressed by the capture tool's static action list, so they use its EdgeBrowser helper.

Visual inspection confirms readable question text and controls. Baseline layout
`layout-faults.ts` reports 0/0/1 through/overlap/cut at 390 px, 0/0/0 at 492 px,
and 0/0/1 at 1440 px: the deliberately truncated phone breadcrumb and desktop header
overflow. An additional broad `aside` collector also sees the underlying rail and its
replacement drawer as overlapping. These are documented, not silently reported as zero faults or
changed in this diagnostic step.

Existing attention/details/drafts/hash/waiting and protocol actions tests pass. They
cover stable keys, first-open fallback, pure draft storage, hash round trips and
delivery, but not the clicked-question-to-rendered-question invariant. In particular,
`details.test.ts` explicitly expects the first open question, and `waiting.test.ts`
explicitly groups multiple items at one place. The full queue checks are reported in
Nexus separately.

The default full-suite attempt emitted nine runtime-test failures under load and was
stopped after 567.74 seconds. Every failed case then passed unchanged in focused runs
(43 tests across six files, with the closing file restricted to its relevant pair).
The final whole-suite verification uses the complete original file list with the
existing documented `--test-concurrency=4` setting before the file globs. No assertion
or timeout was weakened. The first attempt's log and the measured final result remain
review artifacts; the precise cause of each incidental failure is not claimed.
The bounded full run passed all 1,239 tests, with no skips, in 1,094.98 seconds.

## Smallest correction handed to QA2

Preserve an optional selected qid from every question entry point through navigation,
reload, notification links, waiting position and sequential navigation into StepDetail
and stepLayout. Explicit question navigation must resolve that exact question in the
selected project/queue/step. A plain step link may retain its first-open default.
If an explicit target is answered, withdrawn or absent, do not silently bind the user's
existing answer interaction to another question. Keep the existing qid-based component
and draft keys; capture qid/text/choice for an in-flight send.

The existing API accepts additional answers to an already answered question. The stale
page and double-click observations do not authorize changing that general contract;
QA2 should keep this distinction while protecting the intended target.

Add passing regressions with the fix for q2/q3 entry points, reordered/new questions,
reload/Back, stale updates and slow submission. Reuse the source and recorded baseline
failure as evidence. QA3 owns shared desktop option controls; QA4 owns continuation.
No production data, question, approval, live checkout or live server was changed.
