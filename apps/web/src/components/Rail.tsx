// The right rail of a desktop (UX proposals, 11A): what waits for the user in every project, what is at work in the
// project and what finished in it today, each queue with its honest status; "All queues of <project>" at its foot.
// From 1280 px it stands beside the chat, and a queue or step opens over it, so the chat never moves; between 1024
// and 1280 px it folds into the "Waiting N" button in the chat's header and opens as a drawer (App decides).
import type { ReactNode } from "react";
import type { WaitingItem } from "@nexus/protocol/attention";
import type { ProjectState, ProjectSummary } from "../api.ts";
import { atWork, finishedToday, shortStatus } from "../rail.ts";
import { WaitingCards } from "./Attention.tsx";
import { TONE } from "./QueueRow.tsx";
import { Clock, CloseButton } from "./ui.tsx";
import { nav } from "../nav.ts";
import { t } from "../i18n.ts";

/** The rail's width; a queue or step opened beside the chat takes the same place. */
export const RAIL = "23.25rem";

const Label = ({ children, tone = "text-fg-3" }: { children: ReactNode; tone?: string }) =>
  <h2 className={`text-[11px] font-semibold uppercase tracking-wider ${tone}`}>{children}</h2>;

export function Rail({ projects, state, queuesShown, onOpenWaiting, onClose, digest }: {
  projects: ProjectSummary[]; state: ProjectState | undefined;
  /** The project's queues show in the middle: "All queues" is pressed. */
  queuesShown: boolean;
  onOpenWaiting: (w: WaitingItem) => void;
  /** As a drawer (below 1280 px): its ✕. */
  onClose?: () => void;
  /** The morning digest, at the rail's top when there is something new. */
  digest?: ReactNode;
}) {
  const project = state?.project;
  const waiting = projects.reduce((n, p) => n + p.attention.length, 0);
  const work = state ? atWork(state.queues) : [];
  const done = state ? finishedToday(state.queues, new Set(state.attention.map((a) => a.queue).filter((x): x is string => !!x))) : [];
  const open = (queue: string) => project && nav.item(project.id, queue);
  return (
    <div className="flex h-full min-h-0 flex-col" aria-label={t("rail.label")}>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-3 pb-4">
        {digest && <div className="pt-3 empty:hidden">{digest}</div>}
        <div className="flex items-center gap-2 px-1 pb-2.5 pt-4">
          <Label tone="text-warn">{t("waiting.titleCount", { count: waiting })}</Label>
          <span className="flex-1" />
          <span className="text-[11px] text-fg-3">{t("rail.allProjects")}</span>
          {onClose && <CloseButton onClose={onClose} />}
        </div>
        <WaitingCards projects={projects} current={project?.id} onOpen={onOpenWaiting} />

        {project && <>
          <div className="px-1 pb-1.5 pt-6"><Label>{t("rail.runningIn", { project: project.name })}</Label></div>
          {work.length === 0 && <p className="px-1 text-sm text-fg-3">{t("rail.nothingRuns")}</p>}
          <ul>
            {work.map(({ queue: q, status: s }) => {
              const step = s.step ? q.steps.find((x) => x.id === s.step) : undefined;
              return (
                <li key={q.id}>
                  <button onClick={() => open(q.id)} title={`${q.title}: ${s.label}`}
                    className="grid w-full grid-cols-[2.5rem_1fr_auto] items-center gap-2 rounded-md px-1 py-1.5 text-left text-sm hover:bg-surface-3/50">
                    <span className="truncate font-mono text-xs text-fg-3">{q.id}</span>
                    <span className="min-w-0 truncate text-fg">{q.title}{step && <span className="text-fg-2"> — {step.id} {step.title}</span>}</span>
                    <span className={`flex items-center gap-1.5 whitespace-nowrap text-xs ${TONE[s.tone][1]}`}>
                      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${TONE[s.tone][0]}`} />{shortStatus(s)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>

          {done.length > 0 && <>
            <div className="px-1 pb-1.5 pt-6"><Label>{t("rail.finishedToday", { count: done.length })}</Label></div>
            <ul>
              {done.map(({ queue: q, finished_at }) => (
                <li key={q.id}>
                  <button onClick={() => open(q.id)} className="flex w-full items-center gap-2 rounded-md px-1 py-1 text-left text-[13px] hover:bg-surface-3/50">
                    <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${q.status === "cancelled" ? "bg-fg-3" : "bg-ok"}`} />
                    <span className={`w-9 shrink-0 truncate font-mono text-xs ${q.status === "cancelled" ? "text-fg-3" : "text-ok"}`}>{q.id}</span>
                    <span className="min-w-0 flex-1 truncate text-fg-2">{q.status === "cancelled" ? t("rail.cancelled", { title: q.title }) : q.title}</span>
                    {finished_at && <span className="shrink-0 text-xs text-fg-3"><Clock at={finished_at} /></span>}
                  </button>
                </li>
              ))}
            </ul>
          </>}
        </>}
      </div>
      {project && (
        <div className="shrink-0 border-t border-line px-3 py-3">
          <button onClick={() => nav.tab("queues")} aria-pressed={queuesShown}
            className={`w-full truncate rounded-lg border border-line-strong px-3 py-1.5 text-sm font-medium ${queuesShown ? "bg-surface-3 text-fg" : "text-fg hover:bg-surface-3/60"}`}>
            {t("rail.allQueues", { project: project.name })}
          </button>
        </div>
      )}
    </div>
  );
}
