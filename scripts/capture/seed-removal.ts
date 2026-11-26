// A seed for the capture tool: two test projects for the Danger zone of a project's settings (docs/protocol/files.md, "Removing a
// project"). "demo" has nothing running, and what a removal lists: a planned start, a scheduled one, an open question
// and a worktree Nexus made. "busy" has a stopped queue and a queue waiting to be merged back, so nothing can be
// removed. Run by scripts/capture.ts as `node <this> <data dir>` with NEXUS_HOME set to the development instance's; it
// writes only there.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ProjectStore, approveQueue, newId, writeRegistry, type Event, type QueueFile, type SessionFile } from "@nexus/protocol";
import { requireTempHome } from "../temp-home.ts";

requireTempHome();

const dir = process.argv[2];
if (!dir) throw new Error("usage: node seed-removal.ts <data dir>");
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const posix = (p: string) => p.replaceAll("\\", "/");

function project(id: string, name: string) {
  const root = join(dir!, id);
  mkdirSync(root, { recursive: true });
  const st = ProjectStore.init(root, { id, name, root });
  const queue = (q: string, title: string, extra: Partial<QueueFile> = {}) => {
    st.writeQueue({
      protocol: 1, id: q, title, revision: 1, status: "proposed", stop_conditions: [], checks: [],
      steps: [{ id: `${q}1`, title: "First step", goal: "Do it.", acceptance: ["Done"] }], ...extra,
    } as QueueFile);
    approveQueue(st, q);
  };
  return { root, st, queue };
}

// demo: nothing runs.
const demo = project("demo", "Demo app");
demo.queue("API", "The public API");
demo.queue("DOC", "API guide");
demo.st.writePlan("DOC", { protocol: 1, by: "user", after: [{ queue: "API", by: "user", at: ago(60) }], created_at: ago(60), updated_at: ago(60), decisions: [] });
demo.queue("NIGHT", "Nightly cleanup");
const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1); tomorrow.setHours(2, 0, 0, 0);
demo.st.writeStart("NIGHT", { protocol: 1, at: tomorrow.toISOString(), by: "user", revision: 1, created_at: ago(30) });
const tree = join(dir, "demo.worktrees", "UI");
mkdirSync(tree, { recursive: true });
demo.queue("UI", "Settings page", { worktree: posix(tree), branch: "nexus/UI", integration: true });
const w: SessionFile = { protocol: 1, id: newId(), project: "demo", role: "worker", runtime: "claude", native_id: "00000000-0000-4000-8000-000000000011", title: "API worker", cwd: demo.root, launched_by: "nexus", created_at: ago(120), queue: "API" };
demo.st.writeSession(w);
demo.st.appendEvent({ v: 1, id: newId(), at: ago(10), session: w.id, type: "question.asked", queue: "API", step: "API1", qid: newId(), text: "Version the API in the path or in a header?", can_continue: false } as Event);

// busy: a stopped queue and a merge back waiting.
const busy = project("busy", "Busy app");
busy.queue("SYNC", "Sync engine");
busy.st.writeQueue({ ...busy.st.readQueue("SYNC"), status: "stopped" });
busy.st.writeRun("SYNC", { protocol: 1, session: w.id, state: "halted", reason: "a stop condition", step: "SYNC1", started_at: ago(90), updated_at: ago(20) });
busy.queue("THEME", "Dark theme", { status: "done" } as Partial<QueueFile>);
busy.st.writeGit("THEME", { protocol: 1, merge: { waiting: { reason: "the checkout has uncommitted changes", since: ago(15) } } } as never);

writeRegistry({ protocol: 1, projects: [{ id: "demo", root: demo.root }, { id: "busy", root: busy.root }] });
console.log(`seeded ${demo.root} and ${busy.root}`);
