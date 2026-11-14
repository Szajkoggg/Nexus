// The planned deploy (PROTOCOL.md, "Planned deploys"; queue PD): what it waits for (a step, a queue, or a time), where
// it stands, and Cancel. One plan for the whole server, so it shows wherever the server's state does: at the top of
// the right rail, the phone's Waiting tab, and the Nexus section of the global settings.
import { useState } from "react";
import { formatClock, formatDateTime, t } from "../i18n.ts";
import { nav } from "../nav.ts";
import { Button } from "./ui.tsx";

export interface PlannedDeploy {
  id: string;
  after?: { project: string; queue: string; step?: string };
  at?: string;
  deadline?: string;
  ref?: string;
  /** The orchestrator that planned it; absent when the user did. */
  by?: { project: string; session: string };
  created_at: string;
  warning?: string;
  /** What it waits for, in the server's words (a step, a queue, a time). */
  waiting?: string;
  /** Provisional work it waits for the user to confirm (`queue/step`). */
  waiting_for?: string[];
  /** The queue it holds at its step's end meanwhile. */
  held?: { project: string; queue: string };
  /** Its time or target came: its update is under way. */
  started?: { at: string; update: string };
}

export async function cancelPlan(): Promise<void> {
  const r = await fetch("/api/server/cancel-plan", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? r.statusText);
}

/**
 * The plan as a card: the rail and the Waiting tab frame it; the settings show it as it is (`framed` false).
 * `projects`: where known, to show the target project's name rather than its id.
 */
export function PlannedDeployCard({ plan, onChanged, framed = true, projects }: {
  plan: PlannedDeploy; onChanged: () => void; framed?: boolean; projects?: readonly { id: string; name: string }[];
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const now = new Date();
  const cancel = () => {
    setBusy(true); setError(undefined);
    cancelPlan().then(onChanged, (e: Error) => setError(e.message)).finally(() => setBusy(false));
  };
  const a = plan.after;
  const target = a ? t(a.step ? "deploy.afterStep" : "deploy.afterQueue", { queue: a.queue, step: a.step ?? "" }) : t("deploy.at", { time: formatClock(plan.at!, now) });
  const confirming = !plan.started && !!plan.waiting_for?.length;
  return (
    <div className={framed ? `rounded-lg border px-3 py-2.5 ${confirming ? "border-review/40 bg-review/5" : "border-accent/30 bg-accent/5"}` : ""}>
      <div className={`flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider ${confirming ? "text-review" : "text-accent"}`}>
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${confirming ? "bg-review" : "bg-accent"} ${plan.started ? "animate-pulse" : ""}`} />
        {t(plan.started ? "deploy.startedTitle" : "deploy.title")}
      </div>
      <div className="mt-1 text-sm text-fg">
        {a ? (
          <button onClick={() => nav.item(a.project, a.queue, a.step)} className="font-medium hover:underline" title={t("deploy.openTarget")}>{target}</button>
        ) : <span className="font-medium" title={formatDateTime(plan.at!)}>{target}</span>}
        {a && <span className="text-fg-3"> · {projects?.find((p) => p.id === a.project)?.name ?? a.project}</span>}
      </div>
      {plan.at && (
        <p className="mt-0.5 text-xs text-fg-2">
          {plan.deadline ? t("deploy.deadline", { time: formatClock(plan.deadline, now) }) : t("deploy.noDeadline")}
        </p>
      )}
      <p className={`mt-1 text-xs ${confirming ? "text-review" : "text-fg-2"}`}>
        {plan.started ? t("deploy.underway")
          : confirming ? t("deploy.provisional", { steps: plan.waiting_for!.join(", ") })
          : a && plan.waiting ? t("deploy.waiting", { what: plan.waiting })
          : plan.at ? t("deploy.startsAt", { time: formatClock(plan.at, now) }) : null}
      </p>
      {plan.held && !plan.started && <p className="mt-0.5 text-xs text-fg-2">{t("deploy.held", { queue: plan.held.queue })}</p>}
      {plan.warning && <p className="mt-1 text-xs text-warn">{plan.warning}</p>}
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-[11px] text-fg-3">{t(plan.by ? "deploy.byOrchestrator" : "deploy.byYou")}{plan.ref && plan.ref !== "main" ? ` · ${plan.ref}` : ""}</span>
        <span className="flex-1" />
        <Button variant="quiet" onClick={cancel} disabled={busy}>{t(plan.started ? "deploy.cancelStarted" : "deploy.cancel")}</Button>
      </div>
      {error && <p className="mt-1 text-xs text-danger">{error}</p>}
    </div>
  );
}
