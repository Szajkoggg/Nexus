// Running queues through Nexus-launched sessions: controls, live activity, sessions and usage.
import { useState } from "react";
import { act, enc, useFetch, type ActivityEntry, type ProjectState, type QueueView, type SessionView, type Usage } from "../api.ts";
import { Button, Section, TimeAgo } from "./ui.tsx";

const RUN_TONE: Record<string, string> = {
  running: "text-blue-300 bg-blue-500/10 ring-blue-500/40",
  pausing: "text-amber-300 bg-amber-500/10 ring-amber-500/40",
  paused: "text-zinc-300 bg-zinc-500/10 ring-zinc-500/40",
  halted: "text-orange-300 bg-orange-500/10 ring-orange-500/40",
  finished: "text-emerald-300 bg-emerald-500/10 ring-emerald-500/30",
  usage_wait: "text-amber-300 bg-amber-500/10 ring-amber-500/40",
};
const RUN_LABEL: Record<string, string> = {
  running: "running", pausing: "pausing after this step", paused: "paused", halted: "halted",
  finished: "finished", usage_wait: "waiting for the usage window",
};

export function RunChip({ queue }: { queue: QueueView }) {
  const r = queue.run;
  if (!r || r.state === "finished") return null;
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs ring-1 ${RUN_TONE[r.state]}`}>
      {r.state === "running" && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-blue-400" />}
      Nexus: {RUN_LABEL[r.state]}{r.step && r.state === "running" ? ` · ${r.step}` : ""}
    </span>
  );
}

const MODELS = [
  { value: "", label: "project default" },
  { value: "opus", label: "Opus" },
  { value: "sonnet", label: "Sonnet" },
  { value: "haiku", label: "Haiku" },
];

/** Start, pause, stop and resume a queue's run. */
export function RunControls({ project, queue, onChanged }: { project: ProjectState; queue: QueueView; onChanged: () => void }) {
  const id = project.project.id;
  const [model, setModel] = useState("");
  const [session, setSession] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const run = queue.run;
  const active = run && ["running", "pausing", "usage_wait"].includes(run.state);
  const call = async (body: Record<string, unknown>) => {
    setBusy(true); setError(undefined);
    try { await act(id, "POST", `/queues/${enc(queue.id)}/run`, body); onChanged(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const reusable = project.sessions.filter((s) => s.runtime === "claude" && s.launched_by === "nexus" && s.native_id
    && !project.queues.some((q) => q.id !== queue.id && q.run?.session === s.id && ["running", "pausing", "usage_wait"].includes(q.run.state)));
  const runSession = run ? project.sessions.find((s) => s.id === run.session) : undefined;
  const canStart = queue.approved && !active && queue.status !== "done" && queue.status !== "cancelled";

  return (
    <Section title="Run with Nexus">
      {run && (
        <div className="mb-3 rounded-lg bg-zinc-800/50 p-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`rounded-full px-2 py-0.5 text-xs ring-1 ${RUN_TONE[run.state]}`}>{RUN_LABEL[run.state]}</span>
            {run.step && <span className="font-mono text-xs text-zinc-400">at {run.step}</span>}
            <span className="text-xs text-zinc-500">since <TimeAgo at={run.updated_at} /></span>
          </div>
          {run.reason && <p className="mt-1 text-zinc-300">{run.reason}</p>}
          {runSession && <p className="mt-1 text-xs text-zinc-500">Session: {runSession.title ?? runSession.id} {runSession.live?.model ? `· ${runSession.live.model}` : ""} <ContextBar s={runSession} /></p>}
          {run.state === "usage_wait" && run.resume_at && <p className="mt-1 text-xs text-zinc-500">Resumes by itself at {new Date(run.resume_at).toLocaleTimeString()}.</p>}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {active && run?.state !== "pausing" && <Button variant="quiet" disabled={busy} onClick={() => call({ action: "pause" })}>Pause after this step</Button>}
        {active && <Button variant="danger" disabled={busy} onClick={() => call({ action: "stop" })}>Stop now</Button>}
        {run && (run.state === "paused" || run.state === "halted") && <Button disabled={busy || !queue.approved} onClick={() => call({ action: "resume" })}>Resume</Button>}
      </div>
      {canStart && (!run || run.state === "finished" || run.state === "halted" || run.state === "paused") && (
        <div className={`${run ? "mt-4 border-t border-zinc-800 pt-3" : ""} flex flex-wrap items-end gap-3`}>
          <label className="text-xs text-zinc-400">
            <span className="mb-1 block">Session</span>
            <select value={session} onChange={(e) => setSession(e.target.value)} className="max-w-72 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-zinc-200">
              <option value="">New session</option>
              {reusable.map((s) => (
                <option key={s.id} value={s.id}>
                  Continue: {s.title ?? s.id.slice(-8)}{s.context ? ` (${s.context.topics.slice(0, 3).join(", ") || "has context"})` : ""}{s.live?.context_tokens && s.live.context_window ? ` · ${Math.round((100 * s.live.context_tokens) / s.live.context_window)}%` : ""}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs text-zinc-400">
            <span className="mb-1 block">Model</span>
            <select value={model} onChange={(e) => setModel(e.target.value)} disabled={!!session} className="rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-zinc-200 disabled:opacity-50">
              {MODELS.map((m) => <option key={m.value} value={m.value}>{m.label}{m.value === "" && project.project.runtimes.claude.model ? ` (${project.project.runtimes.claude.model})` : ""}</option>)}
            </select>
          </label>
          <Button disabled={busy} onClick={() => call({ action: "start", model: model || undefined, session: session || undefined })}>
            {run ? "Start a new run" : "Start"}
          </Button>
        </div>
      )}
      {!queue.approved && !active && <p className="text-sm text-zinc-500">Approve the queue's current revision to run it.</p>}
      {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
      <p className="mt-2 text-xs text-zinc-600">
        Claude Code runs in {queue.worktree && queue.worktree !== "auto" ? <span className="font-mono">{queue.worktree}</span> : queue.worktree === "auto" ? "a new worktree" : <span className="font-mono">{project.project.root}</span>} with permission mode {project.project.runtimes.claude.permission_mode}.
      </p>
    </Section>
  );
}

const KIND_STYLE: Record<string, string> = {
  tool: "text-zinc-300", text: "text-zinc-100", tool_error: "text-red-300", error: "text-red-300",
  turn_start: "text-zinc-500", turn_end: "text-zinc-500", exit: "text-zinc-500",
};
const KIND_ICON: Record<string, string> = { tool: "›", text: "¶", tool_error: "✗", error: "!", turn_start: "▸", turn_end: "■", exit: "■" };

/** What the agent did during a step, from the runtime's stream. */
export function Activity({ project, session, queue, step, version }: { project: string; session: string; queue: string; step: string; version: unknown }) {
  const items = useFetch<ActivityEntry[]>(`/api/projects/${enc(project)}/sessions/${enc(session)}/activity?queue=${enc(queue)}&step=${enc(step)}`, version);
  const [all, setAll] = useState(false);
  if (!items?.length) return null;
  const shown = all ? items : items.slice(-40);
  return (
    <Section title="Agent activity" aside={items.length > 40 && <button className="text-xs text-sky-400" onClick={() => setAll(!all)}>{all ? "Latest only" : `All ${items.length}`}</button>}>
      <ol className="scroll-thin max-h-96 space-y-1 overflow-y-auto rounded-lg bg-zinc-950 p-3 font-mono text-xs">
        {shown.map((a, i) => (
          <li key={i} className={`flex gap-2 ${KIND_STYLE[a.kind] ?? "text-zinc-400"}`}>
            <span className="w-14 shrink-0 text-zinc-600">{new Date(a.at).toLocaleTimeString("en-GB")}</span>
            <span className="w-3 shrink-0 text-zinc-600">{KIND_ICON[a.kind] ?? "·"}</span>
            <span className={`min-w-0 break-words ${a.kind === "text" ? "whitespace-pre-wrap font-sans" : ""}`}>{a.text}</span>
          </li>
        ))}
      </ol>
    </Section>
  );
}

export function ContextBar({ s }: { s: SessionView }) {
  const t = s.live?.context_tokens; const w = s.live?.context_window;
  if (!t || !w) return null;
  const pct = Math.round((100 * t) / w);
  return (
    <span className="inline-flex items-center gap-1.5 align-middle" title={`${t.toLocaleString()} of ${w.toLocaleString()} tokens`}>
      <span className="inline-block h-1.5 w-16 overflow-hidden rounded bg-zinc-800">
        <span className={`block h-full ${pct > 60 ? "bg-amber-400" : "bg-sky-400"}`} style={{ width: `${Math.max(2, pct)}%` }} />
      </span>
      <span className="text-zinc-500">{pct}%</span>
    </span>
  );
}

/** The subscription's windows, from the latest report of any session. */
export function UsageMeter({ version }: { version: unknown }) {
  const u = useFetch<Usage | null>("/api/usage", version);
  if (!u) return null;
  const windows = Object.entries(u.windows).filter(([, w]) => !w.resets_at || Date.parse(w.resets_at) > Date.now());
  if (!windows.length) return null;
  const name = (k: string) => (k === "five_hour" ? "5h" : k === "seven_day" ? "7d" : k.replace(/_/g, " "));
  return (
    <span className="hidden items-center gap-3 text-xs text-zinc-500 sm:flex" title={`Reported ${new Date(u.updated_at).toLocaleString()}`}>
      {windows.map(([k, w]) => {
        const pct = Math.round(w.utilization * 100);
        return (
          <span key={k} className="flex items-center gap-1.5" title={w.resets_at ? `resets ${new Date(w.resets_at).toLocaleString()}` : undefined}>
            {name(k)}
            <span className="inline-block h-1.5 w-12 overflow-hidden rounded bg-zinc-800">
              <span className={`block h-full ${pct >= 90 ? "bg-red-400" : pct >= 70 ? "bg-amber-400" : "bg-emerald-400"}`} style={{ width: `${Math.max(2, pct)}%` }} />
            </span>
            {pct}%
          </span>
        );
      })}
    </span>
  );
}
