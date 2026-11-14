// Refs in a chat: the ids of the project's queues and steps become links; nothing else does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { findFileRefs, refIndex, splitRefs, wholeRef } from "../src/refs.ts";

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

// ---------------------------------------------------------------- files and commits (CH3)

const files = (text: string) => findFileRefs(text).map((f) => f.ref);
const file = (path: string, line: number) => ({ kind: "file", path, line });
const commit = (hash: string) => ({ kind: "commit", hash });

test("a path with a line: POSIX, Windows, relative, a bare file name with a known extension", () => {
  assert.deepEqual(files("see apps/server/src/engine.ts:138 for it"), [file("apps/server/src/engine.ts", 138)]);
  assert.deepEqual(files("C:\\Code\\Nexus\\apps\\web\\src\\App.tsx:42"), [file("C:\\Code\\Nexus\\apps\\web\\src\\App.tsx", 42)]);
  assert.deepEqual(files("C:/Code/Nexus/README.md:3"), [file("C:/Code/Nexus/README.md", 3)]);
  assert.deepEqual(files("/home/u/p/main.py:7 and ./x.ts:1 and ../y.ts:2 and ~/z.sh:3"),
    [file("/home/u/p/main.py", 7), file("./x.ts", 1), file("../y.ts", 2), file("~/z.sh", 3)]);
  assert.deepEqual(files("README.md:5, docs/PROTOCOL.md:800."), [file("README.md", 5), file("docs/PROTOCOL.md", 800)]);
  assert.deepEqual(files("(engine.ts:138:5) and engine.ts:10-20"), [file("engine.ts", 138), file("engine.ts", 10)], "a column or a range: the first line");
  assert.deepEqual(files("az engine.ts:138-ban és a `files.ts:40`-nél"), [file("engine.ts", 138), file("files.ts", 40)], "Hungarian suffixes");
  assert.deepEqual(files("apps/web/src/components/FileView.tsx:12"), [file("apps/web/src/components/FileView.tsx", 12)]);
  assert.deepEqual(files("tmp/review/CH3.1/code@1440.png:1"), [file("tmp/review/CH3.1/code@1440.png", 1)]);
});

test("no file without a line, and none in times, versions, host:port pairs, URLs or longer words", () => {
  for (const text of [
    "apps/server/src/engine.ts", "README.md", "at 12:30 today", "version 1.2:3", "ratio 1.5:1", "example.com:8080",
    "localhost:4317", "127.0.0.1:4318", "https://github.com/x/y/blob/main/src/a.ts:12", "http://127.0.0.1:4321/?file=a.ts:3",
    "see www.example.com/a.ts:4", "e.g.: 5", "Section 3.a:2", "note.md:0", "x.ts:12abc", "foo.ts:12/bar", "a.ts:", "user@host.md:3x",
  ]) assert.deepEqual(files(text), [], text);
});

test("a commit hash: 7 to 40 lowercase hex with a digit and a letter, standing alone", () => {
  assert.deepEqual(files("committed 13118f1 and db6fc71."), [commit("13118f1"), commit("db6fc71")]);
  assert.deepEqual(files("full: 13118f1a2b3c4d5e6f708192a3b4c5d6e7f80912"), [commit("13118f1a2b3c4d5e6f708192a3b4c5d6e7f80912")]);
  assert.deepEqual(files("a 13118f1-ben (306ab01)"), [commit("13118f1"), commit("306ab01")], "a suffix, brackets");
  assert.deepEqual(files("--commit 13118f1"), [commit("13118f1")]);
});

test("no commit in words, numbers, colours, ids, UUIDs, paths, file names, longer hashes or URLs", () => {
  for (const text of [
    "defaced effaced facade", "1234567 and 20261114", "#3f7cf5aa", "0x7fffabc1", "ABCDEF1", "13118f",
    "550e8400-e29b-41d4-a716-446655440000", "uploads/20261114-153012-a1b2c3d4e5.png", "src/abc1234/x", "abc1234.ts",
    "sha256:59423e02fed56a33626d2124f6e9396258e00641b63b0146b389b0f04b75ccd2", "https://github.com/o/r/commit/13118f1",
    "x13118f1", "13118f1x", "run-13118f1", "id_13118f1",
  ]) assert.deepEqual(files(text), [], text);
});

test("files and commits come out with the queue and step ids, the text given back whole", () => {
  const text = "SF2 changed apps/x.ts:3 in 13118f1; UX2 next.";
  const parts = splitRefs(text, index);
  assert.equal(parts.map((x) => (typeof x === "string" ? x : x.text)).join(""), text);
  assert.deepEqual(refs(text), [
    { queue: "SF", step: "SF2", text: "SF2" }, { ...file("apps/x.ts", 3), text: "apps/x.ts:3" },
    { ...commit("13118f1"), text: "13118f1" }, { queue: "UX", step: "UX2", text: "UX2" },
  ]);
  assert.deepEqual(splitRefs("see a.ts:3", refIndex([])), ["see ", { ...file("a.ts", 3), text: "a.ts:3" }], "a project without queues");
});

test("an inline code span is a link when it is wholly one file or commit", () => {
  assert.deepEqual(wholeRef("apps/server/src/files.ts:40"), file("apps/server/src/files.ts", 40));
  assert.deepEqual(wholeRef(" 13118f1 "), commit("13118f1"));
  assert.equal(wholeRef("apps/server/src/files.ts"), undefined);
  assert.equal(wholeRef("npm test a.ts:3"), undefined);
  assert.equal(wholeRef("a.ts:3 b.ts:4"), undefined);
});
