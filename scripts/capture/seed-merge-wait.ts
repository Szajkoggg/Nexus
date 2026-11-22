// A seed for the capture tool: a test project "demo" (a git repository) with a finished worktree queue W whose merge
// back waits: the main checkout has uncommitted changes (the instance's own Merger finds that and says why, in the
// Waiting tab's "Merging back" item). W's steps, among them the long ids W.refactor and W.integrate, finished late
// yesterday, so the morning digest lists them with a date before the time, beside a long project name. Run by
// scripts/capture.ts as `node <this> <data dir>` with NEXUS_HOME set to the development instance's; it writes only
// under the data directory and that NEXUS_HOME. (scripts/capture/seed-merge.ts is the same project with a queue merged back as well.)
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ProjectStore, approveQueue, newId, updateSettings, writeRegistry, type Event, type SessionFile, type StepDef } from "@nexus/protocol";

const dir = process.argv[2];
if (!dir) throw new Error("usage: node seed-merge-wait.ts <data dir>");
const root = join(dir, "demo").replaceAll("\\", "/");
mkdirSync(root, { recursive: true });
const NL = String.fromCharCode(10);
// Late yesterday: 30 minutes before today's midnight, then earlier. The digest reads the last 24 hours.
const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
const yesterday = (min: number) => new Date(midnight.getTime() - (30 + min) * 60_000).toISOString();
const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=demo", "-c", "user.email=demo@example.invalid", "-c", "commit.gpgsign=false", ...a], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
git("init", "-q", "-b", "main");
writeFileSync(join(root, ".gitignore"), `.nexus/${NL}`); writeFileSync(join(root, "README.md"), `# Demo app${NL}`);
git("add", "-A"); git("commit", "-qm", "init");
// W's branch: its work (its integration step's commit is the branch's tip).
git("checkout", "-q", "-b", "nexus/W"); writeFileSync(join(root, "stats.ts"), `export const totals = [];${NL}`); git("add", "stats.ts"); git("commit", "-qm", "W: daily totals");
git("checkout", "-q", "main");
const tip = git("rev-parse", "nexus/W");

const st = ProjectStore.init(root, { id: "demo", name: "Demo app, statistics backend", root, orchestrator: { session: null } });
writeRegistry({ protocol: 1, projects: [{ id: "demo", root }] });
st.markReviewLevels(yesterday(24 * 60));
updateSettings(st, { defaults: { merge_back: true } });
const session = (role: SessionFile["role"], title: string, queue?: string): SessionFile => {
  const s: SessionFile = { protocol: 1, id: newId(), project: "demo", role, runtime: "claude", title, cwd: root, launched_by: "nexus", created_at: yesterday(600), ...(queue ? { queue } : {}) };
  st.writeSession(s);
  return s;
};
const emit = (s: SessionFile, min: number, body: Record<string, unknown>) => st.appendEvent({ v: 1, id: newId(), at: yesterday(min), session: s.id, ...body } as Event);
const user = session("user", "You");
const orch = session("orchestrator", "Orchestrator");
const step = (id: string, title: string, goal: string, acceptance: string[]): StepDef => ({ id, title, goal, acceptance });
const sha = (n: number) => n.toString(16).padStart(8, "0").repeat(5);

const wt = `${root}.worktrees/W`;
const defs = [
  step("W1", "Daily totals", "Steps and queues done per day, from the event logs.", ["Unit tests on a fixture log"]),
  step("W2", "Stats API", "GET /api/projects/:id/stats with the daily totals.", ["An API test"]),
];
st.writeQueue({ protocol: 1, id: "W", title: "Statistics backend", revision: 1, status: "proposed", coding: true, worktree: wt, branch: "nexus/W", integration: true,
  checks: ["npm run typecheck", "npm test"], stop_conditions: [], steps: defs });
approveQueue(st, "W");
const w = session("worker", "W worker", "W");
const ids = ["W1", "W2", "W.refactor", "W.integrate"];
const rounds: Record<string, { session: string; start: string; started_at: string; end: string; ended_at: string }[]> = {};
let min = 160;
ids.forEach((s, i) => {
  emit(w, min, { type: "step.started", queue: "W", step: s });
  if (s === "W.integrate") for (const c of ["npm run typecheck", "npm test"]) emit(w, min - 8, { type: "check.result", queue: "W", step: s, name: c, ok: true, duration: c === "npm test" ? 212 : 14 });
  const summary = s === "W.integrate" ? "Merged main (3 commits) into the branch; no conflict; both checks pass on the result."
    : s === "W.refactor" ? "Two helpers merged into one; behaviour unchanged, checks pass." : `${s} done.`;
  emit(w, min - 10, { type: "step.done", queue: "W", step: s, summary, commit: sha(160 + i) });
  emit(s === "W.integrate" ? orch : user, min - 12, { type: "review.accepted", queue: "W", step: s });
  rounds[s] = [{ session: w.id, start: sha(160 + i - 1), started_at: yesterday(min), end: i === ids.length - 1 ? tip : sha(160 + i), ended_at: yesterday(min - 10) }];
  min -= 35;
});
st.writeRun("W", { protocol: 1, session: w.id, state: "finished", started_at: yesterday(160), updated_at: yesterday(min), ended_at: yesterday(min + 5) });
st.writeGit("W", { protocol: 1, base: { ref: "main", sha: sha(159), at: yesterday(160), branch: true }, steps: rounds });
// The main checkout's uncommitted change that keeps the merge back waiting.
writeFileSync(join(root, "README.md"), `# Demo app${NL}${NL}A note not committed yet.${NL}`);
console.log(`seeded ${root}`);
