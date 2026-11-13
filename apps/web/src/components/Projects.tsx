// Switching projects: a sidebar on a desktop; on the phone (below 1024 px, App decides), a picker that opens from the
// current project's name.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { nav } from "../nav.ts";
import type { ProjectSummary } from "../api.ts";

const Waiting = ({ n }: { n: number }) =>
  n > 0 ? <span className="shrink-0 rounded-full bg-warn/20 px-1.5 text-xs text-warn" title="Waiting for you">{n}</span> : null;
const Running = ({ n }: { n: number }) =>
  n > 0 ? <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-accent" title={`${n} running`} /> : null;

/** A project's mark in the sidebar: the first letters of its first two words ("Project Honeycomb" → PH). */
export const initials = (name: string) =>
  name.split(/[\s_-]+/).filter(Boolean).slice(0, 2).map((w) => [...w][0]!.toUpperCase()).join("") || "?";

/**
 * A desktop's sidebar (from 1024 px; UX proposals, 12A): Nexus and whether live updates arrive, every project with its
 * waiting count and a dot when something runs (the list scrolls when there are many), and at its foot the global
 * status (`foot`: the update, the usage, notifications, settings, remote access).
 */
export function ProjectSidebar({ projects, current, connected, onPick, foot }: {
  projects: ProjectSummary[]; current?: string; connected: boolean; onPick: (id: string) => void; foot: ReactNode;
}) {
  return (
    <aside className="flex h-full w-58 shrink-0 flex-col border-r border-line bg-surface" aria-label="Projects">
      <div className="flex items-center gap-2 px-4.5 pb-3 pt-4">
        <span className="text-base font-semibold tracking-tight text-fg">Nexus</span>
        <span className="flex-1" />
        <span className={`flex items-center gap-1.5 text-xs ${connected ? "text-fg-3" : "text-stop"}`} title={connected ? "Live updates on" : "Reconnecting"}>
          {connected ? "live" : "offline"}<span className={`h-1.5 w-1.5 rounded-full ${connected ? "bg-ok" : "bg-stop"}`} />
        </span>
      </div>
      <div className="px-5 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-fg-3">Projects</div>
      <nav className="scroll-thin min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2.5 pb-3">
        {projects.map((p) => {
          const on = p.id === current;
          return (
            <button key={p.id} onClick={() => onPick(p.id)} aria-current={on ? "page" : undefined} title={p.name}
              className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm ${on ? "bg-surface-3 font-semibold text-fg" : "text-fg-2 hover:bg-surface-2 hover:text-fg"}`}>
              <span className={`grid h-6.5 w-6.5 shrink-0 place-items-center rounded-md text-xs font-bold ${on ? "bg-accent-strong text-on-accent" : "bg-surface-3 text-fg-2"}`}>{initials(p.name)}</span>
              <span className="min-w-0 flex-1 truncate">{p.name}</span>
              <Running n={p.running} />
              <Count n={p.attention.length} />
            </button>
          );
        })}
      </nav>
      <div className="flex shrink-0 flex-col gap-2 border-t border-line px-4 py-3">{foot}</div>
    </aside>
  );
}

const Count = ({ n }: { n: number }) =>
  n > 0 ? <span className="grid h-4.5 min-w-4.5 shrink-0 place-items-center rounded-full bg-warn px-1.5 text-[11px] font-semibold text-canvas" title="Waiting for you">{n}</span> : null;

/**
 * The narrow layout: the current project's name, with its own count and dot; a tap opens the list of all projects
 * (each with its count and dot), a second tap switches. What waits in other projects is counted by the waiting
 * button beside it.
 */
export function ProjectPicker({ projects, current, open, onPick }: { projects: ProjectSummary[]; current?: string; open: boolean; onPick: (id: string) => void }) {
  // Open is a layer in the history (nav.ts): Back closes the list.
  const setOpen = (v: boolean) => (v ? nav.open("projects") : nav.close("projects"));
  const button = useRef<HTMLButtonElement>(null);
  // The header blurs what is behind it, which would trap fixed children; the list goes to the body, just below it.
  const [top, setTop] = useState(0);
  useEffect(() => { if (open) setTop(button.current?.closest("header")?.getBoundingClientRect().bottom ?? 0); }, [open]);
  const here = projects.find((p) => p.id === current);
  const single = projects.length < 2;
  return (
    <div className="flex min-w-0 shrink">
      <button
        ref={button}
        onClick={() => !single && setOpen(!open)}
        aria-haspopup="listbox" aria-expanded={open} disabled={single}
        className="flex min-w-0 items-center gap-2 rounded-lg bg-surface-3 px-3 py-1.5 text-sm text-fg disabled:cursor-default"
      >
        <span className="truncate">{here?.name ?? "Projects"}</span>
        {here && <Waiting n={here.attention.length} />}
        {here && <Running n={here.running} />}
        {!single && (
          <span className="shrink-0 text-fg-2">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={open ? "rotate-180" : ""}><path d="m6 9 6 6 6-6" /></svg>
          </span>
        )}
      </button>
      {open && createPortal(
        <>
          <div className="fixed inset-x-0 bottom-0 z-40 bg-scrim/50" style={{ top }} onClick={() => setOpen(false)} />
          <ul role="listbox" aria-label="Projects" style={{ top, maxHeight: `calc(100dvh - ${top}px - 4rem)` }}
            className="scroll-thin fixed inset-x-0 z-50 overflow-y-auto border-b border-line bg-surface py-1 shadow-2xl">
            {projects.map((p) => (
              <li key={p.id}>
                <button
                  role="option" aria-selected={p.id === current}
                  onClick={() => (p.id === current ? setOpen(false) : onPick(p.id))}
                  className={`flex min-h-12 w-full items-center gap-3 px-4 text-left text-sm ${p.id === current ? "bg-surface-3/80 text-fg" : "text-fg active:bg-surface-3"}`}
                >
                  <span className={`w-4 shrink-0 text-accent ${p.id === current ? "" : "invisible"}`}>✓</span>
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
