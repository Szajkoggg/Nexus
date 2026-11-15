// A seed for the capture tool: a test project "demo" (a git repository) with a worktree queue "SC" whose two finished
// steps have commits of their own (two in SC1, one in SC2), so that a step's commits and its queue's branch show, and a
// planned queue "PL" beside it, and a short orchestrator chat. The commits have fixed dates, so their hashes are the same on every run. Run by
// scripts/capture.ts as `node <this> <data dir>` with NEXUS_HOME set to the development instance's; it writes only
// under the data directory and that NEXUS_HOME.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ProjectStore, approveQueue, newId, writeRegistry, type Event, type SessionFile } from "@nexus/protocol";

const dir = process.argv[2];
if (!dir) throw new Error("usage: node seed-commits.ts <data dir>");
const root = join(dir, "demo").replaceAll("\\", "/");
const wt = `${root}.worktrees/SC`;
mkdirSync(root, { recursive: true });
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
let tick = 0;
/** git in `cwd`, each commit one minute after the last from a fixed date. */
const git = (cwd: string, ...a: string[]) => {
  const date = new Date(Date.UTC(2026, 10, 1, 9, tick++)).toISOString();
  return execFileSync("git", ["-c", "user.name=demo", "-c", "user.email=demo@example.invalid", "-c", "commit.gpgsign=false", ...a], {
    cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  }).trim();
};
const commit = (cwd: string, file: string, text: string, subject: string) => {
  writeFileSync(join(cwd, file), text);
  git(cwd, "add", file); git(cwd, "commit", "-qm", subject);
  return git(cwd, "rev-parse", "HEAD");
};

git(root, "init", "-q", "-b", "main");
writeFileSync(join(root, ".gitignore"), ".nexus/\n");
const base = commit(root, "README.md", "# Demo app\n", "init");
git(root, "worktree", "add", "-q", "-b", "nexus/SC", wt);
commit(wt, "search.ts", "export const search = (q: string) => q.trim();\n", "Search: trim the query");
const s1b = commit(wt, "search.test.ts", "// trims\n", "Search: a test of the trim");
const s2 = commit(wt, "history.ts", "export const history: string[] = [];\n", "History: the last searches, newest first");

const st = ProjectStore.init(root, { id: "demo", name: "Demo app", root, orchestrator: { session: null } });
writeRegistry({ protocol: 1, projects: [{ id: "demo", root }] });
const w: SessionFile = { protocol: 1, id: newId(), project: "demo", role: "worker", runtime: "claude", title: "SC worker", cwd: wt, launched_by: "nexus", created_at: ago(120), queue: "SC" };
const user: SessionFile = { protocol: 1, id: newId(), project: "demo", role: "user", runtime: "claude", title: "You", cwd: root, launched_by: "nexus", created_at: ago(120) };
st.writeSession(w); st.writeSession(user);
const emit = (s: SessionFile, min: number, body: Record<string, unknown>) => st.appendEvent({ v: 1, id: newId(), at: ago(min), session: s.id, ...body } as Event);

st.writeQueue({ protocol: 1, id: "SC", title: "Search with history", revision: 1, status: "proposed", coding: true, worktree: wt, branch: "nexus/SC",
  checks: ["npm test"], stop_conditions: [], steps: [
    { id: "SC1", title: "Trimmed search", goal: "The query is trimmed before it is sent.", acceptance: ["A unit test of the trim"] },
    { id: "SC2", title: "Search history", goal: "The last searches are kept, newest first.", acceptance: ["A unit test of the order"] },
  ] });
approveQueue(st, "SC");
emit(w, 100, { type: "step.started", queue: "SC", step: "SC1" });
emit(w, 90, { type: "check.result", queue: "SC", step: "SC1", name: "npm test", ok: true, duration: 21 });
emit(w, 89, { type: "step.done", queue: "SC", step: "SC1", summary: "The query is trimmed; a unit test covers it.", commit: s1b });
emit(user, 85, { type: "review.accepted", queue: "SC", step: "SC1" });
emit(w, 80, { type: "step.started", queue: "SC", step: "SC2" });
emit(w, 70, { type: "check.result", queue: "SC", step: "SC2", name: "npm test", ok: true, duration: 23 });
emit(w, 69, { type: "step.done", queue: "SC", step: "SC2", summary: "The last searches are kept, newest first; a unit test covers the order.", commit: s2 });
emit(user, 65, { type: "review.accepted", queue: "SC", step: "SC2" });
st.writeRun("SC", { protocol: 1, session: w.id, state: "finished", started_at: ago(100), updated_at: ago(65), ended_at: ago(66) });
st.writeGit("SC", { protocol: 1, base: { ref: "main", sha: base, at: ago(100), branch: true }, steps: {
  SC1: [{ session: w.id, start: base, started_at: ago(100), end: s1b, ended_at: ago(89) }],
  SC2: [{ session: w.id, start: s1b, started_at: ago(80), end: s2, ended_at: ago(69) }],
} });

st.writeQueue({ protocol: 1, id: "PL", title: "Saved searches", revision: 1, status: "proposed", checks: ["npm test"], stop_conditions: [], steps: [
  { id: "PL1", title: "Save a search", goal: "A search can be saved under a name.", acceptance: ["A unit test"] },
] });

// The orchestrator's chat: a few turns, so that the chat view has messages of both sides.
const orch: SessionFile = { protocol: 1, id: newId(), project: "demo", role: "orchestrator", runtime: "claude", title: "Orchestrator", cwd: root, launched_by: "nexus", created_at: ago(60) };
st.writeSession(orch);
st.updateProject((p) => ({ ...p, orchestrator: { runtime: "claude", notify: false, ...p.orchestrator, session: orch.id } }));
const PARAGRAPH = String.fromCharCode(10, 10);
const chat: [number, "user" | "orchestrator", string][] = [
  [50, "user", "Where does SC stand?"],
  [49, "orchestrator", ["SC is done: both steps were accepted, and the closing refactoring step is next.", "PL waits for your approval."].join(PARAGRAPH)],
  [30, "user", "Start PL after SC."],
  [29, "orchestrator", "PL is planned after SC; it starts once you approve it."],
];
for (const [min, from, text] of chat) st.appendChat(orch.id, { at: ago(min), from, text });
