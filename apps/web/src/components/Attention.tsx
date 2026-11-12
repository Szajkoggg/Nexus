import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { attentionKey, type AttentionItem, type ProjectSummary } from "../api.ts";
import { TimeAgo } from "./ui.tsx";

const LABEL: Record<AttentionItem["kind"], { text: string; tone: string }> = {
  question: { text: "Question", tone: "text-amber-300 bg-amber-500/10 ring-amber-500/40" },
  stopped: { text: "Stopped", tone: "text-orange-300 bg-orange-500/10 ring-orange-500/40" },
  approval: { text: "Needs approval", tone: "text-sky-300 bg-sky-500/10 ring-sky-500/40" },
  review: { text: "Review", tone: "text-violet-300 bg-violet-500/10 ring-violet-500/40" },
  failed: { text: "Failed", tone: "text-red-300 bg-red-500/10 ring-red-500/40" },
};

const plain = (s: string) => s.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\*\*|`/g, "");

export function AttentionPanel({ items, onOpen }: { items: AttentionItem[]; onOpen: (a: AttentionItem) => void }) {
  return (
    <section className="mb-8">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-amber-300/90">
        Waiting for you <span className="ml-1 text-xs text-zinc-500">{items.length}</span>
      </h2>
      <div className="grid gap-2 md:grid-cols-2">
        {items.map((a) => (
          <button
            key={attentionKey(a)}
            onClick={() => onOpen(a)}
            className="flex items-start gap-3 rounded-lg border border-zinc-800 bg-zinc-900/60 p-3 text-left hover:border-zinc-600"
          >
            <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ${LABEL[a.kind].tone}`}>{LABEL[a.kind].text}</span>
            <span className="min-w-0 flex-1">
              <span className="block font-mono text-xs text-zinc-500">{a.queue}{a.step ? `/${a.step}` : ""}</span>
              <span className="line-clamp-2 text-sm text-zinc-200">{plain(a.text)}</span>
            </span>
            {a.at && <span className="shrink-0 text-xs text-zinc-600"><TimeAgo at={a.at} /></span>}
          </button>
        ))}
      </div>
    </section>
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
          n.onclick = () => { window.focus(); location.hash = `/${[p.id, a.queue, a.step].filter(Boolean).map((x) => encodeURIComponent(x!)).join("/")}`; };
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

export function NotifyToggle({ supported, on, toggle, push, toast, busy, dismiss }: {
  supported: boolean; on: boolean; toggle: () => void; push: boolean; toast?: Toast; busy: boolean; dismiss: () => void;
}) {
  if (!supported) return null;
  return (
    <>
      <button
        onClick={toggle}
        title={on ? `${push ? "Push" : "Tab"} notifications on: click to turn off` : push ? "Send notifications to this device, even with Nexus closed" : "Notify me in this tab when something waits for me"}
        className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-xs ${on ? "text-sky-300" : "text-zinc-500 hover:text-zinc-300"} ${busy ? "animate-pulse" : ""}`}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
          {!on && <path d="M3 3l18 18" />}
        </svg>
        <span className="hidden sm:inline">{on ? "notify" : "notify off"}</span>
      </button>
      {/* Into <body>: the header's backdrop blur would otherwise make it the box `fixed` positions against. */}
      {toast && createPortal(
        <div
          role="status" onClick={dismiss}
          className={`fixed inset-x-4 bottom-[calc(1rem+env(safe-area-inset-bottom))] z-[60] mx-auto max-w-md rounded-lg border bg-zinc-900 px-4 py-3 text-sm shadow-2xl sm:inset-x-auto sm:right-6 ${toast.kind === "error" ? "border-red-500/40 text-red-200" : "border-emerald-500/40 text-emerald-200"}`}
        >
          {toast.text}
        </div>,
        document.body,
      )}
    </>
  );
}
