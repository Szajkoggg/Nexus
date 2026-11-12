import { test } from "node:test";
import assert from "node:assert/strict";
import { DRAFT_MAX_AGE_MS, draftKey, parseDrafts, pruneDrafts, withDraft, type Drafts } from "../src/drafts.ts";

test("each target has its own key, and parts cannot run into each other", () => {
  assert.equal(draftKey("p", "note", "Q", "Q1"), "p/note/Q/Q1");
  assert.notEqual(draftKey("p", "note", "Q", "Q1"), draftKey("p", "note", "Q", "Q2"));
  assert.notEqual(draftKey("p", "note", "Q", "Q1"), draftKey("q", "note", "Q", "Q1"));
  assert.notEqual(draftKey("p", "note", "Q", "Q1"), draftKey("p", "message", "Q", "Q1"));
  // A slash inside an id does not make it look like two parts.
  assert.notEqual(draftKey("a/b", "orchestrator"), draftKey("a", "b", "orchestrator"));
});

test("setting a draft keeps the others; empty text removes it; the argument is not changed", () => {
  const start: Drafts = { a: { text: "one", at: 1 } };
  const set = withDraft(start, "b", "two", 5);
  assert.deepEqual(set, { a: { text: "one", at: 1 }, b: { text: "two", at: 5 } });
  assert.deepEqual(start, { a: { text: "one", at: 1 } });
  assert.deepEqual(withDraft(set, "a", "", 6), { b: { text: "two", at: 5 } });
});

test("drafts untouched for more than 14 days are pruned", () => {
  const now = 100 * DRAFT_MAX_AGE_MS;
  const drafts: Drafts = {
    fresh: { text: "x", at: now - 1000 },
    edge: { text: "y", at: now - DRAFT_MAX_AGE_MS },
    old: { text: "z", at: now - DRAFT_MAX_AGE_MS - 1 },
  };
  assert.deepEqual(Object.keys(pruneDrafts(drafts, now)).sort(), ["edge", "fresh"]);
  assert.equal(DRAFT_MAX_AGE_MS, 14 * 24 * 60 * 60 * 1000);
});

test("stored data that is malformed is ignored instead of breaking the page", () => {
  assert.deepEqual(parseDrafts(null), {});
  assert.deepEqual(parseDrafts("not json"), {});
  assert.deepEqual(parseDrafts("[1,2]"), {});
  assert.deepEqual(parseDrafts(JSON.stringify({ ok: { text: "t", at: 3 }, bad: { text: 4 }, empty: { text: "", at: 1 }, nul: null })),
    { ok: { text: "t", at: 3 } });
});
