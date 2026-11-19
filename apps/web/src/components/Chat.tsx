// Chats: the project's orchestrator, and conversations with a thinking partner.
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import type { ChatEntry, RuntimeFile, SessionFile, SessionView } from "@nexus/protocol";
import type { NumberedEntry } from "@nexus/protocol/chat";
import { tokenCount } from "@nexus/protocol/tokens";
import { PinButton, PinsBar, SearchBar, SearchButton, StopButton, type PinView, type SearchState } from "./ChatTools.tsx";
import { act, actResult, enc, projectUrl, request, useAction, useQuery, type Version } from "../api.ts";
import { Button, Clock, Composer, Menu, ReadError, TimeAgo, type MenuEntry } from "./ui.tsx";
import { CopyButton, ReplyTools } from "./MessageTools.tsx";
import { messageSource, replyTools } from "../messageTools.ts";
import { ChatMarkdown, RefText } from "./Refs.tsx";
import { draftKey, putDraftAndFocus, readDraft } from "../drafts.ts";
import { withQuote } from "../quote.ts";
import { withLineBreaks } from "../markdown.ts";
import { QuoteSelection, QuoteTarget } from "./Quote.tsx";
import { layerValue } from "../layers.ts";
import { nav, useNav } from "../nav.ts";
import { usePhone } from "../phone.ts";
import { firstUnread, hasUnread, opening, placeKey, readPlace, seenUpTo, unreadCount, usePlaces, writePlace } from "../chatPlace.ts";
import { EffortSelect, ModelSelect, useEfforts } from "./Settings.tsx";
import { rich, t } from "../i18n.ts";
import { SentPictures, filesOf, usePictures } from "./Pictures.tsx";
import { splitPictures, withPictures } from "../pictures.ts";
import { usePage } from "../page.ts";
import { fileHref } from "../hash.ts";
import { clearChatTarget, useChatTarget } from "../chatTarget.ts";
import { SearchField } from "./Search.tsx";
import { IdeasMatching, IdeasOverview, IdeasSwitch, type IdeasPanelView } from "./Ideas.tsx";

// ---------------------------------------------------------------- the endpoints this file reads and writes

/** A session's chat lines from `from` up to (not including) `to`: the older part of a long chat. */
const chatLines = (project: string, session: string, from: number, to: number) =>
  request<{ chat: NumberedEntry[] }>(projectUrl(project, `/sessions/${enc(session)}/chat?from=${from}&to=${to}`));
/** The chat lines a search finds (with `tools`, also in tool calls). */
const searchChat = (project: string, session: string, query: string, tools: boolean, signal: AbortSignal) =>
  request<{ lines?: number[] }>(projectUrl(project, `/sessions/${enc(session)}/chat/search?q=${enc(query)}${tools ? "&tools=1" : ""}`), { signal });
/** The step's latest conversation that is not archived, if any. */
const stepConversation = (project: string, queue: string, step: string) =>
  request<{ conversation: { id: string } | null }>(projectUrl(project, `/queues/${enc(queue)}/steps/${enc(step)}/conversation`));
/** Starts a conversation (about a step, or with a title and a runtime); resolves with its id. */
async function newConversation(project: string, body: { queue: string; step: string } | { title: string; runtime: string; model?: string; effort?: string }): Promise<string> {
  const made = await actResult<{ id: string }>(project, "POST", "/conversations", body);
  if (!made) throw new Error("the server started no conversation");
  return made.id;
}

/**
 * A chat view: the newest entries with their lines in chat.jsonl, and the pinned messages (apps/server/src/chats.ts).
 * The orchestrator's also has the sessions it went on from (`earlier`, its context care: apps/server/src/orchestrator.ts).
 */
interface View { session: SessionFile | null; state: "working" | "idle" | "exited"; runtime: RuntimeFile | null; chat: NumberedEntry[]; pins: PinView[]; model: string | null; effort: string | null; earlier?: EarlierSession[] }

/**
 * A session the orchestrator's current one went on from, oldest first: its newest entries, and its switch to the next
 * (when, its context fill then from 0 to 1 and its tokens, unknown from an older server; the summary it wrote or null).
 */
interface EarlierSession {
  session: string; created_at: string; chat: NumberedEntry[];
  switch: { at: string; fill: number | null; tokens?: number | null; summary: NonNullable<SessionView["context"]> | null };
}

/** Where the server keeps the orchestrator's latest summary for a fresh session (PROTOCOL.md, "Layout"). */
const SUMMARY_FILE = ".nexus/orchestrator/summary.md";

/** A chat's search, open or not: its button is in the chat's header, or in the desktop column's for the orchestrator. */
interface Search { open: boolean; set: (open: boolean) => void }

/** The orchestrator's chat of a project: its data, and why it could not be read (shown in its place, ChatPanel). */
export function useOrchestrator(project: string | undefined, version: Version) {
  return useQuery<View>(project ? projectUrl(project, "/orchestrator") : undefined, version);
}

/** A chat: what it is (its header; on a desktop's orchestrator chat, in the middle column's header), the messages, and the composer. */
function ChatColumn({ project, title, over, who, about, view, ready, error, place, status, showTools, onNeedTools, menu, empty, draft, placeholder, onSend, onStop, onBack, bare, search, wrapTitle }: {
  /** The project: where pictures are uploaded, and served from. */
  project: string;
  title: string; over: string;
  wrapTitle?: boolean;
  /** The view holds this chat (not the one shown before it, still there while this one loads). */
  ready: boolean;
  /** The chat's read failed (and nothing of it is held): why, where its messages would be. */
  error?: string;
  /** Where its place is kept (chatPlace.ts, placeKey). */
  place: string;
  /** Who answers, over each of its messages on a desktop: "Orchestrator", "Partner". */
  who: string; about?: ReactNode; view: View | undefined; status: string; showTools: boolean; empty: ReactNode;
  draft: string; placeholder: string; onSend: (text: string) => Promise<void>; onBack?: () => void;
  /** The chat's menu, at the right of its header. */
  menu?: MenuEntry[];
  /** No header of its own: the desktop's orchestrator chat, whose state is in the middle column's header. */
  bare?: boolean;
  search: Search;
  /** The stop button's action, shown while the agent is in a turn (ChatTools.tsx, StopButton). */
  onStop: () => Promise<void>;
  /** Shows the tool calls: a search hit on a tool line goes there (chatTarget.ts). */
  onNeedTools: () => void;
}) {
  const side = useContext(Side);
  const phone = usePhone();
  const loaded = useMemo(() => (ready ? view?.chat ?? [] : []), [ready, view?.chat]);
  const earlier = ready ? view?.earlier ?? [] : [];
  const session = ready ? view?.session?.id : undefined;
  // What the view sent, after what is older and was loaded to reach a match or a pin (useOlder).
  const older = useOlder(project, session, loaded);
  const full = older.full;
  const shown = full.map((c, i) => ({ c, i })).filter(({ c }) => showTools || c.kind !== "tool");
  const p = usePlace(place, full, ready, showTools, view?.state);
  const goTo = useGoTo(p.scroller, full, older.load);
  const s = useSearch(project, session, showTools, search, goTo);
  useTarget(place, ready, session, earlier, showTools, onNeedTools, goTo, p.scroller);
  const highlight = s?.query ?? "";
  const current = s?.hits?.[s.at];
  const pins = ready ? view?.pins ?? [] : [];
  const pinned = new Set(pins.map((x) => x.line));
  const pin = (line: number, on: boolean) => { if (session) void act(project, "POST", `/sessions/${enc(session)}/pins`, { line, pinned: on }).catch((e: Error) => alert(e.message)); };
  const whoOf = (e: NumberedEntry) => (e.from === "user" ? t("chat.you") : e.from === "nexus" ? "Nexus" : who);
  // Quoting (Quote.tsx): a selection or a "reply to this" goes into this chat's box, after its draft.
  const quote = useCallback((text: string) => putDraftAndFocus(draft, withQuote(readDraft(draft), text)), [draft]);
  // On a desktop the text keeps a chat app's measure: a column of about 780 px in the middle.
  const measure = phone ? "" : "mx-auto w-full max-w-[48.75rem]";
  // Pictures for the next message: pasted or chosen in the composer, or dropped anywhere on the chat.
  const pictures = usePictures(project, draft);
  const [dragging, setDragging] = useState(false);
  const carriesFiles = (e: React.DragEvent) => [...e.dataTransfer.types].includes("Files");
  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col"
      onDragOver={(e) => { if (!carriesFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = "copy"; setDragging(true); }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false); }}
      onDrop={(e) => { if (!carriesFiles(e)) return; e.preventDefault(); setDragging(false); pictures.add(filesOf(e.dataTransfer)); }}>
      {dragging && (
        <div className="pointer-events-none absolute inset-2 z-20 grid place-items-center rounded-2xl border-2 border-dashed border-accent bg-canvas/80 text-sm font-semibold text-fg">
          {t("chat.dropHere")}
        </div>
      )}
      {!bare && (
        <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-5 py-3">
          {onBack && <button onClick={onBack} className={`rounded-md px-1.5 text-lg text-fg-2 hover:text-fg ${side ? "" : "sm:hidden"}`} aria-label={t("common.back")}>‹</button>}
          <div className="min-w-0">
            <div className="text-xs text-fg-3">{over}</div>
            <h2 className={`${wrapTitle ? "break-words" : "truncate"} font-semibold text-fg`}>{title}</h2>
            {about}
          </div>
          <span className="text-xs text-fg-3">{statusLine(view, status)}</span>
          <span className="ml-auto flex items-center gap-1.5">
            {ready && view?.session && <SearchButton open={search.open} onToggle={() => search.set(!search.open)} />}
            {menu && <Menu items={menu} down label={t("chat.actions")} />}
          </span>
        </header>
      )}
      <QuoteTarget.Provider value={quote}>
      <QuoteSelection scroller={p.scroller} />
      <div className="relative flex min-h-0 flex-1 flex-col">
        {s && <SearchBar s={s} />}
        <PinsBar key={session} pins={pins} who={whoOf} onGo={(line) => goTo(line, "pin")} onUnpin={(line) => pin(line, false)} />
        <div ref={p.scroller} onScroll={p.onScroll} data-chat-scroll={place} className={`scroll-thin flex-1 overflow-y-auto ${phone ? "px-5" : "px-6"}`}>
          {/* The space at the ends is the content's, not the scroller's padding: a long reply's sticky line (Reply) then
              sticks at the very edge of the view, with no strip of text scrolling past outside it. */}
          <div className={`${measure} ${phone ? "space-y-3 py-4" : "space-y-4 py-6"}`}>
            {ready && shown.length === 0 && !earlier.length && <div className="mt-10 text-center text-sm text-fg-3">{empty}</div>}
            {!ready && error && <ReadError error={error} className="mt-10 text-center" />}
            {/* The sessions it went on from: read-only (their pins and search are their own), a line at each switch. */}
            {earlier.map((b, k) => (
              <div key={b.session} className={phone ? "space-y-3" : "space-y-4"}>
                {b.chat.filter((c) => showTools || c.kind !== "tool").map((c) => (
                  <div key={`${b.session}:${c.line}`} data-earlier={`${b.session}:${c.line}`}><Entry c={c} flat={!phone} who={who} project={project} highlight={highlight} /></div>
                ))}
                <FreshSessionLine project={project} sw={b.switch} latest={k === earlier.length - 1} />
              </div>
            ))}
            {shown.map(({ c, i }) => (
              <div key={c.line} data-i={i} data-line={c.line} className={c.line === current ? "search-current" : undefined}>
                <Entry c={c} flat={!phone} who={who} project={project} highlight={highlight} pinned={pinned.has(c.line)} onPin={(on) => pin(c.line, on)} />
              </div>
            ))}
            {ready && view?.state === "working" && <div className="text-xs text-fg-3"><span className="animate-pulse">●</span> {t("chat.working")}</div>}
          </div>
        </div>
        {p.unread > 0 && (
          <button onClick={p.jump} className="absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-line-strong bg-surface-3 px-3.5 py-1.5 text-xs font-semibold text-fg shadow-lg hover:bg-surface-4 max-lg:min-h-11 max-lg:px-4">
            {t("chat.newBelow", { count: p.unread })}
          </button>
        )}
      </div>
      </QuoteTarget.Provider>
      <footer className={phone ? "border-t border-line p-3" : "px-6 pb-5 pt-3"}>
        <div className={measure}>
          {ready && view?.state === "working" && <StopButton key={view.chat.length} who={who} onStop={onStop} />}
          <Composer rows={3} draft={draft} placeholder={placeholder} button={t("details.send")} oneLine={phone} card={!phone} pictures={pictures}
            onSubmit={async (text) => { p.follow(); await onSend(withPictures(text, pictures.paths)); pictures.clear(); }} />
        </div>
      </footer>
    </div>
  );
}

/**
 * Older entries than the view sent (its newest 300 or 400), loaded when a search's match or a pin is older: lines
 * `from` up to the view's first. Old entries never change (chat.jsonl is append-only), so they are fetched once; when
 * the view's window has moved on past them, the gap is filled.
 */
function useOlder(project: string, session: string | undefined, loaded: NumberedEntry[]) {
  const [older, setOlder] = useState<{ session?: string; to: number; chat: NumberedEntry[] }>({ to: 0, chat: [] });
  const first = loaded[0]?.line;
  const mine = useMemo(() => (older.session === session ? older.chat : []), [older, session]);
  const load = useCallback(async (from: number) => {
    if (!session || first === undefined || from >= first) return;
    // Older lines that cannot be read stay out; the next scroll to the top asks again.
    const j = await chatLines(project, session, from, first).catch(() => undefined);
    if (!j) return;
    setOlder({ session, to: first, chat: j.chat });
  }, [project, session, first]);
  useEffect(() => { if (mine.length && first !== undefined && first > older.to) void load(mine[0]!.line); }, [first, older.to, mine, load]);
  const full = useMemo(() => (mine.length && first !== undefined ? [...mine.filter((e) => e.line < first), ...loaded] : loaded), [mine, loaded, first]);
  return { full, load };
}

/**
 * Going to an entry by its line: a search's match (its first mark in the middle of the view) or a pinned message (at the
 * top), flashed. An entry that is not loaded yet is loaded first (useOlder), and gone to once it is drawn.
 */
function useGoTo(scroller: RefObject<HTMLDivElement | null>, full: NumberedEntry[], load: (from: number) => Promise<void>) {
  const pending = useRef<{ line: number; how: "search" | "pin" } | null>(null);
  const scrollTo = useCallback((line: number, how: "search" | "pin") => {
    const box = scroller.current;
    const el = box?.querySelector<HTMLElement>(`[data-line="${line}"]`);
    if (!box || !el) return false;
    const target = (how === "search" && el.querySelector<HTMLElement>("mark")) || el;
    const r = target.getBoundingClientRect(), b = box.getBoundingClientRect();
    box.scrollTop += how === "search" ? r.top - b.top - box.clientHeight / 2 + Math.min(r.height, box.clientHeight / 2) / 2 : r.top - b.top - 12;
    el.classList.remove("md-flash");
    void el.offsetWidth; // restarts the flash
    el.classList.add("md-flash");
    return true;
  }, [scroller]);
  const goTo = useCallback((line: number, how: "search" | "pin") => {
    pending.current = null;
    if (scrollTo(line, how)) return;
    pending.current = { line, how };
    void load(line);
  }, [scrollTo, load]);
  useLayoutEffect(() => {
    const p = pending.current;
    if (p && scrollTo(p.line, p.how)) pending.current = null;
  }, [full, scrollTo]);
  return goTo;
}

/**
 * Going to a search hit's message (chatTarget.ts) once this chat, its place, has loaded: in the current session by its
 * line (loading older entries if needed, as a chat's own search does); in a session the orchestrator went on from, if
 * the view holds it (its newest entries); else the chat simply opens where the user left it. A tool line first turns
 * the tool calls on. The target is taken, so it is gone to once.
 */
function useTarget(place: string, ready: boolean, session: string | undefined, earlier: EarlierSession[], showTools: boolean, onNeedTools: () => void,
  goTo: (line: number, how: "search") => void, scroller: RefObject<HTMLDivElement | null>) {
  const target = useChatTarget();
  useEffect(() => {
    if (!target || target.place !== place || !ready) return;
    if (target.tool && !showTools) { onNeedTools(); return; }
    clearChatTarget();
    if (target.session === session) { goTo(target.line, "search"); return; }
    const el = scroller.current?.querySelector<HTMLElement>(`[data-earlier="${target.session}:${target.line}"]`);
    if (!el) return;
    el.scrollIntoView({ block: "center" });
    el.classList.add("md-flash");
  }, [target, place, ready, session, earlier, showTools, onNeedTools, goTo, scroller]);
}

/**
 * The search of a chat (ChatTools.tsx): the server searches the whole chat.jsonl (a moment after the typing stops);
 * the newest match is the first one shown, and ↑ goes to older ones.
 */
function useSearch(project: string, session: string | undefined, showTools: boolean, search: Search, goTo: (line: number, how: "search") => void): SearchState | undefined {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<number[] | undefined>([]);
  const [at, setAt] = useState(0);
  useEffect(() => { if (!search.open) { setQuery(""); setHits([]); } }, [search.open]);
  useEffect(() => {
    if (!search.open || !session || !query.trim()) { setHits([]); return; }
    setHits(undefined);
    const ctl = new AbortController();
    const timer = setTimeout(() => {
      void searchChat(project, session, query, showTools, ctl.signal)
        .then((j) => { const lines = j.lines ?? []; setHits(lines); setAt(Math.max(0, lines.length - 1)); if (lines.length) goTo(lines.at(-1)!, "search"); })
        // A newer query took over (aborted), or the search failed: no hits, as a refused search showed before.
        .catch((e: Error) => { if (e.name !== "AbortError") setHits([]); });
    }, 250);
    return () => { clearTimeout(timer); ctl.abort(); };
  }, [project, session, showTools, search.open, query, goTo]);
  if (!search.open) return undefined;
  const go = (step: -1 | 1) => {
    if (!hits?.length) return;
    const n = (at + step + hits.length) % hits.length;
    setAt(n);
    goTo(hits[n]!, "search");
  };
  return { query, setQuery, hits, at, go, close: () => search.set(false) };
}

/**
 * A chat's place (chatPlace.ts): once the chat has loaded it opens where the user left it, or at its newest message the
 * first time; scrolling records the entry at the top, whether the view is at the end and what has been seen. While the
 * chat is open and at its end, new messages keep it there; otherwise they do not move it, and `unread` counts them for
 * the "N new" button, which jumps to the first.
 */
function usePlace(key: string, full: readonly ChatEntry[], ready: boolean, showTools: boolean, state: string | undefined) {
  const scroller = useRef<HTMLDivElement>(null);
  const restored = useRef(false);
  const atEnd = useRef(true);
  const chat = useRef(full);
  chat.current = full;
  const [shown, setShown] = useState<{ end: boolean; seen?: string }>({ end: true, seen: readPlace(key)?.seen });

  /** Reads the view: the entry at its top, whether it is at the end, the last entry in it; stores the place. */
  const record = useCallback(() => {
    const box = scroller.current;
    if (!box || !restored.current) return;
    const top = box.getBoundingClientRect().top, bottom = top + box.clientHeight;
    const items = [...box.querySelectorAll<HTMLElement>("[data-i]")];
    const first = items.find((el) => el.getBoundingClientRect().bottom > top + 1);
    let last = -1;
    for (const el of items) if (el.getBoundingClientRect().top < bottom - 1) last = Number(el.dataset.i);
    const end = box.scrollHeight - box.scrollTop - box.clientHeight < 32;
    const all = chat.current;
    const seen = seenUpTo(all, end ? all.length - 1 : last, readPlace(key)?.seen);
    writePlace(key, { anchor: first ? Number(first.dataset.i) : 0, offset: first ? first.getBoundingClientRect().top - top : 0, end, ...(seen ? { seen } : {}) });
    atEnd.current = end;
    setShown((s) => (s.end === end && s.seen === seen ? s : { end, seen }));
  }, [key]);

  /** Puts the view at the stored place (or at the end) and records it. */
  const restore = useCallback(() => {
    const box = scroller.current;
    if (!box) return;
    const o = opening(readPlace(key), chat.current.length);
    if (o.at === "end") box.scrollTop = box.scrollHeight;
    else {
      const el = [...box.querySelectorAll<HTMLElement>("[data-i]")].find((x) => Number(x.dataset.i) >= o.anchor);
      if (el) box.scrollTop += el.getBoundingClientRect().top - box.getBoundingClientRect().top - (Number(el.dataset.i) === o.anchor ? o.offset : 0);
      else box.scrollTop = box.scrollHeight;
    }
    restored.current = true;
    record();
  }, [key, record]);

  // Opening: only once the chat has loaded, so a chat opened for the first time lands at its newest message.
  useLayoutEffect(() => { if (ready && !restored.current) restore(); }, [ready, full.length, restore]);
  // Showing or hiding the tool lines keeps the entry at the top.
  useLayoutEffect(() => { if (restored.current) restore(); }, [showTools, restore]);
  // New entries (or "working…") while the chat is open: followed at the end, else left below the view.
  useLayoutEffect(() => {
    const box = scroller.current;
    if (!box || !restored.current) return;
    if (atEnd.current) box.scrollTop = box.scrollHeight;
    record();
  }, [full.length, state, record]);

  const frame = useRef(0);
  const onScroll = () => { cancelAnimationFrame(frame.current); frame.current = requestAnimationFrame(record); };
  const jump = () => {
    const box = scroller.current;
    const i = firstUnread(chat.current, readPlace(key)?.seen);
    const el = box && i !== undefined ? [...box.querySelectorAll<HTMLElement>("[data-i]")].find((x) => Number(x.dataset.i) >= i) : undefined;
    if (box && el) box.scrollTo({ top: box.scrollTop + el.getBoundingClientRect().top - box.getBoundingClientRect().top - 12, behavior: "smooth" });
    else if (box) box.scrollTo({ top: box.scrollHeight, behavior: "smooth" });
  };
  const unread = shown.end ? 0 : unreadCount(full, shown.seen);
  /** The user sends: the view goes to the end and follows. */
  const follow = () => { atEnd.current = true; const box = scroller.current; if (box) box.scrollTop = box.scrollHeight; };
  return { scroller, onScroll, unread, jump, follow };
}

/** What a chat's session is doing, its model, effort and its context: "ready · opus-5-5 · 212k tokens of context (21%)". */
function statusLine(view: View | undefined, status: string): string {
  const rt = view?.runtime;
  const context = rt?.context_tokens && rt.context_window
    ? t("chat.context", { tokens: tokenCount(rt.context_tokens), pct: Math.round((100 * rt.context_tokens) / rt.context_window) }) : undefined;
  const model = rt?.model ? rt.model.replace(/^claude-/, "") : view?.model;
  return `${status}${model ? ` · ${model}` : ""}${view?.effort ? ` · ${t("run.effort", { effort: view.effort })}` : ""}${context ? ` · ${context}` : ""}`;
}

/**
 * One entry of a chat. On the phone the other side's messages are bubbles; on a desktop (`flat`, mockup 11A) they are
 * text in the column under a line saying who and when, Nexus's notices a line with a rule at the left. Every message
 * shows its time and can be copied as Markdown (MessageTools.tsx): on a desktop Copy shows on hover, on the phone it
 * is always there.
 */
function Entry({ c, flat, who, project, highlight, pinned, onPin }: {
  c: ChatEntry; flat?: boolean; who: string; project: string;
  /** A search's query, its matches marked. */
  highlight: string;
  /** Its pin; none for an entry of an earlier session (read-only). */
  pinned?: boolean; onPin?: (pinned: boolean) => void;
}) {
  if (c.kind === "tool") {
    return <div className="truncate pl-1 font-mono text-[11px] text-fg-3" title={c.text}>{flat ? "$" : "›"} {c.text}</div>;
  }
  if (c.from === "user") {
    // Its pictures' paths show as the pictures, below its text (a message of pictures alone has no bubble).
    const { text, pictures } = splitPictures(c.text);
    return (
      <div className="group/msg flex flex-col items-end">
        {text && <div className={`whitespace-pre-wrap rounded-2xl rounded-br-sm bg-user-bubble px-4 py-2 text-sm text-fg ${flat ? "max-w-[min(85%,37.5rem)]" : "max-w-[85%]"}`}><RefText text={text} highlight={highlight} /></div>}
        {pictures.length > 0 && <div className={flat ? "max-w-[min(85%,37.5rem)]" : "max-w-[85%]"}><SentPictures project={project} paths={pictures} /></div>}
        <div className="mt-0.5 flex items-center gap-0.5 text-[11px] text-fg-3">
          {onPin && <PinButton pinned={!!pinned} onPin={onPin} hoverOnly={flat} />}
          <CopyButton text={messageSource(c)} label={t("chat.copy")} className={flat ? "opacity-0 group-hover/msg:opacity-100" : ""} />
          <Clock at={c.at} />
        </div>
      </div>
    );
  }
  if (c.from === "nexus") {
    if (flat) {
      return (
        <div className={`border-l-2 px-2.5 py-0.5 text-xs ${c.kind === "error" ? "border-danger/60 text-danger" : "border-line-strong text-fg-2"}`}>
          <span className="whitespace-pre-wrap">Nexus · <RefText text={c.text} highlight={highlight} /></span><span className="text-fg-3"> · <Clock at={c.at} /></span>
        </div>
      );
    }
    return (
      <div className={`rounded-lg border px-3 py-2 text-xs ${c.kind === "error" ? "border-danger/30 bg-danger/5 text-danger" : "border-warn/30 bg-warn/5 text-warn/90"}`}>
        <span className="mr-2 font-semibold">Nexus</span><span className="whitespace-pre-wrap"><RefText text={c.text} highlight={highlight} /></span>
        <span className="ml-2 text-fg-3"><Clock at={c.at} /></span>
      </div>
    );
  }
  return <Reply c={c} flat={flat} who={who} highlight={highlight} pinned={pinned} onPin={onPin} />;
}

/**
 * The line in the orchestrator's chat where it went on in a fresh session (its context care): how full the old
 * session's context was, and the summary it wrote, shown on demand; at the latest switch also the summary's file
 * (.nexus/orchestrator/summary.md, which holds the latest one), opened in the file viewer.
 */
function FreshSessionLine({ project, sw, latest }: { project: string; sw: EarlierSession["switch"]; latest: boolean }) {
  const [open, setOpen] = useState(false);
  const pct = sw.fill === null ? undefined : Math.round(sw.fill * 100);
  const link = "text-accent underline decoration-dotted underline-offset-2 hover:decoration-solid";
  return (
    <div role="separator" aria-label={t("chat.freshSession")} className="py-1 text-xs text-fg-3">
      <div className="flex items-center gap-3">
        <span className="h-px flex-1 bg-line-strong" />
        <span className="text-center font-semibold text-fg-2">{t("chat.freshSession")}</span>
        <span className="h-px flex-1 bg-line-strong" />
      </div>
      <div className="mt-1 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-center">
        <span>{pct === undefined ? t("chat.freshStarted") : typeof sw.tokens === "number" ? t("chat.freshTokens", { tokens: tokenCount(sw.tokens), pct }) : t("chat.freshFull", { pct })} · <Clock at={sw.at} /></span>
        {sw.summary
          ? <button onClick={() => setOpen(!open)} aria-expanded={open} className={`${link} max-lg:min-h-11`}>{open ? t("chat.freshHideSummary") : t("chat.freshShowSummary")}</button>
          : <span>{t("chat.freshNoSummary")}</span>}
        {sw.summary && latest && (
          <a href={fileHref(project, SUMMARY_FILE)} title={SUMMARY_FILE} className={`${link} max-lg:inline-flex max-lg:min-h-11 max-lg:items-center`}
            onClick={(e) => { if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey) return; e.preventDefault(); nav.file(SUMMARY_FILE); }}>{t("chat.freshFile")}</a>
        )}
      </div>
      {open && sw.summary && (
        <div className="mt-2 rounded-lg border border-line bg-surface-2 px-3 py-2 text-left text-sm text-fg">
          {/* Its lines as written (a summary is often one item a line): each line break kept. */}
          <ChatMarkdown>{withLineBreaks(sw.summary.text)}</ChatMarkdown>
          {sw.summary.topics.length > 0 && <div className="mt-1 text-xs text-fg-3">{t("chat.freshTopics", { topics: sw.summary.topics.join(", ") })}</div>}
          {sw.summary.files.length > 0 && <div className="text-xs text-fg-3">{t("chat.freshFiles", { files: sw.summary.files.join(", ") })}</div>}
        </div>
      )}
    </div>
  );
}

/**
 * A reply of the agent. A long one (messageTools.ts) has its Contents and "Jump to the questions" on its line: on a
 * desktop the line over it, which stays at the top while the reply is read; on the phone the line under the bubble,
 * which stays at the bottom.
 */
function Reply({ c, flat, who, highlight, pinned, onPin }: { c: ChatEntry; flat?: boolean; who: string; highlight: string; pinned?: boolean; onPin?: (pinned: boolean) => void }) {
  const message = useRef<HTMLDivElement>(null);
  const tools = useMemo(() => replyTools(c.text), [c.text]);
  const long = tools.contents.length > 0 || tools.questions !== undefined;
  const copy = <>
    <CopyButton text={messageSource(c)} label={t("chat.copy")} className={flat ? "opacity-0 group-hover/msg:opacity-100" : ""} />
    {onPin && <PinButton pinned={!!pinned} onPin={onPin} hoverOnly={flat} />}
  </>;
  if (flat) {
    return (
      <div ref={message} className="group/msg">
        <div className={`mb-1 flex min-h-6 flex-wrap items-center gap-x-1 text-xs text-fg-3 ${long ? "sticky top-0 z-[5] -mx-2 border-b border-line bg-canvas px-2 py-1" : ""}`}>
          <span className="mr-1">{who} · <Clock at={c.at} /></span>
          <ReplyTools message={message} contents={tools.contents} questions={tools.questions} />
          {copy}
        </div>
        <ChatMarkdown className="leading-relaxed" highlight={highlight}>{c.text}</ChatMarkdown>
      </div>
    );
  }
  return (
    <div ref={message} className="max-w-[92%]">
      <div className="rounded-2xl rounded-bl-sm bg-surface-3 px-4 py-2">
        <ChatMarkdown highlight={highlight}>{c.text}</ChatMarkdown>
      </div>
      <div className={`mt-0.5 flex flex-wrap items-center gap-x-0.5 pl-1 text-[11px] text-fg-3 ${long ? "sticky bottom-0 z-[5] bg-canvas py-1" : ""}`}>
        <span className="mr-1"><Clock at={c.at} /></span>
        <ReplyTools message={message} contents={tools.contents} questions={tools.questions} up />
        {copy}
      </div>
    </div>
  );
}

/**
 * Narrow: on the phone's tab the Ideas panel shows its list or one conversation at a time. On a desktop's middle
 * column the list and the open conversation sit side by side.
 */
const Side = createContext(false);

/** What a desktop's middle column header needs from App: the orchestrator's state, the number of ideas, its own buttons. */
export interface Desk {
  orchestrator: View | undefined;
  /** Conversations that are not archived, for "Ideas · N". */
  ideas: number | undefined;
  /** Unread on the switch (chatPlace.ts): messages in the orchestrator's chat, and whether a conversation has any. */
  unread: Unread;
  /** The column's buttons at the right: what waits, All queues. */
  tools: ReactNode;
}

/**
 * The header of a desktop's middle column (mockup 11A): the Orchestrator / Ideas switch, what the view says about
 * itself (the chat's state, its tool calls and ⋯), and the column's own buttons. The project's queues show it too,
 * with neither side of the switch on. A switch adds no history entry (layers.ts, switchTab).
 */
export function DeskHead({ which, desk, children }: { which?: "chat" | "ideas" | "stats"; desk: Desk; children?: ReactNode }) {
  const o = desk.orchestrator;
  const item = (p: "chat" | "ideas" | "stats", label: ReactNode) => (
    <button key={p} onClick={() => nav.tab(p)} aria-pressed={p === which}
      className={`flex items-center gap-1.5 rounded-md px-3 py-1 text-[13px] ${p === which ? "bg-surface-3 font-semibold text-fg" : "text-fg-2 hover:text-fg"}`}>{label}</button>
  );
  return (
    <header className="flex min-h-15 shrink-0 items-center gap-3 border-b border-line px-6 py-2.5">
      <div className="flex shrink-0 items-center gap-0.5 rounded-lg border border-line bg-surface-2 p-0.5" role="group" aria-label={t("desk.chats")}>
        {item("chat", <><span className={`h-2 w-2 rounded-full ${o?.state === "working" ? "animate-pulse bg-accent" : o?.session ? "bg-ok" : "bg-fg-3"}`} />{t("desk.orchestrator")}<UnreadMark n={desk.unread.chat} /></>)}
        {item("ideas", <>{t("desk.ideas")}{desk.ideas ? <span className="text-fg-3">· {desk.ideas}</span> : null}<UnreadMark n={desk.unread.ideas ? -1 : 0} /></>)}
        {item("stats", t("desk.stats"))}
      </div>
      {children}
      <span className="flex-1" />
      <SearchField />
      {desk.tools}
    </header>
  );
}

/** What is unread in a project's chats, for the switch and the phone's tabs. */
export interface Unread { chat: number; ideas: boolean }

/** An unread marker: the count of new messages ("Orchestrator (2)"), or a dot when only "something" is new (`n` < 0). */
function UnreadMark({ n }: { n: number }) {
  if (n === 0) return null;
  return n < 0
    ? <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" title={t("common.newMessagesTitle")} aria-label={t("common.newMessages")} />
    : <span className="grid h-4 min-w-4 shrink-0 place-items-center rounded-full bg-accent-strong px-1 text-[10.5px] font-semibold text-on-accent" title={t("common.newCount", { count: n })} aria-label={t("common.newCount", { count: n })}>{n}</span>;
}

/**
 * A chat's frame. On the phone (`inline`) it is the content of its tab: no panel row, since the bottom bar switches and
 * nothing closes it. On a desktop (`desk`) it is the middle column, under its header.
 */
function Panel({ inline, desk, which, head, children }: {
  inline?: boolean; desk?: Desk; which: "chat" | "ideas"; head?: ReactNode; children: ReactNode;
}) {
  if (inline || !desk) return <Side.Provider value={true}><div className="flex min-h-0 min-w-0 flex-1">{children}</div></Side.Provider>;
  return (
    <Side.Provider value={false}>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <DeskHead which={which} desk={desk}>{head}</DeskHead>
        <div className="flex min-h-0 flex-1">{children}</div>
      </div>
    </Side.Provider>
  );
}

const stateText = (v: View | undefined) =>
  t(v?.state === "working" ? "chat.working" : v?.session ? (v.state === "idle" ? "chat.ready" : "chat.asleep") : "chat.startsFirst");

// ---------------------------------------------------------------- the orchestrator

/** The orchestrator's chat: the phone's Orchestrator tab (`inline`), a desktop's middle column (`desk`). */
export function ChatPanel({ project, name, view, error, inline, desk }: {
  project: string; name: string; view: View | undefined; error?: string; inline?: boolean; desk?: Desk;
}) {
  const { reload: onChanged } = usePage();
  const [showTools, setShowTools] = useState(false);
  const showToolCalls = useCallback(() => setShowTools(true), []);
  const [searching, setSearching] = useState(false);
  const fresh: MenuEntry[] = view?.session ? [{
    label: t("chat.newConversationMenu"), onSelect: () => {
      if (confirm(t("chat.newConversationConfirm"))) {
        void act(project, "POST", "/orchestrator/reset").then(onChanged);
      }
    },
  }] : [];
  const menu: MenuEntry[] = [{ label: t("chat.showTools"), checked: showTools, onSelect: () => setShowTools(!showTools) }, ...fresh];
  // On a desktop the chat's state, "Tool calls" and ⋯ (New conversation) are in the column's header.
  const head = desk && <>
    <span className="min-w-0 truncate text-xs text-fg-3">{statusLine(view, stateText(view))}</span>
    {view?.session && <SearchButton open={searching} onToggle={() => setSearching(!searching)} />}
    <button onClick={() => setShowTools(!showTools)} aria-pressed={showTools}
      className={`shrink-0 rounded-md px-2.5 py-1 text-xs ${showTools ? "bg-surface-3 text-fg" : "text-fg-2 hover:bg-surface-3 hover:text-fg"}`}>{t("chat.toolCalls")}</button>
    {fresh.length > 0 && <Menu items={fresh} down label={t("chat.actions")} />}
  </>;
  return (
    <Panel inline={inline} desk={desk} which="chat" head={head}>
      <ChatColumn project={project}
        over={name} title={t("desk.orchestrator")} who={t("desk.orchestrator")} view={view} status={stateText(view)}
        ready={!!view && (!view.session || view.session.project === project)} error={error} place={placeKey(project, "orchestrator")} showTools={showTools} onNeedTools={showToolCalls} search={{ open: searching, set: setSearching }} menu={inline ? menu : undefined} bare={!!desk}
        empty={<>
          <p>{t("chat.orchestratorEmpty")}</p>
          <p className="mt-1 text-fg-3">{rich("chat.orchestratorEmptyNote", { nexus: <code key="nexus">nexus</code> })}</p>
        </>}
        draft={draftKey(project, "orchestrator")}
        placeholder={t("chat.orchestratorPlaceholder")}
        onSend={async (text) => { await act(project, "POST", "/orchestrator/messages", { text }); onChanged(); }}
        onStop={async () => { await act(project, "POST", "/orchestrator/stop"); onChanged(); }}
      />
    </Panel>
  );
}

// ---------------------------------------------------------------- conversations

interface ConversationItem extends SessionFile { state: string; last_at: string; messages: number }
/** `compact`: its runtime compacts a conversation on request (apps/server/src/conversations.ts): Compact is offered. */
interface ConversationView extends View { notes_dir: string | null; compact?: boolean; idea_context_error?: string }

/** The step a conversation is about, as a link back to it (it closes the Ideas panel and opens the step). */
function AboutStep({ project, c, className = "" }: { project: string; c: SessionFile; className?: string }) {
  if (!c.about) return null;
  if (c.about.idea) {
    const scope = c.about.idea;
    return <button className={`block max-w-full break-all text-left text-xs text-accent ${className}`} onClick={() => nav.closeThenOpen("conversation", `note:${scope.file}`)}>
      {t("ideas.chatScope")} · {scope.file}{scope.date ? `#${scope.date}` : ""}
    </button>;
  }
  const { queue, step } = c.about;
  return (
    <button onClick={(e) => { e.stopPropagation(); nav.closeThenItem("ideas", project, queue, step); }} title={t("chat.openStep")}
      className={`inline-flex max-w-full items-center gap-1 truncate rounded bg-surface-3 px-1.5 py-0.5 text-xs text-accent hover:bg-surface-4 ${className}`}>
      <span className="text-fg-3">{t("chat.aboutStep")}</span> <span className="font-mono">{queue}/{step}</span>
    </button>
  );
}

/**
 * "Chat about this" on a step: opens the step's latest conversation that is not archived, or starts one (the server
 * seeds it with the step's context at the first message); "New conversation" starts another. Below, the step's
 * conversations, each a link into it.
 */
export function StepChat({ project, queue, step }: { project: string; queue: string; step: string }) {
  const { version } = usePage();
  const list = useQuery<ConversationItem[]>(projectUrl(project, "/conversations"), version).data;
  const { busy, error, run } = useAction();
  const mine = (list ?? []).filter((c) => !c.archived && c.about?.queue === queue && c.about.step === step);
  const go = (fresh: boolean) => run(async () => {
    const open = fresh ? null : (await stepConversation(project, queue, step)).conversation;
    return open?.id ?? await newConversation(project, { queue, step });
  }, (id) => nav.conversation(id));
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <button onClick={() => void go(false)} disabled={busy} title={t("chat.aboutThisTitle")}
          className="flex items-center gap-1.5 rounded-md border border-line-strong px-2.5 py-1 text-sm text-fg hover:border-fg-3/60 hover:bg-surface-3 disabled:opacity-40 max-lg:min-h-11 max-lg:px-3.5">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
          {t("chat.aboutThis")}
        </button>
        {mine.length > 0 && (
          <button onClick={() => void go(true)} disabled={busy} className="rounded-md px-2 py-1 text-xs text-fg-2 hover:bg-surface-3 hover:text-fg disabled:opacity-40 max-lg:min-h-11 max-lg:px-3">
            {t("chat.newConversation")}
          </button>
        )}
      </div>
      {mine.length > 0 && (
        <ul className="mt-1.5 space-y-0.5">
          {mine.map((c) => (
            <li key={c.id}>
              <button onClick={() => nav.conversation(c.id)} className="flex max-w-full items-baseline gap-2 text-left text-xs text-fg-2 hover:text-fg">
                <span className="truncate text-accent">{c.title}</span>
                <span className="shrink-0 text-fg-3">{t("chat.messages", { count: c.messages })} · <TimeAgo at={c.last_at} /></span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="mt-1 text-xs text-danger">{error}</p>}
    </div>
  );
}

/** What the Ideas panel shows (IdeasPanelView), kept in the browser across visits. */
const IDEAS_VIEW = "nexus.ideas.view";
function useIdeasView(): [IdeasPanelView, (v: IdeasPanelView) => void] {
  const [view, setView] = useState<IdeasPanelView>(() => { try { return localStorage.getItem(IDEAS_VIEW) === "overview" ? "overview" : "conversations"; } catch { return "conversations"; } });
  return [view, (v) => { try { localStorage.setItem(IDEAS_VIEW, v); } catch { /* storage blocked: the choice lives as long as the view */ } setView(v); }];
}

/**
 * The Ideas panel: the conversations with a thinking partner, or the overview of their notes (components/Ideas.tsx),
 * on the phone's Ideas tab (`inline`) and a desktop's middle column (`desk`). An open conversation shows the
 * conversations; an open note (the layer note:<file>) the overview.
 */
export function ConversationsPanel({ project, name, defaultRuntime, inline, desk, areas = [] }: {
  project: string; name: string; defaultRuntime: "claude" | "codex"; inline?: boolean; desk?: Desk;
  /** The project's areas in its order (its tag list): the overview's groups follow it. */
  areas?: readonly string[];
}) {
  const at = useNav();
  const [stored, setStored] = useIdeasView();
  const noteOpen = layerValue(at, "note") !== undefined;
  const matching = layerValue(at, "matching") !== undefined;
  const conversationOpen = layerValue(at, "conversation") !== undefined;
  const view: IdeasPanelView = conversationOpen ? "conversations" : noteOpen || matching ? "overview" : stored;
  const pick = (v: IdeasPanelView) => {
    setStored(v);
    if (v === "conversations" && noteOpen) nav.close("note");
    if (v === "conversations" && matching) nav.close("matching");
    if (v === "overview" && conversationOpen) nav.close("conversation");
  };
  if (view === "overview") {
    return (
      <Panel inline={inline} desk={desk} which="ideas" head={desk && <IdeasSwitch view={view} onView={pick} />}>
        {matching
          ? <IdeasMatching project={project} phone={!desk} />
          : <IdeasOverview project={project} areas={areas} phone={!desk} top={!desk && <div className="mb-3"><IdeasSwitch view={view} onView={pick} wide /></div>} />}
      </Panel>
    );
  }
  return <Conversations project={project} name={name} defaultRuntime={defaultRuntime} inline={inline} desk={desk} switcher={(wide) => <IdeasSwitch view={view} onView={pick} wide={wide} />} />;
}

function Conversations({ project, name, defaultRuntime, inline, desk, switcher }: {
  project: string; name: string; defaultRuntime: "claude" | "codex"; inline?: boolean; desk?: Desk;
  /** The Ideas panel's switch (to the overview), in the column's header on a desktop, atop the list on the phone. */
  switcher: (wide: boolean) => ReactNode;
}) {
  const { reload: onChanged, version } = usePage();
  const { data: list, error: listError } = useQuery<ConversationItem[]>(projectUrl(project, "/conversations"), version);
  usePlaces(); // the list's unread dots follow each conversation's place
  // The open conversation (or the new-conversation form) is a layer above the panel: Back returns to the list.
  const layer = layerValue(useNav(), "conversation");
  const creating = layer === "new";
  const open = creating ? undefined : layer;
  const [showArchived, setShowArchived] = useState(false);
  const { data: view, error: viewError } = useQuery<ConversationView>(open ? projectUrl(project, `/conversations/${enc(open)}`) : undefined, version);
  // On the phone's tab the list or one conversation at a time; on a desktop both, side by side.
  const side = !desk;
  const current = list?.find((c) => c.id === open);
  const shown = (list ?? []).filter((c) => showArchived || !c.archived);
  const [showTools, setShowTools] = useState(false);
  const showToolCalls = useCallback(() => setShowTools(true), []);
  const [searching, setSearching] = useState(false);
  useEffect(() => setSearching(false), [open]);
  const efforts = useEfforts(current?.runtime === "codex" ? "codex" : "claude", current?.model ?? "");
  const patch = (body: unknown) => act(project, "PATCH", `/conversations/${enc(open!)}`, body).then(onChanged, (e: Error) => alert(e.message));
  // The menu of an open conversation: what its header had (Hand to orchestrator, More…) and the tool calls.
  const menu: MenuEntry[] | undefined = !creating && open && current ? [
    { label: t("chat.showTools"), checked: showTools, onSelect: () => setShowTools(!showTools) },
    {
      label: t("chat.handOff"), onSelect: () => {
        if (current.about?.idea) {
          const { file, date } = current.about.idea;
          nav.open(`idea-handoff:${JSON.stringify({ file, ...(date ? { date } : {}) })}`);
          return;
        }
        if (confirm(t("chat.handOffConfirm"))) {
          void act(project, "POST", `/conversations/${enc(open)}/handoff`).then(onChanged);
        }
      },
    },
    // Compact (queue CC3): only where the partner's runtime compacts on request.
    ...(view?.session?.id === open && view.compact ? [{
      label: t("chat.compact"), onSelect: () => {
        if (confirm(t("chat.compactConfirm"))) {
          void act(project, "POST", `/conversations/${enc(open)}/compact`).then(onChanged, (e: Error) => alert(e.message));
        }
      },
    }] : []),
    { label: t("chat.rename"), onSelect: () => { const title = prompt(t("chat.topic"), current.title); if (title) void patch({ title }); } },
    { label: t(current.archived ? "chat.unarchive" : "chat.archive"), onSelect: () => void patch({ archived: !current.archived }) },
    { heading: t("chat.effortHeading") },
    { label: t("run.default"), checked: !current.effort, onSelect: () => void patch({ effort: null }) },
    ...efforts.map((x) => ({ label: x, checked: current.effort === x, onSelect: () => void patch({ effort: x }) })),
  ] : undefined;

  return (
    <Panel inline={inline} desk={desk} which="ideas" head={desk && switcher(false)}>
      <nav className={side
        ? `${open || creating ? "hidden" : "flex"} w-full flex-col`
        : `${open || creating ? "hidden sm:flex" : "flex"} w-full shrink-0 flex-col border-r border-line sm:w-72`}>
        {side && (
          <div className="flex items-center gap-2 border-b border-line px-4 py-3">
            <div className="min-w-0 flex-1">
              <div className="text-xs text-fg-3">{name}</div>
              <h2 className="font-semibold text-fg">{t("desk.ideas")}</h2>
            </div>
          </div>
        )}
        {side && <div className="px-3 pt-3">{switcher(true)}</div>}
        <div className="p-3"><Button onClick={() => nav.open("conversation:new")}>{t("chat.newConversation")}</Button></div>
        <ul className="scroll-thin flex-1 overflow-y-auto px-2 pb-3">
          {shown.map((c) => (
            <li key={c.id}>
              <button onClick={() => nav.open(`conversation:${c.id}`)}
                className={`w-full rounded-lg px-3 py-2 text-left text-sm ${c.id === open ? "bg-surface-3 text-fg" : "text-fg hover:bg-surface-3/60"} ${c.archived ? "opacity-50" : ""}`}>
                <span className="flex items-center gap-2">
                  {c.state === "working" && <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-accent" />}
                  {c.id !== open && hasUnread(c.last_at, readPlace(placeKey(project, "conversation", c.id))?.seen) && <UnreadMark n={-1} />}
                  <span className={c.about?.idea ? "min-w-0 break-words" : "truncate"}>{c.title}</span>
                </span>
                <span className="block break-all text-xs text-fg-3">{c.about && <span className="font-mono text-accent/80">{c.about.idea ? `${c.about.idea.file}${c.about.idea.date ? `#${c.about.idea.date}` : ""}` : `${c.about.queue}/${c.about.step}`} · </span>}{c.runtime} · {t("chat.messages", { count: c.messages })} · <TimeAgo at={c.last_at} /></span>
              </button>
            </li>
          ))}
          {list && shown.length === 0 && <li className="px-3 py-2 text-sm text-fg-3">{t("chat.noConversation")}</li>}
          {!list && listError && <li className="px-3 py-2"><ReadError error={listError} /></li>}
        </ul>
        {(list ?? []).some((c) => c.archived) && (
          <label className="flex items-center gap-2 border-t border-line px-4 py-2 text-xs text-fg-3">
            <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} className="accent-accent" /> {t("chat.showArchived")}
          </label>
        )}
      </nav>

      {creating && <NewConversation project={project} defaultRuntime={defaultRuntime} onBack={() => nav.close("conversation")}
        onCreated={(id) => { nav.open(`conversation:${id}`); onChanged(); }} />}
      {!creating && open && current && (
        <ChatColumn key={open} project={project}
          wrapTitle={!!current.about?.idea}
          ready={view?.session?.id === open} error={viewError} place={placeKey(project, "conversation", open)}
          over={t("chat.ideasOf", { project: name })} title={current.title ?? t("chat.conversation")} who={t("chat.partner")} about={<>
            <AboutStep project={project} c={current} className="mt-1" />
            {view?.idea_context_error && <p role="alert" className="mt-2 text-xs text-warn">{view.idea_context_error}</p>}
            {current.about?.idea && current.archived && <p className="mt-2 text-xs text-warn">{t("ideas.chatArchived")}</p>}
          </>} view={view} status={stateText(view)} onBack={() => nav.close("conversation")}
          showTools={showTools} onNeedTools={showToolCalls} menu={menu} search={{ open: searching, set: setSearching }}
          empty={<>
            <p>{t("chat.ideasEmpty")}</p>
            <p className="mt-1 text-fg-3">
              {view?.notes_dir ? rich("chat.partnerNotes", { folder: <code key="folder">{view.notes_dir}</code> }) : t("chat.partnerNoNotes")}
            </p>
          </>}
          draft={draftKey(project, "conversation", open)}
          placeholder={t("chat.ideasPlaceholder")}
          onSend={async (text) => { await act(project, "POST", `/conversations/${enc(open)}/messages`, { text }); onChanged(); }}
          onStop={async () => { await act(project, "POST", `/conversations/${enc(open)}/stop`); onChanged(); }}
        />
      )}
      {!side && !creating && !open && (
        <div className="hidden flex-1 flex-col items-center justify-center p-8 text-center text-sm text-fg-3 sm:flex">
          <p>{t("chat.openOrStart")}</p>
          <p className="mt-1 text-fg-3">{t("chat.ownSession")}</p>
        </div>
      )}
    </Panel>
  );
}

function NewConversation({ project, defaultRuntime, onBack, onCreated }: {
  project: string; defaultRuntime: "claude" | "codex"; onBack: () => void; onCreated: (id: string) => void;
}) {
  const [title, setTitle] = useState("");
  const [runtime, setRuntime] = useState(defaultRuntime);
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [error, setError] = useState<string>();
  const field = "w-full rounded-md border border-line-strong bg-canvas px-2 py-1.5 text-sm text-fg placeholder:text-fg-3";
  const create = async () => {
    setError(undefined);
    try { onCreated(await newConversation(project, { title, runtime, model: model || undefined, effort: effort || undefined })); }
    catch (e) { setError((e as Error).message); }
  };
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <header className="flex items-center gap-2 border-b border-line px-5 py-3">
        <button onClick={onBack} className={`rounded-md px-1.5 text-lg text-fg-2 hover:text-fg ${useContext(Side) ? "" : "sm:hidden"}`} aria-label={t("common.back")}>‹</button>
        <h2 className="flex-1 font-semibold text-fg">{t("chat.newConversation")}</h2>
      </header>
      <div className="max-w-lg space-y-3 p-5">
        <label className="block text-sm text-fg">{t("chat.topic")}
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t("chat.topicPlaceholder")} autoFocus className={`mt-1 ${field}`} />
        </label>
        <div className="flex flex-wrap gap-3">
          <label className="text-sm text-fg">{t("run.field.runtime")}
            <select value={runtime} onChange={(e) => { setRuntime(e.target.value as "claude" | "codex"); setModel(""); setEffort(""); }} className={`mt-1 ${field}`}>
              <option value="claude">Claude Code</option><option value="codex">Codex</option>
            </select>
          </label>
          <label className="text-sm text-fg">{t("run.field.model")}
            <span className="mt-1 block"><ModelSelect runtime={runtime} value={model} onChange={setModel} className="py-1.5" /></span>
          </label>
          <label className="text-sm text-fg">{t("run.field.effort")}
            <span className="mt-1 block"><EffortSelect runtime={runtime} model={model} value={effort} onChange={setEffort} className="py-1.5" /></span>
          </label>
        </div>
        <Button onClick={() => void create()}>{t("run.start")}</Button>
        {error && <p className="text-sm text-danger">{error}</p>}
      </div>
    </div>
  );
}
