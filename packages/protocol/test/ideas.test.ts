// The ideas overview (ideas.ts): reading made-up notes, deriving every status from made-up queues and hand-overs, and
// the queue's `source` list (note references checked in a draft, pinned by the approval, an import's kept as it was).

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { ideaOutcome as ideaOutcomeForTest } from "../src/idea-outcomes.ts";
import {
  ActionError, ProjectStore, QueueFile, applyDraft, approveQueue, deriveIdeas, ideaQueues, importedFrom, loadProjectState,
  noteRefs, parseNote, parseNoteRef, projectIdeas, readHandOvers, readNotes, revisionHash, topicStatus, type Event, type IdeaQueue,
  decideIdeaMatches as saveIdeaMatches, ideaMatches, ideaLinks, changeIdeaLinks, ideaOriginId, newId, reportSourceHash, suggestMatches, type MatchQueue,
} from "../src/index.ts";

const decideIdeaMatches = (st: ProjectStore, items: unknown, accept: unknown) => saveIdeaMatches(st, items, accept,
  { revision: ideaLinks(st, loadProjectState(st)).revision, request_id: newId() });

const linksOf = (st: ProjectStore) => ideaLinks(st, loadProjectState(st));
const correct = (st: ProjectStore, body: object) => changeIdeaLinks(st, {
  revision: linksOf(st).revision, request_id: newId(), reason: "Correct the fixture relationship", ...body,
});

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
  assert.deepEqual(ideaMatches(st, loadProjectState(st)).items.map((x) => [x.queue, x.ref, x.kind, x.decision?.accepted]), [["OLD", "docs/ideas/plan.md#2026-11-14", "dated", true]]);

  decideIdeaMatches(st, [{ queue: "OLD", ref: "docs/ideas/plan.md#2026-11-14" }], false);
  assert.equal(entry().status, "decided", "rejected: not built");
  assert.equal(ideaMatches(st, loadProjectState(st)).items[0]!.decision?.accepted, false);

  decideIdeaMatches(st, [{ queue: "OLD", ref: "docs/ideas/plan.md#2026-11-14" }], null);
  assert.deepEqual(st.readIdeaMatches().matches, [], "taken back");
  assert.equal(st.readIdeaMatches().history?.length, 3, "all three decisions survive taking it back");
  assert.throws(() => decideIdeaMatches(st, [{ queue: "OLD", ref: "docs/ideas/plan.md#2026-11-15" }], true), (e: ActionError) => e.status === 404);
  assert.throws(() => decideIdeaMatches(st, [], true), /items is a list/);
  assert.throws(() => decideIdeaMatches(st, [{ queue: "OLD", ref: "docs/ideas/plan.md#2026-11-14" }], "yes"), /accept is true, false or null/);
});

test("MT/IO/ST2 corrections preserve FB, other MT links, legacy decisions and closed queue approvals", () => {
  const { st, root } = project();
  for (const name of ["umbrella", "queue-templates", "tags", "feedback"]) writeFileSync(join(root, `docs/ideas/${name}.md`), "# " + name + "\n\n## Decided\n\n### 2026-11-15\n\n- A decision.\n");
  const ref = (name: string) => `docs/ideas/${name}.md#2026-11-15`;
  const legacy = [
    { queue: "MT", ref: ref("umbrella") }, { queue: "MT", ref: ref("feedback") },
    { queue: "IO", ref: ref("tags") }, { queue: "ST2", ref: ref("tags") }, { queue: "FB", ref: ref("feedback") },
  ].map((m) => ({ ...m, kind: "exact" as const, quote: `Original evidence for ${m.queue} ${m.ref}`, accepted: true, at: "2026-11-16T00:00:00Z" }));
  legacy.push({ queue: "FB", ref: ref("tags"), kind: "exact", quote: "Rejected context reference", accepted: false, at: "2026-11-16T00:00:00Z" });
  for (const id of ["MT", "IO", "ST2", "FB"]) {
    st.writeQueue({ protocol: 1, id, title: id, revision: 1, status: "done", stop_conditions: [], checks: [], steps: [], approvals: [], history: [] });
    approveQueue(st, id);
  }
  // An actual old-format file, with no migration fields.
  writeFileSync(join(st.dir, "idea-matches.yaml"), YAML.stringify({ protocol: 1, matches: legacy }));
  const definitions = ["MT", "IO", "ST2", "FB"].map((id) => readFileSync(join(st.queueDir(id), "queue.yaml"), "utf8"));
  const replacement = correct(st, { operation: "replace", origin: ideaOriginId("match", "MT", ref("umbrella")), ref: ref("queue-templates") });
  for (const queue of ["IO", "ST2"]) correct(st, { operation: "decide", decisions: [{ origin: ideaOriginId("match", queue, ref("tags")), accept: false }] });
  const reloaded = new ProjectStore(st.dir);
  assert.deepEqual(reloaded.readIdeaMatches().matches, legacy);
  const edges = () => linksOf(reloaded).items.filter((r) => r.effective).map((r) => `${r.queue} ${r.ref}`).sort();
  assert.deepEqual(edges(), [`MT ${ref("queue-templates")}`, `MT ${ref("feedback")}`, `FB ${ref("feedback")}`].sort());
  assert.deepEqual(["MT", "IO", "ST2", "FB"].map((id) => readFileSync(join(st.queueDir(id), "queue.yaml"), "utf8")), definitions);
  correct(reloaded, { operation: "undo", action: replacement.id });
  assert.ok(edges().includes(`MT ${ref("umbrella")}`));
  assert.ok(!edges().includes(`MT ${ref("queue-templates")}`));
  assert.equal(linksOf(st).history.length, 4);
  assert.equal(linksOf(st).history[0]!.changes.length, 2, "replacement and undo are atomic pairs");
  assert.equal(linksOf(st).history[3]!.changes.length, 2);
});

test("source rejection is separate, retries are idempotent, stale writes and changed-origin undo conflict", () => {
  const { st } = finished();
  const ref = "docs/ideas/plan.md#2026-11-14";
  decideIdeaMatches(st, [{ queue: "OLD", ref }], true);
  st.writeQueue({ ...st.readQueue("OLD"), source: [ref] });
  const request = { request_id: newId(), revision: linksOf(st).revision, reason: "Only reject this historical match", operation: "decide", decisions: [{ origin: ideaOriginId("match", "OLD", ref), accept: false }] };
  const first = changeIdeaLinks(st, request);
  assert.deepEqual(changeIdeaLinks(new ProjectStore(st.dir), request), first);
  writeFileSync(join(st.dir, "idea-matches.lock"), "crashed after committing");
  assert.deepEqual(changeIdeaLinks(new ProjectStore(st.dir), request), first, "saved retry is a read even with a crash-left lock");
  rmSync(join(st.dir, "idea-matches.lock"));
  assert.equal(linksOf(st).history.length, 2);
  assert.ok(linksOf(st).items.find((r) => r.origin === "source")!.effective);
  assert.throws(() => changeIdeaLinks(st, { ...request, request_id: newId() }), (e: ActionError) => e.status === 409);
  assert.throws(() => changeIdeaLinks(st, { ...request, reason: "Changed payload" }), /request_id/);
  assert.throws(() => correct(st, { operation: "remove", origin: ideaOriginId("source", "OLD", ref) }), /separate/);
  const source = correct(st, { operation: "correct-source", origin: ideaOriginId("source", "OLD", ref), ref: "docs/ideas/plan.md#2026-11-15" });
  assert.deepEqual(st.readQueue("OLD").source, [ref]);
  assert.equal(linksOf(st).items.find((r) => r.origin === "source")!.state, "ignored");
  assert.deepEqual(projectIdeas(st, loadProjectState(st)).notes[0]!.entries[1]!.queues.map((q) => q.id), ["OLD"]);
  const manual = source.changes[1]!.after.id;
  correct(st, { operation: "remove", origin: manual });
  assert.throws(() => correct(st, { operation: "undo", action: source.id }), /newer action/);
  // Even an identical later decision counts as a touched record and protects undo.
  correct(st, { operation: "decide", decisions: [{ origin: ideaOriginId("match", "OLD", ref), accept: true }] });
  assert.throws(() => correct(st, { operation: "undo", action: first.id }), /newer action/);
});

test("invalid targets, missing dates/notes/queues, safe removal, restoration checks and write lock", () => {
  const { st, root } = finished();
  const ref = "docs/ideas/plan.md#2026-11-14";
  for (const bad of ["docs/ideas/plan.md#2026-12-30", "docs/ideas/nope.md#2026-11-14", "docs/ideas/../plan.md#2026-11-14", "other/plan.md#2026-11-14", "C:/other/plan.md#2026-11-14"]) {
    assert.throws(() => correct(st, { operation: "add", queue: "OLD", ref: bad }));
  }
  assert.throws(() => correct(st, { operation: "add", queue: "MISSING", ref }), /missing/);
  // Directory junctions work without Windows symlink privilege; no escape through the configured notes root.
  const outside = mkdtempSync(join(tmpdir(), "nexus-other-notes-"));
  writeFileSync(join(outside, "escape.md"), NOTE);
  symlinkSync(outside, join(root, "docs/ideas/escape"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => correct(st, { operation: "add", queue: "OLD", ref: "docs/ideas/escape/escape.md#2026-11-14" }), /no note/);
  const add = correct(st, { operation: "add", queue: "OLD", ref });
  assert.throws(() => correct(st, { operation: "add", queue: "OLD", ref }), /Already linked/);
  writeFileSync(join(root, "docs/ideas/plan.md"), "# Plan\n\n## Decided\n\n### 2026-11-15\n\n- New.\n");
  assert.match(linksOf(st).items.find((r) => r.id === add.changes[0]!.after.id)!.diagnostics.join(), /no Decided entry/);
  correct(st, { operation: "replace", origin: add.changes[0]!.after.id, ref: "docs/ideas/plan.md#2026-11-15" });
  rmSync(join(root, "docs/ideas/plan.md"));
  rmSync(st.queueDir("OLD"), { recursive: true });
  const broken = linksOf(new ProjectStore(st.dir)).items.find((r) => r.origin === "manual" && r.effective)!;
  assert.match(broken.diagnostics.join(), /Queue OLD is missing/);
  assert.match(broken.diagnostics.join(), /there is no note/);
  assert.equal(broken.title, "Old queue");
  const removed = correct(st, { operation: "remove", origin: broken.id });
  assert.throws(() => correct(st, { operation: "undo", action: removed.id }), /missing/);
  assert.equal(linksOf(st).history.length, 3);
  writeFileSync(join(st.dir, "idea-matches.lock"), "held by another writer");
  assert.throws(() => correct(st, { operation: "undo", action: removed.id }), (e: ActionError) => e.status === 409);
  rmSync(join(st.dir, "idea-matches.lock"));
  assert.equal(linksOf(st).history.length, 3);
});

test("example and context mentions describe syntax only and keep their own evidence sentence", () => {
  const suggestions = suggestMatches([mq("CONTEXT", "Example: docs/ideas/plan.md#2026-11-14. Context only: docs/ideas/other.md#2026-11-18.")], notes, "docs/ideas");
  assert.deepEqual(suggestions.map((s) => [s.kind, s.quote]), [
    ["exact", "Example: docs/ideas/plan.md#2026-11-14."], ["exact", "Context only: docs/ideas/other.md#2026-11-18."],
  ]);
  assert.ok(suggestions.every((s) => s.location === "description"));
  assert.ok(suggestions.every((s) => !("confidence" in s)), "exact is reference syntax, never implementation certainty");
});

for (const field of ["description", "goal"] as const) test(`pending ${field} evidence refreshes after an unrelated snapshot; old requests conflict and decided evidence survives`, () => {
  const { st, root } = finished();
  const ref = "docs/ideas/plan.md#2026-11-14";
  const id = ideaOriginId("match", "OLD", ref);
  const setEvidence = (text: string) => {
    const q = st.readQueue("OLD");
    st.writeQueue({ ...q, description: field === "description" ? text : "Unrelated description.",
      steps: q.steps.map((s) => ({ ...s, goal: field === "goal" ? text : "" })) });
  };
  const item = () => linksOf(new ProjectStore(st.dir)).items.find((r) => r.id === id)!;
  setEvidence(`Original reference: ${ref}.`);
  correct(st, { operation: "add", queue: "OLD", ref: "docs/ideas/plan.md#2026-11-15" });
  const saved = st.readIdeaMatches().records!.find((r) => r.id === id)!;
  const request = { request_id: newId(), revision: linksOf(st).revision, operation: "decide", reason: "Review this reference",
    decisions: [{ origin: id, accept: true }] };
  const changed = `Updated context reference: ${ref}.`;
  setEvidence(changed);
  assert.notEqual(linksOf(st).revision, request.revision);
  assert.equal(item().quote, changed);
  assert.equal(item().current_suggestion!.quote, changed);
  assert.equal(item().evidence_status, "current");
  assert.deepEqual(item().recorded_evidence, saved, "the old observation is explicitly historical");
  assert.equal(ideaMatches(st, loadProjectState(st)).items[0]!.quote, changed);
  assert.throws(() => changeIdeaLinks(st, request), (e: ActionError) => e.status === 409);

  // Removing the reference while note/date/queue still exist must invalidate the latest screen too.
  const beforeRemoval = { ...request, request_id: newId(), revision: linksOf(st).revision };
  setEvidence("The queue no longer mentions a note.");
  assert.notEqual(linksOf(st).revision, beforeRemoval.revision);
  assert.equal(item().current_suggestion, null);
  assert.equal(item().evidence_status, "historical");
  assert.deepEqual(item().recorded_evidence, saved);
  assert.match(item().diagnostics.join(), /no longer present/);
  assert.throws(() => changeIdeaLinks(st, beforeRemoval), (e: ActionError) => e.status === 409);

  setEvidence(changed);
  const accepted = correct(st, { operation: "decide", decisions: [{ origin: id, accept: true }] });
  setEvidence(`Later wording: ${ref}.`);
  const beforeLater = linksOf(st).revision;
  assert.equal(item().quote, changed, "accepted evidence remains the evidence of that decision");
  assert.equal(item().evidence_status, "historical");
  assert.equal(item().current_suggestion!.quote, `Later wording: ${ref}.`);
  assert.equal(item().recorded_evidence!.quote, changed);
  setEvidence("No reference remains.");
  assert.notEqual(linksOf(st).revision, beforeLater);
  rmSync(join(root, "docs/ideas/plan.md"));
  assert.equal(item().quote, changed);
  assert.equal(item().recorded_evidence!.note_title, "Plan view");
  assert.match(item().diagnostics.join(), /there is no note/);
  assert.deepEqual(linksOf(st).history.find((a) => a.id === accepted.id), accepted);
});

test("outcomes quote accepted substantive rounds, retain provenance and never use a closing result as the queue", () => {
  const { st } = finished();
  const ref = "docs/ideas/plan.md#2026-11-14";
  decideIdeaMatches(st, [{ queue: "OLD", ref }], true);
  const outcome = () => projectIdeas(st, loadProjectState(st)).notes[0]!.queues[0]!.outcome!;
  assert.equal(outcome().kind, "accepted-steps");
  assert.equal(outcome().text, "Done.");
  assert.equal(outcome().accepted[0]!.round, 1);
  assert.equal(outcome().excerpts[0]!.commit, "abc1234");
  assert.ok(outcome().excerpts[0]!.event);
  assert.equal(outcome().report.available, false);
  writeFileSync(join(st.queueDir("OLD"), "report.md"), "# Report\n\nThe feature is available.\n");
  st.appendEvent({ v: 1, id: newId(), at: "2026-11-14T23:00:00Z", session: "o", queue: "OLD", type: "queue.report", path: join(st.queueDir("OLD"), "report.md"), summary: "The feature is available. It handles errors. Further details." } as Event);
  assert.equal(outcome().kind, "queue-report");
  assert.equal(outcome().text, "The feature is available. It handles errors.");
  assert.ok(outcome().report.event);
  assert.equal(outcome().report.source_status, "unverifiable", "legacy events do not prove freshness");
  assert.match(outcome().warnings.join(), /no source fingerprint/);
  const hash = outcome().report.hash;
  const excerpt = outcome().excerpts[0];
  writeFileSync(join(st.queueDir("OLD"), "report.md"), "# Updated report\n");
  assert.notEqual(outcome().report.hash, hash);
  assert.equal(outcome().report.source_status, "unverifiable");
  assert.deepEqual(outcome().excerpts[0], excerpt, "file edits never reattribute an old event quotation to new bytes");
  st.appendEvent({ v: 1, id: newId(), at: "2026-11-14T23:10:00Z", session: "o", queue: "OLD", type: "queue.report", path: join(st.queueDir("OLD"), "report.md"), summary: "Closing refactoring is complete." } as Event);
  assert.equal(outcome().kind, "accepted-steps");
  assert.equal(outcome().text, "Done.");
  const state = loadProjectState(st);
  // Exercise extraction against the state contract for reopened and provisional current rounds.
  state.queues[0]!.steps[0]!.status = "running";
  assert.equal(ideaOutcomeForTest(st, state.queues[0]!).kind, "unavailable");
  assert.equal(ideaOutcomeForTest(st, state.queues[0]!).historical[0]!.summary, "Done.");
  state.queues[0]!.steps[0]!.status = "done";
  state.queues[0]!.steps[0]!.provisional = { at: "2026-11-14T23:20:00Z", event: "p" };
  assert.equal(ideaOutcomeForTest(st, state.queues[0]!).kind, "unavailable");
  state.queues[0]!.steps[0]!.provisional!.confirmed = "2026-11-14T23:21:00Z";
  assert.equal(ideaOutcomeForTest(st, state.queues[0]!).kind, "accepted-steps");
});

test("report event fingerprints distinguish current, changed and missing sources; a new event refreshes the excerpt", () => {
  const { st } = finished();
  const path = join(st.queueDir("OLD"), "report.md");
  const extract = () => ideaOutcomeForTest(st, loadProjectState(new ProjectStore(st.dir)).queues[0]!);
  const register = (summary: string, at: string) => {
    const id = newId();
    st.appendEvent({ v: 1, id, at, session: "o", queue: "OLD", type: "queue.report", path, summary,
      source_hash: reportSourceHash(readFileSync(path)) } as Event);
    return id;
  };
  writeFileSync(path, "# Report\n\nOriginal outcome.\n");
  const first = register("Original outcome.", "2026-11-14T23:00:00Z");
  const original = extract();
  assert.equal(original.report.source_status, "current");
  assert.equal(original.report.hash, original.report.source_hash);
  writeFileSync(path, "# Report\n\nA different outcome after editing.\n");
  const changed = extract();
  assert.equal(changed.report.source_status, "outdated");
  assert.equal(changed.text, "Original outcome.");
  assert.match(changed.warnings.join(), /changed after queue.report/);
  assert.notEqual(changed.report.hash, changed.report.source_hash);
  assert.equal(changed.report.source_hash, original.report.source_hash);
  assert.equal(changed.report.event, first);
  assert.deepEqual(changed.excerpts, original.excerpts);
  const second = register("A different outcome after editing.", "2026-11-14T23:10:00Z");
  const refreshed = extract();
  assert.equal(refreshed.text, "A different outcome after editing.");
  assert.equal(refreshed.report.source_status, "current");
  assert.equal(refreshed.report.event, second);
  assert.notEqual(refreshed.excerpts[0]!.hash, original.excerpts[0]!.hash);
  assert.ok(!refreshed.warnings.some((w) => /changed after|no source fingerprint/.test(w)));
  rmSync(path);
  assert.equal(extract().report.source_status, "missing");
  assert.equal(extract().kind, "accepted-steps");
  assert.equal(extract().report.source_hash, refreshed.report.source_hash);
});

test("outcome fallback samples distinct substantive steps and reports empty, closing-only and stale evidence", () => {
  const { st } = finished();
  const q = loadProjectState(st).queues[0]!;
  const base = q.steps[0]!;
  q.steps = [
    { ...base, id: "A", summary: "Files such as plan.md keep their links. Checks passed." },
    { ...base, id: "B", summary: "History survives reload. Another sentence." },
    { ...base, id: "C", summary: "A third outcome." },
    { ...base, id: "OLD.refactor", summary: "Refactored the helpers.", closing: true },
    { ...base, id: "OLD.integrate", summary: "Integrated the branch.", integration: true },
  ];
  const sample = ideaOutcomeForTest(st, q);
  assert.equal(sample.text, "Files such as plan.md keep their links. History survives reload.");
  assert.deepEqual(sample.excerpts.map((e) => e.step), ["A", "B"]);
  assert.equal(sample.sampled_steps, 2);
  assert.equal(sample.substantive_steps, 3);
  assert.equal(sample.accepted.length, 5, "full accepted evidence includes closing steps separately");
  q.steps = q.steps.slice(3);
  assert.equal(ideaOutcomeForTest(st, q).kind, "unavailable");
  q.steps = [{ ...base, summary: "" }];
  assert.equal(ideaOutcomeForTest(st, q).kind, "unavailable");
  q.steps = [{ ...base, summary: "No complete sentence" }];
  assert.equal(ideaOutcomeForTest(st, q).kind, "unavailable");
  q.steps = [{ ...base, status: "review", summary: "Unaccepted outcome." }];
  writeFileSync(join(st.queueDir("OLD"), "report.md"), "# Report\n");
  q.report = { path: "report.md", at: "2026-11-16T00:00:00Z", summary: "The whole queue is described here." };
  const disagreeing = ideaOutcomeForTest(st, q);
  assert.equal(disagreeing.kind, "queue-report");
  assert.equal(disagreeing.accepted.length, 0);
  assert.match(disagreeing.warnings.join(), /unfinished/);
});

test("read failure never becomes an empty successful list; a notes-root junction cannot leave the project", () => {
  const { st, root } = project();
  writeFileSync(join(st.dir, "idea-matches.yaml"), "protocol: 999\nmatches: []\n");
  assert.throws(() => linksOf(st));
  const outside = mkdtempSync(join(tmpdir(), "nexus-notes-root-"));
  symlinkSync(outside, join(root, "escaped-notes"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => readNotes(root, "escaped-notes"), /outside the project/);
});
