import { useEffect, useRef, useState } from "react";
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

// ---------------------------------------------------------------- browser notifications

const STORAGE = "nexus.notify";
const stored = (): boolean => { try { return localStorage.getItem(STORAGE) === "on"; } catch { return false; } };

/**
 * Shows a browser notification for every item that newly appears in any project's "waiting for you" list.
 * The items present when the page loads are the baseline, not news.
 */
/** Push works where a service worker can run (https, or localhost) and the browser has a push service. */
const pushCapable = () => typeof window !== "undefined" && window.isSecureContext && "serviceWorker" in navigator && "PushManager" in window;

const b64ToBytes = (s: string) => {
  const raw = atob((s + "=".repeat((4 - (s.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};

async function pushSubscription(): Promise<PushSubscription | null> {
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

/**
 * Notifies when something newly waits for the user. With push (an installed app on a phone, or any browser where a
 * service worker runs) the server sends them, even with the page closed; otherwise the open tab shows them.
 */
export function useNotifications(projects: ProjectSummary[] | undefined) {
  const supported = typeof Notification !== "undefined";
  const usePush = pushCapable();
  const [on, setOn] = useState(() => !usePush && supported && stored() && Notification.permission === "granted");
  const [error, setError] = useState<string>();
  const seen = useRef<Set<string> | null>(null);

  useEffect(() => {
    if (usePush) pushSubscription().then((s) => setOn(!!s && Notification.permission === "granted"), () => {});
  }, [usePush]);

  // In-tab notifications, only where push is not available.
  useEffect(() => {
    if (!projects || usePush) return;
    const current = new Map<string, { p: ProjectSummary; a: AttentionItem }>();
    for (const p of projects) for (const a of p.attention) current.set(`${p.id}:${attentionKey(a)}`, { p, a });
    if (seen.current && on) {
      for (const [key, { p, a }] of current) {
        if (seen.current.has(key)) continue;
        const n = new Notification(`${p.name}: ${LABEL[a.kind].text}`, {
          body: `${a.queue ?? ""}${a.step ? `/${a.step}` : ""} ${plain(a.text)}`.trim().slice(0, 200),
          tag: key,
        });
        n.onclick = () => { window.focus(); location.hash = `/${[p.id, a.queue, a.step].filter(Boolean).map((x) => encodeURIComponent(x!)).join("/")}`; };
      }
    }
    seen.current = new Set(current.keys());
  }, [projects, on, usePush]);

  const toggle = async () => {
    setError(undefined);
    if (!supported) return;
    try {
      if (usePush) {
        const existing = await pushSubscription();
        if (existing) {
          await fetch("/api/push/unsubscribe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ endpoint: existing.endpoint }) });
          await existing.unsubscribe();
          setOn(false);
          return;
        }
        if ((await Notification.requestPermission()) !== "granted") return;
        const { key } = (await (await fetch("/api/push/key")).json()) as { key: string };
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(key) });
        const label = /iPhone|iPad/.test(navigator.userAgent) ? "iPhone / iPad" : /Android/.test(navigator.userAgent) ? "Android" : "Desktop browser";
        const r = await fetch("/api/push/subscribe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ subscription: sub.toJSON(), label }) });
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? r.statusText);
        setOn(true);
        return;
      }
      let next = !on;
      if (next && Notification.permission !== "granted") next = (await Notification.requestPermission()) === "granted";
      setOn(next);
      try { localStorage.setItem(STORAGE, next ? "on" : "off"); } catch { /* private mode */ }
    } catch (e) { setError((e as Error).message); }
  };
  return { supported, on, toggle, push: usePush, error };
}

export function NotifyToggle({ supported, on, toggle, push, error }: { supported: boolean; on: boolean; toggle: () => void; push: boolean; error?: string }) {
  if (!supported) return null;
  return (
    <button
      onClick={toggle}
      title={error ? `Notifications: ${error}` : on ? `${push ? "Push" : "Tab"} notifications on: click to turn off` : push ? "Send notifications to this device, even with Nexus closed" : "Notify me in this tab when something waits for me"}
      className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-xs ${on ? "text-sky-300" : "text-zinc-500 hover:text-zinc-300"}`}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
        {!on && <path d="M3 3l18 18" />}
      </svg>
      <span className="hidden sm:inline">{on ? "notify" : "notify off"}</span>
    </button>
  );
}
