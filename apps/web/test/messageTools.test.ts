// Long replies and message actions: the contents from the headings, where the questions start, and what Copy copies.
import { test } from "node:test";
import assert from "node:assert/strict";
import { codeText, headingsOf, isQuestionHeading, isQuestionParagraph, LONG_REPLY, messageSource, questionsOf, replyTools } from "../src/messageTools.ts";

const filler = (n: number) => Array.from({ length: n }, (_, i) => `Line ${i + 1} of the explanation, long enough to fill the reply out a little.`).join(" ");

test("the contents: every heading in order, its text without Markdown, its level under the top headings, its line", () => {
  const md = [
    "Intro paragraph.", // 1
    "", // 2
    "## What changed", // 3
    "", // 4
    "Text.", // 5
    "", // 6
    "### The `engine.ts` part", // 7
    "", // 8
    "#### Deep **detail** [link](https://x)", // 9
    "", // 10
    "##### Deeper still", // 11
    "", // 12
    "## Next ##", // 13
  ].join("\n");
  assert.deepEqual(headingsOf(md), [
    { text: "What changed", level: 0, line: 3 },
    { text: "The engine.ts part", level: 1, line: 7 },
    { text: "Deep detail link", level: 2, line: 9 },
    { text: "Deeper still", level: 2, line: 11 },
    { text: "Next", level: 0, line: 13 },
  ]);
});

test("the contents leave out what only looks like a heading: code, quotes, empty headings; setext headings count", () => {
  const md = ["Title", "=====", "", "```md", "# not a heading", "```", "", "> # quoted", "", "#", "", "Second", "------"].join("\n");
  assert.deepEqual(headingsOf(md), [{ text: "Title", level: 0, line: 1 }, { text: "Second", level: 1, line: 12 }]);
  assert.deepEqual(headingsOf("No headings at all."), []);
});

test("a question heading: Kérdés, Question(s), or a heading ending in a question mark", () => {
  for (const h of ["Kérdések", "Kérdés a döntéshez", "kerdesek", "Questions", "Open question", "Which one do we take?", "Merge now? (recommended)"]) assert.ok(isQuestionHeading(h), h);
  for (const h of ["Summary", "What changed", "Questionable choices"]) assert.ok(!isQuestionHeading(h), h);
});

test("a question paragraph: ends in a question mark, or opens with Question: / Kérdés:", () => {
  for (const p of ["Shall I start CH4?", "Do we keep it “as is”?", "**Should the stop be a pure interrupt?**", "Question: keep or drop?", "Question 2. Which port", "Kérdés: maradjon így"]) assert.ok(isQuestionParagraph(p), p);
  for (const p of ["It works.", "Questions are below.", "Why? Because the file is shared."]) assert.ok(!isQuestionParagraph(p), p);
});

test("where the questions start: the first question heading wins over earlier question paragraphs", () => {
  const md = ["Why did it fail? Let me explain.", "", "Was it the port?", "", "It was.", "", "## Kérdések", "", "1. Keep it?"].join("\n");
  assert.equal(questionsOf(md), 7);
});

test("without a question heading, the first paragraph or list item that asks", () => {
  const md = ["## Summary", "", "All done.", "", "Two things to decide:", "", "1. Merge it now?", "2. Keep the old flag?"].join("\n");
  assert.equal(questionsOf(md), 7);
});

test("code and quotes do not ask the user; a reply that asks nothing has no questions", () => {
  assert.equal(questionsOf(["> Can you check X?", "", "```", "ok?", "```", "", "Checked it: fine."].join("\n")), undefined);
  assert.equal(questionsOf("## Summary\n\nAll done."), undefined);
});

test("a short reply has no tools; a long one has its contents (two headings or more) and its questions", () => {
  const short = "## A\n\nx\n\n## B\n\nShall I go on?";
  assert.deepEqual(replyTools(short), { contents: [] });
  const long = ["## Status", "", filler(25), "", "## Kérdések", "", "1. Shall I go on?"].join("\n");
  assert.ok(long.length >= LONG_REPLY);
  assert.deepEqual(replyTools(long), { contents: [{ text: "Status", level: 0, line: 1 }, { text: "Kérdések", level: 0, line: 5 }], questions: 5 });
  const oneHeading = ["## Status", "", filler(25), "", "Shall I go on?"].join("\n");
  assert.deepEqual(replyTools(oneHeading), { contents: [], questions: 5 }, "one heading makes no contents, the question is still found");
  assert.deepEqual(replyTools(filler(30)), { contents: [] });
});

test("copy returns the message's Markdown source exactly, and a code block its code", () => {
  const text = "## Done\n\n- **one** `two`\n\n```ts\nconst a = 1;\n```\n";
  assert.equal(messageSource({ text }), text);
  const pre = { type: "element", children: [{ type: "element", children: [{ type: "text", value: "const a = 1;\n" }, { type: "element", children: [{ type: "text", value: "b();\n" }] }] }] };
  assert.equal(codeText(pre), "const a = 1;\nb();");
  assert.equal(codeText(undefined), "");
});
