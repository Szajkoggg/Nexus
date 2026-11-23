// The plan's time axis (../planTime.ts; docs/ux/plan-view-modes.md, "The time axis: the estimate contract"): a row per
// queue in the plan's order, its title and note on the left, its bar on a ruler from now on the right, proportional to
// time; no lines (the starts show the order) and no dragging. Hatched: after a wait of unknown length (a review, an
// answer, an approval, a checkout), always with the row's "if …" beside it; dotted: a wait Nexus keeps by itself; a
// diamond: a step that waits for the user's review. On the phone the ruler is on top, each queue's title over its row.
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { formatDayName, formatTimeOfDay, t } from "../i18n.ts";
import type { MarkLook, Words } from "../plan.ts";
import { rulerTicks, timeSpan, type TimeAxis, type TimeRow } from "../planTime.ts";

const H = 3_600_000;
const say = (w: Words) => t(w.key, w.params);
/** The left column with the titles (desktop), and the room between it and the ruler. */
const LABEL = 250, GAP = 12;
/** An hour's least width; a longer plan scrolls sideways. */
const MIN_PX_HOUR = 22;
/** An open bar (its work unknown): how long it is drawn, faded at its end. */
const OPEN_MS = 2.5 * H;

/** A bar's length in words: "40 min", "3.5 h". */
function lengthWords(ms: number): string {
  const min = ms / 60_000;
  if (min < 55) return t("plan.time.minutes", { minutes: Math.max(5, Math.round(min / 5) * 5) });
  return t("plan.time.hours", { hours: Math.round((min / 60) * 2) / 2 });
}

/** The legend of the axis's signs. */
export function TimeLegend({ className = "" }: { className?: string }) {
  return (
    <span className={`items-center gap-3 text-xs text-fg-3 ${className}`} data-box="time legend">
      <span className="flex items-center gap-1.5"><i className="inline-block h-2 w-2 rotate-45 bg-review" aria-hidden />{t("plan.time.legend.review")}</span>
      <span className="flex items-center gap-1.5"><i className="inline-block h-2.5 w-5 rounded-sm border border-dashed border-line-strong bg-[repeating-linear-gradient(135deg,var(--color-surface-3)_0_4px,var(--color-surface-2)_4px_8px)]" aria-hidden />{t("plan.time.legend.cond")}</span>
      <span className="flex items-center gap-1.5"><i className="inline-block h-1.5 w-5 border-b-2 border-dotted border-warn" aria-hidden />{t("plan.time.legend.wait")}</span>
    </span>
  );
}

const HATCH = "bg-[repeating-linear-gradient(135deg,var(--color-surface-3)_0_6px,var(--color-surface-2)_6px_12px)]";
const SOLID: Record<TimeRow["tone"], string> = {
  running: "bg-accent/35 border-accent text-fg", usage: "bg-warn/25 border-warn text-fg", planned: "bg-surface-3 border-line-strong text-fg-2",
};

/** One row's marks on a track `width` px wide, `px` per ms. */
function Track({ r, now, px, width, look }: { r: TimeRow; now: Date; px: number; width: number; look?: ReturnType<MarkLook["card"]> }) {
  const x = (ms: number) => Math.min(width, ms * px);
  const out: ReactNode[] = [];
  if (r.wait && r.wait[1] > r.wait[0]) {
    out.push(<i key="wait" className="absolute top-0 h-[11px] border-b-2 border-dotted border-warn" style={{ left: x(r.wait[0]), width: Math.max(0, x(r.wait[1]) - x(r.wait[0]) - 2) }} />);
  }
  const ring = look === "path" ? "ring-1 ring-warn" : look === "root" ? "ring-1 ring-review" : "";
  if (r.start !== undefined) {
    const open = r.end === undefined;
    const left = open ? Math.max(0, Math.min(x(r.start), width - 96)) : x(r.start);
    const right = open ? Math.min(width, Math.max(left + 96, x(r.start + OPEN_MS))) : Math.max(left + 6, x(r.end!));
    const cut = r.cond === undefined ? right : Math.max(left, Math.min(right, x(r.cond)));
    const words = open ? (r.open ? say(r.open) : "") : lengthWords(r.end! - r.start);
    const fits = right - left >= (open ? 0 : 44);
    out.push(
      <span key="bar" data-box={`bar ${r.id}`} data-plan-bar={r.id} data-plan-cond={r.cond !== undefined ? "" : undefined}
        className={`absolute top-0 h-[22px] overflow-hidden rounded-md border text-[11px] leading-5 ${r.cond !== undefined && cut === left ? "border-dashed border-line-strong text-fg-2" : SOLID[r.tone]} ${ring}`}
        style={{ left, width: right - left, ...(open ? { maskImage: "linear-gradient(to right, black 60%, transparent)" } : {}) }}>
        {cut < right && <i className={`absolute inset-y-0 right-0 ${HATCH}`} style={{ left: cut - left }} aria-hidden />}
        {fits && <span className="relative whitespace-nowrap px-1.5">{words}</span>}
      </span>,
    );
  } else if (!r.blocked) {
    // No bar: in its order, after what it waits for; "not before" what is known.
    const at = r.notBefore !== undefined ? x(r.notBefore) : 0;
    const words = `${r.notBefore !== undefined ? t("plan.time.notBefore", { time: formatTimeOfDay(new Date(now.getTime() + r.notBefore)) }) : r.note[0] ? say(r.note[0]) : ""} · ?`;
    out.push(<span key="text" data-box={`order ${r.id}`} className="absolute top-0 whitespace-nowrap text-[11px] italic leading-[22px] text-fg-3"
      style={at > width / 2 ? { right: Math.max(0, width - at) } : { left: at + 4 }}>{words}</span>);
  }
  for (const m of r.marks) out.push(<i key={`m${m}`} className="absolute top-[5px] z-[1] h-[11px] w-[11px] rotate-45 border-2 border-canvas bg-review" style={{ left: x(m) - 6 }} aria-hidden />);
  return <>{out}</>;
}

/** The hour marks over the axis: "now 21:10", whole hours, the new day's name at midnight; none crowds another. */
function Ruler({ now, span, px, width, short }: { now: Date; span: number; px: number; width: number; short?: boolean }) {
  const nowWords = short ? t("plan.time.nowShort") : t("plan.time.now", { time: formatTimeOfDay(now) });
  const items: { left: number; text: string; day: boolean }[] = [];
  let end = nowWords.length * 6.5 + 8;
  for (const tk of rulerTicks(now, span, px * H)) {
    const text = tk.day ? t("time.dayClock", { date: formatDayName(tk.date), clock: formatTimeOfDay(tk.date) }) : formatTimeOfDay(tk.date);
    const w = text.length * 6.5 + 4;
    const left = tk.day ? tk.ms * px - 4 : tk.ms * px - w / 2;
    if (left < end + 6 || left + w > width) continue;
    items.push({ left, text, day: tk.day });
    end = left + w;
  }
  return (
    <div className="relative h-[22px]" data-box="ruler">
      <span className="absolute left-0 top-0.5 whitespace-nowrap text-[11px] font-semibold text-accent">{nowWords}</span>
      {items.map((i) => <span key={i.text} className={`absolute top-0.5 whitespace-nowrap text-[11px] ${i.day ? "font-semibold text-fg-2" : "text-fg-3"}`} style={{ left: i.left }}>{i.text}</span>)}
    </div>
  );
}

/** The hour lines behind a track, and now's. */
function Grid({ now, span, px }: { now: Date; span: number; px: number }) {
  return (
    <span className="pointer-events-none absolute inset-y-0 left-0 right-0" aria-hidden>
      <i className="absolute inset-y-0 left-0 w-[1.5px] bg-accent" />
      {rulerTicks(now, span, px * H).map((tk) => <i key={tk.ms} className="absolute inset-y-0 w-px bg-line" style={{ left: tk.ms * px }} />)}
    </span>
  );
}

/** A row's title (it opens the queue, or under What blocks exactly what it waits for) and its note. */
function Label({ r, onOpen }: { r: TimeRow; onOpen: (queue: string) => void }) {
  return (
    <div data-box={`label ${r.id}`} className="min-w-0 text-[13px] leading-snug">
      <button onClick={() => onOpen(r.id)} className="text-left font-semibold text-fg [overflow-wrap:anywhere] hover:text-accent">
        <span className="mr-1 font-mono text-xs font-normal text-fg-3">{r.id}</span>{r.title}
      </button>
      <span className="block text-[11.5px] text-fg-3 [overflow-wrap:anywhere]" data-plan-note={r.id}>{r.note.map(say).join("; ")}</span>
    </div>
  );
}

/**
 * The time axis, on a desktop and on the phone. `look`: the mark's (critical path, what blocks): rows on the path or
 * roots ringed, the rest dimmed. `notice`: why the estimates are not used (too few steps, a failed fetch, with Retry).
 */
export function TimeView({ axis, now, onOpen, look, notice }: {
  axis: TimeAxis; now: Date; onOpen: (queue: string) => void; look?: MarkLook; notice?: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null), phone = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0), [phoneWidth, setPhoneWidth] = useState(0);
  useLayoutEffect(() => {
    const measure = () => { setWidth(box.current?.clientWidth ?? 0); setPhoneWidth(phone.current?.clientWidth ?? 0); };
    measure();
    const watch = new ResizeObserver(measure);
    if (box.current) watch.observe(box.current);
    if (phone.current) watch.observe(phone.current);
    return () => watch.disconnect();
  }, []);
  const span = timeSpan(axis, OPEN_MS);
  const track = Math.max(span / H * MIN_PX_HOUR, width - LABEL - GAP - 4);
  const px = track / span;
  const pTrack = Math.max(0, phoneWidth - 4), ppx = pTrack / span;
  const dim = (id: string) => (look?.card(id) === "dim" ? "opacity-40" : "");
  return (
    <div data-plan-time>
      {notice}
      <div ref={box} className="scroll-thin hidden overflow-x-auto pb-1 @3xl:block">
        {width > 0 && (
          <div style={{ width: LABEL + GAP + track + 4 }}>
            <div className="flex"><span style={{ width: LABEL + GAP }} className="shrink-0" /><div style={{ width: track }}><Ruler now={now} span={span} px={px} width={track} /></div></div>
            {axis.rows.map((r) => (
              <div key={r.id} className={`flex ${dim(r.id)}`} data-plan-row={r.id} data-plan-look={look?.card(r.id)}>
                <div style={{ width: LABEL }} className="shrink-0 pb-3"><Label r={r} onOpen={onOpen} /></div>
                <span style={{ width: GAP }} className="shrink-0" />
                <div className="relative shrink-0" style={{ width: track }}>
                  <Grid now={now} span={span} px={px} />
                  <div className="relative mt-1 h-[22px]"><Track r={r} now={now} px={px} width={track} look={look?.card(r.id)} /></div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      <div ref={phone} className="@3xl:hidden">
        {phoneWidth > 0 && <>
          <div className="mb-1.5 border-b border-line"><Ruler now={now} span={span} px={ppx} width={pTrack} short /></div>
          {axis.rows.map((r) => (
            <div key={r.id} className={`border-b border-line/60 py-2 ${dim(r.id)}`} data-plan-row={r.id}>
              <Label r={r} onOpen={onOpen} />
              <div className="relative mt-1.5 h-[22px]" style={{ width: pTrack }}>
                <i className="absolute inset-y-0 left-0 w-[1.5px] bg-accent" aria-hidden />
                <Track r={r} now={now} px={ppx} width={pTrack} look={look?.card(r.id)} />
              </div>
            </div>
          ))}
        </>}
      </div>
    </div>
  );
}
