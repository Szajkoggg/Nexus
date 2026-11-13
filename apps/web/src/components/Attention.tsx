import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { attentionKey, type AttentionItem, type ProjectSummary, type QueueView } from "../api.ts";
import { mergeAttention, type WaitingItem } from "@nexus/protocol/attention";
import { TimeAgo } from "./ui.tsx";
import { OPEN_BUTTON, stopVersion, useStopActions } from "./Stop.tsx";
import { stepThatMatters } from "./QueueRow.tsx";

const LABEL: Record<AttentionItem["kind"], { text: string; tone: string }> = {
  question: { text: "Question", tone: "text-warn bg-warn/15" },
  stopped: { text: "Stopped", tone: "text-stop bg-stop/15" },
  approval: { text: "Needs approval", tone: "text-info bg-info/15" },
  review: { text: "Review", tone: "text-review bg-review/15" },
  failed: { text: "Failed", tone: "text-danger bg-danger/15" },
  start: { text: "Did not start", tone: "text-stop bg-stop/15" },
};

const plain = (s: string) => s.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\*\*|`/g, "");

/** Where an item leads: a stopped queue's item opens the queue, whose stop box has what the step left; others their step. */
export const attentionTarget = (a: AttentionItem): string | undefined => (a.lift ? undefined : a.step);

/** The queue and step an item is about; for a stopped queue, where its stop is ("W at step W4b", "W (the stop came …)"). */
const whereOf = (a: AttentionItem) => (a.lift ? `${a.queue}${a.lift.place}` : `${a.queue ?? ""}${a.step ? `/${a.step}` : ""}`);

/** The orchestrator's proposal to lift a stop, with its reason and time, in a stopped queue's waiting card. */
function LiftProposal({ lift }: { lift: NonNullable<AttentionItem["lift"]> }) {
  if (!lift.proposal) return null;
  return (
    <span className="mt-1.5 block rounded-md bg-canvas/60 px-2 py-1 text-xs text-fg">
      <span className="text-fg-3">The orchestrator proposes to continue · <TimeAgo at={lift.proposal.at} /></span>
      <span className="line-clamp-2 block">{plain(lift.proposal.reason)}</span>
    </span>
  );
}

/**
 * A stopped queue's way on, in its waiting card: Continue right there (Keep or Discard first when the stopped step
 * left commits; Stop.tsx), or "Approve revision N…" when its revision is not approved, and Open.
 */
function StopRow({ project, a, onOpen, onChanged, pushAccepted, queue }: {
  project: string; a: AttentionItem & { lift: NonNullable<AttentionItem["lift"]> }; onOpen: () => void; onChanged?: () => void;
  pushAccepted?: boolean;
  /** The queue, on its project's page: its branch, and the version its step line uses too. */
  queue?: QueueView;
}) {
  const { buttons, panel } = useStopActions({
    project, queue: a.queue!, approved: a.lift.continue, revision: a.lift.revision, version: queue ? stopVersion(queue) : a.at,
    onOpen, onChanged, pushAccepted, branch: queue?.branch, discardShownElsewhere: !!queue && !!stepThatMatters(queue),
  });
  return (
    <div className="px-3.5 pb-3">
      <div className="flex flex-wrap items-center gap-2">
        {buttons}
        <button onClick={onOpen} className={OPEN_BUTTON}>Open</button>
      </div>
      {panel && <div className="mt-2">{panel}</div>}
    </div>
  );
}

/**
 * What waits for the user in this project, on its page. A stopped queue's card names the queue and has Continue; its
 * reason is shown once, at the stopped step in the queue's card below (only when that card shows no stopped step,
 * here). `queues` gives the titles and that.
 */
export function AttentionPanel({ project, items, queues, pushAccepted, onOpen, onChanged }: {
  project: string; items: AttentionItem[]; queues: QueueView[]; pushAccepted: boolean;
  onOpen: (a: AttentionItem) => void; onChanged?: () => void;
}) {
  return (
    <section className="mb-8">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-warn/90">
        Waiting for you <span className="ml-1 text-xs text-fg-3">{items.length}</span>
      </h2>
      <div className="grid items-start gap-2 @2xl:grid-cols-2">
        {items.map((a) => {
          const q = a.lift ? queues.find((x) => x.id === a.queue) : undefined;
          const reasonBelow = !!q && !!stepThatMatters(q);
          return (
            <div key={attentionKey(a)} className="rounded-lg border border-line bg-surface hover:border-fg-3/60">
              <button onClick={() => onOpen(a)} className="flex w-full items-start gap-3 p-3 text-left">
                <span className={`shrink-0 rounded-md px-2 py-0.5 text-xs font-semibold ${LABEL[a.kind].tone}`}>{LABEL[a.kind].text}</span>
                <span className="min-w-0 flex-1">
                  <span className="block font-mono text-xs text-fg-3">{whereOf(a)}</span>
                  <span className="line-clamp-2 text-sm text-fg">{reasonBelow ? q!.title : plain(a.text)}</span>
                  {a.lift && <LiftProposal lift={a.lift} />}
                </span>
                {a.at && <span className="shrink-0 text-xs text-fg-3"><TimeAgo at={a.at} /></span>}
              </button>
              {a.lift && a.queue && (
                <StopRow project={project} a={{ ...a, lift: a.lift }} onOpen={() => onOpen(a)} onChanged={onChanged} pushAccepted={pushAccepted} queue={q} />
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- across all projects

/**
 * Everything waiting for the user in every project, newest first; a tap opens the item in its project. Each card puts
 * the kind, where it is and when on one line and gives the text the full width; a question's options are buttons
 * that open its sheet with that option chosen, for the user to confirm there (`onChoose`).
 */
export function WaitingList({ projects, onOpen, onChoose }: {
  projects: ProjectSummary[]; onOpen: (w: WaitingItem) => void; onChoose?: (w: WaitingItem, option: string) => void;
}) {
  const items = mergeAttention(projects);
  return (
    <div>
      <div className="flex items-baseline gap-3 pr-10 lg:pr-8">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-warn">Waiting for you · {items.length}</h2>
        <span className="ml-auto text-xs text-fg-3">all projects, newest first</span>
      </div>
      {items.length === 0 && <p className="mt-6 text-sm text-fg-2">Nothing waits for you.</p>}
      <ul className="mt-3 space-y-2.5">
        {items.map((a) => (
          <li key={`${a.project}/${attentionKey(a)}`} className="rounded-lg border border-line bg-surface hover:border-fg-3/60">
            <button onClick={() => onOpen(a)} className="block w-full px-3.5 pb-3 pt-3 text-left">
              <span className="flex min-w-0 items-center gap-2 text-xs">
                <span className={`shrink-0 rounded-md px-2 py-0.5 font-semibold ${LABEL[a.kind].tone}`}>{LABEL[a.kind].text}</span>
                <span className="min-w-0 flex-1 truncate text-fg-3">{a.project_name}{a.queue && <> · <span className="font-mono">{whereOf(a)}</span></>}</span>
                {a.at && <span className="shrink-0 text-fg-3"><TimeAgo at={a.at} /></span>}
              </span>
              <span className="mt-1.5 line-clamp-3 text-[15px] leading-snug text-fg">{plain(a.text)}</span>
              {a.lift && <LiftProposal lift={a.lift} />}
            </button>
            {a.lift && a.queue && <StopRow project={a.project} a={{ ...a, lift: a.lift }} onOpen={() => onOpen(a)} />}
            {onChoose && a.kind === "question" && !!a.options?.length && (
              <div className="flex flex-wrap gap-2 px-3.5 pb-3">
                {a.options.map((o, i) => (
                  <button key={o} onClick={() => onChoose(a, o)} title="Opens the question with this option chosen; you confirm there"
                    className="min-h-11 min-w-[40%] flex-1 rounded-md border border-line-strong bg-surface-2 px-3 py-2 text-sm font-medium text-fg hover:bg-surface-3">
                    {i + 1} · {o}
                  </button>
                ))}
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * What waits in every project, as the desktop's rail shows it (mockup 11A): one card, an item a row with its kind,
 * where it is (with its project when it is not the current one) and when, the text in two lines; a stopped queue has
 * Continue and Open. A tap opens the item in its project.
 */
export function WaitingCards({ projects, current, onOpen }: { projects: ProjectSummary[]; current?: string; onOpen: (w: WaitingItem) => void }) {
  const items = mergeAttention(projects);
  if (!items.length) return <p className="px-1 text-sm text-fg-3">Nothing waits for you.</p>;
  return (
    <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface-2">
      {items.map((a) => (
        <li key={`${a.project}/${attentionKey(a)}`}>
          <button onClick={() => onOpen(a)} className="block w-full px-3 pb-2.5 pt-2.5 text-left hover:bg-surface-3/50">
            <span className="flex min-w-0 items-center gap-1.5 text-xs">
              <span className={`shrink-0 rounded px-1.5 py-px font-semibold ${LABEL[a.kind].tone}`}>{LABEL[a.kind].text}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-fg-3">{a.project !== current && <span className="font-sans">{a.project_name} · </span>}{whereOf(a)}</span>
              {a.at && <span className="shrink-0 text-fg-3"><TimeAgo at={a.at} /></span>}
            </span>
            <span className="mt-1 line-clamp-2 text-sm leading-snug text-fg">{plain(a.text)}</span>
            {a.lift && <LiftProposal lift={a.lift} />}
          </button>
          {a.lift && a.queue && <div className="-mt-1"><StopRow project={a.project} a={{ ...a, lift: a.lift }} onOpen={() => onOpen(a)} /></div>}
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------- notifications

const STORAGE = "nexus.notify";
const stored = (): boolean => { try { return localStorage.getItem(STORAGE) === "on"; } catch { return false; } };

/** Push works where a service worker can run (https, or localhost) and the browser has a push service. */
const pushCapable = () => typeof window !== "undefined" && window.isSecureContext && "serviceWorker" in navigator && "PushManager" in window;
const mobile = () => typeof navigator !== "undefined" && /Android|iPhone|iPad/.test(navigator.userAgent);

const b64ToBytes = (s: string) => {
  const raw = atob((s + "=".repeat((4 - (s.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};

const withTimeout = <T,>(p: Promise<T>, ms: number, message: string) =>
  Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(message)), ms))]);

/** The service worker that receives pushes: registered (again, if need be) and active. */
async function worker(): Promise<ServiceWorkerRegistration> {
  await navigator.serviceWorker.register("/sw.js");
  return withTimeout(navigator.serviceWorker.ready, 10_000, "The service worker did not start. Reload the page and try again.");
}

async function pushSubscription(): Promise<PushSubscription | null> {
  const reg = await navigator.serviceWorker.getRegistration();
  return reg ? reg.pushManager.getSubscription() : null;
}

/** Why this device cannot get push notifications, if it cannot. */
export function pushBlocker(): string | undefined {
  if (typeof window === "undefined") return undefined;
  if (!window.isSecureContext) {
    return `Notifications need the https address. This page is open over ${location.protocol.replace(":", "")}: open Nexus at its https://…ts.net address (see the Remote access panel on the PC).`;
  }
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    return "This browser cannot receive push notifications. On an iPhone, add Nexus to the home screen and open it from there.";
  }
  if (typeof Notification !== "undefined" && Notification.permission === "denied") {
    return "Notifications are blocked for this site. Allow them in the browser's site settings (the lock icon next to the address, or the app's settings), then try again.";
  }
  return undefined;
}

export interface Toast { text: string; kind: "ok" | "error" }

/**
 * Notifies when something newly waits for the user. With push (an installed app on a phone, or any browser where a
 * service worker runs) the server sends them, even with the page closed; otherwise the open tab shows them (desktop
 * only: phones show notifications from a service worker, never from a page). The items present when the page loads
 * are the baseline, not news.
 */
export function useNotifications(projects: ProjectSummary[] | undefined) {
  const supported = typeof Notification !== "undefined" || mobile();
  const usePush = pushCapable();
  const [on, setOn] = useState(() => !usePush && typeof Notification !== "undefined" && stored() && Notification.permission === "granted");
  const [toast, setToast] = useState<Toast>();
  const [busy, setBusy] = useState(false);
  const seen = useRef<Set<string> | null>(null);

  useEffect(() => {
    if (usePush) pushSubscription().then((s) => setOn(!!s && Notification.permission === "granted"), () => {});
  }, [usePush]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(undefined), toast.kind === "error" ? 15_000 : 6_000);
    return () => clearTimeout(t);
  }, [toast]);

  // In-tab notifications, only where push is not available.
  useEffect(() => {
    if (!projects || usePush || typeof Notification === "undefined") return;
    const current = new Map<string, { p: ProjectSummary; a: AttentionItem }>();
    for (const p of projects) for (const a of p.attention) current.set(`${p.id}:${attentionKey(a)}`, { p, a });
    if (seen.current && on) {
      for (const [key, { p, a }] of current) {
        if (seen.current.has(key)) continue;
        try {
          const n = new Notification(`${p.name}: ${LABEL[a.kind].text}`, {
            body: `${a.queue ?? ""}${a.step ? `/${a.step}` : ""} ${plain(a.text)}`.trim().slice(0, 200),
            tag: key,
          });
          n.onclick = () => { window.focus(); location.hash = `/${[p.id, a.queue, attentionTarget(a)].filter(Boolean).map((x) => encodeURIComponent(x!)).join("/")}`; };
        } catch { /* a browser that shows notifications only through a service worker */ }
      }
    }
    seen.current = new Set(current.keys());
  }, [projects, on, usePush]);

  const turnOnPush = async () => {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") throw new Error(permission === "denied" ? pushBlocker() ?? "Notifications were refused." : "Notifications were not allowed.");
    const reg = await worker();
    const keyRes = await fetch("/api/push/key");
    if (!keyRes.ok) throw new Error(keyRes.status === 401 ? "Signed out: reload the page and sign in again." : `The server answered ${keyRes.status}.`);
    const { key } = (await keyRes.json()) as { key: string };
    const sub = await withTimeout(
      reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(key) }), 20_000,
      "The browser's push service did not answer. On Android, check that Chrome may use the network and that Google Play services are up to date.",
    );
    const label = /iPhone|iPad/.test(navigator.userAgent) ? "iPhone / iPad" : /Android/.test(navigator.userAgent) ? "Android" : "Desktop browser";
    const r = await fetch("/api/push/subscribe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ subscription: sub.toJSON(), label }) });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `The server answered ${r.status}.`);
    // A first notification right away shows that the whole path works.
    await fetch("/api/push/test", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ endpoint: sub.endpoint }) });
  };

  const toggle = async () => {
    if (busy) return;
    setBusy(true);
    setToast(undefined);
    try {
      if (usePush || mobile()) {
        const blocker = pushBlocker();
        if (blocker) throw new Error(blocker);
        const existing = await pushSubscription();
        if (existing) {
          await fetch("/api/push/unsubscribe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ endpoint: existing.endpoint }) });
          await existing.unsubscribe();
          setOn(false);
          setToast({ kind: "ok", text: "Notifications are off for this device." });
          return;
        }
        await turnOnPush();
        setOn(true);
        setToast({ kind: "ok", text: "Notifications are on for this device. A test notification is on its way." });
        return;
      }
      let next = !on;
      if (next && Notification.permission !== "granted") next = (await Notification.requestPermission()) === "granted";
      if (!next && !on) throw new Error(pushBlocker() ?? "Notifications were not allowed.");
      setOn(next);
      setToast({ kind: "ok", text: next ? "This tab notifies you while it is open." : "Notifications are off." });
      try { localStorage.setItem(STORAGE, next ? "on" : "off"); } catch { /* private mode */ }
    } catch (e) {
      setToast({ kind: "error", text: (e as Error).message || String(e) });
    } finally { setBusy(false); }
  };
  return { supported, on, toggle, push: usePush, toast, busy, dismiss: () => setToast(undefined) };
}

export function NotifyToggle({ supported, on, toggle, push, toast, busy, dismiss, labelled }: {
  supported: boolean; on: boolean; toggle: () => void; push: boolean; toast?: Toast; busy: boolean; dismiss: () => void;
  /** In the phone's Settings: says what a tap does, in words. */
  labelled?: boolean;
}) {
  if (!supported) return labelled ? <span className="text-sm text-fg-3">Not available in this browser.</span> : null;
  return (
    <>
      <button
        onClick={toggle}
        title={on ? `${push ? "Push" : "Tab"} notifications on: click to turn off` : push ? "Send notifications to this device, even with Nexus closed" : "Notify me in this tab when something waits for me"}
        className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-xs ${on ? "text-accent" : "text-fg-3 hover:text-fg"} ${busy ? "animate-pulse" : ""}`}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
          {!on && <path d="M3 3l18 18" />}
        </svg>
        {labelled
          ? <span className="text-sm">{on ? `On (${push ? "push to this device" : "in this tab"}): tap to turn off` : "Off: tap to turn on"}</span>
          : <span className="hidden sm:inline">{on ? "notify" : "notify off"}</span>}
      </button>
      {/* Into <body>: the header's backdrop blur would otherwise make it the box `fixed` positions against. */}
      {toast && createPortal(
        <div
          role="status" onClick={dismiss}
          className={`fixed inset-x-4 bottom-[calc(1rem+env(safe-area-inset-bottom))] z-[60] mx-auto max-w-md rounded-lg border bg-surface px-4 py-3 text-sm shadow-2xl sm:inset-x-auto sm:right-6 ${toast.kind === "error" ? "border-danger/40 text-danger" : "border-ok/40 text-ok"}`}
        >
          {toast.text}
        </div>,
        document.body,
      )}
    </>
  );
}
