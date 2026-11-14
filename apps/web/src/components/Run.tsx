// Running queues through Nexus-launched sessions: controls, live activity, sessions and usage.
import { useEffect, useState, type ReactNode } from "react";
import { HOLDING_RUN_STATES, formatClock, retryLine } from "@nexus/protocol/times";
import { act, enc, useFetch, type ActivityEntry, type ProjectState, type QueueView, type SessionView, type Usage } from "../api.ts";
import { Button, RunTimes, Section, TimeAgo } from "./ui.tsx";
import { EffortSelect, ModelSelect } from "./Settings.tsx";

// The run's state as a dot and a word: [dot, text].
const RUN_TONE: Record<string, [string, string]> = {
  running: ["bg-accent animate-pulse", "text-accent"],
  pausing: ["bg-warn", "text-warn"],
  paused: ["bg-fg-2", "text-fg-2"],
  halted: ["bg-stop", "text-stop"],
  finished: ["bg-ok", "text-ok"],
  usage_wait: ["bg-warn", "text-warn"],
  retry_wait: ["bg-warn", "text-warn"],
  approval_wait: ["bg-info", "text-info"],
};
const RunState = ({ state, children }: { state: string; children: ReactNode }) => (
  <span className={`inline-flex items-center gap-1.5 whitespace-nowrap text-xs font-medium ${RUN_TONE[state]?.[1] ?? "text-fg-2"}`}>
    <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${RUN_TONE[state]?.[0] ?? "bg-fg-3"}`} />{children}
  </span>
);
const RUN_LABEL: Record<string, string> = {
  running: "running", pausing: "pausing after this step", paused: "paused", halted: "halted",
  finished: "finished", usage_wait: "waiting for the usage window", retry_wait: "waiting to retry",
  approval_wait: "waiting for approval",
};

/** A pending retry, "Retry 2 of 5 at 14:05, overloaded", in amber; nothing for a run that is not waiting to retry. */
export function RetryNote({ run, className = "mt-1 text-xs" }: { run: NonNullable<QueueView["run"]>; className?: string }) {
  const line = retryLine(run, new Date());
  if (!line) return null;
  return <p className={`${className} text-warn`}>↻ {line[0]!.toUpperCase() + line.slice(1)}</p>;
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
    <ul className="mt-1 space-y-0.5 text-xs text-fg-2">
      {run.switches.map((s) => (
        <li key={s.to} className="flex gap-1.5">
          <span className="text-info">↪</span>
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

const AT = "@time", USAGE = "@usage-reset";

/** How long until a time, in words ("3 h 20 min", "12 days"), updated each minute. */
function Until({ at }: { at: string }) {
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((x) => x + 1), 60_000); return () => clearInterval(t); }, []);
  const min = Math.max(0, Math.round((Date.parse(at) - Date.now()) / 60_000));
  const text = min < 60 ? `${min} min` : min < 48 * 60 ? `${Math.floor(min / 60)} h${min % 60 ? ` ${min % 60} min` : ""}` : `${Math.round(min / 1440)} days`;
  return <>{text}</>;
}

/**
 * A planned start of the queue: the queue it waits for and why it has not come yet, or why it could not start; with
 * Cancel. Amber while it waits on something only the user or the orchestrator can change.
 */
function PlannedStart({ queue, busy, onCancel }: { queue: QueueView; busy: boolean; onCancel: () => void }) {
  const p = queue.start;
  if (!p) return null;
  const options = [p.session ? `continues session ${p.session.slice(-8)}` : p.runtime === "codex" ? "Codex" : p.runtime === "claude" ? "Claude Code" : undefined, p.model, p.effort && `${p.effort} effort`].filter(Boolean);
  const tone = p.failed ? "border-stop/30 bg-stop/10" : p.blocked ? "border-warn/30 bg-warn/10" : "border-info/30 bg-info/10";
  return (
    <div className={`mb-3 rounded-lg border p-3 text-sm ${tone}`}>
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <p className="min-w-0 flex-1">
          {p.after
            ? (p.failed
              ? <span className="text-stop">It was to start when <span className="font-mono">{p.after}</span> was done, but could not: {p.failed.reason}</span>
              : <span className="text-fg">Starts when <span className="font-mono">{p.after}</span> is done.</span>)
            : (p.failed
              ? <span className="text-stop">It was to start at {formatClock(p.at!, new Date())}, but did not: {p.failed.reason}</span>
              : <span className="text-fg">Starts at <span className="font-medium">{formatClock(p.at!, new Date())}</span>{p.usage ? `, when the ${p.usage === "codex" ? "Codex" : "Claude Code"} usage window resets` : ""}.</span>)}
          <span className="mt-1 block text-xs text-fg-2">
            {p.failed ? <>Start it yourself, or dismiss the plan. · <TimeAgo at={p.failed.at} /></>
              : p.held ? <>{p.after ? <><span className="font-mono">{p.after}</span> is done</> : "Its time came"}; it {p.held.reason}. It starts by itself once it may.</>
              : p.after ? <>Now: {p.waiting}.</> : <>In <Until at={p.at!} />. It must be approved then, and its session free.</>}
          </span>
          <span className="mt-1 block text-xs text-fg-3">
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

/** Start, pause, stop and resume a queue's run. */
export function RunControls({ project, queue, onChanged }: { project: ProjectState; queue: QueueView; onChanged: () => void }) {
  const id = project.project.id;
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [runtime, setRuntime] = useState<"claude" | "codex">(project.project.runtimes.default);
  const defaultModel = project.project.runtimes[runtime].model;
  const defaultEffort = project.project.runtimes[runtime].effort;
  const [session, setSession] = useState("");
  // "When": "" now, AT a time, USAGE the usage window's reset, else a queue to start after.
  const [after, setAfter] = useState("");
  const [time, setTime] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const run = queue.run;
  // A run that holds its session: going on by itself, or waiting for the approval of the queue's new revision.
  const active = run && HOLDING_RUN_STATES.includes(run.state);
  const waitsApproval = run?.state === "approval_wait";
  const call = async (body: Record<string, unknown>) => {
    setBusy(true); setError(undefined);
    try { await act(id, "POST", `/queues/${enc(queue.id)}/run`, body); onChanged(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const reusable = project.sessions.filter((s) => s.role === "worker" && s.runtime !== "external" && s.launched_by === "nexus" && s.native_id
    && !project.queues.some((q) => q.id !== queue.id && q.run?.session === s.id && HOLDING_RUN_STATES.includes(q.run.state)));
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
        <p className="mb-3 text-xs text-fg-2">
          <span className="text-info">→</span> When this queue is done, {queue.starts_next.map((x, i) => <span key={x}>{i ? ", " : ""}<span className="font-mono text-fg">{x}</span></span>)} start{queue.starts_next.length === 1 ? "s" : ""}.
        </p>
      )}
      {run && (
        <div className="mb-3 rounded-lg bg-surface-2 p-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <RunState state={shown!.state}>{ended ? "ended" : RUN_LABEL[run.state]}</RunState>
            {run.step && <span className="font-mono text-xs text-fg-2">at {run.step}</span>}
            <span className="text-xs text-fg-3">since <TimeAgo at={run.updated_at} /></span>
          </div>
          <div className="mt-1 flex flex-wrap gap-x-3 text-xs text-fg-2"><RunTimes run={shown!} /></div>
          {run.reason && (ended
            ? <p className="mt-1 text-xs text-fg-3">The queue is done. The run's last note: {run.reason}</p>
            : <p className="mt-1 text-fg">{run.reason}</p>)}
          {runSession && <p className="mt-1 text-xs text-fg-3">Session: {runSession.title ?? runSession.id} {runSession.live?.model ? `· ${runSession.live.model}` : ""}{runSession.effort ? ` · ${runSession.effort} effort` : ""} <ContextBar s={runSession} /></p>}
          {run.after && <p className="mt-1 text-xs text-fg-3">Started by its plan when <span className="font-mono">{run.after}</span> was done.</p>}
          <SessionSwitches run={run} sessions={project.sessions} />
          {run.summary_asked && run.state === "running" && <p className="mt-1 text-xs text-info">↪ The context is full: the session writes its summary of {run.summary_asked}; the next step runs in a fresh session.</p>}
          {run.state === "usage_wait" && run.resume_at && <p className="mt-1 text-xs text-fg-3">Resumes by itself at {new Date(run.resume_at).toLocaleTimeString()}.</p>}
          {waitsApproval && <p className="mt-1 text-xs text-info">Its last step ended while revision {queue.revision} waits for your approval: once you approve it, the run goes on by itself, in this session.</p>}
          <RetryNote run={run} />
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {active && run?.state !== "pausing" && <Button variant="quiet" disabled={busy} onClick={() => call({ action: "pause" })}>{waitsApproval ? "Pause" : "Pause after this step"}</Button>}
        {active && !waitsApproval && <Button variant="danger" disabled={busy} onClick={() => call({ action: "stop" })}>Stop now</Button>}
        {run && !ended && queue.status !== "stopped" && (run.state === "paused" || run.state === "halted") && <Button disabled={busy || !queue.approved} onClick={() => call({ action: "resume" })}>Resume</Button>}
      </div>
      {canStart && (!run || run.state === "finished" || run.state === "halted" || run.state === "paused") && (
        <div className={`${run ? "mt-4 border-t border-line pt-3" : ""} flex flex-wrap items-end gap-3`}>
          <label className="text-xs text-fg-2">
            <span className="mb-1 block">Session</span>
            <select value={session} onChange={(e) => setSession(e.target.value)} className="max-w-72 rounded-md border border-line-strong bg-canvas px-2 py-1 text-sm text-fg">
              <option value="">New session</option>
              {reusable.map((s) => (
                <option key={s.id} value={s.id}>
                  Continue: {s.title ?? s.id.slice(-8)} ({s.runtime}){s.context ? ` (${s.context.topics.slice(0, 3).join(", ") || "has context"})` : ""}{s.live?.context_tokens && s.live.context_window ? ` · ${Math.round((100 * s.live.context_tokens) / s.live.context_window)}%` : ""}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs text-fg-2">
            <span className="mb-1 block">Runtime</span>
            <select value={runtime} onChange={(e) => { setRuntime(e.target.value as "claude" | "codex"); setModel(""); setEffort(""); }} disabled={!!session} className="rounded-md border border-line-strong bg-canvas px-2 py-1 text-sm text-fg disabled:opacity-50">
              <option value="claude">Claude Code</option>
              <option value="codex">Codex</option>
            </select>
          </label>
          <label className="max-w-full text-xs text-fg-2">
            <span className="mb-1 block">Model</span>
            <ModelSelect runtime={runtime} value={model} onChange={setModel} disabled={!!session} className="max-w-full"
              defaultLabel={session ? "as before" : defaultModel ? `default: ${defaultModel}` : "runtime default"} />
          </label>
          <label className="text-xs text-fg-2">
            <span className="mb-1 block">Effort</span>
            <EffortSelect runtime={runtime} model={model || (project.project.runtimes[runtime].model ?? "")} value={effort} onChange={setEffort}
              defaultLabel={session ? "as before" : defaultEffort ? `default: ${defaultEffort}` : "default"} />
          </label>
          <label className="text-xs text-fg-2">
            <span className="mb-1 block">When</span>
            <select value={after} onChange={(e) => setAfter(e.target.value)} className="max-w-60 rounded-md border border-line-strong bg-canvas px-2 py-1 text-sm text-fg">
              <option value="">Now</option>
              <option value={AT}>At a time…</option>
              <option value={USAGE}>When the usage window resets</option>
              {chainable.map((x) => <option key={x.id} value={x.id}>When {x.id} is done{x.status === "done" ? " (it is: now)" : ""}</option>)}
            </select>
          </label>
          {after === AT && (
            <label className="text-xs text-fg-2">
              <span className="mb-1 block">Time</span>
              <input type="datetime-local" value={time} onChange={(e) => setTime(e.target.value)} className="rounded-md border border-line-strong bg-canvas px-2 py-1 text-sm text-fg" />
            </label>
          )}
          <Button disabled={busy || (after === AT && !time)} onClick={() => call({
            action: "start", model: model || undefined, effort: effort || undefined, session: session || undefined, runtime: session ? undefined : runtime,
            ...(after === AT ? { at: new Date(time).toISOString() } : after === USAGE ? { at: "usage-reset" } : after ? { after } : {}),
          })}>
            {after === AT || after === USAGE ? "Schedule" : after ? `Start after ${after}` : run ? "Start a new run" : "Start"}
          </Button>
        </div>
      )}
      {!queue.approved && !active && <p className="text-sm text-fg-3">Approve the queue's current revision to run it.</p>}
      {error && <p className="mt-2 text-xs text-danger">{error}</p>}
      <p className="mt-2 text-xs text-fg-3 wrap-anywhere">
        {runtime === "codex" ? "Codex" : "Claude Code"} runs in {queue.worktree && queue.worktree !== "auto" ? <span className="font-mono">{queue.worktree}</span> : queue.worktree === "auto" ? "a new worktree" : <span className="font-mono">{project.project.root}</span>}{runtime === "codex"
          ? ` with sandbox ${project.project.runtimes.codex.sandbox}, approvals ${project.project.runtimes.codex.approval_policy}.`
          : ` with permission mode ${project.project.runtimes.claude.permission_mode}.`}
      </p>
    </Section>
  );
}

const KIND_STYLE: Record<string, string> = {
  tool: "text-fg", text: "text-fg", tool_error: "text-danger", error: "text-danger",
  turn_start: "text-fg-3", turn_end: "text-fg-3", exit: "text-fg-3", retry: "text-warn",
};
const KIND_ICON: Record<string, string> = { tool: "›", text: "¶", tool_error: "✗", error: "!", turn_start: "▸", turn_end: "■", exit: "■", retry: "↻" };

/** What the agent did during a step, from the runtime's stream. */
export function Activity({ project, session, queue, step, version }: { project: string; session: string; queue: string; step: string; version: unknown }) {
  const items = useFetch<ActivityEntry[]>(`/api/projects/${enc(project)}/sessions/${enc(session)}/activity?queue=${enc(queue)}&step=${enc(step)}`, version);
  const [all, setAll] = useState(false);
  if (!items?.length) return null;
  const shown = all ? items : items.slice(-40);
  return (
    <Section title="Agent activity" aside={items.length > 40 && <button className="text-xs text-accent" onClick={() => setAll(!all)}>{all ? "Latest only" : `All ${items.length}`}</button>}>
      <ol className="scroll-thin max-h-96 space-y-1 overflow-y-auto rounded-lg bg-canvas p-3 font-mono text-xs">
        {shown.map((a, i) => (
          <li key={i} className={`flex gap-2 ${KIND_STYLE[a.kind] ?? "text-fg-2"}`}>
            <span className="w-14 shrink-0 text-fg-3">{new Date(a.at).toLocaleTimeString("en-GB")}</span>
            <span className="w-3 shrink-0 text-fg-3">{KIND_ICON[a.kind] ?? "·"}</span>
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
      <span className="inline-block h-1.5 w-16 overflow-hidden rounded bg-surface-3">
        <span className={`block h-full ${pct > 60 ? "bg-warn" : "bg-info"}`} style={{ width: `${Math.max(2, pct)}%` }} />
      </span>
      <span className="text-fg-3">{pct}%</span>
    </span>
  );
}

/** The subscription's windows, from the latest report of any session. */
export function UsageMeter({ version, always, stacked }: {
  version: unknown; always?: boolean;
  /** At a desktop sidebar's foot: one row per window, its name, a bar and the percentage. */
  stacked?: boolean;
}) {
  const u = useFetch<Usage | null>("/api/usage", version);
  const none = always ? <span className="text-xs text-fg-3">No session has reported it yet.</span> : null;
  if (!u) return none;
  const windows = Object.entries(u.windows).filter(([, w]) => !w.resets_at || Date.parse(w.resets_at) > Date.now());
  if (!windows.length) return none;
  const name = (k: string) => (k === "five_hour" ? "Claude 5h" : k === "seven_day" ? "Claude 7d" : k.startsWith("codex_") ? `Codex ${k.slice(6)}` : k.replace(/_/g, " "));
  const fill = (pct: number) => (pct >= 90 ? "bg-danger" : pct >= 70 ? "bg-warn" : "bg-ok");
  if (stacked) {
    return (
      <div className="space-y-1.5" title={`Reported ${new Date(u.updated_at).toLocaleString()}`}>
        {windows.map(([k, w]) => {
          const pct = Math.round(w.utilization * 100);
          return (
            <div key={k} className="grid grid-cols-[4.5rem_1fr_2.25rem] items-center gap-2 text-xs text-fg-3" title={w.resets_at ? `resets ${new Date(w.resets_at).toLocaleString()}` : undefined}>
              <span className="truncate">{name(k)}</span>
              <span className="h-1 overflow-hidden rounded-sm bg-surface-3"><span className={`block h-full ${fill(pct)}`} style={{ width: `${Math.max(2, pct)}%` }} /></span>
              <span className="text-right">{pct}%</span>
            </div>
          );
        })}
      </div>
    );
  }
  return (
    <span className={`${always ? "flex flex-wrap" : "hidden sm:flex"} items-center gap-3 text-xs text-fg-3`} title={`Reported ${new Date(u.updated_at).toLocaleString()}`}>
      {windows.map(([k, w]) => {
        const pct = Math.round(w.utilization * 100);
        return (
          <span key={k} className="flex items-center gap-1.5" title={w.resets_at ? `resets ${new Date(w.resets_at).toLocaleString()}` : undefined}>
            {name(k)}
            <span className="inline-block h-1.5 w-12 overflow-hidden rounded bg-surface-3">
              <span className={`block h-full ${fill(pct)}`} style={{ width: `${Math.max(2, pct)}%` }} />
            </span>
            {pct}%
          </span>
        );
      })}
    </span>
  );
}
