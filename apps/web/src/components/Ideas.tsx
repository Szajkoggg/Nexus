// The ideas overview (queue IO; docs/ux/ideas-overview.md, mockup 22): the thinking partners' notes by area and
// sub-group, each dated Decided entry with its status, filtered by status and text; and an opened note with its
// entries' histories, its open questions and its queues. The derivation is the server's (GET /api/projects/:id/ideas,
// @nexus/protocol ideas.ts); the notes are only read. A note opens as the layer note:<file>: on a desktop where a step
// opens (in the rail's place), on the phone over the list.
import { useState, type ReactNode } from "react";
import type { HistoryItem, IdeaEntryView, IdeaMatchesResponse, IdeaNoteView, IdeasResponse, MatchItem, TopicStatus } from "@nexus/protocol/ideas";
import { act, projectUrl, useAction, useQuery } from "../api.ts";
import { formatClock, formatDate, formatDay, rich, t, type Key } from "../i18n.ts";
import { groupByArea, filterCounts, shownNotes, IDEA_FILTERS, type IdeaFilter, type ShownNote } from "../ideasView.ts";
import { layerValue } from "../layers.ts";
import { nav, useNav } from "../nav.ts";
import { usePage } from "../page.ts";
import { ActionBar, Button, PanelBody, PanelHeader, ReadError, statusWord } from "./ui.tsx";

/** The colour of each status: a dot and a word (an open ring for a topic still being worked out). */
const TONE: Record<TopicStatus, { dot: string; text: string }> = {
  worked_out: { dot: "border border-fg-3", text: "text-fg-3" },
  decided: { dot: "bg-info", text: "text-info" },
  handed_over: { dot: "bg-review", text: "text-review" },
  queued: { dot: "bg-accent", text: "text-accent" },
  built: { dot: "bg-ok", text: "text-ok" },
  dropped: { dot: "bg-fg-3", text: "text-fg-3" },
  replaced: { dot: "bg-fg-3", text: "text-fg-3" },
};

function IdeaStatus({ status, className = "" }: { status: TopicStatus; className?: string }) {
  const tone = TONE[status];
  return (
    <span className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap text-xs ${tone.text} ${className}`}>
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${tone.dot}`} />
      {t(`ideas.status.${status}` as Key)}
    </span>
  );
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
  const [filter, setFilter] = useState<IdeaFilter>("all");
  const [text, setText] = useState("");
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  const counts = data ? filterCounts(data.notes) : undefined;
  const groups = data ? groupByArea(shownNotes(data.notes, filter, text), areas) : [];
  const fold = (key: string) => setFolded((f) => { const n = new Set(f); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  return (
    <div className={`scroll-thin min-h-0 flex-1 overflow-y-auto ${phone ? "px-3 pb-6 pt-3" : "px-6 pb-8 pt-4"}`} data-ideas-overview>
      {top}
      {!data && error && <ReadError error={error} what={t("ideas.readError")} />}
      {data && data.notes_dir === null && <p className="text-sm text-fg-3">{t("ideas.noNotesDir")}</p>}
      {data && data.notes_dir !== null && data.notes.length === 0 && (
        <p className="text-sm text-fg-3">{rich("ideas.noNotes", { folder: <code key="folder">{data.notes_dir}</code> })}</p>
      )}
      {data && counts && data.notes.length > 0 && <>
        <div className={`mb-3 flex items-center gap-2.5 ${phone ? "scroll-thin -mx-3 overflow-x-auto px-3 pb-1" : "flex-wrap"}`}>
          <div className="flex shrink-0 overflow-hidden rounded-lg border border-line-strong" role="group" aria-label={t("ideas.filterLabel")}>
            {IDEA_FILTERS.filter((f) => f === "all" || counts[f] > 0).map((f) => (
              <button key={f} onClick={() => setFilter(f)} aria-pressed={filter === f}
                className={filterButton(filter === f)}>
                {t(`ideas.filter.${f}`)}<span className={`ml-1.5 font-normal ${filter === f ? "text-fg-2" : "text-fg-3"}`}>{counts[f]}</span>
              </button>
            ))}
          </div>
          {!phone && <span className="flex-1" />}
          {!phone && (
            <input value={text} onChange={(e) => setText(e.target.value)} placeholder={t("ideas.filterText")} aria-label={t("ideas.filterText")}
              className="w-40 min-w-0 rounded-lg border border-line-strong bg-canvas px-2.5 py-1 text-xs text-fg placeholder:text-fg-3" />
          )}
        </div>
        {data.to_match.suggestions > 0 && <ToMatchBanner suggestions={data.to_match.suggestions} queues={data.to_match.queues} />}
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
        <span className={`truncate text-[13.5px] font-semibold text-fg ${phone ? "min-w-0 flex-1" : "shrink-0"}`}>{note.title}</span>
        {note.summary && <span className={`truncate text-xs text-fg-3 ${phone ? "order-3 basis-full" : "min-w-0 flex-1"}`}>{note.summary}</span>}
        {!note.summary && !phone && <span className="flex-1" />}
        {note.open > 0 && <span className="shrink-0 rounded border border-warn/45 px-1.5 text-[11px] font-semibold text-warn">{t("ideas.open", { count: note.open })}</span>}
        <IdeaStatus status={note.status} />
      </span>
      {entries.map((e) => <EntryLine key={e.date} e={e} phone={phone} />)}
      {note.entries.length === 0 && (
        <span className="mt-1 block pl-3 text-xs text-fg-3 max-lg:pl-0">{t("ideas.noDecision")}</span>
      )}
    </button>
  );
}

function EntryLine({ e, phone }: { e: IdeaEntryView; phone?: boolean }) {
  const off = e.status === "dropped" || e.status === "replaced";
  const q = e.queues[0];
  return (
    <span className={`mt-1 grid items-baseline gap-2.5 text-xs ${phone ? "grid-cols-[2.75rem_minmax(0,1fr)_auto]" : "grid-cols-[3.25rem_minmax(0,1fr)_auto_8rem] pl-3"}`}>
      <span className={`tabular-nums text-fg-3 ${off ? "opacity-60" : ""}`}>{day(e.date)}</span>
      <span className={`truncate text-fg-2 ${off ? "opacity-60" : ""}`}>{e.lead}<span className="text-fg-3"> · {e.decisions}</span></span>
      <IdeaStatus status={e.status} />
      {!phone && (
        <span className="truncate font-mono text-[11.5px] text-accent">
          {q ? <>{e.queues.map((x) => x.id).join(", ")}<span className="font-sans text-fg-3"> · {statusWord(q.status)}</span></> : e.replaced_by ? <span className="font-sans text-fg-3">→ {e.replaced_by.replace(/^.*\//, "")}</span> : null}
        </span>
      )}
    </span>
  );
}

// ---------------------------------------------------------------- an opened note

/** An opened note: its Summary, its entries with their histories, its open questions and its queues. */
export function NotePanel({ project, file, onClose }: { project: string; file: string; onClose: () => void }) {
  const { data, error } = useIdeas(project);
  const note = data?.notes.find((n) => n.file === file);
  const where = note ? (note.area ? `${note.area_from === "queues" ? t("ideas.areaFromQueues", { area: note.area }) : note.area}${note.group ? ` / ${note.group}` : ""}` : t("ideas.unsorted")) : "";
  return <>
    <PanelHeader where={where} title={note?.title ?? file.replace(/^.*\//, "")} onClose={onClose}
      status={<>
        <button onClick={() => nav.file(file)} className="truncate font-mono text-[11.5px] text-accent hover:underline">{file}</button>
        {note && <IdeaStatus status={note.status} />}
      </>} />
    <PanelBody>
      {!data && error && <ReadError error={error} what={t("ideas.readError")} />}
      {data && !note && <p className="text-sm text-fg-3">{t("ideas.notFound")}</p>}
      {note && <NoteBody project={project} note={note} />}
    </PanelBody>
    <ActionBar primary={<Button variant="quiet" onClick={() => nav.file(file)}>{t("ideas.openFile")}</Button>} />
  </>;
}

function NoteBody({ project, note }: { project: string; note: IdeaNoteView }) {
  const label = "mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-fg-3";
  return (
    <div className="space-y-4">
      {note.summary && <p className="text-[13px] leading-relaxed text-fg-2">{note.summary}</p>}
      {note.entries.length > 0 && (
        <div>
          <div className={label}>{t("ideas.entries", { count: note.entries.length })}</div>
          <div className="space-y-2">{[...note.entries].reverse().map((e) => <EntryCard key={e.date} e={e} />)}</div>
        </div>
      )}
      {note.questions.length > 0 && (
        <div>
          <div className={label}>{t("ideas.questions", { count: note.questions.length })}</div>
          <ul className="space-y-1">
            {note.questions.map((q, i) => <li key={i} className="relative pl-3.5 text-[12.5px] text-fg-2"><span className="absolute left-0 font-bold text-warn">?</span>{q}</li>)}
          </ul>
        </div>
      )}
      {note.queues.length > 0 && (
        <div>
          <div className={label}>{t("ideas.queues")}</div>
          {note.queues.map((q) => (
            <button key={q.id} onClick={() => nav.closeThenItem("note", project, q.id)} className="flex w-full items-baseline gap-2 py-0.5 text-left text-[12.5px] hover:text-fg">
              <span className="font-mono text-[11.5px] text-accent">{q.id}</span>
              <span className="min-w-0 flex-1 truncate text-fg-2">{q.title}</span>
              <span className={`shrink-0 text-xs ${q.status === "done" ? "text-ok" : q.status === "cancelled" ? "text-fg-3" : "text-accent"}`}>{statusWord(q.status)}</span>
            </button>
          ))}
        </div>
      )}
      {note.ideas > 0 && <p className="text-xs text-fg-3">{t("ideas.ideasInFile", { count: note.ideas })}</p>}
    </div>
  );
}

function EntryCard({ e }: { e: IdeaEntryView }) {
  const others = e.headings.filter((h) => h !== e.date);
  return (
    <div className="rounded-lg border border-line bg-canvas px-3 py-2">
      <div className="flex items-baseline gap-2">
        <b className="text-[13px] font-semibold text-fg">{formatDayYear(e.date)}</b>
        <span className="text-xs text-fg-3">{e.headings.length > 1 ? `${t("ideas.headings", { count: e.headings.length })} · ` : ""}{t("ideas.decisions", { count: e.decisions })}</span>
        <span className="flex-1" />
        <IdeaStatus status={e.status} />
      </div>
      {e.lead && <p className="mt-0.5 text-[12.5px] text-fg-2">{e.lead}{others.length > 0 && <span className="text-fg-3"> · {others.join(" · ")}</span>}</p>}
      {e.dropped?.why && <p className="mt-0.5 text-xs text-fg-3">{e.dropped.why}</p>}
      <ol className="relative mt-1.5 before:absolute before:bottom-1.5 before:left-[3px] before:top-1.5 before:w-px before:bg-line-strong">
        {e.history.map((h, i) => <HistoryLine key={i} h={h} />)}
      </ol>
    </div>
  );
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

// ---------------------------------------------------------------- matching the earlier queues

type MatchFilter = "open" | "accepted" | "rejected";
const matchFilter = (m: MatchItem): MatchFilter => (!m.decision ? "open" : m.decision.accepted ? "accepted" : "rejected");
const KIND_TONE: Record<MatchItem["kind"], string> = { exact: "bg-ok/15 text-ok", dated: "bg-accent/15 text-accent", file: "bg-warn/15 text-warn" };

/** "To match · N": the suggestions for the earlier queues that wait for the user, atop the overview. */
function ToMatchBanner({ suggestions, queues }: { suggestions: number; queues: number }) {
  return (
    <div className="mb-3.5 flex items-center gap-2.5 rounded-xl border border-warn/40 bg-warn/5 px-3 py-2 text-[13px] text-fg">
      <span className="min-w-0 flex-1"><b className="font-semibold text-warn">{t("ideas.toMatch.title", { count: suggestions })}</b> {t("ideas.toMatch.text", { count: queues })}</span>
      <button onClick={() => nav.open("matching")} className="shrink-0 rounded-lg border border-line-strong bg-surface-2 px-3 py-1 text-xs font-semibold text-fg hover:bg-surface-3 max-lg:min-h-10">{t("ideas.toMatch.review")}</button>
    </div>
  );
}

/** The quote a suggestion came from, its references and dates marked. */
function Quote({ text }: { text: string }) {
  const parts = text.split(/(\S*\.md(?:#\d{4}-\d{2}-\d{2})?|\d{4}-\d{2}-\d{2})/);
  return (
    <p className="my-1.5 border-l-2 border-line-strong px-2.5 text-[12.5px] text-fg-2">
      {parts.map((p, i) => (i % 2 ? <mark key={i} className="rounded bg-accent/20 px-0.5 text-fg">{p}</mark> : p))}
    </p>
  );
}

/**
 * The suggestions for matching the earlier queues to the notes' entries (the layer "matching" over the overview):
 * queue by queue with the sentence each came from; the user accepts or rejects each, or the exact and dated ones at
 * once, and may take a decision back.
 */
export function IdeasMatching({ project, phone }: { project: string; phone?: boolean }) {
  const { version, reload } = usePage();
  const { data, error } = useQuery<IdeaMatchesResponse>(projectUrl(project, "/ideas/matches"), version);
  const { busy, error: failed, run } = useAction();
  const [filter, setFilter] = useState<MatchFilter>("open");
  const items = data?.items ?? [];
  const shown = items.filter((m) => matchFilter(m) === filter);
  const sure = items.filter((m) => !m.decision && m.kind !== "file");
  const decide = (list: MatchItem[], accept: boolean | null) =>
    void run(() => act(project, "POST", "/ideas/matches", { items: list.map(({ queue, ref }) => ({ queue, ref })), accept }), reload);
  const queues = [...new Set(shown.map((m) => m.queue))];
  return (
    <div className={`scroll-thin min-h-0 flex-1 overflow-y-auto ${phone ? "px-3 pb-6 pt-3" : "px-6 pb-8 pt-4"}`} data-ideas-matching>
      <div className="mb-1.5 flex flex-wrap items-center gap-2.5">
        <button onClick={() => nav.close("matching")} className="rounded-md px-1.5 py-1 text-xs text-fg-2 hover:bg-surface-3 hover:text-fg max-lg:min-h-10">‹ {t("ideas.match.back")}</button>
        <h2 className="text-[15px] font-semibold text-fg">{t("ideas.match.title")}</h2>
      </div>
      <p className="mb-3 text-[12.5px] text-fg-3">{t("ideas.match.note")}</p>
      <div className="mb-3 flex flex-wrap items-center gap-2.5">
        <div className="flex overflow-hidden rounded-lg border border-line-strong" role="group" aria-label={t("ideas.match.filterLabel")}>
          {(["open", "accepted", "rejected"] as const).map((f) => (
            <button key={f} onClick={() => setFilter(f)} aria-pressed={filter === f}
              className={filterButton(filter === f)}>
              {t(`ideas.match.filter.${f}`)}<span className="ml-1.5 font-normal text-fg-3">{items.filter((m) => matchFilter(m) === f).length}</span>
            </button>
          ))}
        </div>
        <span className="flex-1" />
        {filter === "open" && sure.length > 0 && <Button onClick={() => decide(sure, true)} disabled={busy}>{t("ideas.match.acceptAll", { count: sure.length })}</Button>}
      </div>
      {failed && <p className="mb-2 text-xs text-danger">{failed}</p>}
      {!data && error && <ReadError error={error} what={t("ideas.match.readError")} />}
      {data && queues.length === 0 && <p className="text-sm text-fg-3">{t("ideas.match.none")}</p>}
      {queues.map((id) => {
        const own = shown.filter((m) => m.queue === id);
        const q = own[0]!;
        return (
          <div key={id} className="mb-2.5 rounded-xl border border-line bg-surface px-3.5 py-2.5">
            <div className="flex items-baseline gap-2.5">
              <span className="font-mono text-xs text-fg-3">{id}</span>
              <b className="min-w-0 flex-1 truncate text-[13.5px] font-semibold text-fg">{q.title}</b>
              <span className="shrink-0 whitespace-nowrap text-xs text-fg-3">{statusWord(q.status)}{q.finished_at ? ` ${day(q.finished_at.slice(0, 10))}` : ""}{q.commit ? ` · ${q.commit.slice(0, 7)}` : ""}</span>
            </div>
            {q.quote && <Quote text={q.quote} />}
            {own.map((m) => (
              <div key={m.ref} className={`grid items-center gap-2.5 border-t border-line py-1.5 text-[12.5px] ${phone ? "grid-cols-[minmax(0,1fr)_auto]" : "grid-cols-[minmax(0,1fr)_6.5rem_auto]"}`}>
                <span className="truncate font-mono text-xs text-fg">{m.ref.replace(/^.*\//, "")}{m.lead && <span className="ml-1.5 font-sans text-fg-3">{m.lead}</span>}</span>
                {!phone && <span className={`rounded px-1.5 text-center text-[11px] font-semibold ${KIND_TONE[m.kind]}`}>{t(`ideas.match.kind.${m.kind}`)}</span>}
                {m.decision ? (
                  <span className={`whitespace-nowrap text-xs ${m.decision.accepted ? "text-ok" : "text-fg-3"}`}>
                    {t(m.decision.accepted ? "ideas.match.accepted" : "ideas.match.rejected")} · <button onClick={() => decide([m], null)} disabled={busy} className="underline hover:text-fg">{t("ideas.match.undo")}</button>
                  </span>
                ) : (
                  <span className="flex gap-1.5">
                    <Button variant="quiet" onClick={() => decide([m], true)} disabled={busy}>{t("ideas.match.accept")}</Button>
                    <button onClick={() => decide([m], false)} disabled={busy} className="rounded-md px-2.5 py-1.5 text-sm text-fg-2 hover:bg-surface-3 hover:text-fg max-lg:min-h-11">{t("ideas.match.reject")}</button>
                  </span>
                )}
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}
