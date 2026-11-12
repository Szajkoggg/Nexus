// Switching projects: tabs on a wide screen; on a narrow one, a picker that opens from the current project's name.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ProjectSummary } from "../api.ts";

const Waiting = ({ n }: { n: number }) =>
  n > 0 ? <span className="shrink-0 rounded-full bg-amber-500/20 px-1.5 text-xs text-amber-300" title="Waiting for you">{n}</span> : null;
const Running = ({ n }: { n: number }) =>
  n > 0 ? <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-blue-400" title={`${n} running`} /> : null;

/** The wide layout: one tab per project. */
export function ProjectTabs({ projects, current, onPick }: { projects: ProjectSummary[]; current?: string; onPick: (id: string) => void }) {
  return (
    <nav className="scroll-thin hidden flex-1 gap-1 overflow-x-auto sm:flex">
      {projects.map((p) => (
        <button
          key={p.id}
          onClick={() => onPick(p.id)}
          className={`flex shrink-0 items-center gap-2 rounded-lg px-3 py-1.5 text-sm ${p.id === current ? "bg-zinc-800 text-zinc-50" : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"}`}
        >
          {p.name}
          <Waiting n={p.attention.length} />
          <Running n={p.running} />
        </button>
      ))}
    </nav>
  );
}

/**
 * The narrow layout: the current project's name, with its own count and dot; a tap opens the list of all projects
 * (each with its count and dot), a second tap switches. A small amber dot on the closed picker says that another
 * project waits for you.
 */
export function ProjectPicker({ projects, current, onPick }: { projects: ProjectSummary[]; current?: string; onPick: (id: string) => void }) {
  const [open, setOpen] = useState(() => new URLSearchParams(location.search).has("projects"));
  const button = useRef<HTMLButtonElement>(null);
  // The header blurs what is behind it, which would trap fixed children; the list goes to the body, just below it.
  const [top, setTop] = useState(0);
  useEffect(() => { if (open) setTop(button.current?.closest("header")?.getBoundingClientRect().bottom ?? 0); }, [open]);
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [open]);
  const here = projects.find((p) => p.id === current);
  const others = projects.filter((p) => p.id !== current);
  const elsewhere = others.some((p) => p.attention.length > 0);
  const single = projects.length < 2;
  return (
    <div className="flex min-w-0 flex-1 sm:hidden">
      <button
        ref={button}
        onClick={() => !single && setOpen(!open)}
        aria-haspopup="listbox" aria-expanded={open} disabled={single}
        className="flex min-w-0 items-center gap-2 rounded-lg bg-zinc-800 px-3 py-1.5 text-sm text-zinc-50 disabled:cursor-default"
      >
        <span className="truncate">{here?.name ?? "Projects"}</span>
        {here && <Waiting n={here.attention.length} />}
        {here && <Running n={here.running} />}
        {!single && (
          <span className="relative shrink-0 text-zinc-400">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={open ? "rotate-180" : ""}><path d="m6 9 6 6 6-6" /></svg>
            {elsewhere && !open && <span className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-amber-400" title="Another project waits for you" />}
          </span>
        )}
      </button>
      {open && createPortal(
        <>
          <div className="fixed inset-x-0 bottom-0 z-40 bg-black/50" style={{ top }} onClick={() => setOpen(false)} />
          <ul role="listbox" aria-label="Projects" style={{ top, maxHeight: `calc(100dvh - ${top}px - 4rem)` }}
            className="scroll-thin fixed inset-x-0 z-50 overflow-y-auto border-b border-zinc-800 bg-zinc-900 py-1 shadow-2xl">
            {projects.map((p) => (
              <li key={p.id}>
                <button
                  role="option" aria-selected={p.id === current}
                  onClick={() => { setOpen(false); onPick(p.id); }}
                  className={`flex min-h-12 w-full items-center gap-3 px-4 text-left text-sm ${p.id === current ? "bg-zinc-800/80 text-zinc-50" : "text-zinc-300 active:bg-zinc-800"}`}
                >
                  <span className={`w-4 shrink-0 text-sky-400 ${p.id === current ? "" : "invisible"}`}>✓</span>
                  <span className="min-w-0 flex-1 truncate">{p.name}</span>
                  <Running n={p.running} />
                  <Waiting n={p.attention.length} />
                </button>
              </li>
            ))}
          </ul>
        </>,
        document.body,
      )}
    </div>
  );
}
