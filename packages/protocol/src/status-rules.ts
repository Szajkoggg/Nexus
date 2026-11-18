// The status rules every part reads the same way: when a run is going, when a step waits for the user's review (or the
// orchestrator's), and when a question is open. Pure and free of Node: the dashboard imports this module directly
// (`@nexus/protocol/status-rules`), so it imports nothing at run time but the equally pure ids.ts; the server, the CLI
// and the state derivation use it too, so a rule changes in one place.
import type { RunFile, StepStatus } from "./schemas.ts";
import { compareIds } from "./ids.ts";

type RunState = RunFile["state"];
/** A run, as the state derivation, the server and the dashboard each hold it (the dashboard as plain text). */
type RunLike = { state: RunState | (string & {}); held?: unknown } | null | undefined;

/**
 * Run states in which the run holds its session and its checkout: it goes on by itself (running, pausing, a usage or
 * retry wait) or once the user approves the queue's new revision (approval_wait). Such a queue cannot be started or
 * cancelled, and its session runs no other queue.
 */
const HOLDING_RUN_STATES: readonly RunState[] = ["running", "pausing", "usage_wait", "retry_wait", "approval_wait"];

/**
 * Run states in which the run holds its checkout (the project's own, or its worktree): those holding its session, and
 * paused (it will go on there). No other queue starts, resumes or continues in that checkout meanwhile. A halted or
 * finished run holds none.
 */
const CHECKOUT_RUN_STATES: readonly RunState[] = [...HOLDING_RUN_STATES, "paused"];

/** Run states that count toward the limit on queues running at once (a queue waiting for a review or an answer does not). */
const COUNTED_RUN_STATES: readonly RunState[] = ["running", "pausing"];

/** The run's states that mean it is not going (it may be resumed later). */
const ENDED_RUN_STATES: readonly RunState[] = ["finished", "halted", "paused"];

/** The run is going: it holds its session and its checkout (HOLDING_RUN_STATES). */
export const runGoing = (run: RunLike): boolean => !!run && HOLDING_RUN_STATES.includes(run.state as RunState);
/** The run holds its checkout: going, or paused there (CHECKOUT_RUN_STATES). */
export const runHoldsCheckout = (run: RunLike): boolean => !!run && CHECKOUT_RUN_STATES.includes(run.state as RunState);
/**
 * The run is at work now and counts toward the limit on queues running at once (COUNTED_RUN_STATES): not one held at
 * the limit (`held`), which waits for a place.
 */
export const runCounted = (run: RunLike): boolean => !!run && COUNTED_RUN_STATES.includes(run.state as RunState) && !run.held;
/** The run is not going: finished, halted or paused (ENDED_RUN_STATES). */
export const runEnded = (run: RunLike): boolean => !!run && ENDED_RUN_STATES.includes(run.state as RunState);

/** A step (its status one of StepStatus), as each part holds it; the dashboard's helpers hold the status as plain text. */
type StepLike = { status: StepStatus | (string & {}); review_with?: string };

/** The step waits for the user's review (Accept, Send back). */
export const waitsForUserReview = (s: StepLike): boolean => s.status === "review" && s.review_with !== "orchestrator";
/** The step's review is the orchestrator's (review levels 2 and 3). */
export const reviewedByOrchestrator = (s: StepLike): boolean => s.status === "review" && s.review_with === "orchestrator";
/**
 * The step is at work: running, waiting for an answer within its turn, or its checks running in its checkout (Nexus
 * runs them after its done: a merge back into that checkout waits for them too).
 */
export const stepAtWork = (s: Pick<StepLike, "status">): boolean => s.status === "running" || s.status === "waiting" || s.status === "checking";
/** The step holds its queue in `waiting`: a question or a review is open on it. */
export const stepWaits = (s: Pick<StepLike, "status">): boolean => s.status === "waiting" || s.status === "review";

/** The question waits for an answer: asked, or passed on to the user by the orchestrator. */
export const isOpenQuestion = (q: { state: "open" | "answered" | "escalated" | "withdrawn" | (string & {}) }): boolean => q.state === "open" || q.state === "escalated";

/** An open question holds a run at `step`: one of that step or of no step; any open one while the run names no step. */
export const holdsRunStep = (x: { state: string; step?: string }, step: string | undefined): boolean =>
  isOpenQuestion(x) && (!step || !x.step || x.step === step);

/**
 * What holds a step's next work turn: its questions still open or escalated (`remaining`), and a last answer that asked
 * to wait (`wait`) that no explicit Resume released yet (`resumed`: the answer the run's Resume released; `last`: the
 * latest answer's id). The step owns the barrier, even when its questions were asked by an earlier session.
 */
export function questionBarrier(questions: readonly {
  queue?: string; step?: string; state: string;
  answers: readonly { id: string; at: string; escalate?: boolean; continue?: boolean }[];
}[], queue: string, step: string | undefined, resumed?: string) {
  const own = step ? questions.filter(q => q.queue === queue && q.step === step) : [];
  const remaining = own.filter(isOpenQuestion).length;
  const last = own.flatMap(q => q.answers).filter(a => !a.escalate)
    .sort((a, b) => a.at.localeCompare(b.at) || compareIds(a.id, b.id)).at(-1);
  const wait = last?.continue === false && last.id !== resumed;
  return { remaining, wait, blocked: remaining > 0 || wait, last: last?.id };
}

/**
 * The step is at work now: the derivation says `running` and its queue's run is going (queue EF). A run the user
 * stopped (paused, "stopped by the user") leaves its step `running` in the derivation, as the step it goes on with at
 * Continue (the dashboard reads such a queue as paused); no agent works on it, so it is no step at work: not in the
 * server's running steps, nothing an update waits for, no queue running in the projects' list.
 */
export const stepWorkedOn = (run: RunLike, step: { status: StepStatus | (string & {}) }): boolean => step.status === "running" && runGoing(run);

/** The queue is at work now: `running` in the derivation and its run going (see stepWorkedOn). */
export const queueWorkedOn = (q: { status: string; run?: RunLike }): boolean => q.status === "running" && runGoing(q.run);

/** The steps at work in a project's state (stepWorkedOn), each with its queue: what `nexus server status` lists. */
export function stepsWorkedOn<Q extends { run?: RunLike; steps: readonly { status: StepStatus | (string & {}) }[] }>(queues: readonly Q[]): { queue: Q; step: Q["steps"][number] }[] {
  return queues.flatMap((queue) => queue.steps.filter((step) => stepWorkedOn(queue.run, step)).map((step) => ({ queue, step })));
}
