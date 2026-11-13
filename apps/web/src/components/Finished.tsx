// The finished queues of a project, folded into one line at the bottom of the queue list: "Finished (N)", closed
// until the user opens it (the browser remembers that, per project); open, one compact line per queue, the most
// recently finished on top, a tap opening its details.
import { useState } from "react";
import { formatDuration } from "@nexus/protocol/times";
import type { QueueView } from "../api.ts";
import type { FinishedRow } from "../finished.ts";
import { Clock } from "./ui.tsx";

const key = (project: string) => `nexus.finished-open:${project}`;
const remembered = (project: string) => { try { return localStorage.getItem(key(project)) === "1"; } catch { return false; } };

export function FinishedGroup({ project, rows, onOpen }: { project: string; rows: FinishedRow<QueueView>[]; onOpen: (queue: string) => void }) {
  const [open, setOpenState] = useState(() => remembered(project));
  const [shownFor, setShownFor] = useState(project);
  if (shownFor !== project) { setShownFor(project); setOpenState(remembered(project)); } // another project: its own choice
  const setOpen = (v: boolean) => {
    setOpenState(v);
    try { if (v) localStorage.setItem(key(project), "1"); else localStorage.removeItem(key(project)); } catch { /* not kept */ }
  };
  if (rows.length === 0) return null;
  return (
    <section className="mb-8">
      <button onClick={() => setOpen(!open)} aria-expanded={open}
        className="flex w-full items-center gap-2 rounded-lg py-1 text-left text-sm font-semibold uppercase tracking-wider text-fg-2 hover:text-fg">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={`shrink-0 transition-transform ${open ? "rotate-90" : ""}`}><path d="m9 18 6-6-6-6" /></svg>
        Finished <span className="font-normal text-fg-3">({rows.length})</span>
      </button>
      {open && (
        <ul className="mt-2 divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
          {rows.map(({ queue: q, finished_at, ran_ms }) => (
            <li key={q.id}>
              <button onClick={() => onOpen(q.id)} className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-surface-3/50">
                <span className="w-10 shrink-0 truncate font-mono text-xs text-fg-3">{q.id}</span>
                {/* On a phone the times go under the title, so the title keeps the width. */}
                <span className="flex min-w-0 flex-1 flex-col sm:flex-row sm:items-center sm:gap-3">
                  <span className="min-w-0 truncate text-fg sm:flex-1">{q.title}</span>
                  <span className="shrink-0 whitespace-nowrap text-xs text-fg-3">
                    {q.status === "cancelled" && <>cancelled · </>}
                    {finished_at ? <Clock at={finished_at} /> : "no finish time"}{ran_ms !== undefined && <> · ran {formatDuration(ran_ms)}</>}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
