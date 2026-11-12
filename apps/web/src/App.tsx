import { useEffect, useMemo, useRef, useState } from "react";
import type { QueueStatus } from "@nexus/protocol";
import { useLive, useProjectState, useProjects, type AttentionItem, type QueueView } from "./api.ts";
import { QueueRow } from "./components/QueueRow.tsx";
import { QueueDetail, StepDetail } from "./components/Details.tsx";
import { Drawer, SIDE_LEFT, SIDE_RIGHT, StatusBadge, TimeAgo, useWide } from "./components/ui.tsx";
import { AttentionPanel, NotifyToggle, useNotifications, WaitingButton, WaitingList } from "./components/Attention.tsx";
import { ContextBar, UsageMeter } from "./components/Run.tsx";
import { ChatPanel, ConversationsButton, ConversationsPanel, OrchestratorButton, useOrchestrator } from "./components/Chat.tsx";
import { RemoteButton, RemotePanel } from "./components/Remote.tsx";
import { ProjectPicker, ProjectTabs } from "./components/Projects.tsx";
import { isOpen } from "./layers.ts";
import { nav, useNav } from "./nav.ts";
import { SettingsButton, SettingsPanel, UpdatePill, useServer } from "./components/Settings.tsx";

const GROUPS: { title: string; statuses: QueueStatus[]; collapsible?: boolean }[] = [
  { title: "Finished", statuses: ["done", "cancelled"], collapsible: true },
  { title: "In progress", statuses: ["running", "waiting", "stopped", "paused"] },
  { title: "Planned", statuses: ["approved", "proposed", "draft"] },
];

/**
 * The selection lives in the URL hash: #/<project>[/<queue>[/<step>]]; what is open over it, in the history entry
 * (nav.ts), so that Back closes the topmost layer.
 */
function useRoute() {
  const n = useNav();
  const parts = n.hash.replace(/^#\/?/, "").split("/").map(decodeURIComponent).filter(Boolean);
  return { project: parts[0], queue: parts[1], step: parts[2], nav: n };
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
  const server = useServer(tick);
  // Each panel is a layer in the browser history: opening pushes an entry, closing (or Back) pops it.
  const ideasOpen = isOpen(route.nav, "ideas");
  const settingsOpen = isOpen(route.nav, "settings");
  const remoteOpen = isOpen(route.nav, "remote");
  const chatOpen = isOpen(route.nav, "chat");
  const waitingOpen = isOpen(route.nav, "waiting");

  const byGroup = useMemo(() => {
    const order = (q: QueueView) => q.updated ?? q.updated_at ?? "";
    return GROUPS.map((g) => ({
      ...g,
      queues: (state?.queues ?? []).filter((q) => g.statuses.includes(q.status)).sort((a, b) => order(b).localeCompare(order(a))),
    }));
  }, [state]);

  const queue = state?.queues.find((q) => q.id === route.queue);
  const step = queue?.steps.find((s) => s.id === route.step);
  const close = () => nav.close("item");

  // On a wide screen a step's details sit on the left and a chat on the right, below the header, and the queue
  // list keeps the room between them; elsewhere both are layers over the page.
  const wide = useWide();
  const itemShown = !!(state && queue);
  const header = useRef<HTMLElement>(null);
  useEffect(() => {
    const h = header.current;
    if (!h) return;
    const set = () => document.documentElement.style.setProperty("--header-h", `${h.getBoundingClientRect().height}px`);
    set();
    const o = new ResizeObserver(set);
    o.observe(h);
    return () => o.disconnect();
  }, []);

  return (
    <div className="flex min-h-full flex-col">
      <header ref={header} className="sticky top-0 z-30 border-b border-zinc-800 bg-zinc-950/90 pt-[env(safe-area-inset-top)] backdrop-blur">
        {/* On a phone the header has two rows: the project and what waits for you, then the tools. */}
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-2 gap-y-2.5 px-4 py-3 sm:flex-nowrap sm:gap-4">
          {/* On a phone the project picker takes the wordmark's place: the current project is what matters there. */}
          <span className="hidden text-lg font-semibold tracking-tight text-zinc-50 sm:inline">Nexus</span>
          {projects && <ProjectTabs projects={projects} current={projectId} onPick={(id) => nav.project(id)} />}
          {projects && <ProjectPicker projects={projects} current={projectId} open={isOpen(route.nav, "projects")} onPick={(id) => nav.project(id)} />}
          <WaitingButton projects={projects} onClick={() => nav.open("waiting")} />
          <div className="basis-full sm:hidden" />
          <UpdatePill info={server} />
          {projectId && <ConversationsButton onClick={() => nav.open("ideas")} />}
          {projectId && <OrchestratorButton view={orchestrator} onClick={() => nav.open("chat")} />}
          <UsageMeter version={tick} />
          <NotifyToggle {...notify} />
          {state && <SettingsButton onClick={() => nav.open("settings")} />}
          <RemoteButton onClick={() => nav.open("remote")} />
          <span className={`ml-auto flex items-center gap-1.5 text-xs sm:ml-0 ${connected ? "text-zinc-500" : "text-orange-400"}`} title={connected ? "Live updates on" : "Reconnecting"}>
            <span className={`h-2 w-2 rounded-full ${connected ? "bg-emerald-500" : "bg-orange-500"}`} />
            <span className="hidden sm:inline">{connected ? "live" : "offline"}</span>
          </span>
        </div>
      </header>

      <main className="@container mx-auto w-full max-w-7xl flex-1 px-4 py-6"
        style={wide && (itemShown || chatOpen || ideasOpen) ? { maxWidth: "none", marginLeft: itemShown ? SIDE_LEFT : 0, marginRight: chatOpen || ideasOpen ? SIDE_RIGHT : 0, width: "auto" } : undefined}>
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
          <AttentionPanel items={state.attention} onOpen={(a: AttentionItem) => { if (projectId && a.queue) nav.item(projectId, a.queue, a.step); }} />
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
                    <button key={q.id} onClick={() => projectId && nav.item(projectId, q.id)} className="flex items-center gap-2 rounded-lg border border-zinc-800 px-3 py-1.5 text-sm text-zinc-400 hover:border-zinc-700 hover:text-zinc-200">
                      <span className="font-mono text-zinc-500">{q.id}</span>{q.title}<StatusBadge status={q.status} />
                    </button>
                  ))}
                </div>
              )}
              <div className="space-y-3">
                {shown.map((q) => (
                  <QueueRow key={q.id} queue={q} onQueue={() => projectId && nav.item(projectId, q.id)} onStep={(s) => projectId && nav.item(projectId, q.id, s)} />
                ))}
              </div>
              {g.queues.length === 0 && <p className="text-sm text-zinc-600">Nothing here.</p>}
            </section>
          );
        })}

        {state && state.sessions.some((s) => s.role === "worker" || s.role === "orchestrator") && (
          <section className="mb-8">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-zinc-400">Sessions</h2>
            <div className="overflow-x-auto rounded-xl border border-zinc-800">
              <table className="w-full text-left text-sm">
                <thead className="text-xs text-zinc-500"><tr>{["Session", "Role", "Runtime", "Queue", "State", "Context", "Last event"].map((h) => <th key={h} className="px-3 py-2 font-medium">{h}</th>)}</tr></thead>
                <tbody>
                  {state.sessions.filter((s) => s.role === "worker" || s.role === "orchestrator").map((s) => (
                    <tr key={s.id} className="border-t border-zinc-800/80">
                      <td className="px-3 py-2"><span className="text-zinc-200">{s.title ?? s.id.slice(-8)}</span></td>
                      <td className="px-3 py-2 text-zinc-400">{s.role}</td>
                      <td className="px-3 py-2 text-zinc-400">{s.runtime}{s.launched_by === "external" ? " (external)" : ""}</td>
                      <td className="px-3 py-2 font-mono text-zinc-400">{s.queue ?? "-"}</td>
                      <td className="px-3 py-2 text-zinc-400">{s.live ? `${s.live.state}${s.live.model ? ` · ${s.live.model.replace(/^claude-/, "")}` : ""}${s.effort ? ` · ${s.effort}` : ""}` : "-"}</td>
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

      {ideasOpen && projectId && state && (
        <ConversationsPanel project={projectId} name={state.project.name} version={tick} defaultRuntime={state.project.conversations.runtime}
          onClose={() => nav.close("ideas")} onChanged={() => setTick((t) => t + 1)} />
      )}

      {chatOpen && projectId && (
        <ChatPanel project={projectId} name={state?.project.name ?? projectId} view={orchestrator} onClose={() => nav.close("chat")} onChanged={() => setTick((t) => t + 1)} />
      )}

      <Drawer open={settingsOpen && !!state} onClose={() => nav.close("settings")}>
        {state && <SettingsPanel key={state.project.id} project={state.project} onChanged={() => { reload(); setTick((t) => t + 1); }} server={server} />}
      </Drawer>

      <Drawer open={waitingOpen} onClose={() => nav.close("waiting")}>
        <WaitingList projects={projects ?? []} onOpen={(w) => nav.closeThenItem("waiting", w.project, w.queue, w.step)} />
      </Drawer>

      <Drawer open={remoteOpen} onClose={() => nav.close("remote")}>
        <RemotePanel version={tick} />
      </Drawer>

      <Drawer open={itemShown} onClose={close} left={wide}>
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
