// The flaky checks from the queues' checks.yaml (`nexus stats --flaky`, docs/protocol/cli.md): a check Nexus ran that
// failed, then passed when run again (`flaky: true`), grouped by the test that failed on the first run. A first run
// without known failing tests (an output format Nexus does not read) counts under the check's own name. Reads only.
import type { ChecksFile } from "./schemas.ts";

/** One queue's checks.yaml, with its project. */
export interface FlakySource { project: string; queue: string; checks: ChecksFile }

/** One flaky test (or check, when its failing tests are unknown): how often, where, when last. */
export interface FlakyGroup {
  /** The failing test's name, or the check's name when the first run's failing tests are unknown. */
  test: string;
  /** Whether `test` is a check's name (the failing tests unknown). */
  byCheck: boolean;
  count: number;
  /** The checks it failed in (`npm test`), sorted. */
  checks: string[];
  /** Where it happened: `<project>/<queue>/<step>` (the project left out when there is only one), oldest first, once each. */
  steps: string[];
  /** The latest time it happened (the first run's start). */
  last: string;
}

/**
 * The flaky records since `since` (an ISO time; every record when left out), grouped by test, most frequent first
 * (then the latest first, then by name).
 */
export function flakyReport(sources: FlakySource[], since?: string): FlakyGroup[] {
  const projects = new Set(sources.map((s) => s.project));
  const groups = new Map<string, FlakyGroup & { seen: Set<string> }>();
  const records: { at: string; key: string; test: string; byCheck: boolean; check: string; where: string }[] = [];
  for (const s of sources) {
    for (const [step, entry] of Object.entries(s.checks.steps)) {
      for (const set of entry.sets) {
        for (const c of set.checks) {
          if (!c.flaky) continue;
          const first = c.runs[0];
          const at = first?.started_at ?? set.ended_at ?? set.requested_at;
          if (since && at < since) continue;
          const where = projects.size > 1 ? `${s.project}/${s.queue}/${step}` : `${s.queue}/${step}`;
          const tests = first?.failed_tests?.length ? [...new Set(first.failed_tests)] : undefined;
          if (tests) for (const t of tests) records.push({ at, key: `t:${t}`, test: t, byCheck: false, check: c.name, where });
          else records.push({ at, key: `c:${c.name}`, test: c.name, byCheck: true, check: c.name, where });
        }
      }
    }
  }
  records.sort((a, b) => a.at.localeCompare(b.at));
  for (const r of records) {
    let g = groups.get(r.key);
    if (!g) { g = { test: r.test, byCheck: r.byCheck, count: 0, checks: [], steps: [], last: r.at, seen: new Set() }; groups.set(r.key, g); }
    g.count++;
    if (!g.checks.includes(r.check)) g.checks.push(r.check);
    if (!g.seen.has(r.where)) { g.seen.add(r.where); g.steps.push(r.where); }
    if (r.at > g.last) g.last = r.at;
  }
  return [...groups.values()]
    .map(({ seen: _seen, ...g }) => ({ ...g, checks: g.checks.sort() }))
    .sort((a, b) => b.count - a.count || b.last.localeCompare(a.last) || a.test.localeCompare(b.test));
}

/** The report as text, one block per test; `since`: the date or time as the user gave it. */
export function flakyText(groups: FlakyGroup[], since?: string): string {
  const from = since ? ` since ${since}` : "";
  if (!groups.length) return `no flaky checks${from}`;
  const total = groups.reduce((n, g) => n + g.count, 0);
  const lines = [`flaky checks${from}: ${groups.length} ${groups.length === 1 ? "test" : "tests"}, ${total} ${total === 1 ? "time" : "times"}`];
  for (const g of groups) {
    lines.push(`${g.test}${g.byCheck ? " (the check; its failing tests unknown)" : ""}`);
    lines.push(`  ${g.count} ${g.count === 1 ? "time" : "times"}, last ${g.last.slice(0, 16).replace("T", " ")}; check ${g.checks.join(", ")}`);
    lines.push(`  in ${g.steps.join(", ")}`);
  }
  return lines.join("\n");
}
