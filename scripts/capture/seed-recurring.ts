// A seed for the capture tool: templates and recurring queues (docs/protocol/planning.md, "Queue templates", "Recurring queues").
// Project "demo" has a template of its own (nexus-templates/), two queues, and three recurring queues the user approved:
// a weekly survey whose last run is done (made up for a time Nexus missed), one after every 5 queues, and one paused. Project "fresh" has one
// the orchestrator just set (waiting for the user's approval) and one that changed since the user approved it. Run by
// scripts/capture.ts as `node <this> <data dir>` with NEXUS_HOME set to the development instance's; it writes only
// there. Recurring queues are new: there is no base commit to seed.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ProjectStore, approveQueue, ensureUserSession, newId, readTemplates, resolveRecurring, revisionHash, writeRegistry,
  type Event, type RecurringFile, type SessionFile,
} from "@nexus/protocol";

const dir = process.argv[2];
if (!dir) throw new Error("usage: node seed-recurring.ts <data dir>");
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
/** The last Monday 03:00 (local) at or before `min` minutes ago: a time of the weekly schedule below. */
const mondayBefore = (min: number) => {
  const d = new Date(Date.now() - min * 60_000);
  const t = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7), 3, 0);
  if (t > d) t.setDate(t.getDate() - 7);
  return t.toISOString();
};

function project(id: string, name: string): { st: ProjectStore; root: string } {
  const root = join(dir!, id);
  mkdirSync(root, { recursive: true });
  return { st: ProjectStore.init(root, { id, name, root }), root };
}
const demo = project("demo", "Demo app");
const fresh = project("fresh", "Fresh app");
writeRegistry({ protocol: 1, projects: [{ id: "demo", root: demo.root }, { id: "fresh", root: fresh.root }] });

// The project's own template, beside Nexus's five.
mkdirSync(join(demo.root, "nexus-templates"), { recursive: true });
writeFileSync(join(demo.root, "nexus-templates", "release-notes.yaml"), `template:
  id: release-notes
  title: Release notes
  description: Write the release notes of a version from its merged queues.
params:
  - name: version
    description: the version the notes are for
title: "Release notes for {{version}}"
steps:
  - id: "{{id}}1"
    title: "Write the notes for {{version}}"
    goal: Collect what changed since the last version and write the notes.
    kind: docs
    size: S
`);

/** A recurring queue as the server writes it; `approved`: its standing approval of what it is now (or of an older form). */
function recurring(st: ProjectStore, root: string, r: Omit<RecurringFile, "protocol" | "created_at" | "updated_at" | "set_by">, approved: "now" | "old" | false): void {
  const resolved = resolveRecurring(r, readTemplates(root));
  if ("problem" in resolved) throw new Error(`${r.id}: ${resolved.problem}`);
  st.writeRecurring({
    protocol: 1, set_by: "orchestrator", created_at: ago(20_000), updated_at: ago(approved === false ? 5 : 3000), handled: ago(1), ...r,
    ...(approved ? { approval: { hash: approved === "now" ? resolved.hash : "sha256:an-older-form", at: ago(3000) } } : {}),
  });
}

// Demo: a done run of the weekly survey, two queues of other work, and the three recurring queues.
const w: SessionFile = { protocol: 1, id: newId(), project: "demo", role: "worker", runtime: "claude", native_id: "00000000-0000-4000-8000-000000000011", title: "Survey worker", cwd: demo.root, launched_by: "nexus", created_at: ago(9000) };
demo.st.writeSession(w);
const user = ensureUserSession(demo.st);
const emit = (session: string, min: number, body: Record<string, unknown>) => demo.st.appendEvent({ v: 1, id: newId(), at: ago(min), session, ...body } as Event);
const run = "deps-20261109-0300";
demo.st.writeQueue({
  protocol: 1, id: run, title: "Maintenance: dependencies", revision: 1, status: "approved", maintenance: "survey", coding: false, origin: "maintenance", stop_conditions: [], checks: [],
  steps: [{ id: `${run}1`, title: "Survey: dependencies", goal: "Survey the project's dependencies.", acceptance: ["The report"], kind: "research", size: "S" }],
});
const q = demo.st.readQueue(run);
demo.st.writeQueue({ ...q, approvals: [{ revision: 1, at: ago(8000), hash: revisionHash(q), standing: { id: "deps", approved_at: ago(9000), hash: "sha256:seed" } }] });
emit(w.id, 7990, { type: "step.started", queue: run, step: `${run}1` });
emit(w.id, 7970, { type: "step.done", queue: run, step: `${run}1`, summary: "Two packages are a patch behind; nothing vulnerable." });
emit(user.id, 7960, { type: "review.accepted", queue: run, step: `${run}1` });
for (const [id, title] of [["SRCH", "Search in the step list"], ["EXP", "Export a queue as Markdown"]] as const) {
  demo.st.writeQueue({ protocol: 1, id, title, revision: 1, status: "proposed", stop_conditions: [], checks: ["npm test"], kind: "code", origin: "user",
    steps: [{ id: `${id}1`, title, goal: title, acceptance: ["Works"], size: "M" }] });
  approveQueue(demo.st, id);
}
recurring(demo.st, demo.root, { id: "deps", template: "maintenance", params: { scope: "dependencies (outdated, vulnerable)" }, every: "mon 03:00", maintenance: "survey",
  last: { queue: run, at: ago(8000), due: mondayBefore(8000), caught_up: mondayBefore(8000) } }, "now");
recurring(demo.st, demo.root, { id: "notes", template: "maintenance", params: { scope: "AGENTS.md, DESIGN.md and PROTOCOL.md (and their topic files) against the code" }, after_queues: 5,
  maintenance: "fix_small", baseline: [] }, "now");
recurring(demo.st, demo.root, { id: "release", template: "release-notes", params: { version: "the next minor" }, every: "monthly 1 09:00", paused: true }, "now");

// Fresh: one just set by the orchestrator, one that changed since the user's approval.
recurring(fresh.st, fresh.root, { id: "weekly-care", template: "maintenance", params: {}, every: "sun 22:00", reason: "The user asked for a weekly look at the dependencies" }, false);
recurring(fresh.st, fresh.root, { id: "flaky", template: "spike", params: { question: "Which tests failed now and then this week, and why?" }, every: "fri 16:00" }, "old");
console.log(`seeded ${demo.root} and ${fresh.root}`);
