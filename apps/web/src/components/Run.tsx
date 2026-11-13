// Running queues through Nexus-launched sessions: controls, live activity, sessions and usage.
import { useState } from "react";
import { formatClock, retryLine } from "@nexus/protocol/times";
import { act, enc, useFetch, type ActivityEntry, type ProjectState, type QueueView, type SessionView, type Usage } from "../api.ts";
import { Button, RunTimes, Section, TimeAgo } from "./ui.tsx";
import { EffortSelect, ModelSelect } from "./Settings.tsx";

const RUN_TONE: Record<string, string> = {
  running: "text-blue-300 bg-blue-500/10 ring-blue-500/40",
  pausing: "text-amber-300 bg-amber-500/10 ring-amber-500/40",
  paused: "text-zinc-300 bg-zinc-500/10 ring-zinc-500/40",
  halted: "text-orange-300 bg-orange-500/10 ring-orange-500/40",
  finished: "text-emerald-300 bg-emerald-500/10 ring-emerald-500/30",
  usage_wait: "text-amber-300 bg-amber-500/10 ring-amber-500/40",
  retry_wait: "text-amber-300 bg-amber-500/10 ring-amber-500/40",
};
const RUN_LABEL: Record<string, string> = {
  running: "running", pausing: "pausing after this step", paused: "paused", halted: "halted",
  finished: "finished", usage_wait: "waiting for the usage window", retry_wait: "waiting to retry",
};

/** A pending retry, "Retry 2 of 5 at 14:05, overloaded", in amber; nothing for a run that is not waiting to retry. */
export function RetryNote({ run, className = "mt-1 text-xs" }: { run: NonNullable<QueueView["run"]>; className?: string }) {
  const line = retryLine(run, new Date());
  if (!line) return null;
  return <p className={`${className} text-amber-300`}>↻ {line[0]!.toUpperCase() + line.slice(1)}</p>;
}

const RUNTIME_NAME: Record<string, string> = { claude: "Claude Code", codex: "Codex" };

const SEEDED: Record<string, string> = {
  written: "seeded with its context summary",
  asked: "seeded with the context summary it wrote when asked",
  fallback: "no summary came: seeded with the queue's description and its finished steps' summaries",
};

/**
 * Each time the run went on in a fresh session: the previous one's context was full (context care), or the step runs
 * on another runtime.
 */
function SessionSwitches({ run, sessions }: { run: NonNullable<QueueView["run"]>; sessions: SessionView[] }) {
  if (!run.switches?.length) return null;
  return (
    <ul className="mt-1 space-y-0.5 text-xs text-zinc-400">
      {run.switches.map((s) => (
        <li key={s.to} className="flex gap-1.5">
          <span className="text-sky-400">↪</span>
          <span className="min-w-0">
            Fresh session from <span className="font-mono">{s.step}</span> at {formatClock(s.at, new Date())}: {s.why === "runtime"
              ? `the step runs on ${RUNTIME_NAME[sessions.find((x) => x.id === s.to)?.runtime ?? ""] ?? "another runtime"}`
              : `the previous one's context was ${s.fill === undefined ? "full" : `${Math.round(s.fill * 100)}% full`}`}; {SEEDED[s.summary]}.
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * A planned start of the queue: the queue it waits for and why it has not come yet, or why it could not start; with
 * Cancel. Amber while it waits on something only the user or the orchestrator can change.
 */
function PlannedStart({ queue, busy, onCancel }: { queue: QueueView; busy: boolean; onCancel: () => void }) {
  const p = queue.start;
  if (!p) return null;
  const options = [p.session ? `continues session ${p.session.slice(-8)}` : p.runtime === "codex" ? "Codex" : p.runtime === "claude" ? "Claude Code" : undefined, p.model, p.effort && `${p.effort} effort`].filter(Boolean);
  const tone = p.failed ? "bg-orange-500/10 ring-orange-500/30" : p.blocked ? "bg-amber-500/10 ring-amber-500/30" : "bg-sky-500/10 ring-sky-500/30";
  return (
    <div className={`mb-3 rounded-lg p-3 text-sm ring-1 ${tone}`}>
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <p className="min-w-0 flex-1">
          {p.failed
            ? <span className="text-orange-200">It was to start when <span className="font-mono">{p.after}</span> was done, but could not: {p.failed.reason}</span>
            : <span className="text-zinc-100">Starts when <span className="font-mono">{p.after}</span> is done.</span>}
          <span className="mt-1 block text-xs text-zinc-400">
            {p.failed ? <>Start it yourself, or dismiss the plan. · <TimeAgo at={p.failed.at} /></> : <>Now: {p.waiting}.</>}
          </span>
          <span className="mt-1 block text-xs text-zinc-500">
            Planned by {p.by === "user" ? "you" : "the orchestrator"} · <TimeAgo at={p.created_at} />{options.length ? ` · ${options.join(" · ")}` : ""}{p.reason ? ` · ${p.reason}` : ""}
          </span>
        </p>
        <Button variant="quiet" disabled={busy} onClick={onCancel}>{p.failed ? "Dismiss" : "Cancel"}</Button>
      </div>
    </div>
  );
}

/** A run that halted although its queue is done (or cancelled): it has ended; nothing waits on it. */
const endedHalt = (queue: QueueView) => queue.run?.state === "halted" && (queue.status === "done" || queue.status === "cancelled");

export function RunChip({ queue }: { queue: QueueView }) {
  const r = queue.run;
  const going = r && ["running", "pausing", "usage_wait", "retry_wait"].includes(r.state);
  if (queue.start && !going) {
    const tone = queue.start.failed || queue.start.blocked ? "text-orange-300 bg-orange-500/10 ring-orange-500/40" : "text-sky-300 bg-sky-500/10 ring-sky-500/40";
    return <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ring-1 ${tone}`}>{queue.start.failed ? "did not start" : "starts"} after {queue.start.after}</span>;
  }
  if (!r || r.state === "finished" || endedHalt(queue)) return null;
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs ring-1 ${RUN_TONE[r.state]}`}>
      {r.state === "running" && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-blue-400" />}
      Nexus: {RUN_LABEL[r.state]}{r.step && (r.state === "running" || r.state === "retry_wait") ? ` · ${r.step}` : ""}
    </span>
  );
}


/** Start, pause, stop and resume a queue's run. */
export function RunControls({ project, queue, onChanged }: { project: ProjectState; queue: QueueView; onChanged: () => void }) {
  const id = project.project.id;
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [runtime, setRuntime] = useState<"claude" | "codex">(project.project.runtimes.default);
  const defaultModel = project.project.runtimes[runtime].model;
  const defaultEffort = project.project.runtimes[runtime].effort;
  const [session, setSession] = useState("");
  const [after, setAfter] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const run = queue.run;
  const active = run && ["running", "pausing", "usage_wait", "retry_wait"].includes(run.state);
  const call = async (body: Record<string, unknown>) => {
    setBusy(true); setError(undefined);
    try { await act(id, "POST", `/queues/${enc(queue.id)}/run`, body); onChanged(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const reusable = project.sessions.filter((s) => s.role === "worker" && s.runtime !== "external" && s.launched_by === "nexus" && s.native_id
    && !project.queues.some((q) => q.id !== queue.id && q.run?.session === s.id && ["running", "pausing", "usage_wait", "retry_wait"].includes(q.run.state)));
  const runSession = run ? project.sessions.find((s) => s.id === run.session) : undefined;
  // A stopped queue goes on only through Continue or a newly approved revision (the stop box above).
  const canStart = queue.approved && !active && queue.status !== "done" && queue.status !== "cancelled" && queue.status !== "stopped";
  const ended = endedHalt(queue);
  // Shown as finished: the label, its colour and the times say "ended", and there is nothing to resume.
  const shown = run && ended ? { ...run, state: "finished" as const } : run;
  // Queues this one can start after: any other that is not cancelled (a done one starts this one now).
  const chainable = project.queues.filter((x) => x.id !== queue.id && x.status !== "cancelled");

  return (
    <Section title="Run with Nexus">
      <PlannedStart queue={queue} busy={busy} onCancel={() => call({ action: "cancel_start" })} />
      {!!queue.starts_next?.length && (
        <p className="mb-3 text-xs text-zinc-400">
          <span className="text-sky-400">→</span> When this queue is done, {queue.starts_next.map((x, i) => <span key={x}>{i ? ", " : ""}<span className="font-mono text-zinc-200">{x}</span></span>)} start{queue.starts_next.length === 1 ? "s" : ""}.
        </p>
      )}
      {run && (
        <div className="mb-3 rounded-lg bg-zinc-800/50 p-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`rounded-full px-2 py-0.5 text-xs ring-1 ${RUN_TONE[shown!.state]}`}>{ended ? "ended" : RUN_LABEL[run.state]}</span>
            {run.step && <span className="font-mono text-xs text-zinc-400">at {run.step}</span>}
            <span className="text-xs text-zinc-500">since <TimeAgo at={run.updated_at} /></span>
          </div>
          <div className="mt-1 flex flex-wrap gap-x-3 text-xs text-zinc-400"><RunTimes run={shown!} /></div>
          {run.reason && (ended
            ? <p className="mt-1 text-xs text-zinc-500">The queue is done. The run's last note: {run.reason}</p>
            : <p className="mt-1 text-zinc-300">{run.reason}</p>)}
          {runSession && <p className="mt-1 text-xs text-zinc-500">Session: {runSession.title ?? runSession.id} {runSession.live?.model ? `· ${runSession.live.model}` : ""}{runSession.effort ? ` · ${runSession.effort} effort` : ""} <ContextBar s={runSession} /></p>}
          {run.after && <p className="mt-1 text-xs text-zinc-500">Started by its plan when <span className="font-mono">{run.after}</span> was done.</p>}
          <SessionSwitches run={run} sessions={project.sessions} />
          {run.summary_asked && run.state === "running" && <p className="mt-1 text-xs text-sky-300">↪ The context is full: the session writes its summary of {run.summary_asked}; the next step runs in a fresh session.</p>}
          {run.state === "usage_wait" && run.resume_at && <p className="mt-1 text-xs text-zinc-500">Resumes by itself at {new Date(run.resume_at).toLocaleTimeString()}.</p>}
          <RetryNote run={run} />
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {active && run?.state !== "pausing" && <Button variant="quiet" disabled={busy} onClick={() => call({ action: "pause" })}>Pause after this step</Button>}
        {active && <Button variant="danger" disabled={busy} onClick={() => call({ action: "stop" })}>Stop now</Button>}
        {run && !ended && queue.status !== "stopped" && (run.state === "paused" || run.state === "halted") && <Button disabled={busy || !queue.approved} onClick={() => call({ action: "resume" })}>Resume</Button>}
      </div>
      {canStart && (!run || run.state === "finished" || run.state === "halted" || run.state === "paused") && (
        <div className={`${run ? "mt-4 border-t border-zinc-800 pt-3" : ""} flex flex-wrap items-end gap-3`}>
          <label className="text-xs text-zinc-400">
            <span className="mb-1 block">Session</span>
            <select value={session} onChange={(e) => setSession(e.target.value)} className="max-w-72 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-zinc-200">
              <option value="">New session</option>
              {reusable.map((s) => (
                <option key={s.id} value={s.id}>
                  Continue: {s.title ?? s.id.slice(-8)} ({s.runtime}){s.context ? ` (${s.context.topics.slice(0, 3).join(", ") || "has context"})` : ""}{s.live?.context_tokens && s.live.context_window ? ` · ${Math.round((100 * s.live.context_tokens) / s.live.context_window)}%` : ""}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs text-zinc-400">
            <span className="mb-1 block">Runtime</span>
            <select value={runtime} onChange={(e) => { setRuntime(e.target.value as "claude" | "codex"); setModel(""); setEffort(""); }} disabled={!!session} className="rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-zinc-200 disabled:opacity-50">
              <option value="claude">Claude Code</option>
              <option value="codex">Codex</option>
            </select>
          </label>
          <label className="max-w-full text-xs text-zinc-400">
            <span className="mb-1 block">Model</span>
            <ModelSelect runtime={runtime} value={model} onChange={setModel} disabled={!!session} className="max-w-full"
              defaultLabel={session ? "as before" : defaultModel ? `default: ${defaultModel}` : "runtime default"} />
          </label>
          <label className="text-xs text-zinc-400">
            <span className="mb-1 block">Effort</span>
            <EffortSelect runtime={runtime} model={model || (project.project.runtimes[runtime].model ?? "")} value={effort} onChange={setEffort}
              defaultLabel={session ? "as before" : defaultEffort ? `default: ${defaultEffort}` : "default"} />
          </label>
          <label className="text-xs text-zinc-400">
            <span className="mb-1 block">When</span>
            <select value={after} onChange={(e) => setAfter(e.target.value)} className="max-w-60 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-zinc-200">
              <option value="">Now</option>
              {chainable.map((x) => <option key={x.id} value={x.id}>When {x.id} is done{x.status === "done" ? " (it is: now)" : ""}</option>)}
            </select>
          </label>
          <Button disabled={busy} onClick={() => call({ action: "start", model: model || undefined, effort: effort || undefined, session: session || undefined, runtime: session ? undefined : runtime, after: after || undefined })}>
            {after ? `Start after ${after}` : run ? "Start a new run" : "Start"}
          </Button>
        </div>
      )}
      {!queue.approved && !active && <p className="text-sm text-zinc-500">Approve the queue's current revision to run it.</p>}
      {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
      <p className="mt-2 text-xs text-zinc-600">
        {runtime === "codex" ? "Codex" : "Claude Code"} runs in {queue.worktree && queue.worktree !== "auto" ? <span className="font-mono">{queue.worktree}</span> : queue.worktree === "auto" ? "a new worktree" : <span className="font-mono">{project.project.root}</span>}{runtime === "codex"
          ? ` with sandbox ${project.project.runtimes.codex.sandbox}, approvals ${project.project.runtimes.codex.approval_policy}.`
          : ` with permission mode ${project.project.runtimes.claude.permission_mode}.`}
      </p>
    </Section>
  );
}

const KIND_STYLE: Record<string, string> = {
  tool: "text-zinc-300", text: "text-zinc-100", tool_error: "text-red-300", error: "text-red-300",
  turn_start: "text-zinc-500", turn_end: "text-zinc-500", exit: "text-zinc-500", retry: "text-amber-300",
};
const KIND_ICON: Record<string, string> = { tool: "›", text: "¶", tool_error: "✗", error: "!", turn_start: "▸", turn_end: "■", exit: "■", retry: "↻" };

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
  const name = (k: string) => (k === "five_hour" ? "Claude 5h" : k === "seven_day" ? "Claude 7d" : k.startsWith("codex_") ? `Codex ${k.slice(6)}` : k.replace(/_/g, " "));
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
