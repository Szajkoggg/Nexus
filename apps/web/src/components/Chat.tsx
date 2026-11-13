// Chats: the project's orchestrator, and conversations with a thinking partner.
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { ChatEntry, RuntimeFile, SessionFile } from "@nexus/protocol";
import { act, enc, useFetch } from "../api.ts";
import { Button, Composer, Menu, TimeAgo, type MenuEntry } from "./ui.tsx";
import { ChatMarkdown, RefText } from "./Refs.tsx";
import { draftKey } from "../drafts.ts";
import { layerValue } from "../layers.ts";
import { nav, useNav } from "../nav.ts";
import { usePhone } from "../phone.ts";
import { EffortSelect, ModelSelect, useEfforts } from "./Settings.tsx";

interface View { session: SessionFile | null; state: "working" | "idle" | "exited"; runtime: RuntimeFile | null; chat: ChatEntry[]; model: string | null; effort: string | null }

export function useOrchestrator(project: string | undefined, version: unknown) {
  return useFetch<View>(project ? `/api/projects/${enc(project)}/orchestrator` : undefined, version);
}

/** A chat: what it is (its header; on a desktop's orchestrator chat, in the middle column's header), the messages, and the composer. */
function ChatColumn({ title, over, who, about, view, status, showTools, menu, empty, draft, placeholder, onSend, onBack, bare }: {
  title: string; over: string;
  /** Who answers, over each of its messages on a desktop: "Orchestrator", "Partner". */
  who: string; about?: ReactNode; view: View | undefined; status: string; showTools: boolean; empty: ReactNode;
  draft: string; placeholder: string; onSend: (text: string) => Promise<void>; onBack?: () => void;
  /** The chat's menu, at the right of its header. */
  menu?: MenuEntry[];
  /** No header of its own: the desktop's orchestrator chat, whose state is in the middle column's header. */
  bare?: boolean;
}) {
  const end = useRef<HTMLDivElement>(null);
  const side = useContext(Side);
  const phone = usePhone();
  const chat = (view?.chat ?? []).filter((c) => showTools || c.kind !== "tool");
  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [chat.length, view?.state]);
  // On a desktop the text keeps a chat app's measure: a column of about 780 px in the middle.
  const measure = phone ? "" : "mx-auto w-full max-w-[48.75rem]";
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {!bare && (
        <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-5 py-3">
          {onBack && <button onClick={onBack} className={`rounded-md px-1.5 text-lg text-fg-2 hover:text-fg ${side ? "" : "sm:hidden"}`} aria-label="Back">‹</button>}
          <div className="min-w-0">
            <div className="text-xs text-fg-3">{over}</div>
            <h2 className="truncate font-semibold text-fg">{title}</h2>
            {about}
          </div>
          <span className="text-xs text-fg-3">{statusLine(view, status)}</span>
          {menu && <span className="ml-auto"><Menu items={menu} down label="Chat actions" /></span>}
        </header>
      )}
      <div className={`scroll-thin flex-1 overflow-y-auto ${phone ? "px-5 py-4" : "px-6 py-6"}`}>
        <div className={`${measure} ${phone ? "space-y-3" : "space-y-4"}`}>
          {chat.length === 0 && <div className="mt-10 text-center text-sm text-fg-3">{empty}</div>}
          {chat.map((c, i) => <Entry key={i} c={c} flat={!phone} who={who} />)}
          {view?.state === "working" && <div className="text-xs text-fg-3"><span className="animate-pulse">●</span> working…</div>}
          <div ref={end} />
        </div>
      </div>
      <footer className={phone ? "border-t border-line p-3" : "px-6 pb-5 pt-3"}>
        <div className={measure}>
          <Composer rows={3} draft={draft} placeholder={placeholder} button="Send" onSubmit={onSend} oneLine={phone} card={!phone} />
        </div>
      </footer>
    </div>
  );
}

/** What a chat's session is doing, its model, effort and how full its context is: "ready · opus-5-5 · 38% context". */
function statusLine(view: View | undefined, status: string): string {
  const rt = view?.runtime;
  const pct = rt?.context_tokens && rt.context_window ? Math.round((100 * rt.context_tokens) / rt.context_window) : undefined;
  const model = rt?.model ? rt.model.replace(/^claude-/, "") : view?.model;
  return `${status}${model ? ` · ${model}` : ""}${view?.effort ? ` · ${view.effort} effort` : ""}${pct !== undefined ? ` · ${pct}% context` : ""}`;
}

/**
 * One entry of a chat. On the phone the other side's messages are bubbles; on a desktop (`flat`, mockup 11A) they are
 * text in the column under a line saying who and when, Nexus's notices a line with a rule at the left.
 */
function Entry({ c, flat, who }: { c: ChatEntry; flat?: boolean; who: string }) {
  if (c.kind === "tool") {
    return <div className="truncate pl-1 font-mono text-[11px] text-fg-3" title={c.text}>{flat ? "$" : "›"} {c.text}</div>;
  }
  if (c.from === "user") {
    return (
      <div className="flex justify-end">
        <div className={`whitespace-pre-wrap rounded-2xl rounded-br-sm bg-user-bubble px-4 py-2 text-sm text-fg ${flat ? "max-w-[min(85%,37.5rem)]" : "max-w-[85%]"}`}><RefText text={c.text} /></div>
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
      <div className="flex shrink-0 items-center gap-0.5 rounded-lg border border-line bg-surface-2 p-0.5" role="group" aria-label="Chats">
        {item("chat", <><span className={`h-2 w-2 rounded-full ${o?.state === "working" ? "animate-pulse bg-accent" : o?.session ? "bg-ok" : "bg-fg-3"}`} />Orchestrator</>)}
        {item("ideas", <>Ideas{desk.ideas ? <span className="text-fg-3">· {desk.ideas}</span> : null}</>)}
      </div>
      {children}
      <span className="flex-1" />
      {desk.tools}
    </header>
  );
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
  v?.state === "working" ? "working…" : v?.session ? (v.state === "idle" ? "ready" : "asleep: wakes with your next message") : "starts with your first message";

// ---------------------------------------------------------------- the orchestrator

/** The orchestrator's chat: the phone's Orchestrator tab (`inline`), a desktop's middle column (`desk`). */
export function ChatPanel({ project, name, view, onChanged, inline, desk }: {
  project: string; name: string; view: View | undefined; onChanged: () => void; inline?: boolean; desk?: Desk;
}) {
  const [showTools, setShowTools] = useState(false);
  const fresh: MenuEntry[] = view?.session ? [{
    label: "New conversation…", onSelect: () => {
      if (confirm("Start a new conversation? The orchestrator forgets this one (its transcript stays on disk).")) {
        void act(project, "POST", "/orchestrator/reset").then(onChanged);
      }
    },
  }] : [];
  const menu: MenuEntry[] = [{ label: "Show tool calls", checked: showTools, onSelect: () => setShowTools(!showTools) }, ...fresh];
  // On a desktop the chat's state, "Tool calls" and ⋯ (New conversation) are in the column's header.
  const head = desk && <>
    <span className="min-w-0 truncate text-xs text-fg-3">{statusLine(view, stateText(view))}</span>
    <button onClick={() => setShowTools(!showTools)} aria-pressed={showTools}
      className={`shrink-0 rounded-md px-2.5 py-1 text-xs ${showTools ? "bg-surface-3 text-fg" : "text-fg-2 hover:bg-surface-3 hover:text-fg"}`}>Tool calls</button>
    {fresh.length > 0 && <Menu items={fresh} down label="Chat actions" />}
  </>;
  return (
    <Panel inline={inline} desk={desk} which="chat" head={head}>
      <ChatColumn
        over={name} title="Orchestrator" who="Orchestrator" view={view} status={stateText(view)} showTools={showTools} menu={inline ? menu : undefined} bare={!!desk}
        empty={<>
          <p>Plan queues with the orchestrator, ask where things stand, or have it start a run.</p>
          <p className="mt-1 text-fg-3">It reads the project and works through <code>nexus</code>; it never edits files or approves queues.</p>
        </>}
        draft={draftKey(project, "orchestrator")}
        placeholder="Message the orchestrator…"
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
    <button onClick={(e) => { e.stopPropagation(); nav.closeThenItem("ideas", project, queue, step); }} title="Open the step"
      className={`inline-flex max-w-full items-center gap-1 truncate rounded bg-surface-3 px-1.5 py-0.5 text-xs text-accent hover:bg-surface-4 ${className}`}>
      <span className="text-fg-3">about step</span> <span className="font-mono">{queue}/{step}</span>
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
        <button onClick={() => void go(false)} disabled={busy} title="Talk this step through with a thinking partner; nothing changes in the run"
          className="flex items-center gap-1.5 rounded-md border border-line-strong px-2.5 py-1 text-sm text-fg hover:border-fg-3/60 hover:bg-surface-3 disabled:opacity-40 max-lg:min-h-11 max-lg:px-3.5">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
          Chat about this
        </button>
        {mine.length > 0 && (
          <button onClick={() => void go(true)} disabled={busy} className="rounded-md px-2 py-1 text-xs text-fg-2 hover:bg-surface-3 hover:text-fg disabled:opacity-40 max-lg:min-h-11 max-lg:px-3">
            New conversation
          </button>
        )}
      </div>
      {mine.length > 0 && (
        <ul className="mt-1.5 space-y-0.5">
          {mine.map((c) => (
            <li key={c.id}>
              <button onClick={() => nav.conversation(c.id)} className="flex max-w-full items-baseline gap-2 text-left text-xs text-fg-2 hover:text-fg">
                <span className="truncate text-accent">{c.title}</span>
                <span className="shrink-0 text-fg-3">{c.messages} message{c.messages === 1 ? "" : "s"} · <TimeAgo at={c.last_at} /></span>
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
    { label: "Show tool calls", checked: showTools, onSelect: () => setShowTools(!showTools) },
    {
      label: "Hand to orchestrator…", onSelect: () => {
        if (confirm("Hand this conversation to the orchestrator? The partner writes a summary (decisions, open questions, proposed work), which goes into the orchestrator's chat.")) {
          void act(project, "POST", `/conversations/${enc(open)}/handoff`).then(onChanged);
        }
      },
    },
    { label: "Rename…", onSelect: () => { const t = prompt("Topic", current.title); if (t) void patch({ title: t }); } },
    { label: current.archived ? "Unarchive" : "Archive", onSelect: () => void patch({ archived: !current.archived }) },
    { heading: "Effort (from the next message)" },
    { label: "default", checked: !current.effort, onSelect: () => void patch({ effort: null }) },
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
              <h2 className="font-semibold text-fg">Ideas</h2>
            </div>
          </div>
        )}
        <div className="p-3"><Button onClick={() => nav.open("conversation:new")}>New conversation</Button></div>
        <ul className="scroll-thin flex-1 overflow-y-auto px-2 pb-3">
          {shown.map((c) => (
            <li key={c.id}>
              <button onClick={() => nav.open(`conversation:${c.id}`)}
                className={`w-full rounded-lg px-3 py-2 text-left text-sm ${c.id === open ? "bg-surface-3 text-fg" : "text-fg hover:bg-surface-3/60"} ${c.archived ? "opacity-50" : ""}`}>
                <span className="flex items-center gap-2">
                  {c.state === "working" && <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-accent" />}
                  <span className="truncate">{c.title}</span>
                </span>
                <span className="block text-xs text-fg-3">{c.about && <span className="font-mono text-accent/80">{c.about.queue}/{c.about.step} · </span>}{c.runtime} · {c.messages} messages · <TimeAgo at={c.last_at} /></span>
              </button>
            </li>
          ))}
          {list && shown.length === 0 && <li className="px-3 py-2 text-sm text-fg-3">No conversation yet.</li>}
        </ul>
        {(list ?? []).some((c) => c.archived) && (
          <label className="flex items-center gap-2 border-t border-line px-4 py-2 text-xs text-fg-3">
            <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} className="accent-accent" /> show archived
          </label>
        )}
      </nav>

      {creating && <NewConversation project={project} defaultRuntime={defaultRuntime} onBack={() => nav.close("conversation")}
        onCreated={(id) => { nav.open(`conversation:${id}`); onChanged(); }} />}
      {!creating && open && current && (
        <ChatColumn
          over={`${name} · ideas`} title={current.title ?? "Conversation"} who="Partner" about={<AboutStep project={project} c={current} className="mt-1" />} view={view} status={stateText(view)} onBack={() => nav.close("conversation")}
          showTools={showTools} menu={menu}
          empty={<>
            <p>Think something through: gameplay, a mechanic, the look, what to build next.</p>
            <p className="mt-1 text-fg-3">
              The partner reads the project{view?.notes_dir ? <> and writes notes only in <code>{view.notes_dir}</code></> : <>; it writes nothing until a notes folder is set in the project's settings</>}. It starts no work: hand the conversation to the orchestrator for that.
            </p>
          </>}
          draft={draftKey(project, "conversation", open)}
          placeholder="Think out loud…"
          onSend={async (text) => { await act(project, "POST", `/conversations/${enc(open)}/messages`, { text }); onChanged(); }}
        />
      )}
      {!side && !creating && !open && (
        <div className="hidden flex-1 flex-col items-center justify-center p-8 text-center text-sm text-fg-3 sm:flex">
          <p>Open a conversation, or start a new one.</p>
          <p className="mt-1 text-fg-3">Each conversation is its own session: topics do not mix, and each can be picked up later.</p>
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
        <button onClick={onBack} className={`rounded-md px-1.5 text-lg text-fg-2 hover:text-fg ${useContext(Side) ? "" : "sm:hidden"}`} aria-label="Back">‹</button>
        <h2 className="flex-1 font-semibold text-fg">New conversation</h2>
      </header>
      <div className="max-w-lg space-y-3 p-5">
        <label className="block text-sm text-fg">Topic
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Gameplay: mining and defense" autoFocus className={`mt-1 ${field}`} />
        </label>
        <div className="flex flex-wrap gap-3">
          <label className="text-sm text-fg">Runtime
            <select value={runtime} onChange={(e) => { setRuntime(e.target.value as "claude" | "codex"); setModel(""); setEffort(""); }} className={`mt-1 ${field}`}>
              <option value="claude">Claude Code</option><option value="codex">Codex</option>
            </select>
          </label>
          <label className="text-sm text-fg">Model
            <span className="mt-1 block"><ModelSelect runtime={runtime} value={model} onChange={setModel} className="py-1.5" /></span>
          </label>
          <label className="text-sm text-fg">Effort
            <span className="mt-1 block"><EffortSelect runtime={runtime} model={model} value={effort} onChange={setEffort} className="py-1.5" /></span>
          </label>
        </div>
        <Button onClick={() => void create()}>Start</Button>
        {error && <p className="text-sm text-danger">{error}</p>}
      </div>
    </div>
  );
}
