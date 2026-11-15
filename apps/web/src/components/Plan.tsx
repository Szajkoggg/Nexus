// The plan on the Queues view (PROTOCOL.md, "The plan"; layout in ../plan.ts): on a desktop, lanes from the left (what
// runs now, then what follows), with a line from each queue to those that wait for it, solid where the user set the
// dependency and dashed where the orchestrator did; on the phone, the same queues as one ordered list. Every planned
// queue says what it waits for and which of its dependencies are the user's ("set by you").
//
// The user reorders it as a list (the rule is the server's, plan.ts reorderedFollowers): "After…" on a queue, or
// dragging it onto another (onto "Next": to the front). The orchestrator's proposals have Accept and Decline on the
// queue (and in the waiting list, PlanRow); a dependency the user set can be handed back to the orchestrator (↩).
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { act, enc, useAction, useQuery, type AttentionItem, type QueueView, type Version } from "../api.ts";
import type { EstimatesResponse } from "@nexus/protocol";
import { t } from "../i18n.ts";
import { estimateWords, moveTargets, planLayout, planList, type PlanLayout, type PlanNode, type Why } from "../plan.ts";
import { Button } from "./ui.tsx";
import { TONE } from "./QueueRow.tsx";

/** A reason's colour: what the user can do in the approval and stop colours; what waits by itself muted. */
const WHY: Record<Why["tone"], string> = {
  approval: "text-info", blocked: "text-stop", time: "text-fg-2", usage: "text-warn",
  checkout: "text-warn", limit: "text-warn", failed: "text-danger", ready: "text-ok",
};

const columnTitle = (c: number) => t(c === 0 ? "plan.column.now" : c === 1 ? "plan.column.next" : "plan.column.then");
const listText = (ids: readonly string[]) => (ids.length ? t("plan.after", { queue: ids.join(", ") }) : t("plan.first"));

/** The user's actions on the plan: each a POST to …/queues/:q/plan. */
function usePlanActions(project: string, onChanged: () => void) {
  const { busy, error, run } = useAction();
  const post = (queue: string, body: Record<string, unknown>) => run(() => act(project, "POST", `/queues/${enc(queue)}/plan`, body), onChanged);
  return {
    error, busy,
    move: (queue: string, after: string | null) => post(queue, { action: "move", after }),
    accept: (queue: string) => post(queue, { action: "accept" }),
    decline: (queue: string) => post(queue, { action: "decline" }),
    handBack: (queue: string, after: string) => post(queue, { action: "hand_back", after }),
  };
}
type Actions = ReturnType<typeof usePlanActions> & {
  targets: (queue: string) => { id: string; title: string }[];
  /** The queues' expected times (estimates), once loaded. */
  estimates?: EstimatesResponse;
};

export function PlanView({ project, queues, version, onOpen, onChanged }: {
  project: string; queues: readonly QueueView[]; onOpen: (queue: string) => void; onChanged: () => void;
  /** Changes when the project's files do: the estimates are fetched again. */
  version?: Version;
}) {
  const layout = useMemo(() => planLayout(queues), [queues]);
  const base = usePlanActions(project, onChanged);
  const estimates = useQuery<EstimatesResponse>(`/api/projects/${enc(project)}/estimates`, version).data;
  const actions: Actions = { ...base, targets: (q) => moveTargets(layout, queues, q), estimates };
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
      {actions.error && <p className="mb-3 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger" role="alert">{actions.error}</p>}
      <div className="hidden @3xl:block"><Lanes layout={layout} onOpen={onOpen} actions={actions} /></div>
      <PhoneList layout={layout} onOpen={onOpen} actions={actions} />
      {layout.outside.length > 0 && (
        <div className="mt-4">
          <h3 className="mb-1.5 text-xs font-medium text-fg-3">{t("plan.outsideTitle", { count: layout.outside.length })}</h3>
          <div className="flex flex-wrap gap-2">
            {layout.outside.map((q) => (
              <span key={q.id} className="flex items-center gap-2 rounded-lg border border-dashed border-line-strong bg-surface px-2.5 py-1.5 text-sm">
                <button onClick={() => onOpen(q.id)} className="flex items-baseline gap-2 text-left hover:text-accent">
                  <span className="font-mono text-xs text-fg-3">{q.id}</span><span className="text-fg">{q.title}</span>
                </button>
                <AfterMenu queue={q.id} actions={actions} />
              </span>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

/** The lanes: a column per step of the plan, cards in each, and the lines drawn over them once they are laid out. */
function Lanes({ layout, onOpen, actions }: { layout: PlanLayout; onOpen: (queue: string) => void; actions: Actions }) {
  const box = useRef<HTMLDivElement>(null);
  const cards = useRef(new Map<string, HTMLElement>());
  const [lines, setLines] = useState<{ key: string; d: string; by: "user" | "orchestrator" }[]>([]);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [dragged, setDragged] = useState<string>();
  const [over, setOver] = useState<string>();

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

  /** Where a dragged queue may be dropped: onto another queue (after it), or onto "Next" (to the front). */
  const dropTarget = (target: string | null) => ({
    onDragOver: (e: React.DragEvent) => { if (dragged && dragged !== target) { e.preventDefault(); setOver(target ?? ""); } },
    onDragLeave: () => setOver(undefined),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      const q = e.dataTransfer.getData("text/plain") || dragged;
      setOver(undefined); setDragged(undefined);
      if (q && q !== target) void actions.move(q, target);
    },
  });

  return (
    <div ref={box} className="scroll-thin relative overflow-x-auto pb-1">
      <div className="grid gap-x-10" style={{ gridTemplateColumns: `repeat(${layout.columns.length}, minmax(11.5rem, 1fr))` }}>
        {layout.columns.map((col, c) => (
          <div key={c} className="min-w-0">
            <h3 {...(c === 1 ? dropTarget(null) : {})} data-plan-drop={c === 1 ? "first" : undefined}
              className={`mb-2 rounded text-xs font-medium ${c === 1 && over === "" ? "bg-accent/15 text-accent" : "text-fg-3"} ${c === 1 && dragged ? "outline-1 outline-dashed outline-accent/50" : ""}`}>
              {columnTitle(c)}{c === 1 && dragged ? ` · ${t("plan.dropFirst")}` : ""}
            </h3>
            <div className="space-y-3">
              {col.map((n) => (
                <Card key={n.id} node={n} onOpen={onOpen} actions={actions} highlight={over === n.id}
                  drag={{
                    draggable: n.movable,
                    onDragStart: (e: React.DragEvent) => { e.dataTransfer.setData("text/plain", n.id); e.dataTransfer.effectAllowed = "move"; setDragged(n.id); },
                    onDragEnd: () => { setDragged(undefined); setOver(undefined); },
                    ...dropTarget(n.id),
                  }}
                  cardRef={(el) => { if (el) cards.current.set(n.id, el); else cards.current.delete(n.id); }} />
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
function PhoneList({ layout, onOpen, actions }: { layout: PlanLayout; onOpen: (queue: string) => void; actions: Actions }) {
  const list = planList(layout);
  return (
    <ol className="space-y-2 @3xl:hidden">
      {list.map((n, i) => (
        <li key={n.id}>
          {(i === 0 || list[i - 1]!.column !== n.column) && <h3 className={`mb-1.5 text-xs font-medium text-fg-3 ${i ? "mt-4" : ""}`}>{columnTitle(n.column)}</h3>}
          <Card node={n} onOpen={onOpen} actions={actions} />
        </li>
      ))}
    </ol>
  );
}

/**
 * A queue in the plan: its status now, or what it waits for and the queues before it ("set by you", with ↩ to hand it
 * back); the orchestrator's proposal with Accept and Decline; "After…" to move it.
 */
function Card({ node: n, onOpen, actions, cardRef, drag, highlight }: {
  node: PlanNode; onOpen: (queue: string) => void; actions: Actions; cardRef?: (el: HTMLElement | null) => void;
  drag?: React.HTMLAttributes<HTMLDivElement> & { draggable?: boolean }; highlight?: boolean;
}) {
  const [dot, word] = TONE[n.status.tone];
  return (
    <div ref={cardRef} {...drag} data-plan-card={n.id}
      className={`rounded-lg border bg-surface px-3 py-2 ${highlight ? "border-accent ring-2 ring-accent/30" : n.proposal ? "border-review/50" : "border-line hover:border-line-strong"} ${n.movable && drag ? "cursor-grab active:cursor-grabbing" : ""}`}>
      <div className="flex items-start gap-2">
        <button onClick={() => onOpen(n.id)} className="flex min-w-0 flex-1 items-baseline gap-2 text-left hover:text-accent">
          <span className="font-mono text-xs text-fg-3">{n.id}</span>
          <span className="min-w-0 truncate text-sm font-medium text-fg">{n.title}</span>
        </button>
        {n.movable && <AfterMenu queue={n.id} actions={actions} />}
      </div>
      {(n.now || !n.planned) && (
        <span className="mt-1 flex items-center gap-1.5 text-xs">
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} />
          <span className={`min-w-0 truncate ${word}`}>{n.now ? n.status.label : `${t("plan.notPlanned")} · ${n.status.label}`}</span>
        </span>
      )}
      {!n.now && n.planned && n.why.map((w) => (
        <span key={w.key} className={`mt-1 block text-xs ${WHY[w.tone]}`}>{t(w.key, w.params)}</span>
      ))}
      {n.before.length > 0 && (
        <span className="mt-1.5 flex flex-wrap gap-1">
          {n.before.map((b) => (
            <span key={b.queue} className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] ${b.done ? "bg-surface-3 text-fg-3" : b.by === "user" ? "bg-accent/15 text-accent" : "bg-surface-3 text-fg-2"}`}>
              {t("plan.after", { queue: b.queue })}{b.by === "user" ? ` · ${t("plan.setByYou")}` : ""}{b.done ? ` · ${t("plan.done")}` : ""}
              {b.by === "user" && (
                <button onClick={() => void actions.handBack(n.id, b.queue)} disabled={actions.busy} data-plan-handback={`${n.id}:${b.queue}`}
                  title={t("plan.handBack")} aria-label={t("plan.handBack")} className="-mr-0.5 rounded px-0.5 hover:bg-accent/20 disabled:opacity-40">↩</button>
              )}
            </span>
          ))}
        </span>
      )}
      <Estimate queue={n.id} estimates={actions.estimates} />
      {n.proposal && <Proposal queue={n.id} proposal={n.proposal} current={n.before.map((b) => b.queue)} actions={actions} />}
    </div>
  );
}

/** What the queue's steps left are expected to take, marked as an estimate (or that there is none yet). */
function Estimate({ queue, estimates }: { queue: string; estimates?: EstimatesResponse }) {
  const words = estimateWords(estimates?.queues[queue]);
  if (!words || !estimates) return null;
  const title = estimates.samples < estimates.min ? t("plan.estimate.tooFew", { min: estimates.min }) : t("plan.estimate.title", { samples: estimates.samples });
  return <span className="mt-1 block text-[11px] italic text-fg-3" title={title} data-plan-estimate={queue}>{t(words.key, words.params)}</span>;
}

/** The orchestrator's proposal for a queue, with Accept and Decline. */
function Proposal({ queue, proposal, current, actions }: { queue: string; proposal: { after: readonly string[]; reason: string }; current: readonly string[]; actions: Pick<Actions, "accept" | "decline" | "busy"> }) {
  return (
    <div className="mt-2 rounded-md border border-review/40 bg-review/10 p-2 text-xs" data-plan-proposal={queue}>
      <p className="text-review">{t("plan.proposal", { proposed: listText(proposal.after), current: listText(current) })}</p>
      <p className="mt-0.5 line-clamp-3 text-fg-2">{proposal.reason}</p>
      <ProposalButtons queue={queue} actions={actions} className="mt-2" />
    </div>
  );
}

/** Accept and Decline on the orchestrator's proposal for a queue. */
function ProposalButtons({ queue, actions, className = "" }: { queue: string; actions: Pick<Actions, "accept" | "decline" | "busy">; className?: string }) {
  return (
    <div className={`flex flex-wrap items-center gap-2 ${className}`}>
      <Button onClick={() => void actions.accept(queue)} disabled={actions.busy}>{t("plan.accept")}</Button>
      <Button variant="quiet" onClick={() => void actions.decline(queue)} disabled={actions.busy}>{t("plan.decline")}</Button>
    </div>
  );
}

/** "After…": a small menu of where to move the queue: first (none before it), or after another queue. */
function AfterMenu({ queue, actions }: { queue: string; actions: Actions }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", key); };
  }, [open]);
  const pick = (after: string | null) => { setOpen(false); void actions.move(queue, after); };
  return (
    <span ref={box} className="relative shrink-0">
      <button onClick={() => setOpen(!open)} aria-expanded={open} disabled={actions.busy} data-plan-move={queue}
        className="rounded px-1.5 py-0.5 text-xs text-fg-3 hover:bg-surface-3 hover:text-fg disabled:opacity-40 max-lg:min-h-8">{t("plan.move")}</button>
      {open && (
        <span role="menu" className="scroll-thin absolute right-0 z-30 mt-1 block max-h-72 w-60 overflow-y-auto rounded-lg border border-line-strong bg-surface-2 p-1 shadow-lg">
          <button role="menuitem" data-plan-after="" onClick={() => pick(null)} className="block w-full rounded px-2 py-1.5 text-left text-sm text-fg hover:bg-surface-3">{t("plan.moveFirst")}</button>
          {actions.targets(queue).map((x) => (
            <button key={x.id} role="menuitem" data-plan-after={x.id} onClick={() => pick(x.id)} className="flex w-full items-baseline gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-surface-3">
              <span className="shrink-0 text-fg">{t("plan.after", { queue: x.id })}</span><span className="min-w-0 truncate text-xs text-fg-3">{x.title}</span>
            </button>
          ))}
        </span>
      )}
    </span>
  );
}

/** An item of kind `plan` with the orchestrator's proposal, in a waiting list: Accept and Decline there. */
export function PlanRow({ project, a, onChanged }: { project: string; a: AttentionItem; onChanged?: () => void }) {
  const actions = usePlanActions(project, onChanged ?? (() => {}));
  const p = a.plan?.proposal;
  if (!p || !a.queue) return null;
  return (
    <div className="px-3.5 pb-3">
      <ProposalButtons queue={a.queue} actions={actions} />
      {actions.error && <p className="mt-2 text-sm text-danger" role="alert">{actions.error}</p>}
    </div>
  );
}
