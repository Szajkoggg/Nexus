// The waits of the tests that run fake runtimes, servers or git (decided 2026-11-14, queue TS; DESIGN.md, "The tests'
// waits"). A test waits for something the code under test does by itself (a run to finish, a reply, a server to
// answer): short, so that a change that breaks many tests fails the suite in minutes rather than hours of 20-30 s
// timeouts, and polled often, so that a passing test does not idle.
//
// - WAIT_MS: how long a wait lasts before it fails; NEXUS_TEST_WAIT_MS sets it (default 10000), e.g. higher on a slow
//   machine. Every wait is it, or one of the named longer waits below, which are multiples of it.
// - POLL_MS: how often a condition is looked at.

import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

/**
 * How long a test waits for a condition before it fails (NEXUS_TEST_WAIT_MS, default 10000). Decided as 10 s (queue
 * TS1): at 5 s, an agent's turn or a worker's step sometimes took 5 to 7 s in a full run on the user's machine, which
 * runs other applications beside it; a different test failed in nearly every run.
 */
export const WAIT_MS = ((v) => (Number.isFinite(v) && v > 0 ? v : 10_000))(Number(process.env.NEXUS_TEST_WAIT_MS ?? 10_000));

/** How often a waiting test looks at its condition. */
export const POLL_MS = 25;

/**
 * The waits that are longer for a known reason, each named for it (and scaled with WAIT_MS). Everything else waits
 * WAIT_MS.
 */
export const LONGER = {
  /**
   * One step of a worker's, or one agent's turn after another's (the orchestrator sends a step back, then the worker
   * takes round 2): each turn starts or wakes a fake process and calls the nexus CLI. In the full suite such waits took
   * 2.5 to 3.5 s, and over 5 s in a slower run (queue TS1).
   */
  step: WAIT_MS * 2,
  /**
   * A whole run (or chain of runs) to its end: every step starts the fake worker or a turn of it and calls the nexus
   * CLI a few times, each a node process. Alone a two-step run takes about 2 s; in the full suite, whose files run side
   * by side on every core, such waits took 4 to 8 s (measured with NEXUS_TEST_WAIT_LOG, queue TS1).
   */
  run: WAIT_MS * 3,
  /**
   * Work that starts many processes in a row and waits on them: a server's start (main.ts), an update's hand-over to a
   * successor process and its rollback (git, npm stand-ins), a run that commits in a worktree. In the full suite the
   * longest such wait took 12 s (a rollback); on a busy machine more (queue FU4 measured 14 s a step under load).
   */
  processes: WAIT_MS * 6,
} as const;

/**
 * How long a fake step works ("FAKE: slow", FAKE_SLOW_MS) when the test acts while it runs (sends a message, revises
 * the queue, pauses or drains): long enough that a late look on a busy machine still finds it at work, where 300 ms
 * to 2.5 s were sometimes over before the test could act (queue TS1).
 */
export const WORK_MS = String(WAIT_MS / 2);

/**
 * Holds the fake runtimes' "slow" steps at work until `release()` (FAKE_RELEASE, read by fake-behaviour.ts): for a
 * test that acts while a step works (sends a message, pauses, drains, revises) and then lets it end. Faster than a
 * fixed WORK_MS, and a late look still finds the step at work (queue TS2). Call before the step's process starts;
 * `done()` clears it for the next test.
 */
export function holdWork(): { release: () => void; done: () => void } {
  const file = join(mkdtempSync(join(tmpdir(), "nexus-hold-")), "release");
  process.env.FAKE_RELEASE = file;
  return { release: () => writeFileSync(file, ""), done: () => { delete process.env.FAKE_RELEASE; } };
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Waits until `pred` holds, looking every POLL_MS; after `ms` (WAIT_MS) it fails with "timed out waiting for <what>"
 * and what `detail` adds (start it with "; ").
 */
export async function until(what: string, pred: () => boolean, ms: number = WAIT_MS, detail: () => string = () => ""): Promise<void> {
  const start = performance.now();
  while (!pred()) {
    if (performance.now() - start > ms) assert.fail(`timed out waiting for ${what} (${Math.round(ms)} ms)${detail()}`);
    await sleep(POLL_MS);
  }
  logLong(what, performance.now() - start);
}

/**
 * NEXUS_TEST_WAIT_LOG names a file where every wait over 2 s is written (its time, test file and what it waited for):
 * how the waits' lengths were measured (queue TS).
 */
function logLong(what: string, ms: number): void {
  const file = process.env.NEXUS_TEST_WAIT_LOG;
  if (file && ms > 2000) appendFileSync(file, [Math.round(ms), basename(process.argv[1] ?? "?"), what].join("\t") + "\n");
}

/** As until, for a condition that is asked asynchronously (an HTTP request); a rejection counts as not yet. */
export async function untilAsync(what: string, pred: () => Promise<boolean>, ms: number = WAIT_MS, detail: () => string = () => ""): Promise<void> {
  const start = performance.now();
  while (!(await pred().catch(() => false))) {
    if (performance.now() - start > ms) assert.fail(`timed out waiting for ${what} (${Math.round(ms)} ms)${detail()}`);
    await sleep(POLL_MS);
  }
  logLong(what, performance.now() - start);
}

/** Waits for a server started by the test to answer `url` (a GET that is ok): a named longer wait (LONGER.processes). */
export function serverUp(url: string): Promise<void> {
  return untilAsync(`the server at ${url}`, async () => (await fetch(url)).ok, LONGER.processes);
}
