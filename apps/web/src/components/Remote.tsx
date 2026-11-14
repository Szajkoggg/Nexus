// Remote access: how a phone reaches this dashboard, signs in, and gets notifications.
import { useEffect, useState } from "react";
import { useFetch } from "../api.ts";
import { Button, Section } from "./ui.tsx";
import { t } from "../i18n.ts";

interface Remote {
  local: boolean;
  tailscale: { tailscale: boolean; url?: string; detail?: string };
  base: string | null;
  token?: string;
  login_url?: string;
  qr?: string;
  devices: { endpoint: string; label?: string; added_at: string }[];
}

/** What this browser can do for notifications, step by step, so a refusal is not silent. */
function DeviceCheck() {
  const [rows, setRows] = useState<[string, boolean | undefined, string][]>();
  useEffect(() => {
    void (async () => {
      const secure = window.isSecureContext;
      const sw = "serviceWorker" in navigator && "PushManager" in window;
      const perm = typeof Notification !== "undefined" ? Notification.permission : "unsupported";
      let reg: ServiceWorkerRegistration | undefined; let sub: PushSubscription | null = null;
      if (sw) { try { reg = await navigator.serviceWorker.getRegistration(); sub = reg ? await reg.pushManager.getSubscription() : null; } catch { /* reported below */ } }
      setRows([
        ["Opened over https", secure, secure ? location.host : `${location.protocol}//${location.host}: open the https://…ts.net address`],
        ["Browser supports push", sw, sw ? "" : "on an iPhone, open Nexus from the home screen"],
        ["Notifications allowed", perm === "granted" ? true : perm === "denied" ? false : undefined, perm === "denied" ? "blocked: allow them in the site or app settings" : perm === "default" ? "not asked yet: the bell asks" : perm],
        ["Service worker running", reg?.active ? true : sw && secure ? false : undefined, reg?.active ? "" : "the bell starts it"],
        ["This device subscribed", sub ? true : false, sub ? new URL(sub.endpoint).host : "turn on the bell"],
      ]);
    })();
  }, []);
  if (!rows) return null;
  return (
    <div className="mt-3 rounded-lg bg-canvas p-3">
      <div className="mb-1 text-xs font-semibold text-fg-2">This device</div>
      <ul className="space-y-1 text-xs">
        {rows.map(([label, ok, detail]) => (
          <li key={label} className="flex gap-2">
            <span className={ok === true ? "text-ok" : ok === false ? "text-danger" : "text-fg-3"}>{ok === true ? "✓" : ok === false ? "✗" : "·"}</span>
            <span className="text-fg">{label}</span>
            {detail && <span className="min-w-0 break-words text-fg-3">{detail}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function RemoteButton({ onClick }: { onClick: () => void }) {
  return (
    <button onClick={onClick} title={t("sidebar.remoteAccess")} className="rounded-md p-1.5 text-fg-3 hover:bg-surface hover:text-fg">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="7" y="2" width="10" height="20" rx="2" /><path d="M11 18h2" /></svg>
    </button>
  );
}

export function RemotePanel({ version }: { version: unknown }) {
  const [base, setBase] = useState("");
  const [bump, setBump] = useState(0);
  const r = useFetch<Remote>(`/api/remote${base ? `?base=${encodeURIComponent(base)}` : ""}`, `${String(version)}-${bump}`);
  const [reveal, setReveal] = useState(false);
  const [note, setNote] = useState<string>();
  if (!r) return <p className="text-sm text-fg-3">Loading…</p>;

  const post = async (url: string) => {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    return res.json() as Promise<Record<string, unknown>>;
  };

  return (
    <div>
      <h2 className="pr-8 text-xl font-semibold text-fg">Remote access</h2>
      <p className="mt-1 text-sm text-fg-2">Use Nexus from your phone while this PC is on. It stays private: only your own devices on your Tailscale network can reach it, and each signs in once with the access token.</p>

      {!r.local && <Section title="This device"><p className="text-sm text-fg">You are signed in remotely. The token and the QR code are shown only on the PC.</p></Section>}

      {r.local && (
        <>
          <Section title="1. Tailscale">
            {r.tailscale.url ? (
              <p className="text-sm text-ok">Tailscale is running. This PC is <span className="font-mono">{r.tailscale.url}</span></p>
            ) : (
              <p className="text-sm text-warn">{r.tailscale.detail ?? "Tailscale is not available."}</p>
            )}
            <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-fg-2">
              <li>Install Tailscale on this PC and sign in: <code className="text-fg">winget install tailscale.tailscale</code></li>
              <li>Install the Tailscale app on your phone and sign in with the same account.</li>
              <li>In the Tailscale admin console, under DNS, turn on MagicDNS and HTTPS certificates.</li>
              <li>Publish Nexus to your tailnet (not the internet): <code className="text-fg">tailscale serve --bg 4317</code></li>
            </ol>
          </Section>

          <Section title="2. Sign the phone in">
            {!r.tailscale.url && (
              <label className="mb-3 block text-xs text-fg-2">
                Address the phone uses (if not Tailscale's)
                <input value={base} onChange={(e) => setBase(e.target.value.trim())} placeholder="https://my-pc.tailnet.ts.net"
                  className="mt-1 block w-full rounded-md border border-line-strong bg-canvas px-2 py-1 text-sm text-fg placeholder:text-fg-3" />
              </label>
            )}
            {r.qr && r.login_url ? (
              <div className="flex flex-wrap items-start gap-4">
                <div className="w-44 shrink-0 rounded-lg bg-canvas p-2" dangerouslySetInnerHTML={{ __html: r.qr }} />
                <div className="min-w-0 text-sm text-fg-2">
                  <p>Scan with the phone's camera: it opens Nexus and signs in. Then add it to the home screen (Share → Add to Home Screen on iPhone) to get notifications.</p>
                  <p className="mt-2 break-all font-mono text-xs text-fg-3">{r.base}/login</p>
                </div>
              </div>
            ) : <p className="text-sm text-fg-3">The QR code appears once the address is known.</p>}
            <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
              <span className="text-fg-2">Access token:</span>
              <code className="rounded bg-canvas px-2 py-0.5 text-fg">{reveal ? r.token : "••••••••••••"}</code>
              <Button variant="quiet" onClick={() => setReveal(!reveal)}>{reveal ? "Hide" : "Show"}</Button>
              <Button variant="danger" onClick={() => {
                if (confirm("Replace the access token? Every remote device is signed out and must sign in again.")) {
                  void post("/api/remote/rotate").then(() => { setBump((b) => b + 1); setNote("A new token is in place; remote devices are signed out."); });
                }
              }}>Replace token</Button>
            </div>
          </Section>
        </>
      )}

      <Section title="3. Notifications">
        <p className="text-sm text-fg-2">On each device, turn on the bell in the header. Nexus then sends a notification when something waits for you: a question, a stop, a queue to approve, a review.</p>
        <DeviceCheck />
        {r.devices.length > 0 ? (
          <ul className="mt-2 space-y-1 text-sm text-fg">
            {r.devices.map((d) => <li key={d.endpoint}>{d.label ?? "Device"} <span className="text-xs text-fg-3">since {new Date(d.added_at).toLocaleDateString()}</span></li>)}
          </ul>
        ) : <p className="mt-2 text-sm text-fg-3">No device receives notifications yet.</p>}
        {r.devices.length > 0 && (
          <div className="mt-2"><Button variant="quiet" onClick={() => void post("/api/push/test").then((x) => setNote(`Test sent to ${String(x.sent)} device(s).`))}>Send a test notification</Button></div>
        )}
      </Section>
      {note && <p className="mt-4 text-sm text-info">{note}</p>}
    </div>
  );
}
