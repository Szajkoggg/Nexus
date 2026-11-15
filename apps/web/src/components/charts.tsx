// The chart forms of the Stats views, drawn as SVG in the theme's tokens and following Claude Code's dataviz skill
// (docs/ux/stats-mockups.md): one series colour (--color-series), thin marks with a 4 px rounded data end and a square
// base, hairline solid grid, dashed lines only for a reference (a threshold, a target), the end value labelled, text in
// the text tokens, a tooltip on hover and keyboard focus over a hit area larger than the mark (values first, then
// what they are), and every chart beside a table view (ChartCard). No chart library: the forms are few and small.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** A tooltip's lines: the first is the value (strong), the rest say what it is. */
export type TipLines = string[];

/** The width of an element, followed as it changes (the charts draw to it). */
function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const watch = new ResizeObserver(() => setWidth(el.clientWidth));
    watch.observe(el);
    return () => watch.disconnect();
  }, []);
  return [ref, width];
}

interface Hover { x: number; y: number; lines: TipLines }
/** One tooltip per chart, at the pointer (or beside the focused mark), above everything. */
function useTip() {
  const [hover, setHover] = useState<Hover | null>(null);
  const props = (lines: TipLines) => ({
    tabIndex: 0,
    "aria-label": lines.join(", "),
    onPointerMove: (e: React.PointerEvent) => setHover({ x: e.clientX, y: e.clientY, lines }),
    onPointerLeave: () => setHover(null),
    onFocus: (e: React.FocusEvent<SVGElement>) => { const r = e.currentTarget.getBoundingClientRect(); setHover({ x: r.right, y: r.top, lines }); },
    onBlur: () => setHover(null),
  });
  const tip = hover && createPortal(
    <div role="tooltip" className="pointer-events-none fixed z-50 max-w-72 rounded-lg border border-line-strong bg-surface-3 px-2.5 py-1.5 text-xs shadow-2xl"
      style={{ left: Math.min(hover.x + 14, window.innerWidth - 300), top: hover.y + 14 }}>
      {hover.lines.map((l, i) => <div key={i} className={i === 0 ? "text-[13px] font-semibold text-fg" : "text-fg-3"}>{l}</div>)}
    </div>,
    document.body,
  );
  return { props, tip };
}

/** A column from the baseline y0 up to y1, its top rounded (4 px), its base square. */
const colPath = (x: number, y0: number, y1: number, w: number, r = 4) => {
  const h = y0 - y1; r = Math.min(r, h, w / 2);
  return `M${x} ${y0}V${y1 + r}Q${x} ${y1} ${x + r} ${y1}H${x + w - r}Q${x + w} ${y1} ${x + w} ${y1 + r}V${y0}Z`;
};
/** A bar from x0 right to x1, its end rounded (4 px), its base square. */
const barPath = (x0: number, x1: number, y: number, h: number, r = 4) => {
  const w = x1 - x0; r = Math.min(r, w, h / 2);
  return `M${x0} ${y}H${x1 - r}Q${x1} ${y} ${x1} ${y + r}V${y + h - r}Q${x1} ${y + h} ${x1 - r} ${y + h}H${x0}Z`;
};

const AX = "fill-fg-3 text-[10px] tabular-nums";
const LABEL = "fill-fg-2 text-[11px] tabular-nums";

export interface TimePoint {
  value: number | null; tip: TipLines;
  /** Beyond a warning threshold: the warn colour and ⚠ with the value (a dot on a line, the column itself). */
  warn?: boolean;
}
export interface Reference { value: number; label: string; tone: "warn" | "target" }

/**
 * A chart over time or over steps: columns (a value per day or step, from zero) or a line, one series; the line with
 * a 10 % wash (`area`, a level) or a dot on every value (`dots`, each a step of its own); the reference lines dashed
 * and labelled at the right; the line's last value labelled. A day without a value draws nothing (a column) or is
 * passed over (the line joins its neighbours). With `onPick` a value is a link: a click or Enter on it picks it.
 */
export function TimeChart({ kind, points, min = 0, max, ticks, format, xLabels, refs = [], end, height = 128, area, dots, onPick, valueLabel = format }: {
  kind: "columns" | "line"; points: TimePoint[]; min?: number; max: number; ticks: number[]; format: (v: number) => string;
  xLabels: [number, string][]; refs?: Reference[]; end?: string; height?: number; area?: boolean; dots?: boolean;
  onPick?: (i: number) => void;
  /** How a value beyond the threshold is written beside its mark (default: as the ticks). */
  valueLabel?: (v: number) => string;
}) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const { props, tip } = useTip();
  const m = { l: 36, r: 62, t: 14, b: 20 };
  const pw = Math.max(0, w - m.l - m.r), ph = height - m.t - m.b;
  const band = points.length ? pw / points.length : 0;
  const X = (i: number) => m.l + band * i + band / 2;
  const Y = (v: number) => m.t + ph - ((Math.min(Math.max(v, min), max) - min) / (max - min || 1)) * ph;
  const known = points.map((p, i) => [p, i] as const).filter(([p]) => p.value !== null) as (readonly [TimePoint & { value: number }, number])[];
  const line = known.map(([p, i], k) => `${k ? "L" : "M"}${X(i)} ${Y(p.value)}`).join("");
  const last = known.at(-1);
  const cw = Math.min(24, Math.max(2, band - 2));
  const pick = (i: number) => onPick && {
    onClick: () => onPick(i),
    onKeyDown: (e: React.KeyboardEvent) => { if (e.key === "Enter") { e.preventDefault(); onPick(i); } },
    role: "link",
  };
  return (
    <div ref={ref}>
      {w > 0 && (
        <svg width={w} height={height} role="img" className="block overflow-visible">
          {ticks.map((t) => <g key={t}>
            {/* A reference line at a tick takes its place: one line there, the dashed one. */}
            {!refs.some((r) => r.value === t) && <line x1={m.l} x2={w - m.r} y1={Y(t)} y2={Y(t)} className={t === min ? "stroke-line-strong" : "stroke-line"} />}
            <text x={m.l - 6} y={Y(t) + 3} textAnchor="end" className={AX}>{format(t)}</text>
          </g>)}
          {xLabels.map(([i, label]) => <text key={i} x={X(i)} y={height - 4} textAnchor="middle" className={AX}>{label}</text>)}
          {refs.map((r) => <g key={r.label}>
            <line x1={m.l} x2={w - m.r} y1={Y(r.value)} y2={Y(r.value)} strokeDasharray="4 3" className={r.tone === "warn" ? "stroke-warn" : "stroke-fg-2"} />
            <text x={w - m.r + 4} y={Y(r.value) + 3} className={AX}>{r.label}</text>
          </g>)}
          {kind === "line" && line && <>
            {area && <path d={`${line}L${X(last![1])} ${Y(min)}L${X(known[0]![1])} ${Y(min)}Z`} className="fill-series" opacity={0.1} />}
            <path d={line} fill="none" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" className="stroke-series" />
          </>}
          {points.map((p, i) => p.value === null ? null : (
            <g key={i}>
              {kind === "columns" && p.value > min && <path d={colPath(X(i) - cw / 2, Y(min), Y(p.value), cw)} className={`pointer-events-none ${p.warn ? "fill-warn" : "fill-series"}`} />}
              {kind === "line" && (dots || p.warn) && <circle cx={X(i)} cy={Y(p.value)} r={p.warn ? 5 : 4} strokeWidth={2} className={`pointer-events-none stroke-surface ${p.warn ? "fill-warn" : "fill-series"}`} />}
              {p.warn && <text x={X(i)} y={Y(p.value) - 8} textAnchor="middle" className="pointer-events-none fill-fg text-[11px] tabular-nums">{kind === "line" ? `⚠ ${valueLabel(p.value)}` : "⚠"}</text>}
              <rect x={X(i) - Math.max(band, 24) / 2} y={0} width={Math.max(band, 24)} height={m.t + ph} fill="transparent"
                className={`outline-none ${onPick ? "cursor-pointer" : "cursor-default"}`} {...props(p.tip)} {...pick(i)} />
            </g>
          ))}
          {kind === "line" && last && <>
            {!dots && !last[0].warn && <circle cx={X(last[1])} cy={Y(last[0].value)} r={4} strokeWidth={2} className="pointer-events-none fill-series stroke-surface" />}
            {end && !last[0].warn && <text x={X(last[1]) + 8} y={Y(last[0].value) + 4} className="pointer-events-none fill-fg text-[11px] font-semibold tabular-nums">{end}</text>}
          </>}
        </svg>
      )}
      {tip}
    </div>
  );
}

/** A 12-point sparkline beside a number: the de-emphasis ink, the current value a dot in the series colour. */
export function Sparkline({ values, height = 48 }: { values: number[]; height?: number }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const lo = Math.min(...values), hi = Math.max(...values);
  const X = (i: number) => 4 + (i / Math.max(1, values.length - 1)) * (w - 10);
  const Y = (v: number) => 5 + (1 - (v - lo) / (hi - lo || 1)) * (height - 10);
  return (
    <div ref={ref} className="min-w-0 flex-1" aria-hidden="true">
      {w > 0 && values.length > 1 && <svg width={w} height={height} className="block overflow-visible">
        <path d={values.map((v, i) => `${i ? "L" : "M"}${X(i)} ${Y(v)}`).join("")} fill="none" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" className="stroke-fg-3" />
        <circle cx={X(values.length - 1)} cy={Y(values.at(-1)!)} r={4} strokeWidth={2} className="fill-series stroke-surface" />
      </svg>}
    </div>
  );
}

const CELL = 36;

/** A comparison cell: a bar from zero with its value at the tip; a few-data group in the de-emphasis grey. */
export function BarCell({ value, max, label, few, tip, second }: {
  value: number; max: number; label: string; few?: boolean; tip: TipLines;
  /** A second bar under the first (a group with steps on two runtimes: each weekly window). */
  second?: { value: number; label: string; tip: TipLines };
}) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const { props, tip: shown } = useTip();
  const room = 72, pw = Math.max(0, w - room);
  const bar = (v: number, y: number, h: number, text: string, lines: TipLines) => {
    const x1 = Math.max(2, (Math.min(v, max) / max) * pw);
    return <g>
      <rect x={0} y={y - 4} width={w} height={h + 8} fill="transparent" className="outline-none" {...props(lines)} />
      <path d={barPath(0, x1, y, h)} className={`pointer-events-none ${few ? "fill-fg-3" : "fill-series"}`} />
      <text x={x1 + 6} y={y + h / 2 + 4} className={`pointer-events-none ${LABEL}`}>{text}</text>
    </g>;
  };
  return (
    <div ref={ref} className="h-9">
      {w > 0 && <svg width={w} height={CELL} role="img" className="block overflow-visible">
        {second ? <>{bar(value, 7, 9, label, tip)}{bar(second.value, 20, 9, second.label, second.tip)}</> : bar(value, 12, 12, label, tip)}
      </svg>}
      {shown}
    </div>
  );
}

/** A comparison cell: a dot on a scale from `min` (rounds start at 1), optionally a range line (the middle half). */
export function DotCell({ value, min = 0, max, low, high, label, few, tip }: {
  value: number; min?: number; max: number; low?: number; high?: number; label: string; few?: boolean; tip: TipLines;
}) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const { props, tip: shown } = useTip();
  const pw = Math.max(0, w - 52);
  const X = (v: number) => 6 + ((Math.min(Math.max(v, min), max) - min) / (max - min)) * pw;
  return (
    <div ref={ref} className="h-9">
      {w > 0 && <svg width={w} height={CELL} role="img" className="block overflow-visible">
        <line x1={6} x2={6 + pw} y1={18} y2={18} className="stroke-line" />
        <rect x={0} y={0} width={w} height={CELL} fill="transparent" className="outline-none" {...props(tip)} />
        {low !== undefined && high !== undefined && <line x1={X(low)} x2={X(high)} y1={18} y2={18} strokeWidth={2} strokeLinecap="round" className="pointer-events-none stroke-fg-3" />}
        <circle cx={X(value)} cy={18} r={5} strokeWidth={2} className={`pointer-events-none ${few ? "fill-surface stroke-fg-3" : "fill-series stroke-surface"}`} />
        <text x={Math.max(X(high ?? value), X(value)) + 9} y={22} className={`pointer-events-none ${LABEL}`}>{label}</text>
      </svg>}
      {shown}
    </div>
  );
}

/** The ticks under a comparison column, on the same scale as its cells (`room`: what the cells keep for labels). */
export function AxisCell({ ticks, min = 0, max, format, room, inset = 0 }: { ticks: number[]; min?: number; max: number; format: (v: number) => string; room: number; inset?: number }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const pw = Math.max(0, w - room);
  return (
    <div ref={ref} className="h-4">
      {w > 0 && <svg width={w} height={16} className="block overflow-visible">
        {ticks.map((t) => <text key={t} x={inset + ((t - min) / (max - min)) * pw} y={11} textAnchor={t === min ? "start" : "middle"} className={AX}>{format(t)}</text>)}
      </svg>}
    </div>
  );
}

export interface ScatterPoint { key: string; x: number; y: number; low?: number; high?: number; label: string; few?: boolean; tip: TipLines }

/**
 * A scatter of a few groups: x and y on their own scales, each dot directly labelled (beside the end of its range
 * line, on the left where the right is the plot's edge); a few-data group as a hollow grey dot.
 */
export function Scatter({ points, xMax, yMin, yMax, xTicks, yTicks, xFormat, yFormat, xTitle, yTitle, height = 240 }: {
  points: ScatterPoint[]; xMax: number; yMin: number; yMax: number; xTicks: number[]; yTicks: number[];
  xFormat: (v: number) => string; yFormat: (v: number) => string; xTitle: string; yTitle: string; height?: number;
}) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const { props, tip } = useTip();
  const m = { l: 40, r: 16, t: 16, b: 30 };
  const X = (v: number) => m.l + (Math.min(v, xMax) / xMax) * (w - m.l - m.r);
  const Y = (v: number) => m.t + (1 - (Math.min(Math.max(v, yMin), yMax) - yMin) / (yMax - yMin)) * (height - m.t - m.b);
  return (
    <div ref={ref}>
      {w > 0 && <svg width={w} height={height} role="img" className="block overflow-visible">
        <text x={2} y={6} className={AX}>{yTitle}</text>
        {yTicks.map((t) => <g key={t}>
          <line x1={m.l} x2={w - m.r} y1={Y(t)} y2={Y(t)} className={t === yMin ? "stroke-line-strong" : "stroke-line"} />
          <text x={m.l - 6} y={Y(t) + 3} textAnchor="end" className={AX}>{yFormat(t)}</text>
        </g>)}
        {xTicks.map((t) => <text key={t} x={X(t)} y={height - 14} textAnchor="middle" className={AX}>{xFormat(t)}</text>)}
        <text x={w - m.r} y={height - 1} textAnchor="end" className={AX}>{xTitle}</text>
        {points.map((p) => <g key={p.key}>
          {p.low !== undefined && p.high !== undefined && <line x1={X(p.low)} x2={X(p.high)} y1={Y(p.y)} y2={Y(p.y)} strokeWidth={2} strokeLinecap="round" className="pointer-events-none stroke-fg-3" />}
        </g>)}
        {placeLabels(points, X, Y, xMax).map(({ p, x, y, anchor, moved }) => <g key={p.key}>
          <circle cx={X(p.x)} cy={Y(p.y)} r={14} fill="transparent" className="outline-none" {...props(p.tip)} />
          <circle cx={X(p.x)} cy={Y(p.y)} r={5} strokeWidth={2} className={`pointer-events-none ${p.few ? "fill-surface stroke-fg-3" : "fill-series stroke-surface"}`} />
          {moved && <line x1={X(p.x)} y1={Y(p.y)} x2={anchor === "end" ? x + 2 : x - 2} y2={y - 4} className="pointer-events-none stroke-line-strong" />}
          <text x={x} y={y} textAnchor={anchor} className={`pointer-events-none ${LABEL}`}>{p.label}</text>
        </g>)}
      </svg>}
      {tip}
    </div>
  );
}

/**
 * Where a scatter's labels go: beside the end of a point's range line (on the left where the right is the plot's
 * edge), moved up or down a line at a time while it would cover a label already placed or another point's dot or
 * range line; a moved label gets a thin leader to its dot. The width of a label is estimated from its length (11 px
 * text).
 */
function placeLabels(points: ScatterPoint[], X: (v: number) => number, Y: (v: number) => number, xMax: number) {
  const placed: { x0: number; x1: number; y: number; key?: string }[] = points.map((p) => ({
    key: p.key, x0: X(p.low ?? p.x) - 7, x1: X(p.high ?? p.x) + 7, y: Y(p.y) + 4,
  }));
  const out: { p: ScatterPoint; x: number; y: number; anchor: "start" | "end"; moved: boolean }[] = [];
  for (const p of [...points].sort((a, b) => b.y - a.y)) {
    const left = (p.high ?? p.x) > xMax * 0.8;
    const x = left ? X(p.low ?? p.x) - 6 : X(p.high ?? p.x) + 6;
    const width = p.label.length * 6.2;
    const [x0, x1] = left ? [x - width, x] : [x, x + width];
    const base = Y(p.y) + 4;
    let y = base;
    for (const shift of [0, -13, 13, -26, 26, -39, 39]) {
      y = base + shift;
      if (!placed.some((b) => b.key !== p.key && Math.abs(b.y - y) < 12 && b.x0 < x1 && x0 < b.x1)) break;
    }
    placed.push({ x0, x1, y });
    out.push({ p, x, y, anchor: left ? "end" : "start", moved: y !== base });
  }
  return out;
}

/** A segmented switch: the views of a card, the range, the grouping. */
export function Segmented<T extends string>({ options, value, onChange, small, label }: {
  options: { value: T; label: string }[]; value: T; onChange: (v: T) => void; small?: boolean; label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex shrink-0 overflow-hidden rounded-lg border border-line-strong">
      {options.map((o) => (
        <button key={o.value} role="radio" aria-checked={o.value === value} onClick={() => onChange(o.value)}
          className={`whitespace-nowrap border-l border-line-strong first:border-l-0 ${small ? "px-2 py-0.5 text-[11px]" : "px-2.5 py-1 text-xs"} ${o.value === value ? "bg-surface-3 font-semibold text-fg" : "text-fg-2 hover:bg-surface-2"}`}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** A chart's card: its title and caption, its views (the chart, the table…) behind a switch in the corner. */
export function ChartCard<T extends string>({ title, heading, caption, views, initial, store, children }: {
  title: string;
  /** The title as shown, when it is more than text (a metric's name in mono with its unit); `title` names the switch. */
  heading?: ReactNode;
  caption?: ReactNode; views: { value: T; label: string }[]; initial: T;
  /** A localStorage key that keeps the view picked across visits. */
  store?: string;
  children: (view: T) => ReactNode;
}) {
  const [view, setView] = useState<T>(() => {
    const kept = store ? localStorage.getItem(store) : null;
    return views.some((v) => v.value === kept) ? (kept as T) : initial;
  });
  useEffect(() => { if (store) localStorage.setItem(store, view); }, [store, view]);
  return (
    <section className="min-w-0 rounded-xl border border-line bg-surface px-3.5 pb-2.5 pt-3">
      <div className="flex items-start gap-2">
        <h3 className="min-w-0 flex-1 text-[13px] font-semibold text-fg">{heading ?? title}</h3>
        <Segmented options={views} value={view} onChange={setView} small label={title} />
      </div>
      {caption && <p className="mt-0.5 text-xs text-fg-3">{caption}</p>}
      <div className="mt-1.5">{children(view)}</div>
    </section>
  );
}

/** A chart's table view: the same values, readable without the chart, numbers aligned. */
export function DataTable({ head, rows }: { head: string[]; rows: (string | number)[][] }) {
  return (
    <div className="scroll-thin max-h-56 overflow-auto">
      <table className="w-full border-collapse text-xs tabular-nums">
        <thead className="sticky top-0 bg-surface"><tr>{head.map((h, i) => <th key={i} className={`border-b border-line px-1.5 py-1 font-semibold text-fg-3 ${i ? "text-right" : "text-left"}`}>{h}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} className={`whitespace-nowrap border-b border-line px-1.5 py-1 ${j ? "text-right text-fg-2" : "text-left text-fg"}`}>{c}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}
