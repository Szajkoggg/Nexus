// The tests that run the fake runtimes, a server or the `nexus` CLI as real processes, and why (queue IPR). Every other
// test runs the fake runtimes in its own process (apps/server/test/in-process-runtime.ts, inProcessRuntime()) and the
// CLI as a function (packages/cli/test/run-cli.ts): a process start costs a Node start, and on Windows a job host. Pure
// functions over the files' texts, so scripts/test/real-process-tests.test.ts can show them on a faulty example and run
// them on the real files.

/** The test files that start processes on purpose, each with why it needs them. */
export const REAL_PROCESS_TESTS: Readonly<Record<string, string>> = {
  // The Windows job host and the agents' process trees: what they test is the processes.
  "apps/server/test/worker-exit.test.ts": "the job host ends a worker's process tree at a step's boundary",
  "apps/server/test/worker-processes.test.ts": "a worker's descendants and what the job host does with them",
  "apps/server/test/worker-job.test.ts": "the worker's Windows job host itself",
  "apps/server/test/worker-job-load.test.ts": "a real job host's cleanup of many busy members and a parent starting children, timed against the server's 15 s",
  "apps/server/test/worker-end.test.ts": "compiles the job host's C# with the End harness in a PowerShell of its own, and ends real processes on the default seam",
  "apps/server/test/worker-process-frames.test.ts": "one case starts a real job host to show the frames it sends",
  "apps/server/test/worker-cleanup-gate.test.ts": "stops, resumes and a host's loss meet a cleanup held inside the real job host's native wait",
  "apps/server/test/worker-cleanup-membership.test.ts": "a job member starts a child, and another exits, while a cleanup is held inside the real job host's native wait",
  "apps/server/test/worker-cleanup-restart.test.ts": "a server's restart, its death in a server process of its own, a runtime crash and stale records meet a cleanup held inside the real job host's native wait",
  "apps/server/test/agent-guard.test.ts": "the write guard tells an agent's process (in its job) from the user's",
  "apps/server/test/stop-at-once.test.ts": "Stop at once ends the runtime's OS process (process.kill(pid, 0) fails after)",
  "apps/server/test/clock-steps.test.ts": "runs stop-at-once and stopwork with the server's clock stepped, its children on the system clock",
  "apps/server/test/setup-tree.test.ts": "the worktree setup command's child process ends with it (a drain, a shutdown, its time limit) and its folder is free: what it tests is the process tree",
  "apps/server/test/worktree-setup.test.ts": "the worktree_setup setting runs the setup command through the engine, on Windows in a real job host, and the tests stop and resume it at its gate",
  "apps/server/test/stopwork.test.ts": "clock-steps.test.ts runs it with the server's clock stepped: its agents and their CLI must keep the system clock, as processes of their own",
  // What the runtimes' processes leave in Nexus's records.
  "apps/server/test/runtime-records.test.ts": "the runtime record keeps the process id (pid) of the runtime's process",
  "apps/server/test/conversation-saved.test.ts": "waits for the runtime's process id in its record before it ends the process, as a deploy or a restart does",
  "apps/server/test/scenario.test.ts": "its golden files hold the server's frozen clock; the CLI and the runtimes, as processes, keep the system clock",
  // One adapter test per runtime over a real stdio JSON stream.
  "apps/server/test/claude-settling.test.ts": "Claude's adapter over a real process's stdio: output that arrives while the server's event loop stalls",
  "apps/server/test/codex-exit.test.ts": "Codex's adapter over a real process's stdio: a line read after the process's exit",
  "apps/server/test/codex-drain-window.test.ts": "Codex's adapter over a real process's stdio: a descendant holds stdout open after the exit",
  // The CLI's contract as a process.
  "packages/cli/test/cli-roles-errors.test.ts": "the CLI's exit codes, stdout and stderr as a process (bin/nexus.js)",
  "packages/protocol/test/status.test.ts": "the protocol package may not import the CLI (dependency-cruiser): it runs bin/nexus.js",
  // Tests that start a server: the HTTP API, the server's start and its own processes.
  "apps/server/test/archive-api.test.ts": "starts a server",
  "apps/server/test/away.test.ts": "starts a server",
  "apps/server/test/chat-pins.test.ts": "starts a server",
  "apps/server/test/chat-update.test.ts": "starts a server",
  "apps/server/test/conversation-settings.test.ts": "starts a server",
  "apps/server/test/crash.test.ts": "starts a server",
  "apps/server/test/crash-recovery.test.ts": "kills a server process of its own (crash-server.ts) where a fake is held: a server that dies without a drain or a shutdown",
  "apps/server/test/deploy-notices.test.ts": "starts a server",
  "apps/server/test/deploy-plan.test.ts": "starts a server",
  "apps/server/test/digest.test.ts": "starts a server",
  "apps/server/test/files.test.ts": "starts a server",
  "apps/server/test/guard.test.ts": "starts a server",
  "apps/server/test/handover.test.ts": "starts a server",
  "apps/server/test/home-watch.test.ts": "starts a server",
  "apps/server/test/http-adapter.test.ts": "starts a server",
  "apps/server/test/idea-handoff-api.test.ts": "starts a server",
  "apps/server/test/ideas-api.test.ts": "starts a server",
  "apps/server/test/limits-api.test.ts": "starts a server",
  "apps/server/test/live-api.test.ts": "starts a server",
  "apps/server/test/question-barrier-api.test.ts": "starts a server",
  "apps/server/test/refusals.test.ts": "starts a server",
  "apps/server/test/remove-api.test.ts": "starts a server",
  "apps/server/test/review-files.test.ts": "starts a server",
  "apps/server/test/rules-fix.test.ts": "starts a server",
  "apps/server/test/search-api.test.ts": "starts a server",
  "apps/server/test/slow-git.test.ts": "starts a server",
  "apps/server/test/stats-api.test.ts": "starts a server",
  "apps/server/test/stop-at-once-api.test.ts": "starts a server",
  "apps/server/test/unknown-project.test.ts": "starts a server",
  "apps/server/test/uploads.test.ts": "starts a server",
  "apps/server/test/withdraw.test.ts": "starts a server",
  // The tests' own global folders: what each test file's process gets from the preloader.
  "apps/server/test/temp-home.test.ts": "runs test files under node --test to show each file's process gets its own temporary NEXUS_HOME, APPDATA and LOCALAPPDATA, removed when it ends",
  // The machine's full-test lock: its processes are what it tests.
  "scripts/test/test-lock.test.ts": "a test run, its starter and its wait for the lock, as the processes they are",
};

/** The text without its comments (line and block), so a file named in a comment is not taken for one it runs. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

/**
 * How a test file starts processes, by what its code names: a fake runtime as a script path (fake-claude.ts or
 * fake-codex.ts in a string, not an import), a server (spawnServer, apps/server/test/helpers.ts; crashAt,
 * apps/server/test/crash-server.ts, one that dies), the CLI as a process (bin/nexus.js in a string), test files in a
 * Node process of their own ("--test" in a string), a Windows job host or its code in a PowerShell (spawnRuntimeChild,
 * new WorkerProcess, or a job host's or the End harness's script in a string: queue LCK), a command's process tree
 * (runSetup or spawnTree, apps/server/src/capacity.ts: queue LKF; or a worktree_setup setting given a command built by the test, not a plain string or null: the engine runs it through runSetup). Empty: it starts none.
 */
export function processStarts(text: string): string[] {
  const c = code(text).replace(/\bfrom\s+(["'])[^"'\n]*\1/g, "").replace(/\bimport\(\s*(["'])[^"'\n]*\1\s*\)/g, "");
  const kinds: string[] = [];
  if (/["'`][^"'`\n]*fake-(?:claude|codex)\.ts["'`]/.test(c)) kinds.push("a fake runtime as a process");
  if (/\bspawnServer\(/.test(c)) kinds.push("a server");
  if (/\bcrashAt\(/.test(c)) kinds.push("a server that dies");
  if (/["'`][^"'`\n]*bin\/nexus\.js["'`]/.test(c)) kinds.push("the CLI as a process");
  if (/["'`]--test["'`]/.test(c)) kinds.push("test files in a Node process of their own");
  if (/\bspawnRuntimeChild\(|\bnew WorkerProcess\(|["'`][^"'`\n]*worker-(?:job|gate|end)\.ps1["'`]/.test(c)) kinds.push("a Windows job host or its code in a PowerShell");
  if (/\b(?:runSetup|spawnTree)\(/.test(c) || /\bworktree_setup:\s*(?:`|(?!null\b|undefined\b)[A-Za-z_][\w.]*)/.test(c)) kinds.push("a command's process tree (on Windows in a job host)");
  return kinds;
}

/**
 * Whether the file runs the fake runtimes in its own process: inProcessRuntime() as the `spawn` option, or
 * inProcessClaude / inProcessCodex as an adapter's spawnChild.
 */
export function usesInProcessRuntime(text: string): boolean {
  return /\binProcessRuntime\(|\binProcess(?:Claude|Codex)\b/.test(code(text));
}

/**
 * What is wrong with the list for these test files (path relative to the repository, with forward slashes, and text):
 * a file that starts processes, is not listed and does not use inProcessRuntime(); a listed file that is not there or
 * starts none. Empty when the list is right.
 */
export function listFindings(files: readonly { path: string; text: string }[], list: Readonly<Record<string, string>> = REAL_PROCESS_TESTS): string[] {
  const findings: string[] = [];
  const byPath = new Map(files.map((f) => [f.path, f.text]));
  for (const f of files) {
    const kinds = processStarts(f.text);
    if (kinds.length && !(f.path in list) && !usesInProcessRuntime(f.text)) {
      findings.push(`${f.path}: starts ${kinds.join(", ")}; list it in scripts/real-process-tests.ts with why, or use inProcessRuntime()`);
    }
  }
  for (const path of Object.keys(list)) {
    const text = byPath.get(path);
    if (text === undefined) findings.push(`${path}: listed, but no such test file`);
    else if (!processStarts(text).length) findings.push(`${path}: listed, but starts no process: take it off the list`);
  }
  return findings;
}
