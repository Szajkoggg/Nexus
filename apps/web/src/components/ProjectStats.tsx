// A project's Stats tab (queue ST3; the mockup docs/ux/mockups/21-stats-project.html, the reasons for each form in
// docs/ux/stats-mockups.md): the metrics the orchestrator defined and the checks' times, one card each in the form it
// gave (a line over the steps, bars, or the latest number), with the target and the warning threshold; a value is a
// link to its step. Beside the chat and Ideas on a desktop, a tab of its own on the phone. Data: stats-free metrics.ts.
import { useMemo, useState } from "react";
import { metricValueText } from "@nexus/protocol/metrics";
import type { ProjectMetrics } from "@nexus/protocol/stats";
import { projectUrl, useQuery, type QueueView } from "../api.ts";
import { usePage } from "../page.ts";
import { nav } from "../nav.ts";
import { formatDay, formatNumber, formatWeekday, t } from "../i18n.ts";
import { metricCards, type MetricCard, type MetricPoint } from "../metrics.ts";
import { dayOf, rangeSince, type Range } from "../stats.ts";
import { ChartCard, DataTable, Sparkline, TimeChart, type Reference } from "./charts.tsx";
import { RangeSwitch, chartOrTable } from "./Stats.tsx";

/** The range's start as an ISO time (its first day's start, local); none for all. */
const sinceIso = (range: Range) => {
  const day = rangeSince(range);
  return day && dayOf(day).toISOString();
};

export function ProjectStats({ project, queues, phone }: { project: string; queues: QueueView[]; phone: boolean }) {
  const [range, setRange] = useState<Range>("30d");
  const { version } = usePage();
  const data = useQuery<ProjectMetrics>(projectUrl(project, "/metrics"), version).data;
  const cards = useMemo(() => (data ? metricCards(project, data, sinceIso(range)) : undefined), [data, project, range]);
  const title = (p: MetricPoint) => queues.find((q) => q.id === p.queue)?.steps.find((s) => s.id === p.step)?.title;
  return (
    <div className={phone ? "pb-6" : "mx-auto max-w-6xl"}>
      <div className="mb-3 flex flex-wrap items-center gap-x-3.5 gap-y-2">
        <h2 className="text-[13px] font-semibold uppercase tracking-wider text-fg-2">{t("metrics.title")}</h2>
        {!phone && <span className="text-xs text-fg-3">{t("metrics.note")}</span>}
        <span className="flex-1" />
        <RangeSwitch value={range} onChange={setRange} phone={phone} />
      </div>
      {cards && !cards.length && <p className="rounded-xl border border-line bg-surface px-4 py-6 text-center text-sm text-fg-3">{t("metrics.none")}</p>}
      <div className={`grid gap-3 ${phone ? "grid-cols-1" : "grid-cols-[repeat(auto-fit,minmax(20rem,1fr))]"}`}>
        {cards?.map((c) => <MetricCardView key={c.def.name} project={project} card={c} title={title} />)}
      </div>
    </div>
  );
}

const open = (project: string, p: MetricPoint) => nav.item(project, p.queue, p.step);

function caption(c: MetricCard): string {
  const d = c.def;
  return [
    t(d.show === "bar" ? "metrics.show.bar" : d.show === "number" ? "metrics.show.number" : "metrics.show.line"),
    d.target !== undefined ? t("metrics.target", { value: metricValueText(d.target, d.unit) }) : undefined,
    d.warn_above !== undefined ? t("metrics.warnAbove", { value: metricValueText(d.warn_above, d.unit) }) : undefined,
    d.warn_below !== undefined ? t("metrics.warnBelow", { value: metricValueText(d.warn_below, d.unit) }) : undefined,
  ].filter(Boolean).join(" · ");
}

function MetricCardView({ project, card: c, title }: { project: string; card: MetricCard; title: (p: MetricPoint) => string | undefined }) {
  const d = c.def;
  const text = (v: number) => metricValueText(v, d.unit);
  const heading = <><span className="font-mono">{d.name}</span> <span className="text-xs font-normal text-fg-3">{d.unit}</span></>;
  if (!c.points.length) {
    return (
      <section className="min-w-0 rounded-xl border border-line bg-surface px-3.5 pb-3 pt-3">
        <h3 className="text-[13px] font-semibold text-fg">{heading}</h3>
        <p className="mt-0.5 text-xs text-fg-3">{caption(c)}</p>
        <div className="mt-2 grid h-32 place-items-center rounded-lg border border-dashed border-line-strong px-3 text-center text-xs text-fg-3">
          <div>{t("metrics.noValues")}<br />{t("metrics.recordWith")}<br /><code className="rounded bg-surface-3 px-1 font-mono text-[11px]">nexus metric record {d.name} &lt;value&gt;</code></div>
        </div>
      </section>
    );
  }
  const tipOf = (p: MetricPoint) => [
    text(p.value),
    ...(p.warn ? [t("metrics.beyond", { limit: text((d.warn_above ?? d.warn_below)!) })] : []),
    `${p.queue}/${p.step}${title(p) ? ` · ${title(p)}` : ""}`,
    [p.commit, formatWeekday(new Date(p.at))].filter(Boolean).join(" · "),
    t("metrics.openStep"),
  ];
  const n = c.points.length;
  const xLabels: [number, string][] = (n > 2 ? [0, Math.floor((n - 1) / 2), n - 1] : n === 2 ? [0, 1] : [0]).map((i) => [i, formatDay(new Date(c.points[i]!.at))]);
  const refs: Reference[] = c.refs.map((r) => ({ value: r.value, tone: r.kind, label: r.kind === "warn" ? `⚠ ${formatNumber(r.value)}` : t("metrics.targetShort", { value: formatNumber(r.value) }) }));
  const last = c.last!;
  return (
    <ChartCard title={d.name} caption={caption(c)} initial="chart" views={chartOrTable()} heading={heading}>
      {(view) => <>
        {view === "table"
          ? <DataTable head={[t("metrics.col.step"), t("metrics.col.value"), t("metrics.col.commit"), t("stats.col.day")]}
              rows={[...c.points].reverse().map((p) => [`${p.queue}/${p.step}`, `${p.warn ? "⚠ " : ""}${text(p.value)}`, p.commit ?? "–", formatWeekday(new Date(p.at))])} />
          : d.show === "number"
            ? (
              <div className="flex h-32 items-end gap-4 pb-2">
                <div className="shrink-0">
                  <div className="text-[34px] font-semibold leading-tight text-fg">{formatNumber(last.value)} <span className="text-sm font-normal text-fg-2">{d.unit}</span></div>
                  {c.change !== undefined && c.change !== 0 && (
                    <div className="text-xs text-fg-2">{t(c.change < 0 ? "metrics.down" : "metrics.up", { value: formatNumber(Math.abs(c.change)), since: formatDay(new Date(c.points[0]!.at)) })}</div>
                  )}
                  {last.warn && <div className="text-xs text-warn">⚠ {t("metrics.beyond", { limit: text((d.warn_above ?? d.warn_below)!) })}</div>}
                </div>
                <Sparkline values={c.points.slice(-12).map((p) => p.value)} />
              </div>
            )
            : <TimeChart kind={d.show === "bar" ? "columns" : "line"} dots min={c.axis.min} max={c.axis.max} ticks={c.axis.ticks} format={formatNumber}
                valueLabel={formatNumber} xLabels={xLabels} refs={refs} end={d.show === "bar" ? undefined : text(last.value)}
                points={c.points.map((p) => ({ value: p.value, warn: p.warn, tip: tipOf(p) }))} onPick={(i) => open(project, c.points[i]!)} />}
        <div className="mt-1 flex gap-1.5 text-xs text-fg-3">
          {t("metrics.last", { value: text(last.value) })}
          <button onClick={() => open(project, last)} className="text-accent hover:underline">{`${last.queue}/${last.step} →`}</button>
        </div>
      </>}
    </ChartCard>
  );
}
