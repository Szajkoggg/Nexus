# Backlog

Ideas for Nexus, roughly in order of how much they help unattended runs. None is approved: the orchestrator turns
them into queues with the user. Each queue still needs the user's approval.

## 0. Updates that roll back

Nexus now develops itself, so a broken version must not take the live instance down. Today an update that builds but
then fails to start leaves no server running (and remote access with it). Have the successor report that it is up
and serving; if it does not within a minute, put the live worktree back on the previous commit and start that, and
say so in the log and the dashboard. A smoke check (the API answers, a project loads) before the predecessor exits
would be better still.

## 1. Refused actions, visible

In `auto` permission mode (Claude Code) and with Codex's auto review, actions an agent wanted but was not allowed are
refused without asking. Claude Code reports them (`permission_denials` in each turn's `result`; `permission_denied`
system messages); Codex reports declined requests. Record them per session and step, show them in the dashboard (the
step's detail, and a per-project list grouped by kind), and offer to add an allow rule from a refusal (to the project's
settings, never to the project's own files).

## 2. Retrying what fails for a passing reason

Today an API overload, a lost connection or a runtime that crashes mid-turn halts the queue, and the user finds it
stopped hours later. Tell passing failures (the runtime's own error codes: overloaded, rate limited, network) from
lasting ones; retry the turn with backoff a bounded number of times, then halt with the reason; show the retries.

## 3. Context care between steps

When a session's context is fuller than the project's threshold at a step's end, have it write its context summary,
then go on in a fresh session seeded with that summary (and the queue's own text), instead of letting the runtime
compact on its own in the middle of a step.

## 4. Chains and schedules

"When queue A is done, start B" (both approved); "start when the usage window resets"; "start at night". Shown on
the queues, cancellable.

## 5. Runtime, model and effort per step

A step in the queue YAML may name its runtime, model and effort (a mechanical step on a small model, a design step on
a strong one). The engine switches sessions where a step needs another runtime, carrying the context summary across.

## 6. Git on the dashboard

Per step, the commits it made and a summary of their diff; the branch's state; for a finished queue with its own
worktree, merging back and cleaning up as explicit, user-approved actions.

## 7. Reviewing

A before/after comparison viewer for review images; per picture "accept" or a comment, which goes back to the
worker as a note for the next step or round.

## 8. Smaller

- One "waiting for you" view across all projects.
- Voice input in the chats on the phone (the browser's speech recognition).
- Notifications per kind on or off; quiet hours.
- Search across a project's history: events, chats, reports.
- Adopting a session started in a terminal into Nexus (its transcript resumed by Nexus once the terminal is closed).
- The orchestrator on Codex (its `read-only` sandbox with `.nexus/` writable), for projects that prefer it.
