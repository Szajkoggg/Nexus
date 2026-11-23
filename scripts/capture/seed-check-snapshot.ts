// A seed for the capture tool: a check that ran into its time limit while Windows made a volume shadow copy, ran once
// more and passed (queue CK2), shown in the step's checks box as "passed (rerun after a disk snapshot)". A development
// instance cannot reach that by itself (the limit is an hour, and the copies come from the machine's event log), so the
// checks file is written as the engine would have left it: the set was running when the run was paused, its first two
// checks ended (npm run lint after a snapshot rerun, npm run typecheck passed), npm test interrupted by the pause. The
// run stays paused, so the engine starts nothing. Run by scripts/capture.ts as `node <this> <data dir>` with NEXUS_HOME
// set to the development instance's; it writes only there.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ProjectStore, approveQueue, newId, writeRegistry, type ChecksFile, type Event, type SessionFile } from "@nexus/protocol";
import { assertTempHome } from "../../apps/server/test/helpers.ts";

assertTempHome(process.env.NEXUS_HOME);
const dir = process.argv[2];
if (!dir) throw new Error("usage: node seed-check-snapshot.ts <data dir>");
const root = join(dir, "demo");
mkdirSync(root, { recursive: true });
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

const st = ProjectStore.init(root, { id: "demo", name: "Demo app", root, orchestrator: { session: null } });
writeRegistry({ protocol: 1, projects: [{ id: "demo", root }] });
st.markReviewLevels(ago(24 * 60));
const checks = ["npm run lint", "npm run typecheck", "npm test"];
st.writeQueue({
  protocol: 1, id: "SR", title: "Search in the step list", revision: 1, status: "proposed", stop_conditions: [], checks,
  steps: [
    { id: "SR1", title: "A search box over the steps", goal: "A search box filters the step list.", acceptance: [] },
    { id: "SR2", title: "Keyboard", goal: "Escape clears the search.", acceptance: [] },
  ],
});
approveQueue(st, "SR");
const worker: SessionFile = { protocol: 1, id: newId(), project: "demo", role: "worker", runtime: "claude", title: "SR worker", cwd: root, launched_by: "nexus", created_at: ago(200), queue: "SR" };
st.writeSession(worker);
const emit = (min: number, body: Record<string, unknown>) => {
  const id = newId();
  st.appendEvent({ v: 1, id, at: ago(min), session: worker.id, ...body } as Event);
  return id;
};
emit(180, { type: "step.started", queue: "SR", step: "SR1" });
const done = emit(130, { type: "step.done", queue: "SR", step: "SR1", summary: "A search box over the step list filters by title and goal." });
st.writeRun("SR", { protocol: 1, session: worker.id, state: "paused", step: "SR1", started_at: ago(180), updated_at: ago(2), revision: 1, runtime: "claude" });

const log = (n: number, name: string, run: number) => `checks/SR1/r1f0-${n}-${name}.${run}.log`;
const file: ChecksFile = {
  protocol: 1,
  steps: {
    SR1: {
      by: "nexus",
      sets: [{
        done, round: 1, fix: 0, commit: "3f2a9c1d5e7b8a6f4c2d1e0b9a8c7d6e5f4a3b2c", requested_at: ago(129), granted_at: ago(129), ended_at: ago(2), state: "interrupted",
        checks: [
          {
            name: checks[0]!, command: checks[0]!, ok: true, snapshot_rerun: true,
            runs: [
              { started_at: ago(129), ended_at: ago(69), duration: 3600, exit_code: null, timed_out: true, log: log(1, "npm-run-lint", 1), tail: "",
                snapshots: [{ at: ago(110), seconds: 41.2, by: "C:\\Windows\\system32\\taskhostw.exe" }] },
              { started_at: ago(69), ended_at: ago(68), duration: 48.3, exit_code: 0, log: log(1, "npm-run-lint", 2) },
            ],
          },
          { name: checks[1]!, command: checks[1]!, ok: true, runs: [{ started_at: ago(68), ended_at: ago(67), duration: 61.7, exit_code: 0, log: log(2, "npm-run-typecheck", 1) }] },
          { name: checks[2]!, command: checks[2]!, runs: [{ started_at: ago(67), ended_at: ago(2), duration: 3900, exit_code: null, interrupted: true, log: log(3, "npm-test", 1) }] },
        ],
      }],
    },
  },
};
st.writeChecks("SR", file);
console.log(`seeded ${root}`);
