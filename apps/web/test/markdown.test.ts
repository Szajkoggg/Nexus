// The dashboard's shared Markdown set-up (markdown.ts): GitHub's tables (and the rest of GFM) in the chat's Markdown
// and the dashboard's, the chat's refs and search marks inside a table, a table's source for "reply to this", and a
// step summary's line breaks that leave its table a table. Rendered as the components do: react-markdown on the server.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown, { type Components } from "react-markdown";
import { chatRehypePlugins, remarkPlugins, segmentOf, withLineBreaks } from "../src/markdown.ts";
import { refIndex } from "../src/refs.ts";
import { sourceAt, type SourcePosition } from "../src/quote.ts";

const index = refIndex([{ id: "MD", steps: [{ id: "MD1" }, { id: "MD2" }] }]);

/** As the dashboard's texts render (Markdown, ui.tsx). */
const dashboard = (md: string) => renderToStaticMarkup(createElement(ReactMarkdown, { remarkPlugins }, md));
/** As a chat message renders (ChatMarkdown, Refs.tsx), its components aside. */
const chat = (md: string, highlight = "", components?: Components) =>
  renderToStaticMarkup(createElement(ReactMarkdown, { remarkPlugins, rehypePlugins: chatRehypePlugins(index, highlight), components }, md));

const TABLE = [
  "The plan:",
  "",
  "| Step | What | Where |",
  "|---|:---:|---|",
  "| MD1 | GFM tables | `apps/web/src/markdown.ts:12` |",
  "| MD2 | strikethrough ~~old~~ | https://example.com/x |",
  "",
  "After it.",
].join("\n");

test("a GFM table is a table, with the chat's set-up and the dashboard's", () => {
  for (const html of [dashboard(TABLE), chat(TABLE)]) {
    assert.match(html, /<table>\s*<thead>\s*<tr>\s*<th>Step<\/th>/);
    assert.match(html, /<th style="text-align:center">What<\/th>/, "column alignment");
    assert.equal(html.match(/<tr>/g)?.length, 3, "a header row and two rows");
    assert.match(html, /<p>After it\.<\/p>/, "the text after the table is a paragraph again");
    assert.match(html, /<del>old<\/del>/, "strikethrough");
    assert.ok(!html.includes("|---|"), "no pipes left as text");
  }
  assert.match(dashboard("- [x] done\n- [ ] to do"), /<input type="checkbox" disabled="" checked=""\/> done/, "task lists");
  assert.match(dashboard("See https://example.com/a for it."), /<a href="https:\/\/example.com\/a">https:\/\/example.com\/a<\/a>/, "bare URLs");
});

test("in a table's cells, refs become links and a search's matches are marked", () => {
  const html = chat(TABLE, "tables");
  assert.match(html, /<td><a href="#" data-ref="MD\/MD1">MD1<\/a><\/td>/, "a step id in a cell");
  assert.match(html, /<td><a href="#" data-ref="file:12:apps\/web\/src\/markdown.ts"><code>apps\/web\/src\/markdown.ts:12<\/code><\/a><\/td>/, "a file in code");
  assert.match(html, /<td style="text-align:center">GFM <mark>tables<\/mark><\/td>/, "the searched word");
  assert.match(html, /<a href="https:\/\/example.com\/x">https:\/\/example.com\/x<\/a>/, "a bare URL is a link");
  assert.ok(!html.includes("data-ref=\"MD\"><a"), "no ref inside a link");
  assert.deepEqual(segmentOf("MD/MD1"), { queue: "MD", step: "MD1", text: "" });
  assert.deepEqual(segmentOf("file:12:apps/web/src/markdown.ts"), { kind: "file", line: 12, path: "apps/web/src/markdown.ts", text: "" });
});

/** A chat message's table as its "reply to this" sees it (ChatMarkdown): its Markdown source and its source line. */
function tableIn(md: string): { source: string | undefined; line: number | undefined } {
  let found = { source: undefined as string | undefined, line: undefined as number | undefined };
  chat(md, "", {
    table: ({ node, ...p }) => {
      found = { source: sourceAt(md, node?.position as SourcePosition | undefined), line: node?.position?.start.line };
      return createElement("table", p);
    },
  });
  return found;
}

test("a table's source is its rows, and its line is where it starts", () => {
  assert.deepEqual(tableIn(TABLE), { source: TABLE.split("\n").slice(2, 6).join("\n"), line: 3 });
  // Indented in a list item, it loses the item's indentation, as a nested item does.
  assert.equal(tableIn("- item\n\n  | a | b |\n  |---|---|\n  | 1 | 2 |").source, "| a | b |\n|---|---|\n| 1 | 2 |");
});

test("a step summary's line breaks are kept, and its table stays a table", () => {
  const summary = "Done: MD1.\nThe checks:\n\n| Check | Result |\n|---|---|\n| npm test | ok |\n| lint | ok |\n\nNext: MD2.\nThen MD3.";
  const html = chat(withLineBreaks(summary));
  assert.match(html, /<p>Done: <a[^>]*>MD1<\/a>\.<br\/>\s*The checks:<\/p>/, "a break per line");
  assert.match(html, /<table>[\s\S]*<td>npm test<\/td>\s*<td>ok<\/td>[\s\S]*<td>lint<\/td>\s*<td>ok<\/td>[\s\S]*<\/table>/);
  assert.match(html, /<p>Next: <a[^>]*>MD2<\/a>\.<br\/>\s*Then MD3\.<\/p>/);
  // Right under a line, with no blank line between them, too.
  assert.match(chat(withLineBreaks("Results:\n| a | b |\n|---|---|\n| 1 | 2 |")), /<p>Results:<\/p>\s*<table>/);
});
