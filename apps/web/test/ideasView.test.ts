import { test } from "node:test";
import assert from "node:assert/strict";
import type { IdeaEntryView, IdeaNoteView } from "@nexus/protocol/ideas";
import { filterCounts, groupByArea, shownNotes } from "../src/ideasView.ts";

const entry = (date: string, status: IdeaEntryView["status"], lead = `Lead ${date}`): IdeaEntryView =>
  ({ date, headings: [date], lead, decisions: 1, content: `### ${date}\n- ${lead}\n`, ref: `n.md#${date}`, status,
    queues: status === "queued" ? [{ id: "Q", title: "Work", status: "proposed" }] : [],
    history: status === "handed_over" ? [{ kind: "handed_over", at: date, conversation: "chat" }] : [] });
const note = (title: string, entries: IdeaEntryView[], extra: Partial<IdeaNoteView> = {}): IdeaNoteView =>
  ({ file: `docs/ideas/${title.toLowerCase()}.md`, title, entries, open: 0, questions: [], ideas: 0, status: "decided", queues: [], ...extra });

const notes = [
  note("Plan", [entry("2026-11-14", "built"), entry("2026-11-15", "queued", "Lines never run through boxes")], { area: "dashboard", group: "queues" }),
  note("Chat", [entry("2026-11-14", "handed_over"), entry("2026-11-16", "replaced")], { area: "dashboard" }),
  note("Tags", [entry("2026-11-14", "decided")], { area: "protocol", summary: "Facets of a step" }),
  note("Games", [], { summary: "Nothing decided yet" }),
  note("Deploys", [entry("2026-11-13", "dropped")], { area: "lifecycle" }),
];

test("the filters' counts: entries by status (replaced with dropped), topics with no entry", () => {
  assert.deepEqual(filterCounts(notes), { all: 7, queues_done: 0, worked_out: 1, unconfirmed: 4, partial: 0, full: 0, attention: 0, decided: 1, handed_over: 1, queued: 1, built: 1, dropped: 2 });
});

test("a status filter keeps the entries with that status and their notes; worked_out the empty topics", () => {
  assert.deepEqual(shownNotes(notes, "queued").map((n) => [n.note.title, n.entries.map((e) => e.date)]), [["Plan", ["2026-11-15"]]]);
  assert.deepEqual(shownNotes(notes, "dropped").map((n) => n.note.title), ["Chat", "Deploys"]);
  assert.deepEqual(shownNotes(notes, "worked_out").map((n) => n.note.title), ["Games"]);
  assert.equal(shownNotes(notes, "all").length, 5);
});

test("the text filter matches a note (all its entries stay) or an entry's lead (only it stays)", () => {
  assert.deepEqual(shownNotes(notes, "all", "FACETS").map((n) => n.note.title), ["Tags"]);
  assert.deepEqual(shownNotes(notes, "all", "boxes").map((n) => [n.note.title, n.entries.length]), [["Plan", 1]]);
  assert.deepEqual(shownNotes(notes, "all", "plan").map((n) => [n.note.title, n.entries.length]), [["Plan", 2]]);
  assert.deepEqual(shownNotes(notes, "worked_out", "nothing").map((n) => n.note.title), ["Games"]);
});

test("grouped by area in the project's order, the others by name, Unsorted last; sub-groups after the area's own notes", () => {
  const g = groupByArea(shownNotes(notes, "all"), ["protocol", "dashboard"]);
  assert.deepEqual(g.map((a) => [a.area, a.count]), [["protocol", 1], ["dashboard", 2], ["lifecycle", 1], [null, 1]]);
  assert.deepEqual(g[1]!.groups.map((x) => [x.group, x.notes.map((n) => n.note.title)]), [[null, ["Chat"]], ["queues", ["Plan"]]]);
});

test("effective user decisions drive all filters; legacy built cannot imply full and stale assessments need attention", () => {
  const effective = (date: string, patch: Partial<NonNullable<IdeaEntryView["effective"]>>): IdeaEntryView => ({
    ...entry(date, "built"), effective: { ref: `n.md#${date}`, disposition: "active", implementation: "unconfirmed",
      marker: {}, marker_status: "legacy", stale_reasons: [], diagnostics: [], blockers: [], caveats: [],
      work: { state: "finished", queues: [] }, snapshot: { content: "hash", links: [], evidence: "hash" }, ...patch },
  });
  const examples = [note("Effective", [
    effective("2026-11-10", { implementation_signal: "queues_done_unconfirmed" }), effective("2026-11-11", { implementation: "full" }),
    effective("2026-11-12", { implementation: "partial" }),
    effective("2026-11-13", { implementation: "needs_review", stale_reasons: ["Decision changed"] }),
    effective("2026-11-14", { disposition: "dropped", implementation: "suspended" }),
    effective("2026-11-15", { disposition: "replaced", diagnostics: ["Missing target"] }),
  ])];
  assert.deepEqual(filterCounts(examples), { all: 6, queues_done: 2, worked_out: 0, unconfirmed: 2, partial: 1, full: 1, decided: 0, handed_over: 0, queued: 0, built: 4, dropped: 2, attention: 2 });
  // Queues done, not confirmed (IWS): the server's signal, and a finished entry whose assessment needs review again.
  assert.deepEqual(shownNotes(examples, "queues_done")[0]!.entries.map((e) => e.date), ["2026-11-10", "2026-11-13"]);
  assert.deepEqual(shownNotes(examples, "full")[0]!.entries.map((e) => e.date), ["2026-11-11"]);
  assert.deepEqual(shownNotes(examples, "attention")[0]!.entries.map((e) => e.date), ["2026-11-13", "2026-11-15"]);
});
