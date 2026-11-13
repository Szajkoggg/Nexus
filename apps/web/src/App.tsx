import { useEffect, useMemo, useRef, useState } from "react";
import type { QueueStatus } from "@nexus/protocol";
import { useLive, useProjectState, useProjects, type AttentionItem, type QueueView } from "./api.ts";
import { QueueRow } from "./components/QueueRow.tsx";
import { QueueDetail, StepDetail } from "./components/Details.tsx";
import { Button, Drawer, Section, SIDE_LEFT, SIDE_RIGHT, TimeAgo, useWide } from "./components/ui.tsx";
import { AttentionPanel, attentionTarget, NotifyToggle, useNotifications, WaitingButton, WaitingList } from "./components/Attention.tsx";
import { ContextBar, UsageMeter } from "./components/Run.tsx";
import { ChatPanel, ConversationsButton, ConversationsPanel, OrchestratorButton, useOrchestrator } from "./components/Chat.tsx";
import { RemoteButton, RemotePanel } from "./components/Remote.tsx";
import { ProjectPicker, ProjectTabs } from "./components/Projects.tsx";
import { isOpen, panelOrder, phoneView } from "./layers.ts";
import { usePhone } from "./phone.ts";
import { BottomBar, RunningNow } from "./components/Phone.tsx";
import { waitingPosition } from "./waiting.ts";
import { mergeAttention } from "@nexus/protocol/attention";
import { nav, useNav } from "./nav.ts";
import { SettingsButton, SettingsPanel, UpdatePill, useServer } from "./components/Settings.tsx";
import { ProjectRefusals } from "./components/Refusals.tsx";
import { FinishedGroup } from "./components/Finished.tsx";
import { splitFinished } from "./finished.ts";

// Finished queues (done, cancelled) fold into one group at the bottom (FinishedGroup); one that still waits for the
// user stays in progress until nothing waits.
const GROUPS: { title: string; statuses: QueueStatus[] }[] = [
  { title: "In progress", statuses: ["running", "waiting", "stopped", "paused", "done", "cancelled"] },
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

  const { byGroup, finished } = useMemo(() => {
    const order = (q: QueueView) => q.updated ?? q.updated_at ?? "";
    const split = splitFinished(state?.queues ?? [], new Set((state?.attention ?? []).map((a) => a.queue).filter((x): x is string => !!x)));
    return {
      finished: split.finished,
      byGroup: GROUPS.map((g) => ({
        ...g,
        queues: split.active.filter((q) => g.statuses.includes(q.status)).sort((a, b) => order(b).localeCompare(order(a))),
      })),
    };
  }, [state]);

  const queue = state?.queues.find((q) => q.id === route.queue);
  const step = queue?.steps.find((s) => s.id === route.step);
  const close = () => nav.close("item");
  // Below 1024 px: the phone layout, with a tab instead of the chat, Ideas and waiting layers (layers.ts phoneView).
  const phone = usePhone();
  const tab = phone ? phoneView(route.nav).tab : undefined;
  const waiting = useMemo(() => mergeAttention(projects ?? []), [projects]);
  // On the phone an item that waits for the user says where it stands in the waiting list: "2 of 6".
  const place = phone && projectId && route.queue ? waitingPosition(waiting, { project: projectId, queue: route.queue, step: route.step }) : undefined;
  const of = place?.at ? `${place.at} of ${place.total} waiting` : undefined;

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
  }, [phone]);

  const banners = <>
    {projectsError && <Banner>Cannot reach the Nexus server: {projectsError}</Banner>}
    {projects?.length === 0 && (
      <Banner>No projects yet. Register one with <code>nexus project add &lt;path&gt;</code>.</Banner>
    )}
    {error && <Banner>{error}</Banner>}
    {state && state.warnings.length > 0 && (
      <details className="mb-4 rounded-lg border border-warn/30 bg-warn/5 px-3 py-2 text-sm text-warn">
        <summary className="cursor-pointer">{state.warnings.length} warning(s) reading the project files</summary>
        <ul className="mt-2 list-disc pl-5 text-xs text-warn/80">{state.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
      </details>
    )}
  </>;

  // The project's queues (the desktop's page; the phone's Queues tab, where what waits has a tab of its own).
  const queuesPage = <>
    {state && byGroup.map((g) => (
      <section key={g.title} className="mb-8">
        <div className="mb-3 flex items-baseline gap-3">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-fg-2">{g.title}</h2>
          <span className="text-xs text-fg-3">{g.queues.length}</span>
        </div>
        <div className="space-y-3">
          {g.queues.map((q) => (
            <QueueRow key={q.id} queue={q} onQueue={() => projectId && nav.item(projectId, q.id)} onStep={(s) => projectId && nav.item(projectId, q.id, s)} />
          ))}
        </div>
        {g.queues.length === 0 && <p className="text-sm text-fg-3">Nothing here.</p>}
      </section>
    ))}

    {state && projectId && <FinishedGroup project={projectId} rows={finished} onOpen={(id) => nav.item(projectId, id)} />}

    {state && <ProjectRefusals project={state} />}

    {state && state.sessions.some((s) => s.role === "worker" || s.role === "orchestrator") && (
      <section className="mb-8">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-fg-2">Sessions</h2>
        <div className="overflow-x-auto rounded-xl border border-line">
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-fg-3"><tr>{["Session", "Role", "Runtime", "Queue", "State", "Context", "Last event"].map((h) => <th key={h} className="px-3 py-2 font-medium">{h}</th>)}</tr></thead>
            <tbody>
              {state.sessions.filter((s) => s.role === "worker" || s.role === "orchestrator").map((s) => (
                <tr key={s.id} className="border-t border-line">
                  <td className="px-3 py-2"><span className="text-fg">{s.title ?? s.id.slice(-8)}</span></td>
                  <td className="px-3 py-2 text-fg-2">{s.role}</td>
                  <td className="px-3 py-2 text-fg-2">{s.runtime}{s.launched_by === "external" ? " (external)" : ""}</td>
                  <td className="px-3 py-2 font-mono text-fg-2">{s.queue ?? "-"}</td>
                  <td className="px-3 py-2 text-fg-2">{s.live ? `${s.live.state}${s.live.model ? ` · ${s.live.model.replace(/^claude-/, "")}` : ""}${s.effort ? ` · ${s.effort}` : ""}` : "-"}</td>
                  <td className="px-3 py-2"><ContextBar s={s} /></td>
                  <td className="px-3 py-2 text-fg-3">{s.last_event ? <>{s.last_event} · <TimeAgo at={s.last_event_at} /></> : "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    )}
  </>;

  // The sheets and drawers over either layout: settings, remote access, a queue or step.
  const drawers = <>
    <Drawer open={settingsOpen && !!state} onClose={() => nav.close("settings")}>
      {state && <SettingsPanel key={state.project.id} project={state.project} onChanged={() => { reload(); setTick((t) => t + 1); }} server={server}
        tools={phone ? <PhoneTools connected={connected} version={tick} server={server} notify={notify} /> : undefined} />}
    </Drawer>

    <Drawer open={remoteOpen} onClose={() => nav.close("remote")}>
      <RemotePanel version={tick} />
    </Drawer>

    <Drawer open={itemShown} onClose={close} left={wide} panel>
      {state && queue && (step
        ? <StepDetail project={state} queue={queue} step={step} onChanged={reload} onClose={close} of={of} />
        : <QueueDetail project={state} queue={queue} onChanged={reload} onClose={close} of={of} />)}
    </Drawer>
  </>;

  if (phone) {
    const scrolls = tab === "waiting" || tab === "queues";
    return (
      <div className="flex h-dvh flex-col">
        {/* The top line: the project picker, what runs, settings. The header's other tools are in Settings here. */}
        <header ref={header} className="z-30 shrink-0 border-b border-line bg-surface pt-[env(safe-area-inset-top)]">
          <div className="flex min-h-13 items-center gap-3 px-3 py-2">
            {projects && <ProjectPicker projects={projects} current={projectId} open={isOpen(route.nav, "projects")} onPick={(id) => nav.project(id)} />}
            {state && <RunningNow queues={state.queues} />}
            <span className="flex-1" />
            {!connected && <span className="flex items-center gap-1.5 text-xs text-stop" title="Reconnecting"><span className="h-2 w-2 rounded-full bg-stop" />offline</span>}
            {state && <SettingsButton onClick={() => nav.open("settings")} />}
          </div>
        </header>

        <main className={scrolls ? "@container scroll-thin min-h-0 flex-1 overflow-y-auto px-4 py-4" : "flex min-h-0 flex-1 flex-col"}>
          {scrolls && banners}
          {tab === "waiting" && <WaitingList projects={projects ?? []} onOpen={(w) => nav.closeThenItem("waiting", w.project, w.queue, attentionTarget(w))} />}
          {tab === "queues" && queuesPage}
          {tab === "chat" && projectId && (
            <ChatPanel key={`chat-${projectId}`} inline project={projectId} name={state?.project.name ?? projectId} view={orchestrator} onClose={() => nav.tab("waiting")} onChanged={() => setTick((t) => t + 1)} />
          )}
          {tab === "ideas" && projectId && state && (
            <ConversationsPanel key={`ideas-${projectId}`} inline project={projectId} name={state.project.name} version={tick} defaultRuntime={state.project.conversations.runtime}
              onClose={() => nav.tab("waiting")} onChanged={() => setTick((t) => t + 1)} />
          )}
        </main>

        <BottomBar tab={tab!} waiting={waiting.length} working={orchestrator?.state === "working"} onTab={(t) => nav.tab(t)} />
        {drawers}
      </div>
    );
  }

  return (
    <div className="flex min-h-full flex-col">
      <header ref={header} className="sticky top-0 z-30 border-b border-line bg-canvas/90 pt-[env(safe-area-inset-top)] backdrop-blur">
        {/* From 1024 px; below it the phone's top line and bottom bar take its place. */}
        <div className="mx-auto flex max-w-7xl items-center gap-4 px-4 py-3">
          <span className="text-lg font-semibold tracking-tight text-fg">Nexus</span>
          {projects && <ProjectTabs projects={projects} current={projectId} onPick={(id) => nav.project(id)} />}
          <WaitingButton projects={projects} onClick={() => nav.open("waiting")} />
          <UpdatePill info={server} />
          {projectId && <ConversationsButton onClick={() => nav.raise("ideas")} />}
          {projectId && <OrchestratorButton view={orchestrator} onClick={() => nav.raise("chat")} />}
          <UsageMeter version={tick} />
          <NotifyToggle {...notify} />
          {state && <SettingsButton onClick={() => nav.open("settings")} />}
          <RemoteButton onClick={() => nav.open("remote")} />
          <span className={`flex items-center gap-1.5 text-xs ${connected ? "text-fg-3" : "text-stop"}`} title={connected ? "Live updates on" : "Reconnecting"}>
            <span className={`h-2 w-2 rounded-full ${connected ? "bg-ok" : "bg-stop"}`} />
            <span>{connected ? "live" : "offline"}</span>
          </span>
        </div>
      </header>

      <main className="@container mx-auto w-full max-w-7xl flex-1 px-4 py-6"
        style={wide && (itemShown || chatOpen || ideasOpen) ? { maxWidth: "none", marginLeft: itemShown ? SIDE_LEFT : 0, marginRight: chatOpen || ideasOpen ? SIDE_RIGHT : 0, width: "auto" } : undefined}>
        {banners}

        {state && state.attention.length > 0 && (
          <AttentionPanel items={state.attention} onOpen={(a: AttentionItem) => { if (projectId && a.queue) nav.item(projectId, a.queue, attentionTarget(a)); }} />
        )}

        {queuesPage}
      </main>

      {/* The chat and the Ideas panel stack in the order they were opened: the later one lies on top. */}
      {panelOrder(route.nav).map((p) => p === "ideas"
        ? ideasOpen && projectId && state && (
          <ConversationsPanel key="ideas" project={projectId} name={state.project.name} version={tick} defaultRuntime={state.project.conversations.runtime}
            onClose={() => nav.close("ideas")} onChanged={() => setTick((t) => t + 1)} />
        )
        : chatOpen && projectId && (
          <ChatPanel key="chat" project={projectId} name={state?.project.name ?? projectId} view={orchestrator} onClose={() => nav.close("chat")} onChanged={() => setTick((t) => t + 1)} />
        ))}

      <Drawer open={waitingOpen} onClose={() => nav.close("waiting")}>
        <WaitingList projects={projects ?? []} onOpen={(w) => nav.closeThenItem("waiting", w.project, w.queue, attentionTarget(w))} />
      </Drawer>

      {drawers}
    </div>
  );
}

function Banner({ children }: { children: React.ReactNode }) {
  return <div className="mb-4 rounded-lg border border-line bg-surface px-4 py-3 text-sm text-fg">{children}</div>;
}

/**
 * The phone's Settings, at the top: what the desktop header shows as icons (the update, the usage, notifications,
 * remote access) and whether live updates arrive.
 */
function PhoneTools({ connected, version, server, notify }: {
  connected: boolean; version: unknown; server: ReturnType<typeof useServer>; notify: ReturnType<typeof useNotifications>;
}) {
  const row = (label: string, value: React.ReactNode) => (
    <div className="grid gap-1 py-1.5 sm:grid-cols-[11rem_1fr] sm:items-center sm:gap-3">
      <span className="text-sm text-fg">{label}</span>
      <span className="min-w-0 text-sm text-fg-2">{value}</span>
    </div>
  );
  return (
    <Section title="Nexus on this device">
      {row("Live updates", connected ? "On" : <span className="text-stop">Reconnecting…</span>)}
      {server?.update && server.update.phase !== "idle" && server.update.phase !== "updated" && row("Update", <UpdatePill info={server} />)}
      {row("Usage", <UsageMeter version={version} always />)}
      {row("Notifications", <NotifyToggle {...notify} labelled />)}
      {row("Remote access", <Button variant="quiet" onClick={() => nav.open("remote")}>Phone and other devices…</Button>)}
    </Section>
  );
}
