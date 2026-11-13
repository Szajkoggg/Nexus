// Quoting in a chat (decided 2026-11-14; docs/ideas/chat-improvements.md): a selection, or one paragraph or list item
// of a message ("reply to this"), goes into the message box as a Markdown quote ("> …") at the end, after any draft,
// with the cursor on a line of its own below it. "Reply to this" quotes the item's Markdown source, not its rendered
// text. Pure and unit tested; the chat (Chat.tsx) and its Markdown (Refs.tsx) use it.

/** Text as a Markdown quote: every line behind "> " ("">" alone for an empty one); blank lines at either end dropped. */
export function quoteText(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n").map((l) => l.replace(/\s+$/, ""));
  while (lines.length && lines[0] === "") lines.shift();
  while (lines.length && lines.at(-1) === "") lines.pop();
  return lines.map((l) => (l ? `> ${l}` : ">")).join("\n");
}

/**
 * The message box's text with a quote added at its end: after the draft (and a blank line), then a blank line, so the
 * cursor (put at the end) starts the answer below the quote. Nothing to quote leaves the draft as it is.
 */
export function withQuote(draft: string, text: string): string {
  const q = quoteText(text);
  if (!q) return draft;
  const before = draft.replace(/\s+$/, "");
  return `${before ? `${before}\n\n` : ""}${q}\n\n`;
}

/** Where a node's source is in the Markdown it came from (react-markdown's positions: lines and columns from 1, offsets from 0). */
export interface SourcePosition { start: { line: number; column: number; offset?: number }; end: { line: number; column: number; offset?: number } }

/**
 * The Markdown source of a paragraph or a list item, from its position in the message: a nested item's lines lose the
 * indentation the item itself has, so "  - b\n    - c" quotes as "- b\n  - c". Undefined when the position is missing.
 */
export function sourceAt(markdown: string, pos: SourcePosition | undefined): string | undefined {
  if (!pos) return undefined;
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const s = pos.start, e = pos.end;
  if (s.line < 1 || e.line > lines.length || e.line < s.line) return undefined;
  const part = lines.slice(s.line - 1, e.line);
  part[part.length - 1] = part.at(-1)!.slice(0, s.line === e.line ? e.column - 1 : e.column - 1);
  part[0] = part[0]!.slice(s.column - 1);
  const indent = s.column - 1;
  return part.map((l, i) => (i === 0 ? l : l.replace(new RegExp(`^ {0,${indent}}`), ""))).join("\n").replace(/\s+$/, "");
}
