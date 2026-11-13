import type { QueueView, StepView } from "../api.ts";
import { StatusBadge, StepTimes, TimeAgo, reviewLabel, toneOf } from "./ui.tsx";
import { RunChip } from "./Run.tsx";
import { retryLine } from "@nexus/protocol/times";
import { stopPlace } from "@nexus/protocol/attention";
import { StopWays } from "./Attention.tsx";
import { stepValuesText } from "@nexus/protocol/steps";

export function QueueRow({ queue, onQueue, onStep }: {
  queue: QueueView;
  onQueue: () => void;
  onStep: (step: string) => void;
}) {
  const finished = queue.steps.filter((s) => s.status === "done" || s.status === "skipped").length;
  const openQuestions = queue.questions.filter((q) => q.state === "open" || q.state === "escalated").length;
  return (
    <div className="rounded-xl border border-line bg-surface">
      <button onClick={onQueue} className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-4 pt-3 text-left hover:text-fg">
        <span className="font-mono text-sm text-fg-3">{queue.id}</span>
        <span className="font-medium text-fg">{queue.title}</span>
        <StatusBadge status={queue.status} />
        <RunChip queue={queue} />
        {openQuestions > 0 && (
          <span className="rounded-full bg-warn/15 px-2 py-0.5 text-xs text-warn">
            {openQuestions} question{openQuestions > 1 ? "s" : ""}
          </span>
        )}
        <span className="ml-auto flex items-center gap-3 text-xs text-fg-3">
          {queue.branch && <span className="font-mono">{queue.branch}</span>}
          <span>{finished}/{queue.steps.length} steps</span>
          {queue.updated && <TimeAgo at={queue.updated} />}
        </span>
      </button>
      {queue.status === "stopped" ? (
        // The way out of the stop; a tap opens the queue, whose stop box has Continue.
        <button onClick={onQueue} className="block w-full px-4 pt-1 text-left">
          <span className="line-clamp-1 text-xs text-fg-3">
            Stopped{stopPlace(queue)}{queue.status_reason ? `: ${queue.status_reason.replace(/\*\*|`/g, "")}` : ""}
          </span>
          <StopWays lift={{ place: stopPlace(queue), continue: queue.approved, revision: queue.revision, proposal: queue.lift_proposal }} className="mt-1" />
        </button>
      ) : queue.status_reason && (queue.status === "waiting" || queue.status === "paused") && (
        <p className="line-clamp-1 px-4 pt-1 text-xs text-fg-3">{queue.status_reason.replace(/\*\*|`/g, "")}</p>
      )}
      <div className="scroll-thin flex gap-2 overflow-x-auto px-4 pb-4 pt-3">
        {queue.steps.map((s, i) => (
          <div key={s.id} className="flex items-center gap-2">
            {i > 0 && <div className="h-px w-3 shrink-0 bg-line-strong" />}
            <StepCard step={s} current={s.id === queue.current_step} retry={queue.run?.step === s.id ? retryLine(queue.run, new Date()) : undefined} onClick={() => onStep(s.id)} />
          </div>
        ))}
        {queue.steps.length === 0 && <p className="text-sm text-fg-3">No steps yet.</p>}
      </div>
    </div>
  );
}

/** A step's own runtime, model and effort, compact; nothing for a step that runs on the run's. */
export function StepValues({ step, className = "" }: { step: StepView; className?: string }) {
  const text = stepValuesText(step);
  if (!text) return null;
  return (
    <span className={`block truncate text-[11px] text-review ${className}`} title={`This step runs on ${text}; what it leaves out is the run's`}>
      ⚙ {text}
    </span>
  );
}

function StepCard({ step, current, retry, onClick }: { step: StepView; current: boolean; retry?: string; onClick: () => void }) {
  const t = toneOf(step.status);
  const unread = step.notes.filter((n) => !n.read_at).length;
  const line = step.progress?.text ?? step.summary ?? step.reason ?? step.status_note;
  return (
    <button
      onClick={onClick}
      className={`group flex h-32 w-52 shrink-0 flex-col rounded-lg border p-3 text-left transition hover:border-fg-3/60 ${current ? "border-line-strong bg-surface-3" : "border-line bg-surface-2"}`}
    >
      <div className="flex items-center gap-2 text-xs">
        <span className={`h-2 w-2 shrink-0 rounded-full ${t.dot}`} />
        <span className="font-mono text-fg-2">{step.id}</span>
        <span className={`${t.text}`}>{reviewLabel(step) ?? step.status}</span>
        <span className="ml-auto flex gap-1.5 text-fg-3">
          {step.review_items.length > 0 && <span title="Review material">▣ {step.review_items.length}</span>}
          {step.notes.length > 0 && <span title={`${step.notes.length} note(s), ${unread} unread`} className={unread ? "text-info" : ""}>✎ {step.notes.length}</span>}
        </span>
      </div>
      <div className="mt-1.5 line-clamp-2 text-sm font-medium leading-snug text-fg">{step.title}</div>
      <StepValues step={step} className="mt-1" />
      <div className="mt-auto text-[11px] text-fg-3"><StepTimes step={step} compact /></div>
      {retry && <div className="line-clamp-1 text-xs text-warn" title={retry}>↻ {retry}</div>}
      {line && !retry && <div className="line-clamp-1 text-xs text-fg-3">{line.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\*\*|`/g, "")}</div>}
      {step.progress?.pct !== undefined && step.status === "running" && (
        <div className="mt-1 h-1 overflow-hidden rounded bg-surface-3">
          <div className="h-full bg-accent" style={{ width: `${step.progress.pct}%` }} />
        </div>
      )}
    </button>
  );
}
