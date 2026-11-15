// A seed for the capture tool: a test project "demo" (a git repository) with worktree queues and Nexus merging back
// (queue PW). M was merged back by Nexus (a fast-forward, then cleaned up); W is finished, its branch at its integrated
// commit, but its merge back waits: the main checkout has uncommitted changes (the instance's own Merger finds that
// and keeps it waiting). The project merges back by itself (its own merge_back, on), resolves conflicts as the global
// setting says (off), and sets up each new worktree with npm ci. Run by scripts/capture.ts as `node <this> <data dir>` with NEXUS_HOME set to the
// development instance's; it writes only under the data directory and that NEXUS_HOME.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ProjectStore, approveQueue, newId, updateSettings, writeRegistry, type Event, type SessionFile, type StepDef } from "@nexus/protocol";

const dir = process.argv[2];
if (!dir) throw new Error("usage: node seed-merge.ts <data dir>");
const root = join(dir, "demo").replaceAll("\\", "/");
mkdirSync(root, { recursive: true });
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=demo", "-c", "user.email=demo@example.invalid", "-c", "commit.gpgsign=false", ...a], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
git("init", "-q", "-b", "main");
writeFileSync(join(root, ".gitignore"), ".nexus/\n"); writeFileSync(join(root, "README.md"), "# Demo app\n");
git("add", "-A"); git("commit", "-qm", "init");
// W's branch: its work, then main merged into it (its integration step's commit).
git("checkout", "-q", "-b", "nexus/W"); writeFileSync(join(root, "stats.ts"), "export const totals = [];\n"); git("add", "stats.ts"); git("commit", "-qm", "W: daily totals");
git("checkout", "-q", "main");
const wTip = git("rev-parse", "nexus/W");
const st = ProjectStore.init(root, { id: "demo", name: "Demo app", root, orchestrator: { session: null } });
writeRegistry({ protocol: 1, projects: [{ id: "demo", root }] });
st.markReviewLevels(ago(24 * 60));
updateSettings(st, { defaults: { merge_back: true, worktree_setup: "npm ci" } });
const session = (role: SessionFile["role"], title: string, queue?: string): SessionFile => {
  const s: SessionFile = { protocol: 1, id: newId(), project: "demo", role, runtime: "claude", title, cwd: root, launched_by: "nexus", created_at: ago(600), ...(queue ? { queue } : {}) };
  st.writeSession(s);
  return s;
};
const emit = (s: SessionFile, min: number, body: Record<string, unknown>) => st.appendEvent({ v: 1, id: newId(), at: ago(min), session: s.id, ...body } as Event);
const user = session("user", "You");
const orch = session("orchestrator", "Orchestrator");
const step = (id: string, title: string, goal: string, acceptance: string[]): StepDef => ({ id, title, goal, acceptance });
const sha = (n: number) => n.toString(16).padStart(8, "0").repeat(5);

/** A finished worktree queue: its steps and its integration step done and accepted, its git records written. */
function finished(id: string, title: string, defs: StepDef[], start: number, tip?: string) {
  const wt = `${root}.worktrees/${id}`;
  st.writeQueue({ protocol: 1, id, title, revision: 1, status: "proposed", coding: true, worktree: wt, branch: `nexus/${id}`, integration: true,
    checks: ["npm run typecheck", "npm test"], stop_conditions: [], steps: defs });
  approveQueue(st, id);
  const w = session("worker", `${id} worker`, id);
  let min = start;
  const rounds: Record<string, { session: string; start: string; started_at: string; end: string; ended_at: string }[]> = {};
  const ids = [...defs.map((d) => d.id), `${id}.refactor`, `${id}.integrate`];
  ids.forEach((s, i) => {
    emit(w, min, { type: "step.started", queue: id, step: s });
    if (s.endsWith(".integrate")) {
      for (const c of ["npm run typecheck", "npm test"]) emit(w, min - 8, { type: "check.result", queue: id, step: s, name: c, ok: true, duration: c === "npm test" ? 212 : 14 });
    }
    const summary = s.endsWith(".integrate") ? "Merged main (3 commits) into the branch; no conflict; both checks pass on the result."
      : s.endsWith(".refactor") ? "Two helpers merged into one; behaviour unchanged, checks pass." : `${s} done.`;
    emit(w, min - 10, { type: "step.done", queue: id, step: s, summary, commit: sha(start + i) });
    emit(s.endsWith(".integrate") ? orch : user, min - 12, { type: "review.accepted", queue: id, step: s });
    const end = tip && i === ids.length - 1 ? tip : sha(start + i);
    rounds[s] = [{ session: w.id, start: sha(start + i - 1), started_at: ago(min), end, ended_at: ago(min - 10) }];
    min -= 20;
  });

  st.writeRun(id, { protocol: 1, session: w.id, state: "finished", started_at: ago(start), updated_at: ago(min), ended_at: ago(min + 5) });
  st.writeGit(id, { protocol: 1, base: { ref: "main", sha: sha(start - 1), at: ago(start), branch: true }, steps: rounds });

  return { wt, end: tip ?? sha(start + ids.length - 1), min };
}

// M: merged back by Nexus, then cleaned up.
const m = finished("M", "Search history", [
  step("M1", "History as data", "Searches kept per user, newest first, at most 50.", ["Unit tests for the limit and the order"]),
  step("M2", "History list", "The list under the search box, with Clear.", ["A test of Clear"]),
], 300);
const gm = st.readGit("M")!;
st.writeGit("M", { ...gm, merged: { at: ago(m.min + 3), into: "main", path: root, sha: m.end, fast_forward: true, by: "nexus" }, cleaned: { at: ago(m.min + 2), path: m.wt, branch: "nexus/M" } });

// W: finished, its merge back waiting for a clean main checkout (after one run again).
const w = finished("W", "Statistics backend", [
  step("W1", "Daily totals", "Steps and queues done per day, from the event logs.", ["Unit tests on a fixture log"]),
  step("W2", "Stats API", "GET /api/projects/:id/stats with the daily totals.", ["An API test"]),
], 160, wTip);
const gw = st.readGit("W")!;
st.writeGit("W", { ...gw, merge: { waiting: { reason: `${root} has uncommitted changes: commit or stash them, then merge`, since: ago(w.min + 1) }, reintegrations: 1 } });
// The main checkout's uncommitted change that keeps it waiting.
writeFileSync(join(root, "README.md"), "# Demo app\n\nA note not committed yet.\n");
