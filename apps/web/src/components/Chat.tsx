// Chats: the project's orchestrator, and conversations with a thinking partner.
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ChatEntry, RuntimeFile, SessionFile } from "@nexus/protocol";
import { act, enc, useFetch } from "../api.ts";
import { Button, Composer, Markdown, TimeAgo } from "./ui.tsx";
import { draftKey } from "../drafts.ts";
import { EffortSelect, ModelSelect, useEfforts } from "./Settings.tsx";

interface View { session: SessionFile | null; state: "working" | "idle" | "exited"; runtime: RuntimeFile | null; chat: ChatEntry[]; model: string | null; effort: string | null }

export function useOrchestrator(project: string | undefined, version: unknown) {
  return useFetch<View>(project ? `/api/projects/${enc(project)}/orchestrator` : undefined, version);
}

const Close = ({ onClose }: { onClose: () => void }) => (
  <button onClick={onClose} aria-label="Close" className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 6l12 12M18 6L6 18" /></svg>
  </button>
);

function useEscape(onClose: () => void) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);
}

/** A chat: its header, the messages, and the composer. */
function ChatColumn({ title, over, view, status, actions, empty, draft, placeholder, onSend, onBack }: {
  title: string; over: string; view: View | undefined; status: string; actions?: ReactNode; empty: ReactNode;
  draft: string; placeholder: string; onSend: (text: string) => Promise<void>; onBack?: () => void;
}) {
  const end = useRef<HTMLDivElement>(null);
  const [showTools, setShowTools] = useState(false);
  const chat = (view?.chat ?? []).filter((c) => showTools || c.kind !== "tool");
  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [chat.length, view?.state]);
  const rt = view?.runtime;
  const pct = rt?.context_tokens && rt.context_window ? Math.round((100 * rt.context_tokens) / rt.context_window) : undefined;
  const model = rt?.model ? rt.model.replace(/^claude-/, "") : view?.model;
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-zinc-800 px-5 py-3">
        {onBack && <button onClick={onBack} className="rounded-md px-1.5 text-lg text-zinc-400 hover:text-zinc-100 sm:hidden" aria-label="Back">‹</button>}
        <div className="min-w-0">
          <div className="text-xs text-zinc-500">{over}</div>
          <h2 className="truncate font-semibold text-zinc-50">{title}</h2>
        </div>
        <span className="text-xs text-zinc-500">
          {status}{model ? ` · ${model}` : ""}{view?.effort ? ` · ${view.effort} effort` : ""}{pct !== undefined ? ` · ${pct}% context` : ""}
        </span>
        <span className="ml-auto flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-zinc-400">
            <input type="checkbox" checked={showTools} onChange={(e) => setShowTools(e.target.checked)} className="accent-sky-500" /> tool calls
          </label>
          {actions}
        </span>
      </header>
      <div className="scroll-thin flex-1 space-y-3 overflow-y-auto px-5 py-4">
        {chat.length === 0 && <div className="mt-10 text-center text-sm text-zinc-500">{empty}</div>}
        {chat.map((c, i) => <Entry key={i} c={c} />)}
        {view?.state === "working" && <div className="text-xs text-zinc-500"><span className="animate-pulse">●</span> working…</div>}
        <div ref={end} />
      </div>
      <footer className="border-t border-zinc-800 p-4">
        <Composer rows={3} draft={draft} placeholder={placeholder} button="Send" onSubmit={onSend} />
      </footer>
    </div>
  );
}

function Entry({ c }: { c: ChatEntry }) {
  if (c.kind === "tool") {
    return <div className="truncate pl-1 font-mono text-[11px] text-zinc-600" title={c.text}>› {c.text}</div>;
  }
  if (c.from === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-sky-600/90 px-4 py-2 text-sm text-white">{c.text}</div>
      </div>
    );
  }
  if (c.from === "nexus") {
    return (
      <div className={`rounded-lg border px-3 py-2 text-xs ${c.kind === "error" ? "border-red-500/30 bg-red-500/5 text-red-300" : "border-amber-500/30 bg-amber-500/5 text-amber-200/90"}`}>
        <span className="mr-2 font-semibold">Nexus</span><span className="whitespace-pre-wrap">{c.text}</span>
        <span className="ml-2 text-zinc-500"><TimeAgo at={c.at} /></span>
      </div>
    );
  }
  return (
    <div className="max-w-[92%] rounded-2xl rounded-bl-sm bg-zinc-800/70 px-4 py-2">
      <Markdown>{c.text}</Markdown>
    </div>
  );
}

const Panel = ({ onClose, wide, children }: { onClose: () => void; wide?: boolean; children: ReactNode }) => (
  <div className="fixed inset-0 z-50 flex justify-end">
    <div className="absolute inset-0 bg-black/40" onClick={onClose} />
    <aside className={`relative flex h-full w-full ${wide ? "max-w-5xl" : "max-w-2xl"} border-l border-zinc-800 bg-zinc-900 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] shadow-2xl`}>
      {children}
    </aside>
  </div>
);

const stateText = (v: View | undefined) =>
  v?.state === "working" ? "working…" : v?.session ? (v.state === "idle" ? "ready" : "asleep: wakes with your next message") : "starts with your first message";

// ---------------------------------------------------------------- the orchestrator

export function OrchestratorButton({ view, onClick }: { view: View | undefined; onClick: () => void }) {
  return (
    <button onClick={onClick} title="Orchestrator" className="flex shrink-0 items-center gap-2 rounded-lg border border-zinc-700 px-2.5 py-1.5 text-sm text-zinc-200 hover:border-zinc-500 hover:bg-zinc-900 sm:px-3">
      <span className={`h-2 w-2 rounded-full ${view?.state === "working" ? "animate-pulse bg-blue-400" : view?.session ? "bg-emerald-500" : "bg-zinc-600"}`} />
      <span className="hidden sm:inline">Orchestrator</span>
      <svg className="sm:hidden" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1.1-4.6A8 8 0 1 1 21 12Z" /></svg>
    </button>
  );
}

export function ChatPanel({ project, name, view, onClose, onChanged }: {
  project: string; name: string; view: View | undefined; onClose: () => void; onChanged: () => void;
}) {
  useEscape(onClose);
  return (
    <Panel onClose={onClose}>
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
          <p className="mt-1 text-zinc-600">It reads the project and works through <code>nexus</code>; it never edits files or approves queues.</p>
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

export function ConversationsButton({ onClick }: { onClick: () => void }) {
  return (
    <button onClick={onClick} title="Conversations: think a topic through with a partner" className="flex shrink-0 items-center gap-2 rounded-lg border border-zinc-700 px-2.5 py-1.5 text-sm text-zinc-200 hover:border-zinc-500 hover:bg-zinc-900 sm:px-3">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.2 1 2V17h6v-.3c0-.8.4-1.5 1-2A7 7 0 0 0 12 2Z" /></svg>
      <span className="hidden sm:inline">Ideas</span>
    </button>
  );
}

export function ConversationsPanel({ project, name, version, onClose, onChanged, defaultRuntime }: {
  project: string; name: string; version: unknown; onClose: () => void; onChanged: () => void; defaultRuntime: "claude" | "codex";
}) {
  useEscape(onClose);
  const list = useFetch<ConversationItem[]>(`/api/projects/${enc(project)}/conversations`, version);
  const [open, setOpen] = useState<string>();
  const [creating, setCreating] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const view = useFetch<ConversationView>(open ? `/api/projects/${enc(project)}/conversations/${enc(open)}` : undefined, version);
  const current = list?.find((c) => c.id === open);
  const shown = (list ?? []).filter((c) => showArchived || !c.archived);

  return (
    <Panel onClose={onClose} wide>
      <nav className={`${open || creating ? "hidden sm:flex" : "flex"} w-full shrink-0 flex-col border-r border-zinc-800 sm:w-72`}>
        <div className="flex items-center gap-2 border-b border-zinc-800 px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="text-xs text-zinc-500">{name}</div>
            <h2 className="font-semibold text-zinc-50">Ideas</h2>
          </div>
          <span className="sm:hidden"><Close onClose={onClose} /></span>
        </div>
        <div className="p-3"><Button onClick={() => { setCreating(true); setOpen(undefined); }}>New conversation</Button></div>
        <ul className="scroll-thin flex-1 overflow-y-auto px-2 pb-3">
          {shown.map((c) => (
            <li key={c.id}>
              <button onClick={() => { setOpen(c.id); setCreating(false); }}
                className={`w-full rounded-lg px-3 py-2 text-left text-sm ${c.id === open ? "bg-zinc-800 text-zinc-50" : "text-zinc-300 hover:bg-zinc-800/60"} ${c.archived ? "opacity-50" : ""}`}>
                <span className="flex items-center gap-2">
                  {c.state === "working" && <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-blue-400" />}
                  <span className="truncate">{c.title}</span>
                </span>
                <span className="block text-xs text-zinc-500">{c.runtime} · {c.messages} messages · <TimeAgo at={c.last_at} /></span>
              </button>
            </li>
          ))}
          {list && shown.length === 0 && <li className="px-3 py-2 text-sm text-zinc-500">No conversation yet.</li>}
        </ul>
        {(list ?? []).some((c) => c.archived) && (
          <label className="flex items-center gap-2 border-t border-zinc-800 px-4 py-2 text-xs text-zinc-500">
            <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} className="accent-sky-500" /> show archived
          </label>
        )}
      </nav>

      {creating && <NewConversation project={project} defaultRuntime={defaultRuntime} onBack={() => setCreating(false)} onClose={onClose}
        onCreated={(id) => { setCreating(false); setOpen(id); onChanged(); }} />}
      {!creating && open && current && (
        <ChatColumn
          over={`${name} · ideas`} title={current.title ?? "Conversation"} view={view} status={stateText(view)} onBack={() => setOpen(undefined)}
          actions={<>
            <Button variant="quiet" onClick={() => {
              if (confirm("Hand this conversation to the orchestrator? The partner writes a summary (decisions, open questions, proposed work), which goes into the orchestrator's chat.")) {
                void act(project, "POST", `/conversations/${enc(open)}/handoff`).then(onChanged);
              }
            }}>Hand to orchestrator</Button>
            <ConversationMenu project={project} c={current} onChanged={onChanged} />
            <span className="hidden sm:inline"><Close onClose={onClose} /></span>
          </>}
          empty={<>
            <p>Think something through: gameplay, a mechanic, the look, what to build next.</p>
            <p className="mt-1 text-zinc-600">
              The partner reads the project{view?.notes_dir ? <> and writes notes only in <code>{view.notes_dir}</code></> : <>; it writes nothing until a notes folder is set in the project's settings</>}. It starts no work: hand the conversation to the orchestrator for that.
            </p>
          </>}
          draft={draftKey(project, "conversation", open)}
          placeholder="Think out loud…"
          onSend={async (text) => { await act(project, "POST", `/conversations/${enc(open)}/messages`, { text }); onChanged(); }}
        />
      )}
      {!creating && !open && (
        <div className="hidden flex-1 flex-col items-center justify-center p-8 text-center text-sm text-zinc-500 sm:flex">
          <div className="absolute right-3 top-3"><Close onClose={onClose} /></div>
          <p>Open a conversation, or start a new one.</p>
          <p className="mt-1 text-zinc-600">Each conversation is its own session: topics do not mix, and each can be picked up later.</p>
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
  const field = "w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-200 placeholder:text-zinc-600";
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
      <header className="flex items-center gap-2 border-b border-zinc-800 px-5 py-3">
        <button onClick={onBack} className="rounded-md px-1.5 text-lg text-zinc-400 hover:text-zinc-100 sm:hidden" aria-label="Back">‹</button>
        <h2 className="flex-1 font-semibold text-zinc-50">New conversation</h2>
        <Close onClose={onClose} />
      </header>
      <div className="max-w-lg space-y-3 p-5">
        <label className="block text-sm text-zinc-300">Topic
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Gameplay: mining and defense" autoFocus className={`mt-1 ${field}`} />
        </label>
        <div className="flex flex-wrap gap-3">
          <label className="text-sm text-zinc-300">Runtime
            <select value={runtime} onChange={(e) => { setRuntime(e.target.value as "claude" | "codex"); setModel(""); setEffort(""); }} className={`mt-1 ${field}`}>
              <option value="claude">Claude Code</option><option value="codex">Codex</option>
            </select>
          </label>
          <label className="text-sm text-zinc-300">Model
            <span className="mt-1 block"><ModelSelect runtime={runtime} value={model} onChange={setModel} className="py-1.5" /></span>
          </label>
          <label className="text-sm text-zinc-300">Effort
            <span className="mt-1 block"><EffortSelect runtime={runtime} model={model} value={effort} onChange={setEffort} className="py-1.5" /></span>
          </label>
        </div>
        <Button onClick={() => void create()}>Start</Button>
        {error && <p className="text-sm text-red-300">{error}</p>}
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
    }} className="rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-300" title="More">
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
