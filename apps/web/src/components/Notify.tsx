// Notifications when something newly waits for the user: push from the server where a service worker can run (an
// installed app on a phone, any browser on https or localhost), else from the open tab (desktop only); and the bell
// that turns them on and off, with what it says when it did.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { attentionKey, HttpError, request, type AttentionItem, type ProjectSummary } from "../api.ts";
import { itemHash } from "../hash.ts";
import { t } from "../i18n.ts";
import { attentionTarget, kindLabel, textOf } from "./Attention.tsx";

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
  return withTimeout(navigator.serviceWorker.ready, 10_000, t("notify.workerDidNotStart"));
}

async function pushSubscription(): Promise<PushSubscription | null> {
  const reg = await navigator.serviceWorker.getRegistration();
  return reg ? reg.pushManager.getSubscription() : null;
}

/** Why this device cannot get push notifications, if it cannot. */
function pushBlocker(): string | undefined {
  if (typeof window === "undefined") return undefined;
  if (!window.isSecureContext) {
    return t("notify.blocker.https", { protocol: location.protocol.replace(":", "") });
  }
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    return t("notify.blocker.browser");
  }
  if (typeof Notification !== "undefined" && Notification.permission === "denied") {
    return t("notify.blocker.blocked");
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
          const n = new Notification(t("notify.notification", { project: p.name, kind: kindLabel(a.kind).text }), {
            body: `${a.queue ?? ""}${a.step ? `/${a.step}` : ""} ${textOf(a)}`.trim().slice(0, 200),
            tag: key,
          });
          n.onclick = () => { window.focus(); location.hash = itemHash(p.id, a.queue, attentionTarget(a)); };
        } catch { /* a browser that shows notifications only through a service worker */ }
      }
    }
    seen.current = new Set(current.keys());
  }, [projects, on, usePush]);

  const turnOnPush = async () => {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") throw new Error(permission === "denied" ? pushBlocker() ?? t("notify.refused") : t("notify.notAllowed"));
    const reg = await worker();
    const { key } = await request<{ key: string }>("/api/push/key").catch((e: unknown) => {
      if (!(e instanceof HttpError)) throw e;
      throw new Error(e.status === 401 ? t("notify.signedOut") : t("common.serverAnswered", { status: String(e.status) }));
    });
    const sub = await withTimeout(
      reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(key) }), 20_000,
      t("notify.pushNoAnswer"),
    );
    const device = /iPhone|iPad/.test(navigator.userAgent) ? "iPhone / iPad" : /Android/.test(navigator.userAgent) ? "Android" : t("notify.desktopBrowser");
    await request("/api/push/subscribe", { method: "POST", body: { subscription: sub.toJSON(), label: device } }).catch((e: unknown) => {
      // The server's reason when it gave one, else its status.
      throw new Error(e instanceof HttpError ? e.reason ?? t("common.serverAnswered", { status: String(e.status) }) : (e as Error).message);
    });
    // A first notification right away shows that the whole path works; the subscription stands even if it fails.
    await request("/api/push/test", { method: "POST", body: { endpoint: sub.endpoint } }).catch(() => undefined);
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
          // The browser's subscription ends either way; one the server still holds is dropped at its first failed send.
          await request("/api/push/unsubscribe", { method: "POST", body: { endpoint: existing.endpoint } }).catch(() => undefined);
          await existing.unsubscribe();
          setOn(false);
          setToast({ kind: "ok", text: t("notify.offForDevice") });
          return;
        }
        await turnOnPush();
        setOn(true);
        setToast({ kind: "ok", text: t("notify.onForDevice") });
        return;
      }
      let next = !on;
      if (next && Notification.permission !== "granted") next = (await Notification.requestPermission()) === "granted";
      if (!next && !on) throw new Error(pushBlocker() ?? t("notify.notAllowed"));
      setOn(next);
      setToast({ kind: "ok", text: next ? t("notify.onInTab") : t("notify.off") });
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
  if (!supported) return labelled ? <span className="text-sm text-fg-3">{t("notify.unavailable")}</span> : null;
  return (
    <>
      <button
        onClick={toggle}
        title={t(on ? (push ? "notify.titleOnPush" : "notify.titleOnTab") : push ? "notify.titleOffPush" : "notify.titleOffTab")}
        className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-xs ${on ? "text-accent" : "text-fg-3 hover:text-fg"} ${busy ? "animate-pulse" : ""}`}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
          {!on && <path d="M3 3l18 18" />}
        </svg>
        {labelled
          ? <span className="text-sm">{t(on ? (push ? "notify.labelOnPush" : "notify.labelOnTab") : "notify.labelOff")}</span>
          : <span className="hidden sm:inline">{t(on ? "notify.short" : "notify.shortOff")}</span>}
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
