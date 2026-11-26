import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ProjectStore, IdeaStatusesFile, changeIdeaStatus, changeIdeaLinks, deriveIdeaLinks, deriveIdeaStatuses,
  ideaLinks, ideaStatuses, loadProjectState, newId, parseNote, projectIdeas, readNotes, reconcileIdeaStatuses,
  type IdeaStatusRecord, type QueueView,
} from "../src/index.ts";

const REF = "notes/a.md#2026-11-14", OTHER = "notes/a.md#2026-11-15";
const TEXT = "# A\n**Summary:** A summary.\n**Area:** protocol\n## Decided\n### 2026-11-14\n- First.\n- Second.\n```md\n## Open\n**Dropped:** 2026-11-14: code, not metadata\n```\n### 2026-11-14 (later)\n- Third.\n### 2026-11-15\n- Other.\n## Open\n- Question?\n## Ideas\n- Maybe.\n";
function fixture(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), "nexus-idea-status-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "notes"));
  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  store.updateProject((p) => ({ ...p, conversations: { ...p.conversations, notes_dir: "notes" } }));
  const note = join(root, "notes/a.md");
  writeFileSync(note, TEXT);
  const view = () => ideaStatuses(store, loadProjectState(store));
  const entry = () => view().entries.find((e) => e.ref === REF)!;
  const act = (body: object) => changeIdeaStatus(store, { request_id: newId(), ref: REF, revision: view().revision, reason: "User reviewed the complete dated entry", ...body });
  const observe = () => reconcileIdeaStatuses(store, loadProjectState(store));
  const queue = (id: string, status: "done" | "proposed" | "cancelled" = "done") => {
    store.writeQueue({ protocol: 1, id, title: id, revision: 1, status, source: [REF],
      steps: [{ id: `${id}1`, title: "Work", goal: "Outcome", acceptance: [], status: status === "done" ? "done" : "pending" }], approvals: [], history: [], checks: [], stop_conditions: [] });
  };
  return { store, note, view, entry, act, observe, queue };
}

test("the fingerprint includes every dated heading, bullet and code; only CRLF, trailing spaces and metadata normalize", () => {
  const content = (s: string) => parseNote("notes/a.md", s).entries[0]!.content;
  const original = content(TEXT);
  assert.match(original, /Third/);
  assert.match(original, /## Open\n\*\*Dropped/);
  assert.equal(content(TEXT.replaceAll("\n", "  \r\n")), original);
  assert.equal(content(TEXT.replace("- First.", "**Dropped:** 2026-11-17: stopped\n- First.")), original);
  for (const [from, to] of [["A summary.", "New summary."], ["protocol", "dashboard"], ["Question?", "Another?"], ["Maybe.", "Later."]]) {
    assert.equal(content(TEXT.replace(from!, to!)), original);
  }
  for (const from of ["First.", "Second.", "Third.", "code, not metadata", "(later)"]) assert.notEqual(content(TEXT.replace(from, "Changed")), original);
  const nestedFence = "# A\n## Decided\n### 2026-11-14\n````md\n```\n**Dropped:** 2026-11-14: literal\n## Open\n````\n";
  assert.match(content(nestedFence), /Dropped.*literal/);
  assert.equal(parseNote("notes/a.md", nestedFence).entries[0]!.dropped, undefined);
});

test("legacy markers, UI precedence, explicit keep/adopt and undo preserve both statements", (t) => {
  const f = fixture(t);
  const marker = "**Dropped:** 2026-11-16: old choice\n";
  writeFileSync(f.note, TEXT.replace("- First.", marker + "- First."));
  assert.equal(f.entry().disposition, "dropped");
  const reopened = f.act({ operation: "reopen" });
  assert.equal(f.entry().disposition, "active");
  assert.equal(f.entry().marker_status, "overridden");
  writeFileSync(f.note, TEXT.replace("- First.", marker.replace("old choice", "later choice") + "- First."));
  assert.equal(f.entry().marker_status, "conflict");
  assert.equal(f.entry().disposition, "active");
  f.act({ operation: "undo", action: reopened.id });
  assert.equal(f.entry().disposition, "dropped", "undo first override uses current legacy fallback");
  f.act({ operation: "reopen" });
  writeFileSync(f.note, TEXT);
  assert.equal(f.entry().marker_status, "conflict");
  f.act({ operation: "keep" });
  assert.equal(f.entry().marker_status, "current");
  writeFileSync(f.note, TEXT.replace("- First.", marker + "- First."));
  f.act({ operation: "adopt-marker" });
  assert.equal(f.entry().disposition, "dropped");
  assert.equal(f.store.readIdeaStatuses().history.length, 5);
});

test("replacement validates targets, self-links and cycles through legacy and UI decisions", (t) => {
  const f = fixture(t);
  for (const target of [REF, "notes/missing.md#2026-11-14", "../elsewhere.md#2026-11-14", "notes/a.md#2099-01-01"]) {
    assert.throws(() => f.act({ operation: "replace", target }), /Replacement/);
  }
  f.act({ operation: "replace", target: OTHER });
  assert.throws(() => f.act({ ref: OTHER, operation: "replace", target: REF }), /cycle/);
  writeFileSync(f.note, TEXT.replace("- Other.", `**Replaced by:** ${REF}\n- Other.`));
  assert.match(f.entry().diagnostics.join(), /cycle/);
  f.act({ operation: "reopen" });
  assert.throws(() => f.act({ operation: "replace", target: OTHER }), /cycle/);
  writeFileSync(f.note, TEXT.replace("- First.", "**Dropped:** 2026-11-17: old\n**Replaced by:** notes/gone.md#2026-11-14\n- First."));
  const legacy = deriveIdeaStatuses(IdeaStatusesFile.parse({ protocol: 1 }), loadProjectState(f.store), readNotes(f.store.readProject().root, "notes"), ideaLinks(f.store, loadProjectState(f.store))).entries[0]!;
  assert.equal(legacy.disposition, "replaced");
  assert.match(legacy.diagnostics.join(), /Conflicting legacy markers.*missing/);
});

test("explicit partial/full/revoke/drop/reopen and compensating undo retain history without changing work or handoffs", (t) => {
  const f = fixture(t);
  f.queue("Q");
  f.store.writeSession({ protocol: 1, id: "chat", project: "p", role: "conversation", runtime: "codex", cwd: f.store.readProject().root, launched_by: "nexus", created_at: "2026-11-14T00:00:00Z" });
  f.store.appendEvent({ v: 1, id: newId(), at: "2026-11-14T00:00:00Z", session: "chat", type: "ideas.covered", refs: [REF] });
  const queue = readFileSync(join(f.store.queueDir("Q"), "queue.yaml"), "utf8");
  assert.equal(f.entry().implementation, "unconfirmed", "legacy built never supplies a confirmation");
  const overview = projectIdeas(f.store, loadProjectState(f.store));
  assert.equal(overview.notes[0]!.entries[0]!.status, "built");
  assert.equal(overview.notes[0]!.implementation, "unconfirmed");
  f.act({ operation: "partial", reason: "First exists; second and third remain" });
  assert.equal(f.entry().implementation, "partial");
  f.act({ operation: "confirm" });
  assert.equal(f.entry().implementation, "full");
  const dropped = f.act({ operation: "drop" });
  assert.equal(f.entry().implementation, "suspended");
  f.act({ operation: "undo", action: dropped.id });
  assert.equal(f.entry().implementation, "full");
  const revoke = f.act({ operation: "revoke" });
  assert.equal(f.entry().implementation, "unconfirmed");
  f.act({ operation: "undo", action: revoke.id });
  assert.equal(f.entry().implementation, "full");
  f.act({ operation: "reopen" });
  assert.equal(f.entry().implementation, "unconfirmed");
  assert.equal(f.entry().disposition, "active");
  assert.equal(readFileSync(join(f.store.queueDir("Q"), "queue.yaml"), "utf8"), queue);
  assert.equal(f.store.readRun("Q"), undefined);
  assert.equal(f.store.readStart("Q"), undefined);
  assert.equal(f.store.readPlan("Q"), undefined);
  assert.equal(projectIdeas(f.store, loadProjectState(f.store)).notes[0]!.entries[0]!.history.filter((h) => h.kind === "handed_over").length, 1);
  assert.equal(new ProjectStore(f.store.dir).readIdeaStatuses().history.length, 7);
});

test("observed content change is permanently stale, even after revert/restart or undo of revocation", (t) => {
  const f = fixture(t);
  assert.throws(() => f.act({ operation: "confirm" }), /evidence reference/);
  f.act({ operation: "confirm", evidence_refs: ["https://example.test/release"] });
  writeFileSync(f.note, TEXT.replace("A summary.", "New summary.").replace("Question?", "Updated?"));
  f.observe();
  assert.equal(f.entry().implementation, "full");
  const revoke = f.act({ operation: "revoke" });
  writeFileSync(f.note, TEXT.replace("Second.", "Changed second."));
  f.observe();
  writeFileSync(f.note, TEXT);
  f.act({ operation: "undo", action: revoke.id });
  assert.equal(f.entry().implementation, "needs_review");
  assert.deepEqual(f.entry().stale_reasons, ["Decided content changed"]);
  assert.equal(ideaStatuses(new ProjectStore(f.store.dir), loadProjectState(f.store)).entries[0]!.implementation, "needs_review");
  f.act({ operation: "partial" });
  assert.equal(f.entry().implementation, "partial", "a new deliberate assessment refreshes the snapshot");
  rmSync(f.note);
  f.observe();
  assert.deepEqual(f.view().missing, [REF]);
  writeFileSync(f.note, TEXT);
  assert.match(f.entry().stale_reasons.join(), /missing/);
});

test("effective edge changes invalidate; duplicate origins, order and reasons do not", (t) => {
  const f = fixture(t);
  f.queue("Q"); f.queue("R");
  f.act({ operation: "confirm" });
  const links = () => ideaLinks(f.store, loadProjectState(f.store));
  const file = f.store.readIdeaMatches();
  const source = links().items.find((i) => i.queue === "Q")!;
  f.store.writeIdeaMatches({ ...file, records: [{ ...source, id: "duplicate", origin: "manual", quote: "Another reason" }] });
  f.observe();
  assert.equal(f.entry().implementation, "full");
  const remove = (origin: string, operation: string) => changeIdeaLinks(f.store, { request_id: newId(), revision: links().revision, reason: "Correction", operation, origin });
  remove(source.id, "ignore-source");
  assert.equal(f.entry().implementation, "full", "manual origin still supports the same edge");
  const removed = remove("duplicate", "remove");
  assert.equal(f.entry().implementation, "needs_review");
  changeIdeaLinks(f.store, { request_id: newId(), revision: links().revision, reason: "Restore", operation: "undo", action: removed.id });
  assert.equal(f.entry().implementation, "needs_review", "undo edge change cannot revive old confirmation");
  assert.match(f.entry().stale_reasons.join(), /Effective linked work changed/);
});

test("work-state table separates multiple queues, cancellation, skipped steps, provisional review and integration", (t) => {
  const f = fixture(t); f.queue("Q"); f.queue("R", "proposed");
  const state = loadProjectState(f.store), notes = readNotes(state.project.root, "notes");
  const view = (q: Partial<QueueView> = {}) => {
    const queues = [{ ...state.queues[0]!, ...q }, state.queues[1]!];
    const s = { ...state, queues };
    return deriveIdeaStatuses(IdeaStatusesFile.parse({ protocol: 1 }), s, notes, deriveIdeaLinks(f.store.readIdeaMatches(), s, notes)).entries[0]!;
  };
  assert.equal(view().work.state, "some_finished");
  assert.match(view().blockers.join(), /R: work is proposed/);
  for (const status of ["running", "stopped", "waiting", "approved", "proposed"] as const) assert.match(view({ status }).blockers.join(), new RegExp(`Q: work is ${status}`));
  assert.match(view({ status: "cancelled" }).caveats.join(), /cancelled/);
  const step = state.queues[0]!.steps[0]!;
  assert.match(view({ status: "waiting", steps: [{ ...step, status: "failed" }] }).blockers.join(), /step is failed/);
  assert.match(view({ steps: [{ ...step, status: "skipped" }] }).caveats.join(), /skipped/);
  assert.match(view({ steps: [{ ...step, status: "done", provisional: { at: "2026-11-14T00:00:00Z", event: "review" } }] }).blockers.join(), /final review/);
  assert.match(view({ integration: true }).blockers.join(), /awaiting merge/);
  assert.match(view({ git: { protocol: 1, steps: {}, merge: { waiting: { since: "2026-11-14T00:00:00Z", reason: "Conflict" } } } }).blockers.join(), /merge needs attention/);
  assert.throws(() => f.act({ operation: "confirm" }), /R: work is proposed/);
  f.store.writeQueue({ ...f.store.readQueue("R"), status: "cancelled" });
  assert.throws(() => f.act({ operation: "confirm" }), /Explain why/);
  f.act({ operation: "confirm", caveat_reason: "Q contains the complete result; R was redundant" });
  assert.equal(f.entry().implementation, "full");
  // The server remembered source identity when the assessment was saved, without accepting a suggestion.
  rmSync(f.store.queueDir("R"), { recursive: true });
  f.observe();
  assert.equal(f.entry().implementation, "needs_review");
  assert.match(f.entry().blockers.join(), /missing/);
  assert.throws(() => f.act({ operation: "confirm", caveat_reason: "No longer relevant" }), /missing/);
});

test("changed accepted results, reopened work, missing reports and merge outcomes invalidate a saved assessment", (t) => {
  const f = fixture(t); f.queue("Q");
  const state = loadProjectState(f.store), notes = readNotes(state.project.root, "notes");
  const links = deriveIdeaLinks(f.store.readIdeaMatches(), state, notes);
  const snapshot = deriveIdeaStatuses(IdeaStatusesFile.parse({ protocol: 1 }), state, notes, links).entries[0]!.snapshot;
  const record: IdeaStatusRecord = { ref: REF, assessment: { id: "a", kind: "full", at: "2026-11-14T00:00:00Z", reason: "Reviewed", evidence_refs: [], snapshot } };
  const file = IdeaStatusesFile.parse({ protocol: 1, records: [record] });
  const q = state.queues[0]!, step = q.steps[0]!;
  for (const changed of [
    { ...q, steps: [{ ...step, summary: "A different accepted result" }] },
    { ...q, status: "running" as const },
    { ...q, steps: [{ ...step, status: "pending" as const }] },
    { ...q, git: { protocol: 1 as const, steps: {}, merged: { at: "2026-11-14T00:00:00Z", into: "main", path: "p", sha: "abc", fast_forward: true } } },
  ]) {
    const current = deriveIdeaStatuses(file, { ...state, queues: [changed] }, notes, links).entries[0]!;
    assert.equal(current.implementation, "needs_review");
    assert.match(current.stale_reasons.join(), /evidence/);
  }
  writeFileSync(join(f.store.queueDir("Q"), "report.md"), "Original result.");
  f.act({ operation: "confirm" });
  rmSync(join(f.store.queueDir("Q"), "report.md"));
  f.observe();
  assert.equal(f.entry().implementation, "needs_review");
});

test("request IDs, revisions and undo reject competing edits without overwriting history", (t) => {
  const f = fixture(t);
  const req = { request_id: "same", revision: f.view().revision, reason: "Drop", operation: "drop", ref: REF };
  const result = changeIdeaStatus(f.store, req);
  assert.deepEqual(changeIdeaStatus(f.store, req), result);
  assert.throws(() => changeIdeaStatus(f.store, { ...req, reason: "Different" }), /already used/);
  assert.throws(() => changeIdeaStatus(f.store, { ...req, request_id: "competing" }), /Changed since/);
  f.act({ operation: "reopen" });
  assert.throws(() => f.act({ operation: "undo", action: result.id }), /newer action/);
  assert.throws(() => f.act({ operation: "drop", reason: " " }), /invalid status/);
  const stale = { request_id: "old-content", revision: f.view().revision, operation: "drop", ref: REF, reason: "Old screen" };
  writeFileSync(f.note, TEXT.replace("Second.", "Changed."));
  assert.throws(() => changeIdeaStatus(f.store, stale), /Changed since/);
  assert.equal(f.store.readIdeaStatuses().history.length, 2);
});

test("note roll-up excludes inactive entries, takes the least assessment and retains attention", (t) => {
  const f = fixture(t);
  const note = () => projectIdeas(f.store, loadProjectState(f.store)).notes[0]!;
  f.act({ operation: "confirm", evidence_refs: ["external:review"] });
  assert.equal(note().implementation, "unconfirmed", "the second date remains unconfirmed");
  f.act({ ref: OTHER, operation: "partial" });
  assert.equal(note().implementation, "partial");
  f.act({ ref: OTHER, operation: "drop" });
  assert.equal(note().implementation, "full");
  writeFileSync(f.note, TEXT.replace("Second.", "New second."));
  f.observe();
  f.act({ operation: "drop" });
  assert.equal(note().implementation, "dropped");
  assert.equal(note().needs_attention, 1, "stale history is visible even when every entry is inactive");
});

test("a legacy drop followed by a file revert cannot reactivate an observed assessment", (t) => {
  const f = fixture(t);
  f.act({ operation: "confirm", evidence_refs: ["external:review"] });
  writeFileSync(f.note, TEXT.replace("- First.", "**Dropped:** 2026-11-17: changed plan\n- First."));
  f.observe();
  assert.equal(f.entry().implementation, "suspended");
  writeFileSync(f.note, TEXT);
  assert.equal(f.entry().implementation, "needs_review");
  assert.deepEqual(f.entry().stale_reasons, ["Legacy disposition changed"]);
});

test("queues done, not confirmed: named for an active entry whose every linked queue is done and that the user has not assessed (IWS)", (t) => {
  const f = fixture(t);
  assert.equal(f.entry().implementation_signal, undefined, "no linked work");
  f.queue("Q"); f.queue("R", "proposed");
  assert.equal(f.entry().work.state, "some_finished");
  assert.equal(f.entry().implementation_signal, undefined, "R is not done");
  f.queue("R");
  assert.equal(f.entry().work.state, "finished");
  assert.equal(f.entry().implementation_signal, "queues_done_unconfirmed");
  assert.equal(f.entry().implementation, "unconfirmed", "the signal never confirms anything");
  f.act({ operation: "partial" });
  assert.equal(f.entry().implementation_signal, undefined, "the user's assessment is the statement");
  f.act({ operation: "confirm" });
  assert.equal(f.entry().implementation, "full");
  assert.equal(f.entry().implementation_signal, undefined);
  f.act({ operation: "drop" });
  assert.equal(f.entry().implementation_signal, undefined, "not for a dropped entry");
});

test("the note's roll-up: unconfirmed without finished work, then queues done, then partial, then full (IWS)", (t) => {
  const f = fixture(t);
  const note = () => projectIdeas(f.store, loadProjectState(f.store)).notes[0]!;
  f.queue("Q");
  assert.equal(note().implementation, "unconfirmed", "the second date has no work");
  f.act({ ref: OTHER, operation: "partial" });
  assert.equal(note().implementation, "queues_done", "the first date: Q done, not confirmed");
  writeFileSync(f.note, TEXT.replace("Other.", "Other, changed."));
  f.observe();
  assert.equal(note().implementation, "unconfirmed", "the second date's assessment needs review and it has no work");
  f.act({ ref: OTHER, operation: "confirm", evidence_refs: ["external:review"] });
  f.act({ operation: "partial" });
  assert.equal(note().implementation, "partial");
});
