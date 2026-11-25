# Nexus protocol

Status: **draft 1**, `protocol: 1`, 2026-11-12. The concepts behind it are in [DESIGN.md](DESIGN.md).

This is the contract between Nexus, the agents and the user: the files under a project's `.nexus/` directory, the
events agents append, and the `nexus` CLI that writes them. It does not depend on any runtime: anything that can run
a shell command can take part.

## Contents

The protocol is split by topic, one file each in `docs/protocol/`. New text goes into the file of its topic.

- [The `.nexus` files](protocol/files.md): the layout of `.nexus/`, `project.yaml`, notes, the rules files, removing a project.
  Sections: Rules; Layout; `project.yaml`; Notes: `notes/<step-id>/<note-id>.md`; Removing a project; A project's rules files
- [Server-owned runtime files](protocol/runtime-files.md): the files only the server's queue engine writes (`git.yaml`, `checks.yaml`, `push.yaml`, `plan.yaml`, runs, inboxes and the like).
  Sections: Server-owned runtime files
- [Settings](protocol/settings.md): the global settings, how a project follows them, and the languages.
  Sections: Global settings
- [Queues](protocol/queues.md): `queue.yaml`: steps, revisions, stops and the closing refactoring step.
  Sections: `queue.yaml`
- [Worktrees, integration and merging](protocol/git.md): the integration step, merging back, the merge train, cleaning up worktrees, pushing, one queue per checkout.
  Sections: The integration step; Git on the dashboard; Merge back and clean up; Cleaning up a survey's worktree; Pushing what was accepted; One queue per checkout, and a limit
- [Review](protocol/review.md): review levels, away mode, sending a step back, the review helper, review pictures.
  Sections: Review; Sending a step back; The review helper; Review pictures
- [Sessions, events and the step turn](protocol/sessions.md): events, the user's session, inboxes, `session.yaml`, the step turn, question links.
  Sections: Events: `sessions/<id>/events.jsonl`; The user's session; Inbox: `sessions/<id>/inbox.jsonl`; `session.yaml`; The step turn; Dashboard question links; The `nexus` command inside agents
- [The `nexus` CLI](protocol/cli.md): the `nexus` command and its subcommands.
  Sections: The `nexus` CLI
- [Checks and the machine's capacity](protocol/checks.md): the checks Nexus runs after a step, and the machine's capacity coordinator and full-test lock.
  Sections: Checks run by Nexus; The capacity coordinator
- [Server API](protocol/api.md): the HTTP API: searching, uploads, files, remote access, push, planned deploys.
  Sections: Server API
- [The live stream](protocol/live.md): the WebSocket's messages with the changes themselves, the sequence number per project, where a reply stands, the dashboard's rules for gaps and full reloads (queue SD).
  Sections: The live stream (WebSocket)
- [Conversations](protocol/conversations.md): the ideas overview, thinking-partner conversations, idea hand-offs.
  Sections: Conversations; Idea conversation scope and direct delivery (IC5)
- [The orchestrator](protocol/orchestrator.md): the orchestrator's session, its fallback and context care, stopping a chat agent's turn.
  Sections: The orchestrator; The orchestrator's context care
- [Plan, schedules, templates and recurring queues](protocol/planning.md): the plan, schedules, queue templates, recurring queues, the static analysis reminder.
  Sections: The plan; Schedules; Queue templates; Recurring queues; Static analysis reminder
- [Tags, metrics and statistics](protocol/stats.md): step tags, project metrics, statistics.
  Sections: Tags; Project metrics; Statistics
- [Runtimes, fallback and context care](protocol/runtimes.md): usage fallback, kinds and routing, context care, how the engine runs Codex and Claude Code sessions.
  Sections: Fallback when usage runs out; Kinds and their defaults; Runtime, model and effort per step; Context care; How the engine runs a Codex session; How the engine runs a Claude Code session
