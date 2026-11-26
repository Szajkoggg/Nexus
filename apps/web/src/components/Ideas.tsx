// The ideas overview (queue IO; docs/ux/ideas-overview.md, mockup 22): the thinking partners' notes by area and
// sub-group, each dated Decided entry with its status, filtered by status and text; and an opened note with its
// entries' histories, its open questions and its queues. The derivation is the server's (GET /api/projects/:id/ideas,
// @nexus/protocol ideas.ts); the notes are only read. A note opens as the layer note:<file>: on a desktop where a step
// opens (in the rail's place), on the phone over the list.
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { HistoryItem, IdeaEntryView, IdeaNoteView, IdeasResponse } from "@nexus/protocol/ideas";
import { projectUrl, useQuery } from "../api.ts";
import { formatClock, formatDate, formatDay, rich, t, type Key } from "../i18n.ts";
import { groupByArea, filterCounts, shownNotes, dispositionOf, implementationOf, queuesDone, IDEA_FILTERS, type IdeaFilter, type ShownNote } from "../ideasView.ts";
import { layerValue } from "../layers.ts";
import { nav, useNav } from "../nav.ts";
import { usePage } from "../page.ts";
import { ActionBar, Button, PanelBody, PanelHeader, ReadError, statusWord } from "./ui.tsx";

import { EntryState, IdeaStatusForm, IdeaStatusHistory, Signal } from "./IdeaStatus.tsx";
import { ideaButton, ideaCard } from "./IdeaForms.tsx";
import { EntryProposals } from "./IdeaProposals.tsx";
import type { IdeaProposalsResponse } from "@nexus/protocol";
import { IdeaActions, IdeaActivity } from "./IdeaOnward.tsx";
export { IdeasMatching } from "./IdeaLinks.tsx";

function NoteState({ note }: { note: IdeaNoteView }) {
  const value = note.implementation ?? (note.entries.length ? "unconfirmed" : "worked_out");
  if (value === "queues_done" || value === "partial" || value === "full") return <span className="inline-flex flex-wrap items-baseline gap-x-2 text-xs text-fg-3">
    <Signal kind={value} />{note.needs_attention ? <span>{t("ideas.attention", { count: note.needs_attention })}</span> : null}</span>;
  const key = value === "worked_out" ? "ideas.status.worked_out" : value === "unconfirmed" ? "ideas.notConfirmed" : `ideas.${value}`;
  return <span className="text-xs text-fg-3">{t(key as Key)}{note.needs_attention ? ` / ${t("ideas.attention", { count: note.needs_attention })}` : ""}</span>;
}

function overviewPlace(project: string): { filter: IdeaFilter; text: string; scroll: number } {
  try { return { filter: "all", text: "", scroll: 0, ...JSON.parse(sessionStorage.getItem(`ideas-overview:${project}`) ?? "{}") }; }
  catch { return { filter: "all", text: "", scroll: 0 }; }
}

/** "14 Nov" for an entry's date (a day, read as local). */
const day = (date: string) => formatDay(new Date(`${date}T00:00:00`));
/** A history line's time: a day alone (what the note dates), or a time ("15 Nov 12:40"). */
const when = (at: string) => (at.length === 10 ? day(at) : formatClock(at, new Date()));
/** "15 Nov 2026" for an entry card's date (a day, read as local). */
const formatDayYear = (date: string) => formatDate(`${date}T00:00:00`);
/** A button of a filter's group (the overview's statuses, the matching's decisions). */
const filterButton = (on: boolean) =>
  `whitespace-nowrap border-l border-line-strong px-2.5 py-1 text-xs first:border-l-0 max-lg:min-h-9 ${on ? "bg-surface-3 font-semibold text-fg" : "text-fg-2 hover:text-fg"}`;

const useIdeas = (project: string) => useQuery<IdeasResponse>(projectUrl(project, "/ideas"), usePage().version);

/** What the Ideas panel shows: its conversations, or the overview of the notes. */
export type IdeasPanelView = "conversations" | "overview";

/** The switch of the Ideas panel between its two views. */
export function IdeasSwitch({ view, onView, wide }: { view: IdeasPanelView; onView: (v: IdeasPanelView) => void; wide?: boolean }) {
  const item = (v: IdeasPanelView) => (
    <button key={v} onClick={() => onView(v)} aria-pressed={view === v}
      className={`rounded-md px-3 py-1 text-[13px] ${wide ? "flex-1 py-1.5 max-lg:min-h-10" : ""} ${view === v ? "bg-surface-3 font-semibold text-fg" : "text-fg-2 hover:text-fg"}`}>
      {t(`ideas.view.${v}`)}
    </button>
  );
  return (
    <div className={`flex shrink-0 items-center gap-0.5 rounded-lg border border-line bg-surface-2 p-0.5 ${wide ? "w-full" : ""}`} role="group" aria-label={t("ideas.view")}>
      {item("conversations")}{item("overview")}
    </div>
  );
}

/** The overview: the filters, then the notes by area and sub-group, each with its entries. */
export function IdeasOverview({ project, areas, phone, top }: { project: string; areas: readonly string[]; phone?: boolean; top?: ReactNode }) {
  const { data, error } = useIdeas(project);
  const open = layerValue(useNav(), "note");
  const [filter, setFilter] = useState<IdeaFilter>(() => overviewPlace(project).filter);
  const scroll = useRef<HTMLDivElement>(null);
  const restored = useRef(false);
  const [text, setText] = useState(() => overviewPlace(project).text);
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  useLayoutEffect(() => {
    if (data && !restored.current && scroll.current) { scroll.current.scrollTop = overviewPlace(project).scroll; restored.current = true; }
  }, [data, project]);
  const remember = (patch: object) => sessionStorage.setItem(`ideas-overview:${project}`, JSON.stringify({ ...overviewPlace(project), ...patch }));
  const counts = data ? filterCounts(data.notes) : undefined;
  const groups = data ? groupByArea(shownNotes(data.notes, filter, text), areas) : [];
  const fold = (key: string) => setFolded((f) => { const n = new Set(f); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  return (
    <div ref={scroll} onScroll={(e) => remember({ scroll: e.currentTarget.scrollTop })} className={`scroll-thin min-h-0 flex-1 overflow-y-auto ${phone ? "px-3 pb-6 pt-3" : "px-6 pb-8 pt-4"} [overflow-wrap:anywhere]`} data-ideas-overview>
      {top}
      {error && <ReadError error={error} what={t("ideas.readError")} />}
      {data && data.notes_dir === null && <p className="text-sm text-fg-3">{t("ideas.noNotesDir")}</p>}
      {data && data.notes_dir !== null && data.notes.length === 0 && (
        <p className="text-sm text-fg-3">{rich("ideas.noNotes", { folder: <code key="folder">{data.notes_dir}</code> })}</p>
      )}
      <div className="my-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-fg-3">{data?.to_match.suggestions ? t("ideas.pendingCount", { count: data.to_match.suggestions }) : t("ideas.noPending")}</p>
        <button onClick={() => nav.open("matching")} className={ideaButton}>{t("ideas.manage")}</button>
      </div>
      {data && counts && data.notes.length > 0 && <>
        <div className={`mb-3 flex items-center gap-2.5 flex-wrap`}>
          <div className="flex flex-wrap gap-1" role="group" aria-label={t("ideas.filterLabel")}>
            {IDEA_FILTERS.filter((f) => f === "all" || f === "attention" || counts[f] > 0).map((f) => (
              <button key={f} onClick={() => { setFilter(f); remember({ filter: f }); }} aria-pressed={filter === f}
                className={`${filterButton(filter === f)} ${f === "queues_done" && filter !== f ? "text-warn hover:text-warn" : ""}`}>
                {t(`ideas.filter.${f}`)}<span className={`ml-1.5 font-normal ${filter === f ? "text-fg-2" : "text-fg-3"}`}>{counts[f]}</span>
              </button>
            ))}
          </div>
          {!phone && <span className="flex-1" />}
          {(
            <input value={text} onChange={(e) => { setText(e.target.value); remember({ text: e.target.value }); }} placeholder={t("ideas.filterText")} aria-label={t("ideas.filterText")}
              className="w-full min-w-0 rounded-lg border border-line-strong bg-canvas px-2.5 py-1 text-xs text-fg placeholder:text-fg-3" />
          )}
        </div>
        {groups.length === 0 && <p className="text-sm text-fg-3">{t("ideas.nothingShown")}</p>}
        {groups.map((a) => {
          const key = a.area ?? "";
          const isFolded = folded.has(key);
          return (
            <section key={key} className="mb-4">
              <div className="flex items-baseline gap-2 px-0.5 pb-1.5">
                <button onClick={() => fold(key)} aria-expanded={!isFolded} aria-label={t("ideas.fold", { area: a.area ?? t("ideas.unsorted") })}
                  className="flex items-baseline gap-2 text-xs font-semibold uppercase tracking-wider text-fg-2 hover:text-fg">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" className="self-center text-fg-3" aria-hidden="true">
                    <path d={isFolded ? "M9 6l6 6-6 6" : "M6 9l6 6 6-6"} />
                  </svg>
                  {a.area ?? t("ideas.unsorted")}
                </button>
                <span className="text-xs text-fg-3">{t("ideas.notes", { count: a.count })}</span>
                {a.area === null && !phone && <span className="text-xs italic text-fg-3">· {t("ideas.unsortedHint")}</span>}
              </div>
              {!isFolded && a.groups.map((g) => (
                <div key={g.group ?? ""} className="mb-2.5">
                  {g.group && <div className="mb-1.5 ml-1 text-xs font-semibold text-fg-3">{a.area} / <span className="text-fg-2">{g.group}</span></div>}
                  <div className="overflow-hidden rounded-xl border border-line bg-surface">
                    {g.notes.map((n) => <NoteRow key={n.note.file} shown={n} on={n.note.file === open} phone={phone} />)}
                  </div>
                </div>
              ))}
            </section>
          );
        })}
      </>}
    </div>
  );
}

/** A note in the list: its title, Summary and status, then its entries (those the filters keep). */
function NoteRow({ shown, on, phone }: { shown: ShownNote; on: boolean; phone?: boolean }) {
  const { note, entries } = shown;
  return (
    <button onClick={() => nav.open(`note:${note.file}`)} aria-current={on || undefined}
      className={`block w-full border-t border-line px-3.5 py-2 text-left first:border-t-0 hover:bg-surface-2 ${on ? "bg-accent/10 shadow-[inset_3px_0_0_var(--color-accent)]" : ""}`}>
      <span className={`flex items-baseline gap-2.5 ${phone ? "flex-wrap" : ""}`}>
        <span className="min-w-0 break-words text-[13.5px] font-semibold text-fg">{note.title}</span>
        {note.summary && <span className={`text-xs text-fg-3 ${phone ? "order-3 basis-full" : "min-w-0 flex-1"}`}>{note.summary}</span>}
        {!note.summary && !phone && <span className="flex-1" />}
        {note.open > 0 && <span className="shrink-0 rounded border border-warn/45 px-1.5 text-[11px] font-semibold text-warn">{t("ideas.open", { count: note.open })}</span>}
        <NoteState note={note} />
      </span>
      {entries.map((e) => <EntryLine key={e.date} e={e} phone={phone} />)}
      {note.entries.length === 0 && (
        <span className="mt-1 block pl-3 text-xs text-fg-3 max-lg:pl-0">{t("ideas.noDecision")}</span>
      )}
    </button>
  );
}

function EntryLine({ e, phone }: { e: IdeaEntryView; phone?: boolean }) {
  const off = dispositionOf(e) !== "active";
  const replacement = e.effective?.disposition === "replaced" ? e.effective.replacement : undefined;
  const q = e.queues[0];
  return (
    <span data-idea-entry={e.ref} className={`mt-1 grid items-baseline gap-2.5 text-xs ${phone ? "grid-cols-[2.75rem_minmax(0,1fr)]" : "grid-cols-[3.25rem_minmax(0,1fr)] pl-3"}`}>
      <span className={`tabular-nums text-fg-3 ${off ? "opacity-60" : ""}`}>{day(e.date)}</span>
      <span className={`text-fg-2 ${off ? "opacity-60" : ""}`}>{e.lead}<span className="text-fg-3"> · {e.decisions}</span></span>
      <span className="col-span-2 flex flex-wrap items-baseline gap-x-2.5 gap-y-1"><EntryState entry={e} />
        {!phone && (q || replacement) && <span className="font-mono text-[11.5px] text-accent">
          {q ? <>{e.queues.map((x) => x.id).join(", ")}<span className="font-sans text-fg-3"> · {statusWord(q.status)}</span></> : replacement ? <span className="font-sans text-fg-3">→ {replacement.replace(/^.*\//, "")}</span> : null}
        </span>}
      </span>
    </span>
  );
}

// ---------------------------------------------------------------- an opened note

/** An opened note: its Summary, its entries with their histories, its open questions and its queues. */
export function NotePanel({ project, file, onClose }: { project: string; file: string; onClose: () => void }) {
  const { data, error } = useIdeas(project);
  const statusLayer = layerValue(useNav(), "idea-status");
  let selection: [string, string?] | undefined;
  try { selection = statusLayer ? JSON.parse(statusLayer) : undefined; } catch { /* A stale or malformed navigation layer has no selected date. */ }
  const note = data?.notes.find((n) => n.file === file);
  const entry = note?.entries.find((e) => e.ref === selection?.[0]);
  const undo = data?.statuses.history.find((a) => a.id === selection?.[1]);
  const [saved, setSaved] = useState(false);
  const where = note?.area ? `${note.area}${note.group ? ` / ${note.group}` : ""}` : t("ideas.unsorted");
  return <>
    <PanelHeader wrap where={where} title={entry ? t("ideas.reviewDecision") : note?.title ?? file.replace(/^.*\//, "")} onClose={statusLayer ? () => nav.close("idea-status") : onClose}
      status={<button onClick={() => nav.file(file)} className="break-all text-left font-mono text-[11.5px] text-accent hover:underline">{file}</button>} />
    <PanelBody>
      {error && <ReadError error={error} what={t("ideas.readError")} />}
      {data && !note && <p className="text-sm text-fg-3">{t("ideas.notFound")}</p>}
      {saved && !entry && <p role="status" className="mb-3 text-xs text-ok">{t("ideas.saved")}</p>}
      {entry && data ? <div className="space-y-4"><IdeaStatusForm key={statusLayer} project={project} entry={entry} data={data} undo={undo}
        onSaved={() => { setSaved(true); nav.close("idea-status"); }} onCancel={() => nav.close("idea-status")} />
        <IdeaStatusHistory data={data} entry={entry} onUndo={(action) => nav.open(`idea-status:${JSON.stringify([entry.ref, action.id])}`)} /></div>
        : note && data && <NoteBody project={project} note={note} data={data} />}
    </PanelBody>
    {entry || !note ? <ActionBar primary={<Button variant="quiet" onClick={() => nav.open("matching")}>{t("ideas.manage")}</Button>}
      secondary={<Button variant="quiet" onClick={() => nav.file(file)}>{t("ideas.openFile")}</Button>} />
      : <ActionBar primary={<div data-note-actions><IdeaActions project={project} file={file} /></div>} />}
  </>;
}

function NoteBody({ project, note, data }: { project: string; note: IdeaNoteView; data: IdeasResponse }) {
  const label = "mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-fg-3";
  const body = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const scroller = body.current?.parentElement;
    if (!scroller) return;
    const key = `idea-note-place:${project}:${note.file}`;
    scroller.scrollTop = Number(sessionStorage.getItem(key)) || 0;
    const save = () => sessionStorage.setItem(key, String(scroller.scrollTop));
    scroller.addEventListener("scroll", save);
    return () => { save(); scroller.removeEventListener("scroll", save); };
  }, [project, note.file]);
  // The agents' link proposals that touch a date of this note show on its card (IWS, part d).
  const proposals = useQuery<IdeaProposalsResponse>(projectUrl(project, "/ideas/proposals"), usePage().version).data;
  const queueTitle = (id: string) => data.links.items.find((r) => r.queue === id)?.title;
  return <div ref={body} className="space-y-4 [overflow-wrap:anywhere]" data-idea-note>
    {note.summary && <section data-box="Summary"><h3 className={label}>{t("ideas.summary")}</h3><p className="text-[13px] leading-relaxed text-fg-2">{note.summary}</p></section>}
    <section data-box="Open" data-idea-open><h3 className={label}>{t("ideas.questions", { count: note.questions.length })}</h3>
      {note.questions.length ? <ul className="list-disc space-y-1 pl-4 text-[12.5px] text-fg-2">{note.questions.map((q, i) => <li key={i}>{q}</li>)}</ul> : <p className="text-xs text-fg-3">{t("ideas.noQuestions")}</p>}
    </section>
    {note.entries.length > 0 && <section><h3 className={label}>{t("ideas.decidedDates", { count: note.entries.length })}</h3>
      <div className="space-y-2">{[...note.entries].reverse().map((e) => <EntryCard key={e.date} e={e} data={data} project={project} proposals={proposals} queueTitle={queueTitle} />)}</div></section>}
    <RelatedWork project={project} note={note} data={data} />
    {note.ideas > 0 && <p className="text-xs text-fg-3">{t("ideas.ideasInFile", { count: note.ideas })}</p>}
    <IdeaActivity project={project} file={note.file} />
    <div className="flex flex-wrap gap-3 text-xs"><button className="text-accent underline" onClick={() => nav.open("matching")}>{t("ideas.manage")}</button>
      <button className="text-accent underline" onClick={() => nav.file(note.file)}>{t("ideas.readOnlyNote")}</button></div>
  </div>;
}

function EntryCard({ e, data, project, proposals, queueTitle }: {
  e: IdeaEntryView; data: IdeasResponse; project: string; proposals?: IdeaProposalsResponse; queueTitle: (id: string) => string | undefined;
}) {
  const change = (action?: string) => nav.open(`idea-status:${JSON.stringify([e.ref, action])}`);
  const done = dispositionOf(e) === "active" && queuesDone(e);
  return <article className={ideaCard} data-box={`Decision ${e.date}`} data-decision={e.ref}>
    <div className="flex flex-wrap items-baseline justify-between gap-2"><b className="text-[13px]">{formatDayYear(e.date)}</b><EntryState entry={e} compact /></div>
    <p className="text-[12.5px] text-fg-2">{e.lead} / {t("ideas.decisions", { count: e.decisions })}</p>
    <EntryFacts e={e} />
    {e.effective?.diagnostics.map((d) => <p key={d} className="text-xs text-warn">{d}</p>)}
    {proposals && <EntryProposals project={project} data={proposals} entryRef={e.ref} queueTitle={queueTitle} />}
    <div className="flex flex-wrap items-center gap-3 text-xs">{done
      ? <button className={ideaButton} data-review-confirm onClick={() => change()}>{t("ideas.reviewAndConfirm")}</button>
      : <button className="text-accent underline" onClick={() => change()}>{t(e.effective?.work.state === "finished" && !["full", "partial"].includes(implementationOf(e)) ? "ideas.reviewImplementation" : "ideas.changeStatus")}</button>}
      <details className="min-w-0 flex-1"><summary className="text-accent">{t("ideas.history")}</summary>
        <ol className="mt-2 space-y-1">{e.history.map((h, i) => <HistoryLine key={i} h={h} />)}</ol>
        {e.effective && <IdeaStatusHistory data={data} entry={e} onUndo={(action) => change(action.id)} />}
      </details></div>
    <details className="text-xs text-fg-3"><summary>{t("ideas.decisionText")}</summary><pre className="mt-2 whitespace-pre-wrap font-sans leading-relaxed">{e.content}</pre></details>
  </article>;
}

/**
 * What an entry card says under its lead: with every linked queue done and no confirmation, the queues and that only
 * the user confirms; with the user's assessment, who assessed it when and why, then the queues; else the work and
 * assessment words as before (IWS).
 */
function EntryFacts({ e }: { e: IdeaEntryView }) {
  const effective = e.effective, implementation = implementationOf(e);
  const queues = effective?.work.queues ?? [];
  const linked = queues.length ? t("ideas.linkedQueues", { queues: queues.map((q) => `${q.id} ${statusWord(q.status)}`).join(", "),
    done: queues.filter((q) => q.status === "done").length, count: queues.length }) : "";
  if (dispositionOf(e) === "active" && queuesDone(e)) return <p className="text-xs text-fg-2">{linked} {t("ideas.onlyYouConfirm")}</p>;
  const a = effective?.assessment;
  if (dispositionOf(e) === "active" && a && (implementation === "full" || implementation === "partial")) return <p className="text-xs text-fg-2">
    {t(implementation === "full" ? "ideas.confirmedBy" : "ideas.assessedBy", { date: day(a.at.slice(0, 10)), reason: a.reason })} {linked}</p>;
  return <EntryState entry={e} />;
}

function RelatedWork({ project, note, data }: { project: string; note: IdeaNoteView; data: IdeasResponse }) {
  const links = data.links.items.filter((r) => r.effective && note.entries.some((e) => e.ref === r.ref));
  const ids = [...new Set(links.map((r) => r.queue))];
  return <details className="border-t border-line pt-3" data-related-work><summary className="text-sm font-semibold">{t("ideas.related", { count: ids.length })}</summary>
    <div className="mt-3 space-y-3">{ids.map((id) => {
      const q = note.queues.find((q) => q.id === id), origins = links.filter((r) => r.queue === id), outcome = q?.outcome;
      return <article key={id} className={ideaCard}><button className="text-left text-sm font-semibold text-accent" disabled={!q} onClick={() => nav.item(project, id)}>{id} / {q?.title ?? origins[0]?.title}</button>
        <p className="text-xs text-fg-3">{q ? statusWord(q.status) : t("ideas.link.missing")}</p>
        <p className="text-[13px] leading-relaxed">{outcome?.text ?? t("ideas.reportUnavailable")}</p>
        {outcome && outcome.report.source_status !== "current" && outcome.kind === "queue-report" && <p className="text-xs text-warn">{t("ideas.reportSource", { status: outcome.report.source_status })}</p>}
        {outcome && <p className="text-xs text-fg-3">{outcome.kind === "queue-report" ? t("ideas.reportScope") : outcome.kind === "accepted-steps" ? t("ideas.stepsScope", { sampled: outcome.sampled_steps, total: outcome.substantive_steps }) : ""}</p>}
        {q && <button className="text-xs text-accent underline" onClick={() => outcome?.report.available ? nav.file(outcome.report.path) : nav.item(project, id)}>{t("ideas.report")}</button>}
        {outcome && <details className="text-xs text-fg-3"><summary>{t("ideas.acceptedEvidence")}</summary>
          <p className="mt-2">{t("ideas.reportSource", { status: outcome.report.source_status })}</p>
          {outcome.warnings.map((w) => <p key={w} className="mt-1 text-warn">{w}</p>)}
          {outcome.accepted.map((a) => <div key={a.event} className="mt-3"><button className="text-accent underline" onClick={() => nav.item(project, id, a.step)}>{a.step} / {a.round}</button><p>{a.summary}</p><code>{a.commit}</code></div>)}
          {!!outcome.historical.length && <details className="mt-3"><summary>{t("ideas.historicalEvidence")}</summary>{outcome.historical.map((a) => <p key={a.event}>{a.step} / {a.round} / {a.summary}</p>)}</details>}
        </details>}
        <details className="text-xs text-fg-3"><summary>{t("ideas.linkedDetails")}</summary>{origins.map((r) => <div key={r.id} className="mt-2"><p>{r.origin} / {r.ref}</p><p>{r.quote}</p>{r.diagnostics.map((d) => <p key={d} className="text-warn">{d}</p>)}</div>)}</details>
      </article>;
    })}</div>
  </details>;
}

const HISTORY_DOT: Partial<Record<HistoryItem["kind"], string>> = {
  decided: "bg-info", handed_over: "bg-review", queued: "bg-accent", finished: "bg-ok", dropped: "bg-fg-3", replaced: "bg-fg-3",
};

function HistoryLine({ h }: { h: HistoryItem }) {
  const faint = h.kind === "approved" || h.kind === "started" || h.kind === "cancelled";
  const text = h.kind === "handed_over" && h.conversation ? t("ideas.history.handedOverIn", { conversation: h.conversation })
    : h.kind === "replaced" && h.text ? t("ideas.replacedBy", { ref: h.text })
    : t(`ideas.history.${h.kind}` as Key, { queue: h.queue ?? "" });
  return (
    <li className={`relative flex gap-2 pl-4 text-xs leading-relaxed ${faint ? "text-fg-3" : "text-fg-2"}`}>
      <span className={`absolute left-0 top-[7px] h-[7px] w-[7px] rounded-full ${HISTORY_DOT[h.kind] ?? "bg-line-strong"}`} />
      <span className="w-[5.5rem] shrink-0 tabular-nums text-fg-3">{when(h.at)}</span>
      <span className="min-w-0">{text}{h.commit && <span className="ml-1 font-mono text-[11px] text-accent">{h.commit.slice(0, 7)}</span>}</span>
    </li>
  );
}
