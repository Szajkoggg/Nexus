import { useState } from "react";
import type { IdeaStatusAction } from "@nexus/protocol";
import type { IdeaEntryView, IdeasResponse } from "@nexus/protocol/ideas";
import { dispositionOf, implementationOf, workOf } from "../ideasView.ts";
import { formatDate, t, type Key } from "../i18n.ts";
import { DecisionPicker, IdeaField, IdeaSaveState, ideaButton, ideaCard, ideaInput, useIdeaSave } from "./IdeaForms.tsx";

export function EntryState({ entry, compact = false }: { entry: IdeaEntryView; compact?: boolean }) {
  const disposition = dispositionOf(entry), implementation = implementationOf(entry);
  const label = implementation === "needs_review" && entry.effective?.assessment?.kind === "full" ? "previousFull" : implementation === "unconfirmed" ? "notConfirmed" : implementation;
  return <span className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs leading-relaxed">
    {disposition !== "active" ? <span className="text-fg-3">{t(`ideas.${disposition}`)}</span> : <>
      {(!compact || implementation === "unconfirmed") && <span className="text-accent">{t(`ideas.work.${workOf(entry)}`)}</span>}
      {(!compact || implementation !== "unconfirmed") && <span className={implementation === "full" ? "text-ok" : implementation === "needs_review" ? "text-warn" : "text-fg-3"}>{t(`ideas.${label}` as Key)}</span>}
    </>}
  </span>;
}

const operations = ["partial", "confirm", "drop", "replace", "reopen", "revoke", "keep", "adopt-marker"] as const;

export function IdeaStatusForm({ project, entry, data, undo, onSaved, onCancel }: {
  project: string; entry: IdeaEntryView; data: IdeasResponse; undo?: IdeaStatusAction; onSaved: () => void; onCancel: () => void;
}) {
  const e = entry.effective!;
  const [operation, setOperation] = useState<(typeof operations)[number]>(e.disposition === "active" ? "partial" : "reopen");
  const [reason, setReason] = useState("");
  const [target, setTarget] = useState("");
  const [references, setReferences] = useState("");
  const [caveat, setCaveat] = useState("");
  const save = useIdeaSave(project, "statuses", data.statuses.revision, onSaved);
  const full = !undo && operation === "confirm";
  const assessment = !undo && (operation === "confirm" || operation === "partial");
  const blocked = full && (e.blockers.length > 0 || e.disposition !== "active");
  return <form className="space-y-4 text-sm [overflow-wrap:anywhere]" data-idea-status-form onSubmit={(event) => {
    event.preventDefault();
    save.save({ ref: entry.ref, operation: undo ? "undo" : operation, reason,
      ...(undo ? { action: undo.id } : {}), ...(operation === "replace" && !undo ? { target } : {}),
      ...(assessment ? { evidence_refs: references.split("\n").map((s) => s.trim()).filter(Boolean), ...(caveat.trim() ? { caveat_reason: caveat } : {}) } : {}) });
  }}>
    <section data-box="Status scope"><h3 className="text-xs font-semibold text-fg-3">{formatDate(`${entry.date}T00:00:00`)}</h3><p className="mt-2">{entry.lead}</p>
      <details className="mt-2 text-xs text-fg-2"><summary>{t("ideas.decisionText")}</summary><pre className="mt-2 whitespace-pre-wrap font-sans">{entry.content}</pre></details></section>
    <div className={ideaCard} data-box="Current assessment"><EntryState entry={entry} />
      {e.stale_reasons.map((s) => <p key={s} className="text-xs text-warn">{s}</p>)}
      <p className="text-xs text-fg-3">{t("ideas.currentDisposition", { state: t(`ideas.${e.disposition}`) })}</p>
      {e.disposition === "replaced" && e.replacement && <code className="block text-xs">{e.replacement}</code>}
    </div>
    <section><h3 className="text-xs font-semibold text-fg-3">{t("ideas.linkedDetails")}</h3>
      {e.work.queues.map((q) => <p key={q.id} className="mt-1 text-xs">{q.id} · {q.status}{q.issues.map((s) => <span key={s} className="block text-warn">{s}</span>)}</p>)}
      <p className="mt-2 text-xs text-fg-3">{t("ideas.noDeployment")}</p></section>
    {undo ? <div className={ideaCard}><h3>{t("ideas.undoPreview")}</h3><p>{undo.operation} · {undo.reason}</p>
      <pre className="whitespace-pre-wrap text-xs">{JSON.stringify({ disposition: undo.before?.disposition ?? e.marker, assessment: undo.before?.assessment?.kind ?? "unconfirmed" }, null, 2)}</pre></div>
      : <IdeaField label={t("ideas.yourDecision")}><select className={ideaInput} value={operation} onChange={(event) => setOperation(event.target.value as typeof operation)}>
        {operations.map((o) => <option key={o} value={o}>{t(`ideas.operation.${o}`)}</option>)}
      </select></IdeaField>}
    {!undo && operation === "replace" && <DecisionPicker data={data} value={target} onChange={setTarget} exclude={entry.ref} />}
    <IdeaField label={assessment ? t("ideas.assessmentReason") : t("ideas.reason")}><textarea className={ideaInput} value={reason} onChange={(event) => setReason(event.target.value)} required rows={3} /></IdeaField>
    {assessment && <IdeaField label={t("ideas.evidenceRefs")}><textarea className={ideaInput} value={references} onChange={(event) => setReferences(event.target.value)} rows={2} required={full && !e.snapshot.links.length} /></IdeaField>}
    {full && !e.snapshot.links.length && <p className="text-xs text-fg-3">{t("ideas.noQueueEvidence")}</p>}
    {full && e.caveats.length > 0 && <IdeaField label={t("ideas.caveatReason")}><textarea className={ideaInput} value={caveat} onChange={(event) => setCaveat(event.target.value)} required rows={3} /></IdeaField>}
    {blocked && <div role="alert" className="text-xs text-warn">{e.disposition !== "active" && t("ideas.operation.reopen")}{e.blockers.map((s) => <p key={s}>{s}</p>)}</div>}
    <p className="text-xs text-fg-3">{t("ideas.noQueueAction")}</p><IdeaSaveState save={save} />
    <div className="flex flex-wrap gap-2"><button className={`${ideaButton} bg-accent/15`} disabled={save.busy || save.stale || blocked || !reason.trim()}>{save.busy ? t("ideas.saving") : t("ideas.saveDecision")}</button>
      <button type="button" className={ideaButton} onClick={onCancel} disabled={save.busy}>{t("ideas.cancel")}</button></div>
  </form>;
}

export function IdeaStatusHistory({ data, entry, onUndo }: { data: IdeasResponse; entry: IdeaEntryView; onUndo: (action: IdeaStatusAction) => void }) {
  const history = data.statuses.history.filter((h) => h.ref === entry.ref);
  const e = entry.effective!;
  return <div className="space-y-3 text-xs [overflow-wrap:anywhere]">
    {(Object.keys(e.marker).length > 0 || e.marker_status === "conflict") && <details><summary className={e.marker_status === "conflict" ? "text-warn" : "text-fg-3"}>{t(e.marker_status === "conflict" ? "ideas.markerConflict" : e.marker_status === "overridden" ? "ideas.markerHistorical" : "ideas.markerDetails")}</summary>
      <pre className="mt-2 whitespace-pre-wrap">{JSON.stringify(e.marker, null, 2)}</pre><p>{t("ideas.currentDisposition", { state: t(`ideas.${e.disposition}`) })}</p></details>}
    {e.assessment && <details><summary>{t("ideas.assessmentDetails")}</summary><p className="mt-2">{e.assessment.kind} · {e.assessment.at}</p><p>{e.assessment.reason}</p>{e.assessment.evidence_refs.map((r) => <p key={r}>{r}</p>)}</details>}
    <details data-status-history><summary>{t("ideas.statusHistory")}</summary>
      {!history.length && <p className="mt-2 text-fg-3">{t("ideas.noHistory")}</p>}
      {[...history].reverse().map((h) => <div key={h.id} className="mt-3 border-l border-line pl-3"><p>{h.at} · {h.actor} · {h.operation}</p><p>{h.reason}</p>
        <p>{h.before?.disposition?.state ?? t("ideas.markerDetails")} → {h.after?.disposition?.state ?? t("ideas.markerDetails")} · {h.before?.assessment?.kind ?? t("ideas.notConfirmed")} → {h.after?.assessment?.kind ?? t("ideas.notConfirmed")}</p>
        {h.undo && <p>↶ {h.undo}</p>}{h === history.at(-1) && <button className={`${ideaButton} mt-2`} onClick={() => onUndo(h)}>{t("ideas.undo")}</button>}</div>)}
      {data.statuses.invalidations.filter((i) => i.ref === entry.ref).map((i) => <p key={i.assessment} className="mt-3 text-warn">{i.at} · {i.reasons.join("; ")}</p>)}
    </details>
  </div>;
}
