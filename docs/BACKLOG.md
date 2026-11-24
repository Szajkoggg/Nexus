# Backlog

Ideas for Nexus, in the order they should come: first what keeps Nexus safe while it develops itself, then what
makes unattended runs trustworthy. None is approved: the orchestrator turns them into queues with the user, and each
queue needs the user's approval.

Nothing is planned at present.

## Built

Items that were in this list and are built; the commit is where each came in, the document is where it is described
today.

- Voice input in the chats on the phone (the browser's speech recognition): commit `fd28eb6`; README.md, "Speaking".
- Notifications per kind on or off, and quiet hours: commit `ecc901f`; README.md, "Which notifications a device gets".
- Search across a project's history (events, chats, reports): commit `4a2e027` (the search from the files) and
  `e59cb79` (the dashboard); README.md, "Searching the whole project".
- The orchestrator on Codex (its `read-only` sandbox with `.nexus/` writable): commit `fbda175`; README.md, "The
  orchestrator on Codex", and docs/design/runtimes.md, "An orchestrator on Codex can be kept to its drafts".
- Closing the local HTTP gap (a script on this machine sending the dashboard's writes with a forged `Origin`): queue
  HG, commits `bcfc5c8`, `a2dc3cb` and `d7ae29a`; docs/design/security.md, "The local HTTP gap (queue HG)".

## Dropped

- Adopting a session started in a terminal into Nexus (its transcript resumed by Nexus once the terminal is closed;
  queue AD). The user dropped it on 2026-11-24: a session's note and a fresh session bring the same more cheaply. The
  queue is deleted; the work of its steps AD1 and AD2 stays on the branch `nexus/AD`.
