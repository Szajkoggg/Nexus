// IWS's fixture: the ideas notes of seed-ideas-corrections.ts with every kind of implementation state side by side
// (linked work finished but not confirmed, some linked work finished, confirmed, partially implemented, work linked),
// and a queue the user paused four days ago (the paused-queue warning of IWS3). The same data serves the befores of
// IWS1 and the afters of IWS2, IWS3 and IWS4B. Writes only the capture tool's isolated demo project.
import "./seed-ideas-corrections.ts";
import { join } from "node:path";
import { ProjectStore, loadProjectState, newId, revisionHash, type Event, type QueueFile } from "@nexus/protocol";
import { ideaStatuses } from "../../packages/protocol/src/ideas-read.ts";
import { changeIdeaStatus } from "../../packages/protocol/src/idea-status-actions.ts";

const dir = process.argv[2];
if (!dir) throw new Error("usage: node seed-idea-work-signals.ts <data dir>");
const root = join(dir, "demo");
const store = new ProjectStore(join(root, ".nexus"));

// Confirmed in full, and partially implemented: the user's assessments, not derived from the queues.
for (const [operation, ref, reason] of [
  ["confirm", "docs/ideas/deploy-timing.md#2026-11-13", "Planned deploys work after a step, a queue and at a time."],
  ["partial", "docs/ideas/parallel-worktrees-and-merge-back.md#2026-11-15", "Worktrees run; the merge-back still waits for the user by hand."],
] as const) {
  const revision = ideaStatuses(store, loadProjectState(store)).revision;
  changeIdeaStatus(store, { operation, request_id: `fixture-${operation}`, revision, ref, reason });
}

// A queue the user paused four days ago, at its second step.
const ago = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();
const ad: QueueFile = {
  protocol: 1, id: "AD", title: "Agent digest in the morning", revision: 1, status: "approved", review_level: 2, stop_conditions: [],
  checks: ["npm test"], approvals: [], withdrawals: [], history: [], changes: [], created_at: ago(24 * 6), updated_at: ago(24 * 6),
  steps: [1, 2, 3].map((i) => ({ id: `AD${i}`, title: ["Collect", "Summarize", "Show"][i - 1]!, goal: "g", acceptance: ["Done"] })),
};
store.writeQueue({ ...ad, approvals: [{ revision: 1, at: ago(24 * 6 - 1), hash: revisionHash(ad) }] });
const worker = newId();
store.writeSession({ protocol: 1, id: worker, project: "demo", role: "worker", runtime: "claude", title: "AD worker", cwd: root, launched_by: "nexus", created_at: ago(24 * 5), queue: "AD" });
for (const [type, step, at, more] of [
  ["step.started", "AD1", ago(24 * 5), {}],
  ["step.done", "AD1", ago(24 * 4 + 2), { summary: "The digest collects the night's events.", commit: "abc1234" }],
] as const) store.appendEvent({ v: 1, id: newId(), type, session: worker, at, queue: "AD", step, ...more } as Event);
store.writeRun("AD", { protocol: 1, session: worker, state: "paused", reason: "paused by the user", step: "AD2", started_at: ago(24 * 5), updated_at: ago(24 * 4), ended_at: ago(24 * 4), runtime: "claude", revision: 1 });
console.log(`IWS fixture: assessments and a paused queue in ${root}`);
