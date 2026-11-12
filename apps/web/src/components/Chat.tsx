// The project's orchestrator chat.
import { useEffect, useRef, useState } from "react";
import type { ChatEntry, RuntimeFile, SessionFile } from "@nexus/protocol";
import { act, enc, useFetch } from "../api.ts";
import { Button, Composer, Markdown, TimeAgo } from "./ui.tsx";

interface View { session: SessionFile | null; state: "working" | "idle" | "exited"; runtime: RuntimeFile | null; chat: ChatEntry[] }

export function useOrchestrator(project: string | undefined, version: unknown) {
  return useFetch<View>(project ? `/api/projects/${enc(project)}/orchestrator` : undefined, version);
}

export function OrchestratorButton({ view, onClick }: { view: View | undefined; onClick: () => void }) {
  return (
    <button onClick={onClick} title="Orchestrator" className="flex shrink-0 items-center gap-2 rounded-lg border border-zinc-700 px-2.5 py-1.5 sm:px-3 text-sm text-zinc-200 hover:border-zinc-500 hover:bg-zinc-900">
      <span className={`h-2 w-2 rounded-full ${view?.state === "working" ? "animate-pulse bg-blue-400" : view?.session ? "bg-emerald-500" : "bg-zinc-600"}`} />
      <span className="hidden sm:inline">Orchestrator</span>
      <svg className="sm:hidden" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1.1-4.6A8 8 0 1 1 21 12Z" /></svg>
    </button>
  );
}

export function ChatPanel({ project, name, view, onClose, onChanged }: {
  project: string; name: string; view: View | undefined; onClose: () => void; onChanged: () => void;
}) {
  const end = useRef<HTMLDivElement>(null);
  const [showTools, setShowTools] = useState(false);
  const [error, setError] = useState<string>();
  const chat = (view?.chat ?? []).filter((c) => showTools || c.kind !== "tool");
  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [chat.length, view?.state]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);
  const rt = view?.runtime;
  const pct = rt?.context_tokens && rt.context_window ? Math.round((100 * rt.context_tokens) / rt.context_window) : undefined;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <aside className="relative flex h-full w-full max-w-2xl flex-col border-l border-zinc-800 bg-zinc-900 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] shadow-2xl">
        <header className="flex flex-wrap items-center gap-3 border-b border-zinc-800 px-5 py-3">
          <div className="min-w-0">
            <div className="text-xs text-zinc-500">{name}</div>
            <h2 className="font-semibold text-zinc-50">Orchestrator</h2>
          </div>
          <span className="text-xs text-zinc-500">
            {view?.state === "working" ? "working…" : view?.session ? (view.state === "idle" ? "ready" : "asleep: wakes with your next message") : "starts with your first message"}
            {rt?.model ? ` · ${rt.model.replace(/^claude-/, "")}` : ""}{pct !== undefined ? ` · ${pct}% context` : ""}
          </span>
          <span className="ml-auto flex items-center gap-2">
            <label className="flex items-center gap-1.5 text-xs text-zinc-400">
              <input type="checkbox" checked={showTools} onChange={(e) => setShowTools(e.target.checked)} className="accent-sky-500" /> tool calls
            </label>
            {view?.session && (
              <Button variant="quiet" onClick={() => {
                if (confirm("Start a new conversation? The orchestrator forgets this one (its transcript stays on disk).")) {
                  act(project, "POST", "/orchestrator/reset").then(onChanged, (e: Error) => setError(e.message));
                }
              }}>New conversation</Button>
            )}
            <button onClick={onClose} aria-label="Close" className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 6l12 12M18 6L6 18" /></svg>
            </button>
          </span>
        </header>

        <div className="scroll-thin flex-1 space-y-3 overflow-y-auto px-5 py-4">
          {chat.length === 0 && (
            <div className="mt-10 text-center text-sm text-zinc-500">
              <p>Plan queues with the orchestrator, ask where things stand, or have it start a run.</p>
              <p className="mt-1 text-zinc-600">It reads the project and works through <code>nexus</code>; it never edits files or approves queues.</p>
            </div>
          )}
          {chat.map((c, i) => <Entry key={i} c={c} />)}
          {view?.state === "working" && <div className="text-xs text-zinc-500"><span className="animate-pulse">●</span> working…</div>}
          <div ref={end} />
        </div>

        <footer className="border-t border-zinc-800 p-4">
          <Composer
            rows={3}
            placeholder="Message the orchestrator…"
            button="Send"
            onSubmit={async (text) => { await act(project, "POST", "/orchestrator/messages", { text }); onChanged(); }}
          />
          {error && <p className="mt-1 text-xs text-red-400">{error}</p>}
        </footer>
      </aside>
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
        <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-sky-600/90 px-4 py-2 text-sm whitespace-pre-wrap text-white">{c.text}</div>
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
