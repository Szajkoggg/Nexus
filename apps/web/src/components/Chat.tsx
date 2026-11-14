// Chats: the project's orchestrator, and conversations with a thinking partner.
import { createContext, useCallback, useContext, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { ChatEntry, RuntimeFile, SessionFile } from "@nexus/protocol";
import { act, enc, useFetch } from "../api.ts";
import { Button, Composer, Menu, TimeAgo, type MenuEntry } from "./ui.tsx";
import { ChatMarkdown, RefText } from "./Refs.tsx";
import { draftKey, putDraftAndFocus, readDraft } from "../drafts.ts";
import { withQuote } from "../quote.ts";
import { QuoteSelection, QuoteTarget } from "./Quote.tsx";
import { layerValue } from "../layers.ts";
import { nav, useNav } from "../nav.ts";
import { usePhone } from "../phone.ts";
import { firstUnread, hasUnread, opening, placeKey, readPlace, seenUpTo, unreadCount, usePlaces, writePlace } from "../chatPlace.ts";
import { EffortSelect, ModelSelect, useEfforts } from "./Settings.tsx";
import { rich, t } from "../i18n.ts";
import { SentPictures, filesOf, usePictures } from "./Pictures.tsx";
import { splitPictures, withPictures } from "../pictures.ts";

interface View { session: SessionFile | null; state: "working" | "idle" | "exited"; runtime: RuntimeFile | null; chat: ChatEntry[]; model: string | null; effort: string | null }

export function useOrchestrator(project: string | undefined, version: unknown) {
  return useFetch<View>(project ? `/api/projects/${enc(project)}/orchestrator` : undefined, version);
}

/** A chat: what it is (its header; on a desktop's orchestrator chat, in the middle column's header), the messages, and the composer. */
function ChatColumn({ project, title, over, who, about, view, ready, place, status, showTools, menu, empty, draft, placeholder, onSend, onBack, bare }: {
  /** The project: where pictures are uploaded, and served from. */
  project: string;
  title: string; over: string;
  /** The view holds this chat (not the one shown before it, still there while this one loads). */
  ready: boolean;
  /** Where its place is kept (chatPlace.ts, placeKey). */
  place: string;
  /** Who answers, over each of its messages on a desktop: "Orchestrator", "Partner". */
  who: string; about?: ReactNode; view: View | undefined; status: string; showTools: boolean; empty: ReactNode;
  draft: string; placeholder: string; onSend: (text: string) => Promise<void>; onBack?: () => void;
  /** The chat's menu, at the right of its header. */
  menu?: MenuEntry[];
  /** No header of its own: the desktop's orchestrator chat, whose state is in the middle column's header. */
  bare?: boolean;
}) {
  const side = useContext(Side);
  const phone = usePhone();
  const full = ready ? view?.chat ?? [] : [];
  const shown = full.map((c, i) => ({ c, i })).filter(({ c }) => showTools || c.kind !== "tool");
  const p = usePlace(place, full, ready, showTools, view?.state);
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
            <h2 className="truncate font-semibold text-fg">{title}</h2>
            {about}
          </div>
          <span className="text-xs text-fg-3">{statusLine(view, status)}</span>
          {menu && <span className="ml-auto"><Menu items={menu} down label={t("chat.actions")} /></span>}
        </header>
      )}
      <QuoteTarget.Provider value={quote}>
      <QuoteSelection scroller={p.scroller} />
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div ref={p.scroller} onScroll={p.onScroll} data-chat-scroll={place} className={`scroll-thin flex-1 overflow-y-auto ${phone ? "px-5 py-4" : "px-6 py-6"}`}>
          <div className={`${measure} ${phone ? "space-y-3" : "space-y-4"}`}>
            {ready && shown.length === 0 && <div className="mt-10 text-center text-sm text-fg-3">{empty}</div>}
            {shown.map(({ c, i }) => <div key={i} data-i={i}><Entry c={c} flat={!phone} who={who} project={project} /></div>)}
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
          <Composer rows={3} draft={draft} placeholder={placeholder} button={t("details.send")} oneLine={phone} card={!phone} pictures={pictures}
            onSubmit={async (text) => { p.follow(); await onSend(withPictures(text, pictures.paths)); pictures.clear(); }} />
        </div>
      </footer>
    </div>
  );
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

/** What a chat's session is doing, its model, effort and how full its context is: "ready · opus-5-5 · 38% context". */
function statusLine(view: View | undefined, status: string): string {
  const rt = view?.runtime;
  const pct = rt?.context_tokens && rt.context_window ? Math.round((100 * rt.context_tokens) / rt.context_window) : undefined;
  const model = rt?.model ? rt.model.replace(/^claude-/, "") : view?.model;
  return `${status}${model ? ` · ${model}` : ""}${view?.effort ? ` · ${t("run.effort", { effort: view.effort })}` : ""}${pct !== undefined ? ` · ${t("chat.context", { pct })}` : ""}`;
}

/**
 * One entry of a chat. On the phone the other side's messages are bubbles; on a desktop (`flat`, mockup 11A) they are
 * text in the column under a line saying who and when, Nexus's notices a line with a rule at the left.
 */
function Entry({ c, flat, who, project }: { c: ChatEntry; flat?: boolean; who: string; project: string }) {
  if (c.kind === "tool") {
    return <div className="truncate pl-1 font-mono text-[11px] text-fg-3" title={c.text}>{flat ? "$" : "›"} {c.text}</div>;
  }
  if (c.from === "user") {
    // Its pictures' paths show as the pictures, below its text (a message of pictures alone has no bubble).
    const { text, pictures } = splitPictures(c.text);
    return (
      <div className="flex flex-col items-end">
        {text && <div className={`whitespace-pre-wrap rounded-2xl rounded-br-sm bg-user-bubble px-4 py-2 text-sm text-fg ${flat ? "max-w-[min(85%,37.5rem)]" : "max-w-[85%]"}`}><RefText text={text} /></div>}
        {pictures.length > 0 && <div className={flat ? "max-w-[min(85%,37.5rem)]" : "max-w-[85%]"}><SentPictures project={project} paths={pictures} /></div>}
      </div>
    );
  }
  if (c.from === "nexus") {
    if (flat) {
      return (
        <div className={`border-l-2 px-2.5 py-0.5 text-xs ${c.kind === "error" ? "border-danger/60 text-danger" : "border-line-strong text-fg-2"}`}>
          <span className="whitespace-pre-wrap">Nexus · <RefText text={c.text} /></span><span className="text-fg-3"> · <TimeAgo at={c.at} /></span>
        </div>
      );
    }
    return (
      <div className={`rounded-lg border px-3 py-2 text-xs ${c.kind === "error" ? "border-danger/30 bg-danger/5 text-danger" : "border-warn/30 bg-warn/5 text-warn/90"}`}>
        <span className="mr-2 font-semibold">Nexus</span><span className="whitespace-pre-wrap"><RefText text={c.text} /></span>
        <span className="ml-2 text-fg-3"><TimeAgo at={c.at} /></span>
      </div>
    );
  }
  if (flat) {
    return (
      <div>
        <div className="mb-1 text-xs text-fg-3">{who} · <TimeAgo at={c.at} /></div>
        <ChatMarkdown className="leading-relaxed">{c.text}</ChatMarkdown>
      </div>
    );
  }
  return (
    <div className="max-w-[92%] rounded-2xl rounded-bl-sm bg-surface-3 px-4 py-2">
      <ChatMarkdown>{c.text}</ChatMarkdown>
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
export function DeskHead({ which, desk, children }: { which?: "chat" | "ideas"; desk: Desk; children?: ReactNode }) {
  const o = desk.orchestrator;
  const item = (p: "chat" | "ideas", label: ReactNode) => (
    <button key={p} onClick={() => nav.tab(p)} aria-pressed={p === which}
      className={`flex items-center gap-1.5 rounded-md px-3 py-1 text-[13px] ${p === which ? "bg-surface-3 font-semibold text-fg" : "text-fg-2 hover:text-fg"}`}>{label}</button>
  );
  return (
    <header className="flex min-h-15 shrink-0 items-center gap-3 border-b border-line px-6 py-2.5">
      <div className="flex shrink-0 items-center gap-0.5 rounded-lg border border-line bg-surface-2 p-0.5" role="group" aria-label={t("desk.chats")}>
        {item("chat", <><span className={`h-2 w-2 rounded-full ${o?.state === "working" ? "animate-pulse bg-accent" : o?.session ? "bg-ok" : "bg-fg-3"}`} />{t("desk.orchestrator")}<UnreadMark n={desk.unread.chat} /></>)}
        {item("ideas", <>{t("desk.ideas")}{desk.ideas ? <span className="text-fg-3">· {desk.ideas}</span> : null}<UnreadMark n={desk.unread.ideas ? -1 : 0} /></>)}
      </div>
      {children}
      <span className="flex-1" />
      {desk.tools}
    </header>
  );
}

/** What is unread in a project's chats, for the switch and the phone's tabs. */
export interface Unread { chat: number; ideas: boolean }

/** An unread marker: the count of new messages ("Orchestrator (2)"), or a dot when only "something" is new (`n` < 0). */
export function UnreadMark({ n }: { n: number }) {
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
export function ChatPanel({ project, name, view, onChanged, inline, desk }: {
  project: string; name: string; view: View | undefined; onChanged: () => void; inline?: boolean; desk?: Desk;
}) {
  const [showTools, setShowTools] = useState(false);
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
    <button onClick={() => setShowTools(!showTools)} aria-pressed={showTools}
      className={`shrink-0 rounded-md px-2.5 py-1 text-xs ${showTools ? "bg-surface-3 text-fg" : "text-fg-2 hover:bg-surface-3 hover:text-fg"}`}>{t("chat.toolCalls")}</button>
    {fresh.length > 0 && <Menu items={fresh} down label={t("chat.actions")} />}
  </>;
  return (
    <Panel inline={inline} desk={desk} which="chat" head={head}>
      <ChatColumn project={project}
        over={name} title={t("desk.orchestrator")} who={t("desk.orchestrator")} view={view} status={stateText(view)}
        ready={!!view && (!view.session || view.session.project === project)} place={placeKey(project, "orchestrator")} showTools={showTools} menu={inline ? menu : undefined} bare={!!desk}
        empty={<>
          <p>{t("chat.orchestratorEmpty")}</p>
          <p className="mt-1 text-fg-3">{rich("chat.orchestratorEmptyNote", { nexus: <code key="nexus">nexus</code> })}</p>
        </>}
        draft={draftKey(project, "orchestrator")}
        placeholder={t("chat.orchestratorPlaceholder")}
        onSend={async (text) => { await act(project, "POST", "/orchestrator/messages", { text }); onChanged(); }}
      />
    </Panel>
  );
}

// ---------------------------------------------------------------- conversations

interface ConversationItem extends SessionFile { state: string; last_at: string; messages: number }
interface ConversationView extends View { notes_dir: string | null }

/** The step a conversation is about, as a link back to it (it closes the Ideas panel and opens the step). */
function AboutStep({ project, c, className = "" }: { project: string; c: SessionFile; className?: string }) {
  if (!c.about) return null;
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
export function StepChat({ project, queue, step, version }: { project: string; queue: string; step: string; version: unknown }) {
  const list = useFetch<ConversationItem[]>(`/api/projects/${enc(project)}/conversations`, version);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const mine = (list ?? []).filter((c) => !c.archived && c.about?.queue === queue && c.about.step === step);
  const go = async (fresh: boolean) => {
    setBusy(true); setError(undefined);
    try {
      if (!fresh) {
        const r = await fetch(`/api/projects/${enc(project)}/queues/${enc(queue)}/steps/${enc(step)}/conversation`);
        const j = await r.json() as { conversation: { id: string } | null };
        if (j.conversation) { nav.conversation(j.conversation.id); return; }
      }
      const r = await fetch(`/api/projects/${enc(project)}/conversations`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ queue, step }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? r.statusText);
      nav.conversation(j.result.id as string);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
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

/** The conversations with a thinking partner: the phone's Ideas tab (`inline`), a desktop's middle column (`desk`). */
export function ConversationsPanel({ project, name, version, onChanged, defaultRuntime, inline, desk }: {
  project: string; name: string; version: unknown; onChanged: () => void; defaultRuntime: "claude" | "codex"; inline?: boolean; desk?: Desk;
}) {
  const list = useFetch<ConversationItem[]>(`/api/projects/${enc(project)}/conversations`, version);
  usePlaces(); // the list's unread dots follow each conversation's place
  // The open conversation (or the new-conversation form) is a layer above the panel: Back returns to the list.
  const layer = layerValue(useNav(), "conversation");
  const creating = layer === "new";
  const open = creating ? undefined : layer;
  const [showArchived, setShowArchived] = useState(false);
  const view = useFetch<ConversationView>(open ? `/api/projects/${enc(project)}/conversations/${enc(open)}` : undefined, version);
  // On the phone's tab the list or one conversation at a time; on a desktop both, side by side.
  const side = !desk;
  const current = list?.find((c) => c.id === open);
  const shown = (list ?? []).filter((c) => showArchived || !c.archived);
  const [showTools, setShowTools] = useState(false);
  const efforts = useEfforts(current?.runtime === "codex" ? "codex" : "claude", current?.model ?? "");
  const patch = (body: unknown) => act(project, "PATCH", `/conversations/${enc(open!)}`, body).then(onChanged, (e: Error) => alert(e.message));
  // The menu of an open conversation: what its header had (Hand to orchestrator, More…) and the tool calls.
  const menu: MenuEntry[] | undefined = !creating && open && current ? [
    { label: t("chat.showTools"), checked: showTools, onSelect: () => setShowTools(!showTools) },
    {
      label: t("chat.handOff"), onSelect: () => {
        if (confirm(t("chat.handOffConfirm"))) {
          void act(project, "POST", `/conversations/${enc(open)}/handoff`).then(onChanged);
        }
      },
    },
    { label: t("chat.rename"), onSelect: () => { const title = prompt(t("chat.topic"), current.title); if (title) void patch({ title }); } },
    { label: t(current.archived ? "chat.unarchive" : "chat.archive"), onSelect: () => void patch({ archived: !current.archived }) },
    { heading: t("chat.effortHeading") },
    { label: t("run.default"), checked: !current.effort, onSelect: () => void patch({ effort: null }) },
    ...efforts.map((x) => ({ label: x, checked: current.effort === x, onSelect: () => void patch({ effort: x }) })),
  ] : undefined;

  return (
    <Panel inline={inline} desk={desk} which="ideas">
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
        <div className="p-3"><Button onClick={() => nav.open("conversation:new")}>{t("chat.newConversation")}</Button></div>
        <ul className="scroll-thin flex-1 overflow-y-auto px-2 pb-3">
          {shown.map((c) => (
            <li key={c.id}>
              <button onClick={() => nav.open(`conversation:${c.id}`)}
                className={`w-full rounded-lg px-3 py-2 text-left text-sm ${c.id === open ? "bg-surface-3 text-fg" : "text-fg hover:bg-surface-3/60"} ${c.archived ? "opacity-50" : ""}`}>
                <span className="flex items-center gap-2">
                  {c.state === "working" && <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-accent" />}
                  {c.id !== open && hasUnread(c.last_at, readPlace(placeKey(project, "conversation", c.id))?.seen) && <UnreadMark n={-1} />}
                  <span className="truncate">{c.title}</span>
                </span>
                <span className="block text-xs text-fg-3">{c.about && <span className="font-mono text-accent/80">{c.about.queue}/{c.about.step} · </span>}{c.runtime} · {t("chat.messages", { count: c.messages })} · <TimeAgo at={c.last_at} /></span>
              </button>
            </li>
          ))}
          {list && shown.length === 0 && <li className="px-3 py-2 text-sm text-fg-3">{t("chat.noConversation")}</li>}
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
          ready={view?.session?.id === open} place={placeKey(project, "conversation", open)}
          over={t("chat.ideasOf", { project: name })} title={current.title ?? t("chat.conversation")} who={t("chat.partner")} about={<AboutStep project={project} c={current} className="mt-1" />} view={view} status={stateText(view)} onBack={() => nav.close("conversation")}
          showTools={showTools} menu={menu}
          empty={<>
            <p>{t("chat.ideasEmpty")}</p>
            <p className="mt-1 text-fg-3">
              {view?.notes_dir ? rich("chat.partnerNotes", { folder: <code key="folder">{view.notes_dir}</code> }) : t("chat.partnerNoNotes")}
            </p>
          </>}
          draft={draftKey(project, "conversation", open)}
          placeholder={t("chat.ideasPlaceholder")}
          onSend={async (text) => { await act(project, "POST", `/conversations/${enc(open)}/messages`, { text }); onChanged(); }}
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
    const r = await fetch(`/api/projects/${enc(project)}/conversations`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ title, runtime, model: model || undefined, effort: effort || undefined }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { setError(j.error ?? r.statusText); return; }
    onCreated(j.result.id as string);
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
