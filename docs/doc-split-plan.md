# Splitting PROTOCOL.md and DESIGN.md by topic: the plan

Queue DS, written in step DS1; DS2 splits `docs/PROTOCOL.md` by it, DS3 splits `docs/DESIGN.md`. Every line number in
this file refers to the queue's base commit `270ae74` (PROTOCOL.md 3,658 lines, 356 KB; DESIGN.md 3,767 lines,
334 KB). After DS2, PROTOCOL.md's numbers no longer hold in the working tree; read them with
`git show 270ae74:docs/PROTOCOL.md`.

## Principles

1. **Only moved.** No sentence is rewritten, removed or summarized. The unit of a move is a heading's section (from
   the heading to the next heading of the same or a higher level), never a paragraph, with one exception: the block
   PROTOCOL.md 2540–2598 ("### Idea conversation scope and direct delivery (IC5)"), which was inserted between
   "## The orchestrator" (2538) and that section's own text (2599 on: "`project.yaml` holds `orchestrator: …`").
   Its own text ends at 2598; it goes to `conversations.md`, and "## The orchestrator" gets its text back directly
   under its heading.
2. **The two old files stay, as the indexes.** `docs/PROTOCOL.md` and `docs/DESIGN.md` keep their title and opening
   paragraphs (PROTOCOL.md 1–8, DESIGN.md 1–10) and get a table of contents: each topic file with one line on what is
   in it and its sections. So every reference to the whole document ("the protocol is in docs/PROTOCOL.md", 48 of
   them, and the agent-contract template's `docs/PROTOCOL.md`) keeps working, and `nexus doc docs/PROTOCOL.md` lists
   where everything went. The alternative, `docs/protocol/README.md` with the old files deleted, would break all 48.
3. **The topic files** go to `docs/protocol/` and `docs/design/`. Each starts with a new H1 title and one line linking
   back to its index (`Part of [the protocol](../PROTOCOL.md).`), then the moved sections in their original order.
   New text is only that: titles, the back link, the indexes' contents, the "See also" lines (below), and the
   references turned into links.
4. **Headings keep their text**, so anchors and every quoted section name ("Checks run by Nexus") keep matching.
   Their level moves up so that each topic file's top sections are `##` (a moved `### Review` becomes `## Review`,
   its `####` children `###`): the same shift for a whole moved block, never within one.
5. **Size**: under about 40 KB per file, so an agent can read one topic whole. One exception: `protocol/api.md`
   (46 KB) is the single section "Server API"; splitting it would mean moving paragraphs.
6. **A part that belongs to two topics** stays in one place; the other file gets a line under its title,
   `See also: [<heading>](<file>.md#<anchor>)`. The cases are listed under "Two topics". None was undecidable.

## PROTOCOL.md → docs/protocol/ (DS2)

| File | Title | Sections (base lines) | Lines | KB |
|---|---|---|---|---|
| `PROTOCOL.md` (index) | Nexus protocol | title, status, opening paragraph (1–8); new: the contents | 8 + contents | <1 |
| `files.md` | The `.nexus` files | Rules (9); Layout (23); `project.yaml` (58); Notes: `notes/<step-id>/<note-id>.md` (627); Server-owned runtime files, its own text (724–816); Removing a project (1312); A project's rules files (1344) | 255 | 34 |
| `settings.md` | Settings | Global settings (94), with Languages (164) | 105 | 9 |
| `queues.md` | Queues | `queue.yaml` (199), with The closing refactoring step (441) | 294 | 25 |
| `git.md` | Worktrees, integration and merging | The integration step (493), with Without a model (532); Git on the dashboard (1086); Merge back and clean up (1161); Cleaning up a survey's worktree (1289); Pushing what was accepted (1366); One queue per checkout, and a limit (3119) | 394 | 36 |
| `review.md` | Review | Review (817); Sending a step back (925); The review helper (945); Review pictures (1107) | 323 | 29 |
| `sessions.md` | Sessions, events and the step turn | Events: `sessions/<id>/events.jsonl` (650); The user's session (1397); Inbox: `sessions/<id>/inbox.jsonl` (1405); `session.yaml` (1426); The step turn (1580); Dashboard question links (1872); The `nexus` command inside agents (2766) | 187 | 20 |
| `cli.md` | The `nexus` CLI | The `nexus` CLI (1449) | 131 | 15 |
| `checks.md` | Checks and the machine's capacity | Checks run by Nexus (1602); The capacity coordinator (1812) | 270 | 22 |
| `api.md` | Server API | Server API (1905) | 354 | 46 |
| `conversations.md` | Conversations | Conversations (2259); Idea conversation scope and direct delivery (IC5) (2540–2598) | 338 | 31 |
| `orchestrator.md` | The orchestrator | The orchestrator (2538–2539 and 2599), with Stopping a chat agent's turn (2745); The orchestrator's context care (3500) | 203 | 20 |
| `planning.md` | Plan, schedules, templates and recurring queues | The plan (2772); Schedules (2875); Queue templates (2900); Recurring queues (2984), with The notes template and reading outside the project (3080); Static analysis reminder (3091) | 347 | 31 |
| `stats.md` | Tags, metrics and statistics | Tags (3176); Project metrics (3242); Statistics (3280) | 149 | 13 |
| `runtimes.md` | Runtimes, fallback and context care | Fallback when usage runs out (3325); Kinds and their defaults (3383); Runtime, model and effort per step (3422); Context care (3448); How the engine runs a Codex session (3534); How the engine runs a Claude Code session (3567), with Windows worker process host (PT) (3593) and Full-test lock and lifetime channel (PT2) (3636) | 300 | 24 |

Every base line 1–3658 is in exactly one row (checked with a script against the base commit).

## DESIGN.md → docs/design/ (DS3)

| File | Title | Sections (base lines) | Lines | KB |
|---|---|---|---|---|
| `DESIGN.md` (index) | Nexus: design | title, status, opening paragraphs (1–10); Open questions (3541); new: the contents | 17 + contents | 1 |
| `overview.md` | Goals, concepts and decisions | Goals (11); Concepts (30), with Queue and step states (45); Architecture, its own text (69–91), with The files are the contract (92) and Nexus drives the queue, step by step (103); Tech stack (1551); Phases (1566); What projects need to change (1579); Decisions, its own text and table (1590–1600); A project's rules: AGENTS.md, pulled into CLAUDE.md (2193); Removing a project (queue PJ) (2215) | 201 | 15 |
| `engine.md` | The engine and the agents | Background work (120); Worker process ownership on Windows (queue PT) (142); The run's state transitions (353); One host for agent processes (384); The texts agents receive (409); Failures (431); Refused actions (507); Messages to a running step (549); The orchestrator (575); Autonomy and insight (799); The orchestrator's briefing and the command line (queue TQ4) (3102); The same commands on every shell tool (queue SH) (3122), with A chained commit and step report (queue BR1) (3140) | 399 | 36 |
| `checks.md` | Checks and static analysis | Nexus runs the checks (queue EC) (193), with The capacity coordinator, first slice (329); Static analysis (queue SA) (2941) | 235 | 20 |
| `questions.md` | Questions | Questions: worker ↔ orchestrator ↔ user (559); Question navigation identity (QA1 finding) (3665); Preserving the selected question (QA2) (3676); Clickable question answers on every layout (QA3) (3708); Completing the question barrier (QA4) (3736) | 118 | 9 |
| `review.md` | Review | Routine reviews by a helper (queue RH) (588); Review material (1340); Findings from review levels (queue RL1) (2832); Level 3: provisional acceptances (queue RL2) (2861); Away mode (queue RL3) (2875) | 196 | 17 |
| `planning.md` | The plan and approvals | The plan (1225); Approvals (1358); A closing refactoring step kept by Nexus (2235) | 144 | 13 |
| `usage.md` | Context and usage | Context management (708); Usage limits (1031); Estimating a turn's use (1083); Sub-agent tokens (1117); Measuring token use (1138); Compacting a conversation (queue CC3) (3197) | 319 | 29 |
| `git.md` | Worktrees and merging | Worktrees (811); Merging back (821); The integration step without a model (queue MI) (894); Never two queues in one checkout (1306); Resuming worktree cleanup (queue CW1) (3290), with Worktree handle investigation (queue WH1) (3339) and A Codex cleanup refusal while termination is completing (queue WH2) (3373) | 400 | 37 |
| `runtimes.md` | Runtimes and findings from building | Runtimes and authentication (1397); Findings from building phase 3 (2259); The web for thinking partners (queue WB) (2890); The user's Codex tools for workers (queue FX) (2918) | 269 | 26 |
| `updates.md` | Updating Nexus | Updating Nexus (1413) | 138 | 12 |
| `dashboard.md` | The dashboard | Back closes the topmost layer (1601); Details beside the chat on a wide screen (replaced) (1617); The file viewer (1921); Colours are theme tokens (1960); The interface texts in one place (1996); One action bar (2040); The phone (2062); A queue's steps as a list, with one honest status (2115); Approving: the whole queue in one scroll (2138); Continue at the stop (2160); Reviewing: the pictures first, the decision in the viewer (2176); Layout faults (queue PL) (3231), with The plan view's layout A (queue PB) (3255) | 356 | 31 |
| `chat.md` | The chat | Chat-first on a desktop (1626); The right rail (1662); Refs in the chat (1688); The morning digest (1731); Drafts stay in the browser (1767); Each chat keeps its place (1777); Quoting in a chat (1799); Long replies and message actions (1819); Search in a chat, and pinned messages (1841); Stopping a chat agent's turn (1863); Pictures in a chat message (1881); Speaking into a chat (1901) | 295 | 25 |
| `tests.md` | Tests | The tests' waits (queue TS1) (2461); Tests while working, and the slowest files (queue TS2) (2521); One full test run on the machine (queue FX) (2568), with its TF (2590) and PT2 (2632) sections; The engine's own waits in tests (queue FX) (2666); Findings from the flaky tests (queue FU4) (2689); Findings from the tests that failed or hung in full runs (queue FL) (2716) | 270 | 24 |
| `state.md` | State, order and reads | Clock steps (queue FL, plan FL4) (2731); The dashboard's reads (queue RX1) (3016); One place for the status rules (queue RX3) (3074); The cost of rebuilding state (queue RX5) (3086) | 187 | 19 |
| `dependencies.md` | Dependency updates | Hono Node adapter 2.x and the public SPA fallback (queue DU1) (3436); The lint toolchain's minimatch update (queue DU2) (3479) | 69 | 6 |
| `ideas.md` | Ideas | Ideas relationships: persisted corrections (IC2) (3505); Ideas corrections: design boundary (IC1) (3532); Ideas dispositions and assessment validity (IC3) (3548); Ideas correction controls (IC4) (3588), with Idea conversations and direct handoffs (IC5) (3620) | 153 | 13 |

Every base line 1–3767 is in exactly one row. Notes on the choices:

- The "### …" sections under "## Decisions" (1601–2258) go to the topic they decide (dashboard, chat, review,
  planning, overview); "## Decisions" itself keeps its opening table, in `overview.md`.
- The QA sections (3665–3767) sit under "## Ideas correction controls (IC4)" only by their heading level; they are
  about questions, not ideas, and go to `questions.md` with "Questions: worker ↔ orchestrator ↔ user".
- "## Open questions" (3541) stands between IC1 and IC3 but is about the whole design (the local HTTP gap); it stays
  in the index.
- "Findings from building phase 3" is one section of bullets on several subjects (runtimes, remote access, updates,
  Windows); it moves whole to `runtimes.md`, where most of its bullets belong.

## Two topics: where it stays, and the "See also" line

| Section | Stays in | See also from |
|---|---|---|
| PROTOCOL "Full-test lock and lifetime channel (PT2)" (under the Claude Code session) | `protocol/runtimes.md` | `protocol/checks.md` |
| PROTOCOL "Stopping a chat agent's turn" (under the orchestrator, also about conversations) | `protocol/orchestrator.md` | `protocol/conversations.md` |
| PROTOCOL "Dashboard question links" | `protocol/sessions.md` | `protocol/api.md` |
| PROTOCOL "Removing a project" (under the runtime files) | `protocol/files.md` | `protocol/api.md` |
| PROTOCOL "Server API": its bold paragraphs "Nexus itself", "Planned deploys", "Push on deploy", "The hand-over after an update", "The chats during an update" | `protocol/api.md` | `protocol/git.md` (push) |
| DESIGN "Reviewing: the pictures first, the decision in the viewer" | `design/dashboard.md` | `design/review.md` |
| DESIGN "Approving: the whole queue in one scroll" | `design/dashboard.md` | `design/planning.md` |
| DESIGN "The plan view's layout A (queue PB)" (under Layout faults) | `design/dashboard.md` | `design/planning.md` |
| DESIGN "Findings from building phase 3" | `design/runtimes.md` | `design/updates.md` |
| DESIGN "One full test run on the machine (queue FX)" | `design/tests.md` | `design/checks.md` |
| DESIGN "Stopping a chat agent's turn" | `design/chat.md` | `design/engine.md` |
| DESIGN "Completing the question barrier (QA4)" (engine behaviour) | `design/questions.md` | `design/engine.md` |

## References to change

Found with a script over every tracked file, plus the notes folder (`C:\Code\Nexus\docs\ideas`, outside the
repository): 285 places name PROTOCOL.md or DESIGN.md (243 outside the two documents and the notes, 25 in the notes, 17
test fixtures). Inside the two documents: 158 quoted section names whose section lands in another topic file, and
62 + 52 "above"/"below".

### The form

- **A quoted section** (`PROTOCOL.md, "Checks run by Nexus"`, the form of almost every code comment) keeps its quote
  and gets the new path: `docs/protocol/checks.md, "Checks run by Nexus"`. A bold paragraph inside a section is
  quoted the same way (`docs/protocol/api.md, "Planned deploys"`).
- **A line number** (`docs/PROTOCOL.md:2864`) becomes `file#anchor`: `docs/protocol/runtimes.md#context-care`. The
  anchor is GitHub's: lower case, punctuation dropped, spaces as hyphens.
- **The whole document** stays as it is (the index) unless listed under "Depends on the paths".
- **Inside the documents**: a quoted section name whose section is now in another file becomes a link with the same
  words, `see [Conversations](conversations.md#conversations)`; in the same file it stays a quote. An "above" or
  "below" whose target moved to another file becomes such a link too (the words around it stay). DESIGN's informal
  `protocol: "Context care"` (733, 749) becomes `[protocol: "Context care"](../protocol/runtimes.md#context-care)`.
  References from PROTOCOL to DESIGN sections stay as they are in DS2 and get their new path in DS3, so that DS2
  does not touch DESIGN.md and its line numbers here stay valid.
- **Stale names** found on the way (the section was renamed): `schemas.ts:15` "Review levels" → "Review"
  (`protocol/review.md`); `packages/cli/src/main.ts:884` "nexus doc" → "The `nexus` CLI" (`protocol/cli.md`).

### Depends on the paths (change in the same commit as the move)

- `packages/cli/test/protocol-cli.test.ts:14, 157, 212`: reads `docs/PROTOCOL.md` and its section "The `nexus` CLI";
  in DS2 it reads `docs/protocol/cli.md`. Without that, DS2's checks fail.
- `nexus-templates/nexus-agent-contract.yaml:6, 25` (default `docs/PROTOCOL.md`, "fix_small fixes only clear slips in
  PROTOCOL.md"), `nexus-templates/nexus-docs-freshness.yaml:14`, `nexus-templates/nexus-notes.yaml:27`,
  `templates/agent-contract.yaml:16`, `scripts/capture/seed-recurring.ts:84`: the defaults name the documents to
  check; with the index they still resolve, but a run must read the topic files. Recommended: `docs/PROTOCOL.md and
  docs/protocol/` (DS2), `docs/DESIGN.md and docs/design/` (DS3). `packages/protocol/test/templates.test.ts:126, 229`
  asserts the contract's text and changes with it.
- `AGENTS.md:4, 44, 47, 63–64` (the pointers and the "Documentation" rule: "updates PROTOCOL.md" becomes "updates
  the matching file in docs/protocol/"), `README.md:7–8, 485, 672, 693, 753, 780`.
- `packages/cli/src/main.ts:887` (the usage line `nexus doc docs/DESIGN.md`) and PROTOCOL.md 1491 (the CLI block's
  example `nexus doc docs/DESIGN.md#Static analysis`, then in `protocol/cli.md`): DS3 points them at a design topic
  file.
- Each commit that moves a document carries an `Agents:` line (AGENTS.md): agents read these files, and
  `nexus doc docs/PROTOCOL.md#<section>` now finds the section only in its topic file.

### The notes folder (outside the repository): a decision for the user

`docs/ideas` is the project's notes folder in the main checkout (`C:\Code\Nexus\docs\ideas`), untracked: no step of
this queue can commit a change there. 25 references in 8 notes: 14 to the whole documents (still valid through the
indexes), two quoted sections (`server-responsiveness.md:26` "The cost of rebuilding state" → `design/state.md`;
`stopped-queue-new-revision.md:50` "Pushing what was accepted" → `design/updates.md`), one renamed one
(`queue-plan-view.md:11` "Chains", today "The plan" → `protocol/planning.md`), and 8 line numbers in
`token-costs.md`, already wrong before the split (the files grew), found by their words:

| Place | Says | Target |
|---|---|---|
| `token-costs.md:44` | `docs/PROTOCOL.md:100`, the context reuse threshold's default | `docs/protocol/settings.md#global-settings` |
| `token-costs.md:45` | `docs/DESIGN.md:475-476`, the orchestrator's threshold | `docs/design/usage.md#context-management` |
| `token-costs.md:46` | `docs/PROTOCOL.md:2864`, "You take over queue …" | `docs/protocol/runtimes.md#context-care` |
| `token-costs.md:49` | `docs/PROTOCOL.md:153`, `kinds.<kind>` | `docs/protocol/runtimes.md#kinds-and-their-defaults` |
| `token-costs.md:52` | `docs/PROTOCOL.md:493`, the checks in the integration step | `docs/protocol/git.md#the-integration-step` |
| `token-costs.md:94` | `docs/PROTOCOL.md:2852-2854`, asking for a summary rewrites the cache | `docs/protocol/runtimes.md#context-care` |
| `token-costs.md:117` | `docs/DESIGN.md:451-453`, compacted by the runtime mid-step | `docs/design/usage.md#context-management` |
| `token-costs.md:118` | `docs/DESIGN.md:459`, no known window | `docs/design/usage.md#context-management` |

The trap: lines 94, 117 and 118 are in the note's "Decided" part, under a date, and any change to a dated entry's
content invalidates its implementation assessments for good (PROTOCOL.md, "Conversations", IC3). Recommended: the
queue does not touch the notes; whoever owns them (the user, or a thinking partner) may change the lines outside dated
entries (44–52) by this table. The user decides at DS1's review.

## Traps

- **Other queues editing the two documents.** Almost every queue adds to PROTOCOL.md or DESIGN.md. When DS's
  integration step merges main, every such addition conflicts with the moved text: take main's new or changed
  lines and put them into the topic file that holds their section (by the tables above), then check that the old
  file is the index again.
- **Checking that nothing was rewritten.** `git diff --color-moved=plain 270ae74 -- docs/` shows moved lines in
  their own colour; every line it shows as added or removed must be one of the allowed new texts (titles, back links,
  contents, "See also" lines, heading levels, references turned into links). A short script that compares the
  base's line ranges with the topic files, ignoring the leading `#`s, does the same without a terminal.
- **Heading levels** change only by the whole block's shift; `nexus doc file.md#section` reads from a heading to the
  next heading of the same or a higher level, so a section must keep its children.
- **Test fixtures** use these file names as plain sample paths (`apps/web/test/fileview.test.ts`, `hash.test.ts`,
  `refs.test.ts`, `scripts/test/token-report.test.ts`): they stay.
- **Code blocks** inside the documents contain quoted words that look like section names (31 such places); they are
  examples, not references, and stay.

## Appendix: every reference

Generated from the base commit; "→" is the file and section it moves to. The DS steps check each place by its words,
since a few matches are loose (a quoted word that only resembles a heading).

### Outside the two documents

#### References to PROTOCOL.md (170)

- `AGENTS.md`
  - 4: the whole document
  - 47: "Checks run by Nexus" → docs/protocol/checks.md#checks-run-by-nexus
  - 63: the whole document
- `README.md`
  - 8: the whole document
  - 485: "Queue templates" → docs/protocol/planning.md#queue-templates
  - 672: "The capacity coordinator" → docs/protocol/checks.md#the-capacity-coordinator
- `apps/server/src/capacity.ts`
  - 1: "The capacity coordinator" → docs/protocol/checks.md#the-capacity-coordinator
- `apps/server/src/check-runs.ts`
  - 1: "Checks run by Nexus" → docs/protocol/checks.md#checks-run-by-nexus
- `apps/server/src/closing.ts`
  - 1: "The closing refactoring step" → docs/protocol/queues.md#the-closing-refactoring-step
- `apps/server/src/codex.ts`
  - 615: "Uploads" → docs/protocol/api.md#server-api (**Uploads**)
- `apps/server/src/conversations.ts`
  - 5: "Conversations" → docs/protocol/conversations.md#conversations
- `apps/server/src/engine.ts`
  - 1244: "Without a model" → docs/protocol/git.md#without-a-model
- `apps/server/src/files.ts`
  - 1: "Files and commits" → docs/protocol/api.md#server-api (**Files and commits**)
- `apps/server/src/integration.ts`
  - 1: "The integration step" → docs/protocol/git.md#the-integration-step
  - 6: "Without a model" → docs/protocol/git.md#without-a-model
- `apps/server/src/main.ts`
  - 102: the whole document
  - 111: "Before review levels" → docs/protocol/review.md#review (**Before review levels**)
  - 407: "Queue templates" → docs/protocol/planning.md#queue-templates
  - 533: "The plan" → docs/protocol/planning.md#the-plan
  - 563: "Tags" → docs/protocol/stats.md#tags
  - 572: "Recurring queues" → docs/protocol/planning.md#recurring-queues
  - 813: "Away mode" → docs/protocol/review.md#review (**Away mode**)
  - 999: "Global settings" → docs/protocol/settings.md#global-settings
- `apps/server/src/mergeback.ts`
  - 3: "The integration step" → docs/protocol/git.md#the-integration-step
- `apps/server/src/merger.ts`
  - 1: "Merging back by itself" → docs/protocol/files.md#server-owned-runtime-files (**Merging back by itself and resolving conflicts**)
  - 20: "The merge train" → docs/protocol/git.md#merge-back-and-clean-up (**The merge train**)
- `apps/server/src/orchestrator.ts`
  - 995: "Fallback when usage runs out" → docs/protocol/runtimes.md#fallback-when-usage-runs-out
- `apps/server/src/prompts.ts`
  - 20: "Languages" → docs/protocol/settings.md#languages
  - 124: "Checks run by Nexus" → docs/protocol/checks.md#checks-run-by-nexus
  - 136: "Checks run by Nexus" → docs/protocol/checks.md#checks-run-by-nexus
  - 738: "The review helper" → docs/protocol/review.md#the-review-helper
  - 763: "The review helper" → docs/protocol/review.md#the-review-helper
- `apps/server/src/recurring.ts`
  - 1: "Recurring queues" → docs/protocol/planning.md#recurring-queues
- `apps/server/src/removal.ts`
  - 1: "Removing a project" → docs/protocol/files.md#removing-a-project
- `apps/server/src/review-helper.ts`
  - 1: "The review helper" → docs/protocol/review.md#the-review-helper
- `apps/server/src/search.ts`
  - 1: "Searching a project" → docs/protocol/api.md#server-api (**Searching a project**)
- `apps/server/src/static-reminder.ts`
  - 1: "Static analysis reminder" → docs/protocol/planning.md#static-analysis-reminder
- `apps/server/src/uploads.ts`
  - 1: "Uploads" → docs/protocol/api.md#server-api (**Uploads**)
- `apps/server/src/worker-process.ts`
  - 2: the whole document
- `apps/server/test/away.test.ts`
  - 1: "Away mode" → docs/protocol/review.md#review (**Away mode**)
- `apps/server/test/closing.test.ts`
  - 1: "The closing refactoring step" → docs/protocol/queues.md#the-closing-refactoring-step
- `apps/server/test/fake-reviewer.ts`
  - 1: "Review" → docs/protocol/review.md#review
- `apps/server/test/fallback-mid.test.ts`
  - 1: "Fallback when usage runs out" → docs/protocol/runtimes.md#fallback-when-usage-runs-out
- `apps/server/test/fallback.test.ts`
  - 1: "Fallback when usage runs out" → docs/protocol/runtimes.md#fallback-when-usage-runs-out
- `apps/server/test/golden/prompts-worker.txt`
  - 317: "Checks run by Nexus" → docs/protocol/checks.md#checks-run-by-nexus
- `apps/server/test/ideas-api.test.ts`
  - 1: "Conversations" → docs/protocol/conversations.md#conversations
- `apps/server/test/integration-free.test.ts`
  - 1: "The integration step" → docs/protocol/git.md#the-integration-step; "Without a model" → docs/protocol/git.md#without-a-model
- `apps/server/test/integration.test.ts`
  - 1: "The integration step" → docs/protocol/git.md#the-integration-step
- `apps/server/test/metrics.test.ts`
  - 1: "Project metrics" → docs/protocol/stats.md#project-metrics
- `apps/server/test/pictures.test.ts`
  - 2: "Uploads" → docs/protocol/api.md#server-api (**Uploads**)
- `apps/server/test/plan.test.ts`
  - 1: "The plan" → docs/protocol/planning.md#the-plan
- `apps/server/test/prompts.test.ts`
  - 216: the whole document
- `apps/server/test/provisional.test.ts`
  - 1: "Review" → docs/protocol/review.md#review
- `apps/server/test/recurring-maintenance.test.ts`
  - 1: "Recurring queues" → docs/protocol/planning.md#recurring-queues
- `apps/server/test/recurring.test.ts`
  - 1: "Recurring queues" → docs/protocol/planning.md#recurring-queues
- `apps/server/test/static-reminder.test.ts`
  - 1: "Static analysis reminder" → docs/protocol/planning.md#static-analysis-reminder
- `apps/server/test/stats-api.test.ts`
  - 1: "Statistics" → docs/protocol/stats.md#statistics
- `apps/server/test/survey-worktree.test.ts`
  - 1: "Cleaning up a survey's worktree" → docs/protocol/git.md#cleaning-up-a-surveys-worktree
- `apps/server/test/tags.test.ts`
  - 1: "Tags" → docs/protocol/stats.md#tags
- `apps/web/src/checks.ts`
  - 1: "Checks run by Nexus" → docs/protocol/checks.md#checks-run-by-nexus
- `apps/web/src/components/Chat.tsx`
  - 63: "Layout" → docs/protocol/files.md#layout
- `apps/web/src/components/Closing.tsx`
  - 1: "The closing refactoring step" → docs/protocol/queues.md#the-closing-refactoring-step
- `apps/web/src/components/Commit.tsx`
  - 2: "Files and commits" → docs/protocol/api.md#server-api (**Files and commits**)
- `apps/web/src/components/DangerZone.tsx`
  - 2: "Removing a project" → docs/protocol/files.md#removing-a-project
- `apps/web/src/components/DeployPlan.tsx`
  - 1: "Planned deploys" → docs/protocol/api.md#server-api (**Planned deploys**)
- `apps/web/src/components/Fallback.tsx`
  - 1: "Fallback when usage runs out" → docs/protocol/runtimes.md#fallback-when-usage-runs-out
- `apps/web/src/components/FileView.tsx`
  - 8: "Files and commits" → docs/protocol/api.md#server-api (**Files and commits**)
- `apps/web/src/components/Levels.tsx`
  - 1: "Review" → docs/protocol/review.md#review
- `apps/web/src/components/Plan.tsx`
  - 1: "The plan" → docs/protocol/planning.md#the-plan
  - 38: "The plan" → docs/protocol/planning.md#the-plan
- `apps/web/src/components/Recurring.tsx`
  - 1: "Queue templates" → docs/protocol/planning.md#queue-templates; "Recurring queues" → docs/protocol/planning.md#recurring-queues
- `apps/web/src/components/Settings.tsx`
  - 2: "Global settings" → docs/protocol/settings.md#global-settings
  - 103: the whole document
  - 702: "Away mode" → docs/protocol/review.md#review (**Away mode**)
  - 704: "Planned deploys" → docs/protocol/api.md#server-api (**Planned deploys**)
- `apps/web/src/components/Tags.tsx`
  - 1: "Tags" → docs/protocol/stats.md#tags
- `apps/web/src/components/details/git.tsx`
  - 62: "The integration step" → docs/protocol/git.md#the-integration-step; "Merge back and clean up" → docs/protocol/git.md#merge-back-and-clean-up
- `apps/web/src/components/details/stepParts.tsx`
  - 53: "Checks run by Nexus" → docs/protocol/checks.md#checks-run-by-nexus
- `apps/web/src/pictures.ts`
  - 1: "Uploads" → docs/protocol/api.md#server-api (**Uploads**)
- `apps/web/src/plan.ts`
  - 1: "The plan" → docs/protocol/planning.md#the-plan
- `docs/ux/mockups/15-approval.html`
  - 40: the whole document
- `nexus-templates/nexus-agent-contract.yaml`
  - 6: the whole document
  - 6: the whole document
  - 25: the whole document
- `nexus-templates/nexus-docs-freshness.yaml`
  - 14: the whole document
- `nexus-templates/nexus-notes.yaml`
  - 27: the whole document
- `packages/cli/src/main.ts`
  - 362: "The review helper" → docs/protocol/review.md#the-review-helper
  - 384: "The review helper" → docs/protocol/review.md#the-review-helper
  - 769: "Checks run by Nexus" → docs/protocol/checks.md#checks-run-by-nexus
  - 884: "nexus doc" → (no such section today)
- `packages/cli/test/metric.test.ts`
  - 1: "Project metrics" → docs/protocol/stats.md#project-metrics
- `packages/cli/test/protocol-cli.test.ts`
  - 1: "The `nexus` CLI" → docs/protocol/cli.md#the-nexus-cli
  - 14: the whole document
  - 157: the whole document
  - 212: the whole document
- `packages/cli/test/recurring.test.ts`
  - 1: "Recurring queues" → docs/protocol/planning.md#recurring-queues
- `packages/cli/test/static-analysis.test.ts`
  - 1: "Static analysis reminder" → docs/protocol/planning.md#static-analysis-reminder
- `packages/cli/test/template.test.ts`
  - 1: "Queue templates" → docs/protocol/planning.md#queue-templates
- `packages/protocol/src/actions.ts`
  - 2: "Rules" → docs/protocol/files.md#rules
- `packages/protocol/src/api.ts`
  - 3: the whole document
  - 61: "Removing a project" → docs/protocol/files.md#removing-a-project
- `packages/protocol/src/away.ts`
  - 1: "Away mode" → docs/protocol/review.md#review (**Away mode**)
- `packages/protocol/src/capacity.ts`
  - 1: "The capacity coordinator" → docs/protocol/checks.md#the-capacity-coordinator
- `packages/protocol/src/checks.ts`
  - 1: "Checks run by Nexus" → docs/protocol/checks.md#checks-run-by-nexus
- `packages/protocol/src/closing.ts`
  - 2: "The closing refactoring step" → docs/protocol/queues.md#the-closing-refactoring-step
  - 46: "The integration step" → docs/protocol/git.md#the-integration-step
  - 51: "Cleaning up a survey's worktree" → docs/protocol/git.md#cleaning-up-a-surveys-worktree
- `packages/protocol/src/commands.ts`
  - 6: "Checks run by Nexus" → docs/protocol/checks.md#checks-run-by-nexus
- `packages/protocol/src/full-test-lock.ts`
  - 1: "Full-test lock and lifetime channel" → docs/protocol/runtimes.md#full-test-lock-and-lifetime-channel-pt2
- `packages/protocol/src/languages.ts`
  - 1: "Languages" → docs/protocol/settings.md#languages
- `packages/protocol/src/metric-define.ts`
  - 1: "Project metrics" → docs/protocol/stats.md#project-metrics
- `packages/protocol/src/metrics.ts`
  - 1: "Project metrics" → docs/protocol/stats.md#project-metrics
- `packages/protocol/src/notify.ts`
  - 1: "Push" → docs/protocol/git.md#pushing-what-was-accepted
- `packages/protocol/src/plan.ts`
  - 1: "The plan" → docs/protocol/planning.md#the-plan
- `packages/protocol/src/recurring.ts`
  - 1: "Recurring queues" → docs/protocol/planning.md#recurring-queues
- `packages/protocol/src/review-stats.ts`
  - 1: "The review helper" → docs/protocol/review.md#the-review-helper
- `packages/protocol/src/routing.ts`
  - 1: "Kinds and their defaults" → docs/protocol/runtimes.md#kinds-and-their-defaults
  - 150: "Fallback when usage runs out" → docs/protocol/runtimes.md#fallback-when-usage-runs-out
- `packages/protocol/src/schemas.ts`
  - 1: the whole document
  - 15: "Review levels" → (no such section today)
  - 68: "The review helper" → docs/protocol/review.md#the-review-helper
  - 72: "The review helper" → docs/protocol/review.md#the-review-helper
  - 112: "Global settings" → docs/protocol/settings.md#global-settings
  - 188: "Checks run by Nexus" → docs/protocol/checks.md#checks-run-by-nexus
  - 211: "Conversations" → docs/protocol/conversations.md#conversations
  - 244: "Kinds and their defaults" → docs/protocol/runtimes.md#kinds-and-their-defaults
  - 287: "The review helper" → docs/protocol/review.md#the-review-helper
  - 386: "Before review levels" → docs/protocol/review.md#review (**Before review levels**)
  - 430: "Before review levels" → docs/protocol/review.md#review (**Before review levels**)
  - 507: "Tags" → docs/protocol/stats.md#tags
  - 601: "Recurring queues" → docs/protocol/planning.md#recurring-queues
  - 649: "Recurring queues" → docs/protocol/planning.md#recurring-queues
  - 933: "The review helper" → docs/protocol/review.md#the-review-helper
  - 964: "An unrelated failure" → docs/protocol/checks.md#checks-run-by-nexus (**An unrelated failure**)
  - 1191: "The plan" → docs/protocol/planning.md#the-plan
  - 1236: "One queue per checkout, and a limit" → docs/protocol/git.md#one-queue-per-checkout-and-a-limit
  - 1281: "Fallback when usage runs out" → docs/protocol/runtimes.md#fallback-when-usage-runs-out
  - 1389: "Away mode" → docs/protocol/review.md#review (**Away mode**)
  - 1488: "Checks run by Nexus" → docs/protocol/checks.md#checks-run-by-nexus
  - 1512: "The capacity coordinator" → docs/protocol/checks.md#the-capacity-coordinator
  - 1601: "Tags" → docs/protocol/stats.md#tags
  - 1706: "Recurring queues" → docs/protocol/planning.md#recurring-queues
  - 1792: "Checks run by Nexus" → docs/protocol/checks.md#checks-run-by-nexus
- `packages/protocol/src/search.ts`
  - 1: "Searching a project" → docs/protocol/api.md#server-api (**Searching a project**)
- `packages/protocol/src/settings.ts`
  - 1: "Global settings" → docs/protocol/settings.md#global-settings
  - 46: the whole document
- `packages/protocol/src/state.ts`
  - 160: "Checks run by Nexus" → docs/protocol/checks.md#checks-run-by-nexus
  - 1064: "The review helper" → docs/protocol/review.md#the-review-helper
- `packages/protocol/src/static-analysis.ts`
  - 1: "Static analysis reminder" → docs/protocol/planning.md#static-analysis-reminder
- `packages/protocol/src/stats.ts`
  - 1: "Statistics" → docs/protocol/stats.md#statistics
- `packages/protocol/src/store.ts`
  - 2: the whole document
- `packages/protocol/src/tag-proposals.ts`
  - 2: "Tags" → docs/protocol/stats.md#tags
- `packages/protocol/src/tags.ts`
  - 1: "Tags" → docs/protocol/stats.md#tags
- `packages/protocol/src/templates.ts`
  - 1: "Queue templates" → docs/protocol/planning.md#queue-templates
- `packages/protocol/src/train.ts`
  - 1: "The merge train" → docs/protocol/git.md#merge-back-and-clean-up (**The merge train**)
- `packages/protocol/test/closing.test.ts`
  - 1: "The closing refactoring step" → docs/protocol/queues.md#the-closing-refactoring-step
- `packages/protocol/test/integration.test.ts`
  - 1: "The integration step" → docs/protocol/git.md#the-integration-step
- `packages/protocol/test/languages.test.ts`
  - 1: "Languages" → docs/protocol/settings.md#languages
- `packages/protocol/test/levels.test.ts`
  - 1: "Review" → docs/protocol/review.md#review
- `packages/protocol/test/routing.test.ts`
  - 1: "Kinds and their defaults" → docs/protocol/runtimes.md#kinds-and-their-defaults
- `packages/protocol/test/tags.test.ts`
  - 1: "Tags" → docs/protocol/stats.md#tags
- `scripts/capture/seed-merge-train.ts`
  - 2: "The merge train" → docs/protocol/git.md#merge-back-and-clean-up (**The merge train**)
- `scripts/capture/seed-plan-nexus.ts`
  - 1: "The plan" → docs/protocol/planning.md#the-plan
- `scripts/capture/seed-plan.ts`
  - 1: "The plan" → docs/protocol/planning.md#the-plan
- `scripts/capture/seed-recurring.ts`
  - 1: "Queue templates" → docs/protocol/planning.md#queue-templates; "Recurring queues" → docs/protocol/planning.md#recurring-queues
  - 84: the whole document
- `scripts/capture/seed-removal.ts`
  - 1: "Removing a project" → docs/protocol/files.md#removing-a-project
- `scripts/capture/seed-tags.ts`
  - 1: "Tags" → docs/protocol/stats.md#tags
- `scripts/check-plan-reorder.ts`
  - 3: "The plan" → docs/protocol/planning.md#the-plan
- `templates/agent-contract.yaml`
  - 16: the whole document

#### References to DESIGN.md (73)

- `.dependency-cruiser.cjs`
  - 2: "Static analysis" → docs/design/checks.md#static-analysis-queue-sa
- `AGENTS.md`
  - 4: the whole document
  - 44: "Static analysis" → docs/design/checks.md#static-analysis-queue-sa
  - 64: the whole document
- `README.md`
  - 7: the whole document
  - 693: "Static analysis" → docs/design/checks.md#static-analysis-queue-sa
  - 753: "Layout faults" → docs/design/dashboard.md#layout-faults-queue-pl
  - 780: "Measuring token use" → docs/design/usage.md#measuring-token-use
- `apps/server/src/agent-host.ts`
  - 142: "When Claude Code saves a conversation" → docs/design/engine.md#failures (**When Claude Code saves a conversation**)
  - 153: "Clock steps" → docs/design/state.md#clock-steps-ordering-by-what-was-seen-not-by-the-wall-clock-queue-fl-plan-fl4
- `apps/server/src/agent.ts`
  - 24: "When Claude Code saves a conversation" → docs/design/engine.md#failures (**When Claude Code saves a conversation**)
  - 37: "Failures" → docs/design/engine.md#failures
  - 88: "Sub-agent tokens" → docs/design/usage.md#sub-agent-tokens
  - 109: "Background work" → docs/design/engine.md#background-work
- `apps/server/src/capacity.ts`
  - 1: "The capacity coordinator, first slice" → docs/design/checks.md#the-capacity-coordinator-first-slice
- `apps/server/src/check-runs.ts`
  - 1: "Nexus runs the checks" → docs/design/checks.md#nexus-runs-the-checks-queue-ec
- `apps/server/src/claude.ts`
  - 116: "The orchestrator's briefing and the command line" → docs/design/engine.md#the-orchestrators-briefing-and-the-command-line-queue-tq4
  - 505: "Sub-agent tokens" → docs/design/usage.md#sub-agent-tokens
- `apps/server/src/codex.ts`
  - 41: "An orchestrator on Codex can be kept to its drafts" → docs/design/runtimes.md#findings-from-building-phase-3 (**An orchestrator on Codex can be kept to its drafts and its own event log, by a permission profile**)
  - 321: "When Claude Code saves a conversation" → docs/design/engine.md#failures (**When Claude Code saves a conversation**)
- `apps/server/src/coordinator.ts`
  - 1: "Never two queues in one checkout" → docs/design/git.md#never-two-queues-in-one-checkout
- `apps/server/src/engine.ts`
  - 2: "Nexus drives the queue, step by step" → docs/design/overview.md#nexus-drives-the-queue-step-by-step
  - 79: "Background work" → docs/design/engine.md#background-work
  - 969: "Background work" → docs/design/engine.md#background-work
  - 1007: "Context care between steps" → docs/design/usage.md#context-management (**Context care between steps**)
  - 1790: "Clock steps" → docs/design/state.md#clock-steps-ordering-by-what-was-seen-not-by-the-wall-clock-queue-fl-plan-fl4
- `apps/server/src/files.ts`
  - 17: the whole document
- `apps/server/src/gitinfo.ts`
  - 10: "Clock steps" → docs/design/state.md#clock-steps-ordering-by-what-was-seen-not-by-the-wall-clock-queue-fl-plan-fl4
- `apps/server/src/main.ts`
  - 150: "The cost of rebuilding state" → docs/design/state.md#the-cost-of-rebuilding-state-queue-rx5
- `apps/server/src/prompts.ts`
  - 53: "A chained commit and step report" → docs/design/engine.md#a-chained-commit-and-step-report-queue-br1
  - 241: "Background work" → docs/design/engine.md#background-work
- `apps/server/src/review-helper.ts`
  - 1: "Routine reviews by a helper" → docs/design/review.md#routine-reviews-by-a-helper-queue-rh
- `apps/server/src/run-state.ts`
  - 1: "The run's state transitions" → docs/design/engine.md#the-runs-state-transitions
- `apps/server/src/shell-rules.ts`
  - 5: "The same commands on every shell tool" → docs/design/engine.md#the-same-commands-on-every-shell-tool-queue-sh
- `apps/server/test/background.test.ts`
  - 2: "Background work" → docs/design/engine.md#background-work
- `apps/server/test/clock-steps.test.ts`
  - 1: "Clock steps" → docs/design/state.md#clock-steps-ordering-by-what-was-seen-not-by-the-wall-clock-queue-fl-plan-fl4
- `apps/server/test/command-line.test.ts`
  - 2: "The orchestrator's briefing and the command line" → docs/design/engine.md#the-orchestrators-briefing-and-the-command-line-queue-tq4
- `apps/server/test/failures.test.ts`
  - 2: "Failures" → docs/design/engine.md#failures
- `apps/server/test/fake-behaviour.ts`
  - 230: "When Claude Code saves a conversation" → docs/design/engine.md#failures (**When Claude Code saves a conversation**)
- `apps/server/test/golden/prompts-worker.txt`
  - 193: "Background work" → docs/design/engine.md#background-work
- `apps/server/test/prompts.test.ts`
  - 190: the whole document
- `apps/server/test/turn-usage.test.ts`
  - 3: the whole document
- `apps/server/test/wait.ts`
  - 1: "The tests' waits" → docs/design/tests.md#the-tests-waits-queue-ts1
- `apps/web/src/components/ui.tsx`
  - 17: the whole document
- `apps/web/src/i18n.ts`
  - 1: "The interface texts in one place" → docs/design/dashboard.md#the-interface-texts-in-one-place
- `apps/web/src/index.css`
  - 7: the whole document
- `apps/web/src/layers.ts`
  - 20: "The phone" → docs/design/dashboard.md#the-phone
- `apps/web/src/messages/en.ts`
  - 1: "The interface texts in one place" → docs/design/dashboard.md#the-interface-texts-in-one-place
- `apps/web/src/phone.ts`
  - 2: "The phone" → docs/design/dashboard.md#the-phone
- `docs/BACKLOG.md`
  - 15: "An orchestrator on Codex can be kept to its drafts" → docs/design/runtimes.md#findings-from-building-phase-3 (**An orchestrator on Codex can be kept to its drafts and its own event log, by a permission profile**)
- `docs/ux/plan-view-options.md`
  - 12: "Layout faults" → docs/design/dashboard.md#layout-faults-queue-pl
- `eslint.config.js`
  - 1: "Static analysis" → docs/design/checks.md#static-analysis-queue-sa
- `nexus-templates/nexus-docs-freshness.yaml`
  - 14: the whole document
- `nexus-templates/nexus-notes.yaml`
  - 27: the whole document
- `packages/cli/src/main.ts`
  - 209: "Clock steps" → docs/design/state.md#clock-steps-ordering-by-what-was-seen-not-by-the-wall-clock-queue-fl-plan-fl4
  - 887: the whole document
- `packages/protocol/src/clock.ts`
  - 1: "Clock steps" → docs/design/state.md#clock-steps-ordering-by-what-was-seen-not-by-the-wall-clock-queue-fl-plan-fl4
  - 35: "Clock steps" → docs/design/state.md#clock-steps-ordering-by-what-was-seen-not-by-the-wall-clock-queue-fl-plan-fl4
- `packages/protocol/src/review-stats.ts`
  - 9: "Routine reviews by a helper" → docs/design/review.md#routine-reviews-by-a-helper-queue-rh
- `packages/protocol/src/rules.ts`
  - 1: "A project's rules: AGENTS.md, pulled into CLAUDE.md" → docs/design/overview.md#a-projects-rules-agentsmd-pulled-into-claudemd
- `packages/protocol/src/schemas.ts`
  - 1080: "Clock steps" → docs/design/state.md#clock-steps-ordering-by-what-was-seen-not-by-the-wall-clock-queue-fl-plan-fl4
- `packages/protocol/src/state.ts`
  - 358: "Clock steps" → docs/design/state.md#clock-steps-ordering-by-what-was-seen-not-by-the-wall-clock-queue-fl-plan-fl4
- `packages/protocol/src/train.ts`
  - 1: "Merging back" → docs/design/git.md#merging-back
- `packages/protocol/src/usage-estimate.ts`
  - 2: "Estimating a turn's use" → docs/design/usage.md#estimating-a-turns-use
  - 19: "Measuring token use" → docs/design/usage.md#measuring-token-use
- `packages/protocol/test/clock.test.ts`
  - 1: "Clock steps" → docs/design/state.md#clock-steps-ordering-by-what-was-seen-not-by-the-wall-clock-queue-fl-plan-fl4
- `packages/protocol/test/usage-estimate.test.ts`
  - 1: "Estimating a turn's use" → docs/design/usage.md#estimating-a-turns-use
- `scripts/capture/faults.ts`
  - 1: "Layout faults" → docs/design/dashboard.md#layout-faults-queue-pl
- `scripts/capture/seed-recurring.ts`
  - 84: the whole document
- `scripts/token-report.ts`
  - 10: "Measuring token use" → docs/design/usage.md#measuring-token-use
- `scripts/token-report/analysis.ts`
  - 4: "Measuring token use" → docs/design/usage.md#measuring-token-use
- `scripts/token-report/transcripts.ts`
  - 3: "Measuring token use" → docs/design/usage.md#measuring-token-use
- `scripts/token-report/weights.ts`
  - 6: "Measuring token use" → docs/design/usage.md#measuring-token-use

#### Fixtures (no change)

- `apps/web/test/fileview.test.ts:66` (DESIGN)
- `apps/web/test/fileview.test.ts:66` (DESIGN)
- `apps/web/test/fileview.test.ts:68` (PROTOCOL)
- `apps/web/test/fileview.test.ts:68` (PROTOCOL)
- `apps/web/test/hash.test.ts:34` (DESIGN)
- `apps/web/test/hash.test.ts:34` (DESIGN)
- `apps/web/test/refs.test.ts:64` (PROTOCOL)
- `apps/web/test/refs.test.ts:64` (PROTOCOL)
- `packages/protocol/test/templates.test.ts:126` (PROTOCOL)
- `packages/protocol/test/templates.test.ts:229` (PROTOCOL)
- `scripts/test/token-report.test.ts:33` (PROTOCOL)
- `scripts/test/token-report.test.ts:67` (PROTOCOL)
- `scripts/test/token-report.test.ts:150` (PROTOCOL)
- `scripts/test/token-report.test.ts:173` (DESIGN)
- `scripts/test/token-report.test.ts:173` (DESIGN)
- `scripts/test/token-report.test.ts:218` (PROTOCOL)
- `scripts/test/token-report.test.ts:221` (PROTOCOL)

### Inside the two documents

Quoted section names whose section moves to another topic file ("in" is the file the quoting line moves to;
[other document] quotes the other document; code blocks left out).

#### Inside PROTOCOL.md (138)

- 3 (in index) [link]: DESIGN.md
- 21 (in files.md): "Languages" → docs/protocol/settings.md
- 60 (in files.md): "Global settings" → docs/protocol/settings.md
- 136 (in settings.md): "Runtime, model and effort per step" → docs/protocol/runtimes.md
- 140 (in settings.md): "The orchestrator" → docs/protocol/orchestrator.md
- 156 (in settings.md): "One queue per checkout, and a limit" → docs/protocol/git.md
- 156 (in settings.md): "Checks run by Nexus" → docs/protocol/checks.md
- 156 (in settings.md): "The review helper" → docs/protocol/review.md
- 157 (in settings.md): "Without a model" → docs/protocol/git.md
- 294 (in queues.md): "Runtime, model and effort per step" → docs/protocol/runtimes.md
- 484 (in queues.md): "The step turn" → docs/protocol/sessions.md
- 486 (in queues.md): "Context care" → docs/protocol/runtimes.md
- 534 (in git.md) [other document]: "The integration step without a model" → docs/design/git.md
- 564 (in git.md): "Checks run by Nexus" → docs/protocol/checks.md
- 602 (in git.md): "worktree setup" → docs/protocol/files.md
- 660 (in sessions.md) [other document]: "Clock steps" → docs/design/state.md
- 677 (in sessions.md): "Review pictures" → docs/protocol/review.md
- 679 (in sessions.md): "Review pictures" → docs/protocol/review.md
- 680 (in sessions.md): "Project metrics" → docs/protocol/stats.md
- 680 (in sessions.md): "Checks run by Nexus" → docs/protocol/checks.md
- 681 (in sessions.md): "Checks run by Nexus" → docs/protocol/checks.md
- 683 (in sessions.md): "Tags" → docs/protocol/stats.md
- 692 (in sessions.md): "Recurring queues" → docs/protocol/planning.md
- 695 (in sessions.md): "The plan" → docs/protocol/planning.md
- 695 (in sessions.md): "Schedules" → docs/protocol/planning.md
- 696 (in sessions.md): "The plan" → docs/protocol/planning.md
- 697 (in sessions.md): "Tags" → docs/protocol/stats.md
- 698 (in sessions.md): "Recurring queues" → docs/protocol/planning.md
- 699 (in sessions.md): "Static analysis reminder" → docs/protocol/planning.md
- 700 (in sessions.md): "Project metrics" → docs/protocol/stats.md
- 701 (in sessions.md): "Project metrics" → docs/protocol/stats.md
- 702 (in sessions.md): "Review" → docs/protocol/review.md
- 702 (in sessions.md): "The review helper" → docs/protocol/review.md
- 703 (in sessions.md): "Sending a step back" → docs/protocol/review.md
- 703 (in sessions.md): "The review helper" → docs/protocol/review.md
- 704 (in sessions.md): "The review helper" → docs/protocol/review.md
- 705 (in sessions.md): "The review helper" → docs/protocol/review.md
- 706 (in sessions.md): "Reject" → docs/protocol/files.md
- 707 (in sessions.md): "The user's level" → docs/protocol/review.md
- 708 (in sessions.md): "Provisional acceptances" → docs/protocol/review.md
- 712 (in sessions.md): "Conversations" → docs/protocol/conversations.md
- 730 (in files.md): "Cleaning up a survey's worktree" → docs/protocol/git.md
- 730 (in files.md): "The merge train" → docs/protocol/git.md
- 730 (in files.md): "Without a model" → docs/protocol/git.md
- 730 (in files.md): "Git on the dashboard" → docs/protocol/git.md
- 730 (in files.md): "Git on the dashboard" → docs/protocol/git.md
- 731 (in files.md): "Checks run by Nexus" → docs/protocol/checks.md
- 732 (in files.md): "Pushing what was accepted" → docs/protocol/git.md
- 733 (in files.md): "The plan" → docs/protocol/planning.md
- 734 (in files.md): "The plan" → docs/protocol/planning.md
- 734 (in files.md): "Schedules" → docs/protocol/planning.md
- 734 (in files.md): "The plan" → docs/protocol/planning.md
- 734 (in files.md): "One queue per checkout, and a limit" → docs/protocol/git.md
- 735 (in files.md): "A new revision of a running queue never stops the running step" → docs/protocol/queues.md
- 735 (in files.md): "One queue per checkout, and a limit" → docs/protocol/git.md
- 735 (in files.md): "Runtime, model and effort per step" → docs/protocol/runtimes.md
- 735 (in files.md): "The closing refactoring step" → docs/protocol/queues.md
- 735 (in files.md): "Fallback when usage runs out" → docs/protocol/runtimes.md
- 735 (in files.md): "Fallback when usage runs out" → docs/protocol/runtimes.md
- 735 (in files.md): "Changes and lifting a stop" → docs/protocol/queues.md
- 736 (in files.md): "The chats during an update" → docs/protocol/api.md
- 736 (in files.md) [other document]: "When Claude Code saves a conversation" → docs/design/engine.md
- 741 (in files.md): "The orchestrator's context care" → docs/protocol/orchestrator.md
- 744 (in files.md): "Global settings" → docs/protocol/settings.md
- 746 (in files.md): "Tags" → docs/protocol/stats.md
- 746 (in files.md): "Fallback when usage runs out" → docs/protocol/runtimes.md
- 746 (in files.md) [other document]: "Sub-agent tokens" → docs/design/usage.md
- 746 (in files.md) [other document]: "Estimating a turn's use" → docs/design/usage.md
- 747 (in files.md): "Away mode" → docs/protocol/review.md
- 747 (in files.md): "Review" → docs/protocol/review.md
- 748 (in files.md): "The capacity coordinator" → docs/protocol/checks.md
- 751 (in files.md): "Planned deploys" → docs/protocol/api.md
- 776 (in files.md): "The integration step" → docs/protocol/git.md
- 784 (in files.md): "The integration step" → docs/protocol/git.md
- 798 (in files.md): "Pushing what was accepted" → docs/protocol/git.md
- 821 (in review.md): "Without a model" → docs/protocol/git.md
- 847 (in review.md): "A new revision of a running queue never stops the running step" → docs/protocol/queues.md
- 869 (in review.md): "The plan" → docs/protocol/planning.md
- 949 (in review.md) [other document]: "Routine reviews by a helper" → docs/design/review.md
- 1014 (in review.md): "Pushing what was accepted" → docs/protocol/git.md
- 1077 (in review.md): "The `nexus` CLI" → docs/protocol/cli.md
- 1099 (in git.md): "Times and order" → docs/protocol/sessions.md
- 1156 (in review.md): "Notes" → docs/protocol/files.md
- 1204 (in git.md): "Planned deploys" → docs/protocol/api.md
- 1205 (in git.md): "The plan" → docs/protocol/planning.md
- 1403 (in sessions.md): "The integration step" → docs/protocol/git.md
- 1403 (in sessions.md): "Without a model" → docs/protocol/git.md
- 1412 (in sessions.md): "Sending a step back" → docs/protocol/review.md
- 1412 (in sessions.md): "Checks run by Nexus" → docs/protocol/checks.md
- 1605 (in checks.md) [other document]: "Nexus runs the checks" → docs/design/checks.md
- 1916 (in api.md): "A project's rules files" → docs/protocol/files.md
- 1931 (in api.md): "The work a stopped step left" → docs/protocol/queues.md
- 1931 (in api.md): "The closing refactoring step" → docs/protocol/queues.md
- 1936 (in api.md): "The plan" → docs/protocol/planning.md
- 1938 (in api.md): "Conversations" → docs/protocol/conversations.md
- 1944 (in api.md): "Conversations" → docs/protocol/conversations.md
- 1945 (in api.md): "Project metrics" → docs/protocol/stats.md
- 1946 (in api.md): "Statistics" → docs/protocol/stats.md
- 1946 (in api.md): "The review helper" → docs/protocol/review.md
- 1947 (in api.md): "Statistics" → docs/protocol/stats.md
- 1948 (in api.md): "Tags" → docs/protocol/stats.md
- 1949 (in api.md): "Queue templates" → docs/protocol/planning.md
- 1950 (in api.md): "Recurring queues" → docs/protocol/planning.md
- 1952 (in api.md): "The plan" → docs/protocol/planning.md
- 1954 (in api.md): "Review pictures" → docs/protocol/review.md
- 1960 (in api.md): "Merge back and clean up" → docs/protocol/git.md
- 1962 (in api.md): "A project's rules files" → docs/protocol/files.md
- 1965 (in api.md): "Continue" → docs/protocol/queues.md
- 1965 (in api.md): "The closing refactoring step" → docs/protocol/queues.md
- 1966 (in api.md): "The work a stopped step left" → docs/protocol/queues.md
- 1973 (in api.md): "Stopping a chat agent's turn" → docs/protocol/orchestrator.md
- 1973 (in api.md): "The orchestrator" → docs/protocol/orchestrator.md
- 1975 (in api.md): "Global settings" → docs/protocol/settings.md
- 1979 (in api.md): "Removing a project" → docs/protocol/files.md
- 1980 (in api.md): "Removing a project" → docs/protocol/files.md
- 1989 (in api.md): "The capacity coordinator" → docs/protocol/checks.md
- 2059 (in api.md): "How the engine runs a Codex session" → docs/protocol/runtimes.md
- 2436 (in conversations.md): "The `nexus` CLI" → docs/protocol/cli.md
- 2622 (in orchestrator.md): "How the engine runs a Codex session" → docs/protocol/runtimes.md
- 2683 (in orchestrator.md): "The plan" → docs/protocol/planning.md
- 2687 (in orchestrator.md): "The plan" → docs/protocol/planning.md
- 2691 (in orchestrator.md): "Tags" → docs/protocol/stats.md
- 2701 (in orchestrator.md): "Housekeeping by the orchestrator" → docs/protocol/queues.md
- 2805 (in planning.md): "One queue per checkout, and a limit" → docs/protocol/git.md
- 2866 (in planning.md): "Away mode" → docs/protocol/review.md
- 2945 (in planning.md): "Cleaning up a survey's worktree" → docs/protocol/git.md
- 2961 (in planning.md): "Checks run by Nexus" → docs/protocol/checks.md
- 3130 (in git.md): "Global settings" → docs/protocol/settings.md
- 3380 (in runtimes.md): "The orchestrator" → docs/protocol/orchestrator.md
- 3385 (in runtimes.md): "Tags" → docs/protocol/stats.md
- 3459 (in runtimes.md): "The closing refactoring step" → docs/protocol/queues.md
- 3503 (in orchestrator.md) [other document]: "The orchestrator's context care" → docs/design/usage.md
- 3555 (in runtimes.md): "Uploads" → docs/protocol/api.md
- 3555 (in runtimes.md): "Server API" → docs/protocol/api.md
- 3563 (in runtimes.md) [other document]: "Background work" → docs/design/engine.md
- 3591 (in runtimes.md) [other document]: "Background work" → docs/design/engine.md
- 3634 (in runtimes.md) [other document]: "Worker process ownership on Windows" → docs/design/engine.md
- 3645 (in runtimes.md): "The capacity coordinator" → docs/protocol/checks.md

#### Inside DESIGN.md (20)

- 9 (in index) [link]: PROTOCOL.md
- 66 (in overview.md) [other document]: "Review" → docs/protocol/review.md
- 118 (in overview.md): "Failures" → docs/design/engine.md
- 118 (in overview.md): "Background work" → docs/design/engine.md
- 198 (in checks.md) [other document]: "Checks run by Nexus" → docs/protocol/checks.md
- 274 (in checks.md): "The integration step without a model" → docs/design/git.md
- 593 (in review.md) [other document]: "The review helper" → docs/protocol/review.md
- 900 (in git.md) [other document]: "The integration step" → docs/protocol/git.md
- 900 (in git.md) [other document]: "Without a model" → docs/protocol/git.md
- 944 (in git.md): "continue" → docs/design/usage.md
- 952 (in git.md) [other document]: "Review" → docs/protocol/review.md
- 1771 (in chat.md): "one writer per file" → docs/design/overview.md
- 1887 (in chat.md) [other document]: "Uploads" → docs/protocol/api.md
- 1929 (in dashboard.md) [other document]: "Files and commits" → docs/protocol/api.md
- 2070 (in dashboard.md): "Chat-first on a desktop" → docs/design/chat.md
- 2082 (in dashboard.md): "Chat-first on a desktop" → docs/design/chat.md
- 2151 (in dashboard.md): "Chat-first on a desktop" → docs/design/chat.md
- 2385 (in runtimes.md): "Updating Nexus" → docs/design/updates.md
- 2403 (in runtimes.md): "The variable is consumed once" → docs/design/updates.md
- 3054 (in state.md): "push on deploy" → docs/design/updates.md
