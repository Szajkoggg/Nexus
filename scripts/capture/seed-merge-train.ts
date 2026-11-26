// A seed for the capture tool: a test project "demo" (a git repository, merge_back on) for the merge train (queue MQ;
// docs/protocol/git.md, "The merge train"). W's integration step waits for the user's review (the orchestrator does not review
// here: notify off), so W holds main; B, another
// worktree queue, finished its own step and is held before its integration step ("for an update", so the instance
// resumes it, and its boundary holds it again for the train); N is planned after B, so the Queues view shows its plan.
// Run by scripts/capture.ts as `node <this> <data dir>` with NEXUS_HOME set to the development instance's; it writes
// only under the data directory and that NEXUS_HOME. It uses only what the protocol has had since the integration step,
// so it also seeds the code of a base commit from then on (where B simply integrates beside W).
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ProjectStore, approveQueue, newId, updateSettings, writeRegistry, type Event, type PlanFile, type SessionFile } from "@nexus/protocol";
import { requireTempHome } from "../temp-home.ts";

requireTempHome();

const dir = process.argv[2];
if (!dir) throw new Error("usage: node seed-merge-train.ts <data dir>");
const root = join(dir, "demo").replaceAll("\\", "/");
mkdirSync(root, { recursive: true });
const NL = String.fromCharCode(10);
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.name=demo", "-c", "user.email=demo@example.invalid", "-c", "commit.gpgsign=false", ...a], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
git(root, "init", "-q", "-b", "main");
writeFileSync(join(root, ".gitignore"), `.nexus/${NL}`); writeFileSync(join(root, "README.md"), `# Demo app${NL}`);
git(root, "add", "-A"); git(root, "commit", "-qm", "init");
const base = git(root, "rev-parse", "HEAD");

const st = ProjectStore.init(root, { id: "demo", name: "Demo app", root, orchestrator: { session: null, notify: false } });
writeRegistry({ protocol: 1, projects: [{ id: "demo", root }] });
st.markReviewLevels(ago(24 * 60)); // the review levels apply to every step here (none counts as accepted by being old)
updateSettings(st, { defaults: { merge_back: true } });
const session = (role: SessionFile["role"], title: string, cwd = root, queue?: string): SessionFile => {
  const s: SessionFile = { protocol: 1, id: newId(), project: "demo", role, runtime: "claude", title, cwd, launched_by: "nexus", created_at: ago(120), ...(queue ? { queue } : {}) };
  st.writeSession(s);
  return s;
};
const emit = (s: SessionFile, min: number, body: Record<string, unknown>) => st.appendEvent({ v: 1, id: newId(), at: ago(min), session: s.id, ...body } as Event);
const user = session("user", "You");

/** A worktree queue with one step of its own, done and accepted, its work committed on its branch. */
const worktreeQueue = (id: string, title: string, stepTitle: string, min: number) => {
  const wt = `${root}.worktrees/${id}`;
  git(root, "worktree", "add", "-q", "-b", `nexus/${id}`, wt, "main");
  writeFileSync(join(wt, `${id.toLowerCase()}.ts`), `export const ${id.toLowerCase()} = 1;${NL}`);
  git(wt, "add", "-A"); git(wt, "commit", "-qm", `${id}: ${stepTitle}`);
  st.writeQueue({ protocol: 1, id, title, revision: 1, status: "proposed", worktree: wt, branch: `nexus/${id}`, integration: true, stop_conditions: [], checks: [],
    steps: [{ id: `${id}1`, title: stepTitle, goal: "FAKE: done", acceptance: ["Done"] }] });
  approveQueue(st, id);
  const w = session("worker", `${id} worker`, wt, id);
  emit(w, min, { type: "step.started", queue: id, step: `${id}1` });
  emit(w, min - 10, { type: "step.done", queue: id, step: `${id}1`, summary: `${stepTitle} done.`, commit: git(wt, "rev-parse", "HEAD") });
  emit(user, min - 11, { type: "review.accepted", queue: id, step: `${id}1` });
  st.writeGit(id, { protocol: 1, base: { ref: "main", sha: base, at: ago(min), branch: true }, steps: {} });
  return { wt, w };
};

// W: its integration step done, waiting for the user's review: it holds main.
const W = worktreeQueue("W", "Statistics backend", "Daily totals", 60);
const tip = git(W.wt, "rev-parse", "HEAD");
emit(W.w, 40, { type: "step.started", queue: "W", step: "W.integrate" });
emit(W.w, 35, { type: "step.done", queue: "W", step: "W.integrate", summary: "Merged main into the branch; no conflict; the checks pass.", commit: tip });
st.writeRun("W", { protocol: 1, session: W.w.id, state: "paused", reason: "paused by the user", step: "W.integrate", started_at: ago(60), updated_at: ago(34), ended_at: ago(34), runtime: "claude", revision: 1 });
st.writeGit("W", { protocol: 1, base: { ref: "main", sha: base, at: ago(60), branch: true },
  steps: { "W.integrate": [{ session: W.w.id, start: tip, started_at: ago(40), end: tip, ended_at: ago(35) }] } });

// B: its own step done; held before its integration step (the instance resumes it, and the train holds it again).
const B = worktreeQueue("B", "Export as CSV", "CSV export", 30);
st.writeRun("B", { protocol: 1, session: B.w.id, state: "paused", reason: "held for an update", resume_after_restart: true, step: "B1", started_at: ago(30), updated_at: ago(19), runtime: "claude", revision: 1 });

// N: planned after B, so the plan shows.
st.writeQueue({ protocol: 1, id: "N", title: "Charts on the dashboard", revision: 1, status: "proposed", stop_conditions: [], checks: [],
  steps: [{ id: "N1", title: "Charts", goal: "FAKE: done", acceptance: ["Done"] }] });
approveQueue(st, "N");
const plan: PlanFile = { protocol: 1, by: "user", created_at: ago(25), updated_at: ago(25), after: [{ queue: "B", by: "user", at: ago(25) }], decisions: [] };
st.writePlan("N", plan);
st.writeStart("N", { protocol: 1, by: "user", revision: 1, created_at: ago(25) });
console.log(`seeded ${root}`);
