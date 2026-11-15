// Searching a project's history: the query's parameters, folded matching of every word, the kind and time filters,
// tool lines only when asked, what events and queues offer, the excerpt with its highlights, and the newest hits kept.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SearchError, SearchHits, chatItem, eventItems, foldText, itemMatches, lineMayMatch, parseSearch, queueItems, searchExcerpt, searchTerms,
  type SearchItem,
} from "../src/search.ts";
import { QueueFile, type Event } from "../src/schemas.ts";

const at = "2026-11-14T10:00:00.000Z";
const item = (text: string, o: Partial<SearchItem> = {}): SearchItem => ({ kind: "chat", at, text, ...o });
const q = (query: string, o: Record<string, string> = {}) => parseSearch({ q: query, ...o });

test("matching ignores accents and case; with several words every one must occur, anywhere", () => {
  assert.equal(foldText("Kérdés ÁRVÍZTŰRŐ"), "kerdes arvizturo");
  assert.deepEqual(searchTerms("  Kérdés   kérdés STOP "), ["kerdes", "stop"]);
  assert.ok(itemMatches(item("Where is the Kérdés about the stop button?"), q("KERDES")));
  assert.ok(itemMatches(item("árvíztűrő tükörfúrógép"), q("tukorfurogep ARVIZTURO")));
  assert.ok(!itemMatches(item("árvíztűrő tükörfúrógép"), q("tukorfurogep kerdes")));
  // A word may be a part of a longer one.
  assert.ok(itemMatches(item("the integration step"), q("integr")));
});

test("the kind and time filters; tool lines only with the switch", () => {
  const chat = item("deploy the server", { kind: "chat" });
  const step = item("deploy the server", { kind: "step", at: "2026-11-10T08:00:00.000Z" });
  const tool = item("Bash: nexus server deploy", { tool: true });
  assert.ok(itemMatches(chat, q("deploy", { kinds: "chat" })));
  assert.ok(!itemMatches(step, q("deploy", { kinds: "chat" })));
  assert.ok(itemMatches(step, q("deploy", { kinds: "chat,step" })));
  assert.ok(itemMatches(step, q("deploy", { since: "2026-11-10" })));
  assert.ok(!itemMatches(step, q("deploy", { since: "2026-11-10T09:00:00+00:00" })));
  assert.ok(itemMatches(chat, q("deploy", { since: "2026-11-14T10:00:00.000Z" })), "an item exactly at `since` counts");
  assert.ok(!itemMatches(tool, q("deploy")));
  assert.ok(itemMatches(tool, q("deploy", { tools: "1" })));
});

test("the parameters: words required, known kinds, a time, a limit in range", () => {
  assert.throws(() => parseSearch({}), SearchError);
  assert.throws(() => parseSearch({ q: "   " }), /q: the words/);
  assert.throws(() => parseSearch({ q: "x".repeat(201) }), /at most 200/);
  assert.throws(() => parseSearch({ q: "x", kinds: "chat,mail" }), /kinds: mail unknown/);
  assert.throws(() => parseSearch({ q: "x", since: "yesterday" }), /since: a time/);
  assert.throws(() => parseSearch({ q: "x", limit: "0" }), /limit/);
  assert.throws(() => parseSearch({ q: "x", limit: "501" }), /limit/);
  assert.throws(() => parseSearch({ q: "x", limit: "2.5" }), /limit/);
  const p = parseSearch({ q: "Árvíz", kinds: "report, chat", since: "2026-11-14", limit: "10", tools: "1" });
  assert.deepEqual(p, { terms: ["arviz"], kinds: ["chat", "report"], since: "2026-11-14T00:00:00.000Z", limit: 10, tools: true });
  assert.deepEqual(parseSearch({ q: "x", kinds: "" }).kinds, ["queue", "step", "question", "chat", "report", "review", "note"]);
  assert.equal(parseSearch({ q: "x" }).limit, 50);
});

test("a raw line is parsed only when it may match; a word JSON escapes is not tested raw", () => {
  const line = JSON.stringify({ at, from: "user", text: "Say \"hello\" to the Kérdés" });
  assert.ok(lineMayMatch(line, q("kerdes hello")));
  assert.ok(!lineMayMatch(line, q("kerdes goodbye")));
  assert.ok(lineMayMatch(line, q('"hello"')), "a quoted word is left to the parsed text");
});

test("the excerpt: around the first match, cut at words, every word highlighted", () => {
  const short = searchExcerpt("The  Kérdés\nabout the stop button", ["kerdes", "stop"]);
  assert.equal(short.excerpt, "The Kérdés about the stop button");
  assert.deepEqual(short.ranges.map(([s, e]) => short.excerpt.slice(s, e)), ["Kérdés", "stop"]);

  const words = Array.from({ length: 80 }, (_, i) => `word${i}`);
  words[50] = "Árvíz";
  // The window opens around the first match (word49 comes just before Árvíz), whole words, "…" on both sides.
  const long = searchExcerpt(words.join(" "), ["arviz", "word49"], 60);
  assert.ok(long.excerpt.startsWith("…") && long.excerpt.endsWith("…"));
  assert.ok(long.excerpt.length <= 62);
  assert.match(long.excerpt, /^…word\d+ .* word\d+…$/);
  assert.deepEqual(long.ranges.map(([s, e]) => long.excerpt.slice(s, e)), ["word49", "Árvíz"]);
  // The first match decides the window: "word5" first occurs as word5 itself; every occurrence shown is marked
  // (also inside word50 … word59 when they are in view).
  const early = searchExcerpt(words.join(" "), ["arviz", "word5"], 60);
  assert.ok(early.excerpt.startsWith("…word2 ") && !early.excerpt.includes("Árvíz"));
  assert.deepEqual(early.ranges.map(([s, e]) => early.excerpt.slice(s, e)), ["word5"]);
  // Overlapping words are merged into one range.
  const merged = searchExcerpt("integration", ["integr", "gration"]);
  assert.deepEqual(merged.ranges, [[0, 11]]);
});

test("what events offer: outcomes, questions and answers, review texts; nothing else", () => {
  const base = { v: 1 as const, id: "01E", at, session: "01S" };
  const ev = (e: Record<string, unknown>) => ({ ...base, ...e }) as Event;
  assert.deepEqual(eventItems(ev({ type: "step.done", queue: "Q", step: "Q1", summary: "Done it" })).map((i) => [i.kind, i.queue, i.step, i.text]), [["step", "Q", "Q1", "Done it"]]);
  assert.equal(eventItems(ev({ type: "step.failed", queue: "Q", step: "Q1", reason: "Broke" }))[0]!.kind, "step");
  assert.equal(eventItems(ev({ type: "queue.stop", queue: "Q", step: "Q1", condition: "C", reason: "R" }))[0]!.text, "C\nR");
  const asked = eventItems(ev({ type: "question.asked", queue: "Q", step: "Q1", qid: "01Q", text: "Which one?", can_continue: false }))[0]!;
  assert.deepEqual([asked.kind, asked.qid], ["question", "01Q"]);
  const answer = eventItems(ev({ type: "answer.given", qid: "01Q", text: "The first" }))[0]!;
  assert.deepEqual([answer.kind, answer.qid, answer.queue], ["question", "01Q", undefined]);
  assert.equal(eventItems(ev({ type: "review.commented", queue: "Q", step: "Q1", path: "a.png", text: "Too dark", to: "note" }))[0]!.kind, "review");
  assert.deepEqual(eventItems(ev({ type: "review.accepted", queue: "Q", step: "Q1" })), []);
  assert.deepEqual(eventItems(ev({ type: "step.progress", queue: "Q", step: "Q1", text: "Halfway" })), []);
});

test("what a queue offers: its title and description, each step's title and goal", () => {
  const queue = QueueFile.parse({ protocol: 1, id: "Q", title: "Search", description: "Find things", steps: [{ id: "Q1", title: "Server", goal: "An endpoint", acceptance: [] }], updated_at: at });
  const items = queueItems(queue);
  assert.deepEqual(items.map((i) => [i.kind, i.queue, i.step, i.text, i.title]), [["queue", "Q", undefined, "Search\nFind things", "Search"], ["queue", "Q", "Q1", "Server\nAn endpoint", "Search"]]);
  assert.equal(chatItem({ at, from: "user", kind: "tool", text: "x" }, "01S", 7).tool, true);
});

test("the hits: newest first, only the newest `limit` kept, all of them counted", () => {
  const hits = new SearchHits(q("deploy", { limit: "3" }));
  for (let i = 0; i < 10; i++) hits.add(item(`deploy ${i}`, { at: `2026-11-1${i}T00:00:00.000Z` }));
  hits.add(item("nothing here"));
  const r = hits.result();
  assert.deepEqual(r.hits.map((h) => h.excerpt), ["deploy 9", "deploy 8", "deploy 7"]);
  assert.equal(r.total, 10);
  assert.equal(r.more, true);
  assert.deepEqual(r.hits[0]!.ranges, [[0, 6]]);
  assert.ok(!("text" in r.hits[0]!) && !("tool" in r.hits[0]!));
});
