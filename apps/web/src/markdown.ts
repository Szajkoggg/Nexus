// The Markdown set-up the dashboard shares: the chat's (ChatMarkdown, Refs.tsx), the dashboard's texts (Markdown,
// ui.tsx) and the file viewer's (FileView.tsx) all read GitHub's Markdown (remark-gfm: tables, strikethrough, task
// lists, bare URLs as links). The chat's two rehype steps live here too: its refs as links and a search's matches
// marked. Plain .ts, so the web tests render it (react-markdown with react-dom/server) without loading a .tsx.
import remarkGfm from "remark-gfm";
import { matchRanges } from "@nexus/protocol/chat";
import { splitRefs, wholeRef, type CommitRef, type FileRef, type RefIndex, type Segment } from "./refs.ts";

/** The remark plugins every Markdown of the dashboard is read with. */
export const remarkPlugins = [remarkGfm];

interface HastNode { type: string; tagName?: string; value?: string; properties?: Record<string, unknown>; children?: HastNode[] }
/** Text in these stays text: code, and what is a link already (GFM's bare URLs included). */
const SKIP = new Set(["code", "pre", "a"]);

/** How a ref travels through Markdown's tree: data-ref on a link ("Q", "Q/S", "file:<line>:<path>", "commit:<hash>"). */
const dataRefOf = (p: Exclude<Segment, string> | FileRef | CommitRef): string =>
  p.kind === "file" ? `file:${p.line}:${p.path}` : p.kind === "commit" ? `commit:${p.hash}` : p.step ? `${p.queue}/${p.step}` : p.queue;

/** The ref a link's data-ref names (dataRefOf's inverse), as a segment without its text. */
export function segmentOf(ref: string): Exclude<Segment, string> {
  const file = /^file:(\d+):([\s\S]+)$/.exec(ref);
  if (file) return { kind: "file", line: Number(file[1]), path: file[2]!, text: "" };
  if (ref.startsWith("commit:")) return { kind: "commit", hash: ref.slice(7), text: "" };
  const [queue, step] = ref.split("/");
  return { queue: queue!, ...(step ? { step } : {}), text: "" };
}

/**
 * A rehype step: the text nodes' refs become links marked data-ref (dataRefOf); an inline code span that is wholly a
 * file or a commit is wrapped in one.
 */
const rehypeRefs = (index: RefIndex) => () => (tree: HastNode) => {
  const link = (ref: string, children: HastNode[]): HastNode => ({ type: "element", tagName: "a", properties: { href: "#", dataRef: ref }, children });
  const walk = (node: HastNode) => {
    if (!node.children || (node.tagName && SKIP.has(node.tagName))) return;
    node.children = node.children.flatMap((c): HastNode[] => {
      if (c.type === "element" && c.tagName === "code" && c.children?.length === 1 && c.children[0]!.type === "text") {
        const ref = wholeRef(c.children[0]!.value ?? "");
        return ref ? [link(dataRefOf(ref), [c])] : [c];
      }
      if (c.type !== "text" || !c.value) { walk(c); return [c]; }
      const parts = splitRefs(c.value, index);
      if (parts.length === 1 && typeof parts[0] === "string") return [c];
      return parts.map((p) => typeof p === "string" ? { type: "text", value: p } : link(dataRefOf(p), [{ type: "text", value: p.text }]));
    });
  };
  walk(tree);
};

/** A rehype step: a search's matches in the text (code and links included) wrapped in <mark>. */
const rehypeMarks = (query: string) => () => (tree: HastNode) => {
  const walk = (node: HastNode) => {
    if (!node.children || node.tagName === "mark") return;
    node.children = node.children.flatMap((c): HastNode[] => {
      if (c.type !== "text" || !c.value) { walk(c); return [c]; }
      const ranges = matchRanges(c.value, query);
      if (!ranges.length) return [c];
      const out: HastNode[] = [];
      let at = 0;
      for (const [a, b] of ranges) {
        if (a > at) out.push({ type: "text", value: c.value.slice(at, a) });
        out.push({ type: "element", tagName: "mark", properties: {}, children: [{ type: "text", value: c.value.slice(a, b) }] });
        at = b;
      }
      if (at < c.value.length) out.push({ type: "text", value: c.value.slice(at) });
      return out;
    });
  };
  walk(tree);
};

/** The chat's rehype steps: its refs as links when it knows the project's queues, a search's matches marked. */
export const chatRehypePlugins = (index: RefIndex | undefined, highlight: string) =>
  [...(index ? [rehypeRefs(index)] : []), ...(highlight.trim() ? [rehypeMarks(highlight)] : [])];

/**
 * A text whose every line break is kept (a step summary is often one item a line): a hard break on each line. A table
 * in it stays a table: GFM reads a row with trailing spaces as a row (markdown.test.ts).
 */
export const withLineBreaks = (text: string): string => text.replace(/\n/g, "  \n");
