// A queue on the project page (UX proposals, 17B): its header with one honest status, a progress line with a segment
// per step, and its steps one line each: two columns on the desktop; on the phone one column with the finished run
// and the steps after the third folded. The step that matters is highlighted with its action.
import { useState, type ReactNode } from "react";
import type { QueueView, StepView } from "../api.ts";
import { TimeAgo, reviewLabel, toneOf } from "./ui.tsx";
import { retryLine } from "@nexus/protocol/times";
import { stepValuesText } from "@nexus/protocol/steps";
import { queueStatus, type Tone } from "../queueStatus.ts";
import { currentIndex, foldSteps, twoColumns } from "../steplist.ts";
import { usePhone } from "../phone.ts";
import { STOP_BUTTON, StopActions, stopVersion } from "./Stop.tsx";

/** The honest status's colours: a dot and a word. */
export const TONE: Record<Tone, [string, string]> = {
  running: ["bg-accent animate-pulse", "text-accent"], waiting: ["bg-warn", "text-warn"], review: ["bg-review", "text-review"],
  stopped: ["bg-stop", "text-stop"], failed: ["bg-danger", "text-danger"], approval: ["bg-info", "text-info"],
  paused: ["bg-fg-2", "text-fg-2"], planned: ["bg-fg-3", "text-fg-2"], done: ["bg-ok", "text-ok"], cancelled: ["bg-fg-3", "text-fg-3"],
};

/** A step's segment of the progress line, and the tint of the step that matters, by its status. */
const SEGMENT: Record<string, string> = {
  done: "bg-ok", skipped: "bg-fg-3", running: "bg-accent", waiting: "bg-warn", review: "bg-review", stopped: "bg-stop",
  failed: "bg-danger", rejected: "bg-danger", pending: "bg-surface-3", paused: "bg-fg-2",
};
const TINT: Record<string, string> = {
  running: "bg-accent/10", waiting: "bg-warn/10", review: "bg-review/10", stopped: "bg-stop/10", failed: "bg-danger/10", rejected: "bg-danger/10",
};

/**
 * A step's status as the list shows it: a step whose events say it runs while its queue's run does not (after a
 * restart, a pause) reads "paused", like its queue, not "running".
 */
const shownStatus = (step: StepView, queue: QueueView) =>
  step.status === "running" && !["running", "pausing", "retry_wait", "usage_wait"].includes(queue.run?.state ?? "") ? "paused" : step.status;

const plain = (s: string) => s.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\*\*|`/g, "");

/**
 * The step that matters, highlighted with its action: the one at work, the stop, or the first one not finished, once
 * the queue has started (a queue not yet run has none). A stopped queue's reason and Continue are on its line.
 */
export function stepThatMatters(queue: Pick<QueueView, "steps" | "current_step">): string | undefined {
  const c = currentIndex(queue.steps, queue.current_step);
  const started = queue.steps.some((x) => x.status !== "pending");
  return started && c < queue.steps.length ? queue.steps[c]!.id : undefined;
}

export function QueueRow({ project, queue, pushAccepted, onQueue, onStep, onChanged }: {
  project: string;
  queue: QueueView;
  pushAccepted: boolean;
  onQueue: () => void;
  onStep: (step: string) => void;
  onChanged?: () => void;
}) {
  const phone = usePhone();
  const s = queueStatus(queue);
  const [open, setOpen] = useState<{ before?: boolean; after?: boolean }>({});
  const current = stepThatMatters(queue);
  const line = (x: StepView) => (
    <StepLine key={x.id} step={x} queue={queue} current={x.id === current} phone={phone} onStep={() => onStep(x.id)} onQueue={onQueue}
      stop={{ project, pushAccepted, onChanged }} />
  );
  const fold = phone ? foldSteps(queue.steps, current, open) : undefined;
  const [left, right] = twoColumns(queue.steps);
  return (
    <div className="rounded-xl border border-line bg-surface">
      <button onClick={onQueue} className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-4 pt-3 text-left max-lg:min-h-11">
        <span className="font-mono text-sm text-fg-3">{queue.id}</span>
        <span className="min-w-0 font-medium text-fg max-lg:flex-1">{queue.title}</span>
        <span className="flex flex-wrap items-center gap-x-2 max-lg:order-last max-lg:basis-full">
          <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${TONE[s.tone][1]}`}>
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${TONE[s.tone][0]}`} />{s.label}
          </span>
          {s.questions > 0 && <span className="text-xs text-fg-3">· {s.questions} question{s.questions > 1 ? "s" : ""}</span>}
        </span>
        <span className="flex items-center gap-3 text-xs text-fg-3 lg:ml-auto">
          {queue.branch && !phone && <span className="font-mono">{queue.branch}</span>}
          {s.total > 0 && <span className="whitespace-nowrap">{s.closed} of {s.total}{s.inReview ? ` · ${s.inReview} in review` : ""}</span>}
          {queue.updated && !phone && <TimeAgo at={queue.updated} />}
        </span>
      </button>
      {s.tone === "paused" && !current && (queue.status_reason ?? queue.run?.reason) && <p className="line-clamp-1 px-4 pt-1 text-xs text-fg-3">{plain((queue.status_reason ?? queue.run?.reason)!)}</p>}
      {queue.steps.length > 0 && (
        <div className="mt-2.5 flex gap-[3px] px-4" aria-label={`${s.closed} of ${s.total} steps closed`}>
          {queue.steps.map((x) => <i key={x.id} title={`${x.id}: ${shownStatus(x, queue)}`} className={`h-[5px] flex-1 rounded-full ${SEGMENT[shownStatus(x, queue)] ?? "bg-surface-3"}`} />)}
        </div>
      )}
      <div className="px-2 pb-2 pt-1.5 lg:px-3">
        {queue.steps.length === 0 && <p className="px-2 py-2 text-sm text-fg-3">No steps yet.</p>}
        {fold ? (
          <>
            {fold.before && (
              <button onClick={() => setOpen({ ...open, before: true })} className="flex min-h-11 w-full items-center gap-2 px-2 text-left text-sm">
                <span className="h-2 w-2 shrink-0 rounded-full bg-ok" />
                <span className="font-mono text-ok">{fold.before.from} – {fold.before.to}</span>
                <span className="text-fg-2">
                  {[fold.before.done && `${fold.before.done} done`, fold.before.skipped && `${fold.before.skipped} skipped`].filter(Boolean).join(", ")} ▸
                </span>
              </button>
            )}
            {fold.shown.map(line)}
            {fold.after && (
              <button onClick={() => setOpen({ ...open, after: true })} className="flex min-h-11 w-full items-center px-2 text-left text-sm text-fg-2">
                + {fold.after.join(", ")} ▸
              </button>
            )}
          </>
        ) : (
          <div className="grid grid-cols-2 gap-x-7">
            <div>{left.map(line)}</div>
            <div>{right.map(line)}</div>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * One step, one line: its dot, its id, its title and its status. The step that matters gets two lines more: why it
 * is where it is (the stop's reason, the question, its summary, its progress), and its action. A stop's is Continue
 * right here (Stop.tsx: Keep or Discard first, in place, when the step left commits; "Approve revision N…" opens the
 * queue when its revision is not approved); the others open the step, where the review and the answer are.
 */
function StepLine({ step, queue, current, phone, onStep, onQueue, stop }: {
  step: StepView; queue: QueueView; current: boolean; phone: boolean; onStep: () => void; onQueue: () => void;
  stop: { project: string; pushAccepted: boolean; onChanged?: () => void };
}) {
  const status = shownStatus(step, queue);
  const t = toneOf(status);
  const word = reviewLabel(step) ?? status;
  const unread = step.notes.filter((n) => !n.read_at).length;
  const meta = (
    <span className="flex shrink-0 items-center gap-2 text-xs text-fg-3">
      {step.review_items.length > 0 && <span title="Review material">▣ {step.review_items.length}</span>}
      {unread > 0 && <span className="text-info" title={`${unread} unread note(s)`}>✎ {unread}</span>}
      {stepValuesText(step) && <span className="text-review" title={`Runs on ${stepValuesText(step)}`}>⚙</span>}
    </span>
  );
  if (!current) {
    return (
      <button onClick={onStep} className="grid w-full grid-cols-[10px_3.25rem_1fr_auto] items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm hover:bg-surface-2 max-lg:min-h-11">
        <span className={`h-2 w-2 rounded-full ${t.dot}`} />
        <span className="truncate font-mono text-xs text-fg-3">{step.id}</span>
        <span className={`truncate ${step.status === "skipped" ? "text-fg-2" : "text-fg"}`}>{step.title}</span>
        <span className="flex items-center gap-2">{meta}<span className={`whitespace-nowrap text-xs ${step.status === "done" ? "text-fg-3" : t.text}`}>{word}</span></span>
      </button>
    );
  }
  const questions = queue.questions.filter((q) => q.step === step.id && (q.state === "open" || q.state === "escalated"));
  const stopHere = queue.status === "stopped";
  const retry = queue.run?.step === step.id ? retryLine(queue.run, new Date()) : undefined;
  const why = stopHere ? queue.status_reason
    : questions[0]?.text ?? retry ?? (status === "paused" ? queue.status_reason ?? queue.run?.reason : undefined) ?? (status === "running" ? step.progress?.text : undefined) ?? step.reason ?? step.summary ?? step.status_note;
  const action = stopHere ? undefined
    : step.status === "review" && step.review_with !== "orchestrator" ? { label: "Review…", go: onStep }
    : questions.length ? { label: `${questions.length} question${questions.length > 1 ? "s" : ""}`, go: onStep }
    : step.status === "failed" || step.status === "rejected" ? { label: "Open…", go: onStep }
    : undefined;
  const render = (button: ReactNode, panel?: ReactNode) => (
    <div role="button" tabIndex={0} onClick={onStep} onKeyDown={(e) => { if (e.key === "Enter") onStep(); }}
      className={`grid cursor-pointer grid-cols-[10px_3.25rem_1fr_auto] gap-x-2.5 rounded-lg px-2 py-2 text-sm ${TINT[status] ?? "bg-surface-3"}`}>
      <span className={`mt-1.5 h-2 w-2 rounded-full ${t.dot}`} />
      <span className="truncate pt-px font-mono text-xs leading-5 text-fg-3">{step.id}</span>
      <span className="min-w-0">
        <span className="font-semibold text-fg">{step.title}</span> <span className={`whitespace-nowrap text-xs ${t.text}`}>{word}</span>
        {why && <span className="mt-0.5 line-clamp-2 block text-xs text-fg-2">{plain(why)}</span>}
        {status === "running" && step.progress?.pct !== undefined && (
          <span className="mt-1.5 block h-1 overflow-hidden rounded bg-surface-3"><span className="block h-full bg-accent" style={{ width: `${step.progress.pct}%` }} /></span>
        )}
        {phone && button && <span className="mt-2 flex">{button}</span>}
        {panel && !phone && <span className="mt-2 block">{panel}</span>}
      </span>
      <span className="flex items-start gap-2">{meta}{!phone && button}</span>
      {panel && phone && <span className="col-span-full mt-2 block">{panel}</span>}
    </div>
  );
  if (stopHere) {
    return (
      <StopActions project={stop.project} queue={queue.id} approved={queue.approved} revision={queue.revision} version={stopVersion(queue)}
        onOpen={onQueue} onChanged={stop.onChanged} pushAccepted={stop.pushAccepted} branch={queue.branch}>
        {(a) => render(a.buttons, a.panel)}
      </StopActions>
    );
  }
  return render(action && (
    <button onClick={(e) => { e.stopPropagation(); action.go(); }} className={STOP_BUTTON}>
      {action.label}
    </button>
  ));
}
