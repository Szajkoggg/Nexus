import type { QueueView, StepView } from "../api.ts";
import { StatusBadge, StepTimes, TimeAgo, toneOf } from "./ui.tsx";
import { RunChip } from "./Run.tsx";
import { retryLine } from "@nexus/protocol/times";

export function QueueRow({ queue, onQueue, onStep }: {
  queue: QueueView;
  onQueue: () => void;
  onStep: (step: string) => void;
}) {
  const finished = queue.steps.filter((s) => s.status === "done" || s.status === "skipped").length;
  const openQuestions = queue.questions.filter((q) => q.state === "open" || q.state === "escalated").length;
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/60">
      <button onClick={onQueue} className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-4 pt-3 text-left hover:text-white">
        <span className="font-mono text-sm text-zinc-500">{queue.id}</span>
        <span className="font-medium text-zinc-100">{queue.title}</span>
        <StatusBadge status={queue.status} />
        <RunChip queue={queue} />
        {openQuestions > 0 && (
          <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-xs text-amber-300">
            {openQuestions} question{openQuestions > 1 ? "s" : ""}
          </span>
        )}
        <span className="ml-auto flex items-center gap-3 text-xs text-zinc-500">
          {queue.branch && <span className="font-mono">{queue.branch}</span>}
          <span>{finished}/{queue.steps.length} steps</span>
          {queue.updated && <TimeAgo at={queue.updated} />}
        </span>
      </button>
      {queue.status_reason && (queue.status === "stopped" || queue.status === "waiting" || queue.status === "paused") && (
        <p className="line-clamp-1 px-4 pt-1 text-xs text-zinc-500">{queue.status_reason.replace(/\*\*|`/g, "")}</p>
      )}
      <div className="scroll-thin flex gap-2 overflow-x-auto px-4 pb-4 pt-3">
        {queue.steps.map((s, i) => (
          <div key={s.id} className="flex items-center gap-2">
            {i > 0 && <div className="h-px w-3 shrink-0 bg-zinc-700" />}
            <StepCard step={s} current={s.id === queue.current_step} retry={queue.run?.step === s.id ? retryLine(queue.run, new Date()) : undefined} onClick={() => onStep(s.id)} />
          </div>
        ))}
        {queue.steps.length === 0 && <p className="text-sm text-zinc-500">No steps yet.</p>}
      </div>
    </div>
  );
}

function StepCard({ step, current, retry, onClick }: { step: StepView; current: boolean; retry?: string; onClick: () => void }) {
  const t = toneOf(step.status);
  const unread = step.notes.filter((n) => !n.read_at).length;
  const line = step.progress?.text ?? step.summary ?? step.reason ?? step.status_note;
  return (
    <button
      onClick={onClick}
      className={`group flex h-32 w-52 shrink-0 flex-col rounded-lg p-3 text-left ring-1 transition hover:brightness-125 ${t.ring} ${t.bg} ${current ? "ring-2" : ""}`}
    >
      <div className="flex items-center gap-2 text-xs">
        <span className={`h-2 w-2 shrink-0 rounded-full ${t.dot}`} />
        <span className="font-mono text-zinc-400">{step.id}</span>
        <span className={`${t.text}`}>{step.status}</span>
        <span className="ml-auto flex gap-1.5 text-zinc-500">
          {step.review_items.length > 0 && <span title="Review material">▣ {step.review_items.length}</span>}
          {step.notes.length > 0 && <span title={`${step.notes.length} note(s), ${unread} unread`} className={unread ? "text-sky-400" : ""}>✎ {step.notes.length}</span>}
        </span>
      </div>
      <div className="mt-1.5 line-clamp-2 text-sm font-medium leading-snug text-zinc-100">{step.title}</div>
      <div className="mt-auto text-[11px] text-zinc-500"><StepTimes step={step} compact /></div>
      {retry && <div className="line-clamp-1 text-xs text-amber-300" title={retry}>↻ {retry}</div>}
      {line && !retry && <div className="line-clamp-1 text-xs text-zinc-500">{line.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\*\*|`/g, "")}</div>}
      {step.progress?.pct !== undefined && step.status === "running" && (
        <div className="mt-1 h-1 overflow-hidden rounded bg-zinc-800">
          <div className="h-full bg-blue-400" style={{ width: `${step.progress.pct}%` }} />
        </div>
      )}
    </button>
  );
}
