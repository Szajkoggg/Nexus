// A seed for the capture tool: the ideas overview (queue IO). A test project "demo" (named Nexus) with a notes folder
// (docs/ideas) of made-up notes after the mockup (docs/ux/mockups/22-ideas-overview.html): areas and a sub-group from
// their Area lines, one note without one (Unsorted), entries that are built, queued (by a running and a proposed
// queue), handed over (a partner's nexus covers), decided and replaced, and open questions. The queues name the
// entries in their source; the done ones have every step done and accepted. Four earlier queues name notes only in
// their description (no source): the suggestions to match (queue IO4), one of them accepted and one rejected. Run by scripts/capture.ts as
// `node <this> <data dir>` with NEXUS_HOME set to the development instance's; it writes only there. No agent runs.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ProjectStore, newId, revisionHash, writeRegistry, type Event, type QueueFile, type SessionFile } from "@nexus/protocol";

const dir = process.argv[2];
if (!dir) throw new Error("usage: node seed-ideas.ts <data dir>");
const root = join(dir, "demo");
const notes = join(root, "docs/ideas");
mkdirSync(notes, { recursive: true });

const st = ProjectStore.init(root, { id: "demo", name: "Nexus", root, orchestrator: { session: null } });
writeRegistry({ protocol: 1, projects: [{ id: "demo", root }] });
st.markReviewLevels("2026-11-10T08:00:00.000Z");
st.updateProject((p) => ({ ...p, conversations: { ...p.conversations, notes_dir: "docs/ideas" } }));
const areas = ["lifecycle", "protocol", "cli", "dashboard", "orchestrator", "conversations", "engine"];
st.writeTags({ protocol: 1, areas: areas.map((name) => ({ name, at: "2026-11-15T08:26:00.000Z" })), activities: [], renames: [], proposals: [], decisions: [] });

// ---------------------------------------------------------------- the notes

type Entry = { date: string; heading?: string; bullets: string[]; extra?: string };
const note = (file: string, title: string, summary: string, area: string | undefined, entries: Entry[], open: string[] = [], ideas = 0) =>
  writeFileSync(join(notes, file), [
    `# ${title}`, "", `**Summary:** ${summary}`, ...(area ? [`**Area:** ${area}`] : []), "",
    ...(entries.length ? ["## Decided", "", ...entries.flatMap((e) => [`### ${e.heading ?? e.date}`, "", ...(e.extra ? [e.extra] : []), ...e.bullets.map((b) => `- ${b}`), ""])] : []),
    ...(ideas ? ["## Ideas (not decided)", "", ...Array.from({ length: ideas }, (_, i) => `- Idea ${i + 1}.`), ""] : []),
    "## Open", "", ...(open.length ? open.map((q) => `- ${q}`) : ["Nothing at the moment."]), "",
  ].join("\n"));
const many = (lead: string, n: number) => [`**${lead}**.`, ...Array.from({ length: n - 1 }, (_, i) => `Detail ${i + 1}.`)];

note("deploy-timing.md", "Deploy timing", "Deploys can be planned after a step, after a queue, or at a time (with an optional deadline).", "lifecycle", [
  { date: "2026-11-13", bullets: many("Planned deploys: after a step, a queue, or at a time", 5) },
  { date: "2026-11-14", bullets: many("A deadline, and what waits for a running step", 3) },
]);
note("deploy-changes-for-orchestrators.md", "Deploy changes for orchestrators", "At a deploy, every project's orchestrator is told the commits' Agents: lines.", "lifecycle", [
  { date: "2026-11-14", bullets: many("Agents: lines in commits, told at a deploy", 4) },
]);
note("parallel-worktrees-and-merge-back.md", "Parallel worktrees and merge-back", "Independent queues run in their own worktrees; a closing integration step merges main in.", "lifecycle", [
  { date: "2026-11-15", bullets: many("Own worktrees; Nexus merges back after the integration step", 6) },
], ["Should a merge-back wait for the user when main moved on?"]);
note("tags.md", "Tags", "Tags are facets: one kind per step, activities, area, size and origin.", "protocol", [
  { date: "2026-11-14", bullets: many("Facets: kind, activities, area, size, origin", 7) },
]);
note("stopped-queue-new-revision.md", "Stopped queue: a new revision", "Only the user lifts a stop: by approving a new revision of the stopped queue, or with Continue.", "protocol", [
  { date: "2026-11-13", bullets: many("A stop is lifted by a new revision or Continue", 3) },
  { date: "2026-11-14", bullets: many("The work of a stopped step is kept or discarded", 2), extra: "**Replaced by:** docs/ideas/orchestrator-status-changes.md#2026-11-14\n" },
]);
note("chat-improvements.md", "Chat improvements", "Tools for the chats: quoting, pictures by pasting or dragging, voice.", "dashboard / chats", [
  { date: "2026-11-14", bullets: many("Quoting a selection; pictures by pasting, dragging, attaching", 5) },
  { date: "2026-11-15", bullets: many("Pictures in the chats by pasting or dragging", 3) },
], ["Should a pasted picture keep its file name?", "How large may a picture be?"]);
note("side-panels-and-waiting-list.md", "Side panels and the waiting list", "The chat panel opened last is on top; a chat keeps its place.", "dashboard / chats", [
  { date: "2026-11-14", bullets: many("Panels stack in the order opened; a chat keeps its place", 4) },
]);
note("queue-plan-view.md", "Queue plan view", "The Queues view shows the planned order as a binding graph of dependencies, ready for parallel queues. The plan's layouts were chosen on mockups (PL); building them runs in PB.", "dashboard / queues and plan", [
  { date: "2026-11-14", bullets: many("The planned order as a graph, ready for parallel queues", 6) },
  { date: "2026-11-15", heading: "2026-11-15: lines must not run through queues", bullets: many("Lines must not run through queues; the layouts from the mockups", 4) },
  { date: "2026-11-15", bullets: ["The layouts: the user's picks.", "Detail.", "Detail."] },
], ["Should a recurring queue show in the graph once, or at each of its runs?"], 2);
note("ideas-overview.md", "An overview of the ideas", "The Ideas panel gets an overview of the notes grouped by area, showing each dated decision's status.", "conversations", [
  { date: "2026-11-15", bullets: many("A view in a hierarchy with statuses; queues name their notes", 6) },
]);
note("chat-context.md", "Chat context", "The Ideas conversations get a Compact action; the orchestrator goes on in a fresh session.", "conversations", [
  { date: "2026-11-15", bullets: many("Compact in the Ideas conversations", 3) },
]);
note("conversation-handoff-scope.md", "Conversation hand-over scope", "A hand-over summarizes only its own conversation's topics and names the dates it covers.", "conversations", [
  { date: "2026-11-14", bullets: many("Only the conversation's own topics are handed over", 2) },
]);
note("game-dev-features.md", "Game dev features", "Game features, Unity first but generic: video as review material, performance measures.", undefined, [
  { date: "2026-11-14", bullets: many("Video as review material; a fixture × seed matrix", 4) },
], ["Which video format?", "How long may a clip be?", "Who records it?"]);
note("test-speed.md", "Test speed", "The slowdown came from runs in which many tests failed by timing out.", undefined, [], [], 2);
writeFileSync(join(notes, "README.md"), "# docs/ideas\n\nThe notes' conventions (not a note).\n");

// ---------------------------------------------------------------- the queues and the hand-overs

const orchestrator: SessionFile = { protocol: 1, id: newId(), project: "demo", role: "orchestrator", runtime: "claude", title: "Orchestrator", cwd: root, launched_by: "nexus", created_at: "2026-11-12T08:00:00.000Z" };
st.writeSession(orchestrator);
const emit = (s: SessionFile, at: string, body: Record<string, unknown>) => st.appendEvent({ v: 1, id: newId(), at, session: s.id, ...body } as Event);
let n = 0;
const hex = () => (0x1a2b3c4 + 0x9e3779 * ++n).toString(16).slice(-7);
const plus = (at: string, min: number) => new Date(Date.parse(at) + min * 60_000).toISOString();

/**
 * A queue that names `source` (none: an earlier queue, with its notes only in `description`): created at `at`,
 * approved, its first `done` steps done and accepted, the next one at work.
 */
function queue(id: string, title: string, source: string[], at: string, steps: number, done: number, approve = true, description?: string) {
  const q: QueueFile = {
    protocol: 1, id, title, revision: 1, status: "proposed", review_level: 2, stop_conditions: [], checks: ["npm test"], approvals: [], withdrawals: [], history: [], changes: [],
    steps: Array.from({ length: steps }, (_, i) => ({ id: `${id}${i + 1}`, title: `Step ${i + 1}`, goal: "g", acceptance: ["Done"] })),
    ...(source.length ? { source: source.map((r) => `docs/ideas/${r}`) } : {}), ...(description ? { description } : {}), created_at: at, updated_at: at,
  };
  // Approved a few minutes after its upload (approveQueue would date it now, after the seeded history).
  st.writeQueue(approve ? { ...q, status: "approved", approvals: [{ revision: 1, at: plus(at, 7), hash: revisionHash(q) }] } : q);
  if (!approve) return;
  const w: SessionFile = { protocol: 1, id: newId(), project: "demo", role: "worker", runtime: "claude", title: `${id} worker`, cwd: root, launched_by: "nexus", created_at: at, queue: id };
  st.writeSession(w);
  let t = plus(at, 20);
  for (let i = 1; i <= Math.min(done + 1, steps); i++) {
    emit(w, t, { type: "step.started", queue: id, step: `${id}${i}` });
    if (i > done) break;
    t = plus(t, 40);
    emit(w, t, { type: "step.done", queue: id, step: `${id}${i}`, summary: "Done.", commit: hex() });
    emit(orchestrator, plus(t, 2), { type: "review.accepted", queue: id, step: `${id}${i}` });
    t = plus(t, 5);
  }
}
queue("PD", "Planned deploys", ["deploy-timing.md#2026-11-13", "deploy-timing.md#2026-11-14"], "2026-11-14T09:00:00.000Z", 3, 3);
queue("N4", "Deploy from the orchestrator chat", ["deploy-changes-for-orchestrators.md#2026-11-14"], "2026-11-14T11:00:00.000Z", 2, 2);
queue("PW", "Parallel work in worktrees", ["parallel-worktrees-and-merge-back.md#2026-11-15"], "2026-11-15T06:00:00.000Z", 3, 3);
queue("ST2", "Statistics: project metrics, nexus stats", ["tags.md#2026-11-14"], "2026-11-14T15:00:00.000Z", 3, 3);
queue("SC", "A stopped step's work is kept or discarded", ["stopped-queue-new-revision.md#2026-11-13"], "2026-11-13T15:00:00.000Z", 2, 2);
queue("CH2", "Chat tools: quoting and pictures", ["chat-improvements.md#2026-11-14"], "2026-11-14T13:00:00.000Z", 2, 2);
queue("CI", "Pictures in the chats by pasting or dragging", ["chat-improvements.md#2026-11-15"], "2026-11-15T16:00:00.000Z", 3, 0, false);
queue("SP", "Side panels stack in the order opened", ["side-panels-and-waiting-list.md#2026-11-14"], "2026-11-14T10:00:00.000Z", 2, 2);
queue("PV", "The planned order in the Queues view", ["queue-plan-view.md#2026-11-14"], "2026-11-14T18:02:00.000Z", 3, 3);
queue("PS", "Never two queues in one checkout", ["queue-plan-view.md#2026-11-14"], "2026-11-14T19:00:00.000Z", 2, 2);
queue("PB", "The plan view, part 1: routes, full titles, line details", ["queue-plan-view.md#2026-11-15"], "2026-11-15T12:58:00.000Z", 5, 2);
queue("IO", "The ideas overview", ["ideas-overview.md#2026-11-15"], "2026-11-15T11:08:00.000Z", 7, 0);
// Earlier queues, from before source: their notes only in their words.
queue("SB", "Side panels: the place in a chat is kept", [], "2026-11-14T16:00:00.000Z", 2, 2, true,
  'Decided by the user on 2026-11-14; notes in docs/ideas/side-panels-and-waiting-list.md (section "2026-11-14 (later): the place in a chat is kept").');
queue("PL", "The plan view's design: layouts and features on mockups, the user's choice", [], "2026-11-15T13:30:00.000Z", 2, 2, true,
  "A felhasználó 2026-11-15-i döntései: docs/ideas/queue-plan-view.md (Decided); a mockupok stílusa: docs/ideas/chat-improvements.md");
queue("TG", "Tags in queue.yaml and on the cards", [], "2026-11-14T16:30:00.000Z", 2, 2, true,
  "Decided: docs/ideas/tags.md#2026-11-14, and the cards show them.");
queue("R1", "Refactoring 1: a behaviour guard, then explicit run state transitions", [], "2026-11-14T17:00:00.000Z", 2, 2, true,
  "The plan is in docs/ideas/game-dev-features.md; this queue does items 1 and 2.");
st.writeIdeaMatches({ protocol: 1, matches: [
  { queue: "TG", ref: "docs/ideas/tags.md#2026-11-14", kind: "exact", quote: "Decided: docs/ideas/tags.md#2026-11-14, and the cards show them.", accepted: true, at: "2026-11-16T08:00:00.000Z" },
  { queue: "R1", ref: "docs/ideas/game-dev-features.md#2026-11-14", kind: "file", quote: "The plan is in docs/ideas/game-dev-features.md; this queue does items 1 and 2.", accepted: false, at: "2026-11-16T08:01:00.000Z" },
] });

const partner = (title: string, at: string, refs: string[]) => {
  const s: SessionFile = { protocol: 1, id: newId(), project: "demo", role: "conversation", runtime: "claude", title, cwd: root, launched_by: "nexus", created_at: plus(at, -60) };
  st.writeSession(s);
  emit(s, at, { type: "ideas.covered", refs: refs.map((r) => `docs/ideas/${r}`) });
};
partner("Plan view layouts", "2026-11-15T12:40:00.000Z", ["queue-plan-view.md#2026-11-15"]);
partner("Ideas overview", "2026-11-15T10:52:00.000Z", ["ideas-overview.md#2026-11-15"]);
partner("Chat context", "2026-11-15T09:30:00.000Z", ["chat-context.md#2026-11-15"]);
console.log(`seeded ${root}`);
