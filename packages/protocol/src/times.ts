// When steps and runs started and ended, how long they took, and how that reads. Pure and free of Node: the dashboard
// imports this module directly (`@nexus/protocol/times`), so it must import nothing at run time.

/** A stretch in which a step was at work: from a step.started to its outcome, a stop, or the run ending. */
export interface Segment { start: string; end?: string }

export interface StepTimes {
  /** The first step.started. */
  started?: string;
  /** When its last stretch ended; absent while it is at work. */
  ended?: string;
  /** At work now: the elapsed time grows. */
  running: boolean;
  /** From the first start to the end (or to now while at work). */
  duration_ms?: number;
  /** The sum of its stretches at work; differs from the duration only when it was started more than once. */
  working_ms?: number;
  /** How many times it was started. */
  segments: number;
}

const ms = (iso: string) => Date.parse(iso);

export function stepTimes(segments: readonly Segment[], now: number): StepTimes {
  const first = segments[0];
  if (!first) return { running: false, segments: 0 };
  const last = segments[segments.length - 1]!;
  const running = last.end === undefined;
  const end = running ? now : ms(last.end!);
  const working = segments.reduce((sum, s) => sum + Math.max(0, (s.end === undefined ? now : ms(s.end)) - ms(s.start)), 0);
  return {
    started: first.start, ended: running ? undefined : last.end, running,
    duration_ms: Math.max(0, end - ms(first.start)), working_ms: working, segments: segments.length,
  };
}

/**
 * Run states in which the run holds its session and its checkout: it goes on by itself (running, pausing, a usage or
 * retry wait) or once the user approves the queue's new revision (approval_wait). Such a queue cannot be started or
 * cancelled, and its session runs no other queue.
 */
export const HOLDING_RUN_STATES: readonly string[] = ["running", "pausing", "usage_wait", "retry_wait", "approval_wait"];

/**
 * Run states in which the run holds its checkout (the project's own, or its worktree): those holding its session, and
 * paused (it will go on there). No other queue starts, resumes or continues in that checkout meanwhile. A halted or
 * finished run holds none.
 */
export const CHECKOUT_RUN_STATES: readonly string[] = [...HOLDING_RUN_STATES, "paused"];

/** Run states that count toward the limit on queues running at once (a queue waiting for a review or an answer does not). */
export const COUNTED_RUN_STATES: readonly string[] = ["running", "pausing"];

/** The run's states that mean it is not going (it may be resumed later). */
export const ENDED_RUN_STATES: ReadonlySet<string> = new Set(["finished", "halted", "paused"]);

export interface RunTimes { started: string; ended?: string; running: boolean; total_ms: number }

/** A run's span: from its start to when it finished, halted or was stopped (or to now while it goes). */
export function runTimes(run: { state: string; started_at: string; ended_at?: string; updated_at: string }, now: number): RunTimes {
  const ended = ENDED_RUN_STATES.has(run.state) ? (run.ended_at ?? run.updated_at) : undefined;
  return { started: run.started_at, ended, running: !ended, total_ms: Math.max(0, (ended ? ms(ended) : now) - ms(run.started_at)) };
}

/** "<1 min", "12 min", "1 h 12 min", "3 h", "2 d 5 h". Minutes are rounded down, so a running clock never jumps ahead. */
export function formatDuration(duration: number): string {
  const min = Math.floor(duration / 60_000);
  if (min < 1) return "<1 min";
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60), m = min % 60;
  if (h < 24) return m ? `${h} h ${m} min` : `${h} h`;
  const d = Math.floor(h / 24), rh = h % 24;
  return rh ? `${d} d ${rh} h` : `${d} d`;
}

/** A check's time in seconds: "0.4 s", "12 s", "3 min 10 s" (whole seconds from 10 s up, rounded). */
export function formatSeconds(seconds: number): string {
  if (seconds < 10) return `${Math.round(seconds * 10) / 10} s`;
  const whole = Math.round(seconds);
  if (whole < 60) return `${whole} s`;
  const m = Math.floor(whole / 60), s = whole % 60;
  return s ? `${m} min ${s} s` : `${m} min`;
}

/** A turn that failed for a passing reason is tried again at most this many times in a row (the engine's limit). */
export const RETRY_LIMIT = 5;

/** Short words for the runtimes' failure codes (Claude Code's and Codex's), as the dashboard shows them. */
export function failureLabel(code: string | undefined): string {
  if (!code) return "a passing failure";
  if (/overloaded/i.test(code)) return "overloaded";
  if (code === "processExited") return "the runtime's process exited";
  if (code === "edge_block_403") return "blocked by Cloudflare (403)";
  if (/connection|disconnected|stream|failedattempts/i.test(code)) return "network";
  if (/rate_?limit|usagelimit/i.test(code)) return "rate limited";
  if (/server_?error|internalservererror/i.test(code)) return "server error";
  return code;
}

/** "retry 2 of 5 at 14:05, overloaded" for a run waiting to retry a turn; undefined otherwise. */
export function retryLine(run: { state: string; retries?: number; resume_at?: string; failure?: string }, now: Date): string | undefined {
  if (run.state !== "retry_wait") return undefined;
  const at = run.resume_at ? ` at ${formatClock(run.resume_at, now)}` : "";
  return `retry ${run.retries ?? 1} of ${RETRY_LIMIT}${at}, ${failureLabel(run.failure)}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const two = (n: number) => String(n).padStart(2, "0");

/** A local time: "14:02" today, "11 Nov 14:02" on another day this year, "11 Nov 2025 14:02" in another year. */
export function formatClock(iso: string, now: Date): string {
  const t = new Date(iso);
  const clock = `${two(t.getHours())}:${two(t.getMinutes())}`;
  if (t.getFullYear() === now.getFullYear() && t.getMonth() === now.getMonth() && t.getDate() === now.getDate()) return clock;
  const day = `${t.getDate()} ${MONTHS[t.getMonth()]}`;
  return t.getFullYear() === now.getFullYear() ? `${day} ${clock}` : `${day} ${t.getFullYear()} ${clock}`;
}
