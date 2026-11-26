// A "Paused for long" waiting card's line and ways on (queue IWS, docs/ux/idea-work-signals.md part c): why and since
// when the run is paused, Resume (the run's own resume), Open (the queue) and "Remind me in N days" (put off by the
// project's deadline once more: POST …/attention/snooze).
import { act, enc, useAction, type AttentionItem } from "../api.ts";
import { t } from "../i18n.ts";
import { pausedLine } from "../paused.ts";
import { OPEN_BUTTON, STOP_BUTTON } from "./Stop.tsx";
import { Button } from "./ui.tsx";

export function PausedRow({ project, a, onOpen, onChanged, className = "px-3.5 pb-3" }: {
  project: string; a: AttentionItem; onOpen: () => void; onChanged?: () => void; className?: string;
}) {
  const { busy, error, run } = useAction();
  const w = a.paused;
  if (!w || !a.queue) return null;
  const queue = a.queue;
  const resume = () => run(() => act(project, "POST", `/queues/${enc(queue)}/run`, { action: "resume" }), () => onChanged?.());
  const snooze = () => run(() => act(project, "POST", "/attention/snooze", { key: w.key }), () => onChanged?.());
  return (
    <div className={className}>
      <p className="mb-2 text-xs text-fg-2">{pausedLine(w, Date.now())}</p>
      <div className="flex flex-wrap items-center gap-2">
        <Button action="paused-resume" disabled={busy} onClick={() => void resume()}>{t("run.resume")}</Button>
        <button onClick={onOpen} className={STOP_BUTTON}>{t("common.open")}</button>
        <button onClick={() => void snooze()} disabled={busy} data-action="paused-remind" className={OPEN_BUTTON}>{t("waiting.paused.remind", { count: w.days })}</button>
      </div>
      {error && <p className="mt-2 text-sm text-danger" role="alert">{error}</p>}
    </div>
  );
}
