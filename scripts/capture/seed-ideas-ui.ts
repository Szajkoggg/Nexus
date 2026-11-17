// IC4's synthetic correction and stale-assessment scenes. Never loads a registered real project.
import "./seed-ideas-corrections.ts";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ProjectStore, loadProjectState, newId, revisionHash, type QueueFile, type Event } from "@nexus/protocol";
import { ideaLinks, ideaStatuses } from "../../packages/protocol/src/ideas-read.ts";
import { changeIdeaStatus, reconcileIdeaStatuses } from "../../packages/protocol/src/idea-status-actions.ts";

const root = join(process.argv[2]!, "demo"), store = new ProjectStore(join(root, ".nexus"));
const ref = (name: string) => `docs/ideas/${name}.md#2026-11-15`;
for (const [name, title, content] of [
  ["user-notes-2026-11-15", "User notes, 15 November", "Several topics collected here; split into their own notes."],
  ["queue-templates", "Queue templates", "A recurring maintenance template that keeps notes current."],
  ["software-dev-features", "Software development features", "Reusable maintenance tools."],
]) writeFileSync(join(root, `docs/ideas/${name}.md`), `# ${title}\n\n**Summary:** ${content}\n**Area:** protocol\n\n## Decided\n\n### 2026-11-15\n\n- ${content}\n\n## Open\n\n- Which templates should be offered?\n`);
for (const name of ["queue-templates", "software-dev-features"]) {
  const file = join(root, `docs/ideas/${name}.md`);
  writeFileSync(file, readFileSync(file, "utf8").replace("## Decided\n", "## Decided\n\n### 2026-11-14\n\n- Maintenance templates.\n"));
}
const base = store.readQueue("ST2");
store.writeQueue({ ...base, source: undefined, description: "Context: docs/ideas/tags.md#2026-11-14" });
const mt: QueueFile = { ...base, id: "MT", title: "Notes maintenance", status: "approved", approvals: [], source: undefined,
  description: `Context: ${ref("user-notes-2026-11-15")}`, steps: [{ id: "MT1", title: "Templates", goal: "Synthetic fixture", acceptance: ["Done"] }] };
store.writeQueue({ ...mt, approvals: [{ revision: 1, at: "2026-11-16T08:00:00.000Z", hash: revisionHash(mt) }] });
const worker = newId(), reviewer = store.sessionIds().find((id) => store.readSession(id).role === "orchestrator")!;
store.writeSession({ protocol: 1, id: worker, project: "demo", role: "worker", runtime: "claude", title: "MT fixture", cwd: root, launched_by: "nexus", created_at: "2026-11-16T08:00:00.000Z", queue: "MT" });
for (const [type, session, at, more] of [
  ["step.started", worker, "2026-11-16T08:01:00.000Z", {}],
  ["step.done", worker, "2026-11-16T08:02:00.000Z", { summary: "Added the notes-maintenance template.", commit: "1234567" }],
  ["review.accepted", reviewer, "2026-11-16T08:03:00.000Z", {}],
] as const) store.appendEvent({ v: 1, id: newId(), type, session, at, queue: "MT", step: "MT1", ...more } as Event);
store.writeQueue({ ...base, id: "FB", title: "Tags and fallback runtimes", status: "proposed", approvals: [], source: ["docs/ideas/tags.md#2026-11-14"],
  steps: [{ id: "FB1", title: "Feedback", goal: "Synthetic fixture", acceptance: ["Done"] }] });
const matches = store.readIdeaMatches();
store.writeQueue({ ...base, id: "OLD", title: "Earlier work", status: "proposed", approvals: [], source: undefined,
  steps: [{ id: "OLD1", title: "Earlier work", goal: "Synthetic fixture", acceptance: ["Done"] }] });
store.writeIdeaMatches({ ...matches, records: [{ id: "fixture-old", queue: "OLD", ref: "docs/ideas/removed-note.md#2026-11-12", origin: "manual", state: "linked", title: "Earlier work", quote: "Historical manual link" }], matches: [...matches.matches, ...[
  { queue: "MT", ref: ref("user-notes-2026-11-15") },
  { queue: "MT", ref: "docs/ideas/queue-templates.md#2026-11-14" },
  { queue: "MT", ref: "docs/ideas/software-dev-features.md#2026-11-14" },
  { queue: "IO", ref: "docs/ideas/tags.md#2026-11-14" },
  { queue: "ST2", ref: "docs/ideas/tags.md#2026-11-14" },
].map((m) => ({ ...m, kind: "exact" as const, quote: `Synthetic historical mention: ${m.ref}`, accepted: true, at: "2026-11-16T08:03:00.000Z" }))] });
// Like IC1's status mockup: CH2 is finished; an explicit older full assessment needs review.
const revision = ideaStatuses(store, loadProjectState(store)).revision;
changeIdeaStatus(store, { operation: "confirm", request_id: "fixture-confirm", revision, ref: "docs/ideas/chat-improvements.md#2026-11-14", reason: "Reviewed the entire date against CH2." });
const file = join(root, "docs/ideas/chat-improvements.md");
writeFileSync(file, readFileSync(file, "utf8").replace("- Detail 1.", "- Detail 1: the decision now also requires keyboard access."));
reconcileIdeaStatuses(store, loadProjectState(store));
console.log(`IC4 fixture: ${ideaLinks(store, loadProjectState(store)).items.length} origins; stale confirmation`);
