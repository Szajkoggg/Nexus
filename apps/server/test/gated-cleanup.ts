// A shared stand-in for the workers' cleanup barrier (AgentProcess.cleanup, queue LH): the runtimes' fakes as usual,
// with every cleanup counted and passed through a gate a test holds, releases or makes fail. It replaces the one-off
// wrappers (integration-free's slowHosts, worker-processes' held and failing cleanups).
import type { AgentProcess } from "../src/agent.ts";
import type { Launch } from "../src/agent-host.ts";
import { ClaudeSession } from "../src/claude.ts";
import { CodexSession } from "../src/codex.ts";

/** One cleanup asked of a process: whether that process had been sent a turn before, and how it ended (once it has). */
export interface CleanupCall { turned: boolean; outcome?: "done" | "failed" }

export interface GatedCleanup {
  /** Makes the processes (EngineOptions.spawn, AgentHostOptions.spawn). */
  spawn: (launch: Launch) => AgentProcess;
  /** Every cleanup asked so far, in order. */
  calls: CleanupCall[];
  /** How many cleanups wait at the gate now. */
  held(): number;
  /** Closes the gate: cleanups wait until release or fail. */
  hold(): void;
  /** Opens the gate: the waiting cleanups, and later ones, run the runtime's own. */
  release(): void;
  /** The waiting cleanups, and later ones until a release, fail with `message`. */
  fail(message?: string): void;
}

/**
 * `make`: the process itself (by default Claude's or Codex's session, against their fakes); `failBeforeTurn`: a cleanup
 * asked of a process that has run no turn yet fails with this message, whatever the gate (a busy machine, where a new
 * process's Windows job host starts later than the cleanup limit: "worker cleanup timed out", queue CI8). The gate
 * starts open.
 */
export function gatedCleanup(o: { make?: (launch: Launch) => AgentProcess; failBeforeTurn?: string } = {}): GatedCleanup {
  const make = o.make ?? ((launch: Launch) => (launch.runtime === "claude" ? new ClaudeSession(launch.options) : new CodexSession(launch.options)));
  const calls: CleanupCall[] = [];
  let gate: { open: boolean; error?: string } = { open: true };
  let waiters: (() => void)[] = [];
  const wake = () => { const w = waiters; waiters = []; for (const f of w) f(); };
  const pass = async (): Promise<void> => {
    while (!gate.open && gate.error === undefined) await new Promise<void>((r) => waiters.push(r));
    if (gate.error !== undefined) throw new Error(gate.error);
  };
  const spawn = (launch: Launch): AgentProcess => {
    const proc = make(launch);
    const own = proc.cleanup?.bind(proc);
    const send = proc.send.bind(proc);
    let turned = false;
    proc.send = (text, priority) => { turned = true; send(text, priority); };
    proc.cleanup = async () => {
      const call: CleanupCall = { turned };
      calls.push(call);
      try {
        if (!turned && o.failBeforeTurn !== undefined) throw new Error(o.failBeforeTurn);
        await pass();
        await own?.();
        call.outcome = "done";
      } catch (e) { call.outcome = "failed"; throw e; }
    };
    return proc;
  };
  return {
    spawn,
    calls,
    held: () => waiters.length,
    hold() { gate = { open: false }; },
    release() { gate = { open: true }; wake(); },
    fail(message = "injected cleanup failure") { gate = { open: false, error: message }; wake(); },
  };
}
