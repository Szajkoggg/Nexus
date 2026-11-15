// Which notifications this device gets (@nexus/protocol notify.ts), in the global settings' "This browser": a switch
// per kind, quiet hours, and "urgent breaks through". Kept with this device's push subscription on the server, else in
// this browser (Notify.tsx, loadDeviceNotify). A change applies at once, like the theme; nothing to save.
import { useEffect, useState } from "react";
import { NOTIFY_KINDS, type NotifyKind, type NotifySettings } from "@nexus/protocol/notify";
import { deviceZone, loadDeviceNotify, saveDeviceNotify } from "./Notify.tsx";
import { t, type Key } from "../i18n.ts";

/** Each kind's name as the user reads it. */
const KIND_LABEL: Record<NotifyKind, Key> = {
  question: "notifySettings.kind.question", stopped: "notifySettings.kind.stopped", approval: "notifySettings.kind.approval",
  review: "notifySettings.kind.review", failed: "notifySettings.kind.failed", start: "notifySettings.kind.start",
  provisional: "notifySettings.kind.provisional", plan: "notifySettings.kind.plan", merge: "notifySettings.kind.merge",
  tags: "notifySettings.kind.tags", recurring: "notifySettings.kind.recurring", update_failed: "notifySettings.kind.updateFailed",
  deploy: "notifySettings.kind.deploy", cancelled: "notifySettings.kind.cancelled",
};

const time = "rounded-md border border-line-strong bg-canvas px-2 py-1 text-sm text-fg disabled:opacity-50";

export function NotifySettingsRows() {
  const [state, setState] = useState<{ settings: NotifySettings; endpoint?: string }>();
  const [msg, setMsg] = useState<{ ok: boolean; text: string }>();
  useEffect(() => {
    let live = true;
    void loadDeviceNotify().then((s) => { if (live) setState(s); });
    return () => { live = false; };
  }, []);
  if (!state) return <p className="py-1.5 text-sm text-fg-3">{t("common.loading")}</p>;
  const s = state.settings;
  const change = (next: NotifySettings) => {
    setState({ ...state, settings: next });
    setMsg(undefined);
    saveDeviceNotify(next, state.endpoint).then(
      () => setMsg({ ok: true, text: t(state.endpoint ? "notifySettings.savedDevice" : "notifySettings.savedBrowser") }),
      (e: Error) => setMsg({ ok: false, text: e.message }),
    );
  };
  const kind = (k: NotifyKind, on: boolean) => change({ ...s, off: on ? s.off.filter((x) => x !== k) : [...s.off, k] });
  const quiet = (q: Partial<NotifySettings["quiet"]>) => change({ ...s, quiet: { ...s.quiet, ...q } });
  return (
    <div className="grid gap-1 py-1.5 sm:grid-cols-[11rem_1fr] sm:items-start sm:gap-3">
      <span className="pt-1 text-sm text-fg">{t("notifySettings.title")}</span>
      <div className="min-w-0 space-y-3">
        <p className="pt-1 text-xs text-fg-3">{t(state.endpoint ? "notifySettings.hintDevice" : "notifySettings.hintBrowser")}</p>
        <fieldset>
          <legend className="mb-1 text-xs font-semibold text-fg-2">{t("notifySettings.kinds")}</legend>
          <div className="grid gap-x-4 gap-y-0.5 sm:grid-cols-2">
            {NOTIFY_KINDS.map((k) => (
              <label key={k} className="flex items-center gap-2 py-0.5 text-sm text-fg max-lg:min-h-9">
                <input type="checkbox" checked={!s.off.includes(k)} onChange={(e) => kind(k, e.target.checked)} className="accent-accent" />
                {t(KIND_LABEL[k])}
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend className="mb-1 text-xs font-semibold text-fg-2">{t("notifySettings.quiet")}</legend>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <label className="flex items-center gap-2 text-sm text-fg">
              <input type="checkbox" checked={s.quiet.on} onChange={(e) => quiet({ on: e.target.checked })} className="accent-accent" />
              {t("notifySettings.quietOn")}
            </label>
            <span className="flex items-center gap-2 text-sm text-fg-2">
              <input type="time" value={s.quiet.from} disabled={!s.quiet.on} aria-label={t("notifySettings.from")} className={time}
                onChange={(e) => { if (e.target.value) quiet({ from: e.target.value }); }} />
              –
              <input type="time" value={s.quiet.to} disabled={!s.quiet.on} aria-label={t("notifySettings.to")} className={time}
                onChange={(e) => { if (e.target.value) quiet({ to: e.target.value }); }} />
            </span>
          </div>
          <p className="mt-1 text-xs text-fg-3">{t("notifySettings.quietHint", { zone: deviceZone() ?? t("notifySettings.thisZone") })}</p>
          <label className="mt-2 flex items-center gap-2 text-sm text-fg">
            <input type="checkbox" checked={s.urgent} disabled={!s.quiet.on} onChange={(e) => change({ ...s, urgent: e.target.checked })} className="accent-accent" />
            {t("notifySettings.urgent")}
          </label>
          <p className="mt-1 text-xs text-fg-3">{t("notifySettings.urgentHint")}</p>
        </fieldset>
        {msg && <p className={`text-xs ${msg.ok ? "text-ok" : "text-danger"}`} role="status">{msg.text}</p>}
      </div>
    </div>
  );
}
