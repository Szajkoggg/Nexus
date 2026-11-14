// A chat message's tools (decided 2026-11-14; docs/ideas/chat-improvements.md): Copy (the message's Markdown source,
// messageTools.ts), and on a long reply its Contents (a menu of its headings) and "Jump to the questions". Both go to
// the rendered element of a source line, which ChatMarkdown (Refs.tsx) marks with data-md-line, and flash it.
import { useEffect, useRef, useState, type RefObject } from "react";
import { Menu } from "./ui.tsx";
import type { Heading } from "../messageTools.ts";
import { t } from "../i18n.ts";

/**
 * Puts text on the clipboard. The Clipboard API needs a secure page (localhost, https); over plain http (remote access
 * on the home network) a hidden text area and the older copy command do it.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (window.isSecureContext && navigator.clipboard) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* falls back below */ }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none";
  document.body.appendChild(area);
  area.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch { ok = false; }
  area.remove();
  return ok;
}

const CopyIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" />
  </svg>
);
const CheckIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12.5 10 17 19 7" /></svg>
);

/** A copy button: copies `text`, then says "Copied" (or that it could not) for a moment. */
export function CopyButton({ text, label, className = "" }: { text: string | (() => string); label: string; className?: string }) {
  const [done, setDone] = useState<"copied" | "failed">();
  const timer = useRef(0);
  useEffect(() => () => clearTimeout(timer.current), []);
  const go = async () => {
    const ok = await copyToClipboard(typeof text === "function" ? text() : text);
    setDone(ok ? "copied" : "failed");
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setDone(undefined), 1600);
  };
  const shown = done === "copied" ? t("chat.copied") : done === "failed" ? t("chat.copyFailed") : label;
  return (
    <button type="button" onClick={() => void go()} title={shown} aria-label={shown}
      className={`inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-fg-3 hover:bg-surface-4 hover:text-fg focus-visible:opacity-100 max-lg:h-8 max-lg:px-2 ${done ? "opacity-100" : ""} ${className}`}>
      {done === "copied" ? <CheckIcon /> : <CopyIcon />}
      {done && <span className="text-[11px]">{shown}</span>}
    </button>
  );
}

/** Scrolls a message's element for a source line into view (below the sticky line over a long reply) and flashes it. */
export function goToLine(message: HTMLElement | null, line: number) {
  const el = message?.querySelector<HTMLElement>(`[data-md-line="${line}"]`);
  if (!el) return;
  el.scrollIntoView({ block: "start", behavior: "smooth" });
  el.classList.remove("md-flash");
  void el.offsetWidth; // restarts the flash when the same place is chosen twice
  el.classList.add("md-flash");
}

const ACTION = "inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-[11.5px] text-fg-2 hover:bg-surface-4 hover:text-fg max-lg:h-8 max-lg:px-2";

/** A long reply's tools: its Contents (when it has headings enough) and "Jump to the questions" (when it asks). */
export function ReplyTools({ message, contents, questions, up }: {
  message: RefObject<HTMLElement | null>; contents: Heading[]; questions: number | undefined;
  /** The menu opens upward (the phone's line under the bubble). */
  up?: boolean;
}) {
  return (
    <>
      {contents.length > 0 && (
        <Menu down={!up} left label={t("chat.contentsTitle")}
          trigger={{ className: ACTION, content: <><ListIcon />{t("chat.contents")}</> }}
          items={[
            { heading: t("chat.contents") },
            ...contents.map((h) => ({
              label: <span className={`block truncate ${h.level === 0 ? "font-medium" : "text-fg-2"}`} style={{ paddingLeft: `${h.level * 0.9}rem` }}>{h.text}</span>,
              onSelect: () => goToLine(message.current, h.line),
            })),
          ]} />
      )}
      {questions !== undefined && (
        <button type="button" onClick={() => goToLine(message.current, questions)} title={t("chat.toQuestionsTitle")} className={`${ACTION} text-accent hover:text-accent`}>
          <QuestionIcon />{t("chat.toQuestions")}
        </button>
      )}
    </>
  );
}

const ListIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" /></svg>
);
const QuestionIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="9" /><path d="M9.5 9.5a2.5 2.5 0 0 1 4.9.7c0 1.7-2.4 2.3-2.4 3.8" /><path d="M12 17h.01" />
  </svg>
);
