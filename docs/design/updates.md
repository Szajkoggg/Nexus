# Updating Nexus

Part of [the design](../DESIGN.md).

See also: [Findings from building phase 3](runtimes.md#findings-from-building-phase-3).

## Updating Nexus

Nexus updates itself between steps (`src/lifecycle.ts`). It holds every running queue at the end of its step
(`resume_after_restart`), moves the live worktree, installs and builds, then hands over to its successor
(`src/handover.ts`). The hand-over keeps two rules: exactly one server writes the projects' files at any time, and
the old server goes only once the new one has shown it works.

1. The predecessor writes `predecessor.json`, stops every agent and waits for their exits to be recorded. It stops
   its own writing (watchers closed, timers cleared, change handling off) and frees the port. It stays alive.
2. It starts the successor with `NEXUS_HANDOVER` naming the hand-over folder. The successor listens and runs a smoke
   check, reading only: `GET /api/server` answers with a version, the dashboard answers if it is built, and every
   registered project's state loads. It writes `ready.json` on success. On failure it writes `failed.json` and
   exits.
3. When `ready.json` appears, the predecessor writes `released.json` with its update log and exits. The successor
   then builds its engines, which is when held runs are recovered and resumed. Its update log, shown in the
   dashboard's server panel (`phase: updated`), begins with the predecessor's lines and ends with the version that
   is up.
4. If the successor does not come up, the predecessor rolls back. That is when it gets no signal within 60 seconds
   (a constant), finds `failed.json`, or sees the successor exit early. See "Rolling back" below.

**What the drain waits for.** Every `tickMs` (`LifecycleOptions`, 2 s by default; tests set less) the drain asks every
project whether a worker is still in a turn. A worker settling after a turn that had a `next` message sent into it
counts as in a turn (`AgentHost.idle`, `AgentProcess.settling`): Claude Code may still run that message as a late turn
of its own, and a restart in that moment would lose it (queue LS, finding 14). So the drain waits for the late turn to
run and end, or for the moment to pass without one (`test/update-drain-settling.test.ts`, queue LCF).

**The chats during an update** (decided 2026-11-15, queue OP). Before, the drain waited for every agent's turn and
refused the user's chat messages, so a deploy that waited an hour for a step closed the orchestrator's chat and the
conversations for that hour, with nothing gained: a chat turn starts no work, and a run start stays refused anyway. Now
only the workers' turns hold the drain (`projectPart` in `src/lifecycle.ts`, the one wiring main.ts and the tests
share). A chat turn still running when the drain ends is not waited for either: at the hand-over it is cut off. Waiting
for it would let a long answer, or a chatty user, hold a deploy indefinitely, and cutting it off loses little, since the
turn can be asked again. So the release first cuts off (interrupts) those turns, after it stopped taking requests, so no
new turn slips in between, and writes what each answered into its session's `runtime.json` (`interrupted`). The server
already owns that file, and every server, once active, reads it: a successor, and also a predecessor that rolled back,
which goes on the same way. What a turn answers is tracked as messages are sent (`AgentHost.send`): the texts sent into
the running turn, and those queued as the next one, by the roles' own quote, the user's words rather than a message
wrapped with a step's context or deploy changes. The quote of a resumed turn is the original one, so a second restart
does not nest them. The agent is asked to check what the cut-off turn had already done, because it may have written a
draft or run a command before it was stopped.

**Rolling back.** The predecessor's process still runs the old code from memory. Only what is read from disk has
moved: the worktree, which the next start runs, and `node_modules` and the built dashboard, which this server serves.
So rolling back means four things:
- Stop the successor and everything it started: on Windows `taskkill /T /F` on its pid, elsewhere its process group,
  since it was started detached. A successor never released is still in standby and has started nothing, but an
  older one that ignores the hand-over may have.
- Check out the commit the update came from on a live worktree. Run `npm install` if the lock file differs from the
  one the update installed (or half installed), and rebuild the dashboard. A development checkout is never moved.
- Take the port again, retrying for up to 20 s while the stopped successor lets go of it.
- Build new engines on the files. Their recovery resumes the held queues (`resume_after_restart`) exactly as a
  successor's would. The old engines were shut down for good by the release.

The projects' side of both is `ProjectRegistry` (`src/project-registry.ts`, queue LCF): `release` stops their
watchers, the planner's and the capacity's writes and every agent; `dropAll` takes each released project out as a
removed one is (its model closed, its engine out of the coordinator); `refresh` loads them anew. The port stays
`main.ts`'s. `test/project-registry.test.ts` runs that start over on two projects: every old model is closed once,
the coordinator holds only the new engines, and a write after it reaches one model per project.

The update then ends in phase `failed`. The error is the reason followed by "rolled back to <commit>" (in a
development checkout: "this server goes on"). The log keeps every line, and a push notification goes to the user's
devices. A failure before the hand-over (a checkout, install or build that fails) also puts a live worktree back.
That server never let go, so its queues simply go on. If the worktree cannot be put back, the error says to do it by
hand before the next start; if the port cannot be had, the error says so and the work goes on without the dashboard.

Until it is released, a successor builds no engine. So it does no recovery, resumes nothing, starts no agent and
writes nothing under any `.nexus/`; it answers `/api/projects…` with 503. The predecessor's exit also counts as
release, since a gone process writes nothing. This covers a predecessor that gave up waiting.

Files carry the signals, not HTTP. The predecessor has given up its port and has nothing to serve. Files keep each
signal's single writer obvious, and they stay behind for reading after a failed update. The order is
release → start → wait, so the successor normally finds the port free; it still waits up to 60 s for it
(`NEXUS_WAIT_PORT`).

**Compatibility.** A start without `NEXUS_HANDOVER` behaves as before: `live.ps1`, `autostart.ps1`, a plain
`npm start`, or a successor started by an older server, which frees the port as it exits and sends no hand-over.
Such a server is active at once and resumes the held queues. A successor of an older version, started by a newer
predecessor, ignores the folder and never signals. Updating to a version from before the hand-over is a downgrade:
after 60 s the predecessor stops that successor, along with any agents it had resumed, and rolls back. Runs the old
successor had resumed come back paused ("the Nexus server restarted"), as after any crash. Updating to such a
version is not supported; do it with `live.ps1`.

**The variable is consumed once.** A successor reads `NEXUS_HANDOVER` at start and deletes it from `process.env`
before anything else runs, so nothing it starts inherits it. `agentEnv()` also removes it, as a second guard, and
tests start `main.ts` only through `test/helpers.ts`, which strips it. Removing the variable is the real protection.
As a backstop, a successor refuses a folder that is not under `<NEXUS_HOME>/handover`: both paths are resolved, the
comparison is case-insensitive on Windows, and the folder must lie strictly inside, ending in a separator. A refused
successor logs why and exits non-zero before writing or starting anything, so a real predecessor sees a failure and
rolls back. The backstop cannot catch a stray server that runs without `NEXUS_HOME`, since that server's home is the
real one.

**Push on deploy** (`src/deploy.ts`). The successor pushes, once it has taken over, and the predecessor does not.
Three reasons:
- A push may take up to its 60-second limit, and the predecessor pushing would keep the successor in standby, with
  the held queues waiting, for that long.
- A push is only right once the new version is known to be up, and the successor is where that is known.
- The result belongs in the update log the server panel shows, and that is the successor's.

The predecessor passes the deployed ref in `released.json`, and only `main` is pushed: the exact commit the live
worktree runs, `<sha>:refs/heads/main` to the upstream remote of `main`. It is a plain push, so git itself refuses
anything but a fast-forward. Prompts are off, and a hang ends at 60 s, so an unattended push can fail but never wait.
A failed push changes nothing about the deploy. The setting lives in `<NEXUS_HOME>/deploy.json`, written only by the
server. It can only be changed from the dashboard (the same Origin rule as withdrawing an approval), so an agent can
neither push nor turn pushing on.

**Commits per step, and foreign ones** (`src/gitinfo.ts`, queue N8). A commit carries nothing that says which agent
made it: workers commit with the user's own identity. In a worktree of the queue's own only its worker commits, but in
the main checkout the user and other queues commit too. Nexus already knows when the worker was at work on the step
(the runtime's turns in `activity.jsonl`), so a commit made outside those turns is marked as not the worker's. A commit
of the user's made during a turn is not caught; changing the commits (an author, a trailer) would catch it, but
Nexus does not touch what agents commit. The branch's state uses the local remote-tracking refs and says how old they
are: fetching is a network action, which the server does not take for the dashboard.

**Pushing what was accepted** (`src/accepted.ts`, queue N5). The server pushes an accepted step's work, not the
worker: a worker pushing depends on its permissions and sandbox, and could push work nobody accepted. What is pushed
is the commit that was HEAD when the step entered review, recorded then, never the branch tip at the time of the
acceptance: by then the next step may have committed (a run goes on while a step waits, or after it is accepted), and
that work is not accepted. Only the newest acceptance of a queue is pushed, since its commit includes the earlier
ones; a failed push is not retried on a timer but at the next acceptance and with Push again, so a refusing remote
costs one attempt per acceptance. The push reuses the deploy push's rules (plain push, no prompts, 60 s). Off by
default, per project (`defaults.push_accepted`). Found while testing it against a bare repository with a refusing
pre-receive hook: a push that changes no ref ("Everything up-to-date") never runs the remote's hooks, so it succeeds
however the remote is set; the result then says the commit "was already" there.

**What changed for agents** (the user's decision of 2026-11-13). An orchestrator session started before a deploy
keeps its old briefing and its habits. The `Agents:` lines in commit messages are where its news comes from:
- The successor collects them from the deployed range (local git, ancestry checked) into
  `<NEXUS_HOME>/deploy-changes.jsonl`. One file for the whole instance means every project's orchestrator reads the
  same record, and a restart rebuilds nothing.
- Each session is told the deploys newer than itself and not yet in its `applied.jsonl`.
- Notifications decide when, not whether: on, the changes go out like any notice and start a turn; off, they ride
  along with the next message the orchestrator gets. Holding them is why the key is written when they are delivered,
  not when they are recorded.
- They never reach the user's chat; the user asked for no "what changed" view.

**Planned deploys** (the user's decision of 2026-11-14, queue PD; `src/deploy-plan.ts`). A deploy can wait for a step
or a queue instead of starting at once. The plan does not hold anything itself: when its target is in, it starts an
ordinary update, whose drain holds every running queue at its step's end. The target's step has just ended, so its
queue stops right there. Watching the files alone was not enough: an agent's `nexus step done` and the end of its turn
can come within the file watcher's debounce, and the engine opens the next step at the turn's end. So the engine also
asks the planner at every step boundary, before it goes on (Engine option `boundary`). The hand-over ends the plan
before the successor starts, so that a successor reading the same file never deploys a second time; a plain restart
keeps it.

A plan that waits for the user's confirmation of provisional work (`provisional_counts` off, queue PD2) holds only its
own queue, at the step's end, not every queue through an early drain: the setting is the user's own choice for when they
are away, and a drain held open until they come back would stop every project. A plan at a time does not start its
drain while it waits, for the same reason. The deadline turns a waiting drain into one with `now` (Lifecycle.hurry)
rather than starting a second update.
