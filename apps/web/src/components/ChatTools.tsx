// Search in a chat and its pinned messages (decided 2026-11-14, queue CH4; docs/ideas/chat-improvements.md). Search
// covers the whole chat: the server searches every line of chat.jsonl (@nexus/protocol/chat, searchChat) and the chat
// loads what is older than its view when a match is there. Matches are highlighted in the messages; ↑ and ↓ (Enter and
// Shift+Enter) go to the previous and next matching message, starting from the newest. Pins name a message by its
// line in chat.jsonl; the server keeps them (sessions/<id>/pins.json); they show at the top of the chat, and a click
// goes to the message.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { excerpt, type NumberedEntry } from "@nexus/protocol/chat";
import { Clock } from "./ui.tsx";
import { t } from "../i18n.ts";

/** A pinned message as the chat views send it. */
export interface PinView { line: number; at: string; entry: NumberedEntry }

const ICON_BUTTON = "grid h-7 w-7 shrink-0 place-items-center rounded-md text-fg-2 hover:bg-surface-3 hover:text-fg disabled:opacity-35 max-lg:h-10 max-lg:w-10";

export const SearchIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
);

/** The button that opens a chat's search (in its header). */
export function SearchButton({ open, onToggle, className = "" }: { open: boolean; onToggle: () => void; className?: string }) {
  return (
    <button type="button" onClick={onToggle} aria-pressed={open} title={t("chat.searchTitle")} aria-label={t("chat.search")}
      className={`grid shrink-0 place-items-center rounded-md ${open ? "bg-surface-3 text-fg" : "text-fg-2 hover:bg-surface-3 hover:text-fg"} h-7 w-7 max-lg:h-11 max-lg:w-11 ${className}`}>
      <SearchIcon />
    </button>
  );
}

/** What the search bar shows and does; the chat (Chat.tsx) holds the state. */
export interface SearchState {
  query: string;
  setQuery: (q: string) => void;
  /** The matching lines, oldest first; undefined while the search runs. */
  hits: number[] | undefined;
  /** Which of them is the current one. */
  at: number;
  go: (step: -1 | 1) => void;
  close: () => void;
}

/** The search bar over a chat's messages: the query, "3 of 12", previous and next, close. */
export function SearchBar({ s }: { s: SearchState }) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, []);
  const n = s.hits?.length ?? 0;
  const count = !s.query.trim() ? "" : s.hits === undefined ? t("chat.searching") : n ? t("chat.searchCount", { at: s.at + 1, count: n }) : t("chat.searchNone");
  return (
    <div className="flex items-center gap-1 border-b border-line bg-surface px-3 py-1.5 max-lg:px-2" role="search">
      <span className="pl-1 text-fg-3"><SearchIcon /></span>
      <input ref={input} value={s.query} onChange={(e) => s.setQuery(e.target.value)} placeholder={t("chat.searchPlaceholder")} aria-label={t("chat.search")}
        onKeyDown={(e) => {
          if (e.key === "Escape") { e.preventDefault(); s.close(); }
          else if (e.key === "Enter") { e.preventDefault(); s.go(e.shiftKey ? 1 : -1); }
        }}
        className="min-w-0 flex-1 bg-transparent px-1.5 py-1 text-sm text-fg outline-none placeholder:text-fg-3 max-lg:py-2" />
      <span className="shrink-0 whitespace-nowrap px-1 text-xs tabular-nums text-fg-3" aria-live="polite">{count}</span>
      <button type="button" onClick={() => s.go(-1)} disabled={n < 2} title={t("chat.searchPrevious")} aria-label={t("chat.searchPrevious")} className={ICON_BUTTON}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 15 6-6 6 6" /></svg>
      </button>
      <button type="button" onClick={() => s.go(1)} disabled={n < 2} title={t("chat.searchNext")} aria-label={t("chat.searchNext")} className={ICON_BUTTON}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
      </button>
      <button type="button" onClick={s.close} title={t("chat.searchClose")} aria-label={t("chat.searchClose")} className={ICON_BUTTON}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
      </button>
    </div>
  );
}

export const PinIcon = ({ filled }: { filled?: boolean }) => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M9 4h6l-1 6 4 4H6l4-4z" /><path d="M12 14v7" />
  </svg>
);

/** Pin or unpin a message: on a pinned one always shown, filled; otherwise like Copy (on hover on a desktop). */
export function PinButton({ pinned, onPin, hoverOnly }: { pinned: boolean; onPin: (pinned: boolean) => void; hoverOnly?: boolean }) {
  const label = pinned ? t("chat.unpin") : t("chat.pin");
  return (
    <button type="button" onClick={() => onPin(!pinned)} title={label} aria-label={label} aria-pressed={pinned}
      className={`inline-flex h-6 shrink-0 items-center rounded-md px-1.5 hover:bg-surface-4 focus-visible:opacity-100 max-lg:h-8 max-lg:px-2 ${pinned ? "text-accent" : `text-fg-3 hover:text-fg ${hoverOnly ? "opacity-0 group-hover/msg:opacity-100" : ""}`}`}>
      <PinIcon filled={pinned} />
    </button>
  );
}

/**
 * The pinned messages at the top of a chat, the most recently pinned first: two, and the others behind "N more". A
 * click goes to the message; ✕ unpins it.
 */
export function PinsBar({ pins, who, onGo, onUnpin }: { pins: PinView[]; who: (e: NumberedEntry) => string; onGo: (line: number) => void; onUnpin: (line: number) => void }) {
  const [all, setAll] = useState(false);
  if (!pins.length) return null;
  const sorted = [...pins].sort((a, b) => b.at.localeCompare(a.at) || b.line - a.line);
  const shown = all ? sorted : sorted.slice(0, 2);
  return (
    <div className="border-b border-line bg-surface" aria-label={t("chat.pinned")}>
      <ul className={`${all ? "scroll-thin max-h-56 overflow-y-auto" : ""}`}>
        {shown.map((p) => (
          <li key={p.line} className="group/pin flex items-center gap-1 pl-3 pr-1.5 max-lg:pl-2">
            <button type="button" onClick={() => onGo(p.line)} title={t("chat.goToPinned")}
              className="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left text-xs max-lg:py-2.5">
              <span className="shrink-0 text-accent"><PinIcon filled /></span>
              <span className="shrink-0 text-fg-3">{who(p.entry)} · <Clock at={p.entry.at} /></span>
              <span className="min-w-0 truncate text-fg">{excerpt(p.entry.text)}</span>
            </button>
            <button type="button" onClick={() => onUnpin(p.line)} title={t("chat.unpin")} aria-label={t("chat.unpin")}
              className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-fg-3 opacity-0 hover:bg-surface-3 hover:text-fg focus-visible:opacity-100 group-hover/pin:opacity-100 max-lg:h-9 max-lg:w-9 max-lg:opacity-100">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
            </button>
          </li>
        ))}
      </ul>
      {sorted.length > 2 && (
        <button type="button" onClick={() => setAll(!all)} className="w-full px-3 pb-1.5 text-left text-[11.5px] text-fg-2 hover:text-fg max-lg:pb-2.5 max-lg:pl-2">
          {all ? t("chat.pinsFewer") : t("chat.pinsMore", { count: sorted.length - 2 })}
        </button>
      )}
    </div>
  );
}

/**
 * Stop, over the message box while the chat's agent is in a turn (decided 2026-11-14, queue CH4): a pure interrupt.
 * The chat then says "Stopped."; what the turn had not written yet is dropped, and messages sent during the turn go in
 * with the next one. Disabled once pressed, until the chat changes.
 */
export function StopButton({ who, onStop }: { who: string; onStop: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  return (
    <div className="mb-2 flex items-center justify-end gap-2">
      {error && <span className="min-w-0 truncate text-xs text-danger">{error}</span>}
      <button type="button" disabled={busy} title={t("chat.stopTitle", { who })}
        onClick={() => { setBusy(true); setError(undefined); onStop().catch((e: Error) => { setError(e.message); setBusy(false); }); }}
        className="flex items-center gap-1.5 rounded-full border border-line-strong bg-surface-2 px-3 py-1 text-xs font-semibold text-fg shadow-sm hover:border-fg-3 hover:bg-surface-3 disabled:opacity-50 max-lg:min-h-10 max-lg:px-4">
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><rect width="10" height="10" rx="2" fill="currentColor" /></svg>
        {busy ? t("chat.stopping") : t("chat.stop")}
      </button>
    </div>
  );
}

/** Text with the query's matches marked (the user's messages and Nexus's notices; Markdown has its own, Refs.tsx). */
export function Marked({ text, ranges }: { text: string; ranges: [number, number][] }): ReactNode {
  if (!ranges.length) return text;
  const out: ReactNode[] = [];
  let at = 0;
  ranges.forEach(([a, b], i) => { if (a > at) out.push(text.slice(at, a)); out.push(<mark key={i}>{text.slice(a, b)}</mark>); at = b; });
  if (at < text.length) out.push(text.slice(at));
  return <>{out}</>;
}
