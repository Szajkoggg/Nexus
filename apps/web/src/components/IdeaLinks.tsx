import { useLayoutEffect, useRef, useState } from "react";
import { applyStateMessage } from "../liveViews.ts";
import type { IdeaLinkAction, IdeaLinkView } from "@nexus/protocol";
import type { IdeasResponse } from "@nexus/protocol/ideas";
import { projectUrl, useQuery, useLiveRead, type ProjectState } from "../api.ts";
import { t, type Key } from "../i18n.ts";
import { nav, useNav } from "../nav.ts";
import { layerValue } from "../layers.ts";
import { usePage } from "../page.ts";
import { ReadError } from "./ui.tsx";
import { DecisionPicker, IdeaField, IdeaSaveState, ideaButton, ideaCard, ideaInput, useIdeaSave } from "./IdeaForms.tsx";

type Filter = "all" | "pending" | "linked" | "rejected" | "attention";
const filters: Filter[] = ["all", "pending", "linked", "rejected", "attention"];
const matches = (r: IdeaLinkView, f: Filter) => f === "all" || (f === "attention" ? r.diagnostics.length > 0 : f === "linked" ? r.effective : r.state === f);
type Edit = { operation: IdeaLinkAction["operation"]; origin?: IdeaLinkView; accept?: boolean | null; action?: IdeaLinkAction };
const originLabel = (r: IdeaLinkView) => t(r.state === "ignored" ? "ideas.link.ignored" : `ideas.link.${r.origin}`);

export function IdeasMatching({ project, phone }: { project: string; phone?: boolean }) {
  const note = layerValue(useNav(), "note");
  const { version, reload } = usePage();
  const { data, error } = useQuery<IdeasResponse>(projectUrl(project, "/ideas"), version);
  const state = useLiveRead<ProjectState>(projectUrl(project, "/state"), project, applyStateMessage);
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [edit, setEdit] = useState<Edit>();
  const [saved, setSaved] = useState(false);
  const form = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { if (edit) form.current?.scrollIntoView({ block: "nearest" }); }, [edit]);
  const items = data?.links.items ?? [];
  const shown = items.filter((r) => matches(r, filter) && `${r.queue} ${r.title} ${r.ref} ${r.note_title} ${r.lead}`.toLowerCase().includes(search.toLowerCase()));
  const begin = (value: Edit) => { setEdit(value); setSaved(false); };
  return <div className={`scroll-thin min-h-0 flex-1 overflow-y-auto ${phone ? "px-3 pb-6 pt-3" : "px-6 pb-8 pt-4"} [overflow-wrap:anywhere]`} data-ideas-matching>
    <div className="mx-auto max-w-4xl space-y-4">
      <button className="text-xs text-accent hover:underline" onClick={() => nav.close("matching")}>‹ {t(note ? "ideas.backNote" : "ideas.backOverview")}</button>
      <h1 className="text-xl font-semibold">{t("ideas.manage")}</h1>
      {error && <ReadError error={error} what={t("ideas.readError")} />}
      {state.error && <ReadError error={state.error} what={t("ideas.findQueue")} />}
      {(error || state.error) && <button className={ideaButton} onClick={reload}>{t("ideas.refresh")}</button>}
      <div className="flex flex-wrap gap-2" role="group" aria-label={t("ideas.manage")}>
        {filters.map((f) => <button key={f} className={`${ideaButton} ${filter === f ? "bg-accent/15 border-accent/50" : ""}`} aria-pressed={filter === f} onClick={() => setFilter(f)}>{t(`ideas.link.${f}`)} · {items.filter((r) => matches(r, f)).length}</button>)}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3"><p className="text-xs text-fg-3">{t("ideas.link.scope")}</p>
        <button className={ideaButton} disabled={!data || !state.data || !!error || !!state.error} onClick={() => begin({ operation: "add" })}>{t("ideas.link.add")}</button></div>
      <input aria-label={t("ideas.link.find")} placeholder={t("ideas.link.find")} className={ideaInput} value={search} onChange={(e) => setSearch(e.target.value)} />
      {saved && <p role="status" className="text-sm text-ok">{t("ideas.saved")}</p>}
      <div ref={form}>{edit && data && state.data && <LinkForm key={`${edit.operation}:${edit.origin?.id ?? edit.action?.id ?? "new"}:${edit.accept}`} project={project} data={data} queues={state.data.queues} edit={edit}
        onCancel={() => setEdit(undefined)} onSaved={() => { setEdit(undefined); setSaved(true); }} />}</div>
      {!shown.length && data && <p className="text-sm text-fg-3">{t("ideas.link.noItems")}</p>}
      {shown.map((r) => <article key={r.id} className={ideaCard} data-box={`Link ${r.id}`} data-origin={r.id}>
        <h2 className="text-sm font-semibold">{r.queue} · {r.title}</h2>
        <p className="text-xs text-fg-3">{originLabel(r)} · {r.state}{r.at ? ` · ${r.at}` : ""}</p>
        <p className="text-sm text-fg-2">{r.note_title ?? r.ref}</p><code className="block text-xs text-accent">{r.ref}</code>
        {r.diagnostics.map((d) => <p key={d} className="text-xs text-warn">{d}</p>)}
        {r.effective && items.some((x) => x.id !== r.id && x.queue === r.queue && x.ref === r.ref && x.effective) && <p className="text-xs text-fg-3">{t("ideas.link.otherOrigin")}</p>}
        <div className="flex flex-wrap gap-2">
          {r.origin === "match" && <>
            {r.state !== "linked" && <button className={ideaButton} onClick={() => begin({ operation: "decide", origin: r, accept: true })}>{t("ideas.link.accept")}</button>}
            {r.state !== "rejected" && <button className={ideaButton} onClick={() => begin({ operation: "decide", origin: r, accept: false })}>{t("ideas.link.reject")}</button>}
            {r.state !== "pending" && <button className={ideaButton} onClick={() => begin({ operation: "decide", origin: r, accept: null })}>{t("ideas.link.pending")}</button>}
          </>}
          {r.state === "linked" && <>
            <button className={ideaButton} onClick={() => begin({ operation: r.origin === "source" ? "correct-source" : "replace", origin: r })}>{t(r.origin === "source" ? "ideas.link.correct-source" : "ideas.link.replace")}</button>
            <button className={ideaButton} onClick={() => begin({ operation: r.origin === "source" ? "ignore-source" : "remove", origin: r })}>{t(r.origin === "source" ? "ideas.link.ignore-source" : "ideas.link.remove")}</button>
          </>}
        </div>
        <details className="text-xs text-fg-3"><summary>{t("ideas.link.evidence")}</summary>
          <p className="mt-2">{r.quote}</p>{r.kind && <p>{r.kind}</p>}{r.location && <p>{t("ideas.link.location")}: {r.location}</p>}
          {r.recorded_evidence && <div className="mt-2"><b>{t("ideas.link.historicalEvidence")}</b><p>{r.recorded_evidence.quote}</p></div>}
          {r.current_suggestion && <div className="mt-2"><b>{t("ideas.link.currentEvidence")}</b><p>{r.current_suggestion.quote}</p></div>}
          {r.origin === "match" && <p className="mt-2">{t("ideas.link.sourceSeparate")}</p>}
        </details>
      </article>)}
      {data && <details className={ideaCard} data-link-history><summary className="font-semibold">{t("ideas.link.history")} · {data.links.history.length}</summary>
        {!data.links.history.length && <p className="text-xs text-fg-3">{t("ideas.noHistory")}</p>}
        {[...data.links.history].reverse().map((h) => {
          const index = data.links.history.indexOf(h);
          const newer = data.links.history.slice(index + 1).some((later) => later.changes.some((c) => h.changes.some((old) => old.after.id === c.after.id)));
          return <div key={h.id} className="space-y-2 border-t border-line pt-3 text-xs"><p>{h.at} · {h.actor} · {h.operation}</p><p>{h.reason}</p>
            {h.changes.map((c) => <p key={c.after.id}>{c.after.queue} · {c.before?.ref ?? "—"} ({c.before?.state ?? "—"}) → {c.after.ref} ({c.after.state})</p>)}
            {h.undo && <p>↶ {h.undo}</p>}{!newer && <button className={ideaButton} onClick={() => begin({ operation: "undo", action: h })}>{t("ideas.link.undo")}</button>}</div>;
        })}
      </details>}
    </div>
  </div>;
}

function LinkForm({ project, data, queues, edit, onCancel, onSaved }: {
  project: string; data: IdeasResponse; queues: ProjectState["queues"]; edit: Edit; onCancel: () => void; onSaved: () => void;
}) {
  const [search, setSearch] = useState("");
  const [queue, setQueue] = useState("");
  const [ref, setRef] = useState("");
  const [reason, setReason] = useState("");
  const save = useIdeaSave(project, "links", data.links.revision, onSaved);
  const target = ["add", "replace", "correct-source"].includes(edit.operation);
  const selected = queues.find((q) => q.id === queue);
  const title = edit.operation === "decide" ? edit.accept === null ? t("ideas.link.pending") : t(edit.accept ? "ideas.link.accept" : "ideas.link.reject") : t(`ideas.link.${edit.operation}` as Key);
  const nextState = edit.operation === "decide" ? edit.accept === null ? "pending" : edit.accept ? "linked" : "rejected" : edit.origin?.origin === "source" ? "ignored" : "removed";
  return <form className={`${ideaCard} border-accent/50`} data-link-form data-box="Correction" onSubmit={(e) => {
    e.preventDefault(); save.save({ operation: edit.operation, reason,
      ...(edit.operation === "add" ? { queue } : {}), ...(target ? { ref } : {}),
      ...(edit.origin && edit.operation !== "decide" ? { origin: edit.origin.id } : {}),
      ...(edit.operation === "decide" ? { decisions: [{ origin: edit.origin!.id, accept: edit.accept }] } : {}),
      ...(edit.action ? { action: edit.action.id } : {}) });
  }}>
    <h2 className="font-semibold">{edit.origin ? `${edit.origin.queue} · ${edit.origin.title}` : title}</h2>
    {edit.origin && <p className="text-xs text-fg-3">{originLabel(edit.origin)} · {edit.origin.state}</p>}
    {edit.origin && <h3 className="font-semibold">{title}</h3>}
    {edit.operation === "add" && <>
      <IdeaField label={t("ideas.findQueue")}><input className={ideaInput} value={search} onChange={(e) => setSearch(e.target.value)} /></IdeaField>
      <IdeaField label={t("ideas.chooseQueue")}><select className={ideaInput} value={queue} onChange={(e) => setQueue(e.target.value)} required><option value="">{t("ideas.chooseQueue")}</option>
        {queues.filter((q) => q.id === queue || `${q.id} ${q.title}`.toLowerCase().includes(search.toLowerCase())).map((q) => <option key={q.id} value={q.id}>{q.id} · {q.title}</option>)}
      </select></IdeaField>{selected && <p className="text-xs">{selected.id} · {selected.title} · {selected.status}</p>}
    </>}
    <div className={target && edit.origin ? "grid gap-4 min-[700px]:grid-cols-2" : "space-y-2"}>
      {edit.origin && <div><p className="mb-2 text-xs text-fg-3">{t("ideas.from")} · {originLabel(edit.origin)}</p><code className="text-xs">{edit.origin.ref}</code></div>}
      {target && <DecisionPicker data={data} value={ref} onChange={setRef} exclude={edit.origin?.ref} />}
    </div>
    {edit.action && <div className="space-y-2 text-xs"><p>{t("ideas.link.undoScope")}</p>{edit.action.changes.map((c) => <p key={c.after.id}>{c.after.queue} · {c.after.ref} ({c.after.state}) → {c.before?.ref ?? c.after.ref} ({t(`ideas.link.${c.before?.state ?? "removed"}`)})</p>)}</div>}
    {!target && edit.origin && <p className="text-xs">{t("ideas.to")} · {t(`ideas.link.${nextState}`)}</p>}
    <IdeaField label={t("ideas.reason")}><textarea className={ideaInput} value={reason} onChange={(e) => setReason(e.target.value)} required rows={3} /></IdeaField>
    <p className="text-xs text-fg-3">{t("ideas.link.scope")}</p><IdeaSaveState save={save} />
    <div className="flex flex-wrap gap-2"><button className={`${ideaButton} bg-accent/15`} disabled={save.busy || save.stale || !reason.trim()}>{save.busy ? t("ideas.saving") : t("ideas.saveCorrection")}</button>
      <button type="button" className={ideaButton} onClick={onCancel} disabled={save.busy}>{t("ideas.cancel")}</button></div>
  </form>;
}
