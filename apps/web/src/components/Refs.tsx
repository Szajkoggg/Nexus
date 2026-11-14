// Refs in a chat drawn as links (UX proposals: "refs in the chat (UX2, W4c) that open the item"): a chip with the
// item's status dot; a click opens the queue or step, as a drawer over the rail on a desktop and as a sheet on the
// phone (nav.item). File paths with a line and commit hashes are links too: a file opens in the file viewer at the line
// (nav.file), a commit its details (nav.open("commit:<hash>")); either is checked when it opens. A file or commit in
// inline code (`src/x.ts:12`) is a link when it is the whole span. Which words are refs is refs.ts's job.
import { createContext, useContext, useMemo, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import type { QueueView } from "../api.ts";
import { refIndex, splitRefs, wholeRef, type CommitRef, type FileRef, type RefIndex, type RefTarget, type Segment } from "../refs.ts";
import { queueStatus } from "../queueStatus.ts";
import { nav } from "../nav.ts";
import { TONE } from "./QueueRow.tsx";
import { Replyable } from "./Quote.tsx";
import { sourceAt } from "../quote.ts";
import { codeText } from "../messageTools.ts";
import { CopyButton } from "./MessageTools.tsx";
import { statusWord } from "./ui.tsx";
import { t } from "../i18n.ts";

interface Refs { project: string; queues: readonly QueueView[]; index: RefIndex }
const RefsContext = createContext<Refs | null>(null);

/** Gives the chats below it the project's queues, whose ids become links in their messages. */
export function RefsProvider({ project, queues, children }: { project: string | undefined; queues: readonly QueueView[] | undefined; children: ReactNode }) {
  const value = useMemo(() => (project && queues ? { project, queues, index: refIndex(queues) } : null), [project, queues]);
  return <RefsContext.Provider value={value}>{children}</RefsContext.Provider>;
}

/** A step's status as a dot colour, for the ones worth a dot. */
const STEP_DOT: Record<string, string> = {
  running: "bg-accent animate-pulse", waiting: "bg-warn", review: "bg-review", stopped: "bg-stop", failed: "bg-danger", rejected: "bg-danger",
};
const QUEUE_DOT = new Set(["running", "waiting", "review", "stopped", "failed"]);

const hashOf = (project: string, t: RefTarget) => "#/" + [project, t.queue, t.step].filter((x): x is string => !!x).map(encodeURIComponent).join("/");

function RefLink({ refs, target, children }: { refs: Refs; target: RefTarget; children: ReactNode }) {
  const q = refs.queues.find((x) => x.id === target.queue);
  const step = target.step ? q?.steps.find((s) => s.id === target.step) : undefined;
  const tone = q && !target.step ? queueStatus(q).tone : undefined;
  const dot = step ? STEP_DOT[step.status] : tone && QUEUE_DOT.has(tone) ? TONE[tone][0] : undefined;
  const title = step ? `${target.queue}/${step.id} ${step.title} · ${statusWord(step.status)}` : q ? `${q.id} ${q.title} · ${queueStatus(q).label}` : target.queue;
  return (
    <a href={hashOf(refs.project, target)} title={title}
      onClick={(e) => { if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey) return; e.preventDefault(); nav.item(refs.project, target.queue, target.step); }}
      className="mx-px inline-flex items-center gap-1.5 whitespace-nowrap rounded-[7px] border border-line-strong bg-surface-2 px-1.5 py-px align-baseline text-[0.9em] font-normal text-fg no-underline hover:border-fg-3 hover:bg-surface-3">
      {dot && <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} />}{children}
    </a>
  );
}

const plainClick = (e: React.MouseEvent) => e.button === 0 && !e.ctrlKey && !e.metaKey && !e.shiftKey;
const LINK = "text-accent underline decoration-dotted underline-offset-2 hover:decoration-solid";

/** A file at a line: opens the file viewer there; a new tab (Ctrl+click) opens the dashboard with it. */
function FileLink({ project, target, children }: { project: string; target: FileRef; children: ReactNode }) {
  const href = `?file=${encodeURIComponent(target.path)}&line=${target.line}#/${encodeURIComponent(project)}`;
  return (
    <a href={href} title={t("refs.openFile", { path: target.path, line: target.line })} className={LINK}
      onClick={(e) => { if (!plainClick(e)) return; e.preventDefault(); nav.file(target.path, target.line); }}>{children}</a>
  );
}

/** A commit: opens its details. */
function CommitLink({ project, target, children }: { project: string; target: CommitRef; children: ReactNode }) {
  const href = `?commit=${target.hash}#/${encodeURIComponent(project)}`;
  return (
    <a href={href} title={t("refs.openCommit", { hash: target.hash })} className={LINK}
      onClick={(e) => { if (!plainClick(e)) return; e.preventDefault(); nav.open(`commit:${target.hash}`); }}>{children}</a>
  );
}

function SegmentLink({ refs, segment, children }: { refs: Refs; segment: Exclude<Segment, string>; children: ReactNode }) {
  if (segment.kind === "file") return <FileLink project={refs.project} target={segment}>{children}</FileLink>;
  if (segment.kind === "commit") return <CommitLink project={refs.project} target={segment}>{children}</CommitLink>;
  return <RefLink refs={refs} target={segment}>{children}</RefLink>;
}

/** Plain text (the user's messages, Nexus's notices) with its refs as links. */
export function RefText({ text }: { text: string }) {
  const refs = useContext(RefsContext);
  if (!refs) return <>{text}</>;
  return <>{splitRefs(text, refs.index).map((x, i) => (typeof x === "string" ? x : <SegmentLink key={i} refs={refs} segment={x}>{x.text}</SegmentLink>))}</>;
}

/** How a ref travels through Markdown's tree: data-ref on a link ("Q", "Q/S", "file:<line>:<path>", "commit:<hash>"). */
const dataRefOf = (p: Exclude<Segment, string> | FileRef | CommitRef): string =>
  p.kind === "file" ? `file:${p.line}:${p.path}` : p.kind === "commit" ? `commit:${p.hash}` : p.step ? `${p.queue}/${p.step}` : p.queue;
function segmentOf(ref: string): Exclude<Segment, string> {
  const file = /^file:(\d+):([\s\S]+)$/.exec(ref);
  if (file) return { kind: "file", line: Number(file[1]), path: file[2]!, text: "" };
  if (ref.startsWith("commit:")) return { kind: "commit", hash: ref.slice(7), text: "" };
  const [queue, step] = ref.split("/");
  return { queue: queue!, ...(step ? { step } : {}), text: "" };
}

// ---------------------------------------------------------------- in Markdown

interface HastNode { type: string; tagName?: string; value?: string; properties?: Record<string, unknown>; children?: HastNode[] }
/** Text in these stays text: code, and what is a link already. */
const SKIP = new Set(["code", "pre", "a"]);

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

/** Headings marked with their source line (a reply's contents go to them). */
const HEADINGS = Object.fromEntries((["h1", "h2", "h3", "h4", "h5", "h6"] as const).map((Tag) =>
  [Tag, ({ node, ...p }: { node?: { position?: { start: { line: number } } } } & Record<string, unknown>) => <Tag data-md-line={node?.position?.start.line} {...p} />]));

/** A chat message's Markdown, with its refs as links (outside code and links), its paragraphs and items repliable. */
export function ChatMarkdown({ children, className = "" }: { children: string; className?: string }) {
  const refs = useContext(RefsContext);
  const plugins = useMemo(() => (refs ? [rehypeRefs(refs.index)] : []), [refs]);
  return (
    <div className={`md text-sm leading-relaxed text-fg ${className}`}>
      <ReactMarkdown rehypePlugins={plugins} components={{
        a: ({ node: _n, ...p }) => {
          const ref = (p as Record<string, unknown>)["data-ref"];
          if (refs && typeof ref === "string") return <SegmentLink refs={refs} segment={segmentOf(ref)}>{p.children}</SegmentLink>;
          return <a {...p} target="_blank" rel="noreferrer" />;
        },
        // "Reply to this" on paragraphs and list items (Quote.tsx): quotes the item's Markdown source. They and the
        // headings carry their source line, where a reply's contents and "Jump to the questions" go (MessageTools.tsx).
        p: ({ node, ...p }) => <Replyable as="p" source={sourceAt(children, node?.position)} data-md-line={node?.position?.start.line} {...p} />,
        li: ({ node, ...p }) => <Replyable as="li" source={sourceAt(children, node?.position)} data-md-line={node?.position?.start.line} {...p} />,
        ...HEADINGS,
        // A code block has its own copy button, at its top right: on hover on a desktop, always on a phone.
        pre: ({ node, ...p }) => (
          <div className="group/code relative">
            <pre {...p} />
            <CopyButton text={() => codeText(node as never)} label={t("chat.copyCode")}
              className="absolute right-1 top-1 bg-surface-2 opacity-0 group-hover/code:opacity-100 max-lg:opacity-100" />
          </div>
        ),
      }}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
