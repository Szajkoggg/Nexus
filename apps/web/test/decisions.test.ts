// The dashboard's review decisions (queue RVD; src/decisions.ts): the cards' states, what holds the user's Accept, the
// answers an Accept names, the order in the viewer, and the drafts' keys and unsaved state.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { DecisionAnswer, DecisionView, DecisionsView } from "@nexus/protocol/review-decisions";
import { acceptHold, answeredCount, decisionCards, draftId, draftStore, insteadText, materialFirst, seenAnswers, unsaved } from "../src/decisions.ts";

const answer = (x: Partial<DecisionAnswer>): DecisionAnswer => ({ event: "e", at: "2026-11-26T10:00:00Z", session: "s", by: "user", version: 1, round: 1, ...x });
const decision = (id: string, x: Partial<DecisionView> = {}): DecisionView => ({
  id, version: 1, round: 1, text: `Question ${id}?`, options: [{ label: "A" }, { label: "B" }], recommended: "B", material: [], for: "user", by: "worker",
  at: "2026-11-26T09:00:00Z", versions: [], answers: [], ...x,
});
const step = (items: DecisionView[]): { decisions: DecisionsView } => ({ decisions: { items } });

test("cards: saved, open, an earlier version, an earlier round, an option asking a change, an orchestrator's proposal", () => {
  const s = step([
    decision("D1", { answers: [answer({ event: "a1", choice: "B" })] }),
    decision("D2", { version: 2, answers: [answer({ event: "a2", choice: "A" })] }),
    decision("D3", { answers: [answer({ event: "a3", round: 1, choice: "A" })] }),
    decision("D4", { options: [{ label: "Keep" }, { label: "Redo", effect: "fix" }], answers: [answer({ event: "a4", choice: "Redo" })] }),
    decision("D5", { answers: [answer({ event: "a5", by: "orchestrator", choice: "B", provisional: true })] }),
    decision("D6", { for: "reviewer", answers: [answer({ event: "a6", by: "helper", choice: "A" })] }),
    decision("D7", { withdrawn: { text: "not a decision", at: "x", by: "orchestrator" } }),
  ]);
  const cards = decisionCards(s, 1);
  assert.deepEqual(cards.map((c) => [c.d.id, c.state, !!c.stale]), [
    ["D1", "saved", false], ["D2", "open", true], ["D3", "saved", false], ["D4", "fix", false], ["D5", "proposal", false], ["D6", "saved", false],
  ], "a withdrawn decision is not shown; a reviewer's answer counts for the user");
  // In round 2 everything is open again; round 1's answer is the history offered as "Same as round 1".
  const round2 = decisionCards(s, 2);
  assert.equal(round2.find((c) => c.d.id === "D3")!.state, "open");
  assert.equal(round2.find((c) => c.d.id === "D3")!.earlier?.event, "a3");
  assert.deepEqual(answeredCount(cards), { answered: 3, total: 6 });
  assert.deepEqual(seenAnswers(s, 1), { D1: "a1", D3: "a3", D4: "a4", D5: "a5", D6: "a6" }, "only the current answers; D2's is to version 1");
});

test("Accept waits for an answer asking a change first, then open decisions, proposals, and unsaved choices", () => {
  const saved = decision("D1", { answers: [answer({ choice: "B" })] });
  const fix = decision("D2", { options: [{ label: "A" }, { label: "Redo", effect: "fix" }], answers: [answer({ choice: "Redo" })] });
  const open = decision("D3");
  const proposal = decision("D4", { answers: [answer({ by: "orchestrator", choice: "A", provisional: true })] });
  assert.deepEqual(acceptHold(decisionCards(step([saved, fix, open]), 1), []), { kind: "fix", ids: ["D2"] });
  assert.deepEqual(acceptHold(decisionCards(step([saved, open, proposal]), 1), []), { kind: "open", ids: ["D3"] });
  assert.deepEqual(acceptHold(decisionCards(step([saved, proposal]), 1), []), { kind: "proposal", ids: ["D4"] });
  assert.deepEqual(acceptHold(decisionCards(step([saved]), 1), ["D1"]), { kind: "unsaved", ids: ["D1"] }, "a changed choice not saved holds it too");
  assert.equal(acceptHold(decisionCards(step([saved]), 1), []), undefined);
  assert.equal(acceptHold([], []), undefined, "no list: nothing holds the user");
});

test("a draft is unsaved only when it is not empty and not the saved answer; its key changes with version, round and holder", () => {
  const cur = answer({ choice: "B", text: "reads better" });
  assert.equal(unsaved(undefined, cur), false);
  assert.equal(unsaved({ words: "  " }, undefined), false, "nothing chosen");
  assert.equal(unsaved({ choice: "B", words: "reads better " }, cur), false, "the saved answer again");
  assert.equal(unsaved({ choice: "A", words: "" }, cur), true);
  assert.equal(unsaved({ choice: "B", words: "" }, answer({ by: "orchestrator", choice: "B" })), true, "the orchestrator's answer is not the user's");
  const s = { id: "WT1", level: 1 as const, review_with: "user" as const, status: "review" as const };
  const d = { id: "D1", version: 1 };
  const base = draftId("demo", "WT", s, d, 1);
  assert.notEqual(draftId("demo", "WT", s, { ...d, version: 2 }, 1), base, "a new version");
  assert.notEqual(draftId("demo", "WT", s, d, 2), base, "a new round");
  assert.notEqual(draftId("other", "WT", s, d, 1), base, "another project");
  assert.notEqual(draftId("demo", "WT", { ...s, level: 3 as const, review_with: "orchestrator" as const }, d, 1), base, "the review changed hands");
  let calls = 0;
  const off = draftStore.subscribe(() => { calls++; });
  draftStore.set(base, { choice: "A", words: "" });
  assert.deepEqual(draftStore.get(base), { choice: "A", words: "" });
  draftStore.set(base, undefined);
  off();
  assert.equal(draftStore.get(base), undefined);
  assert.equal(calls, 2);
});

test("the viewer shows the decisions about its picture first; Instead… names the other option", () => {
  const cards = [decision("D1", { material: ["phone@390"] }), decision("D2"), decision("D3", { material: ["/r/a.png", "list@1440"] })].map((d) => ({ d }));
  assert.deepEqual(materialFirst(cards, { path: "/r/b.png", key: "list@1440" }).map((c) => c.d.id), ["D3", "D1", "D2"]);
  assert.deepEqual(materialFirst(cards, undefined).map((c) => c.d.id), ["D1", "D2", "D3"]);
  assert.equal(insteadText({ id: "D1", choice: "B", options: ["A", "B"] }), "D1: I choose “A” instead of “B” (the orchestrator's choice).");
  assert.match(insteadText({ id: "D2", choice: "B", options: ["A", "B", "C"] }), /^D2: instead of “B” \(the orchestrator's choice\), I choose: $/);
});
