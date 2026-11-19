# Backlog

Ideas for Nexus, in the order they should come: first what keeps Nexus safe while it develops itself, then what
makes unattended runs trustworthy. None is approved: the orchestrator turns them into queues with the user, and each
queue needs the user's approval.

## 11. Smaller

- Voice input in the chats on the phone (the browser's speech recognition).
- Notifications per kind on or off; quiet hours.
- Search across a project's history: events, chats, reports.
- Adopting a session started in a terminal into Nexus (its transcript resumed by Nexus once the terminal is closed).
- The orchestrator on Codex (its `read-only` sandbox with `.nexus/` writable), for projects that prefer it.
- Close the local HTTP gap: an agent's script on this machine can send the dashboard's writes (approve, Continue,
  away) with a forged `Origin`, and Codex's sandbox does not block loopback (docs/design/runtimes.md, "An orchestrator on Codex can
  be kept to its drafts"). The orchestrator is not switched to Codex until this is done (the user, 2026-11-16).
