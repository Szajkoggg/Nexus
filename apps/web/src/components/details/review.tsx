// The user's decision on a step in their review (Accept, Fix it…, Reject, a note), in the drawer's bar and in the picture
// viewer's, and what the viewer and the tiles show of each picture.
import { useState } from "react";
import { act, enc, useAction, type QueueView, type StepView } from "../../api.ts";
import { noteTargets, showsReviewActions } from "../../review.ts";
import { draftKey, readDraft } from "../../drafts.ts";
import { t } from "../../i18n.ts";
import { usePhone } from "../../phone.ts";
import { reviewedByOrchestrator } from "@nexus/protocol/status-rules";
import { ActionBar, Button, Composer, Markdown, TEXTAREA, TimeAgo, useDraftText, type MenuEntry } from "../ui.tsx";
import { usePage } from "../../page.ts";

interface ReviewArgs { project: string; queue: string; step: string; next?: string; criteria: string[] }

/**
 * The user's decision on a step in their review, for an action bar: Accept (with a note, under ⋯), Fix it… beside it,
 * Reject under ⋯, and the forms they open. Fix it opens with the text kept from before, if there is one. The step's
 * drawer and the picture viewer each show it (`accept` names the button).
 */
function useReviewDecision({ project, queue, step, next, criteria }: ReviewArgs, accept_label: string) {
  const { reload: onChanged } = usePage();
  const [error, setError] = useState<string>();
  // Accept's note: closed by default; empty means a plain accept. It goes to the next step, or to the orchestrator
  // (always on the queue's last step).
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState("");
  const [noteTo, setNoteTo] = useState<"next" | "orchestrator">("next");
  const to = next ? noteTo : "orchestrator";
  const accept = () => act(project, "POST", `/queues/${enc(queue)}/steps/${enc(step)}/accept`, note.trim() ? { text: note, note_to: to } : {})
    .then(() => { setNote(""); setNoteOpen(false); onChanged(); }, (e: Error) => setError(e.message));
  const [fixOpen, setFixOpen] = useState(() => !!readDraft(draftKey(project, "fix", queue, step)));
  const [rejectOpen, setRejectOpen] = useState(false);
  // Fix it with criteria: the text waits here until the user confirms that it overrides them.
  const [confirm, setConfirm] = useState<{ resolve: () => void; reject: (e: Error) => void; send: () => Promise<void> }>();
  const send = (text: string) => act(project, "POST", `/queues/${enc(queue)}/steps/${enc(step)}/send-back`, { text }).then(onChanged);
  const menu: MenuEntry[] = [
    ...(noteOpen ? [] : [{ label: t("details.review.addNote"), onSelect: () => setNoteOpen(true) }]),
    ...(rejectOpen ? [] : [{ label: t("details.review.reject"), danger: true, onSelect: () => setRejectOpen(true) }]),
  ];
  const opened = noteOpen || fixOpen || rejectOpen;
  return {
    error,
    menu,
    secondary: <Button variant="quiet" pressed={fixOpen} onClick={() => setFixOpen(!fixOpen)}>{t("details.review.fixOpen")}</Button>,
    primary: <Button onClick={() => void accept()}>{note.trim() ? t("details.review.acceptWithNote") : accept_label}</Button>,
    forms: opened && <div className="space-y-4">
      {rejectOpen && <RejectStep project={project} queue={queue} step={step} onCancel={() => setRejectOpen(false)} />}
      {noteOpen && (
        <div>
          <textarea
            value={note} rows={2} placeholder={t("details.review.notePlaceholder")} onChange={(e) => setNote(e.target.value)}
            className={TEXTAREA}
          />
          {next ? (
            <label className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-fg-2">
              {t("details.review.noteGoesTo")}
              <select value={noteTo} onChange={(e) => setNoteTo(e.target.value as "next" | "orchestrator")} className="rounded-md border border-line-strong bg-canvas px-2 py-1 text-xs text-fg">
                <option value="next">{t("details.review.toNext", { step: next })}</option>
                <option value="orchestrator">{t("details.review.toOrchestrator")}</option>
              </select>
            </label>
          ) : (
            <p className="mt-1.5 text-xs text-fg-2">{t("details.review.lastStep")}</p>
          )}
        </div>
      )}
      {fixOpen && <div>
        <p className="mb-1.5 text-sm text-fg">{t("details.review.fix")}</p>
        <p className="mb-2 text-xs text-fg-3">{t("details.review.fixText")}</p>
        <Composer
          draft={draftKey(project, "fix", queue, step)}
          placeholder={t("details.review.fixPlaceholder")}
          button={t("details.review.fix")}
          verbatim
          onSubmit={(text) => criteria.length
            ? new Promise<void>((resolve, reject) => setConfirm({ resolve, reject, send: () => send(text) }))
            : send(text)}
        />
        {confirm && (
          <div className="mt-3 rounded-lg border border-warn/30 bg-warn/10 p-3">
            <p className="text-sm text-warn">{t("details.review.override")}</p>
            <ul className="mt-1.5 space-y-1">
              {criteria.map((c, i) => <li key={i} className="flex gap-2 text-sm text-fg"><span className="text-fg-3">◇</span><Markdown className="[&_p]:m-0">{c}</Markdown></li>)}
            </ul>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button onClick={() => { const c = confirm; setConfirm(undefined); c.send().then(c.resolve, c.reject); }}>{t("details.review.sendBack")}</Button>
              <Button variant="quiet" onClick={() => { const c = confirm; setConfirm(undefined); c.reject(new Error(t("details.review.notSent"))); }}>{t("common.cancel")}</Button>
            </div>
          </div>
        )}
      </div>}
      </div>,
  };
}

/** The bar of a step in the user's review: Accept and go on, Fix it… beside it, Reject and a note under ⋯. */
export function ReviewBar(props: ReviewArgs) {
  const d = useReviewDecision(props, t("details.review.acceptGoOn"));
  return (
    <ActionBar hint={d.error ? <span className="text-danger">{d.error}</span> : undefined} menu={d.menu} secondary={d.secondary} primary={d.primary}>
      {d.forms}
    </ActionBar>
  );
}

/**
 * The viewer's action bar (UX proposals, 14): for the picture on the left, its mark (a mark only; the step is not
 * accepted by it) and a one-line comment; for the step on the right, while it waits for the user's review, the same
 * decision as the drawer's bar (Accept, Fix it…, Reject and a note under ⋯), so the user decides after the last
 * picture without leaving the viewer. A comment goes back to the worker as a Fix it while the step waits for the user's
 * review; otherwise it is a note on the next pending step. The original file is under ⋯.
 */
export function PictureActions({ project, queue, step, path, src }: { project: string; queue: QueueView; step: StepView; path: string; src: string }) {
  const { reload: onChanged } = usePage();
  const marks = step.pictures[path];
  const [error, setError] = useState<string>();
  const next = noteTargets(queue.steps, step.id).next;
  const reviewing = showsReviewActions(step);
  const where = reviewing ? t("details.picture.toWorker")
    : reviewedByOrchestrator(step) ? t("details.picture.toOrchestrator")
    : next ? t("details.picture.toNote", { step: next }) : undefined;
  const base = `/queues/${enc(queue.id)}/steps/${enc(step.id)}/pictures`;
  const comment = useDraftText({
    draft: draftKey(project, "picture", queue.id, step.id, path),
    onSubmit: async (text) => { await act(project, "POST", `${base}/comment`, { path, text }); onChanged(); },
  });
  const decision = useReviewDecision({ project, queue: queue.id, step: step.id, next, criteria: step.acceptance }, t("details.acceptTheStep"));
  const original = { label: t("details.picture.original"), onSelect: () => window.open(src, "_blank", "noreferrer") };
  const phone = usePhone();
  const fail = error ?? comment.error ?? (reviewing ? decision.error : undefined);
  return (
    <ActionBar
      left={
        <div className="flex min-w-0 flex-1 basis-80 items-center gap-2">
          <button
            onClick={() => void act(project, "POST", `${base}/mark`, { path, accepted: !marks?.accepted }).then(onChanged, (e: Error) => setError(e.message))}
            aria-pressed={!!marks?.accepted} title={t("details.picture.markTitle")}
            className={`shrink-0 whitespace-nowrap rounded-md border px-3 py-1.5 text-sm font-medium max-lg:min-h-11 ${marks?.accepted ? "border-ok/50 bg-ok/20 text-ok" : "border-line-strong bg-surface-2 text-fg hover:bg-surface-3"}`}
          >{t(marks?.accepted ? "details.picture.marked" : "details.picture.mark")}</button>
          {where && (
            <input value={comment.text} onChange={(e) => comment.change(e.target.value)} aria-label={t("details.picture.commentLabel")}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void comment.submit(); } }}
              placeholder={t("details.picture.commentPlaceholder")} title={t("details.picture.commentTitle", { where })}
              className="min-w-0 flex-1 rounded-md border border-line-strong bg-canvas px-3 py-1.5 text-sm text-fg placeholder:text-fg-3 focus:border-accent focus:outline-none max-lg:min-h-11 lg:max-w-md" />
          )}
        </div>
      }
      hint={fail ? <span className="text-danger">{fail}</span> : reviewing && !phone ? <span className="block text-right">{t("details.picture.theStep")}</span> : undefined}
      menu={reviewing ? [...decision.menu, original] : [original]}
      secondary={reviewing ? decision.secondary : undefined}
      primary={reviewing ? decision.primary : undefined}
    >
      {(reviewing && decision.forms) || marks?.comments.length ? (
        <div className="space-y-3 text-sm">
          {reviewing && decision.forms}
          {!!marks?.comments.length && (
            <div className="space-y-1.5">
              {marks.comments.map((c, i) => (
                <div key={i} className="rounded-md bg-surface-3 px-2 py-1.5">
                  <p className="whitespace-pre-wrap text-fg">{c.text}</p>
                  <p className="text-[11px] text-fg-3">{c.to === "send_back" ? t("details.comment.sentBack") : c.to === "orchestrator" ? t("details.comment.toOrchestrator") : t("details.comment.note", { step: c.note_step ?? "" })} · <TimeAgo at={c.at} /></p>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : undefined}
    </ActionBar>
  );
}

/** On a picture's tile: accepted, its comments, whether it has a before to compare with. */
export function PictureBadges({ marks, paired }: { marks?: StepView["pictures"][string]; paired: boolean }) {
  if (!marks?.accepted && !marks?.comments.length && !paired) return null;
  const chip = "rounded bg-canvas/70 px-1.5 py-0.5 text-[11px]";
  return (
    <span className="absolute right-1.5 top-1.5 flex gap-1">
      {paired && <span className={`${chip} text-fg`} title={t("details.hasBefore")}>⇄</span>}
      {marks?.accepted && <span className={`${chip} text-ok`} title={t("details.youMarkedAccepted")}>✓</span>}
      {!!marks?.comments.length && <span className={`${chip} text-info`} title={t("viewer.comments")}>💬 {marks.comments.length}</span>}
    </span>
  );
}

/** A folded part of the review's one line: "▸ Goal and acceptance". */
export function Fold({ label, open, onToggle }: { label: string; open: boolean; onToggle: () => void }) {
  return (
    <button onClick={onToggle} aria-expanded={open} className="whitespace-nowrap text-fg-2 hover:text-fg max-lg:min-h-11">
      <span className={`mr-1 inline-block text-xs text-fg-3 transition-transform ${open ? "rotate-90" : ""}`}>▸</span>{label}
    </button>
  );
}

/** Reject: the step is marked rejected, the run pauses, nothing is reverted; the orchestrator proposes what follows. */
function RejectStep({ project, queue, step, onCancel }: { project: string; queue: string; step: string; onCancel: () => void }) {
  const { reload: onChanged } = usePage();
  const [why, setWhy] = useState("");
  const { busy, error, run } = useAction();
  const reject = () => void run(
    () => act(project, "POST", `/queues/${enc(queue)}/steps/${enc(step)}/reject`, why.trim() ? { text: why } : {}),
    () => { onCancel(); setWhy(""); onChanged(); },
  );
  return (
    <div className="rounded-lg border border-danger/30 bg-danger/10 p-3">
      <p className="text-sm text-danger">{t("details.reject.title")}</p>
      <p className="mt-1 text-xs text-fg-2">{t("details.reject.text")}</p>
      <textarea
        value={why} rows={2} placeholder={t("details.reject.why")} onChange={(e) => setWhy(e.target.value)}
        className="mt-2 w-full resize-y rounded-lg border border-line-strong bg-canvas px-3 py-2 text-sm text-fg placeholder:text-fg-3 focus:border-danger focus:outline-none"
      />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button disabled={busy} onClick={reject} className="rounded-md border border-danger/50 bg-danger/15 px-3 py-1.5 text-sm font-medium text-danger hover:bg-danger/25 disabled:opacity-40">{t(busy ? "details.reject.busy" : "details.reject.button")}</button>
        <Button variant="quiet" onClick={onCancel}>{t("common.cancel")}</Button>
        {error && <span className="text-xs text-danger">{error}</span>}
      </div>
    </div>
  );
}

/** A rejected step: by whom and why, and what the queue waits for while the rejection holds. */
export function Rejected({ step, holding }: { step: StepView; holding: boolean }) {
  const at = step.timeline.findLast((e) => e.type === "review.rejected")?.at;
  return (
    <div className="mt-4 rounded-lg border border-danger/30 bg-danger/10 p-3 text-sm">
      <p>
        <span className="text-fg-3">{t(step.reason ? "details.rejected.byYouWhy" : "details.rejected.byYou")}</span>
        {step.reason && <span className="text-danger">{step.reason}</span>}
        {at && <span className="text-xs text-fg-3"> · <TimeAgo at={at} /></span>}
      </p>
      <p className="mt-1 text-xs text-fg-2">
        {t(holding ? "details.rejected.holding" : "details.rejected.newer")}
      </p>
    </div>
  );
}
