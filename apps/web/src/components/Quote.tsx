// Quoting in a chat (decided 2026-11-14; docs/ideas/chat-improvements.md). Selecting text in the messages shows a small
// floating "Quote" button beside the selection (on a phone below it, clear of the system's own menu above it); Alt+Q
// does the same on a desktop. Hovering a paragraph or list item of a message shows a "reply to this" icon at its edge;
// one click quotes that item's Markdown source. Either way the quote goes at the end of the message box, after any
// draft, with the cursor below it (quote.ts, putDraftAndFocus). The browser's right-click menu is left alone.
import { createContext, useContext, useEffect, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { usePhone } from "../phone.ts";
import { t } from "../i18n.ts";

/** What quoting does in the chat around it: adds the text as a quote to that chat's message box. */
export const QuoteTarget = createContext<((text: string) => void) | null>(null);
/** Inside a list item: its paragraphs have no icon of their own (the item's quotes them). */
const InItem = createContext(false);

/**
 * The floating "Quote" button for a selection inside `scroller` (the chat's messages). It keeps the selected text when
 * it shows, so a tap that clears the selection on a phone still quotes it.
 */
export function QuoteSelection({ scroller }: { scroller: RefObject<HTMLElement | null> }) {
  const quote = useContext(QuoteTarget);
  const phone = usePhone();
  const [at, setAt] = useState<{ text: string; left: number; top: number }>();

  useEffect(() => {
    const read = () => {
      const sel = document.getSelection();
      const box = scroller.current;
      if (!sel || sel.isCollapsed || !sel.rangeCount || !box) { setAt(undefined); return; }
      const range = sel.getRangeAt(0);
      const text = sel.toString();
      if (!box.contains(range.commonAncestorContainer) || !text.trim()) { setAt(undefined); return; }
      const rects = range.getClientRects();
      const last = rects[rects.length - 1] ?? range.getBoundingClientRect();
      const all = range.getBoundingClientRect();
      // Scrolled out of the chat's view (the box grew under it, the user scrolled): no button floating elsewhere.
      const view = box.getBoundingClientRect();
      if (last.bottom <= view.top || last.top >= view.bottom) { setAt(undefined); return; }
      const W = 84, H = 34, vw = window.innerWidth, vh = window.innerHeight;
      // Beside the selection's end on a desktop; below the selection on a phone, where the system menu is above it.
      let left = phone ? all.left + all.width / 2 - W / 2 : last.right + 8;
      let top = phone ? all.bottom + 14 : last.top + last.height / 2 - H / 2;
      if (left + W > vw - 8) {
        left = vw - W - 8;
        if (!phone) top = last.bottom + 8; // no room beside the end of the line: just below it
      }
      left = Math.max(8, left);
      top = Math.min(Math.max(8, top), vh - H - 8);
      setAt({ text, left, top });
    };
    document.addEventListener("selectionchange", read);
    const box = scroller.current;
    box?.addEventListener("scroll", read, { passive: true });
    window.addEventListener("resize", read);
    return () => { document.removeEventListener("selectionchange", read); box?.removeEventListener("scroll", read); window.removeEventListener("resize", read); };
  }, [scroller, phone]);

  const go = () => { if (!at || !quote) return; quote(at.text); document.getSelection()?.removeAllRanges(); setAt(undefined); };
  // Alt+Q quotes the selection (Ctrl+Q and Cmd+Q close browsers on some systems).
  useEffect(() => {
    if (!at || !quote) return;
    const key = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey || e.code !== "KeyQ") return;
      e.preventDefault();
      go();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });

  if (!at || !quote) return null;
  return createPortal(
    <button
      onPointerDown={(e) => e.preventDefault()} onMouseDown={(e) => e.preventDefault()} onClick={go}
      title={t("quote.title")} data-quote-button
      className="fixed z-50 flex h-[34px] items-center gap-1.5 rounded-full border border-line-strong bg-surface-3 px-3 text-xs font-semibold text-fg shadow-lg hover:bg-surface-4 max-lg:h-11 max-lg:px-4"
      style={{ left: at.left, top: at.top }}>
      <QuoteIcon />{t("quote.button")}
    </button>,
    document.body,
  );
}

const QuoteIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M7 6h4v5c0 3.3-1.7 5.6-5 7l-1-1.6c1.9-1 2.9-2.4 3-4.4H4V6zm10 0h4v5c0 3.3-1.7 5.6-5 7l-1-1.6c1.9-1 2.9-2.4 3-4.4h-4V6z" />
  </svg>
);

/**
 * A paragraph or list item of a message that can be replied to: hovering it (on a phone, tapping it) shows the icon at
 * its right edge; only the innermost hovered item shows one. `source` is its Markdown, for the quote.
 */
export function Replyable({ as: Tag, source, children, className = "", ...rest }: {
  as: "p" | "li"; source: string | undefined; children?: ReactNode; className?: string;
} & Record<string, unknown>) {
  const quote = useContext(QuoteTarget);
  const inItem = useContext(InItem);
  if (!quote || !source || (Tag === "p" && inItem)) return <Tag className={className} {...rest}>{children}</Tag>;
  const body = Tag === "li" ? <InItem.Provider value={true}>{children}</InItem.Provider> : children;
  return (
    <Tag className={`reply-item relative [&:hover:not(:has(.reply-item:hover))>.reply-btn]:opacity-100 ${className}`} {...rest}>
      {body}
      <button onClick={() => quote(source)} title={t("quote.replyTitle")} aria-label={t("quote.reply")}
        className="reply-btn absolute -right-7 top-0 grid h-6 w-6 place-items-center rounded-md text-fg-3 opacity-0 hover:bg-surface-4 hover:text-fg focus:opacity-100 max-lg:-right-8 max-lg:h-8 max-lg:w-8">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 14 4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" /></svg>
      </button>
    </Tag>
  );
}
