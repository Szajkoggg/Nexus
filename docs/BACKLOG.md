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

## 3. The orchestrator accepts steps, and Nexus pushes what was accepted

Pending with the user: docs/proposals/honeycomb-push-after-acceptance.md, to bring up after deploy.

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
