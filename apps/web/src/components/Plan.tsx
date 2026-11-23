// The plan on the Queues view (docs/protocol/planning.md, "The plan"; layout in ../plan.ts): on a desktop, columns from the left
// (what runs now, then what follows; layout A of docs/ux/plan-view-options.md), with a line from each queue to those
// that wait for it, routed at right angles around the cards, solid where the user set the dependency and dashed where
// the orchestrator did; on the phone, the same queues as one ordered list. Every card has the queue's whole title and
// says what it waits for and which of its dependencies are the user's ("set by you").
//
// The user reorders it as a list (the rule is the server's, plan.ts reorderedFollowers): "After…" on a queue, or
// dragging it onto another (onto "Next": to the front), whose halves offer "after it instead" and "also after it" (one
// more dependency). A click on a line (an "after" chip on the phone) opens its details: who set it and when, "Remove
// 'after X'" and "Let the orchestrator decide". A move, an "also after" and a removal can be undone from the bar under
// the plan for a few seconds. The orchestrator's proposals have Accept and Decline on the queue (and in the waiting
// list, PlanRow); a dependency the user set can be handed back to the orchestrator (↩).
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { act, actResult, enc, projectUrl, useAction, useQuery, type AttentionItem, type QueueView } from "../api.ts";
import type { EstimatesResponse } from "@nexus/protocol";
import { t } from "../i18n.ts";
import {
  UNDO_SHOWN_MS, changeWords, drawPlan, dropChoices, estimateWords, firstUserWait, lineDetails, moveTargets, planLayout, planList, roundedPath,
  userReviewsOf, type FirstWait, type ReviewWho, type UserReviews, type PlanLayout, type PlanNode, type Why, type Words,
} from "../plan.ts";
import { Button } from "./ui.tsx";
import { TONE } from "./QueueRow.tsx";
import { usePage } from "../page.ts";

/** A reason's colour: what the user can do in the approval and stop colours; what waits by itself muted. */
const WHY: Record<Why["tone"], string> = {
  approval: "text-info", blocked: "text-stop", time: "text-fg-2", usage: "text-warn",
  checkout: "text-warn", limit: "text-warn", failed: "text-danger", ready: "text-ok",
};

const columnTitle = (c: number) => t(c === 0 ? "plan.column.now" : c === 1 ? "plan.column.next" : "plan.column.then");
/** Words of ../plan.ts in the reader's language. */
const say = (w: Words) => t(w.key, w.params);
const listText = (ids: readonly string[]) => (ids.length ? t("plan.after", { queue: ids.join(", ") }) : t("plan.first"));

/** A change of the user's to the plan that can still be undone: what it did, in words, and its line (lit meanwhile). */
interface Change { change: string; queue: string; words: string; edge?: string; until: number }
/** What the server answers a move, an add or a remove (docs/protocol/planning.md, "The plan"). */
interface ChangeAnswer { message: string; undo: { change: string; until: string; queues: string[] } }

/** The user's actions on the plan: each a POST to …/queues/:q/plan. A move, an add and a remove can be undone. */
function usePlanActions(project: string, onChanged: () => void) {
  const { busy, error, run } = useAction();
  const [last, setLast] = useState<Change>();
  const dismiss = useCallback(() => setLast(undefined), []);
  const path = (queue: string) => `/queues/${enc(queue)}/plan`;
  const post = (queue: string, body: Record<string, unknown>) => run(() => act(project, "POST", path(queue), body), onChanged);
  const change = (queue: string, body: Record<string, unknown>, words: Words, edge?: string) =>
    run(() => actResult<ChangeAnswer>(project, "POST", path(queue), body), (r) => {
      if (r?.undo) setLast({ change: r.undo.change, queue, words: say(words), edge, until: Date.now() + UNDO_SHOWN_MS });
      onChanged();
    });
  return {
    error, busy, last, dismiss,
    /** `replaced`: the predecessors the move replaces, for the undo bar's words. */
    moveReplacing: (queue: string, after: string | null, replaced: readonly string[]) =>
      change(queue, { action: "move", after }, changeWords({ kind: "move", queue, target: after, replaced }), after ? `${after}>${queue}` : undefined),
    add: (queue: string, after: string) => change(queue, { action: "add", after }, changeWords({ kind: "add", queue, target: after }), `${after}>${queue}`),
    remove: (queue: string, after: string) => change(queue, { action: "remove", after }, changeWords({ kind: "remove", queue, target: after })),
    undo: (c: Change) => run(() => act(project, "POST", path(c.queue), { action: "undo", change: c.change }), () => { setLast(undefined); onChanged(); }),
    accept: (queue: string) => post(queue, { action: "accept" }),
    decline: (queue: string) => post(queue, { action: "decline" }),
    handBack: (queue: string, after: string) => post(queue, { action: "hand_back", after }),
  };
}
type Actions = ReturnType<typeof usePlanActions> & {
  /** A move after `after` (null: first), the undo bar naming what it replaces. */
  move: (queue: string, after: string | null) => Promise<boolean>;
  targets: (queue: string) => { id: string; title: string }[];
  /** The queues' expected times (estimates), once loaded. */
  estimates?: EstimatesResponse;
  /** The steps left for the user's review, by queue (those with any). */
  reviews: ReadonlyMap<string, UserReviews>;
  /** The first point where the plan will wait for the user's review. */
  first?: FirstWait;
};

export function PlanView({ project, queues, who, onOpen }: {
  project: string; queues: readonly QueueView[]; onOpen: (queue: string) => void;
  /** Who reviews (the project's orchestrator, away mode): which steps will wait for the user's review. */
  who: ReviewWho;
  /** Changes when the project's files do: the estimates are fetched again. */
}) {
  const { reload: onChanged } = usePage();
  const layout = useMemo(() => planLayout(queues), [queues]);
  const base = usePlanActions(project, onChanged);
  const estimates = useQuery<EstimatesResponse>(projectUrl(project, "/estimates"), usePage().queues).data;
  const { orchestrating, away } = who;
  const reviews = useMemo(() => new Map(queues.flatMap((q) => { const r = userReviewsOf(q, { orchestrating, away }); return r ? [[q.id, r] as const] : []; })), [queues, orchestrating, away]);
  const first = useMemo(() => firstUserWait(layout, queues, { orchestrating, away }, estimates?.queues), [layout, queues, orchestrating, away, estimates]);
  const actions: Actions = {
    ...base, targets: (q) => moveTargets(layout, queues, q), estimates, reviews, ...(first ? { first } : {}),
    move: (q, after) => base.moveReplacing(q, after, planList(layout).find((n) => n.id === q)?.before.map((b) => b.queue) ?? []),
  };
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
      {first && <FirstWaitLine first={first} />}
      {actions.error && <p className="mb-3 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger" role="alert">{actions.error}</p>}
      <div className="hidden @3xl:block"><Lanes layout={layout} onOpen={onOpen} actions={actions} /></div>
      <PhoneList layout={layout} onOpen={onOpen} actions={actions} />
      {actions.last && <UndoBar key={actions.last.change} change={actions.last} actions={actions} />}
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

/** The first point where the plan will wait for the user's review: the step, and when (now, by the estimates, or unknown). */
function FirstWaitLine({ first }: { first: FirstWait }) {
  const time = first.ms !== undefined ? estimateWords({ steps: 1, ms: first.ms }) : undefined;
  const when = first.now ? t("plan.firstWait.now") : time ? t("plan.firstWait.in", { time: say(time) }) : t("plan.firstWait.unknown");
  return (
    <p className="mb-3 flex items-baseline gap-1.5 text-xs text-review" data-plan-first-wait={`${first.queue}:${first.step}`}>
      <span className="h-1.5 w-1.5 shrink-0 -translate-y-px rounded-full bg-review" aria-hidden />
      <span className="min-w-0 [overflow-wrap:anywhere]">{t("plan.firstWait", { queue: first.queue, step: first.step, title: first.title ?? "", when })}</span>
    </p>
  );
}

/** Two measures of the cards' heights are the same. */
const sameHeights = (a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>) => a.size === b.size && [...a].every(([k, v]) => b.get(k) === v);

/**
 * The lanes (layout A, ../plan.ts drawPlan): a column per step of the plan, the cards stacked in each at the column's
 * width, and the lines routed around them. The cards are measured where they are drawn, then placed; until then the
 * plan is not shown.
 */
function Lanes({ layout, onOpen, actions }: { layout: PlanLayout; onOpen: (queue: string) => void; actions: Actions }) {
  const box = useRef<HTMLDivElement>(null);
  const cards = useRef(new Map<string, HTMLElement>());
  const [width, setWidth] = useState(0);
  const [heights, setHeights] = useState<ReadonlyMap<string, number>>(new Map());
  const [dragged, setDragged] = useState<string>();
  const [over, setOver] = useState<string>();
  const [zone, setZone] = useState<"instead" | "also">();
  /** The line clicked ("<from>><to>"), its details open under the queue it comes from. */
  const [sel, setSel] = useState<string>();
  const [panelHeight, setPanelHeight] = useState(0);
  const drawing = useMemo(() => drawPlan(layout, heights, width), [layout, heights, width]);
  const ready = width > 0 && layout.columns.every((c) => c.every((n) => heights.has(n.id)));
  const route = sel ? drawing.routes.find((r) => r.key === sel) : undefined;
  const source = route && drawing.boxes.get(route.from);
  const panelTop = source ? source.top + source.height + 10 : 0;
  const height = Math.max(drawing.height, source ? panelTop + panelHeight : 0) + 8;

  // Escape closes the details; so does a line or a queue gone from the plan.
  useEffect(() => {
    if (!sel) return;
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") setSel(undefined); };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [sel]);
  useEffect(() => { if (sel && ready && !route) setSel(undefined); }, [sel, ready, route]);
  /** A click on a line or its chip: its details open, or close if they were. */
  const toggle = (key: string) => setSel(sel === key ? undefined : key);
  const endDrag = () => { setDragged(undefined); setOver(undefined); setZone(undefined); };

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => {
      if (!el.clientWidth) return; // hidden (the phone's list shows)
      setWidth(el.clientWidth);
      const next = new Map([...cards.current].map(([id, c]) => [id, c.offsetHeight]));
      setHeights((old) => (sameHeights(old, next) ? old : next));
    };
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    for (const c of cards.current.values()) watch.observe(c);
    return () => watch.disconnect();
  }, [layout, drawing.column]);

  /**
   * Where a dragged queue may be dropped: onto another queue, which splits in two ("after it instead", "also after
   * it": the zone it is dropped on says which; elsewhere on the queue, instead), or onto "Next" (to the front).
   */
  const dropTarget = (target: string | null) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!dragged || dragged === target || (target && !dropChoices(layout, dragged, target))) return;
      e.preventDefault();
      if (over !== (target ?? "")) { setOver(target ?? ""); setZone(undefined); }
    },
    onDragLeave: (e: React.DragEvent) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) { setOver(undefined); setZone(undefined); } },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      const q = e.dataTransfer.getData("text/plain") || dragged;
      const also = zone === "also";
      endDrag();
      if (!q || q === target) return;
      if (also && target) void actions.add(q, target); else void actions.move(q, target);
    },
  });

  return (
    <div ref={box} className="scroll-thin overflow-x-auto pb-1">
      <div className={`relative ${ready ? "" : "invisible"}`} style={{ width: drawing.width, height }}>
        {layout.columns.map((col, c) => (
          <h3 key={c} {...(c === 1 ? dropTarget(null) : {})} data-plan-drop={c === 1 ? "first" : undefined} data-box={`column ${c}`}
            style={{ left: drawing.x[c], maxWidth: drawing.column }}
            className={`absolute top-0 rounded text-xs font-medium ${c === 1 && over === "" ? "bg-accent/15 text-accent" : "text-fg-3"} ${c === 1 && dragged ? "outline-1 outline-dashed outline-accent/50" : ""}`}>
            {columnTitle(c)}{c === 1 && dragged ? ` · ${t("plan.dropFirst")}` : ""}
            {!col.length && <span className="ml-2 font-normal">{t("common.nothingHere")}</span>}
          </h3>
        ))}
        {layout.columns.flat().map((n) => {
          const b = drawing.boxes.get(n.id);
          const choices = dragged && over === n.id ? dropChoices(layout, dragged, n.id) : undefined;
          return (
            <Card key={n.id} node={n} onOpen={onOpen} actions={actions} highlight={over === n.id} moving={dragged === n.id}
              style={{ position: "absolute", left: b?.left ?? 0, top: b?.top ?? 0, width: drawing.column }}
              chip={(from) => toggle(`${from}>${n.id}`)} chosen={route?.to === n.id ? route.from : undefined}
              drag={{
                draggable: n.movable,
                onDragStart: (e: React.DragEvent) => { e.dataTransfer.setData("text/plain", n.id); e.dataTransfer.effectAllowed = "move"; setDragged(n.id); setSel(undefined); },
                onDragEnd: endDrag,
                ...dropTarget(n.id),
              }}
              cardRef={(el) => { if (el) cards.current.set(n.id, el); else cards.current.delete(n.id); }}>
              {choices && <DropZones target={n.id} choices={choices} zone={zone} onZone={setZone} />}
            </Card>
          );
        })}
        <svg className="pointer-events-none absolute left-0 top-0 overflow-visible" width={drawing.width} height={height} aria-hidden>
          <defs>
            {/* The tip at the line's end, which stops a pixel before the box. */}
            <marker id="plan-arrow-user" viewBox="0 0 6 6" refX="6" refY="3" markerUnits="userSpaceOnUse" markerWidth="8" markerHeight="8" orient="auto"><path d="M0,0 L6,3 L0,6 z" className="fill-accent" /></marker>
            <marker id="plan-arrow-orchestrator" viewBox="0 0 6 6" refX="6" refY="3" markerUnits="userSpaceOnUse" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L6,3 L0,6 z" className="fill-fg-3" /></marker>
          </defs>
          {ready && drawing.routes.map((r) => {
            const lit = r.key === sel || r.key === actions.last?.edge;
            return (
              <path key={r.key} d={roundedPath(r.points)} fill="none" markerEnd={`url(#plan-arrow-${r.by})`} data-edge={r.key}
                className={r.by === "user" ? "stroke-accent" : "stroke-fg-3"} strokeWidth={(r.by === "user" ? 2 : 1.5) + (lit ? 1.5 : 0)}
                strokeDasharray={r.by === "user" ? undefined : "4 3"} opacity={sel && !lit ? 0.45 : 1}
                style={lit ? { filter: "drop-shadow(0 0 3px var(--color-accent))" } : undefined} />
            );
          })}
          {/* What a click hits: a wider band along each line, invisible. */}
          {ready && drawing.routes.map((r) => (
            <path key={`hit:${r.key}`} d={roundedPath(r.points)} fill="none" stroke="transparent" strokeWidth={12} data-plan-line={r.key}
              className="cursor-pointer" style={{ pointerEvents: "stroke" }} onClick={() => toggle(r.key)} />
          ))}
        </svg>
        {route && source && (
          <LinePanel layout={layout} from={route.from} to={route.to} actions={actions} onClose={() => setSel(undefined)} onHeight={setPanelHeight}
            style={{ position: "absolute", left: source.left, top: panelTop, width: drawing.column }} />
        )}
      </div>
    </div>
  );
}

/** A queue split in two while another is dragged over it: "after it instead" and "also after it". */
function DropZones({ target, choices, zone, onZone }: {
  target: string; choices: NonNullable<ReturnType<typeof dropChoices>>; zone?: "instead" | "also"; onZone: (z: "instead" | "also") => void;
}) {
  const half = (z: "instead" | "also", words: Words) => (
    <div data-plan-zone={`${target}:${z}`} onDragOver={(e) => { e.preventDefault(); if (zone !== z) onZone(z); }}
      className={`grid place-items-center rounded-md px-2 py-1.5 text-center text-xs ${zone === z ? "border border-accent bg-accent/15 font-semibold text-accent" : "border border-dashed border-line-strong text-fg-2"}`}>
      {say(words)}
    </div>
  );
  return (
    <div className="absolute inset-x-0 top-0 z-10 grid min-h-full auto-rows-fr gap-1 rounded-lg bg-surface p-1">
      {half("instead", choices.instead)}
      {choices.also && half("also", choices.also)}
    </div>
  );
}

/**
 * A line's details: the dependency, who set it and when, what the queue waits for besides (or that it starts as soon
 * as it may without it), and "Remove 'after X'", "Let the orchestrator decide" (the user's only), Close.
 */
function LinePanel({ layout, from, to, actions, onClose, onHeight, style }: {
  layout: PlanLayout; from: string; to: string; actions: Actions; onClose: () => void; onHeight?: (h: number) => void; style?: React.CSSProperties;
}) {
  const box = useRef<HTMLDivElement>(null);
  // In the phone's list it opens under its card: brought into view, clear of the bottom bar (its scroll margin).
  useEffect(() => { if (!onHeight) box.current?.scrollIntoView?.({ block: "nearest" }); }, [onHeight, from, to]);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || !onHeight) return;
    const measure = () => onHeight(el.offsetHeight);
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    return () => { watch.disconnect(); onHeight(0); };
  }, [onHeight]);
  const d = lineDetails(layout, from, to);
  if (!d) return null;
  return (
    <div ref={box} style={style} data-box="line details" role="dialog" aria-label={say(d.title)}
      className="z-20 scroll-mb-24 rounded-lg border border-accent bg-surface-3 px-3 py-2.5 text-xs shadow-lg max-lg:mt-1.5">
      <div className="text-sm font-semibold text-fg">{say(d.title)}</div>
      <div className="mt-0.5 text-fg-3">{say(d.setBy)}</div>
      <p className={`mt-1.5 ${d.last ? "text-warn" : "text-fg-2"}`}>{say(d.effect)}</p>
      <div className="mt-2 flex flex-col gap-1.5">
        <button onClick={() => void actions.remove(to, from).then((ok) => ok && onClose())} disabled={actions.busy} data-plan-remove={`${to}:${from}`}
          className="rounded-md border border-line-strong px-2 py-1 font-medium text-danger hover:bg-danger/10 disabled:opacity-40 max-lg:min-h-10">{say(d.remove)}</button>
        {d.handBack && (
          <button onClick={() => void actions.handBack(to, from).then((ok) => ok && onClose())} disabled={actions.busy}
            className="rounded-md border border-line-strong px-2 py-1 font-medium text-fg hover:bg-surface-4 disabled:opacity-40 max-lg:min-h-10">{t("plan.line.handBack")}</button>
        )}
        <button onClick={onClose} className="rounded-md px-2 py-1 text-fg-3 hover:bg-surface-4 hover:text-fg max-lg:min-h-10">{t("plan.line.close")}</button>
      </div>
    </div>
  );
}

/** The bar after a change of the user's to the plan: what it did, Undo, and the seconds left to undo it. */
function UndoBar({ change, actions }: { change: Change; actions: Actions }) {
  const [now, setNow] = useState(() => Date.now());
  const { dismiss } = actions;
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 250);
    const end = setTimeout(dismiss, Math.max(0, change.until - Date.now()));
    return () => { clearInterval(tick); clearTimeout(end); };
  }, [change, dismiss]);
  const left = Math.max(0, change.until - now);
  return (
    <div role="status" data-box="undo" className="relative mt-3 flex max-w-xl items-center gap-3 overflow-hidden rounded-lg border border-line-strong bg-surface-3 px-3 py-2 pb-2.5 text-sm">
      <span className="min-w-0 flex-1 text-fg">{change.words}</span>
      <Button variant="quiet" onClick={() => void actions.undo(change)} disabled={actions.busy}>{t("plan.change.undo")}</Button>
      <span className="w-8 shrink-0 text-right text-xs tabular-nums text-fg-3">{t("plan.change.seconds", { seconds: Math.ceil(left / 1000) })}</span>
      <i className="absolute bottom-0 left-0 h-[3px] bg-accent transition-[width] duration-300 ease-linear" style={{ width: `${(left / UNDO_SHOWN_MS) * 100}%` }} />
    </div>
  );
}

/** The phone's list: the columns one after another under their titles. */
function PhoneList({ layout, onOpen, actions }: { layout: PlanLayout; onOpen: (queue: string) => void; actions: Actions }) {
  const list = planList(layout);
  /** The "after" chip tapped: the line's details under its card (`to`). Dragging is the desktop's. */
  const [open, setOpen] = useState<{ from: string; to: string }>();
  return (
    <ol className="space-y-2 @3xl:hidden">
      {list.map((n, i) => {
        const from = open?.to === n.id ? open.from : undefined;
        return (
          <li key={n.id}>
            {(i === 0 || list[i - 1]!.column !== n.column) && <h3 className={`mb-1.5 text-xs font-medium text-fg-3 ${i ? "mt-4" : ""}`}>{columnTitle(n.column)}</h3>}
            <Card node={n} onOpen={onOpen} actions={actions} chosen={from} chipsDone
              chip={(f) => setOpen(from === f ? undefined : { from: f, to: n.id })} />
            {from && <LinePanel layout={layout} from={from} to={n.id} actions={actions} onClose={() => setOpen(undefined)} />}
          </li>
        );
      })}
    </ol>
  );
}

/**
 * A queue in the plan: its status now, or what it waits for and the queues before it ("set by you", with ↩ to hand it
 * back); the orchestrator's proposal with Accept and Decline; "After…" to move it. With `chip`, an "after" chip opens
 * its line's details (`chosen`: the one open); `chipsDone`: a done predecessor's too (the phone's: it has no line).
 * `moving`: it is being dragged; `children`: what lies over it (the halves of a drop target).
 */
function Card({ node: n, onOpen, actions, cardRef, drag, highlight, moving, style, chip, chosen, chipsDone, children }: {
  node: PlanNode; onOpen: (queue: string) => void; actions: Actions; cardRef?: (el: HTMLElement | null) => void;
  drag?: React.HTMLAttributes<HTMLDivElement> & { draggable?: boolean }; highlight?: boolean; moving?: boolean; style?: React.CSSProperties;
  chip?: (from: string) => void; chosen?: string; chipsDone?: boolean; children?: React.ReactNode;
}) {
  const [dot, word] = TONE[n.status.tone];
  // The id and "After…" on top, the whole title under them (it wraps, never cut short).
  return (
    <div ref={cardRef} {...drag} data-plan-card={n.id} style={style}
      className={`rounded-lg border bg-surface px-3 py-2 ${moving ? "border-dashed border-line-strong opacity-45" : highlight ? "border-accent ring-2 ring-accent/30" : n.proposal ? "border-review/50" : "border-line hover:border-line-strong"} ${n.movable && drag ? "cursor-grab active:cursor-grabbing" : ""}`}>
      {children}
      <div className="flex min-h-5 items-center gap-2">
        <span className="font-mono text-xs text-fg-3">{n.id}</span>
        <span className="flex-1" />
        {n.movable && <AfterMenu queue={n.id} actions={actions} />}
      </div>
      <button onClick={() => onOpen(n.id)} className="block w-full text-left text-sm font-medium text-fg [overflow-wrap:anywhere] hover:text-accent">{n.title}</button>
      {(n.now || !n.planned) && (
        <span className="mt-1 flex items-baseline gap-1.5 text-xs">
          <span className={`h-1.5 w-1.5 shrink-0 -translate-y-px rounded-full ${dot}`} />
          <span className={`min-w-0 [overflow-wrap:anywhere] ${word}`}>{n.now ? n.status.label : `${t("plan.notPlanned")} · ${n.status.label}`}</span>
        </span>
      )}
      {n.resting && (
        <span className="mt-1 flex items-baseline gap-1.5 text-xs" data-plan-resting={n.id}>
          <span className={`h-1.5 w-1.5 shrink-0 -translate-y-px rounded-full ${TONE[n.resting.tone][0]}`} />
          <span className={`min-w-0 [overflow-wrap:anywhere] ${TONE[n.resting.tone][1]}`}>{n.resting.label}</span>
        </span>
      )}
      <Reviews queue={n.id} actions={actions} />
      {(n.now || n.planned) && n.why.map((w) => (
        <span key={w.key} className={`mt-1 block text-xs ${WHY[w.tone]}`}>{say(w)}</span>
      ))}
      {n.before.length > 0 && (
        <span className="mt-1.5 flex flex-wrap gap-1">
          {n.before.map((b) => {
            const words = `${t("plan.after", { queue: b.queue })}${b.by === "user" ? ` · ${t("plan.setByYou")}` : ""}${b.done ? ` · ${t("plan.done")}` : ""}`;
            return (
              <span key={b.queue} className={`inline-flex max-w-full items-center gap-1 rounded px-1.5 py-0.5 text-[11px] ${b.done ? "bg-surface-3 text-fg-3" : b.by === "user" ? "bg-accent/15 text-accent" : "bg-surface-3 text-fg-2"} ${chosen === b.queue ? "outline-2 outline-offset-1 outline-accent" : ""}`}>
                {chip && (chipsDone || !b.done)
                  ? <button onClick={() => chip(b.queue)} aria-expanded={chosen === b.queue} data-plan-chip={`${n.id}:${b.queue}`}
                    className="text-left hover:underline max-lg:min-h-6">{words}</button>
                  : words}
                {b.by === "user" && (
                  <button onClick={() => void actions.handBack(n.id, b.queue)} disabled={actions.busy} data-plan-handback={`${n.id}:${b.queue}`}
                    title={t("plan.handBack")} aria-label={t("plan.handBack")} className="-mr-0.5 rounded px-0.5 hover:bg-accent/20 disabled:opacity-40">↩</button>
                )}
              </span>
            );
          })}
        </span>
      )}
      <Estimate queue={n.id} estimates={actions.estimates} />
      {n.proposal && <Proposal queue={n.id} proposal={n.proposal} current={n.before.map((b) => b.queue)} actions={actions} />}
    </div>
  );
}

/** What the queue's steps left are expected to take, marked as an estimate (or that there is none yet). */
/** The steps left for the user's review on a card: how many, the next by its name; "first wait for you" on the first. */
function Reviews({ queue, actions }: { queue: string; actions: Actions }) {
  const r = actions.reviews.get(queue);
  if (!r) return null;
  const first = actions.first?.queue === queue;
  return (
    <span className="mt-1 block text-xs text-review [overflow-wrap:anywhere]" data-plan-reviews={queue}>
      {first && <span className="mr-1 rounded bg-review/15 px-1 py-px font-medium">{t("plan.firstWait.mark")}</span>}
      {t("plan.reviews", { count: r.count, step: r.next.id, title: r.next.title ?? "" })}
    </span>
  );
}

function Estimate({ queue, estimates }: { queue: string; estimates?: EstimatesResponse }) {
  const words = estimateWords(estimates?.queues[queue]);
  if (!words || !estimates) return null;
  const title = estimates.samples < estimates.min ? t("plan.estimate.tooFew", { min: estimates.min }) : t("plan.estimate.title", { samples: estimates.samples });
  return <span className="mt-1 block text-[11px] italic text-fg-3" title={title} data-plan-estimate={queue}>{say(words)}</span>;
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
