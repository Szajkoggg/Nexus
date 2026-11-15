// Templates and recurring queues on the Queues view (PROTOCOL.md, "Queue templates" and "Recurring queues"):
// "New queue from template" (pick a template, fill in its parameters; the orchestrator gets it as the user's message and
// drafts the queue, which the user approves as any), and the project's recurring queues with their state, schedule,
// next and last run. Approving, pausing and removing a recurring queue are the user's: only here and in the waiting
// list. The pure parts are in ../recurring.ts.
import { useState } from "react";
import type { RecurringView, TemplatesResponse } from "@nexus/protocol";
import { act, enc, projectUrl, useAction, useQuery, type AttentionItem } from "../api.ts";
import { t } from "../i18n.ts";
import { usePage } from "../page.ts";
import { missingParams, recurringActions, recurringStatus, scheduleWords, templateMessage, type Mode, type Template } from "../recurring.ts";
import { Button, CloseButton, Clock, StatusBadge, TEXTAREA } from "./ui.tsx";

const LAYER = { nexus: "templates.layer.nexus", global: "templates.layer.global", project: "templates.layer.project" } as const;
const INPUT = "w-full rounded-lg border border-line-strong bg-canvas px-3 py-2 text-sm text-fg placeholder:text-fg-3 focus:border-accent focus:outline-none";

/** "New queue from template": a button on the Queues view that opens the form under it. */
export function NewFromTemplate({ project }: { project: string }) {
  const [open, setOpen] = useState(false);
  const [sent, setSent] = useState(false);
  return (
    <section className="mb-6" aria-label={t("templates.title")}>
      <div className="flex flex-wrap items-center justify-end gap-3">
        {sent && !open && <p className="text-sm text-ok" role="status">{t("templates.sent")}</p>}
        {!open && <Button variant="quiet" onClick={() => { setOpen(true); setSent(false); }}>{t("templates.open")}</Button>}
      </div>
      {open && <TemplateForm project={project} onClose={() => setOpen(false)} onSent={() => { setOpen(false); setSent(true); }} />}
    </section>
  );
}

function TemplateForm({ project, onClose, onSent }: { project: string; onClose: () => void; onSent: () => void }) {
  const list = useQuery<TemplatesResponse>(projectUrl(project, "/templates"));
  const [chosen, setChosen] = useState<string>();
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [mode, setMode] = useState<Mode>();
  const [note, setNote] = useState("");
  const { busy, error, run } = useAction();
  const tpl = list.data?.templates.find((x) => x.id === chosen);
  const missing = tpl ? missingParams(tpl, typed) : [];
  const send = () => tpl && void run(() => act(project, "POST", "/orchestrator/messages", { text: templateMessage(tpl, typed, mode, note) }), onSent);
  const pick = (x: Template) => { setChosen(x.id); setTyped({}); setMode(x.maintenance); };
  return (
    <div className="mt-3 rounded-xl border border-line bg-surface p-4">
      <div className="mb-3 flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-fg">{t("templates.title")}</h2>
          <p className="mt-0.5 text-xs text-fg-3">{t("templates.note")}</p>
        </div>
        <CloseButton onClose={onClose} />
      </div>
      {list.error && <p className="text-sm text-danger" role="alert">{list.error}</p>}
      <div className="grid grid-cols-1 gap-2 @3xl:grid-cols-2" role="radiogroup" aria-label={t("templates.choose")}>
        {(list.data?.templates ?? []).filter((x) => !tpl || x.id === tpl.id).map((x) => (
          <button key={x.id} role="radio" aria-checked={x.id === chosen} onClick={() => pick(x)}
            className={`rounded-lg border px-3 py-2 text-left ${x.id === chosen ? "border-accent bg-accent/10" : "border-line hover:border-line-strong"}`}>
            <span className="flex items-baseline gap-2">
              <span className="text-sm font-medium text-fg">{x.title}</span>
              <span className="font-mono text-xs text-fg-3">{x.id}</span>
              <span className="flex-1" />
              <span className="text-xs text-fg-3">{t(LAYER[x.layer])}</span>
            </span>
            {x.description && <span className="mt-0.5 block text-xs text-fg-2">{x.description}</span>}
          </button>
        ))}
      </div>
      {tpl && <button onClick={() => setChosen(undefined)} className="mt-2 text-xs text-accent hover:underline">{t("templates.another")}</button>}
      {tpl && (
        <div className="mt-4 space-y-3">
          {tpl.params.map((p) => (
            <label key={p.name} className="block">
              <span className="flex items-baseline gap-2 text-sm text-fg">
                <span className="font-mono">{p.name}</span>
                {p.default === undefined && <span className="text-xs text-warn">{t("templates.required")}</span>}
              </span>
              <span className="mb-1 block text-xs text-fg-3">{p.description}</span>
              <input name={`param-${p.name}`} value={typed[p.name] ?? ""} onChange={(e) => setTyped({ ...typed, [p.name]: e.target.value })}
                placeholder={p.default ?? ""} className={INPUT} />
            </label>
          ))}
          {tpl.maintenance && (
            <fieldset>
              <legend className="mb-1 text-sm text-fg">{t("templates.mode")}</legend>
              <div className="flex flex-wrap gap-2">
                {(["survey", "fix_small"] as const).map((m) => (
                  <Button key={m} variant="quiet" pressed={mode === m} onClick={() => setMode(m)}>{t(m === "survey" ? "templates.mode.survey" : "templates.mode.fixSmall")}</Button>
                ))}
              </div>
            </fieldset>
          )}
          <label className="block">
            <span className="mb-1 block text-sm text-fg">{t("templates.extra")}</span>
            <textarea name="note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder={t("templates.extraPlaceholder")} className={TEXTAREA} />
          </label>
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={send} disabled={busy || missing.length > 0}>{t("templates.send")}</Button>
            {missing.length > 0 && <span className="text-xs text-fg-3">{t("templates.missing", { names: missing.join(", ") })}</span>}
          </div>
          {error && <p className="text-sm text-danger" role="alert">{error}</p>}
        </div>
      )}
    </div>
  );
}

/** The user's actions on a recurring queue: each a request to …/recurring/:id. */
function useRecurringActions(project: string, onChanged: () => void) {
  const { busy, error, run } = useAction();
  const post = (id: string, action: "approve" | "pause" | "resume") => run(() => act(project, "POST", `/recurring/${enc(id)}`, { action }), onChanged);
  const remove = (id: string) => { if (confirm(t("recurring.removeConfirm", { id }))) void run(() => act(project, "DELETE", `/recurring/${enc(id)}`), onChanged); };
  return { busy, error, post, remove };
}

const ACTION_WORDS = { approve: "recurring.approve", pause: "recurring.pause", resume: "recurring.resume", remove: "recurring.remove" } as const;

/** The project's recurring queues; nothing while it has none. */
export function RecurringList({ project, recurring, onOpen }: { project: string; recurring: readonly RecurringView[]; onOpen: (queue: string) => void }) {
  const { reload } = usePage();
  const actions = useRecurringActions(project, reload);
  if (!recurring.length) return null;
  return (
    <section className="mb-8" aria-label={t("recurring.title")}>
      <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-fg-2">{t("recurring.title")}</h2>
        <span className="text-xs text-fg-3">{recurring.length}</span>
        <span className="text-xs text-fg-3">{t("recurring.hint")}</span>
      </div>
      {actions.error && <p className="mb-3 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger" role="alert">{actions.error}</p>}
      <div className="space-y-3">
        {recurring.map((r) => <RecurringCard key={r.id} r={r} actions={actions} onOpen={onOpen} />)}
      </div>
    </section>
  );
}

function RecurringCard({ r, actions, onOpen }: { r: RecurringView; actions: ReturnType<typeof useRecurringActions>; onOpen: (queue: string) => void }) {
  const status = recurringStatus(r);
  const params = Object.entries(r.params);
  return (
    <div className={`rounded-xl border bg-surface p-3.5 ${r.status === "needs_approval" ? "border-info/40" : "border-line"}`}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-mono text-xs text-fg-3">{r.id}</span>
        <span className="text-sm font-medium text-fg">{r.template_title ?? r.template}</span>
        <StatusBadge status={status.tone} label={status.word} />
      </div>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-fg-3">{t("recurring.schedule")}</dt>
        <dd className="text-fg-2">{scheduleWords(r)}</dd>
        {params.length > 0 && <>
          <dt className="text-fg-3">{t("recurring.values")}</dt>
          <dd className="min-w-0 truncate font-mono text-fg-2">{params.map(([k, v]) => `${k}=${v}`).join(" · ")}</dd>
        </>}
        {r.maintenance && <>
          <dt className="text-fg-3">{t("recurring.mode")}</dt>
          <dd className="text-fg-2">{t(r.maintenance === "survey" ? "templates.mode.survey" : "templates.mode.fixSmall")}</dd>
        </>}
        {r.next_at && r.status !== "paused" && r.status !== "broken" && <>
          <dt className="text-fg-3">{t("recurring.next")}</dt>
          <dd className="text-fg-2"><Clock at={r.next_at} /></dd>
        </>}
        {r.last && <>
          <dt className="text-fg-3">{t("recurring.last")}</dt>
          <dd><button onClick={() => onOpen(r.last!.queue)} className="font-mono text-accent hover:underline">{r.last.queue}</button></dd>
        </>}
      </dl>
      {r.status === "needs_approval" && <p className="mt-2 text-xs text-info">{t(r.approval ? "recurring.changedNote" : "recurring.approveNote")}</p>}
      {r.problem && <p className="mt-2 text-xs text-danger">{r.problem}</p>}
      {r.skipped && r.skipped.kind !== "approval" && <p className="mt-2 text-xs text-warn">{t("recurring.skipped", { reason: r.skipped.reason })}</p>}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {recurringActions(r).map((a) => a === "remove"
          ? <Button key={a} variant="danger" disabled={actions.busy} onClick={() => actions.remove(r.id)}>{t(ACTION_WORDS[a])}</Button>
          : <Button key={a} variant={a === "approve" ? "primary" : "quiet"} disabled={actions.busy} onClick={() => void actions.post(r.id, a)}>{t(ACTION_WORDS[a])}</Button>)}
      </div>
    </div>
  );
}

/** A recurring queue's item in the waiting list (kind `recurring`): Approve when it waits for the user's approval. */
export function RecurringRow({ project, a, onChanged, className = "px-3.5 pb-3" }: { project: string; a: AttentionItem; onChanged?: () => void; className?: string }) {
  const actions = useRecurringActions(project, () => onChanged?.());
  if (!a.recurring || !a.approvable) return null;
  return (
    <div className={className}>
      <Button onClick={() => void actions.post(a.recurring!, "approve")} disabled={actions.busy}>{t("recurring.approve")}</Button>
      {actions.error && <p className="mt-2 text-sm text-danger" role="alert">{actions.error}</p>}
    </div>
  );
}
