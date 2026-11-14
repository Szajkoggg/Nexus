import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectStore, loadProjectState, newId, recommendedOption, type Event } from "../src/index.ts";

test("a recommendation names one of the options, by its text or its number", () => {
  const o = ["Smooth it now", "Leave it for later"];
  assert.equal(recommendedOption(o, "Leave it for later"), "Leave it for later");
  assert.equal(recommendedOption(o, "1"), "Smooth it now");
  assert.equal(recommendedOption(o, " 2 "), "Leave it for later");
  assert.throws(() => recommendedOption(o, "3"), /not one of the options \(1\. Smooth it now; 2\. Leave it for later\)/);
  assert.throws(() => recommendedOption(o, "smooth it now"), /not one of the options/, "the text exactly");
  assert.throws(() => recommendedOption(undefined, "1"), /has none/);
  assert.throws(() => recommendedOption([], "x"), /has none/);
  // An option that looks like a number is taken as its text first.
  assert.equal(recommendedOption(["2", "1"], "1"), "1");
});

function project() {
  const root = mkdtempSync(join(tmpdir(), "nexus-questions-"));
  const st = ProjectStore.init(root, { id: "p", name: "P", root });
  const at = (s: number) => new Date(Date.UTC(2026, 10, 14, 10, 0, s)).toISOString();
  let t = 0;
  const emit = (session: string, body: Record<string, unknown>) => st.appendEvent({ v: 1, id: newId(), at: at(t++), session, ...body } as Event);
  st.writeSession({ protocol: 1, id: "w", project: "p", role: "worker", runtime: "claude", cwd: root, launched_by: "nexus", created_at: at(0) });
  st.writeSession({ protocol: 1, id: "o", project: "p", role: "orchestrator", runtime: "claude", cwd: root, launched_by: "nexus", created_at: at(0) });
  const q = () => loadProjectState(st);
  return { emit, q };
}

test("the derived question has the asker's recommendation; the waiting item carries it", () => {
  const x = project();
  x.emit("w", { type: "question.asked", qid: "Q1", text: "Smooth it?", options: ["now", "later"], recommended: "now", can_continue: false });
  const s = x.q();
  assert.equal(s.questions[0]!.recommended, "now");
  assert.equal(s.attention.find((a) => a.qid === "Q1")?.recommended, "now");
});

test("an escalation's recommendation replaces the asker's; one that is not an option is dropped with a warning", () => {
  const x = project();
  x.emit("w", { type: "question.asked", qid: "Q1", text: "Smooth it?", options: ["now", "later"], recommended: "now", can_continue: false });
  x.emit("o", { type: "answer.given", qid: "Q1", text: "A look matter: yours. I recommend later.", escalate: true, recommended: "later" });
  let s = x.q();
  assert.equal(s.questions[0]!.state, "escalated");
  assert.equal(s.questions[0]!.recommended, "later");
  assert.equal(s.attention.find((a) => a.qid === "Q1")?.recommended, "later");

  x.emit("w", { type: "question.asked", qid: "Q2", text: "Seed?", options: ["1234", "777"], recommended: "42", can_continue: true });
  x.emit("o", { type: "answer.given", qid: "Q1", text: "Again.", escalate: true, recommended: "never" });
  s = x.q();
  assert.equal(s.questions.find((q) => q.qid === "Q2")!.recommended, undefined);
  assert.equal(s.questions.find((q) => q.qid === "Q1")!.recommended, "later", "a bad one keeps the earlier");
  assert.ok(s.warnings.some((w) => w.includes('"42" is not one of its options')));
  assert.ok(s.warnings.some((w) => w.includes('"never" is not one of question Q1')));
});

test("an escalation without a recommendation keeps the asker's; a question without one has none", () => {
  const x = project();
  x.emit("w", { type: "question.asked", qid: "Q1", text: "Smooth it?", options: ["now", "later"], recommended: "later", can_continue: false });
  x.emit("o", { type: "answer.given", qid: "Q1", text: "Yours.", escalate: true });
  x.emit("w", { type: "question.asked", qid: "Q2", text: "Free text?", can_continue: false });
  const s = x.q();
  assert.equal(s.questions.find((q) => q.qid === "Q1")!.recommended, "later");
  assert.equal(s.questions.find((q) => q.qid === "Q2")!.recommended, undefined);
  assert.equal("recommended" in s.attention.find((a) => a.qid === "Q2")!, false);
});
