// Refs in a chat: the ids of the project's queues and steps become links; nothing else does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { refIndex, splitRefs } from "../src/refs.ts";

const index = refIndex([
  { id: "SF", steps: [{ id: "SF1" }, { id: "SF2" }, { id: "SF3" }] },
  { id: "UX", steps: [{ id: "UX1" }, { id: "UX2" }] },
  { id: "W", steps: [{ id: "W4b" }, { id: "W4c" }] },
  { id: "A", steps: [{ id: "A1" }] },
  { id: "X", steps: [{ id: "S1" }] },
  { id: "Y", steps: [{ id: "S1" }] },
]);
const refs = (text: string) => splitRefs(text, index).filter((x) => typeof x !== "string");

test("the pieces give the text back, and a text without ids is one piece", () => {
  const t = "Elindítottam az SF-et; az UX2 a mockupok, W / W4c Honeycomb, see drafts/SC.yaml.";
  assert.equal(splitRefs(t, index).map((x) => (typeof x === "string" ? x : x.text)).join(""), t);
  assert.deepEqual(splitRefs("Nothing to see here.", index), ["Nothing to see here."]);
  assert.deepEqual(splitRefs("", index), []);
  assert.deepEqual(splitRefs("SF", refIndex([])), ["SF"], "a project without queues");
});

test("queue and step ids of the project, alone or with their queue", () => {
  assert.deepEqual(refs("Started SF; UX2 waits; W4c too."), [
    { queue: "SF", text: "SF" }, { queue: "UX", step: "UX2", text: "UX2" }, { queue: "W", step: "W4c", text: "W4c" },
  ]);
  assert.deepEqual(refs("UX / UX2 and W/W4b"), [{ queue: "UX", step: "UX2", text: "UX / UX2" }, { queue: "W", step: "W4b", text: "W/W4b" }]);
  assert.deepEqual(refs("**SF**-et, az SC-t, (UX)"), [{ queue: "SF", text: "SF" }, { queue: "UX", text: "UX" }], "markdown, hyphenated suffixes, brackets");
  assert.deepEqual(refs("W megállt a W4c-nél"), [{ queue: "W", text: "W" }, { queue: "W", step: "W4c", text: "W4c" }]);
});

test("not every word: other ids, longer words, paths, file names, lower case", () => {
  assert.deepEqual(refs("SC, N8, SFX, XSF, UX2b, ux2, sf, SF_1"), []);
  assert.deepEqual(refs("see .nexus/drafts/SF.yaml and src/UX/x.ts and SF.md"), []);
  assert.deepEqual(refs("Árvíztűrő SFé ÉSF"), [], "letters with accents count as letters");
  assert.deepEqual(refs("The end of SF."), [{ queue: "SF", text: "SF" }], "a full stop ending the sentence is not a file name");
});

test("a one-letter id that is also a word stays text unless written with its step", () => {
  assert.deepEqual(refs("A queue started. I think so."), []);
  assert.deepEqual(refs("A/A1 is done"), [{ queue: "A", step: "A1", text: "A/A1" }]);
  assert.deepEqual(refs("A1 is done"), [{ queue: "A", step: "A1", text: "A1" }], "its step's id alone is a ref");
});

test("a step id two queues share is a ref only with its queue; a queue with another queue's step links only the queue", () => {
  assert.deepEqual(refs("S1 is done"), []);
  assert.deepEqual(refs("X/S1 and Y / S1"), [{ queue: "X", step: "S1", text: "X/S1" }, { queue: "Y", step: "S1", text: "Y / S1" }]);
  assert.deepEqual(refs("SF/UX2"), [{ queue: "SF", text: "SF" }], "after a slash an id is a path's part, not a ref");
});
