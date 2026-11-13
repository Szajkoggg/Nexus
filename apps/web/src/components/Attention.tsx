import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { attentionKey, type AttentionItem, type ProjectSummary } from "../api.ts";
import { mergeAttention, type WaitingItem } from "@nexus/protocol/attention";
import { TimeAgo } from "./ui.tsx";

const LABEL: Record<AttentionItem["kind"], { text: string; tone: string }> = {
  question: { text: "Question", tone: "text-warn bg-warn/15" },
  stopped: { text: "Stopped", tone: "text-stop bg-stop/15" },
  approval: { text: "Needs approval", tone: "text-info bg-info/15" },
  review: { text: "Review", tone: "text-review bg-review/15" },
  failed: { text: "Failed", tone: "text-danger bg-danger/15" },
  start: { text: "Did not start", tone: "text-stop bg-stop/15" },
};

const plain = (s: string) => s.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\*\*|`/g, "");

/** Where an item leads: a stopped queue's item opens the queue, whose stop box has Continue; others their step. */
export const attentionTarget = (a: AttentionItem): string | undefined => (a.lift ? undefined : a.step);

/** The queue and step an item is about; for a stopped queue, where its stop is ("W at step W4b", "W (the stop came …)"). */
const whereOf = (a: AttentionItem) => (a.lift ? `${a.queue}${a.lift.place}` : `${a.queue ?? ""}${a.step ? `/${a.step}` : ""}`);

/**
 * A stopped queue's way out, as the waiting list and the queue card show it: Continue when the current revision is
 * approved (else approving it lifts the stop), and the orchestrator's proposal to lift it, with its reason and time.
 */
export function StopWays({ lift, className = "" }: { lift: NonNullable<AttentionItem["lift"]>; className?: string }) {
  return (
    <span className={`block text-xs ${className}`}>
      <span className="block text-stop">{lift.continue ? "Continue possible: open the queue to lift the stop" : `Approving revision ${lift.revision} lifts the stop`}</span>
      {lift.proposal && (
        <span className="mt-1 block rounded-md bg-canvas/60 px-2 py-1 text-fg">
          <span className="text-fg-3">The orchestrator proposes to continue · <TimeAgo at={lift.proposal.at} /></span>
          <span className="line-clamp-2 block">{plain(lift.proposal.reason)}</span>
        </span>
      )}
    </span>
  );
}

export function AttentionPanel({ items, onOpen }: { items: AttentionItem[]; onOpen: (a: AttentionItem) => void }) {
  return (
    <section className="mb-8">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-warn/90">
        Waiting for you <span className="ml-1 text-xs text-fg-3">{items.length}</span>
      </h2>
      <div className="grid gap-2 @2xl:grid-cols-2">
        {items.map((a) => (
          <button
            key={attentionKey(a)}
            onClick={() => onOpen(a)}
            className="flex items-start gap-3 rounded-lg border border-line bg-surface p-3 text-left hover:border-fg-3/60"
          >
            <span className={`shrink-0 rounded-md px-2 py-0.5 text-xs font-semibold ${LABEL[a.kind].tone}`}>{LABEL[a.kind].text}</span>
            <span className="min-w-0 flex-1">
              <span className="block font-mono text-xs text-fg-3">{whereOf(a)}</span>
              <span className="line-clamp-2 text-sm text-fg">{plain(a.text)}</span>
              {a.lift && <StopWays lift={a.lift} className="mt-1.5" />}
            </span>
            {a.at && <span className="shrink-0 text-xs text-fg-3"><TimeAgo at={a.at} /></span>}
          </button>
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- across all projects

/** The header's way to everything waiting for the user, in every project: an inbox with the total count. */
export function WaitingButton({ projects, onClick }: { projects: ProjectSummary[] | undefined; onClick: () => void }) {
  const n = (projects ?? []).reduce((sum, p) => sum + p.attention.length, 0);
  return (
    <button onClick={onClick} title={`Waiting for you in all projects: ${n}`} aria-label={`Waiting for you: ${n}`}
      className={`flex shrink-0 items-center gap-1.5 rounded-lg border px-2 py-1.5 text-sm hover:bg-surface ${n ? "border-warn/40 text-warn" : "border-line-strong text-fg-2"}`}>
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 12h-6l-2 3h-4l-2-3H2" /><path d="M5.5 5.1 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.7 4H7.3a2 2 0 0 0-1.8 1.1Z" /></svg>
      {n > 0 && <span className="text-xs font-medium">{n}</span>}
    </button>
  );
}

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
              {a.lift && <StopWays lift={a.lift} className="mt-1.5" />}
            </button>
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
