# Nexus: design

Status: **draft 1**, 2026-11-12. For discussion; nothing here is built yet.

Nexus is a local dashboard and orchestrator for AI-driven development across several projects. It shows each
project's queues of work, drives agent sessions through them, carries messages between the user, an orchestrator
agent and the working agents, and keeps the context those sessions hold usable for later work.

The wire format (files, events, CLI) is in [PROTOCOL.md](PROTOCOL.md).

## Contents

The design is split by topic, one file each in `docs/design/`. New text goes into the file of its topic.

- [Goals, concepts and decisions](design/overview.md): goals, concepts, the architecture in brief, the tech stack, phases and the user's first decisions.
  Sections: Goals; Concepts; Architecture; Tech stack; Phases; What projects need to change; Decisions; A project's rules: AGENTS.md, pulled into CLAUDE.md; Removing a project (queue PJ)
- [The engine and the agents](design/engine.md): how the engine drives a queue: background work, process ownership, run states, failures, refused actions, the orchestrator, the texts agents receive.
  Sections: Background work; Worker process ownership on Windows (queue PT); The run's state transitions; One host for agent processes; The texts agents receive
- [The engine and the agents: failures, refused actions and the orchestrator](design/engine-failures.md): what happens when a turn fails, what the engine refuses, messages to a running step, the orchestrator, its briefing and the command line, the same commands on every shell tool.
  Sections: Failures; Refused actions; Messages to a running step; The orchestrator; Autonomy and insight; The orchestrator's briefing and the command line (queue TQ4); The same commands on every shell tool (queue SH)
- [Checks and static analysis](design/checks.md): the checks Nexus runs itself, and static analysis.
  Sections: Nexus runs the checks (queue EC); Static analysis (queue SA)
- [Questions](design/questions.md): questions between worker, orchestrator and user, and the question barrier.
  Sections: Questions: worker ↔ orchestrator ↔ user; Question navigation identity (QA1 finding); Preserving the selected question (QA2); Clickable question answers on every layout (QA3); Completing the question barrier (QA4)
- [Review](design/review.md): routine reviews by a helper, review material, review levels, provisional acceptances, away mode.
  Sections: Routine reviews by a helper (queue RH); Review material; Findings from review levels (queue RL1); Level 3: provisional acceptances (queue RL2); Away mode (queue RL3)
- [Required review decisions](design/review-decisions.md): a step's review decisions (queue RVD): the list the worker declares, answers by version and round, Accept held until every decision is answered, who may answer what at each level, old data, the return batch, the screens.
  Sections: The problem; Concepts; Who writes the list, and when; What counts, version by version and round by round; Accept and the other actions; Rights: who answers what; Missing lists and old data; The return batch and group confirmation; What the next worker gets; The screens (mockups); Decided in this design (technical; the designer's); The user's decisions (RVD1)
- [The plan and approvals](design/planning.md): the plan, approvals, the closing refactoring step kept by Nexus.
  Sections: The plan; Approvals; A closing refactoring step kept by Nexus
- [Context and usage](design/usage.md): context management, usage limits, estimating and measuring token use, compacting a conversation.
  Sections: Context management; Usage limits; Estimating a turn's use; Sub-agent tokens; Measuring token use; Compacting a conversation (queue CC3)
- [Worktrees and merging](design/git.md): worktrees, merging back, the integration step without a model, one queue per checkout, resuming worktree cleanup.
  Sections: Worktrees; Merging back; The integration step without a model (queue MI); Never two queues in one checkout; Resuming worktree cleanup (queue CW1)
- [Runtimes and findings from building](design/runtimes.md): runtimes and authentication, findings from building phase 3, the web for thinking partners, the user's Codex tools, the window between a Codex exit and its handling, what the fake runtimes prove.
  Sections: Runtimes and authentication; Findings from building phase 3; The web for thinking partners (queue WB); The user's Codex tools for workers (queue FX); What the fake runtimes prove (queue LCR)
- [Security on this machine](design/security.md): what keeps the agents Nexus runs from doing the user's actions: the local HTTP gap reproduced, who it matters for, the options, the user's choice and how it was built (queue HG).
  Sections: The local HTTP gap (queue HG)
- [Updating Nexus](design/updates.md): updating Nexus: hand-over, rolling back, pushing, planned deploys.
  Sections: Updating Nexus
- [The dashboard](design/dashboard.md): the dashboard's decisions: layers, the file viewer, colours, texts, the phone, the queue views, layout faults.
  Sections: Back closes the topmost layer; Details beside the chat on a wide screen (replaced); The file viewer; Colours are theme tokens; The interface texts in one place; One action bar; The phone; A queue's steps as a list, with one honest status; Approving: the whole queue in one scroll; Continue at the stop; Reviewing: the pictures first, the decision in the viewer; Layout faults (queue PL); Merge back where it waits (queue UF)
- [Done here, continued elsewhere](design/continued.md): a step whose own work is done while its fix goes on in another step or queue: the case, the options, the mark on a skipped step, where it shows, the effect on the protocol (queue UF).
  Sections: The case; Options; The mark (B); Where it shows; Effect on the protocol (for the user's decision)
- [The chat](design/chat.md): the chat: layout, the right rail, refs, the morning digest, drafts, quoting, search, pictures, speech.
  Sections: Chat-first on a desktop; The right rail; Refs in the chat; The morning digest; Drafts stay in the browser; Each chat keeps its place; Quoting in a chat; Long replies and message actions; Search in a chat, and pinned messages; Stopping a chat agent's turn; Pictures in a chat message; Speaking into a chat; Model and effort of a conversation
- [Tests](design/tests.md): the tests' waits, speed, flaky and hung tests, the tests reading through the model.
  Sections: The tests' waits (queue TS1); Tests while working, and the slowest files (queue TS2); The engine's own waits in tests, and what sets the slowest files (queue FX); Findings from the flaky tests (queue FU4); Findings from the tests that failed or hung in full runs (queue FL); Findings from four tests that failed once in full runs (queue KM); Volume shadow copies stop the tests (queue CI4); Waits for a stretch, not for a whole run; a window on the test's clock (queue CI8); The tests read through the model (queue MF); The agents' texts against the CLI (queue ACF); The compile cache, quick engine waits everywhere, and the tests' temporary folders (queue TI2)
- [Process, startup and cleanup tests](design/process-tests.md): the tests that start processes, the startup and recovery tests and their helpers, the job host's End and cleanup through its native seam.
  Sections: Processes in tests (queue IPR); Startup and recovery tests, and their helpers (queue LCR); The job host's End through a native seam (queue WHR)
- [Full test runs on the machine](design/test-runs.md): one full test run at a time, the lock held by its starter, its renewable lease, and the machine's state measured beside every run.
  Sections: One full test run on the machine (queue FX); The machine's state beside every full run (queue TI4)
- [The nexus CLI and the fake runtimes inside the tests' processes](design/cli-in-process.md): the CLI as a function (`run()`), one environment per call, the tests and fake runtimes calling it in their own process; the fake runtimes in the test's process (`inProcessRuntime()`), and the tests that stay real processes.
  Sections: The CLI as a function, and its calls in the tests (queue IPR1)
- [State, order and reads](design/state.md): clock steps, the dashboard's reads, the status rules, the cost of rebuilding state, missing and unreadable files.
  Sections: Clock steps: ordering by what was seen, not by the wall clock (queue FL, plan FL4); The dashboard's reads (queue RX1); One place for the status rules (queue RX3); The cost of rebuilding state (queue RX5); Missing and unreadable files (queue CHA)
- [The server's responsiveness](design/performance.md): how the server measures its event loop, requests and blocks, what the measurements under load found (before and after the model), why there is no worker thread, and the speed benchmark whose runs the Stats view draws as a trend.
  Sections: Measuring the server (queue SV1); The first measurement (2026-11-20); The dashboard's git reads without holding the loop (queue SV2); The engine's git calls: fewer, still synchronous (queue SV2B); Below normal priority for tests and workers (queue SV3); The measurement after the model, and the worker thread (queue SW); The step boundary's reads from the .git files (queue GB)
- [The derived model](design/model.md): the read layer over the files (queue SM): what the model holds, how the watcher feeds it, contradictions, rebuilding, today's readers and the order of moving them.
  Sections: What the model is; What it holds; How the watcher feeds it; Being as current as a read of the files; When a file contradicts its position; Derivation; Rebuilding; The two findings of the measurement, and the step that removes each; Today's readers; The order of moving the readers; The gate
- [The derived model: what was built, and what is proposed](design/model-built.md): what SM3 and SM4 built and how it differs from the plan, and the proposals beyond the decision.
  Sections: Built in SM3; Built in SM4; Beyond the decision (proposals, not decided)
- [Closed queues](design/archive.md): a closed queue's summary in the dashboard's state and its details read when opened, the model letting go of logs no one reads, the digest reading only the logs written since its time (queue AQ).
  Sections: What was measured before; The decision; The measurement; Tests; Beyond the decision (proposals, not decided)
- [The dashboard gets the changes](design/live.md): the deltas the server sends from the model's changes (queue SD): the state's parts, logs, chat agents' heads, one sequence per project, gaps and full reloads, which views apply them and which are asked again.
  Sections: What the dashboard does today; The principle; The state's delta; Logs; A chat agent's head; Order and gaps: one sequence per project; The views; How it is built and tested (SD2); Built in SD2; Beyond the decision (proposals, not decided)
- [Dependency updates](design/dependencies.md): dependency updates and what they taught.
  Sections: Hono Node adapter 2.x and the public SPA fallback (queue DU1); The lint toolchain's minimatch update (queue DU2)
- [Ideas](design/ideas.md): the ideas overview: relationships, dispositions, assessments, correction controls, hand-offs.
  Sections: Ideas relationships: persisted corrections (IC2); Ideas corrections: design boundary (IC1); Ideas dispositions and assessment validity (IC3); Ideas correction controls (IC4)

## Open questions

None at present. The local HTTP gap (any agent on this machine could send the dashboard's writes with a forged
`Origin`) was closed in queue HG: see [Security on this machine](design/security.md#built-in-hg2).
