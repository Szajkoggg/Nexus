// A seed for the capture tool: a test project "demo" (a git repository) with two finished worktree queues merged back
// whose cleanup waits for their worker process (queue LCK, survey LC3 F2): V's process is still ending, W's did not end
// even when Nexus killed it by force. The waits are written as the Merger records them (git.yaml `merge.waiting`);
// merge_back is off, so the development instance's own Merger leaves them as they are (it cleans up only with
// merge_back on). Run by scripts/capture.ts as `node <this> <data dir>` with NEXUS_HOME set to the development
// instance's; it writes only under the data directory and that NEXUS_HOME.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ProjectStore, approveQueue, newId, writeRegistry, type Event, type SessionFile, type StepDef } from "@nexus/protocol";

const dir = process.argv[2];
if (!dir) throw new Error("usage: node seed-process-wait.ts <data dir>");
const root = join(dir, "demo").replaceAll("\\", "/");
mkdirSync(root, { recursive: true });
const NL = String.fromCharCode(10);
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=demo", "-c", "user.email=demo@example.invalid", "-c", "commit.gpgsign=false", ...a], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
git("init", "-q", "-b", "main");
writeFileSync(join(root, ".gitignore"), `.nexus/${NL}`); writeFileSync(join(root, "README.md"), `# Demo app${NL}`);
git("add", "-A"); git("commit", "-qm", "init");

const st = ProjectStore.init(root, { id: "demo", name: "Demo app", root, orchestrator: { session: null } });
writeRegistry({ protocol: 1, projects: [{ id: "demo", root }] });
st.markReviewLevels(ago(24 * 60));
const session = (role: SessionFile["role"], title: string, queue?: string): SessionFile => {
  const s: SessionFile = { protocol: 1, id: newId(), project: "demo", role, runtime: "claude", title, cwd: root, launched_by: "nexus", created_at: ago(300), ...(queue ? { queue } : {}) };
  st.writeSession(s);
  return s;
};
const emit = (s: SessionFile, min: number, body: Record<string, unknown>) => st.appendEvent({ v: 1, id: newId(), at: ago(min), session: s.id, ...body } as Event);
const user = session("user", "You");
const orch = session("orchestrator", "Orchestrator");
const step = (id: string, title: string): StepDef => ({ id, title, goal: `${title}.`, acceptance: [] });

/** A queue whose branch is merged into main (a fast-forward by Nexus), its cleanup waiting `since` with `reason`. */
function merged(id: string, title: string, file: string, start: number, reason: (worker: SessionFile) => string, since: number) {
  git("checkout", "-q", "-b", `nexus/${id}`); writeFileSync(join(root, file), `export const ${id.toLowerCase()} = 1;${NL}`); git("add", file); git("commit", "-qm", `${id}: ${title}`);
  git("checkout", "-q", "main"); git("merge", "-q", "--ff-only", `nexus/${id}`);
  const tip = git("rev-parse", "HEAD");
  st.writeQueue({ protocol: 1, id, title, revision: 1, status: "proposed", coding: true, worktree: `${root}.worktrees/${id}`, branch: `nexus/${id}`, integration: true,
    checks: [], stop_conditions: [], steps: [step(`${id}1`, title)] });
  approveQueue(st, id);
  const w = session("worker", `${id} worker`, id);
  const steps = [`${id}1`, `${id}.refactor`, `${id}.integrate`]; // with the closing and integration steps the queue gets
  const rounds: Record<string, { session: string; start: string; started_at: string; end: string; ended_at: string }[]> = {};
  steps.forEach((s, i) => {
    const at = start - i * 20;
    emit(w, at, { type: "step.started", queue: id, step: s });
    emit(w, at - 10, { type: "step.done", queue: id, step: s, summary: `${s} done.`, commit: tip });
    emit(s.endsWith(".integrate") ? orch : user, at - 12, { type: "review.accepted", queue: id, step: s });
    rounds[s] = [{ session: w.id, start: tip, started_at: ago(at), end: tip, ended_at: ago(at - 10) }];
  });
  st.writeRun(id, { protocol: 1, session: w.id, state: "finished", started_at: ago(start), updated_at: ago(start - 30), ended_at: ago(start - 30) });
  st.writeGit(id, {
    protocol: 1, base: { ref: "main", sha: tip, at: ago(start), branch: true }, steps: rounds,
    merged: { at: ago(since + 1), into: "main", path: root, sha: tip, fast_forward: true, by: "nexus" },
    merge: { waiting: { reason: reason(w), since: ago(since) } },
  });
}

merged("V", "Export as CSV", "csv.ts", 90, (w) => `queue V's cleanup waits for its worker process to end (session ${w.id}); Nexus kills it by force if it has not ended 60 s after it was asked`, 0.5);
merged("W", "Statistics backend", "stats.ts", 200, (w) => `queue W's worker process did not end even when Nexus killed it by force (session ${w.id}, process 18244): its cleanup waits until it has ended; end it by hand if it does not`, 3);
console.log(`seeded ${root}`);
