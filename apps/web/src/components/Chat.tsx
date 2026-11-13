// Chats: the project's orchestrator, and conversations with a thinking partner.
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { ChatEntry, RuntimeFile, SessionFile } from "@nexus/protocol";
import { act, enc, useFetch } from "../api.ts";
import { Button, Composer, Markdown, SIDE_RIGHT, TimeAgo, useWide } from "./ui.tsx";
import { draftKey } from "../drafts.ts";
import { layerValue, type SidePanel } from "../layers.ts";
import { nav, useNav } from "../nav.ts";
import { EffortSelect, ModelSelect, useEfforts } from "./Settings.tsx";

interface View { session: SessionFile | null; state: "working" | "idle" | "exited"; runtime: RuntimeFile | null; chat: ChatEntry[]; model: string | null; effort: string | null }

export function useOrchestrator(project: string | undefined, version: unknown) {
  return useFetch<View>(project ? `/api/projects/${enc(project)}/orchestrator` : undefined, version);
}

const Close = ({ onClose }: { onClose: () => void }) => (
  <button onClick={onClose} aria-label="Close" className="rounded-md p-1.5 text-fg-2 hover:bg-surface-3 hover:text-fg">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 6l12 12M18 6L6 18" /></svg>
  </button>
);


/** A chat: its header, the messages, and the composer. */
function ChatColumn({ title, over, about, view, status, actions, empty, draft, placeholder, onSend, onBack }: {
  title: string; over: string; about?: ReactNode; view: View | undefined; status: string; actions?: ReactNode; empty: ReactNode;
  draft: string; placeholder: string; onSend: (text: string) => Promise<void>; onBack?: () => void;
}) {
  const end = useRef<HTMLDivElement>(null);
  const side = useContext(Side);
  const [showTools, setShowTools] = useState(false);
  const chat = (view?.chat ?? []).filter((c) => showTools || c.kind !== "tool");
  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [chat.length, view?.state]);
  const rt = view?.runtime;
  const pct = rt?.context_tokens && rt.context_window ? Math.round((100 * rt.context_tokens) / rt.context_window) : undefined;
  const model = rt?.model ? rt.model.replace(/^claude-/, "") : view?.model;
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-5 py-3">
        {onBack && <button onClick={onBack} className={`rounded-md px-1.5 text-lg text-fg-2 hover:text-fg ${side ? "" : "sm:hidden"}`} aria-label="Back">‹</button>}
        <div className="min-w-0">
          <div className="text-xs text-fg-3">{over}</div>
          <h2 className="truncate font-semibold text-fg">{title}</h2>
          {about}
        </div>
        <span className="text-xs text-fg-3">
          {status}{model ? ` · ${model}` : ""}{view?.effort ? ` · ${view.effort} effort` : ""}{pct !== undefined ? ` · ${pct}% context` : ""}
        </span>
        <span className="ml-auto flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-fg-2">
            <input type="checkbox" checked={showTools} onChange={(e) => setShowTools(e.target.checked)} className="accent-accent" /> tool calls
          </label>
          {actions}
        </span>
      </header>
      <div className="scroll-thin flex-1 space-y-3 overflow-y-auto px-5 py-4">
        {chat.length === 0 && <div className="mt-10 text-center text-sm text-fg-3">{empty}</div>}
        {chat.map((c, i) => <Entry key={i} c={c} />)}
        {view?.state === "working" && <div className="text-xs text-fg-3"><span className="animate-pulse">●</span> working…</div>}
        <div ref={end} />
      </div>
      <footer className="border-t border-line p-4">
        <Composer rows={3} draft={draft} placeholder={placeholder} button="Send" onSubmit={onSend} />
      </footer>
    </div>
  );
}

function Entry({ c }: { c: ChatEntry }) {
  if (c.kind === "tool") {
    return <div className="truncate pl-1 font-mono text-[11px] text-fg-3" title={c.text}>› {c.text}</div>;
  }
  if (c.from === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-user-bubble px-4 py-2 text-sm text-fg">{c.text}</div>
      </div>
    );
  }
  if (c.from === "nexus") {
    return (
      <div className={`rounded-lg border px-3 py-2 text-xs ${c.kind === "error" ? "border-danger/30 bg-danger/5 text-danger" : "border-warn/30 bg-warn/5 text-warn/90"}`}>
        <span className="mr-2 font-semibold">Nexus</span><span className="whitespace-pre-wrap">{c.text}</span>
        <span className="ml-2 text-fg-3"><TimeAgo at={c.at} /></span>
      </div>
    );
  }
  return (
    <div className="max-w-[92%] rounded-2xl rounded-bl-sm bg-surface-3 px-4 py-2">
      <Markdown>{c.text}</Markdown>
    </div>
  );
}

/**
 * Inside a side panel (a wide screen, beside a step's details): narrow, so the Ideas panel shows its list or one
 * conversation at a time, as on a phone.
 */
const Side = createContext(false);

/**
 * At the top of each chat panel: Orchestrator | Ideas. The other one comes to the top in one click on every screen
 * size (opened when it is closed); Back then shows this one again.
 */
function PanelSwitch({ which }: { which: SidePanel }) {
  const item = (p: SidePanel, label: string) => (
    <button key={p} onClick={() => { if (p !== which) nav.raise(p); }} aria-pressed={p === which}
      className={`rounded-md px-3 py-1 text-xs font-medium ${p === which ? "bg-surface-4 text-fg" : "text-fg-2 hover:bg-surface-3 hover:text-fg"}`}>{label}</button>
  );
  return (
    <div className="flex shrink-0 items-center gap-1 border-b border-line px-3 py-1.5" role="group" aria-label="Chats">
      {item("chat", "Orchestrator")}{item("ideas", "Ideas")}
    </div>
  );
}

/** A chat's panel: over the page on narrow screens; on a wide one, beside it on the right, the page still usable. */
function Panel({ onClose, wide, which, children }: { onClose: () => void; wide?: boolean; which: SidePanel; children: ReactNode }) {
  const side = useWide();
  const body = <><PanelSwitch which={which} /><div className="flex min-h-0 flex-1">{children}</div></>;
  if (side) {
    return (
      <Side.Provider value={true}>
        <aside className="fixed bottom-0 right-0 z-20 flex flex-col border-l border-line bg-surface shadow-xl" style={{ top: "var(--header-h, 0px)", width: SIDE_RIGHT }}>
          {body}
        </aside>
      </Side.Provider>
    );
  }
  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-scrim/40" onClick={onClose} />
      <aside className={`relative flex h-full w-full flex-col ${wide ? "max-w-5xl" : "max-w-2xl"} border-l border-line bg-surface pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] shadow-2xl`}>
        {body}
      </aside>
    </div>
  );
}

const stateText = (v: View | undefined) =>
  v?.state === "working" ? "working…" : v?.session ? (v.state === "idle" ? "ready" : "asleep: wakes with your next message") : "starts with your first message";

// ---------------------------------------------------------------- the orchestrator

export function OrchestratorButton({ view, onClick }: { view: View | undefined; onClick: () => void }) {
  return (
    <button onClick={onClick} title="Orchestrator" className="flex shrink-0 items-center gap-2 rounded-lg border border-line-strong px-2.5 py-1.5 text-sm text-fg hover:border-fg-3/60 hover:bg-surface sm:px-3">
      <span className={`h-2 w-2 rounded-full ${view?.state === "working" ? "animate-pulse bg-accent" : view?.session ? "bg-ok" : "bg-fg-3"}`} />
      <span className="hidden sm:inline">Orchestrator</span>
      <svg className="sm:hidden" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1.1-4.6A8 8 0 1 1 21 12Z" /></svg>
    </button>
  );
}

export function ChatPanel({ project, name, view, onClose, onChanged }: {
  project: string; name: string; view: View | undefined; onClose: () => void; onChanged: () => void;
}) {
  return (
    <Panel onClose={onClose} which="chat">
      <ChatColumn
        over={name} title="Orchestrator" view={view} status={stateText(view)}
        actions={<>
          {view?.session && (
            <Button variant="quiet" onClick={() => {
              if (confirm("Start a new conversation? The orchestrator forgets this one (its transcript stays on disk).")) {
                void act(project, "POST", "/orchestrator/reset").then(onChanged);
              }
            }}>New conversation</Button>
          )}
          <Close onClose={onClose} />
        </>}
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
    <div className="mt-4">
      <div className="flex flex-wrap items-center gap-2">
        <button onClick={() => void go(false)} disabled={busy} title="Talk this step through with a thinking partner; nothing changes in the run"
          className="flex items-center gap-1.5 rounded-md border border-line-strong px-2.5 py-1 text-sm text-fg hover:border-fg-3/60 hover:bg-surface-3 disabled:opacity-40">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
          Chat about this
        </button>
        {mine.length > 0 && (
          <button onClick={() => void go(true)} disabled={busy} className="rounded-md px-2 py-1 text-xs text-fg-2 hover:bg-surface-3 hover:text-fg disabled:opacity-40">
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

export function ConversationsButton({ onClick }: { onClick: () => void }) {
  return (
    <button onClick={onClick} title="Conversations: think a topic through with a partner" className="flex shrink-0 items-center gap-2 rounded-lg border border-line-strong px-2.5 py-1.5 text-sm text-fg hover:border-fg-3/60 hover:bg-surface sm:px-3">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.2 1 2V17h6v-.3c0-.8.4-1.5 1-2A7 7 0 0 0 12 2Z" /></svg>
      <span className="hidden sm:inline">Ideas</span>
    </button>
  );
}

export function ConversationsPanel({ project, name, version, onClose, onChanged, defaultRuntime }: {
  project: string; name: string; version: unknown; onClose: () => void; onChanged: () => void; defaultRuntime: "claude" | "codex";
}) {
  const list = useFetch<ConversationItem[]>(`/api/projects/${enc(project)}/conversations`, version);
  // The open conversation (or the new-conversation form) is a layer above the panel: Back returns to the list.
  const layer = layerValue(useNav(), "conversation");
  const creating = layer === "new";
  const open = creating ? undefined : layer;
  const [showArchived, setShowArchived] = useState(false);
  const view = useFetch<ConversationView>(open ? `/api/projects/${enc(project)}/conversations/${enc(open)}` : undefined, version);
  const side = useWide();
  const current = list?.find((c) => c.id === open);
  const shown = (list ?? []).filter((c) => showArchived || !c.archived);

  return (
    <Panel onClose={onClose} wide which="ideas">
      <nav className={side
        ? `${open || creating ? "hidden" : "flex"} w-full flex-col`
        : `${open || creating ? "hidden sm:flex" : "flex"} w-full shrink-0 flex-col border-r border-line sm:w-72`}>
        <div className="flex items-center gap-2 border-b border-line px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="text-xs text-fg-3">{name}</div>
            <h2 className="font-semibold text-fg">Ideas</h2>
          </div>
          <span className={side ? "" : "sm:hidden"}><Close onClose={onClose} /></span>
        </div>
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

      {creating && <NewConversation project={project} defaultRuntime={defaultRuntime} onBack={() => nav.close("conversation")} onClose={onClose}
        onCreated={(id) => { nav.open(`conversation:${id}`); onChanged(); }} />}
      {!creating && open && current && (
        <ChatColumn
          over={`${name} · ideas`} title={current.title ?? "Conversation"} about={<AboutStep project={project} c={current} className="mt-1" />} view={view} status={stateText(view)} onBack={() => nav.close("conversation")}
          actions={<>
            <Button variant="quiet" onClick={() => {
              if (confirm("Hand this conversation to the orchestrator? The partner writes a summary (decisions, open questions, proposed work), which goes into the orchestrator's chat.")) {
                void act(project, "POST", `/conversations/${enc(open)}/handoff`).then(onChanged);
              }
            }}>Hand to orchestrator</Button>
            <ConversationMenu project={project} c={current} onChanged={onChanged} />
            <span className={side ? "" : "hidden sm:inline"}><Close onClose={onClose} /></span>
          </>}
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
          <div className="absolute right-3 top-3"><Close onClose={onClose} /></div>
          <p>Open a conversation, or start a new one.</p>
          <p className="mt-1 text-fg-3">Each conversation is its own session: topics do not mix, and each can be picked up later.</p>
        </div>
      )}
    </Panel>
  );
}

function NewConversation({ project, defaultRuntime, onBack, onClose, onCreated }: {
  project: string; defaultRuntime: "claude" | "codex"; onBack: () => void; onClose: () => void; onCreated: (id: string) => void;
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
        <Close onClose={onClose} />
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

function ConversationMenu({ project, c, onChanged }: { project: string; c: ConversationItem; onChanged: () => void }) {
  const efforts = useEfforts(c.runtime === "codex" ? "codex" : "claude", c.model ?? "");
  const patch = (body: unknown) => act(project, "PATCH", `/conversations/${enc(c.id)}`, body).then(onChanged, (e: Error) => alert(e.message));
  return (
    <select value="" onChange={(e) => {
      const v = e.target.value;
      if (v === "rename") { const t = prompt("Topic", c.title); if (t) void patch({ title: t }); }
      if (v === "archive") void patch({ archived: !c.archived });
      if (v.startsWith("effort:")) void patch({ effort: v.slice(7) || null });
    }} className="rounded-md border border-line-strong bg-canvas px-2 py-1 text-xs text-fg" title="More">
      <option value="">More…</option>
      <option value="rename">Rename</option>
      <option value="archive">{c.archived ? "Unarchive" : "Archive"}</option>
      <optgroup label="Effort (from the next message)">
        <option value="effort:">default</option>
        {efforts.map((x) => <option key={x} value={`effort:${x}`}>{x}{c.effort === x ? " ✓" : ""}</option>)}
      </optgroup>
    </select>
  );
}
