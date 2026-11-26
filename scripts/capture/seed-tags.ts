// A seed for the capture tool: a test project "demo" with tags (docs/protocol/stats.md, "Tags"). Its lists (.nexus/tags.yaml)
// have areas, an own activity, a rename and two proposals waiting for the user; queue TG is tagged on the queue and on
// its steps, and its first step waits for the user's review with the activities its worker reported. Run by
// scripts/capture.ts as `node <this> <data dir>` with NEXUS_HOME set to the development instance's; it writes only
// there. Tags are new: there is no base commit to seed.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ProjectStore, approveQueue, newId, writeRegistry, type Event, type SessionFile } from "@nexus/protocol";
import { requireTempHome } from "../temp-home.ts";

requireTempHome();

const dir = process.argv[2];
if (!dir) throw new Error("usage: node seed-tags.ts <data dir>");
const root = join(dir, "demo");
mkdirSync(root, { recursive: true });
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

const st = ProjectStore.init(root, { id: "demo", name: "Demo app", root });
writeRegistry({ protocol: 1, projects: [{ id: "demo", root }] });

st.writeTags({
  protocol: 1, prefix: "da",
  areas: [{ name: "dashboard", at: ago(3000) }, { name: "core", at: ago(3000) }, { name: "cli", at: ago(3000) }],
  activities: [{ name: "da:onboarding", at: ago(2000), reason: "First-run screens" }],
  renames: [{ from: "engine", to: "core", at: ago(1000) }],
  proposals: [
    { id: newId(), at: ago(30), kind: "area", name: "billing", reason: "The invoices and the plans get their own queues from next week" },
    { id: newId(), at: ago(20), kind: "rename", name: "terminal", from: "cli", reason: "The user calls it the terminal" },
  ],
  decisions: [],
});

const w: SessionFile = { protocol: 1, id: newId(), project: "demo", role: "worker", runtime: "claude", native_id: "00000000-0000-4000-8000-000000000007", title: "Tags worker", cwd: root, launched_by: "nexus", created_at: ago(120), queue: "TG" };
st.writeSession(w);
const emit = (min: number, body: Record<string, unknown>) => st.appendEvent({ v: 1, id: newId(), at: ago(min), session: w.id, ...body } as Event);

st.writeQueue({
  protocol: 1, id: "TG", title: "Search in the step list", revision: 1, status: "proposed", review_level: 1, stop_conditions: [], checks: ["npm test"],
  kind: "code", origin: "user", area: "dashboard",
  steps: [
    { id: "TG1", title: "A search box over the steps", goal: "Typing filters the step list by title and goal.", acceptance: ["Filters as the user types"],
      activities: ["feature", "ui", "test"], size: "M" },
    { id: "TG2", title: "How the search should rank", goal: "Decide what a match on the goal weighs against one on the title.", acceptance: ["A short write-up"],
      kind: "design", activities: ["feature"], size: "S" },
    { id: "TG3", title: "The search in nexus status", goal: "nexus status --find <text>.", acceptance: ["Works"], area: "engine", activities: ["feature", "da:onboarding"], size: "S" },
  ],
});
approveQueue(st, "TG");
st.writeQueue({
  protocol: 1, id: "DOC", title: "Tag guide", revision: 1, status: "proposed", stop_conditions: [], checks: [], kind: "docs", origin: "orchestrator", area: "core",
  steps: [{ id: "DOC1", title: "Write the guide", goal: "How to tag a step.", acceptance: ["Written"], size: "S" }],
});
approveQueue(st, "DOC");

emit(90, { type: "step.started", queue: "TG", step: "TG1" });
emit(58, { type: "check.result", queue: "TG", step: "TG1", name: "npm test", ok: true, summary: "214 passed" });
emit(55, { type: "step.done", queue: "TG", step: "TG1", summary: "The step list has a search box; typing filters by title and goal.", activities: ["feature", "ui", "refactor"] });
console.log(`seeded ${root}`);
