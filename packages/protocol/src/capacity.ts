// The capacity coordinator's line as `nexus status` prints it (PROTOCOL.md, "The capacity coordinator"): what holds
// the workstation's heavy slot, what waits for it in which order, and a full test run outside Nexus that keeps it. The
// file is the server's (<NEXUS_HOME>/capacity.yaml); this only reads it, so every project's status shows the same line.
import type { CapacityFile, CapacityRequest } from "./schemas.ts";
import { formatClock } from "./times.ts";

const what = (r: CapacityRequest) => `${r.kind} of ${r.queue}/${r.step} (project ${r.project})`;
const ordinal = (n: number) => `${n}${n % 10 === 1 && n % 100 !== 11 ? "st" : n % 10 === 2 && n % 100 !== 12 ? "nd" : n % 10 === 3 && n % 100 !== 13 ? "rd" : "th"}`;

/** The lines, or none while nothing holds or waits for the slot. */
export function capacityLines(c: CapacityFile | undefined, now: Date): string[] {
  if (!c || (!c.held.length && !c.waiting.length)) return [];
  const at = (iso: string) => formatClock(iso, now);
  const lines = [`machine ${c.workstation} (${c.slots.heavy === 1 ? "one heavy operation at a time" : `${c.slots.heavy} heavy operations at a time`}, across projects):`];
  for (const r of c.held) lines.push(`  running: ${what(r)}, since ${at(r.granted_at ?? r.requested_at)}`);
  const ahead = c.held.length ? `behind ${c.held.map(what).join(", ")}` : c.outside ? "behind a full test run outside Nexus" : "";
  c.waiting.forEach((r, i) => lines.push(`  waiting: ${what(r)}, since ${at(r.requested_at)}, ${ordinal(i + 1)} in line${ahead ? `, ${ahead}` : ""}`));
  if (c.outside) {
    const since = Number.isNaN(Date.parse(c.outside.since)) ? c.outside.since : at(c.outside.since);
    lines.push(`  outside Nexus: a full test run in ${c.outside.cwd} (pid ${c.outside.pid}, since ${since}); nothing is granted until it ends`);
  }
  return lines;
}
