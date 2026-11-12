import { useCallback, useEffect, useMemo, useState } from "react";
import type { QueueStatus } from "@nexus/protocol";
import { useLive, useProjectState, useProjects, type AttentionItem, type QueueView } from "./api.ts";
import { QueueRow } from "./components/QueueRow.tsx";
import { QueueDetail, StepDetail } from "./components/Details.tsx";
import { Drawer, StatusBadge, TimeAgo } from "./components/ui.tsx";
import { AttentionPanel, NotifyToggle, useNotifications } from "./components/Attention.tsx";
import { ContextBar, UsageMeter } from "./components/Run.tsx";
import { ChatPanel, OrchestratorButton, useOrchestrator } from "./components/Chat.tsx";

const GROUPS: { title: string; statuses: QueueStatus[]; collapsible?: boolean }[] = [
  { title: "Finished", statuses: ["done", "cancelled"], collapsible: true },
  { title: "In progress", statuses: ["running", "waiting", "stopped", "paused"] },
  { title: "Planned", statuses: ["approved", "proposed", "draft"] },
];

/** The selection lives in the URL hash: #/<project>[/<queue>[/<step>]]. */
function useRoute() {
  const parse = () => location.hash.replace(/^#\/?/, "").split("/").map(decodeURIComponent).filter(Boolean);
  const [parts, setParts] = useState(parse);
  useEffect(() => {
    const f = () => setParts(parse());
    window.addEventListener("hashchange", f);
    return () => window.removeEventListener("hashchange", f);
  }, []);
  const go = useCallback((...p: (string | undefined)[]) => {
    location.hash = "/" + p.filter((x): x is string => !!x).map(encodeURIComponent).join("/");
  }, []);
  return { project: parts[0], queue: parts[1], step: parts[2], go };
}

export function App() {
  const route = useRoute();
  const { projects, error: projectsError, reload: reloadProjects } = useProjects();
  const projectId = route.project ?? projects?.[0]?.id;
  const { state, error, reload } = useProjectState(projectId);
  const [showFinished, setShowFinished] = useState(false);

  const [tick, setTick] = useState(0);
  const connected = useLive((m) => {
    setTick((t) => t + 1);
    if (m.type === "projects" || m.type === "reconnected") reloadProjects();
    if ((m.type === "changed" && m.project === projectId) || m.type === "reconnected") reload();
    if (m.type === "changed") reloadProjects();
  });

  const notify = useNotifications(projects);
  const orchestrator = useOrchestrator(projectId, tick);
  const [chatOpen, setChatOpen] = useState(() => new URLSearchParams(location.search).has("chat"));

  const byGroup = useMemo(() => {
    const order = (q: QueueView) => q.updated ?? q.updated_at ?? "";
    return GROUPS.map((g) => ({
      ...g,
      queues: (state?.queues ?? []).filter((q) => g.statuses.includes(q.status)).sort((a, b) => order(b).localeCompare(order(a))),
    }));
  }, [state]);

  const queue = state?.queues.find((q) => q.id === route.queue);
  const step = queue?.steps.find((s) => s.id === route.step);
  const close = useCallback(() => route.go(projectId), [route, projectId]);

  return (
    <div className="flex min-h-full flex-col">
      <header className="sticky top-0 z-30 border-b border-zinc-800 bg-zinc-950/90 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center gap-4 px-4 py-3">
          <span className="text-lg font-semibold tracking-tight text-zinc-50">Nexus</span>
          <nav className="scroll-thin flex flex-1 gap-1 overflow-x-auto">
            {projects?.map((p) => (
              <button
                key={p.id}
                onClick={() => route.go(p.id)}
                className={`flex shrink-0 items-center gap-2 rounded-lg px-3 py-1.5 text-sm ${p.id === projectId ? "bg-zinc-800 text-zinc-50" : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"}`}
              >
                {p.name}
                {p.attention.length > 0 && <span className="rounded-full bg-amber-500/20 px-1.5 text-xs text-amber-300" title="Waiting for you">{p.attention.length}</span>}
                {p.running > 0 && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-blue-400" title={`${p.running} running`} />}
              </button>
            ))}
          </nav>
          {projectId && <OrchestratorButton view={orchestrator} onClick={() => setChatOpen(true)} />}
          <UsageMeter version={tick} />
          <NotifyToggle {...notify} />
          <span className={`flex items-center gap-1.5 text-xs ${connected ? "text-zinc-500" : "text-orange-400"}`} title={connected ? "Live updates on" : "Reconnecting"}>
            <span className={`h-2 w-2 rounded-full ${connected ? "bg-emerald-500" : "bg-orange-500"}`} />
            {connected ? "live" : "offline"}
          </span>
        </div>
      </header>

      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6">
        {projectsError && <Banner>Cannot reach the Nexus server: {projectsError}</Banner>}
        {projects?.length === 0 && (
          <Banner>No projects yet. Register one with <code>nexus project add &lt;path&gt;</code>.</Banner>
        )}
        {error && <Banner>{error}</Banner>}
        {state && state.warnings.length > 0 && (
          <details className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm text-amber-200">
            <summary className="cursor-pointer">{state.warnings.length} warning(s) reading the project files</summary>
            <ul className="mt-2 list-disc pl-5 text-xs text-amber-200/80">{state.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
          </details>
        )}

        {state && state.attention.length > 0 && (
          <AttentionPanel items={state.attention} onOpen={(a: AttentionItem) => route.go(projectId, a.queue, a.step)} />
        )}

        {state && byGroup.map((g) => {
          const hidden = g.collapsible && !showFinished;
          const shown = hidden ? [] : g.queues;
          return (
            <section key={g.title} className="mb-8">
              <div className="mb-3 flex items-baseline gap-3">
                <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-400">{g.title}</h2>
                <span className="text-xs text-zinc-600">{g.queues.length}</span>
                {g.collapsible && g.queues.length > 0 && (
                  <button onClick={() => setShowFinished(!showFinished)} className="text-xs text-sky-400 hover:text-sky-300">
                    {showFinished ? "Hide" : "Show"}
                  </button>
                )}
              </div>
              {hidden && g.queues.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {g.queues.map((q) => (
                    <button key={q.id} onClick={() => route.go(projectId, q.id)} className="flex items-center gap-2 rounded-lg border border-zinc-800 px-3 py-1.5 text-sm text-zinc-400 hover:border-zinc-700 hover:text-zinc-200">
                      <span className="font-mono text-zinc-500">{q.id}</span>{q.title}<StatusBadge status={q.status} />
                    </button>
                  ))}
                </div>
              )}
              <div className="space-y-3">
                {shown.map((q) => (
                  <QueueRow key={q.id} queue={q} onQueue={() => route.go(projectId, q.id)} onStep={(s) => route.go(projectId, q.id, s)} />
                ))}
              </div>
              {g.queues.length === 0 && <p className="text-sm text-zinc-600">Nothing here.</p>}
            </section>
          );
        })}

        {state && state.sessions.some((s) => s.role !== "user") && (
          <section className="mb-8">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-zinc-400">Sessions</h2>
            <div className="overflow-x-auto rounded-xl border border-zinc-800">
              <table className="w-full text-left text-sm">
                <thead className="text-xs text-zinc-500"><tr>{["Session", "Role", "Runtime", "Queue", "State", "Context", "Last event"].map((h) => <th key={h} className="px-3 py-2 font-medium">{h}</th>)}</tr></thead>
                <tbody>
                  {state.sessions.filter((s) => s.role !== "user").map((s) => (
                    <tr key={s.id} className="border-t border-zinc-800/80">
                      <td className="px-3 py-2"><span className="text-zinc-200">{s.title ?? s.id.slice(-8)}</span></td>
                      <td className="px-3 py-2 text-zinc-400">{s.role}</td>
                      <td className="px-3 py-2 text-zinc-400">{s.runtime}{s.launched_by === "external" ? " (external)" : ""}</td>
                      <td className="px-3 py-2 font-mono text-zinc-400">{s.queue ?? "-"}</td>
                      <td className="px-3 py-2 text-zinc-400">{s.live ? `${s.live.state}${s.live.model ? ` · ${s.live.model.replace(/^claude-/, "")}` : ""}` : "-"}</td>
                      <td className="px-3 py-2"><ContextBar s={s} /></td>
                      <td className="px-3 py-2 text-zinc-500">{s.last_event ? <>{s.last_event} · <TimeAgo at={s.last_event_at} /></> : "-"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </main>

      {chatOpen && projectId && (
        <ChatPanel project={projectId} name={state?.project.name ?? projectId} view={orchestrator} onClose={() => setChatOpen(false)} onChanged={() => setTick((t) => t + 1)} />
      )}

      <Drawer open={!!(state && queue)} onClose={close}>
        {state && queue && (step
          ? <StepDetail project={state} queue={queue} step={step} onChanged={reload} />
          : <QueueDetail project={state} queue={queue} onChanged={reload} />)}
      </Drawer>
    </div>
  );
}

function Banner({ children }: { children: React.ReactNode }) {
  return <div className="mb-4 rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-3 text-sm text-zinc-300">{children}</div>;
}
