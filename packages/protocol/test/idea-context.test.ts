import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectStore, changeIdeaLinks, changeIdeaStatus, ideaContext, ideaLinks, ideaStatuses, loadProjectState, previewIdeaHandoff, projectIdeas, retryIdeaHandoff, sendIdeaHandoff } from "../src/index.ts";

const TEXT = "# One\n**Summary:** Short summary.\n## Decided\n### 2026-11-14\n- First decision.\n### 2026-11-15\n- Other date.\n## Open\nQuestion prose.\n- Nested question?\n  - Detail.\n## Ideas\nMaybe later.\n```md\n## Decided\nNot a decision.\n```\n";
function fixture(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), "nexus-idea-context-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "notes"));
  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  store.updateProject((p) => ({ ...p, conversations: { ...p.conversations, notes_dir: "notes" } }));
  const note = join(root, "notes/a.md");
  writeFileSync(note, TEXT); writeFileSync(join(root, "notes/b.md"), "# Other topic\n## Ideas\n- Unrelated secret topic.\n");
  const selection = { file: "notes/a.md", dates: ["2026-11-14"], purpose: "plan", instruction: "Review scope only." };
  const preview = () => previewIdeaHandoff(store, selection);
  return { store, note, selection, preview };
}

test("idea context includes complete selected decisions and undecided prose, with exact scope and no unrelated topics", (t) => {
  const f = fixture(t), c = ideaContext(f.store, { file: "notes/a.md", date: "2026-11-14" });
  assert.match(c.text, /First decision/); assert.doesNotMatch(c.text, /Other date|Unrelated secret/);
  assert.match(c.text, /Not decided — Open\nQuestion prose/);
  assert.match(c.text, /Not decided — Ideas\nMaybe later/);
  assert.equal(c.snapshot.decisions.length, 1);
  assert.match(c.text, /does not approve, start, stop or reopen a queue/);
  assert.equal(ideaContext(f.store, { file: "notes/a.md" }).snapshot.decisions.length, 2);
  for (const scope of [{ file: "../notes/a.md" }, { file: "notes/../notes/a.md" }, { file: "notes/a.md", date: "2026-01-01" }, { file: "notes/gone.md" }]) assert.throws(() => ideaContext(f.store, scope), /missing|outside/);
});

test("handoff previews become stale after note changes; dropped dates are context only", (t) => {
  const f = fixture(t), first = f.preview();
  const deliver = () => ({ at: new Date().toISOString(), session: "o", line: 0, inbox: "i" });
  for (const text of [TEXT.replace("First decision", "Changed decision"), TEXT.replace("Short summary", "Changed summary"), TEXT.replace("Question prose", "Changed open"), TEXT.replace("Maybe later", "Changed idea")]) {
    writeFileSync(f.note, text);
    assert.throws(() => sendIdeaHandoff(f.store, { request_id: "stale", revision: first.revision, selection: f.selection }, deliver), /Refresh/);
  }
  writeFileSync(f.note, TEXT);
  const statuses = ideaStatuses(f.store, loadProjectState(f.store));
  changeIdeaStatus(f.store, { request_id: "drop", revision: statuses.revision, operation: "drop", ref: "notes/a.md#2026-11-14", reason: "No longer needed" });
  assert.throws(f.preview, /context only/);
  const context = previewIdeaHandoff(f.store, { ...f.selection, purpose: "context" });
  assert.match(context.payload, /"disposition": "dropped"/);
  assert.match(context.payload, /Context only/);
  assert.throws(() => previewIdeaHandoff(f.store, { ...f.selection, dates: [] }), /Planning requires/);
  assert.equal(previewIdeaHandoff(f.store, { ...f.selection, dates: [], purpose: "context" }).snapshot.decisions.length, 0);
});

test("handoff context follows link corrections, full confirmation and replacement without changing the note", (t) => {
  const f = fixture(t), ref = "notes/a.md#2026-11-14";
  f.store.writeQueue({ protocol: 1, id: "Q", title: "Fixture work", revision: 1, status: "done", source: [ref],
    steps: [{ id: "Q1", title: "Work", goal: "Outcome", acceptance: [], status: "done" }],
    approvals: [], history: [], checks: [], stop_conditions: [] });
  const linked = f.preview(), links = ideaLinks(f.store, loadProjectState(f.store));
  changeIdeaLinks(f.store, { request_id: "correct", revision: links.revision, operation: "ignore-source", origin: links.items[0]!.id, reason: "Wrong fixture relationship" });
  assert.notEqual(f.preview().revision, linked.revision);
  const act = (operation: string, extra: object = {}) => changeIdeaStatus(f.store, { request_id: operation, revision: ideaStatuses(f.store, loadProjectState(f.store)).revision,
    ref, operation, reason: "Reviewed by fixture user", ...extra });
  act("confirm", { evidence_refs: ["https://example.test/result"] });
  assert.throws(f.preview, /context only/);
  assert.equal(previewIdeaHandoff(f.store, { ...f.selection, purpose: "context" }).snapshot.decisions[0]!.effective!.implementation, "full");
  act("replace", { target: "notes/a.md#2026-11-15" });
  assert.throws(f.preview, /context only/);
  const context = previewIdeaHandoff(f.store, { ...f.selection, purpose: "context" });
  assert.equal(context.snapshot.decisions[0]!.effective!.replacement, "notes/a.md#2026-11-15");
  assert.equal(readFileSync(f.note, "utf8"), TEXT);
});

test("failed, retried and restarted handoffs keep one immutable snapshot and report success only after durable delivery", (t) => {
  const f = fixture(t), preview = f.preview();
  const request = { request_id: "handoff", revision: preview.revision, selection: f.selection };
  let calls = 0;
  const fail = () => { calls++; throw new Error("Inbox unavailable"); };
  const failed = sendIdeaHandoff(f.store, request, fail);
  assert.equal(failed.state, "failed"); assert.equal(failed.delivery, undefined);
  assert.equal(projectIdeas(f.store, loadProjectState(f.store)).notes[0]!.entries[0]!.status, "decided");
  writeFileSync(f.note, TEXT.replace("First decision", "New content since failed delivery"));
  const restarted = new ProjectStore(f.store.dir);
  const delivered = retryIdeaHandoff(restarted, "handoff", (id, payload) => {
    calls++; assert.equal(id, "handoff"); assert.equal(payload, preview.payload);
    return { at: new Date().toISOString(), session: "orchestrator", line: 3, inbox: `idea-${id}` };
  });
  assert.equal(delivered.state, "delivered"); assert.equal(delivered.attempts.length, 2);
  assert.deepEqual(sendIdeaHandoff(restarted, request, fail), delivered);
  assert.equal(calls, 2);
  assert.equal(restarted.readIdeaHandoffs().records.length, 1);
  assert.throws(() => sendIdeaHandoff(restarted, { ...request, revision: "other" }, fail), /already names/);
  assert.equal(projectIdeas(restarted, loadProjectState(restarted)).notes[0]!.entries[0]!.status, "handed_over");
  assert.deepEqual(restarted.queueIds(), []);
  assert.equal(readFileSync(f.note, "utf8"), TEXT.replace("First decision", "New content since failed delivery"));
});
