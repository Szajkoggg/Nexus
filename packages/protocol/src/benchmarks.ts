// The server's speed over time (queue SB): the runs of scripts/server-speed.ts (<NEXUS_HOME>/benchmarks/server-speed.jsonl,
// read by store.ts readServerSpeed) as the global Stats view draws them, one panel per configuration (a synthetic tree's
// scale, with or without a test suite beside the server) and one value per run of the measure picked. Pure and free of
// Node: the dashboard imports it.
import type { ServerSpeedConfig, ServerSpeedRun } from "./schemas.ts";

export type { ServerSpeedConfig, ServerSpeedRun };

/** What a panel shows: the reads' 95th percentile, a change until the dashboards are told, the start, the loop's p99. */
export const SPEED_MEASURES = ["reads", "change", "startup", "loop"] as const;
export type SpeedMeasure = (typeof SPEED_MEASURES)[number];

/** A configuration's value of a measure, in ms. */
export function speedValue(c: ServerSpeedConfig, m: SpeedMeasure): number {
  return m === "reads" ? c.reads_p95_ms : m === "change" ? c.change.p95_ms : m === "startup" ? c.startup_ms : c.loop.p99_ms;
}

export interface SpeedPoint { at: string; commit?: string; dirty?: boolean; label?: string; value: number; config: ServerSpeedConfig }
export interface SpeedPanel { key: string; scale: number; tests: boolean; points: SpeedPoint[] }

/** A configuration's key: "1x", "4x+tests". */
export const speedKey = (c: Pick<ServerSpeedConfig, "scale" | "tests">) => `${c.scale}x${c.tests ? "+tests" : ""}`;

/**
 * The panels: every configuration a run measured (by scale, then without the tests before with them), each with the
 * runs at or after `since` (an ISO time; none: all) in the order they ended. A configuration measured only before
 * `since` is a panel without points, so the panels stay put when the range changes.
 */
export function speedPanels(runs: readonly ServerSpeedRun[], measure: SpeedMeasure, since?: string): SpeedPanel[] {
  const panels = new Map<string, SpeedPanel>();
  for (const r of [...runs].sort((a, b) => a.at.localeCompare(b.at))) {
    for (const c of r.configs) {
      const key = speedKey(c);
      let p = panels.get(key);
      if (!p) panels.set(key, p = { key, scale: c.scale, tests: c.tests, points: [] });
      if (since && r.at < since) continue;
      p.points.push({ at: r.at, commit: r.commit, dirty: r.dirty, label: r.label, value: speedValue(c, measure), config: c });
    }
  }
  return [...panels.values()].sort((a, b) => a.scale - b.scale || Number(a.tests) - Number(b.tests));
}
