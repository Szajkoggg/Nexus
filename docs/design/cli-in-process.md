# The nexus CLI inside the tests' processes

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
  protocol-not-to-apps). The runtimes themselves (`fake-claude.ts`, `fake-codex.ts`) are still processes the engine
  starts: the next step of IPR.

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
