// Quoting in a chat: the quote's text, its place after a draft, and "reply to this" quoting an item's Markdown source.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fromMarkdown } from "mdast-util-from-markdown";
import { quoteText, sourceAt, withQuote, type SourcePosition } from "../src/quote.ts";

test("a selection as a quote: every line, empty ones as a bare >, blank ends dropped", () => {
  assert.equal(quoteText("one line"), "> one line");
  assert.equal(quoteText("\nfirst\r\n\nsecond  \n\n"), "> first\n>\n> second");
  assert.equal(quoteText("Three things:\n- SC waits\n  - two steps\n- W stopped"), "> Three things:\n> - SC waits\n>   - two steps\n> - W stopped", "nested list lines keep their indentation");
  assert.equal(quoteText("   \n  "), "");
});

test("the quote goes after the draft, with the cursor's line below it", () => {
  assert.equal(withQuote("", "a"), "> a\n\n");
  assert.equal(withQuote("My answer so far.", "a\nb"), "My answer so far.\n\n> a\n> b\n\n");
  assert.equal(withQuote("Draft\n\n\n", "a"), "Draft\n\n> a\n\n", "trailing blank lines of the draft are not doubled");
  assert.equal(withQuote("> a\n\n", "b"), "> a\n\n> b\n\n", "a second quote after the first");
  assert.equal(withQuote("Draft", "  \n"), "Draft", "nothing to quote: the draft as it was");
});

/** The positions react-markdown gives its components come from mdast: find paragraphs and list items like it does. */
function positions(md: string, type: "paragraph" | "listItem"): SourcePosition[] {
  const out: SourcePosition[] = [];
  const walk = (n: { type: string; position?: SourcePosition; children?: unknown[] }) => {
    if (n.type === type && n.position) out.push(n.position);
    for (const c of (n.children ?? []) as typeof n[]) walk(c);
  };
  walk(fromMarkdown(md) as never);
  return out;
}

test("reply to this quotes the item's Markdown source: bold, refs, code and nested items as written", () => {
  const md = "Three things:\n\n- **SC** waits for `approval`\n  - two steps\n    - SC1\n- W stopped at W2\n\n1. first\n2. second [link](http://x)\n\nThe *end*.";
  const items = positions(md, "listItem").map((p) => sourceAt(md, p));
  assert.deepEqual(items, [
    "- **SC** waits for `approval`\n  - two steps\n    - SC1",
    "- two steps\n  - SC1",
    "- SC1",
    "- W stopped at W2",
    "1. first",
    "2. second [link](http://x)",
  ]);
  const paras = positions(md, "paragraph").map((p) => sourceAt(md, p));
  assert.equal(paras[0], "Three things:");
  assert.equal(paras.at(-1), "The *end*.");
  assert.equal(withQuote("", items[1]!), "> - two steps\n>   - SC1\n\n");
  assert.equal(sourceAt(md, undefined), undefined);
});
