# Backlog

Ideas for Nexus, in the order they should come: first what keeps Nexus safe while it develops itself, then what
makes unattended runs trustworthy. None is approved: the orchestrator turns them into queues with the user, and each
queue needs the user's approval.

## 1. Updates that roll back

Nexus develops itself, so a broken version must not take the live instance down. Today an update that builds but
then fails to start leaves no server running (and remote access with it). Have the successor report that it is up
and serving; if it does not within a minute, put the live worktree back on the previous commit and start that, and
say so in the log and the dashboard. A smoke check (the API answers, a project loads) before the predecessor exits
would be better still.

## 2. Deploying from the orchestrator chat, and pushing on deploy

- **Push on deploy.** Deploying a version to the live instance is the moment the user accepts it, so the update
  pushes `main` to its remote (after the build, before the restart). A failed push does not stop the deploy; the
  dashboard and the update log say it failed and why. A project setting can turn it off.
- **Deploy when asked.** The orchestrator may run `nexus server update` (it already may; workers and partners may
  not) only when the user asks for it in the chat, never on its own. Before it does, it says whether a step is
  running anywhere (the update waits for it; `--now` interrupts instead), and that it restarts with Nexus.
- **Told afterwards.** After a restart that came from an update, the orchestrator that asked for it is told the
  outcome (the new version, or why it failed and what still runs), and passes it on.

## 3. The orchestrator accepts steps, and Nexus pushes what was accepted

A third review mode beside "go on" and "wait for the user": **the orchestrator checks**. Per project, per queue or
per step (`review_policy: orchestrator`).

1. The worker finishes a step and commits. It does not push.
2. The engine holds the step in review and tells the orchestrator, with what it needs: the step's acceptance, its
   checks and review material, its commits.
3. The orchestrator checks the result against the acceptance criteria, with its helpers (run-digest for the step's
   record; the project's own read-only reviewers, such as an invariant reviewer for the diff). Then one of:
   - **accept** (`review.accepted`, which an orchestrator may already write): Nexus pushes the queue's branch and the
     queue goes on;
   - **send back**, with what to fix: a message to the worker, and the step is worked on again (a bounded number of
     times, then it goes to the user);
   - **ask the user**, when it is not sure, or when the project's rules say the matter is the user's (in Project
     Honeycomb the look always is): the step waits in review, the user is notified, and the user's acceptance
     pushes the same way.
4. The push is done by the Nexus server (`git push` of the branch the queue runs on), not by an agent: it does not
   depend on a permission classifier or a sandbox, and it happens only at a step's boundary. A failed push is shown
   on the step and does not lose the acceptance; it is retried with the next one.

Also: the user's own acceptance of a step in review (the "wait" mode) pushes the same way.

Project Honeycomb's rules say a worker pushes after every step. Once this works, its AGENTS.md needs the change
proposed in [proposals/honeycomb-push-after-acceptance.md](proposals/honeycomb-push-after-acceptance.md). The user
approves that change; the orchestrator brings it to the user when the feature is in the live instance.

## 6. Context care between steps

When a session's context is fuller than the project's threshold at a step's end, have it write its context summary,
then go on in a fresh session seeded with that summary (and the queue's own text), instead of letting the runtime
compact on its own in the middle of a step.

## 7. Chains and schedules

"When queue A is done, start B" (both approved); "start when the usage window resets"; "start at night". Shown on
the queues, cancellable.

## 8. Runtime, model and effort per step

A step in the queue YAML may name its runtime, model and effort (a mechanical step on a small model, a design step on
a strong one). The engine switches sessions where a step needs another runtime, carrying the context summary across.

## 9. Git on the dashboard

Per step, the commits it made and a summary of their diff; the branch's state; for a finished queue with its own
worktree, merging back and cleaning up as explicit, user-approved actions.

## 10. Reviewing

A before/after comparison viewer for review images; per picture "accept" or a comment, which goes back to the
worker as a note for the next step or round.

## 11. Smaller

- Voice input in the chats on the phone (the browser's speech recognition).
- Notifications per kind on or off; quiet hours.
- Search across a project's history: events, chats, reports.
- Adopting a session started in a terminal into Nexus (its transcript resumed by Nexus once the terminal is closed).
- The orchestrator on Codex (its `read-only` sandbox with `.nexus/` writable), for projects that prefer it.
