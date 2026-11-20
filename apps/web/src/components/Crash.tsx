// The server's last crash (queue KM; docs/protocol/api.md, "Server crash"): an uncaught exception ended the server,
// and the server running now read its record. Shown at the top of the page until the user closes it, which closes it
// in every dashboard (POST /api/server/crash/dismiss).
import { request, useAction } from "../api.ts";
import { formatDateTime, t } from "../i18n.ts";
import { usePage } from "../page.ts";
import type { ServerCrash } from "./Settings.tsx";
import { Button } from "./ui.tsx";

export function CrashNotice({ crash }: { crash: ServerCrash }) {
  const { reloaded } = usePage();
  const { busy, error, run } = useAction();
  const dismiss = () => void run(async () => {
    await request("/api/server/crash/dismiss", { method: "POST", body: { at: crash.at } });
    await reloaded("/api/server");
  });
  return (
    <div role="alert" className="mb-4 rounded-lg border border-danger/40 bg-danger/5 px-4 py-3">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-danger">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-danger" />
            {t("crash.title")}
          </div>
          <p className="mt-1 break-words text-sm text-fg">{t("crash.text", { error: crash.error, time: formatDateTime(crash.at) })}</p>
          <p className="mt-0.5 text-xs text-fg-2">{t("crash.hint")}</p>
        </div>
        <Button variant="quiet" onClick={dismiss} disabled={busy}>{t("crash.dismiss")}</Button>
      </div>
      {error && <p className="mt-1 text-xs text-danger">{error}</p>}
    </div>
  );
}
