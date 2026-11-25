# Process, startup and cleanup tests

Part of [the design](../DESIGN.md).

See also: [Tests](tests.md), the file these sections moved out of when it passed 40 KB.

## Processes in tests (queue IPR)

Tests run the fake runtimes in their own process (`inProcessRuntime()`) and the CLI as a function; only the files
`scripts/real-process-tests.ts` lists, each with why, start processes ([cli-in-process.md](cli-in-process.md)).

## Startup and recovery tests, and their helpers (queue LCR)

Queue LCR closed the nine coverage gaps of the LC survey (LC-F1 to LC-F9, the survey of RN's start-up and recovery
work) with tests against the fakes and no product change. What they prove is Nexus's own choices: which start (resume
or fresh), which id, in which order, how many times a message or an effect reaches an agent, what a restart pauses or
goes on with. They do not prove how Claude Code or Codex keep a conversation (see
[runtimes.md](runtimes.md), "What the fake runtimes prove (queue LCR)"). The tracker that named every gap, its tests
and the latest run was the queue's review material; the table below is what stays.

| Gap | Test file (`apps/server/test/`) | What is held |
|---|---|---|
| F1 kill, close and stop during a startup replacement | `startup-replacement.test.ts`, `startup-replacement-worker.test.ts` | no corrective start after a kill or shutdown, one exit, the held message once; at the worker role Stop at once and a pause stay in force |
| F2 input replay, settings, accounting | the same two files | every message sent while the refused start is held reaches the corrected start once, in order and priority; arguments equal but for the session flag; usage from its own baseline; an answer given meanwhile reaches the turn once, with its qid |
| F3 a server that died without a word | `crash-recovery.test.ts` | a plain restart pauses the run; after Resume each start-up checkpoint and the twice-interrupted correction end as an uncrashed control does; the chat's cut-off message lost in a plain crash is not replayed |
| F4 a partner's cut-off first turn | `partner-recovery.test.ts` | once after cutOff, shutdown and resumeCutOff on a new server, for both runtimes, a saved conversation with a wrong mark, and a hand-over |
| F5 save signals and broken records | `claude-startup.test.ts`, `partner-recovery.test.ts` | the first whole init, assistant or result line tells saved once; a missing, truncated or wrong-typed runtime.json reads as none with a warning and is set aside at the next write; the id is kept |
| F6 Claude's negative start-up gates | `claude-startup.test.ts` | exactly one corrective start, only for a pre-output refusal naming the conversation; the 1000 ms stderr wait on mock timers |
| F7, F8 Codex's recovery and late refusals | `codex-recovery.test.ts`, `codex-exit.test.ts` | only the missing-rollout text starts a new thread, whatever the code; the new id is kept between the thread's answer and the turn; a refused turn/start ends one turn, once |
| F9 what a resumed conversation holds | `partner-recovery.test.ts` | a sentinel and a completed effect survive a normal resume, a legacy record and a false mark corrected to a resume, and the effect is not done again |

The helpers, all in `apps/server/test/` and all driven through the existing fakes (no second fake system):

- **`FakeGates`** (`fake-behaviour.ts`): holds Claude's fake at `first-read`, `save`, `first-output`, `refusal`,
  `stderr` and `exit`, Codex's at `answer:<method>`, each until the test releases it; the gates' environment goes into
  the adapter's options, never `process.env`. Only for fakes in the test's own process. `leftovers()` and `dispose()`
  are the cleanup (`fake-gates.test.ts`).
- **`FAKE-EXIT: <code | signal> [stderr]`** (Claude's fake) and **`FAKE_CODEX_RPC`** (Codex's): a start-up failure and a
  JSON-RPC answer chosen by the test (any error code and text, another result, none, an exit). `scripted-child.ts`
  is a runtime process the test writes itself, for the orders the fake does not give (stderr after the exit, stderr that
  never ends, a spawn error).
- **`crash-server.ts`** (`crashAt`, `endCrashServers`): a Node process of the test's own runs the engine or the
  orchestrator's resumeCutOff with the fakes in it, held at a gate, and the test ends it by its handle (no drain, no
  cut-off, no shutdown). The next server is a new store and engine on the same files and sees only what is on disk. Its
  environment keeps only a temporary `NEXUS_HOME` and the fakes' paths: a worker's own `NEXUS_DIR` and `NEXUS_SESSION`
  would point at the real project. The fakes have no process id, so a record left by it holds none and the next
  server ends nothing. `crash-recovery.test.ts` is listed in `scripts/real-process-tests.ts` for it.
- **The fakes' kept history and effect receipts** (`openConversation`, `takenIn`, `fakeHistory`, `fakeEffects`): a saved
  conversation keeps the messages Nexus sent it, and a resumed process starts with them; "FAKE-EFFECT: <key>" in a
  message makes a turn that completes write a receipt with an id of its own. A test counts receipts, so "once" means one
  receipt, not one id seen. A stopped or failed turn writes none.
- **`holds()`** (`wait.ts`): checks a state keeps for a window (every 25 ms), for what must not change after a late
  event.

Findings from building them, pinned as today's behaviour and not changed (the user decides whether any should be):

- A server killed after taking up a chat's cut-off mark (the notice sent, the mark cleared) before its process read the
  message leaves nothing to go on with: the next server does not replay it and nothing tells the user; the message
  stays in the chat and the next one is answered in the same session.
- The correction's "retry" activity (a refused start tried again, or a Codex thread started anew) begins the step's turn
  in AgentHost, so a crash in it leaves `turn_open` and the next server records one `interrupted` turn (queue CK).
- A legacy runtime record behind a saved conversation is resumed and keeps no mark afterwards.
- Refusal-like stderr after real output still tells `saved=false`; the next start's refusal corrects it with one more
  start. A Codex thread answered without an id gets a `turn/start` with none, a lasting `turnStartRejected`.

Stability of the new files was measured with `node scripts/load-tests.mjs` (12 busy loops, four copies, five rounds, 20
runs each, all green); none of the new test code sleeps longer than the 25 ms poll, except on the mock clock.

## The job host's End through a native seam (queue WHR)

`End` and `AwaitExit` in `apps/server/src/worker-job.cs` make their native calls (OpenProcess, IsProcessInJob,
WaitForSingleObject, TerminateProcess, CloseHandle and the last error after them) through one seam, the `EndCalls`
interface and its private field `calls`. The default, `Kernel32EndCalls`, forwards each call to the same P/Invoke the
code called directly before, and reads `Marshal.GetLastWin32Error()` right after it, so the job host behaves as before;
nothing at run time (no environment variable, no frame) selects another implementation.

A test compiles its own copy of `worker-job.cs` together with `apps/server/test/worker-end-calls.cs`
(`apps/server/test/worker-end.ps1`) and reaches the production `End` by reflection: no second implementation of the
algorithm exists in the tests. `ScriptedEndCalls` records every call with its handle, job and arguments, and answers
with the results and last errors the test scripts, for the ones Windows gives only in a race (a refused open, a false
TerminateProcess with error 5, WAIT_FAILED). `worker-end.test.ts` pins the call order on one handle and proves, with
the seam left at its default, that End ends a real member of a real job (exit code 1, from its TerminateProcess) and
leaves a process outside the job alive. Its matrix (queue WHR, WHR2) runs the whole End on every branch: OpenProcess
87 and other errors, a non-member, an exited member, an IsProcessInJob failure, TerminateProcess false/5 with a late exit
or a survivor, a timeout after a successful terminate, WAIT_FAILED after either, and last errors left or set by other
calls. Each case pins the exact calls and the outcome (exception type, NativeErrorCode, the operation's name), and the
identity rules hold on every branch: one open, every call on that handle, one close as the last call, a terminate only
after the membership check. These results are injected; the real-handle wait and the DACL denial stay in
`worker-exit.test.ts` as the Windows evidence.

`WorkerProcess` (`apps/server/src/worker-process.ts`), the server's end of the host's control pipe, takes the start of
the host as an optional constructor argument; the default starts `worker-job.ps1` as before.
`worker-process-frames.test.ts` gives it a pipe of its own and node:test's mock timers (queue WHR, WHR3): only the
matching `C <id>` resolves a cleanup, once; F and the host's close reject every pending one; the 15 s cleanup limit, the
15 s kill backstop after K and the 5 s grace after the input's E are passed on their boundaries, with the kills counted
and no timer left. A fake pipe frees no OS resource, so the file's native case runs the real host. Its job member
writes a ready file once it runs: a child's current directory is held only from its start, not from `spawn`'s return,
and asserting the lock before that failed 2 of 20 runs under load.

The cleanup held inside the native phase (queue WHR, WHR4): `nativeGate()` in `apps/server/test/gated-cleanup.ts`
starts the workers' processes in a real job host compiled with `apps/server/test/worker-gate.cs`
(`apps/server/test/worker-gate.ps1`), which wraps the host's End seam. It holds End at AwaitExit's 2000 ms wait on the
handle End opened and checked for the helper the test names (or before the kill's first open, after a DACL denial),
acknowledges with the PID and handle, and goes on with the real wait when the test opens it; the helper's
TerminateProcess can be answered false/5 instead of being made. `worker-cleanup-gate.test.ts` meets the held wait with
Stop now, Stop at once, the pipe's end, the host's kill, resumes, an inbox entry and a review's acceptance, for both
fake runtimes. Two Windows facts shaped it: a console helper started with `windowsHide` has a conhost of its own in the
job, and ending that conhost ends the helper whatever its DACL; Node puts its children in a kill-on-close job of its
own, so ending a runtime ends its helpers. The tests' helpers therefore share the host's console
(`ownedholdshared`, `owneddenyshared` in `apps/server/test/fake-behaviour.ts`).

A restart while the cleanup is held there (queue WHR, WHR5): `apps/server/test/worker-cleanup-restart.test.ts` puts an
update's hand-over, the server's own shutdown, its sudden death (`crashAt` with a gate folder: the server process of
`apps/server/test/crash-server.ts` runs the worker in gate hosts and is killed by its handle), a runtime crash (the gate
host ends its runtime by its own Process object) and a restart for changed settings at the held wait, and starts the
next server on the files. The workers are shared with WHR4 (`apps/server/test/worker-gate-fixture.ts`); the gate counts,
for every host it starts, how many earlier ones still ran, so "no new process beside the old job" is asserted, not
inferred. What building it showed, pinned and not changed: an update's drain counts a held cleanup as idle (it is no
turn), and main.ts's release then waits for the old processes, which end only after the cleanup; a server killed at the
held wait takes the job with it at once (Node's own kill-on-close job holds the host), before any next server; a
runtime crash under the cleanup races two of the host's threads (the control thread sends C after releasing the
cleanup's lock, the monitor ends the host once it has it), so the engine either opens the next step in the dead
process and retries it once, or takes the host's end as the process's exit; the work runs once either way. A helper
whose exit Node already sees may hold its directory a moment longer, and a dying runtime's helper may outlive the
2000 ms wait on a busy machine: the tests wait for the directory and the helper, not only for a PID.

The job's membership and Clean's deadlines (queue WHR, WHR6). Clean's two inputs, the job's membership list and its
clock, go through the same seam (`Members`, `StartTimer`, `ElapsedMilliseconds` on EndCalls); the default
(Kernel32EndCalls) calls the host's own Members() and a Stopwatch exactly as Clean did before, and as for End, nothing
at run time selects another seam: only a test's own compiled copy sets one by reflection. On the scripted seam
(`apps/server/test/worker-end-calls.cs`, request `clean`) `worker-end.test.ts` gives Clean its lists and clock: children
joining after a list, a member gone or exited before its open, the job's end, the 10 s checkpoint (read only after a
whole list, so it is no wall-clock limit) and several members each waiting 2000 ms. `worker-process-frames.test.ts`
separates the host's "worker job did not settle" from the server's 15 s. With real processes,
`apps/server/test/worker-cleanup-membership.test.ts` has the step's helper start a child after Clean's first list
(`apps/server/test/worker-helper.ps1` with -Late, fake behaviour `ownedholdsharedlate`): the child is a member by inheritance and is ended
before C; and a member exits between its listing and its open. The gate traces every list and every End call for any
member (`trace.log`; a failed call's error is kept before the gate writes its files, so End reads its own) and can
hold a wait and a later open in one cleanup (the kth hold answers in `arrived-k`, goes on at `open-k`).

What these tests do not show, and how far each layer reaches: the deadline branches (10 s, several 2000 ms waits) are
scripted, never waited out on a real job; the server's 15 s is shown on mock timers only; a member's exit racing its
termination was seen with real calls (the zero-time wait 258, TerminateProcess refused, the 2000 ms wait sees the
exit), but that is a process the test started, not the historical PT process, whose origin stays open; a real
TerminateProcess refusal of a live member comes only from the DACL helper (`worker-exit.test.ts`). The seams and gates
are test-only and leave the host's defaults unchanged. Extending the nexus-lifecycle template with these files is a
separate proposal, not done.
