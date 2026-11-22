// The global Stats view (queue ST3, the mockup docs/ux/mockups/20-stats-global.html and the reasons for each form in
// docs/ux/stats-mockups.md): the subscription's usage windows day by day, and how steps went by model or effort,
// narrowed by project and tag. Opened from the desktop's sidebar or the phone's project picker; a page of its own,
// across every project. Its data is made ready in stats.ts; the forms are in charts.tsx.
import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { STAT_FILTERS, type StatFilter, type StatsReport, type UsageDays } from "@nexus/protocol/stats";
import { useQuery, type ProjectSummary } from "../api.ts";
import { usePage } from "../page.ts";
import { formatDate, formatDay, formatWeekday, t, type Key } from "../i18n.ts";
import {
  RANGES, compareRows, compareScales, dayOf, daysUrl, estimate, groupLabel, headline, rangeSinceIso, statsUrl, windowPanels,
  type CompareRow, type Range, type WindowPanel,
} from "../stats.ts";
import { AxisCell, BarCell, ChartCard, DataTable, DotCell, Scatter, Segmented, TimeChart, type ScatterPoint } from "./charts.tsx";
import { ServerSpeed } from "./ServerSpeed.tsx";
import { runtimeName } from "../runtimes.ts";

const RANGE_LABEL: Record<Range, Key> = { "7d": "stats.range.7d", "30d": "stats.range.30d", "90d": "stats.range.90d", all: "stats.range.all" };
const FACET_LABEL: Record<(typeof STAT_FILTERS)[number], Key> = { kind: "stats.facet.kind", activity: "stats.facet.activity", area: "stats.facet.area", size: "stats.facet.size", origin: "stats.facet.origin" };

const pct = (v: number) => `${Math.round(v)} %`;
/** A row's stops, and how many of its stopped steps continued elsewhere (a stop by design, not a step lost). */
const stopsCell = (r: Pick<CompareRow, "stops" | "continued">) =>
  r.continued ? <span title={t("stats.stopsContinued", { count: r.continued })}>{r.stops} <span className="text-ok/80">· {r.continued} →</span></span> : r.stops;
const mins = (v: number) => (v > 0 && v < 1 ? t("stats.underMinute") : t("stats.minutes", { n: Math.round(v) }));

/**
 * The version the view reads at: the page's cross-project version, followed at most once a minute (the report is
 * computed over every project and turn; a live message a second would recompute it for nothing).
 */
function useCalmVersion(): string | number | undefined {
  const { all } = usePage();
  const [v, setV] = useState(all);
  const last = useRef(0);
  useEffect(() => {
    const wait = Math.max(0, last.current + 60_000 - Date.now());
    const id = setTimeout(() => { last.current = Date.now(); setV(all); }, wait);
    return () => clearTimeout(id);
  }, [all]);
  return v;
}
/** The last answer while the next is on its way: the charts stay, dimmed, instead of flashing empty. */
function useHeld<T>(data: T | undefined): { shown: T | undefined; stale: boolean } {
  const held = useRef<T | undefined>(data);
  if (data !== undefined) held.current = data;
  return { shown: data ?? held.current, stale: data === undefined && held.current !== undefined };
}

export function StatsView({ projects, phone }: { projects: ProjectSummary[]; phone: boolean }) {
  const [range, setRange] = useState<Range>("30d");
  const [by, setBy] = useState<"model" | "effort">("model");
  const [project, setProject] = useState("");
  const [filter, setFilter] = useState<StatFilter>({});
  const version = useCalmVersion();
  const report = useHeld(useQuery<StatsReport>(statsUrl({ range, by, project: project || undefined, filter }), version).data);
  const days = useHeld(useQuery<UsageDays & { threshold: number }>(daysUrl(range), version).data);
  const r = report.shown, d = days.shown;

  return (
    <div className={phone ? "px-4 pb-6 pt-3" : "mx-auto max-w-7xl px-7 pb-8 pt-5"}>
      <div className="mb-3 flex flex-wrap items-center gap-x-3.5 gap-y-2">
        {!phone && <>
          <h1 className="text-lg font-semibold text-fg">{t("stats.title")}</h1>
          <span className="text-xs text-fg-3">{t("stats.allProjects", { date: formatDate(new Date().toISOString()) })}</span>
          <span className="flex-1" />
        </>}
        <RangeSwitch value={range} onChange={setRange} phone={phone} />
      </div>

      <Heading title={t("stats.windows")} note={t("stats.windowsNote")} phone={phone} />
      <div className={`grid grid-cols-[repeat(auto-fit,minmax(17rem,1fr))] gap-3 transition-opacity ${days.stale ? "opacity-60" : ""}`}>
        {d && windowPanels(d, d.threshold).map((p) => <WindowCard key={p.id} panel={p} threshold={d.threshold} />)}
        {d && !d.windows.length && <p className="text-sm text-fg-3">{t("stats.noWindows")}</p>}
      </div>

      <div className="mt-5" />
      <Heading title={t("stats.models")} note={t("stats.modelsNote")} phone={phone} />
      <div className={`mb-3 flex items-center gap-2 ${phone ? "scroll-thin overflow-x-auto pb-1" : "flex-wrap"}`}>
        <span className="shrink-0 whitespace-nowrap text-xs text-fg-3">{t("stats.groupBy")}</span>
        <Segmented label={t("stats.groupBy")} value={by} onChange={setBy} options={[{ value: "model", label: t("stats.byModel") }, { value: "effort", label: t("stats.byEffort") }]} />
        <Pick label={t("stats.facet.project")} value={project} onChange={setProject} options={projects.map((p) => ({ value: p.id, label: p.name }))} />
        {STAT_FILTERS.map((f) => (
          <Pick key={f} label={t(FACET_LABEL[f])} value={filter[f] ?? ""} onChange={(v) => setFilter((x) => ({ ...x, [f]: v }))}
            options={[...new Set([...(r?.facets[f] ?? []), ...(filter[f] ? [filter[f]] : [])])].map((v) => ({ value: v, label: v === "untagged" ? groupLabel(v) : v }))} />
        ))}
      </div>
      {r && <div className={`transition-opacity ${report.stale ? "opacity-60" : ""}`}>
        <Tiles report={r} phone={phone} />
        {r.groups.length
          ? <Comparison report={r} phone={phone} by={by} />
          : <p className="rounded-xl border border-line bg-surface px-4 py-6 text-center text-sm text-fg-3">{t("stats.noSteps")}</p>}
        <p className="mt-2 text-xs text-fg-3">{t("stats.footnote")}</p>
      </div>}

      <div className="mt-5" />
      <Heading title={t("speed.title")} note={t("speed.titleNote")} phone={phone} />
      <ServerSpeed since={rangeSinceIso(range)} version={version} phone={phone} />
    </div>
  );
}

/** The range picked for a Stats view (the global one, a project's tab); full width on the phone. */
export function RangeSwitch({ value, onChange, phone }: { value: Range; onChange: (r: Range) => void; phone: boolean }) {
  return (
    <div className={phone ? "w-full [&>div]:flex [&>div]:w-full [&_button]:flex-1" : ""}>
      <Segmented label={t("stats.range")} value={value} onChange={onChange} options={RANGES.map((x) => ({ value: x, label: t(RANGE_LABEL[x]) }))} />
    </div>
  );
}

/** A chart card's two views: the chart and its table. */
export const chartOrTable = () => [{ value: "chart" as const, label: t("stats.view.chart") }, { value: "table" as const, label: t("stats.view.table") }];

function Heading({ title, note, phone }: { title: string; note: string; phone: boolean }) {
  return (
    <div className={`mb-2.5 flex gap-x-3 gap-y-0.5 ${phone ? "flex-col" : "items-baseline"}`}>
      <h2 className="text-[13px] font-semibold uppercase tracking-wider text-fg-2">{title}</h2>
      <span className="text-xs text-fg-3">{note}</span>
    </div>
  );
}

/** A filter: a native select (keyboard and screen readers for free), "any" first. */
function Pick({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: { value: string; label: string }[] }) {
  return (
    <label className={`flex shrink-0 items-center gap-1 whitespace-nowrap rounded-lg border bg-surface py-0.5 pl-2.5 pr-1 text-xs ${value ? "border-accent/60" : "border-line-strong"}`}>
      <span className="text-fg-2">{label}:</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} className="cursor-pointer bg-transparent py-0.5 font-semibold text-fg outline-none">
        <option value="">{t("stats.any")}</option>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  );
}

const windowTitle = (p: WindowPanel) => `${runtimeName(p.runtime)} · ${t(p.kind === "5h" ? "stats.window.5h" : p.window === "seven_day" ? "stats.window.7d" : "stats.window.weekly")}`;

function WindowCard({ panel: p, threshold }: { panel: WindowPanel; threshold: number }) {
  const n = p.points.length;
  const step = Math.max(1, Math.ceil(n / 5));
  const xLabels: [number, string][] = [];
  for (let i = n - 1; i >= 0; i -= step) xLabels.unshift([i, i === n - 1 ? t("stats.today") : formatDay(dayOf(p.points[i]!.day))]);
  const what = t(p.kind === "5h" ? "stats.window.peakOf" : "stats.window.levelOf");
  const caption = p.kind === "5h"
    ? (p.over ? t("stats.window.peakOver", { count: p.over, threshold: pct(threshold * 100) }) : t("stats.window.peak"))
    : t("stats.window.level");
  return (
    <ChartCard title={windowTitle(p)} caption={caption} initial="chart" views={chartOrTable()}>
      {(view) => view === "chart"
        ? <TimeChart kind={p.kind === "5h" ? "columns" : "line"} area max={100} ticks={[0, 50, 100]} format={pct} xLabels={xLabels}
            refs={[{ value: threshold * 100, label: `⚠ ${t("stats.pause", { threshold: pct(threshold * 100) })}`, tone: "warn" }]}
            end={p.kind === "7d" && p.last !== undefined ? t("stats.now", { value: pct(p.last) }) : undefined}
            points={p.points.map((x) => ({ value: x.value, tip: x.value === null ? [] : [pct(x.value), what, formatWeekday(dayOf(x.day))] }))} />
        : <DataTable head={[t("stats.col.day"), what]} rows={[...p.points].reverse().map((x) => [formatWeekday(dayOf(x.day)), x.value === null ? "–" : pct(x.value)])} />}
    </ChartCard>
  );
}

function Tiles({ report, phone }: { report: StatsReport; phone: boolean }) {
  const h = headline(report);
  const tile = (value: string, label: string, detail: string) => (
    <div className="rounded-xl border border-line bg-surface px-3.5 py-2.5">
      <div className="text-[22px] font-semibold text-fg">{value}</div>
      <div className="text-xs text-fg-2">{label}</div>
      <div className="text-xs text-fg-3">{detail}</div>
    </div>
  );
  return (
    <div className={`mb-3 grid gap-3 ${phone ? "grid-cols-2 gap-2" : "grid-cols-4"}`}>
      {tile(String(h.steps), t("stats.tile.steps", { count: h.steps }), t("stats.tile.fallback", { count: h.fallback }))}
      {tile(h.rate === undefined ? "–" : pct(h.rate), t("stats.tile.first"), t("stats.tile.decided", { first: h.first, decided: h.decided }))}
      {tile(h.median === undefined ? "–" : mins(h.median), t("stats.tile.median"),
        h.p25 !== undefined && h.p75 !== undefined ? t("stats.tile.middle", { low: Math.round(h.p25), high: Math.round(h.p75) }) : t("stats.tile.noneAccepted"))}
      {tile(h.use ? estimate(h.use.perStep) : "–", t("stats.tile.use"),
        h.missing ? t("stats.tile.missing", { count: h.missing }) : t("stats.tile.estimate"))}
    </div>
  );
}

type CompareView = "columns" | "scatter" | "table";

/** How steps went by model or effort: four aligned columns, a scatter of rate against time, or the table; the user picks. */
function Comparison({ report, phone, by }: { report: StatsReport; phone: boolean; by: "model" | "effort" }) {
  const rows = compareRows(report);
  const scales = compareScales(rows);
  const views = [
    { value: "columns" as const, label: t("stats.view.columns") },
    { value: "scatter" as const, label: t("stats.view.scatter") },
    { value: "table" as const, label: t("stats.view.table") },
  ];
  return (
    <ChartCard<CompareView> title={t(by === "model" ? "stats.compare.model" : "stats.compare.effort")} initial="columns" store="nexus.stats.compare" views={views}>
      {(view) => view === "columns" ? <Columns rows={rows} scales={scales} phone={phone} />
        : view === "scatter" ? <ScatterView rows={rows} scales={scales} phone={phone} />
        : <DataTable head={[t(by === "model" ? "stats.col.model" : "stats.col.effort"), t("stats.col.steps"), t("stats.col.first"), t("stats.col.rounds"), t("stats.col.median"), t("stats.col.middle"), t("stats.col.use"), t("stats.col.stops"), t("stats.col.failures"), t("stats.col.fallback")]}
            rows={rows.map((r) => [r.label + (r.few ? ` (${t("stats.few")})` : ""), r.steps, r.rate === undefined ? "–" : `${pct(r.rate)} (${r.first}/${r.decided})`,
              r.rounds === undefined ? "–" : r.rounds.toFixed(2), r.median === undefined ? "–" : mins(r.median),
              r.p25 === undefined ? "–" : `${Math.round(r.p25)}–${Math.round(r.p75!)}`, r.uses.map((u) => `${runtimeName(u.runtime)} ${estimate(u.perStep)}`).join(", ") || "–",
              stopsCell(r), r.failures, r.fallback])} />}
    </ChartCard>
  );
}

interface Measure { head: Key; sub: Key; axis: ReactNode; cell: (r: CompareRow) => ReactNode }

function measures(rows: CompareRow[], scales: { minutes: number; use: number }): Measure[] {
  const dash = <div className="flex h-9 items-center text-xs text-fg-3">–</div>;
  const roundsMax = Math.max(2, Math.ceil(Math.max(...rows.map((r) => r.rounds ?? 1)) * 2) / 2);
  const tipOf = (r: CompareRow, value: string) => [value, `${r.label} · ${t("stats.steps", { count: r.steps })}${r.few ? ` (${t("stats.few")})` : ""}`];
  return [
    { head: "stats.col.first", sub: "stats.sub.first",
      axis: <AxisCell ticks={[0, 50, 100]} max={100} format={pct} room={72} />,
      cell: (r) => r.rate === undefined ? dash : <BarCell value={r.rate} max={100} few={r.few} label={`${pct(r.rate)} · ${r.first}/${r.decided}`} tip={tipOf(r, t("stats.tip.first", { rate: pct(r.rate), first: r.first, decided: r.decided }))} /> },
    { head: "stats.col.rounds", sub: "stats.sub.rounds",
      axis: <AxisCell ticks={[1, (1 + roundsMax) / 2, roundsMax]} min={1} max={roundsMax} format={(v) => v.toFixed(1)} room={52} inset={6} />,
      cell: (r) => r.rounds === undefined ? dash : <DotCell value={r.rounds} min={1} max={roundsMax} few={r.few} label={r.rounds.toFixed(2)} tip={tipOf(r, t("stats.tip.rounds", { rounds: r.rounds.toFixed(2) }))} /> },
    { head: "stats.col.median", sub: "stats.sub.median",
      axis: <AxisCell ticks={[0, scales.minutes / 2, scales.minutes]} max={scales.minutes} format={(v) => mins(v)} room={52} inset={6} />,
      cell: (r) => r.median === undefined ? dash : <DotCell value={r.median} low={r.p25} high={r.p75} max={scales.minutes} few={r.few} label={mins(r.median)}
        tip={tipOf(r, t("stats.tip.median", { median: mins(r.median), low: Math.round(r.p25!), high: Math.round(r.p75!) }))} /> },
    { head: "stats.col.use", sub: "stats.sub.use",
      axis: <AxisCell ticks={[0, scales.use / 2, scales.use]} max={scales.use} format={(v) => `${v} %`} room={72} />,
      cell: (r) => {
        const [a, b] = r.uses;
        if (!a) return dash;
        const two = !!b;
        const text = (u: typeof a) => two ? `${runtimeName(u.runtime)} ${estimate(u.perStep)}` : estimate(u.perStep);
        const tip = (u: typeof a) => tipOf(r, t("stats.tip.use", { use: estimate(u.perStep), runtime: runtimeName(u.runtime) }));
        return <BarCell value={a.perStep} max={scales.use} few={r.few} label={text(a)} tip={tip(a)} second={b && { value: b.perStep, label: text(b), tip: tip(b) }} />;
      } },
  ];
}

function NameCell({ row }: { row: CompareRow }) {
  return (
    <div className="flex h-9 min-w-0 flex-col justify-center border-t border-line">
      <span className="flex min-w-0 items-center gap-1 text-[13px] font-semibold text-fg">
        <span className="truncate">{row.label}</span>
        {row.few && <span className="shrink-0 rounded border border-line-strong px-1 text-[10px] font-normal text-fg-2">{t("stats.few")}</span>}
      </span>
      <span className="truncate text-[11px] text-fg-3">
        {[...row.runtimes.map(runtimeName), t("stats.steps", { count: row.steps }), ...(row.fallback ? [`↺ ${row.fallback}`] : [])].join(" · ")}
      </span>
    </div>
  );
}

function Columns({ rows, scales, phone }: { rows: CompareRow[]; scales: { minutes: number; use: number }; phone: boolean }) {
  const ms = measures(rows, scales);
  if (phone) {
    // The phone: the four measures one under another, full width, each with every group.
    return <div className="space-y-4">
      {ms.map((m) => (
        <div key={m.head}>
          <div className="text-xs font-semibold text-fg-2">{t(m.head)}</div>
          <div className="mb-1 text-[11px] text-fg-3">{t(m.sub)}</div>
          <div className="grid grid-cols-[7.5rem_minmax(0,1fr)] gap-x-3">
            {rows.map((r) => <Fragment key={r.key}><NameCell row={r} /><div className="border-t border-line">{m.cell(r)}</div></Fragment>)}
            <div />{m.axis}
          </div>
        </div>
      ))}
    </div>;
  }
  return (
    <div className="grid grid-cols-[11rem_repeat(4,minmax(0,1fr))] gap-x-4.5">
      <div />
      {ms.map((m) => <div key={m.head} className="pb-1 text-xs font-semibold text-fg-2">{t(m.head)}<small className="block font-normal text-fg-3">{t(m.sub)}</small></div>)}
      {rows.map((r) => <Fragment key={r.key}><NameCell row={r} />{ms.map((m) => <div key={m.head} className="min-w-0 border-t border-line">{m.cell(r)}</div>)}</Fragment>)}
      <div />
      {ms.map((m) => <div key={m.head}>{m.axis}</div>)}
    </div>
  );
}

function ScatterView({ rows, scales, phone }: { rows: CompareRow[]; scales: { minutes: number; use: number }; phone: boolean }) {
  const placed = rows.filter((r) => r.rate !== undefined && r.median !== undefined);
  const lowest = Math.min(50, ...placed.map((r) => Math.floor(r.rate! / 25) * 25));
  const points: ScatterPoint[] = placed.map((r) => ({
    key: r.key, x: r.median!, y: r.rate!, low: r.p25, high: r.p75, few: r.few,
    label: `${r.label} · ${r.steps}${r.few ? ` · ${t("stats.few")}` : ""}`,
    tip: [t("stats.tip.scatter", { rate: pct(r.rate!), median: mins(r.median!) }), `${r.label} · ${t("stats.steps", { count: r.steps })} · ${r.rounds?.toFixed(2) ?? "–"} ${t("stats.col.rounds").toLowerCase()}`,
      ...r.uses.map((u) => t("stats.tip.use", { use: estimate(u.perStep), runtime: runtimeName(u.runtime) }))],
  }));
  return (
    <div className={phone ? "space-y-3" : "grid grid-cols-[minmax(0,5fr)_minmax(0,6fr)] items-start gap-5.5"}>
      <div>
        <p className="mb-1 text-xs text-fg-3">{t("stats.scatterNote")}</p>
        <Scatter points={points} xMax={scales.minutes} yMin={lowest} yMax={100} xTicks={[0, scales.minutes / 4, scales.minutes / 2, (scales.minutes * 3) / 4, scales.minutes]}
          yTicks={[lowest, (lowest + 100) / 2, 100]} xFormat={(v) => mins(v)} yFormat={pct} xTitle={t("stats.scatterX")} yTitle={t("stats.scatterY")} />
      </div>
      <DataTable head={[t("stats.col.group"), t("stats.col.steps"), t("stats.col.rounds"), t("stats.col.use"), t("stats.col.stops"), t("stats.col.failures"), "↺"]}
        rows={rows.map((r) => [r.label + (r.few ? ` · ${t("stats.few")}` : ""), r.steps, r.rounds?.toFixed(2) ?? "–", r.uses.map((u) => estimate(u.perStep)).join(", ") || "–", stopsCell(r), r.failures, r.fallback])} />
    </div>
  );
}
