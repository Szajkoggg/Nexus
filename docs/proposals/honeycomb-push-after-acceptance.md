# Proposal: Project Honeycomb pushes after acceptance (for its AGENTS.md)

**Status: prepared, not applied.** For Project Honeycomb (`C:\Code\GameDev\ProjectHoneycomb\AGENTS.md`), once
[BACKLOG item 3](../BACKLOG.md) (the orchestrator accepts steps, and Nexus pushes what was accepted) runs in the live
instance. The user approves it; then it is applied in Honeycomb as one commit of its own, by whoever the user asks.

## Why

Under Nexus, a step's push is the moment it is accepted: by the orchestrator against the step's acceptance criteria,
or by the user where the matter is theirs (the look, always). The worker that did the work does not judge it and
does not push it. Outside Nexus (a session started by hand) nothing changes.

## The change

Two sentences of Honeycomb's AGENTS.md change; nothing else.

In "How work is done", the first item ends:

> Each step is still finished properly (checks, record, commit, push) before the next begins.

becomes:

> Each step is still finished properly (checks, record, commit, push) before the next begins. **Under Nexus** (the
> session has `NEXUS_SESSION` set) the step ends with the commit: Nexus pushes it once the step is accepted.

And "Committing":

> One commit per finished step, with a message that says what changed and the key numbers; push after it.

becomes:

> One commit per finished step, with a message that says what changed and the key numbers; push after it (under
> Nexus: do not push; Nexus pushes the step's commits when it is accepted).

## What stays as it is

- Stage explicit paths; the hook refusing `git add -A` stays.
- `invariant-reviewer` before each step's commit, `status-scribe` for the record: still the worker's.
- Experiments on their own branch, `wip/<step>` branches with a handover note.
- The look is the user's: an orchestrator never accepts a step whose acceptance includes the look; it asks the user.
