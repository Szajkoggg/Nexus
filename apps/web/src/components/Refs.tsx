// Refs in a chat drawn as links (UX proposals: "refs in the chat (UX2, W4c) that open the item"): a chip with the
// item's status dot; a click opens the queue or step, as a drawer over the rail on a desktop and as a sheet on the
// phone (nav.item). Which words are refs is refs.ts's job.
import { createContext, useContext, useMemo, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import type { QueueView } from "../api.ts";
import { refIndex, splitRefs, type RefIndex, type RefTarget } from "../refs.ts";
import { queueStatus } from "../queueStatus.ts";
import { nav } from "../nav.ts";
import { TONE } from "./QueueRow.tsx";
import { Replyable } from "./Quote.tsx";
import { sourceAt } from "../quote.ts";

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
  const title = step ? `${target.queue}/${step.id} ${step.title} · ${step.status}` : q ? `${q.id} ${q.title} · ${queueStatus(q).label}` : target.queue;
  return (
    <a href={hashOf(refs.project, target)} title={title}
      onClick={(e) => { if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey) return; e.preventDefault(); nav.item(refs.project, target.queue, target.step); }}
      className="mx-px inline-flex items-center gap-1.5 whitespace-nowrap rounded-[7px] border border-line-strong bg-surface-2 px-1.5 py-px align-baseline text-[0.9em] font-normal text-fg no-underline hover:border-fg-3 hover:bg-surface-3">
      {dot && <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} />}{children}
    </a>
  );
}

/** Plain text (the user's messages, Nexus's notices) with its refs as links. */
export function RefText({ text }: { text: string }) {
  const refs = useContext(RefsContext);
  if (!refs) return <>{text}</>;
  return <>{splitRefs(text, refs.index).map((x, i) => (typeof x === "string" ? x : <RefLink key={i} refs={refs} target={x}>{x.text}</RefLink>))}</>;
}

// ---------------------------------------------------------------- in Markdown

interface HastNode { type: string; tagName?: string; value?: string; properties?: Record<string, unknown>; children?: HastNode[] }
/** Text in these stays text: code, and what is a link already. */
const SKIP = new Set(["code", "pre", "a"]);

/** A rehype step: the text nodes' refs become links marked data-ref ("<queue>" or "<queue>/<step>"). */
const rehypeRefs = (index: RefIndex) => () => (tree: HastNode) => {
  const walk = (node: HastNode) => {
    if (!node.children || (node.tagName && SKIP.has(node.tagName))) return;
    node.children = node.children.flatMap((c): HastNode[] => {
      if (c.type !== "text" || !c.value) { walk(c); return [c]; }
      const parts = splitRefs(c.value, index);
      if (parts.length === 1 && typeof parts[0] === "string") return [c];
      return parts.map((p) => typeof p === "string" ? { type: "text", value: p }
        : { type: "element", tagName: "a", properties: { href: "#", dataRef: p.step ? `${p.queue}/${p.step}` : p.queue }, children: [{ type: "text", value: p.text }] });
    });
  };
  walk(tree);
};

/** A chat message's Markdown, with its refs as links (outside code and links), its paragraphs and items repliable. */
export function ChatMarkdown({ children, className = "" }: { children: string; className?: string }) {
  const refs = useContext(RefsContext);
  const plugins = useMemo(() => (refs ? [rehypeRefs(refs.index)] : []), [refs]);
  return (
    <div className={`md text-sm leading-relaxed text-fg ${className}`}>
      <ReactMarkdown rehypePlugins={plugins} components={{
        a: ({ node: _n, ...p }) => {
          const ref = (p as Record<string, unknown>)["data-ref"];
          if (refs && typeof ref === "string") {
            const [queue, step] = ref.split("/");
            return <RefLink refs={refs} target={{ queue: queue!, ...(step ? { step } : {}) }}>{p.children}</RefLink>;
          }
          return <a {...p} target="_blank" rel="noreferrer" />;
        },
        // "Reply to this" on paragraphs and list items (Quote.tsx): quotes the item's Markdown source.
        p: ({ node, ...p }) => <Replyable as="p" source={sourceAt(children, node?.position)} {...p} />,
        li: ({ node, ...p }) => <Replyable as="li" source={sourceAt(children, node?.position)} {...p} />,
      }}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
