// The capacity coordinator's line in `nexus status` (capacityLines): nothing while nothing holds or waits; what runs,
// what waits in which order and behind what, and a full test run outside Nexus.
import { test } from "node:test";
import assert from "node:assert/strict";
import { capacityLines, type CapacityFile } from "../src/index.ts";

const now = new Date(2026, 10, 18, 10, 30);
const local = (h: number, m: number) => new Date(2026, 10, 18, h, m).toISOString();
const file = (o: Partial<CapacityFile>): CapacityFile => ({ protocol: 1, workstation: "WS", slots: { heavy: 1 }, held: [], waiting: [], updated_at: local(10, 30), ...o });
const req = (project: string, queue: string, step: string, at: string, granted?: string) =>
  ({ id: `${queue}${step}`, kind: "checks" as const, project, queue, step, requested_at: at, ...(granted ? { granted_at: granted } : {}) });

test("nothing to show without a file, or while nothing holds or waits", () => {
  assert.deepEqual(capacityLines(undefined, now), []);
  assert.deepEqual(capacityLines(file({}), now), []);
});

test("what runs, then what waits in line behind it", () => {
  const lines = capacityLines(file({
    held: [req("nexus", "EC", "EC3", local(10, 1), local(10, 2))],
    waiting: [req("hc", "W", "W5", local(10, 3)), req("hc", "X", "X1", local(10, 4)), req("nexus", "Y", "Y2", local(10, 5))],
  }), now);
  assert.deepEqual(lines, [
    "machine WS (one heavy operation at a time, across projects):",
    "  running: checks of EC/EC3 (project nexus), since 10:02",
    "  waiting: checks of W/W5 (project hc), since 10:03, 1st in line, behind checks of EC/EC3 (project nexus)",
    "  waiting: checks of X/X1 (project hc), since 10:04, 2nd in line, behind checks of EC/EC3 (project nexus)",
    "  waiting: checks of Y/Y2 (project nexus), since 10:05, 3rd in line, behind checks of EC/EC3 (project nexus)",
  ]);
});

test("a full test run outside Nexus is what the line waits behind", () => {
  const lines = capacityLines(file({ waiting: [req("nexus", "EC", "EC3", local(10, 3))], outside: { cwd: "C:/x", pid: 7, since: local(9, 58) } }), now);
  assert.deepEqual(lines.slice(1), [
    "  waiting: checks of EC/EC3 (project nexus), since 10:03, 1st in line, behind a full test run outside Nexus",
    "  outside Nexus: a full test run in C:/x (pid 7, since 09:58); nothing is granted until it ends",
  ]);
  // A holder whose time cannot be read is shown as the lock says it.
  assert.match(capacityLines(file({ waiting: [req("a", "Q", "Q1", local(10, 3))], outside: { cwd: "?", pid: 0, since: "?" } }), now)[2]!, /since \?\)/);
});
