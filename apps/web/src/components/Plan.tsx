// The plan on the Queues view (PROTOCOL.md, "The plan"; layout in ../plan.ts): on a desktop, lanes from the left (what
// runs now, then what follows), with a line from each queue to those that wait for it, solid where the user set the
// dependency and dashed where the orchestrator did; on the phone, the same queues as one ordered list. Every planned
// queue says what it waits for and which of its dependencies are the user's ("set by you").
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { QueueView } from "../api.ts";
import { t } from "../i18n.ts";
import { planLayout, planList, type PlanLayout, type PlanNode, type Why } from "../plan.ts";
import { TONE } from "./QueueRow.tsx";

/** A reason's colour: what the user can do in the approval and stop colours; what waits by itself muted. */
const WHY: Record<Why["tone"], string> = {
  approval: "text-info", blocked: "text-stop", time: "text-fg-2", usage: "text-warn",
  checkout: "text-warn", limit: "text-warn", failed: "text-danger", ready: "text-ok",
};

const columnTitle = (c: number) => t(c === 0 ? "plan.column.now" : c === 1 ? "plan.column.next" : "plan.column.then");

export function PlanView({ queues, onOpen }: { queues: readonly QueueView[]; onOpen: (queue: string) => void }) {
  const layout = useMemo(() => planLayout(queues), [queues]);
  // Nothing planned: the view says nothing (the queue lists below say what there is).
  if (!layout.columns.some((c, i) => i > 0 && c.length) && !layout.outside.length) return null;
  return (
    <section className="mb-8" aria-label={t("plan.title")}>
      <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-fg-2">{t("plan.title")}</h2>
        <span className="text-xs text-fg-3">{t("plan.hint")}<span className="hidden @3xl:inline"> {t("plan.hintLines")}</span></span>
        <span className="flex-1" />
        <span className="hidden items-center gap-3 text-xs text-fg-3 @3xl:flex">
          <span className="flex items-center gap-1.5"><svg width="22" height="6" aria-hidden><line x1="0" y1="3" x2="22" y2="3" className="stroke-accent" strokeWidth="2" /></svg>{t("plan.legend.you")}</span>
          <span className="flex items-center gap-1.5"><svg width="22" height="6" aria-hidden><line x1="0" y1="3" x2="22" y2="3" className="stroke-fg-3" strokeWidth="1.5" strokeDasharray="4 3" /></svg>{t("plan.legend.orchestrator")}</span>
        </span>
      </div>
      <div className="hidden @3xl:block"><Lanes layout={layout} onOpen={onOpen} /></div>
      <PhoneList layout={layout} onOpen={onOpen} />
      {layout.outside.length > 0 && (
        <p className="mt-3 text-xs text-fg-3">
          {t("plan.outside", { count: layout.outside.length, queues: layout.outside.map((q) => `${q.id} ${q.title}`).join(", ") })}
        </p>
      )}
    </section>
  );
}

/** The lanes: a column per step of the plan, cards in each, and the lines drawn over them once they are laid out. */
function Lanes({ layout, onOpen }: { layout: PlanLayout; onOpen: (queue: string) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const cards = useRef(new Map<string, HTMLElement>());
  const [lines, setLines] = useState<{ key: string; d: string; by: "user" | "orchestrator" }[]>([]);
  const [size, setSize] = useState({ w: 0, h: 0 });

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      if (!r.width) return; // hidden (the phone's list shows)
      setSize({ w: el.scrollWidth, h: el.scrollHeight });
      setLines(layout.edges.flatMap((e) => {
        const a = cards.current.get(e.from)?.getBoundingClientRect();
        const b = cards.current.get(e.to)?.getBoundingClientRect();
        if (!a || !b) return [];
        const x1 = a.right - r.left + el.scrollLeft, y1 = a.top + a.height / 2 - r.top;
        const x2 = b.left - r.left + el.scrollLeft, y2 = b.top + b.height / 2 - r.top;
        const dx = Math.max(14, (x2 - x1) / 2);
        return [{ key: `${e.from}>${e.to}`, by: e.by, d: `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2 - 3},${y2}` }];
      }));
    };
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    for (const c of cards.current.values()) watch.observe(c);
    return () => watch.disconnect();
  }, [layout]);

  return (
    <div ref={box} className="scroll-thin relative overflow-x-auto pb-1">
      <div className="grid gap-x-10" style={{ gridTemplateColumns: `repeat(${layout.columns.length}, minmax(11.5rem, 1fr))` }}>
        {layout.columns.map((col, c) => (
          <div key={c} className="min-w-0">
            <h3 className="mb-2 text-xs font-medium text-fg-3">{columnTitle(c)}</h3>
            <div className="space-y-3">
              {col.map((n) => (
                <Card key={n.id} node={n} onOpen={onOpen} cardRef={(el) => { if (el) cards.current.set(n.id, el); else cards.current.delete(n.id); }} />
              ))}
              {!col.length && <p className="text-xs text-fg-3">{t("common.nothingHere")}</p>}
            </div>
          </div>
        ))}
      </div>
      <svg className="pointer-events-none absolute left-0 top-0" width={size.w} height={size.h} aria-hidden>
        <defs>
          <marker id="plan-arrow-user" viewBox="0 0 6 6" refX="3" refY="3" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L6,3 L0,6 z" className="fill-accent" /></marker>
          <marker id="plan-arrow-orchestrator" viewBox="0 0 6 6" refX="3" refY="3" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L6,3 L0,6 z" className="fill-fg-3" /></marker>
        </defs>
        {lines.map((l) => (
          <path key={l.key} d={l.d} fill="none" markerEnd={`url(#plan-arrow-${l.by})`}
            className={l.by === "user" ? "stroke-accent" : "stroke-fg-3"} strokeWidth={l.by === "user" ? 2 : 1.5} strokeDasharray={l.by === "user" ? undefined : "4 3"} />
        ))}
      </svg>
    </div>
  );
}

/** The phone's list: the columns one after another under their titles. */
function PhoneList({ layout, onOpen }: { layout: PlanLayout; onOpen: (queue: string) => void }) {
  const list = planList(layout);
  return (
    <ol className="space-y-2 @3xl:hidden">
      {list.map((n, i) => (
        <li key={n.id}>
          {(i === 0 || list[i - 1]!.column !== n.column) && <h3 className={`mb-1.5 text-xs font-medium text-fg-3 ${i ? "mt-4" : ""}`}>{columnTitle(n.column)}</h3>}
          <Card node={n} onOpen={onOpen} />
        </li>
      ))}
    </ol>
  );
}

/** A queue in the plan: its status now, or what it waits for and the queues before it ("set by you"). */
function Card({ node: n, onOpen, cardRef }: { node: PlanNode; onOpen: (queue: string) => void; cardRef?: (el: HTMLElement | null) => void }) {
  const [dot, word] = TONE[n.status.tone];
  return (
    <button ref={cardRef} onClick={() => onOpen(n.id)}
      className="block w-full rounded-lg border border-line bg-surface px-3 py-2 text-left hover:border-line-strong hover:bg-surface-2">
      <span className="flex items-baseline gap-2">
        <span className="font-mono text-xs text-fg-3">{n.id}</span>
        <span className="min-w-0 truncate text-sm font-medium text-fg">{n.title}</span>
      </span>
      {(n.now || !n.planned) && (
        <span className="mt-1 flex items-center gap-1.5 text-xs">
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} />
          <span className={`min-w-0 truncate ${word}`}>{n.planned || n.now ? n.status.label : `${t("plan.notPlanned")} · ${n.status.label}`}</span>
        </span>
      )}
      {!n.now && n.planned && n.why.map((w) => (
        <span key={w.key} className={`mt-1 block text-xs ${WHY[w.tone]}`}>{t(w.key, w.params)}</span>
      ))}
      {n.before.length > 0 && (
        <span className="mt-1.5 flex flex-wrap gap-1">
          {n.before.map((b) => (
            <span key={b.queue} className={`rounded px-1.5 py-0.5 text-[11px] ${b.done ? "bg-surface-3 text-fg-3" : b.by === "user" ? "bg-accent/15 text-accent" : "bg-surface-3 text-fg-2"}`}>
              {t("plan.after", { queue: b.queue })}{b.by === "user" ? ` · ${t("plan.setByYou")}` : ""}{b.done ? ` · ${t("plan.done")}` : ""}
            </span>
          ))}
        </span>
      )}
    </button>
  );
}
