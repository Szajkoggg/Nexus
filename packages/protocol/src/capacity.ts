// The capacity coordinator's line as `nexus status` prints it (docs/protocol/checks.md, "The capacity coordinator"): what holds
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

/** One heavy operation as the dashboard names it: whose step it is. */
export interface CapacityHolder { project: string; queue: string; step: string; since: string }

/**
 * Where a step's checks wait for the machine (queue EF): its place in line (1-based) of how many wait, and what keeps
 * the slot: the operations holding it, or a full test run outside Nexus (`outside`). Undefined when the step does not
 * wait in the file (it may have been granted since, or the file is not there).
 */
export interface CapacityWait {
  position: number;
  waiting: number;
  /** The operations holding the slot now (another project's checks, or this one's other queue). */
  held: CapacityHolder[];
  /** The ones in line before it. */
  ahead: CapacityHolder[];
  outside?: { cwd: string; pid: number; since: string };
}

const holder = (r: CapacityRequest, granted: boolean): CapacityHolder => ({ project: r.project, queue: r.queue, step: r.step, since: (granted ? r.granted_at : undefined) ?? r.requested_at });

/** The wait of the checks of `project`'s `queue`/`step` in the capacity file. */
export function capacityWait(c: CapacityFile | undefined | null, project: string, queue: string, step: string): CapacityWait | undefined {
  if (!c) return undefined;
  const i = c.waiting.findIndex((r) => r.project === project && r.queue === queue && r.step === step);
  if (i < 0) return undefined;
  return {
    position: i + 1, waiting: c.waiting.length,
    held: c.held.map((r) => holder(r, true)), ahead: c.waiting.slice(0, i).map((r) => holder(r, false)),
    ...(c.outside ? { outside: c.outside } : {}),
  };
}
