// A seed for the capture tool: a test project "demo" with a queue FL whose steps FL2 and FL3 stopped by design once
// they found a cause, and were then skipped as continued elsewhere (docs/design/continued.md): FL2 in FL4 and FL5, FL3
// in FL6 to FL8. FL1 and FL4 are done, FL5 waits for the user's review, FL6 to FL8 are pending. Run by
// scripts/capture.ts as `node <this> <data dir>` with NEXUS_HOME set to the development instance's; it writes only
// under the data directory and that NEXUS_HOME.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ProjectStore, approveQueue, newId, writeRegistry, type Event, type SessionFile, type StatusChange, type StepDef } from "@nexus/protocol";
import { requireTempHome } from "../temp-home.ts";

requireTempHome();

const dir = process.argv[2];
if (!dir) throw new Error("usage: node seed-continued.ts <data dir>");
const root = join(dir, "demo").replaceAll("\\", "/");
mkdirSync(root, { recursive: true });
// Minutes before now: the digest reads the last 24 hours.
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

const st = ProjectStore.init(root, { id: "demo", name: "Demo app", root, orchestrator: { session: null } });
writeRegistry({ protocol: 1, projects: [{ id: "demo", root }] });
st.markReviewLevels(ago(24 * 60));
const session = (role: SessionFile["role"], title: string, queue?: string): SessionFile => {
  const s: SessionFile = { protocol: 1, id: newId(), project: "demo", role, runtime: "claude", title, cwd: root, launched_by: "nexus", created_at: ago(600), ...(queue ? { queue } : {}) };
  st.writeSession(s);
  return s;
};
const emit = (s: SessionFile, min: number, body: Record<string, unknown>) => st.appendEvent({ v: 1, id: newId(), at: ago(min), session: s.id, ...body } as Event);
const user = session("user", "You");
session("orchestrator", "Orchestrator");
const w = session("worker", "FL worker", "FL");
const step = (id: string, title: string, goal: string): StepDef => ({ id, title, goal, acceptance: ["The cause named, with a reproduction"] });

st.writeQueue({
  protocol: 1, id: "FL", title: "Flaky full-suite failures: causes and fixes", revision: 1, status: "proposed", stop_conditions: [
    "If a failure's cause is in the product, describe the reproduction and the cause and stop before fixing it.",
  ], checks: ["npm test"], steps: [
    step("FL1", "Collect the failures", "List the full-suite failures of the last week with their logs."),
    step("FL2", "Coordinator wait: the cause", "Find why the coordinator test waits beyond its limit in the full suite."),
    step("FL3", "Three failures: the causes", "Find the causes of the three failures that come back."),
    step("FL4", "Clock step: the design", "Design how the coordinator stands a clock that jumps."),
    step("FL5", "Clock step: the fix", "Build the design of FL4."),
    step("FL6", "Test limit: the fix", "Raise the test limit where the machine is slow."),
    step("FL7", "Port reuse: the fix", "Free the port before the next test takes it."),
    step("FL8", "Temp folders: the fix", "Remove each test's temporary folder."),
  ],
});
approveQueue(st, "FL");
// FL1 done; FL2 and FL3 stopped at the stop condition, each with the cause written up.
emit(w, 600, { type: "step.started", queue: "FL", step: "FL1" });
emit(w, 580, { type: "step.done", queue: "FL", step: "FL1", summary: "Four failures in a week: the coordinator wait, a test limit, a port, temporary folders." });
emit(user, 575, { type: "review.accepted", queue: "FL", step: "FL1" });
emit(w, 570, { type: "step.started", queue: "FL", step: "FL2" });
emit(w, 540, { type: "queue.stop", queue: "FL", step: "FL2", condition: "If a failure's cause is in the product, describe the reproduction and the cause and stop before fixing it.", reason: "The cause is in the product: the system clock jumped 240 s forward and the coordinator's wait counted it." });

// The user lifts the stop by approving the next revision; the orchestrator skips the steps as continued elsewhere.
const q = st.readQueue("FL");
const change = (min: number, c: Omit<StatusChange, "at" | "revision">): StatusChange => ({ at: ago(min), revision: 1, ...c });
const changes: StatusChange[] = [
  change(500, { kind: "lift", by: "user_approval", from: "stopped", to: "approved", reason: "the fix is planned as FL4 and FL5" }),
  change(495, { kind: "status", by: "orchestrator", step: "FL2", from: "pending", to: "skipped", reason: "Cause found and documented (clock step, product side; FL2-cause.md); the fix is planned as FL4 (design) and FL5 (code).", continued_in: ["FL4", "FL5"] }),
];
st.writeQueue({ ...q, changes });
emit(w, 480, { type: "step.started", queue: "FL", step: "FL3" });
emit(w, 440, { type: "queue.stop", queue: "FL", step: "FL3", condition: "If a failure's cause is in the product, describe the reproduction and the cause and stop before fixing it.", reason: "Three causes found: a test limit, a port reused, temporary folders left behind." });
st.writeQueue({
  ...st.readQueue("FL"), changes: [...changes,
    change(420, { kind: "lift", by: "user_approval", from: "stopped", to: "approved", reason: "the fixes are planned as FL6 to FL8" }),
    change(415, { kind: "status", by: "orchestrator", step: "FL3", from: "pending", to: "skipped", reason: "Causes found (FL3-cause.md); the test limit fix is committed.", continued_in: ["FL6", "FL7", "FL8"] }),
  ],
});
// FL4 done, FL5 waits for the user's review.
emit(w, 400, { type: "step.started", queue: "FL", step: "FL4" });
emit(w, 360, { type: "step.done", queue: "FL", step: "FL4", summary: "The coordinator measures its wait on the monotonic clock." });
emit(user, 355, { type: "review.accepted", queue: "FL", step: "FL4" });
emit(w, 350, { type: "step.started", queue: "FL", step: "FL5" });
emit(w, 300, { type: "step.done", queue: "FL", step: "FL5", summary: "The wait uses the monotonic clock; a test jumps the clock 240 s and passes." });
console.log(`seeded ${root}`);
