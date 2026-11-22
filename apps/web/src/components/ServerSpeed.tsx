// The server's speed in the global Stats view (queue SB): the live server's own measurements since its start (GET
// /api/server/perf, queue SV1: its event loop's delay, the blocks, the slow requests) as numbers, and the speed
// benchmark's runs (scripts/server-speed.ts, GET /api/benchmarks/server-speed) as a trend: one small chart per
// configuration (the synthetic tree's scale, with or without tests beside the server) for the measure picked, one dot
// per run, each a run of its own. Follows the dataviz skill as the other Stats charts do
// (charts.tsx): one series colour, a hover tooltip, a table view beside each chart.
import { useMemo, useState } from "react";
import { SPEED_MEASURES, speedPanels, speedValue, type ServerSpeedRun, type SpeedMeasure, type SpeedPanel, type SpeedPoint } from "@nexus/protocol/benchmarks";
import { useQuery } from "../api.ts";
import { formatDateTime, formatDay, formatNumber, formatWeekday, t } from "../i18n.ts";
import { niceAxis } from "../metrics.ts";
import { ChartCard, DataTable, Segmented, TimeChart } from "./charts.tsx";
import { chartOrTable } from "./Stats.tsx";

/** What the dashboard reads of GET /api/server/perf (apps/server/src/perf.ts PerfView). */
interface Perf {
  since: string; block_ms: number;
  loop: { p50_ms: number; p99_ms: number; max_ms: number };
  routes: { route: string; count: number; mean_ms: number; max_ms: number; slow: number }[];
  blocks: { at: string; ms: number }[];
}

const ms = (v: number) => v >= 1000 ? `${formatNumber(Math.round(v / 100) / 10)} s` : `${formatNumber(Math.round(v))} ms`;
const panelTitle = (p: Pick<SpeedPanel, "scale" | "tests">) => t(p.tests ? "speed.panel.tests" : "speed.panel.quiet", { scale: formatNumber(p.scale) });

export function ServerSpeed({ since, version, phone }: { since?: string; version: string | number | undefined; phone: boolean }) {
  const perf = useQuery<Perf>("/api/server/perf", version).data;
  const runs = useQuery<{ runs: ServerSpeedRun[] }>("/api/benchmarks/server-speed", version).data?.runs;
  const [measure, setMeasure] = useState<SpeedMeasure>("reads");
  const panels = useMemo(() => (runs ? speedPanels(runs, measure, since) : undefined), [runs, measure, since]);
  return (
    <>
      {perf && <Live perf={perf} phone={phone} />}
      <div className={`mb-3 mt-4 flex items-center gap-2 ${phone ? "scroll-thin overflow-x-auto pb-1" : "flex-wrap"}`}>
        <span className="shrink-0 whitespace-nowrap text-xs text-fg-3">{t("speed.benchmark")}</span>
        <Segmented label={t("speed.benchmark")} value={measure} onChange={setMeasure} options={SPEED_MEASURES.map((m) => ({ value: m, label: t(`speed.measure.${m}`) }))} />
      </div>
      {runs && !runs.length && (
        <p className="rounded-xl border border-line bg-surface px-4 py-6 text-center text-sm text-fg-3">
          {t("speed.none")}<br /><code className="rounded bg-surface-3 px-1 font-mono text-[11px]">node scripts/server-speed.ts</code>
        </p>
      )}
      {panels && !!panels.length && (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(17rem,1fr))] gap-3">
          {panels.map((p) => <SpeedCard key={p.key} panel={p} measure={measure} />)}
        </div>
      )}
    </>
  );
}

/** The live server since its start: numbers, not a chart (one value each, no history kept). */
function Live({ perf, phone }: { perf: Perf; phone: boolean }) {
  const slow = perf.routes.reduce((n, r) => n + r.slow, 0), requests = perf.routes.reduce((n, r) => n + r.count, 0);
  const longest = Math.max(0, ...perf.blocks.map((b) => b.ms));
  // The slowest API route on average among those asked a few times (a single cold answer says little).
  const slowest = perf.routes.filter((r) => r.count >= 3 && r.route.includes(" /api/")).sort((a, b) => b.mean_ms - a.mean_ms)[0];
  // A route's name is cut short (its whole name in the title); the other words wrap on a narrow tile.
  const tile = (value: string, label: string, detail: string, route?: boolean) => (
    <div className="min-w-0 rounded-xl border border-line bg-surface px-3.5 py-2.5" title={route ? label : undefined}>
      <div className="text-[22px] font-semibold text-fg tabular-nums">{value}</div>
      <div className={`text-xs text-fg-2 ${route ? "truncate" : ""}`}>{label}</div>
      <div className="text-xs text-fg-3">{detail}</div>
    </div>
  );
  return (
    <div className={`grid gap-3 ${phone ? "grid-cols-2 gap-2" : "grid-cols-4"}`}>
      {tile(ms(perf.loop.p99_ms), t("speed.live.loop"), t("speed.live.loopDetail", { p50: ms(perf.loop.p50_ms), max: ms(perf.loop.max_ms) }))}
      {tile(formatNumber(perf.blocks.length), t("speed.live.blocks", { ms: perf.block_ms }), perf.blocks.length ? t("speed.live.longest", { ms: ms(longest) }) : t("speed.live.noBlocks"))}
      {tile(formatNumber(slow), t("speed.live.slow", { ms: perf.block_ms }), t("speed.live.ofRequests", { count: requests }))}
      {slowest
        ? tile(ms(slowest.mean_ms), slowest.route, t("speed.live.slowest", { count: slowest.count, max: ms(slowest.max_ms) }), true)
        : tile("–", t("speed.live.slowestNone"), "")}
    </div>
  );
}

/**
 * A configuration's runs. Each card has its own scale from zero, written on its axis: the job is each one's trend (a
 * run slower than the ones before), and the 4x project beside tests takes many times the 1x project's time.
 */
function SpeedCard({ panel: p, measure }: { panel: SpeedPanel; measure: SpeedMeasure }) {
  const n = p.points.length;
  const axis = niceAxis(0, Math.max(1, ...p.points.map((x) => x.value)));
  const xLabels: [number, string][] = (n > 2 ? [0, Math.floor((n - 1) / 2), n - 1] : n === 2 ? [0, 1] : n ? [0] : []).map((i) => [i, formatDay(new Date(p.points[i]!.at))]);
  const commit = (x: SpeedPoint) => x.commit ? `${x.commit}${x.dirty ? "*" : ""}` : "–";
  const tip = (x: SpeedPoint) => [ms(x.value), t(`speed.note.${measure}`), [commit(x), x.label].filter(Boolean).join(" · "), formatDateTime(x.at)];
  const last = p.points.at(-1);
  return (
    <ChartCard title={panelTitle(p)} caption={t(`speed.note.${measure}`)} initial="chart" views={chartOrTable()}>
      {(view) => !n
        ? <div className="grid h-32 place-items-center rounded-lg border border-dashed border-line-strong text-xs text-fg-3">{t("speed.noRuns")}</div>
        : view === "chart"
          ? <TimeChart kind="line" dots min={axis.min} max={axis.max} ticks={axis.ticks} format={ms} xLabels={xLabels}
              end={last && ms(last.value)} points={p.points.map((x) => ({ value: x.value, tip: tip(x) }))} />
          : <DataTable head={[t("stats.col.day"), t("speed.col.commit"), ...SPEED_MEASURES.map((m) => t(`speed.col.${m}`))]}
              rows={[...p.points].reverse().map((x) => [formatWeekday(new Date(x.at)), commit(x), ...SPEED_MEASURES.map((m) => ms(speedValue(x.config, m)))])} />}
    </ChartCard>
  );
}
