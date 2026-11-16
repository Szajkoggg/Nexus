// The ideas overview (ideas.ts): reading made-up notes, deriving every status from made-up queues and hand-overs, and
// the queue's `source` list (note references checked in a draft, pinned by the approval, an import's kept as it was).

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import {
  ActionError, ProjectStore, QueueFile, applyDraft, approveQueue, deriveIdeas, ideaQueues, importedFrom, loadProjectState,
  noteRefs, parseNote, parseNoteRef, projectIdeas, readHandOvers, readNotes, revisionHash, topicStatus, type Event, type IdeaQueue,
  decideIdeaMatches, ideaMatches, newId, suggestMatches, type MatchQueue,
} from "../src/index.ts";

const NOTE = `# Plan view

**Summary:** The Queues view shows the planned order as a graph.
Second line of the summary.
**Area:** Dashboard / queues

## Background

- not a decision

## Decided

### 2026-11-14

- **The planned order as a graph**, ready for parallel queues.
- Another decision.
  - a nested detail, not a decision of its own

### 2026-11-15: lines must not run through queues

- **A line never runs through a box.**

#### Its details

- Still the 15th's.

### 2026-11-15

- **The layouts** from the mockups.

### 2026-11-16

**Dropped:** 2026-11-20: not feasible after all
- **Colours by area**.

### 2026-11-17

**Replaced by:** docs/ideas/other.md#2026-11-18
- **A legend**.

### Not dated

- not an entry

## Ideas (not decided)

- one idea
- another

## Open

- A question?
`;

test("a note: title, Summary, area and group, entries by date (one per day), dropped, replaced, ideas and open", () => {
  const n = parseNote("docs/ideas/plan.md", NOTE);
  assert.equal(n.title, "Plan view");
  assert.equal(n.summary, "The Queues view shows the planned order as a graph. Second line of the summary.");
  assert.equal(n.area, "dashboard");
  assert.equal(n.group, "queues");
  assert.deepEqual(n.entries.map((e) => e.date), ["2026-11-14", "2026-11-15", "2026-11-16", "2026-11-17"]);
  const [d14, d15, d16, d17] = n.entries;
  assert.equal(d14!.lead, "The planned order as a graph");
  assert.equal(d14!.decisions, 2, "top-level bullets only");
  assert.deepEqual(d15!.headings, ["2026-11-15: lines must not run through queues", "2026-11-15"], "two headings of one day are one entry");
  assert.equal(d15!.decisions, 3, "a deeper heading without a date goes on with the entry");
  assert.deepEqual(d16!.dropped, { date: "2026-11-20", why: "not feasible after all" });
  assert.equal(d17!.replaced_by, "docs/ideas/other.md#2026-11-18");
  assert.equal(n.ideas, 2);
  assert.equal(n.open, 1);
  assert.deepEqual(n.questions, ["A question?"]);
});

test("a note's other forms: nested Decided, (decided <date>) headings, CRLF, no Summary, nothing open", () => {
  const n = parseNote("notes/x.md", [
    "# Two faults", "", "## The first fault", "", "### Decided", "", "#### 2026-11-13", "", "- **One.**", "",
    "## A plan", "", "### How it reaches the agents (decided 2026-11-14)", "", "- **Two.**", "", "### 1. Not dated", "", "- no",
    "", "### Open", "", "Nothing at the moment.", "",
  ].join("\r\n"));
  assert.equal(n.summary, undefined);
  assert.equal(n.area, undefined);
  assert.deepEqual(n.entries.map((e) => [e.date, e.lead, e.decisions]), [["2026-11-13", "One", 1], ["2026-11-14", "Two", 1]]);
  assert.equal(n.open, 0);
});

test("note references: taken apart, checked, the import record told apart", () => {
  assert.deepEqual(parseNoteRef("docs/ideas/tags.md#2026-11-14"), { file: "docs/ideas/tags.md", date: "2026-11-14" });
  for (const bad of ["docs/ideas/tags.md", "docs/ideas/tags.txt#2026-11-14", "/abs/tags.md#2026-11-14", "C:/x/tags.md#2026-11-14", "tags.md#14-11-2026", "a b.md#2026-11-14"]) {
    assert.equal(parseNoteRef(bad), undefined, bad);
  }
  const source = [{ path: "QUEUE.md", imported_at: "2026-11-12T00:00:00Z" }, "docs/ideas/tags.md#2026-11-14"];
  assert.deepEqual(noteRefs(source), ["docs/ideas/tags.md#2026-11-14"]);
  assert.equal(importedFrom(source)?.path, "QUEUE.md");
});

// ---------------------------------------------------------------- statuses

const notes = [
  parseNote("docs/ideas/plan.md", NOTE),
  parseNote("docs/ideas/empty.md", "# Only ideas\n\n**Summary:** Nothing decided yet.\n\n## Ideas\n\n- one\n\n## Open\n\n- a question\n"),
  parseNote("docs/ideas/other.md", "# Other\n\n## Decided\n\n### 2026-11-18\n\n- **A legend, better.**\n"),
];
const queue = (id: string, status: IdeaQueue["status"], refs: string[], extra: Partial<IdeaQueue> = {}): IdeaQueue =>
  ({ id, title: `Queue ${id}`, status, refs, created_at: "2026-11-15T10:00:00Z", ...extra });

test("every status comes about: decided, handed over, queued, built, dropped, replaced; and being worked out", () => {
  const v = deriveIdeas({
    notes,
    queues: [
      queue("A", "done", ["docs/ideas/plan.md#2026-11-14"], { approved_at: "2026-11-15T10:05:00Z", started_at: "2026-11-15T10:10:00Z", finished_at: "2026-11-15T12:00:00Z", commit: "abc1234", areas: ["engine", "engine"] }),
      queue("B", "running", ["docs/ideas/plan.md#2026-11-15"], { areas: ["engine"] }),
      queue("C", "done", ["docs/ideas/plan.md#2026-11-16"], { finished_at: "2026-11-16T09:00:00Z" }),
    ],
    handovers: [{ ref: "docs/ideas/other.md#2026-11-18", at: "2026-11-18T08:00:00Z", conversation: "Legends" }],
  });
  const plan = v.notes[0]!;
  assert.deepEqual(plan.entries.map((e) => e.status), ["built", "queued", "dropped", "replaced"]);
  assert.equal(plan.status, "queued", "the least advanced of its live entries");
  assert.equal(plan.area, "dashboard", "its own Area line wins over its queues'");
  assert.equal(plan.area_from, "note");
  assert.deepEqual(plan.queues.map((q) => q.id), ["A", "B", "C"]);
  assert.equal(plan.entries[0]!.queues[0]!.commit, "abc1234");
  assert.equal(v.notes[1]!.status, "worked_out", "no Decided entry");
  assert.equal(v.notes[1]!.open, 1);
  assert.equal(v.notes[2]!.status, "handed_over");
  assert.equal(v.notes[2]!.entries[0]!.status, "handed_over");
  // Nothing at all: decided.
  assert.equal(deriveIdeas({ notes, queues: [], handovers: [] }).notes[2]!.entries[0]!.status, "decided");
});

test("dropped wins even after its queue was built; a cancelled queue no longer counts", () => {
  const v = deriveIdeas({
    notes,
    queues: [
      queue("C", "done", ["docs/ideas/plan.md#2026-11-16"], { created_at: "2026-11-16T08:00:00Z", finished_at: "2026-11-16T09:00:00Z" }),
      queue("X", "cancelled", ["docs/ideas/plan.md#2026-11-14"]),
    ],
    handovers: [{ ref: "docs/ideas/plan.md#2026-11-14", at: "2026-11-14T18:00:00Z" }],
  });
  const [d14, , d16] = v.notes[0]!.entries;
  assert.equal(d16!.status, "dropped");
  assert.deepEqual(d16!.history.map((h) => h.kind), ["decided", "queued", "finished", "dropped"]);
  assert.equal(d14!.status, "handed_over", "its only queue was cancelled: back to the hand-over");
});

test("built only when every queue that names it is done", () => {
  const ref = "docs/ideas/other.md#2026-11-18";
  const one = deriveIdeas({ notes, queues: [queue("D", "done", [ref]), queue("E", "approved", [ref])], handovers: [] });
  assert.equal(one.notes[2]!.entries[0]!.status, "queued");
  const both = deriveIdeas({ notes, queues: [queue("D", "done", [ref]), queue("E", "done", [ref])], handovers: [] });
  assert.equal(both.notes[2]!.entries[0]!.status, "built");
  const proposed = deriveIdeas({ notes, queues: [queue("F", "proposed", [ref])], handovers: [] });
  assert.equal(proposed.notes[2]!.entries[0]!.status, "queued", "from the upload on");
});

test("a topic's status: the least advanced live entry; only dropped or replaced ones: dropped, then replaced", () => {
  assert.equal(topicStatus([]), "worked_out");
  assert.equal(topicStatus(["built", "decided", "queued"]), "decided");
  assert.equal(topicStatus(["built", "dropped"]), "built");
  assert.equal(topicStatus(["replaced", "dropped"]), "dropped");
  assert.equal(topicStatus(["replaced"]), "replaced");
});

test("the history is in time order: the note's date first, then hand-overs and the queues' lines", () => {
  const ref = "docs/ideas/plan.md#2026-11-14";
  const v = deriveIdeas({
    notes,
    queues: [
      queue("L", "done", [ref], { created_at: "2026-11-15T09:00:00Z", approved_at: "2026-11-15T09:30:00Z", started_at: "2026-11-15T11:00:00Z", finished_at: "2026-11-16T08:00:00Z", commit: "fff0000" }),
      queue("K", "running", [ref], { created_at: "2026-11-14T20:00:00Z", started_at: "2026-11-15T10:00:00Z" }),
    ],
    handovers: [{ ref, at: "2026-11-14T18:00:00Z", session: "S1", conversation: "Plans" }],
  });
  const h = v.notes[0]!.entries[0]!.history;
  assert.deepEqual(h.map((x) => `${x.kind}${x.queue ? ` ${x.queue}` : ""}`), [
    "decided", "handed_over", "queued K", "queued L", "approved L", "started K", "started L", "finished L",
  ]);
  const times = h.map((x) => x.at);
  assert.deepEqual(times, [...times].sort());
  assert.equal(h[1]!.conversation, "Plans");
  assert.equal(h.at(-1)!.commit, "fff0000");
});

test("without an Area line, a note takes the area most of its queues' steps carry; references to nothing are listed", () => {
  const v = deriveIdeas({
    notes: [parseNote("docs/ideas/other.md", "# Other\n\n## Decided\n\n### 2026-11-18\n\n- **A.**\n")],
    queues: [queue("A", "running", ["docs/ideas/other.md#2026-11-18", "docs/ideas/gone.md#2026-11-01"], { areas: ["cli", "engine", "engine"] })],
    handovers: [],
  });
  assert.equal(v.notes[0]!.area, "engine");
  assert.equal(v.notes[0]!.area_from, "queues");
  assert.deepEqual(v.unknown_refs, [{ queue: "A", ref: "docs/ideas/gone.md#2026-11-01" }]);
});

// ---------------------------------------------------------------- the source list in queue.yaml and drafts

function project() {
  const root = mkdtempSync(join(tmpdir(), "nexus-ideas-"));
  const st = ProjectStore.init(root, { id: "p", name: "P", root });
  st.updateProject((p) => ({ ...p, conversations: { ...p.conversations, notes_dir: "docs/ideas" } }));
  mkdirSync(join(root, "docs/ideas/sub"), { recursive: true });
  writeFileSync(join(root, "docs/ideas/plan.md"), NOTE);
  writeFileSync(join(root, "docs/ideas/sub/deep.md"), "# Deep\n\n## Decided\n\n### 2026-11-01\n\n- **Deep.**\n");
  writeFileSync(join(root, "docs/ideas/README.md"), "# Conventions\n\n## Decided\n\n### 2026-11-01\n\n- not a note\n");
  return { root, st };
}
const steps = [{ id: "Q1", title: "One", goal: "", acceptance: [] }];

test("the notes folder is read with its subfolders, the README left out", () => {
  const { root } = project();
  assert.deepEqual(readNotes(root, "docs/ideas").map((n) => n.file), ["docs/ideas/plan.md", "docs/ideas/sub/deep.md"]);
  assert.deepEqual(readNotes(root, undefined), []);
  assert.deepEqual(readNotes(root, "missing"), []);
});

test("a draft's note references are checked against the notes; a wrong one is refused with the reason", () => {
  const { st } = project();
  const draft = (source: unknown[]) => applyDraft(st, { id: "Q", title: "Q", stop_conditions: [], checks: [], steps, source });
  const refused = (source: unknown[], text: RegExp) =>
    assert.throws(() => draft(source), (e: ActionError) => e instanceof ActionError && text.test(e.message), String(source));
  refused(["docs/ideas/plan.md#2026-11-30"], /no Decided entry of 2026-11-30 \(its dates: 2026-11-14, 2026-11-15, 2026-11-16, 2026-11-17\)/);
  refused(["docs/ideas/missing.md#2026-11-14"], /there is no note docs\/ideas\/missing\.md/);
  refused(["other/plan.md#2026-11-14"], /a note is a file in the notes folder docs\/ideas\//);
  refused(["docs/ideas/README.md#2026-11-01"], /there is no note/);
  refused(["docs/ideas/plan.md"], /note reference/);
  draft(["docs/ideas/plan.md#2026-11-14", "docs/ideas/sub/deep.md#2026-11-01"]);
  assert.deepEqual(st.readQueue("Q").source, ["docs/ideas/plan.md#2026-11-14", "docs/ideas/sub/deep.md#2026-11-01"]);

  // A project without a notes folder names no note.
  st.updateProject((p) => ({ ...p, conversations: { ...p.conversations, notes_dir: undefined } }));
  assert.throws(() => applyDraft(st, { id: "R", title: "R", stop_conditions: [], checks: [], steps, source: ["docs/ideas/plan.md#2026-11-14"] }), /no notes folder/);
});

test("note references are pinned by the approval; a revision that changes them needs the user again", () => {
  const { st } = project();
  applyDraft(st, { id: "Q", title: "Q", stop_conditions: [], checks: [], steps, source: ["docs/ideas/plan.md#2026-11-14"] });
  approveQueue(st, "Q");
  const before = st.readQueue("Q");
  // Left out: the source stays, and so does the approval.
  applyDraft(st, { id: "Q", title: "Q", stop_conditions: [], checks: [], steps });
  assert.deepEqual(st.readQueue("Q").source, before.source);
  assert.equal(loadProjectState(st).queues[0]!.approved, true);
  // Another reference: a new revision.
  applyDraft(st, { id: "Q", title: "Q", stop_conditions: [], checks: [], steps, source: ["docs/ideas/plan.md#2026-11-15"] });
  const after = st.readQueue("Q");
  assert.equal(after.revision, before.revision + 1);
  assert.notEqual(revisionHash(after), revisionHash(before));
  assert.equal(loadProjectState(st).queues[0]!.approved, false);
});

test("an imported queue's source reads as a list of one, and its hash is the one it had before the list", () => {
  const { root, st } = project();
  const yaml = {
    protocol: 1, id: "I", title: "Imported", revision: 1, status: "approved", stop_conditions: ["s"], checks: ["c"], steps,
    approvals: [], history: [], source: { path: "QUEUE.md", imported_at: "2026-11-12T00:00:00Z" },
  };
  const parsed = QueueFile.parse(yaml);
  assert.deepEqual(parsed.source, [{ path: "QUEUE.md", imported_at: "2026-11-12T00:00:00Z" }]);
  const old = "sha256:" + createHash("sha256").update(JSON.stringify({ steps, stop_conditions: ["s"], checks: ["c"] })).digest("hex");
  assert.equal(revisionHash(parsed), old);
  // Written in the old form by hand and read through the store: the same.
  mkdirSync(join(root, ".nexus/queues/I"), { recursive: true });
  writeFileSync(join(root, ".nexus/queues/I/queue.yaml"), YAML.stringify(yaml));
  assert.equal(revisionHash(st.readQueue("I")), old);
  // A revision with a note reference keeps the import record before it.
  applyDraft(st, { id: "I", title: "Imported", stop_conditions: ["s"], checks: ["c"], steps, source: ["docs/ideas/plan.md#2026-11-14"] });
  assert.deepEqual(st.readQueue("I").source, [{ path: "QUEUE.md", imported_at: "2026-11-12T00:00:00Z" }, "docs/ideas/plan.md#2026-11-14"]);
});

test("the queues as the derivation reads them: their references, accepted matches, areas, times and last commit", () => {
  const { st } = project();
  st.writeQueue({
    protocol: 1, id: "Q", title: "Q", revision: 1, status: "proposed", stop_conditions: [], checks: [], steps, area: "cli",
    approvals: [], history: [], source: ["docs/ideas/plan.md#2026-11-14"], created_at: "2026-11-15T10:00:00Z",
  });
  approveQueue(st, "Q");
  const [q] = ideaQueues(loadProjectState(st).queues, { Q: ["docs/ideas/sub/deep.md#2026-11-01", "docs/ideas/plan.md#2026-11-14"] });
  assert.deepEqual(q!.refs, ["docs/ideas/plan.md#2026-11-14", "docs/ideas/sub/deep.md#2026-11-01"]);
  assert.deepEqual(q!.areas, ["cli"]);
  assert.equal(q!.status, "approved");
  assert.ok(q!.created_at && q!.approved_at && !q!.finished_at);
});

test("a hand-over record counts only from a thinking partner's own events; another session's is ignored with a warning", () => {
  const { st, root } = project();
  const session = (id: string, role: "conversation" | "worker") =>
    st.writeSession({ protocol: 1, id, project: "p", role, runtime: "claude", cwd: root, launched_by: "nexus", created_at: "2026-11-15T09:00:00Z", title: `Talk ${id}` });
  session("c", "conversation");
  session("w", "worker");
  const covered = (s: string, at: string) => st.appendEvent({ v: 1, id: `${s}-${at}`, at, session: s, type: "ideas.covered", refs: ["docs/ideas/plan.md#2026-11-14"] } as Event);
  covered("w", "2026-11-15T10:00:00Z");
  covered("c", "2026-11-15T11:00:00Z");
  assert.deepEqual(readHandOvers(st), [{ ref: "docs/ideas/plan.md#2026-11-14", at: "2026-11-15T11:00:00Z", session: "c", conversation: "Talk c" }]);
  assert.ok(loadProjectState(st).warnings.some((w) => /ideas\.covered is for thinking partners; ignored/.test(w)));
  const plan = projectIdeas(st, loadProjectState(st)).notes.find((n) => n.file === "docs/ideas/plan.md")!;
  assert.equal(plan.entries[0]!.status, "handed_over");
});

// ---------------------------------------------------------------- matching earlier queues to the notes

const mq = (id: string, description: string, extra: Partial<MatchQueue> = {}): MatchQueue =>
  ({ id, title: `Queue ${id}`, description, steps: [{ title: "One", goal: "" }], created_at: "2026-11-16T10:00:00Z", status: "done", ...extra });

test("suggestions come from the queues' own references: exact, a date in the same sentence, or the file alone", () => {
  const s = suggestMatches([
    mq("A", "Decided: docs/ideas/plan.md#2026-11-15 and more."),
    mq("B", "A felhasználó 2026-11-14-i döntése (docs/ideas/plan.md, docs/ideas/README.md). Another sentence, 2026-11-16."),
    mq("C", "The plan is in docs/ideas/plan.md; this queue does items 1 and 2.", { created_at: "2026-11-15T23:00:00Z" }),
    mq("D", "Named in its source already: docs/ideas/plan.md#2026-11-14.", { source: ["docs/ideas/plan.md#2026-11-14"] }),
    mq("E", "Cancelled: docs/ideas/plan.md#2026-11-14.", { status: "cancelled" }),
    mq("F", "Nothing here, docs/ideas/missing.md and docs/ideas."),
  ], notes, "docs/ideas");
  assert.deepEqual(s.map((x) => [x.queue, x.ref, x.kind]), [
    ["A", "docs/ideas/plan.md#2026-11-15", "exact"],
    ["B", "docs/ideas/plan.md#2026-11-14", "dated"],
    ["C", "docs/ideas/plan.md#2026-11-15", "file"],
  ]);
  assert.equal(s[1]!.quote, "A felhasználó 2026-11-14-i döntése (docs/ideas/plan.md, docs/ideas/README.md).", "the sentence it came from");
  assert.deepEqual(suggestMatches([mq("A", "docs/ideas/plan.md#2026-11-15")], notes, undefined), [], "no notes folder, no suggestions");
});

/** A project with the notes and a finished queue that names plan.md in its description, but has no source. */
function finished() {
  const p = project();
  const { st, root } = p;
  st.writeQueue({
    protocol: 1, id: "OLD", title: "Old queue", revision: 1, status: "proposed", stop_conditions: [], checks: [], approvals: [], history: [],
    description: "Decided by the user on 2026-11-14; notes in docs/ideas/plan.md.", steps, created_at: "2026-11-14T20:00:00Z",
  });
  approveQueue(st, "OLD");
  st.writeSession({ protocol: 1, id: "w", project: "p", role: "worker", runtime: "claude", cwd: root, launched_by: "nexus", created_at: "2026-11-14T20:00:00Z", queue: "OLD" });
  st.writeSession({ protocol: 1, id: "o", project: "p", role: "orchestrator", runtime: "claude", cwd: root, launched_by: "nexus", created_at: "2026-11-14T20:00:00Z" });
  const ev = (s: string, at: string, body: Record<string, unknown>) => st.appendEvent({ v: 1, id: newId(), at, session: s, queue: "OLD", step: "Q1", ...body } as Event);
  ev("w", "2026-11-14T21:00:00Z", { type: "step.started" });
  ev("w", "2026-11-14T22:00:00Z", { type: "step.done", summary: "Done.", commit: "abc1234" });
  ev("o", "2026-11-14T22:05:00Z", { type: "review.accepted" });
  const entry = () => projectIdeas(st, loadProjectState(st)).notes.find((n) => n.file === "docs/ideas/plan.md")!.entries[0]!;
  return { ...p, entry };
}

test("an accepted match counts as the queue's source: the entry is built, with the queue's commit; rejected, it is not", () => {
  const { st, entry } = finished();
  const before = projectIdeas(st, loadProjectState(st));
  assert.deepEqual(before.to_match, { suggestions: 1, queues: 1 });
  assert.equal(entry().status, "decided");
  const m = ideaMatches(st, loadProjectState(st)).items;
  assert.deepEqual(m.map((x) => [x.queue, x.ref, x.kind, x.status, x.commit, x.lead, x.decision]), [["OLD", "docs/ideas/plan.md#2026-11-14", "dated", "done", "abc1234", "The planned order as a graph", undefined]]);

  decideIdeaMatches(st, [{ queue: "OLD", ref: "docs/ideas/plan.md#2026-11-14" }], true);
  const built = entry();
  assert.equal(built.status, "built");
  assert.deepEqual(built.queues.map((q) => [q.id, q.commit]), [["OLD", "abc1234"]]);
  assert.equal(built.history.find((h) => h.kind === "finished")?.commit, "abc1234");
  assert.deepEqual(projectIdeas(st, loadProjectState(st)).to_match, { suggestions: 0, queues: 0 });
  assert.equal(st.readQueue("OLD").source, undefined, "the closed queue itself is not changed");
  assert.deepEqual(st.readIdeaMatches().matches.map((x) => [x.queue, x.ref, x.kind, x.accepted]), [["OLD", "docs/ideas/plan.md#2026-11-14", "dated", true]]);

  decideIdeaMatches(st, [{ queue: "OLD", ref: "docs/ideas/plan.md#2026-11-14" }], false);
  assert.equal(entry().status, "decided", "rejected: not built");
  assert.equal(ideaMatches(st, loadProjectState(st)).items[0]!.decision?.accepted, false);

  decideIdeaMatches(st, [{ queue: "OLD", ref: "docs/ideas/plan.md#2026-11-14" }], null);
  assert.deepEqual(st.readIdeaMatches().matches, [], "taken back");
  assert.throws(() => decideIdeaMatches(st, [{ queue: "OLD", ref: "docs/ideas/plan.md#2026-11-15" }], true), (e: ActionError) => e.status === 404);
  assert.throws(() => decideIdeaMatches(st, [], true), /items is a list/);
  assert.throws(() => decideIdeaMatches(st, [{ queue: "OLD", ref: "docs/ideas/plan.md#2026-11-14" }], "yes"), /accept is true, false or null/);
});
