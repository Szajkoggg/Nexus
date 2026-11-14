// Long replies and message actions in a chat (decided 2026-11-14; docs/ideas/chat-improvements.md). A long reply gets
// a small table of contents built from its headings, and a "jump to the questions" button when it asks the user to
// decide. "Asks the user to decide" needs no protocol: it is a heading with "Kérdés" or "Question" in it or ending in
// "?", or else a paragraph or list item that is a question ("…?", "Question: …"). Every message can be copied as its
// Markdown source, and every code block on its own. Pure and unit tested; the chat (Chat.tsx, MessageTools.tsx) and
// its Markdown (Refs.tsx) use it. Places are the source lines react-markdown's nodes carry (position.start.line), so the
// rendered element of a heading or a question is found by its line.
import { fromMarkdown } from "mdast-util-from-markdown";
import type { ChatEntry } from "@nexus/protocol";

/** A heading of a reply: its text, how deep it sits under the reply's top headings (0, 1, 2), its source line. */
export interface Heading { text: string; level: number; line: number }

/** What a reply offers: its contents (empty when it has none worth showing) and where its questions start. */
export interface ReplyTools { contents: Heading[]; questions?: number }

/** A reply is long from this many characters on: about a screen of a desktop chat. */
export const LONG_REPLY = 1500;
/** A table of contents needs at least this many headings. */
export const MIN_HEADINGS = 2;

interface Node { type: string; depth?: number; value?: string; position?: { start: { line: number } }; children?: Node[] }

const parse = (markdown: string): Node => fromMarkdown(markdown) as unknown as Node;

/** A node's text, without its Markdown (emphasis, links and code lose their marks). */
function textOf(n: Node): string {
  if (n.value !== undefined && (n.type === "text" || n.type === "inlineCode")) return n.value;
  return (n.children ?? []).map(textOf).join("");
}

const clean = (s: string) => s.replace(/\s+/g, " ").trim();

/** The headings of a Markdown text, in order, with levels relative to its topmost (capped at 2). */
export function headingsOf(markdown: string): Heading[] {
  const found: { text: string; depth: number; line: number }[] = [];
  const walk = (n: Node) => {
    if (n.type === "heading" && n.position) { const text = clean(textOf(n)); if (text) found.push({ text, depth: n.depth ?? 1, line: n.position.start.line }); return; }
    // Headings quoted from someone else are not the reply's.
    if (n.type === "blockquote") return;
    n.children?.forEach(walk);
  };
  walk(parse(markdown));
  const top = Math.min(...found.map((h) => h.depth));
  return found.map((h) => ({ text: h.text, level: Math.min(2, h.depth - top), line: h.line }));
}

/** A heading that announces questions: "Kérdés", "Kérdések", "Question(s)", "Open questions", or one ending in "?". */
export const isQuestionHeading = (text: string): boolean =>
  /k[ée]rd[ée]s/i.test(text) || /\bquestions?\b/i.test(text) || endsInQuestion(text);

/** Text ending in a question mark, maybe behind closing quotes, brackets, emphasis marks or a remark in brackets. */
const endsInQuestion = (text: string) => /\?(\s*\([^()]*\))?[\s"'”’»)\]*_]*$/.test(text);

/** A paragraph that asks: it ends in "?", or opens with "Question:", "Question 2.", "Kérdés:". */
export const isQuestionParagraph = (text: string): boolean =>
  endsInQuestion(text) || /^(k[ée]rd[ée]s\w*|questions?)(\s+\d+)?\s*[:.]/i.test(text);

/**
 * Where a reply's questions to the user start, as a source line: its first question heading, else its first paragraph
 * or list item that asks. Code and quotes are never questions to the user. Undefined when it asks nothing.
 */
export function questionsOf(markdown: string): number | undefined {
  let heading: number | undefined, paragraph: number | undefined;
  const walk = (n: Node) => {
    if (heading !== undefined) return;
    if (n.type === "blockquote" || n.type === "code") return;
    if (n.type === "heading") { if (n.position && isQuestionHeading(clean(textOf(n)))) heading = n.position.start.line; return; }
    if (n.type === "paragraph") { if (paragraph === undefined && n.position && isQuestionParagraph(clean(textOf(n)))) paragraph = n.position.start.line; return; }
    // A list item that asks is found at its own line (its paragraph's), which the rendered item carries too.
    n.children?.forEach(walk);
  };
  walk(parse(markdown));
  return heading ?? paragraph;
}

/** A reply long enough to need its tools. */
export const isLong = (markdown: string): boolean => markdown.trim().length >= LONG_REPLY;

/** What a reply of the agent offers: nothing for a short one; for a long one its contents and its questions' place. */
export function replyTools(markdown: string): ReplyTools {
  if (!isLong(markdown)) return { contents: [] };
  const headings = headingsOf(markdown);
  const questions = questionsOf(markdown);
  return { contents: headings.length >= MIN_HEADINGS ? headings : [], ...(questions !== undefined ? { questions } : {}) };
}

/** What "Copy" puts on the clipboard for a message: its Markdown source, exactly as it was written. */
export const messageSource = (entry: Pick<ChatEntry, "text">): string => entry.text;

interface HastNode { type: string; value?: string; children?: HastNode[] }

/** What a code block's copy button copies: the code's text, without the newline Markdown ends a block with. */
export function codeText(node: HastNode | undefined): string {
  const text = (n: HastNode): string => (n.type === "text" ? n.value ?? "" : (n.children ?? []).map(text).join(""));
  return node ? text(node).replace(/\n$/, "") : "";
}
