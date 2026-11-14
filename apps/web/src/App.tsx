import { Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import type { QueueStatus } from "@nexus/protocol";
import { enc, useFetch, useLive, useProjectState, useProjects, type AttentionItem, type QueueView } from "./api.ts";
import { QueueRow } from "./components/QueueRow.tsx";
import { chooseOption, QueueDetail, StepDetail } from "./components/Details.tsx";
import { Button, Drawer, Section, TimeAgo, useWide } from "./components/ui.tsx";
import { Rail, RAIL } from "./components/Rail.tsx";
import { RefsProvider } from "./components/Refs.tsx";
import { AttentionPanel, attentionTarget, NotifyToggle, useNotifications, WaitingList } from "./components/Attention.tsx";
import { ContextBar, UsageMeter } from "./components/Run.tsx";
import { ChatPanel, ConversationsPanel, DeskHead, useOrchestrator, type Desk, type Unread } from "./components/Chat.tsx";
import { hasUnread, placeKey, readPlace, unreadCount, usePlaces } from "./chatPlace.ts";
import { RemoteButton, RemotePanel } from "./components/Remote.tsx";
import { ProjectPicker, ProjectSidebar } from "./components/Projects.tsx";
import { isOpen, layerValue, phoneView, viewOf } from "./layers.ts";
import { fileOf } from "./fileview.ts";
import { CommitDetails } from "./components/Commit.tsx";
import { usePhone } from "./phone.ts";
import { BottomBar, RunningNow } from "./components/Phone.tsx";
import { moveOn, placeOf, waitingPosition, type Place } from "./waiting.ts";
import { Digest } from "./components/Digest.tsx";
import { mergeAttention, type WaitingItem } from "@nexus/protocol/attention";
import { nav, useNav } from "./nav.ts";
import { SettingsButton, SettingsPanel, UpdatePill, useServer } from "./components/Settings.tsx";
import { ProjectRefusals } from "./components/Refusals.tsx";
import { FinishedGroup } from "./components/Finished.tsx";
import { splitFinished } from "./finished.ts";
import { ApprovalView, useApprovalForm } from "./components/Approval.tsx";
import { needsApproval } from "./approval.ts";
import { rich, t, type Key } from "./i18n.ts";

/** The file viewer and its Markdown and highlighting load when a file is first opened. */
const FileView = lazy(() => import("./components/FileView.tsx").then((m) => ({ default: m.FileView })));

// Finished queues (done, cancelled) fold into one group at the bottom (FinishedGroup); one that still waits for the
// user stays in progress until nothing waits.
const GROUPS: { title: Key; statuses: QueueStatus[] }[] = [
  { title: "shell.group.inProgress", statuses: ["running", "waiting", "stopped", "paused", "done", "cancelled"] },
  { title: "shell.group.planned", statuses: ["approved", "proposed", "draft"] },
];

/**
 * The selection lives in the URL hash: #/<project>[/<queue>[/<step>]]; what is open over it, and the view (the phone's
 * tab, a desktop's middle column), in the history entry (nav.ts), so that Back closes the topmost layer.
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
  const settingsOpen = isOpen(route.nav, "settings");
  const remoteOpen = isOpen(route.nav, "remote");
  const waitingOpen = isOpen(route.nav, "waiting");
  const file = fileOf(layerValue(route.nav, "file"));
  const commit = layerValue(route.nav, "commit");

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
  const openWaiting = (w: WaitingItem) => nav.closeThenItem("waiting", w.project, w.queue, attentionTarget(w));
  // Below 1024 px: the phone layout, with a tab instead of the chat, Ideas and waiting layers (layers.ts phoneView).
  // From 1024 px: chat-first (UX proposals, 11A), the middle column showing the chat, Ideas or the project's queues.
  const phone = usePhone();
  const tab = phone ? phoneView(route.nav).tab : undefined;
  const view = phone ? undefined : viewOf(route.nav, "desk").tab;
  const waiting = useMemo(() => mergeAttention(projects ?? []), [projects]);

  // "Go through them one by one" (the digest): the first waiting item opens; once the open item no longer waits (an
  // answer, an acceptance, an approval, Continue), the next one opens in its place (waiting.ts, moveOn). Closing the
  // item, opening something else by hand, or the end of the list ends the round.
  const round = useRef<{ place: Place; opened: boolean } | null>(null);
  const goThrough = () => {
    const first = waiting[0];
    if (!first) return;
    round.current = { place: placeOf(first), opened: false };
    openWaiting(first);
  };
  useEffect(() => {
    const r = round.current;
    if (!r || !projectId) return;
    const here: Place = { project: projectId, queue: route.queue, step: route.step };
    const there = r.place.project === here.project && r.place.queue === here.queue && (r.place.step ?? "") === (here.step ?? "");
    if (!there) { if (r.opened) round.current = null; return; } // still on its way, or the user went elsewhere
    r.opened = true;
    const next = moveOn(waiting, r.place);
    if (next?.queue) {
      round.current = { place: placeOf(next), opened: false };
      nav.item(next.project, next.queue, attentionTarget(next));
    } else if (!waiting.length) round.current = null;
  }, [waiting, projectId, route.queue, route.step]);
  const digest = <Digest projects={projects ?? []} version={tick} onGoThrough={goThrough} />;
  // On the phone an item that waits for the user says where it stands in the waiting list: "2 of 6".
  const place = phone && projectId && route.queue ? waitingPosition(waiting, { project: projectId, queue: route.queue, step: route.step }) : undefined;
  const of = place?.at ? t("shell.placeInWaiting", { at: place.at, total: place.total }) : undefined;

  const itemShown = !!(state && queue);
  // From 1280 px the right rail stands beside the chat (UX proposals, 11A).
  const wide = useWide();
  // A queue waiting for approval opens in the full view on a desktop, the compact list on the phone (UX proposals,
  // 15), unless the user picked the other form for it.
  const [form, setForm] = useApprovalForm(projectId, queue?.id, queue?.revision);
  const fullApproval = !!(queue && !step && needsApproval(queue) && (form ?? (phone ? "panel" : "full")) === "full");
  // "Ideas · N" in a desktop's switch: the conversations that are not archived.
  const ideas = useFetch<{ id: string; archived?: boolean; last_at?: string }[]>(projectId ? `/api/projects/${enc(projectId)}/conversations` : undefined, tick);
  // Unread markers on the chat switch and the phone's tabs, from each chat's place (chatPlace.ts).
  usePlaces();
  const unread: Unread = {
    chat: projectId ? unreadCount(orchestrator?.chat ?? [], readPlace(placeKey(projectId, "orchestrator"))?.seen) : 0,
    ideas: !!projectId && (ideas ?? []).some((c) => !c.archived && hasUnread(c.last_at, readPlace(placeKey(projectId, "conversation", c.id))?.seen)),
  };

  const banners = <>
    {projectsError && <Banner>{t("shell.serverUnreachable", { error: projectsError })}</Banner>}
    {projects?.length === 0 && (
      <Banner>{rich("shell.noProjects", { command: <code key="command">nexus project add &lt;path&gt;</code> })}</Banner>
    )}
    {error && <Banner>{error}</Banner>}
    {state && state.warnings.length > 0 && (
      <details className="mb-4 rounded-lg border border-warn/30 bg-warn/5 px-3 py-2 text-sm text-warn">
        <summary className="cursor-pointer">{t("shell.warnings", { count: state.warnings.length })}</summary>
        <ul className="mt-2 list-disc pl-5 text-xs text-warn/80">{state.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
      </details>
    )}
  </>;

  // The project's queues (the desktop's page; the phone's Queues tab, where what waits has a tab of its own).
  const queuesPage = <>
    {state && byGroup.map((g) => (
      <section key={g.title} className="mb-8">
        <div className="mb-3 flex items-baseline gap-3">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-fg-2">{t(g.title)}</h2>
          <span className="text-xs text-fg-3">{g.queues.length}</span>
        </div>
        <div className="space-y-3">
          {g.queues.map((q) => (
            <QueueRow key={q.id} project={state.project.id} queue={q} pushAccepted={state.project.defaults.push_accepted}
              onQueue={() => projectId && nav.item(projectId, q.id)} onStep={(s) => projectId && nav.item(projectId, q.id, s)} onChanged={reload} />
          ))}
        </div>
        {g.queues.length === 0 && <p className="text-sm text-fg-3">{t("common.nothingHere")}</p>}
      </section>
    ))}

    {state && projectId && <FinishedGroup project={projectId} rows={finished} onOpen={(id) => nav.item(projectId, id)} />}

    {state && <ProjectRefusals project={state} />}

    {state && state.sessions.some((s) => s.role === "worker" || s.role === "orchestrator") && (
      <section className="mb-8">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-fg-2">{t("shell.sessions")}</h2>
        <div className="overflow-x-auto rounded-xl border border-line">
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-fg-3"><tr>{SESSION_COLUMNS.map((h) => <th key={h} className="px-3 py-2 font-medium">{t(h)}</th>)}</tr></thead>
            <tbody>
              {state.sessions.filter((s) => s.role === "worker" || s.role === "orchestrator").map((s) => (
                <tr key={s.id} className="border-t border-line">
                  <td className="px-3 py-2"><span className="text-fg">{s.title ?? s.id.slice(-8)}</span></td>
                  <td className="px-3 py-2 text-fg-2">{s.role}</td>
                  <td className="px-3 py-2 text-fg-2">{s.launched_by === "external" ? t("shell.sessions.external", { runtime: s.runtime }) : s.runtime}</td>
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

    <Drawer open={!!commit && !!projectId} onClose={() => nav.close("commit")}>
      {commit && projectId && <CommitDetails key={commit} project={projectId} hash={commit} />}
    </Drawer>

    {file && projectId && <Suspense fallback={null}><FileView key={`${file.path}:${file.line ?? ""}`} project={projectId} path={file.path} line={file.line} onClose={() => nav.close("file")} /></Suspense>}

    <Drawer open={itemShown && !fullApproval} onClose={close} beside={phone ? undefined : RAIL} panel>
      {state && queue && (step
        ? <StepDetail project={state} queue={queue} step={step} onChanged={reload} onClose={close} of={of} />
        : <QueueDetail project={state} queue={queue} onChanged={reload} onClose={close} of={of}
            chat={orchestrator?.chat} onFull={() => setForm("full")} />)}
    </Drawer>
    {fullApproval && state && queue && (
      <ApprovalView key={`${queue.id}/${queue.revision}`} project={state} queue={queue} chat={orchestrator?.chat ?? []} onChanged={reload} onClose={close}
        onPanel={() => setForm("panel")} sidebar={phone ? undefined : SIDEBAR} />
    )}
  </>;

  if (phone) {
    const scrolls = tab === "waiting" || tab === "queues";
    return (
      <RefsProvider project={projectId} queues={state?.queues}>
      <div className="flex h-dvh flex-col">
        {/* The top line: the project picker, what runs, settings. The header's other tools are in Settings here. */}
        <header className="z-30 shrink-0 border-b border-line bg-surface pt-[env(safe-area-inset-top)]">
          <div className="flex min-h-13 items-center gap-3 px-3 py-2">
            {projects && <ProjectPicker projects={projects} current={projectId} open={isOpen(route.nav, "projects")} onPick={(id) => nav.project(id)} />}
            {state && <RunningNow queues={state.queues} />}
            <span className="flex-1" />
            {!connected && <span className="flex items-center gap-1.5 text-xs text-stop" title={t("common.reconnecting")}><span className="h-2 w-2 rounded-full bg-stop" />{t("common.offline")}</span>}
            {state && <SettingsButton onClick={() => nav.open("settings")} />}
          </div>
        </header>

        <main className={scrolls ? "@container scroll-thin min-h-0 flex-1 overflow-y-auto px-4 py-4" : "flex min-h-0 flex-1 flex-col"}>
          {scrolls && banners}
          {tab === "waiting" && <div className="mb-4 empty:hidden">{digest}</div>}
          {tab === "waiting" && <WaitingList projects={projects ?? []} onOpen={openWaiting} onChoose={(w, o) => { if (w.qid) chooseOption(w.qid, o); openWaiting(w); }} />}
          {tab === "queues" && queuesPage}
          {tab === "chat" && projectId && (
            <ChatPanel key={`chat-${projectId}`} inline project={projectId} name={state?.project.name ?? projectId} view={orchestrator} onChanged={() => setTick((t) => t + 1)} />
          )}
          {tab === "ideas" && projectId && state && (
            <ConversationsPanel key={`ideas-${projectId}`} inline project={projectId} name={state.project.name} version={tick} defaultRuntime={state.project.conversations.runtime}
              onChanged={() => setTick((t) => t + 1)} />
          )}
        </main>

        <BottomBar tab={tab!} waiting={waiting.length} working={orchestrator?.state === "working"} unread={unread} onTab={(t) => nav.tab(t)} />
        {drawers}
      </div>
      </RefsProvider>
    );
  }

  // A desktop (from 1024 px; UX proposals, 11A and 12A): the projects in a sidebar with the global status at its foot,
  // the middle column (the orchestrator chat, what a project opens on; Ideas; or the project's queues from "All
  // queues"), and from 1280 px the rail at the right: what waits, what runs, what finished today. A queue or step opens
  // over the rail, so the chat never moves. Below 1280 px the rail folds into "Waiting N" in the chat's header and
  // opens as a drawer in the rail's place; there, the column makes room for the drawer or a queue.
  const total = waiting.length;
  const desk: Desk = {
    orchestrator,
    ideas: ideas?.filter((c) => !c.archived).length,
    unread,
    tools: wide ? null : (
      <button onClick={() => (waitingOpen ? nav.close("waiting") : nav.open("waiting"))} aria-pressed={waitingOpen} title={t("shell.waitingButtonTitle")}
        className={`flex shrink-0 items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm ${waitingOpen ? "bg-surface-3" : "hover:bg-surface"} ${total ? "border-warn/40 text-warn" : "border-line-strong text-fg-2"}`}>
        {t("shell.waitingButton")}{total > 0 && <span className="grid h-4.5 min-w-4.5 place-items-center rounded-full bg-warn px-1.5 text-[11px] font-semibold text-canvas">{total}</span>}
      </button>
    ),
  };
  const railProps = { projects: projects ?? [], state, queuesShown: view === "queues", onOpenWaiting: openWaiting, digest };
  const besideShown = !wide && ((itemShown && !fullApproval) || waitingOpen);
  const alerts = (projectsError || projects?.length === 0 || error) && <div className="px-6 pt-4">{banners}</div>;
  return (
    <RefsProvider project={projectId} queues={state?.queues}>
    <div className="flex h-dvh">
      <ProjectSidebar projects={projects ?? []} current={projectId} connected={connected} onPick={(id) => nav.project(id)} foot={<>
        <UpdatePill info={server} />
        <UsageMeter version={tick} stacked />
        <div className="-mx-1.5 flex items-center gap-0.5">
          <NotifyToggle {...notify} />
          <span className="flex-1" />
          {state && <SettingsButton onClick={() => nav.open("settings")} />}
          <RemoteButton onClick={() => nav.open("remote")} />
        </div>
      </>} />

      <main className="flex min-w-0 flex-1 flex-col" style={besideShown ? { marginRight: RAIL } : undefined}>
        {view === "chat" && <>
          {alerts}
          {projectId && <ChatPanel key={`chat-${projectId}`} desk={desk} project={projectId} name={state?.project.name ?? projectId} view={orchestrator} onChanged={() => setTick((t) => t + 1)} />}
        </>}
        {view === "ideas" && <>
          {alerts}
          {projectId && state && (
            <ConversationsPanel key={`ideas-${projectId}`} desk={desk} project={projectId} name={state.project.name} version={tick} defaultRuntime={state.project.conversations.runtime}
              onChanged={() => setTick((t) => t + 1)} />
          )}
        </>}
        {view === "queues" && <>
          <DeskHead desk={desk}>
            <h1 className="min-w-0 truncate text-sm font-semibold text-fg">{state?.project.name ?? projectId}<span className="font-normal text-fg-3">{t("shell.queuesOf")}</span></h1>
          </DeskHead>
          <div className="@container scroll-thin min-h-0 flex-1 overflow-y-auto px-6 py-6">
            <div className="mx-auto max-w-6xl">
              {banners}
              {!wide && state && state.attention.length > 0 && (
                <AttentionPanel project={state.project.id} items={state.attention} queues={state.queues} pushAccepted={state.project.defaults.push_accepted}
                  onChanged={reload}
                  onOpen={(a: AttentionItem) => { if (projectId && a.queue) nav.item(projectId, a.queue, attentionTarget(a)); }} />
              )}
              {queuesPage}
            </div>
          </div>
        </>}
      </main>

      {wide && (
        <aside className="shrink-0 border-l border-line bg-surface" style={{ width: RAIL }}>
          <Rail {...railProps} />
        </aside>
      )}
      <Drawer open={!wide && waitingOpen} onClose={() => nav.close("waiting")} beside={RAIL} panel>
        <Rail {...railProps} onClose={() => nav.close("waiting")} />
      </Drawer>

      {drawers}
    </div>
    </RefsProvider>
  );
}

const SESSION_COLUMNS: Key[] = [
  "shell.sessions.session", "shell.sessions.role", "shell.sessions.runtime", "shell.sessions.queue", "shell.sessions.state",
  "shell.sessions.context", "shell.sessions.lastEvent",
];

/** The width of a desktop's project sidebar (Tailwind's w-58), which the approval's full view leaves in sight. */
const SIDEBAR = "14.5rem";

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
    <Section title={t("device.title")}>
      {row(t("device.liveUpdates"), connected ? t("common.on") : <span className="text-stop">{t("common.reconnectingDots")}</span>)}
      {server?.update && server.update.phase !== "idle" && server.update.phase !== "updated" && row(t("device.update"), <UpdatePill info={server} />)}
      {row(t("device.usage"), <UsageMeter version={version} always />)}
      {row(t("device.notifications"), <NotifyToggle {...notify} labelled />)}
      {row(t("device.remoteAccess"), <Button variant="quiet" onClick={() => nav.open("remote")}>{t("device.otherDevices")}</Button>)}
    </Section>
  );
}
