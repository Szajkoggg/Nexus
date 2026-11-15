// What the step and queue panels (components/details/) decide before they draw anything, as pure helpers (unit tested
// in test/details.test.ts): which parts a step shows and in which form, how a question's answer reads, how a timeline
// event reads, and what a queue's approval history and worktree say.
import type { Event, QueueView, StepView } from "@nexus/protocol";
import { isOpenQuestion, reviewedByOrchestrator, stepAtWork } from "@nexus/protocol/status-rules";
import { formatSeconds, t, type Key } from "./i18n.ts";
import { comparisonOf, pairPictures, showsReviewActions } from "./review.ts";

// ---------------------------------------------------------------- the step

type ReviewItem = StepView["review_items"][number];

/** A review item shown as a picture (in the viewer); any other opens as a link. */
export const isImage = (r: ReviewItem): boolean => !!r.path && /\.(png|jpe?g|gif|webp|svg)$/i.test(r.path);

/**
 * A finished or cancelled queue: its panel lists its steps, and they open read-only (nothing more happens in it: no
 * level, note, message, review or answer; a provisional acceptance still waits for the user's confirmation).
 */
export const queueOver = (q: Pick<QueueView, "status">): boolean => q.status === "done" || q.status === "cancelled";

/** What a step's panel shows, from the step, its queue's questions and the window. */
export interface StepLayout {
  /** Its queue is over (queueOver): the step is only read. */
  readOnly: boolean;
  /** At work: its session can be messaged. */
  live: boolean;
  /** A note goes to the orchestrator, which holds the step in review, not to the worker. */
  forOrchestrator: boolean;
  /** Notes may still be added. */
  notesOpen: boolean;
  /** The orchestrator's reason for handing the review over; none when the user took it by setting the level to 1. */
  orchestratorAsks: string | undefined;
  /** The step waits for the user's review: Accept in the action bar, the summary and the pictures first. */
  reviewing: boolean;
  /** The open question the action bar answers (the first; the others keep their box in their card). */
  asking: QueueView["questions"][number] | undefined;
  /** On the phone a step with an open question is the question's sheet. */
  questionFirst: boolean;
}

export function stepLayout(step: StepView, questions: QueueView["questions"], phone: boolean, queue?: Pick<QueueView, "status">): StepLayout {
  const readOnly = !!queue && queueOver(queue);
  const forOrchestrator = reviewedByOrchestrator(step);
  const reviewing = !readOnly && showsReviewActions(step);
  const asking = reviewing || readOnly ? undefined : questions.find(isOpenQuestion);
  return {
    readOnly,
    live: !readOnly && stepAtWork(step) && !!step.session,
    forOrchestrator,
    notesOpen: !readOnly && (step.status === "pending" || step.status === "stopped" || forOrchestrator),
    orchestratorAsks: step.asked_user?.by !== "user" ? step.asked_user?.text : undefined,
    reviewing,
    asking,
    questionFirst: phone && !!asking,
  };
}

/** A picture as the viewer shows it: its file, its label and what it is compared with. */
interface ViewerPicture {
  src: string; label: string; round?: number; key?: string; comparison: ReturnType<typeof comparisonOf>;
  before?: { src: string; label: string };
  accepted: boolean; comments: number;
}

const fileName = (p: string) => p.split(/[\\/]/).at(-1)!;

/**
 * The step's pictures, each with what it is compared with: by its view key and role, else (older material) an
 * explicit --before or the same label in an earlier round. `url` makes a file's address.
 */
export function stepPictures(step: Pick<StepView, "review_items" | "pictures">, url: (path: string) => string) {
  const pairs = pairPictures(step.review_items.filter(isImage));
  const images: ViewerPicture[] = pairs.map((pair) => {
    const { item: r, before, beforeLabel, other } = pair;
    return {
      src: url(r.path!), label: r.label ?? fileName(r.path!), round: r.round, key: r.key, comparison: comparisonOf(pair),
      // A keyed counterpart by its label; an explicit before by its file name; one paired by label by its round.
      before: before ? { src: url(before), label: other?.key ? other.label ?? fileName(before) : beforeLabel === t("review.role.before") ? fileName(before) : beforeLabel ?? t("review.role.before") } : undefined,
      accepted: !!step.pictures[r.path!]?.accepted, comments: step.pictures[r.path!]?.comments.length ?? 0,
    };
  });
  return { pairs, images };
}

/** The picture the viewer layer names ("viewer:<n>"), kept within the pictures; undefined while the viewer is closed. */
export function shownPicture(layer: string | undefined, count: number): number | undefined {
  return layer === undefined ? undefined : Math.min(Math.max(0, Number(layer) || 0), count - 1);
}

// ---------------------------------------------------------------- questions

/** Between an option and the user's words in one answer. */
const PARAGRAPH = String.fromCharCode(10, 10);

/** A question sheet's answer: the chosen option, then the user's words; undefined when there is neither. */
export function answerText(choice: string | undefined, words: string): string | undefined {
  return [choice, words].filter(Boolean).join(PARAGRAPH) || undefined;
}

const QUESTION_STATES: Record<string, Key> = { open: "details.question.stateOpen", answered: "details.question.stateAnswered", withdrawn: "details.question.stateWithdrawn" };
/** A question's state as a word; one the dashboard does not know, as it is. */
export const questionState = (state: string) => (QUESTION_STATES[state] ? t(QUESTION_STATES[state]) : state);

// ---------------------------------------------------------------- the timeline

/** What a timeline line says after the event's type; empty for an event that has nothing to say there. */
export function describe(e: Event): string {
  switch (e.type) {
    case "step.progress": return e.text + (e.pct !== undefined ? ` (${e.pct}%)` : "");
    case "step.interrupted": return e.text;
    case "step.done": return e.summary;
    case "step.failed": return e.reason;
    case "queue.stop": return `${e.condition}: ${e.reason}`;
    case "check.result": return `${e.ok ? "✓" : "✗"} ${e.name}${e.duration !== undefined ? ` (${formatSeconds(e.duration)})` : ""}${e.summary ? ` — ${e.summary}` : ""}`;
    case "review.added": return e.items.map((i) => i.label ?? i.path ?? i.url).join(", ");
    case "question.asked": return e.text;
    case "answer.given": return e.text;
    case "context.summary": return e.text.slice(0, 200);
    case "review.accepted": return e.text ?? "";
    case "review.sent_back": return e.text;
    case "review.asked_user": return e.text;
    case "review.rejected": return e.text ?? "";
    case "review.provisional": return e.text ?? "";
    case "review.fix_asked": return e.text;
    // Events this line shows no text for.
    case "change.proposed":
    case "log":
    case "message.read":
    // A step's metrics are shown by the statistics' views (queue ST3).
    case "metric.defined":
    case "metric.recorded":
    // Recurring queues are shown in their own part of the Queues view (queue TQ4).
    case "recurring.set":
    case "note.read":
    case "plan.proposed":
    case "question.withdrawn":
    case "queue.drafted":
    case "queue.report":
    case "review.commented":
    case "review.confirmed":
    case "review.marked":
    case "session.request":
    case "status.set":
    case "step.started":
    case "tags.proposed":
    default: return "";
  }
}

// ---------------------------------------------------------------- the queue

/** The queue's approvals and withdrawals, oldest first. */
export function approvalHistory(queue: Pick<QueueView, "approvals" | "withdrawals">) {
  return [...queue.approvals.map((a) => ({ ...a, withdrawn: false as const })), ...queue.withdrawals.map((w) => ({ ...w, withdrawn: true as const }))]
    .sort((x, y) => x.at.localeCompare(y.at));
}

/** Where the queue's approval stands, as the header's word: approved, withdrawn, an older revision's, or none. */
export function approvalWord(queue: Pick<QueueView, "approved" | "approvals" | "withdrawals">): Key {
  if (queue.approved) return "details.approval.approved";
  const last = queue.withdrawals.at(-1);
  if (last && last.approvals >= queue.approvals.length) return "details.approval.withdrawn";
  return queue.approvals.length ? "details.approval.older" : "details.approval.none";
}

/** An approved queue that never ran may take its approval back (a started one is paused or stopped instead). */
export const canWithdrawApproval = (queue: Pick<QueueView, "approved" | "run" | "steps">): boolean =>
  queue.approved && !queue.run && queue.steps.every((s) => s.status === "pending" && s.segments.length === 0);

const normPath = (p: string) => p.replaceAll("\\", "/").toLowerCase();

/**
 * A queue's own worktree, finished or merged or cleaned up: the merge back and the cleanup it offers. Not for a queue in
 * the project's checkout, an `auto` worktree not made yet, or one still running.
 */
export function showsWorktreeActions(queue: Pick<QueueView, "worktree" | "status" | "git">, root: string): boolean {
  if (!queue.worktree || queue.worktree === "auto" || normPath(queue.worktree) === normPath(root)) return false;
  return queue.status === "done" || !!queue.git?.merged || !!queue.git?.cleaned;
}

/** How the merge back of an integration step stands: merged (since the step finished), waiting, and runs again. */
export function integrationState(queue: Pick<QueueView, "git">, step: Pick<StepView, "finished_at">) {
  const g = queue.git;
  const merged = g?.merged && (!step.finished_at || g.merged.at >= step.finished_at) ? g.merged : undefined;
  return { base: g?.base?.ref ?? "main", merged, waiting: g?.merge?.waiting, again: g?.merge?.reintegrations ?? 0 };
}
