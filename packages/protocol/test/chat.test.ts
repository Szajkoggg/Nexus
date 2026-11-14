// Searching a chat and its pins: matching folded text, the whole chat's matching lines, pins by line, excerpts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { excerpt, fold, matchRanges, searchChat, setPin, type NumberedEntry } from "../src/chat.ts";
import { readJsonl } from "../src/store.ts";
import { ChatEntry } from "../src/schemas.ts";

const at = "2026-11-14T10:00:00.000Z";
const e = (line: number, text: string, o: Partial<NumberedEntry> = {}): NumberedEntry => ({ at, from: "orchestrator", kind: "message", text, line, ...o });

test("folding: lower case and no accents, with the way back to the original's indices", () => {
  const f = fold("Kérdés Ő");
  assert.equal(f.folded, "kerdes o");
  assert.equal(f.map.length, f.folded.length + 1);
  assert.equal(fold("a😀b").map.join(","), "0,1,1,3,4", "both code units of a character outside the basic plane map to its start");
});

test("match ranges: every occurrence, case and accents ignored, in the original text's indices", () => {
  assert.deepEqual(matchRanges("The Kérdés and the kerdes", "KERDES"), [[4, 10], [19, 25]]);
  assert.deepEqual(matchRanges("aaaa", "aa"), [[0, 2], [2, 4]], "occurrences do not overlap");
  assert.deepEqual(matchRanges("stop  the   run", " the  run "), [], "spaces in the text are not collapsed");
  assert.deepEqual(matchRanges("stop the run", " the  run "), [[5, 12]], "the query's own spaces are");
  assert.deepEqual(matchRanges("anything", "   "), []);
  assert.deepEqual(matchRanges("a😀b😀b", "b"), [[3, 4], [6, 7]]);
});

test("search: the matching lines of the whole chat, oldest first; tool lines only when they are shown", () => {
  const chat = [e(0, "Start CH4?", { from: "user" }), e(2, "Bash: nexus run CH4 start", { kind: "tool" }), e(3, "Started **CH4**."), e(7, "Nothing here")];
  assert.deepEqual(searchChat(chat, "ch4"), [0, 3]);
  assert.deepEqual(searchChat(chat, "ch4", { tools: true }), [0, 2, 3]);
  assert.deepEqual(searchChat(chat, "missing"), []);
  assert.deepEqual(searchChat(chat, ""), []);
});

test("a chat's lines are their indices in chat.jsonl, past blank and broken lines", () => {
  const dir = mkdtempSync(join(tmpdir(), "nexus-chat-"));
  const file = join(dir, "chat.jsonl");
  const line = (text: string) => JSON.stringify({ at, from: "user", kind: "message", text });
  writeFileSync(file, [line("a"), "", "{broken", line("b"), line("c")].join("\n") + "\n" + '{"partial":');
  const r = readJsonl(file, ChatEntry);
  assert.deepEqual(r.entries.map((x) => x.text), ["a", "b", "c"]);
  assert.deepEqual(r.lines, [0, 3, 4]);
  assert.equal(r.errors.length, 1);
});

test("pins: pin and unpin by line, kept in chat order; pinning again keeps the first time", () => {
  let pins = setPin([], 12, true, "2026-11-14T10:00:00.000Z");
  pins = setPin(pins, 3, true, "2026-11-14T10:05:00.000Z");
  assert.deepEqual(pins.map((p) => p.line), [3, 12]);
  pins = setPin(pins, 12, true, "2026-11-14T11:00:00.000Z");
  assert.equal(pins.find((p) => p.line === 12)!.at, "2026-11-14T10:00:00.000Z");
  pins = setPin(pins, 3, false, at);
  assert.deepEqual(pins, [{ line: 12, at: "2026-11-14T10:00:00.000Z" }]);
  assert.deepEqual(setPin(pins, 99, false, at), pins, "unpinning what is not pinned changes nothing");
});

test("an excerpt: the message's first words without Markdown's marks", () => {
  assert.equal(excerpt("## Decided\n\n- **Stop** is a pure `interrupt`, see [the notes](docs/x.md).\n> quoted"), "Decided Stop is a pure interrupt, see the notes. quoted");
  assert.equal(excerpt("```ts\nconst a = 1;\n```"), "const a = 1;");
  assert.equal(excerpt("x".repeat(200), 10), "xxxxxxxxx…");
});
