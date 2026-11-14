// Remote access: how a phone reaches this dashboard, signs in, and gets notifications.
import { useEffect, useState } from "react";
import { useFetch } from "../api.ts";
import { Button, Section } from "./ui.tsx";
import { formatDate, rich, t } from "../i18n.ts";

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
        [t("remote.check.https"), secure, secure ? location.host : t("remote.check.httpsNot", { address: `${location.protocol}//${location.host}` })],
        [t("remote.check.push"), sw, sw ? "" : t("remote.check.pushNot")],
        [t("remote.check.allowed"), perm === "granted" ? true : perm === "denied" ? false : undefined, perm === "denied" ? t("remote.check.blocked") : perm === "default" ? t("remote.check.notAsked") : perm],
        [t("remote.check.worker"), reg?.active ? true : sw && secure ? false : undefined, reg?.active ? "" : t("remote.check.workerNot")],
        [t("remote.check.subscribed"), sub ? true : false, sub ? new URL(sub.endpoint).host : t("remote.check.subscribedNot")],
      ]);
    })();
  }, []);
  if (!rows) return null;
  return (
    <div className="mt-3 rounded-lg bg-canvas p-3">
      <div className="mb-1 text-xs font-semibold text-fg-2">{t("remote.thisDevice")}</div>
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
  if (!r) return <p className="text-sm text-fg-3">{t("common.loading")}</p>;

  const post = async (url: string) => {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    return res.json() as Promise<Record<string, unknown>>;
  };

  return (
    <div>
      <h2 className="pr-8 text-xl font-semibold text-fg">{t("sidebar.remoteAccess")}</h2>
      <p className="mt-1 text-sm text-fg-2">{t("remote.intro")}</p>

      {!r.local && <Section title={t("remote.thisDevice")}><p className="text-sm text-fg">{t("remote.signedInRemotely")}</p></Section>}

      {r.local && (
        <>
          <Section title={t("remote.tailscale")}>
            {r.tailscale.url ? (
              <p className="text-sm text-ok">{rich("remote.tailscaleRunning", { url: <span key="url" className="font-mono">{r.tailscale.url}</span> })}</p>
            ) : (
              <p className="text-sm text-warn">{r.tailscale.detail ?? t("remote.tailscaleMissing")}</p>
            )}
            <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-fg-2">
              <li>{rich("remote.step1", { command: <code key="command" className="text-fg">winget install tailscale.tailscale</code> })}</li>
              <li>{t("remote.step2")}</li>
              <li>{t("remote.step3")}</li>
              <li>{rich("remote.step4", { command: <code key="command" className="text-fg">tailscale serve --bg 4317</code> })}</li>
            </ol>
          </Section>

          <Section title={t("remote.signIn")}>
            {!r.tailscale.url && (
              <label className="mb-3 block text-xs text-fg-2">
                {t("remote.address")}
                <input value={base} onChange={(e) => setBase(e.target.value.trim())} placeholder={t("remote.addressPlaceholder")}
                  className="mt-1 block w-full rounded-md border border-line-strong bg-canvas px-2 py-1 text-sm text-fg placeholder:text-fg-3" />
              </label>
            )}
            {r.qr && r.login_url ? (
              <div className="flex flex-wrap items-start gap-4">
                <div className="w-44 shrink-0 rounded-lg bg-canvas p-2" dangerouslySetInnerHTML={{ __html: r.qr }} />
                <div className="min-w-0 text-sm text-fg-2">
                  <p>{t("remote.scan")}</p>
                  <p className="mt-2 break-all font-mono text-xs text-fg-3">{r.base}/login</p>
                </div>
              </div>
            ) : <p className="text-sm text-fg-3">{t("remote.qrLater")}</p>}
            <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
              <span className="text-fg-2">{t("remote.token")}</span>
              <code className="rounded bg-canvas px-2 py-0.5 text-fg">{reveal ? r.token : "••••••••••••"}</code>
              <Button variant="quiet" onClick={() => setReveal(!reveal)}>{t(reveal ? "remote.hide" : "remote.show")}</Button>
              <Button variant="danger" onClick={() => {
                if (confirm(t("remote.replaceConfirm"))) {
                  void post("/api/remote/rotate").then(() => { setBump((b) => b + 1); setNote(t("remote.replaced")); });
                }
              }}>{t("remote.replace")}</Button>
            </div>
          </Section>
        </>
      )}

      <Section title={t("remote.notifications")}>
        <p className="text-sm text-fg-2">{t("remote.notificationsText")}</p>
        <DeviceCheck />
        {r.devices.length > 0 ? (
          <ul className="mt-2 space-y-1 text-sm text-fg">
            {r.devices.map((d) => <li key={d.endpoint}>{d.label ?? t("remote.device")} <span className="text-xs text-fg-3">{t("remote.since", { date: formatDate(d.added_at) })}</span></li>)}
          </ul>
        ) : <p className="mt-2 text-sm text-fg-3">{t("remote.noDevice")}</p>}
        {r.devices.length > 0 && (
          <div className="mt-2"><Button variant="quiet" onClick={() => void post("/api/push/test").then((x) => setNote(t("remote.testSent", { count: Number(x.sent) })))}>{t("remote.test")}</Button></div>
        )}
      </Section>
      {note && <p className="mt-4 text-sm text-info">{note}</p>}
    </div>
  );
}
