# The nexus CLI and the fake runtimes inside the tests' processes

## The CLI as a function, and its calls in the tests (queue IPR1)

A full run started about 2,600 processes of `packages/cli/bin/nexus.js`: every report of a fake runtime (step start,
step done, a question, a context summary) and every CLI test's call. Each loaded Node, the CLI and the protocol package
again. IPR1 made the CLI a function, and the tests call it in the process they already have:

- **`run(argv, { env, cwd, stdout, stderr, stdin })`** in `packages/cli/src/main.ts` returns the exit code (0, 2 for a
  usage error with one `nexus: ...` line, 1 for anything else with its stack). It never exits the process and never
  writes to the console: `bin/nexus.js` passes the process's command line, environment, working directory and streams,
  and sets `process.exitCode` to what it returns, so an agent's call behaves as before.
- **One call, one environment.** Several sessions' calls may run in one process at once, so the CLI keeps its options,
  environment and working directory per call (`AsyncLocalStorage`), and reads nothing of the process's: `NEXUS_DIR`,
  `NEXUS_SESSION`, `NEXUS_PORT` and `NEXUS_HOME` come from the call, relative paths on its command line are read from
  its working directory, and git runs with its environment. The protocol helpers the CLI calls take the environment as
  a parameter whose default is `process.env`, so the server's calls are unchanged: `nexusHome`, `readRegistry`,
  `writeRegistry`, `readTurns`, `readGlobalSettings`, `readAway`, `readCapacity`, `findNexusDir`, `templateDirs` (for
  `readTemplates`), `reportFolder` and `inReportFolder` (the temporary folder from the call's TEMP), and a
  `ProjectStore` made with an environment reads the global settings, the away mode and the templates by it.
- **Waiting for the server does not block.** `waitApplied` (a draft, a run request, a send-back) waited with
  `Atomics.wait`; in a process that also runs the server, or a test's stand-in for it, that froze both for 15 s. It
  now waits with timers.
- **The fakes call it in their own process** (`apps/server/test/fake-behaviour.ts`), with their own environment, loaded
  at the first call. While a call runs, the fake's input is paused: a process the fake waited for (`execFileSync`)
  kept it from reading the next message until the call ended, and a test relies on that (orchestrator.test.ts: a
  second draft sent while the first waits for the server is a turn of its own, not a message read inside the first).
- **The tests' helper** is `packages/cli/test/run-cli.ts`: `cliRun` (exit code, stdout, stderr) and `cliOut` (stdout,
  or a `CliError` with `status`, `stdout` and `stderr`, as execFileSync's error has them).
- **Still real processes**, on purpose: the CLI's contract as agents meet it, `bin/nexus.js` with its exit code,
  stdout and stderr (`packages/cli/test/cli-roles-errors.test.ts`: the command-line usage errors and `nexus --help`);
  the user's CLI outside every agent's job (`apps/server/test/agent-guard.test.ts`); and the protocol package's one
  call (`packages/protocol/test/status.test.ts`), since the protocol may not import the CLI (dependency-cruiser's
  protocol-not-to-apps). The runtimes themselves (`fake-claude.ts`, `fake-codex.ts`) were still processes the engine
  started: IPR2 moved them in too (below).

Measured on the same machine, each full run alone under the lock (`npm test`; the processes counted by a preload
through `NODE_OPTIONS` that notes every start of `bin/nexus.js`):

| | before | after |
|---|---|---|
| wall clock | 638 s | 532 s |
| the test runner's duration | 634 s | 528 s |
| tests (pass, skipped) | 1627 (1626, 1) | 1627 (1625, 1; one failed: see below) |
| processes of bin/nexus.js | 2580 | 11 |

The run after had one failure, `apps/server/test/tags.test.ts` ("a proposed area waits for the user; ..."): the test
sends its second draft as soon as the notice of the acceptance is in the chat, and on a busy machine the orchestrator's
fake is still in the notice's turn, takes the draft in as read inside it and answers only "ok". It is the test's race,
not the CLI's: with `node scripts/load-tests.mjs --copies 4 --rounds 3 --wait-ms 10000` it failed in 2 of 12 runs with
the CLI in the fake's process, and in 1 of 24 runs with the fake and the CLI of the commit before (the same message).
The 11 processes left are the ones listed above as still real (9 of cli-roles-errors.test.ts, one each of the other
two).

## The fake runtimes in the test's own process (queue IPR2)

After IPR1 every agent process of a test was still a Node process of its own (`fake-claude.ts`, `fake-codex.ts`), on
Windows inside a job host (PowerShell, `worker-job.ps1`): about 460 of them in a full run. IPR2 runs them in the
test's own process, against the real adapters:

- **The fakes as functions.** `runFakeClaude(io)` and `runFakeCodex(io)` take what the process gave them before
  (`FakeIo`: argv, env, cwd, stdin, stdout, stderr, `exit(code)` and `signal()`) and return what ends them from
  outside. Run as a script, the file passes `process.*` and behaves as before; the tests of real processes use that.
  Everything a fake keeps is its own (`Fake`: its io, timers, the interrupt of its slow wait, the integration's stop),
  since many run in one process; `fake-behaviour.ts`'s helpers take the fake, and its `nexus` calls run with the
  fake's environment and working directory.
- **An ended fake does nothing more**, as a killed process does: no output, no timer fires (its timers are cleared),
  no `nexus` call starts (the call's promise never settles, and the work after it never runs).
- **The seam** is the one that was there: `AgentHostOptions.spawn` (the engine's, the orchestrator's, the
  conversations' and the review helpers'). `inProcessRuntime()` makes the real `ClaudeSession` or `CodexSession` with
  `spawnChild` (`ClaudeOptions`, `AgentOptions`: what starts the process, `spawnRuntimeChild` by default) set to a
  child in memory. A test that makes an adapter itself passes `inProcessClaude` or `inProcessCodex` as its
  `spawnChild`. The server never sets it.
- **The child in memory** (`apps/server/test/in-process-runtime.ts`): stdin, stdout and stderr are pipes whose data
  comes out once the writer's call has returned and before the event loop goes on (`process.nextTick`). A first
  version passed each chunk on a later turn of the event loop (`setImmediate`): a chunk took a turn, so Codex's answer
  to `turn/start` came after a user's message that the engine sent meanwhile; the adapter, without the turn's id,
  kept the message for the next turn, and the step that waited for it waited for ever (engine.test.ts, "a message
  reaches a working turn"). Its exit comes as the job host gives it: what the fake wrote is read first, then `exit`
  and `close`; a kill and a signal end it with exit code 1 (TerminateProcess, `worker-job.cs`). It has no pid: Nexus
  records none and looks for no process of it.
- **A process some code still starts** (a server, the model list, an engine made without the option) gets the fake's
  script, never the real CLI: `in-process-runtime.ts` sets `NEXUS_CLAUDE` and `NEXUS_CODEX` when they are not set.

What came out while moving the tests:

- **A notice read inside a turn.** A fake in the test's process runs only when the server's synchronous work has
  ended, so a notice sent right after another comes into the running turn more often than into a process of its own
  (Claude's `next`, Codex's steer). The orchestrator's fake acted only on a command read so (`FAKE-NEXUS`); a step
  waiting for its review was then never accepted (orchestrator.test.ts, recurring-maintenance.test.ts). It now acts on
  a worker's question and a review notice read inside a turn as on one of its own turn, as an agent acts on what it
  reads mid-turn.
- **The closing step's round ends with its turn**, which may come in after the run finished: closing.test.ts waited
  only for the run, and now waits for the round's end too.

**Still real processes**, each with why, are listed in `scripts/real-process-tests.ts`; the rule is one sentence in
[tests.md](tests.md), "Processes in tests". `scripts/test/real-process-tests.test.ts` reads every `*.test.ts` and
fails on a file that starts the fake runtimes (their script path in a string), a server (`spawnServer`), the CLI
(`bin/nexus.js` in a string) or test files (`"--test"`) as processes, is not listed and does not use the fakes in its
own process; and on a listed file that is gone or starts none. Besides the job host and process-tree tests, one
adapter test per runtime (Claude's settling, Codex's exit and drain window), the CLI's contract and the tests that
start a server, these stay real because their subject is the process: runtime-records.test.ts (the record's pid),
conversation-saved.test.ts (it waits for the pid before it ends the process, as a deploy does), scenario.test.ts
(its golden files hold the server's frozen clock, the runtimes and the CLI keep the system clock) and stopwork.test.ts
(clock-steps.test.ts runs it with the server's clock stepped and its agents on the system clock).
