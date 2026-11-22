// Closed queues in the state the dashboard reads (queue AQ; docs/design/archive.md): a queue that is done or cancelled
// and waits for nothing goes out with its summary only (what the list, the plan, the refs and the rail show); its
// details (the steps' timelines, messages, checks, texts) are read when it is opened (GET …/queues/:queue). The model
// keeps the whole state: the decisions, the statistics and the opened queue read it as before.
import { isOpenQuestion } from "./status-rules.ts";
import { pendingProvisional, type AttentionItem, type ProjectState, type QueueView, type StepView } from "./state.ts";

const CLOSED: ReadonlySet<string> = new Set(["done", "cancelled"]);

/**
 * A queue whose details stay out of the dashboard's state: done or cancelled, and nothing in it waits for the user (no
 * step in review or with a provisional acceptance to confirm, no open question, no attention item). The same queues
 * the project page folds into "Finished" (apps/web/src/finished.ts), so the list shows each from its summary alone.
 */
export function isArchived(q: QueueView, attention: readonly AttentionItem[]): boolean {
  return CLOSED.has(q.status)
    && !q.steps.some((s) => s.status === "review" || pendingProvisional(s))
    && !q.questions.some(isOpenQuestion)
    && !attention.some((a) => a.queue === q.id);
}

/** A closed step's summary: its list fields; its details empty (timeline, messages, checks, metrics, texts). */
function stepSummary(s: StepView): StepView {
  const { summary: _s, reason: _r, progress: _p, ...rest } = s;
  return {
    ...rest, goal: "", acceptance: [], timeline: [], messages: [], checks: [], metrics: [], review_items: [], notes: [],
    sent_back: [], pictures: {},
  };
}

/** A closed queue's summary (`archived`): its steps' summaries, without its description, stop conditions and report. */
function queueSummary(q: QueueView): QueueView {
  const { report: _r, description: _d, ...rest } = q;
  return { ...rest, stop_conditions: [], steps: q.steps.map(stepSummary), archived: true };
}

const shown = new WeakMap<ProjectState, ProjectState>();

/**
 * The state as the dashboard reads it (the full read and the live stream's deltas): each archived queue as its
 * summary, every other part as the model's. The same object for the same state (the stream compares by identity).
 */
export function shownState(s: ProjectState): ProjectState {
  let out = shown.get(s);
  if (!out) {
    out = { ...s, queues: s.queues.map((q) => (isArchived(q, s.attention) ? queueSummary(q) : q)) };
    shown.set(s, out);
  }
  return out;
}
