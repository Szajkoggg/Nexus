// A seed for the capture tool: a test project "demo" with a deploy planned after one of its steps (queue PD), for the
// planned deploy on the right rail, the phone's Waiting tab and the Nexus section of the settings. Run by
// scripts/capture.ts as `node <this> <data dir>` with NEXUS_HOME set to the development instance's; it writes only
// there.
//
// - SD ("Search in the docs"): SD1 done, SD2 at work (its events only: no run, so nothing is started), SD3 pending. The
//   plan waits for SD2: it never comes in, so the instance never starts an update.
// - RV has a step waiting for the user's review, so the rail's Waiting list is not empty.
// - The plan file (<NEXUS_HOME>/deploy-plan.json) is written here as a fixture; on a server only the server writes it.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ProjectStore, approveQueue, newId, nexusHome, writeRegistry, type Event, type SessionFile } from "@nexus/protocol";

const dir = process.argv[2];
if (!dir) throw new Error("usage: node seed-planned-deploy.ts <data dir>");
const root = join(dir, "demo");
mkdirSync(root, { recursive: true });
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

const st = ProjectStore.init(root, { id: "demo", name: "Demo app", root });
writeRegistry({ protocol: 1, projects: [{ id: "demo", root }] });
const session = (id: string, role: SessionFile["role"], title: string, queue?: string): SessionFile => {
  const s: SessionFile = { protocol: 1, id, project: "demo", role, runtime: "claude", title, cwd: root, launched_by: "nexus", created_at: ago(300), ...(queue ? { queue } : {}) };
  st.writeSession(s);
  return s;
};
const emit = (s: SessionFile, min: number, body: Record<string, unknown>) => st.appendEvent({ v: 1, id: newId(), at: ago(min), session: s.id, ...body } as Event);
const queue = (id: string, title: string, steps: [string, string, string][], over: Record<string, unknown> = {}) => {
  st.writeQueue({ protocol: 1, id, title, revision: 1, status: "proposed", stop_conditions: [], checks: [], ...over,
    steps: steps.map(([sid, stitle, goal]) => ({ id: sid, title: stitle, goal, acceptance: ["Done"] })) });
  approveQueue(st, id);
};
const user = session("user", "user", "You");
const orch = session(newId(), "orchestrator", "Orchestrator");
st.updateProject((p) => ({ ...p, orchestrator: { runtime: "claude", notify: false, ...p.orchestrator, session: orch.id } }));

// SD: SD1 done and accepted, SD2 at work.
const sd = session(newId(), "worker", "SD worker", "SD");
queue("SD", "Search in the docs", [["SD1", "Index the docs", "An index."], ["SD2", "Search box", "A search box."], ["SD3", "Highlight hits", "Highlights."]]);
emit(sd, 60, { type: "step.started", queue: "SD", step: "SD1" });
emit(sd, 35, { type: "step.done", queue: "SD", step: "SD1", summary: "The docs are indexed at build time." });
emit(user, 34, { type: "review.accepted", queue: "SD", step: "SD1" });
emit(sd, 30, { type: "step.started", queue: "SD", step: "SD2" });
emit(sd, 5, { type: "step.progress", queue: "SD", step: "SD2", text: "Results list wired to the index", pct: 60 });

// RV: a step waiting for the user's review.
const rv = session(newId(), "worker", "RV worker", "RV");
queue("RV", "Waiting tab with reasons", [["RV1", "Reasons", "Each waiting item says why."], ["RV2", "Polish", "Spacing."]], { review_policy: "wait" });
emit(rv, 95, { type: "step.started", queue: "RV", step: "RV1" });
emit(rv, 70, { type: "step.done", queue: "RV", step: "RV1", summary: "Every waiting item now says why it waits." });

// The plan: a deploy after SD2, planned by the orchestrator when the user asked.
mkdirSync(nexusHome(), { recursive: true });
writeFileSync(join(nexusHome(), "deploy-plan.json"), JSON.stringify({
  protocol: 1,
  plan: { id: newId(), after: { project: "demo", queue: "SD", step: "SD2" }, by: { project: "demo", session: orch.id }, created_at: ago(12) },
}, null, 2) + "\n");
console.log(`seeded ${root}`);
