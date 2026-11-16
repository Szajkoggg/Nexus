// The ideas overview (docs/ux/ideas-overview.md): a thinking partner's notes read into topics and dated Decided
// entries, and each entry's status derived from what followed it (the hand-over records, the queues that name it in
// their `source`, their finish). Pure: the notes come in as text, the queues and hand-overs as plain records; the
// files are read in ideas-read.ts. Nothing here is kept by hand: every status is derived again whenever a file changes.

import type { ImportSource, QueueSource, QueueStatus } from "./schemas.ts";
import type { QueueView } from "./state.ts";

// ---------------------------------------------------------------- references

/**
 * A note reference: a thinking partner's note (a path from the project's root, ending .md) and a Decided entry's date.
 * schemas.ts checks a queue's source with it; it is kept here so that the dashboard needs no schemas (and no zod).
 */
export const NOTE_REF = /^(?!\/)(?![A-Za-z]:)[^#\s\\]*?([^/#\s\\]+\.md)#(\d{4}-\d{2}-\d{2})$/;

/** A note reference taken apart: the note's path from the project's root (forward slashes) and the entry's date. */
export interface IdeaRef { file: string; date: string }

/** Takes a note reference apart (`docs/ideas/tags.md#2026-11-14`); undefined when it is not one. */
export function parseNoteRef(ref: string): IdeaRef | undefined {
  if (!NOTE_REF.test(ref)) return undefined;
  const at = ref.lastIndexOf("#");
  return { file: ref.slice(0, at), date: ref.slice(at + 1) };
}

/** The reference of a note's entry. */
export const noteRef = (file: string, date: string): string => `${file}#${date}`;

/** The note references of a queue's source, in its order (the import record left out). */
export const noteRefs = (source: readonly QueueSource[] | undefined): string[] =>
  (source ?? []).filter((x): x is string => typeof x === "string");

/** The file a queue was imported from (`nexus import`), when it was. */
export const importedFrom = (source: readonly QueueSource[] | undefined): ImportSource | undefined =>
  (source ?? []).find((x): x is ImportSource => typeof x === "object");

/**
 * What is wrong with a note reference a draft gives, against the project's notes (read as they are now): it must name
 * a note in the notes folder, and an entry of that date in it. Undefined when it is right.
 */
export function noteRefIssue(ref: string, notesDir: string | undefined, notes: readonly IdeaNote[]): string | undefined {
  const r = parseNoteRef(ref);
  if (!r) return `${ref} is not a note reference: <notes folder>/<file>.md#<YYYY-MM-DD>`;
  if (!notesDir) return `${ref}: the project has no notes folder (conversations.notes_dir), so no note can be named`;
  if (!r.file.startsWith(`${notesDir}/`)) return `${ref}: a note is a file in the notes folder ${notesDir}/`;
  const note = notes.find((n) => n.file === r.file);
  if (!note) return `${ref}: there is no note ${r.file}`;
  if (!note.entries.some((e) => e.date === r.date)) {
    const dates = note.entries.map((e) => e.date);
    return `${ref}: ${r.file} has no Decided entry of ${r.date} (${dates.length ? `its dates: ${dates.join(", ")}` : "it has no dated Decided entry"})`;
  }
  return undefined;
}

// ---------------------------------------------------------------- reading a note

/**
 * A dated Decided entry: everything under one date in a note's Decided section(s); headings of the same date are one
 * entry (`2026-11-14` and `2026-11-14 (later): …`), so `file#date` always names one. `lead`: the bold lead of its
 * first bullet (else the bullet's first words); `decisions`: its top-level bullets. `dropped` and `replaced_by` come
 * from the lines `**Dropped:** <date>: <why>` and `**Replaced by:** <file>#<date>` the partner writes under it.
 */
interface IdeaEntry {
  date: string;
  headings: string[];
  lead: string;
  decisions: number;
  dropped?: { date: string; why: string };
  replaced_by?: string;
}

/**
 * A thinking partner's note (one topic). `file`: its path from the project's root; `area` and `group` from its
 * `**Area:** <area> [/ <group>]` line; `open`: its Open questions (top-level bullets under an Open heading), and
 * `questions` their text (Markdown marks taken out); `ideas`:
 * the bullets under its "Ideas" headings.
 */
export interface IdeaNote {
  file: string;
  title: string;
  summary?: string;
  area?: string;
  group?: string;
  entries: IdeaEntry[];
  open: number;
  questions: string[];
  ideas: number;
}

const DATE = /\d{4}-\d{2}-\d{2}/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const BULLET = /^[-*+]\s+(.*)$/;

/** The date a heading under Decided gives its entry: one it begins with, or `(decided <date>)` at its end. */
function headingDate(text: string): string | undefined {
  const start = /^(\d{4}-\d{2}-\d{2})\b/.exec(text);
  if (start) return start[1];
  const decided = /\(decided (\d{4}-\d{2}-\d{2})\)\s*$/i.exec(text);
  return decided?.[1];
}

/** The text of a bullet as a lead: its bold opening, else its first words; Markdown marks taken out. */
function leadOf(bullet: string): string {
  const bold = /^\*\*(.+?)\*\*/.exec(bullet);
  const text = (bold ? bold[1]! : bullet).replace(/\*\*|`/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[.:;,]\s*$/, "").trim();
  return text.length > 120 ? `${text.slice(0, 119).trimEnd()}…` : text;
}

/** A line's text without its Markdown marks (bold, code, links). */
const plain = (text: string) => text.replace(/\*\*|`/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").trim();

/** A field line under the title (`**Summary:** …`, `**Area:** …`) with its continuation lines, as one line. */
function fieldOf(lines: string[], name: string): string | undefined {
  const i = lines.findIndex((l) => l.startsWith(`**${name}:**`));
  if (i < 0) return undefined;
  const out = [lines[i]!.slice(name.length + 5).trim()];
  for (let j = i + 1; j < lines.length; j++) {
    const l = lines[j]!;
    if (!l.trim() || l.startsWith("#") || l.startsWith("**")) break;
    out.push(l.trim());
  }
  return out.join(" ").trim() || undefined;
}

/**
 * Reads a note (Markdown) as the overview needs it. Lenient: a Decided section is any heading named "Decided" (at any
 * level; it ends at the next heading of its level or above); under it, a heading that begins with a date, or ends
 * with `(decided <date>)`, starts that date's entry, and a deeper heading without a date goes on with it. A heading
 * `… (decided <date>)` outside a Decided section is an entry too.
 */
export function parseNote(file: string, text: string): IdeaNote {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const title = lines.map((l) => /^#\s+(.*)$/.exec(l)?.[1]?.trim()).find((x) => x) ?? file.split("/").pop()!.replace(/\.md$/, "");
  const firstSection = lines.findIndex((l) => /^##\s/.test(l));
  const head = firstSection < 0 ? lines : lines.slice(0, firstSection);
  const summary = fieldOf(head, "Summary");
  const areaLine = fieldOf(head, "Area");
  const [area, group] = (areaLine ?? "").split("/").map((x) => x.trim().toLowerCase());

  const entries = new Map<string, IdeaEntry>();
  let decided: number | undefined;                 // the level of the Decided heading we are under
  let entry: { e: IdeaEntry; level: number } | undefined;
  let other: { kind: "open" | "ideas"; level: number } | undefined;
  const questions: string[] = [];
  let ideas = 0;
  let inFence = false;
  for (const raw of lines) {
    if (/^\s*(```|~~~)/.test(raw)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const h = HEADING.exec(raw);
    if (h) {
      const level = h[1]!.length, text = h[2]!;
      if (decided !== undefined && level <= decided) decided = undefined;
      if (entry && level <= entry.level) entry = undefined;
      if (other && level <= other.level) other = undefined;
      if (/^decided\b/i.test(text)) { decided = level; continue; }
      if (/^open\b/i.test(text)) { other = { kind: "open", level }; continue; }
      if (/^ideas\b/i.test(text)) { other = { kind: "ideas", level }; continue; }
      const date = headingDate(text);
      const dated = date && (decided !== undefined || /\(decided \d{4}-\d{2}-\d{2}\)\s*$/i.test(text));
      if (dated) {
        let e = entries.get(date);
        if (!e) { e = { date, headings: [], lead: "", decisions: 0 }; entries.set(date, e); }
        e.headings.push(text);
        entry = { e, level };
      }
      continue;
    }
    if (entry) {
      const e = entry.e;
      const dropped = /^\*\*Dropped:\*\*\s*(\d{4}-\d{2}-\d{2})\s*[:,-]?\s*(.*)$/.exec(raw);
      if (dropped) { e.dropped = { date: dropped[1]!, why: dropped[2]!.trim() }; continue; }
      const replaced = /^\*\*Replaced by:\*\*\s*(\S+)/.exec(raw);
      if (replaced) { e.replaced_by = replaced[1]!.replace(/^\[([^\]]*)\]\(([^)]*)\)$/, "$2"); continue; }
      const b = BULLET.exec(raw);
      if (b) { e.decisions++; if (!e.lead) e.lead = leadOf(b[1]!); }
      continue;
    }
    const b = other && BULLET.exec(raw);
    if (b) { if (other!.kind === "open") questions.push(plain(b[1]!)); else ideas++; }
  }
  const sorted = [...entries.values()].sort((a, b) => a.date.localeCompare(b.date));
  return { file, title, summary, area: area || undefined, group: group || undefined, entries: sorted, open: questions.length, questions, ideas };
}

// ---------------------------------------------------------------- statuses

/** An entry's status, the least advanced first; dropped and replaced stand apart (and win over the others). */
const ENTRY_STATUSES = ["decided", "handed_over", "queued", "built", "dropped", "replaced"] as const;
export type EntryStatus = (typeof ENTRY_STATUSES)[number];
/** A topic's status: its least advanced entry's (dropped and replaced left out); `worked_out` with no entry at all. */
export type TopicStatus = "worked_out" | EntryStatus;
const PROGRESS: readonly EntryStatus[] = ["decided", "handed_over", "queued", "built"];

/**
 * A queue as the derivation needs it: its own status and times, the note references it came from (its `source`, and
 * the matches the user accepted for it), and the areas of its steps (the fallback of a note without an Area line).
 * `finished_at` and `commit`: when it was done, and its last commit.
 */
export interface IdeaQueue {
  id: string;
  title: string;
  status: QueueStatus;
  refs: string[];
  areas?: string[];
  created_at?: string;
  approved_at?: string;
  started_at?: string;
  finished_at?: string;
  commit?: string;
}

/** A hand-over's record of an entry it covered (`nexus covers`): when, and from which conversation. */
export interface HandOver { ref: string; at: string; session?: string; conversation?: string }

/** One line of an entry's history; `at` is a time, or a date for what only the note dates (decided, dropped). */
export interface HistoryItem {
  kind: "decided" | "handed_over" | "queued" | "approved" | "started" | "finished" | "cancelled" | "dropped" | "replaced";
  at: string;
  queue?: string;
  session?: string;
  conversation?: string;
  commit?: string;
  text?: string;
}

/** A queue as an entry or a note lists it. */
interface IdeaQueueRef { id: string; title: string; status: QueueStatus; commit?: string }

export interface IdeaEntryView extends IdeaEntry {
  ref: string;
  status: EntryStatus;
  queues: IdeaQueueRef[];
  history: HistoryItem[];
}

export interface IdeaNoteView extends Omit<IdeaNote, "entries"> {
  status: TopicStatus;
  /** Where its area comes from: its Area line, or the areas its queues' steps carry most. */
  area_from?: "note" | "queues";
  entries: IdeaEntryView[];
  queues: IdeaQueueRef[];
}

/** The overview: the notes, and what names nothing (a queue's reference to a note or an entry that is not there). */
export interface IdeasView { notes: IdeaNoteView[]; unknown_refs: { queue: string; ref: string }[] }

/** The ideas overview of a project as the dashboard gets it (GET /api/projects/:id/ideas; ideas-read.ts, projectIdeas). */
export interface IdeasResponse extends IdeasView {
  /** The project's notes folder (relative to its root), or null when it has none: then there are no notes. */
  notes_dir: string | null;
  /** The suggestions for matching earlier queues that wait for the user's decision, and how many queues they are of. */
  to_match: { suggestions: number; queues: number };
}

const queueRef = (q: IdeaQueue): IdeaQueueRef => ({ id: q.id, title: q.title, status: q.status, ...(q.commit ? { commit: q.commit } : {}) });

/** The history a queue gives an entry that it names. */
function queueHistory(q: IdeaQueue): HistoryItem[] {
  const out: HistoryItem[] = [];
  if (q.created_at) out.push({ kind: "queued", at: q.created_at, queue: q.id });
  if (q.approved_at) out.push({ kind: "approved", at: q.approved_at, queue: q.id });
  if (q.started_at) out.push({ kind: "started", at: q.started_at, queue: q.id });
  if (q.status === "done" && q.finished_at) out.push({ kind: "finished", at: q.finished_at, queue: q.id, ...(q.commit ? { commit: q.commit } : {}) });
  if (q.status === "cancelled") out.push({ kind: "cancelled", at: q.finished_at ?? q.started_at ?? q.approved_at ?? q.created_at ?? "", queue: q.id });
  return out.filter((h) => h.at);
}

/** The status of one entry, from its note's lines, the queues that name it and the hand-overs that covered it. */
function entryStatus(e: IdeaEntry, queues: readonly IdeaQueue[], handedOver: boolean): EntryStatus {
  if (e.replaced_by) return "replaced";
  if (e.dropped) return "dropped";
  const live = queues.filter((q) => q.status !== "cancelled");
  if (live.length) return live.every((q) => q.status === "done") ? "built" : "queued";
  return handedOver ? "handed_over" : "decided";
}

/** A topic's status: the least advanced of its live entries; with only dropped or replaced ones, dropped first. */
export function topicStatus(statuses: readonly EntryStatus[]): TopicStatus {
  if (!statuses.length) return "worked_out";
  const live = statuses.filter((s) => PROGRESS.includes(s));
  if (!live.length) return statuses.includes("dropped") ? "dropped" : "replaced";
  return PROGRESS.find((s) => live.includes(s))!;
}

/** The area most of a note's queues' steps carry (the first such area on a tie), when they carry any. */
function queuesArea(queues: readonly IdeaQueue[]): string | undefined {
  const count = new Map<string, number>();
  for (const a of queues.flatMap((q) => q.areas ?? [])) count.set(a, (count.get(a) ?? 0) + 1);
  let best: string | undefined, n = 0;
  for (const [a, c] of count) if (c > n) { best = a; n = c; }
  return best;
}

/**
 * The overview: every note with its entries' statuses and histories (oldest first), the topic's status, and the
 * queues that name it. A reference to a note or an entry that is not there is listed in `unknown_refs`.
 */
export function deriveIdeas(input: { notes: readonly IdeaNote[]; queues: readonly IdeaQueue[]; handovers: readonly HandOver[] }): IdeasView {
  const byRef = new Map<string, IdeaQueue[]>();
  for (const q of input.queues) for (const r of new Set(q.refs)) byRef.set(r, [...(byRef.get(r) ?? []), q]);
  const known = new Set<string>();
  const notes = input.notes.map((n): IdeaNoteView => {
    const entries = n.entries.map((e): IdeaEntryView => {
      const ref = noteRef(n.file, e.date);
      known.add(ref);
      const queues = byRef.get(ref) ?? [];
      const handovers = input.handovers.filter((h) => h.ref === ref);
      const history: HistoryItem[] = [
        { kind: "decided", at: e.date },
        ...handovers.map((h): HistoryItem => ({ kind: "handed_over", at: h.at, ...(h.session ? { session: h.session } : {}), ...(h.conversation ? { conversation: h.conversation } : {}) })),
        ...queues.flatMap(queueHistory),
        ...(e.dropped ? [{ kind: "dropped" as const, at: e.dropped.date, text: e.dropped.why }] : []),
        ...(e.replaced_by ? [{ kind: "replaced" as const, at: e.date, text: e.replaced_by }] : []),
      ];
      // Oldest first; a date alone (the note's) comes before the times of that day. A stable sort keeps the order above
      // for equal times.
      history.sort((a, b) => a.at.localeCompare(b.at));
      return { ...e, ref, status: entryStatus(e, queues, handovers.length > 0), queues: queues.map(queueRef), history };
    });
    const noteQueues = [...new Map(entries.flatMap((e) => byRef.get(e.ref) ?? []).map((q) => [q.id, q])).values()];
    const fallback = n.area ? undefined : queuesArea(noteQueues);
    return {
      ...n,
      ...(n.area ? { area_from: "note" as const } : fallback ? { area: fallback, area_from: "queues" as const } : {}),
      status: topicStatus(entries.map((e) => e.status)),
      entries,
      queues: noteQueues.map(queueRef),
    };
  });
  const unknown_refs = input.queues.flatMap((q) => [...new Set(q.refs)].filter((r) => !known.has(r)).map((ref) => ({ queue: q.id, ref })));
  return { notes, unknown_refs };
}

/**
 * The queues as the derivation reads them (IdeaQueue), from the project's derived state: each one's note references
 * (its source, and `matched`: the references the user accepted for it, by queue id), its steps' areas, its times
 * (created; the latest approval; the run's start, else its first step's; when done, the run's end, else its last
 * step's finish) and its last commit.
 */
export function ideaQueues(views: readonly QueueView[], matched: Readonly<Record<string, readonly string[]>> = {}): IdeaQueue[] {
  return views.map((v) => {
    const refs = [...new Set([...noteRefs(v.source), ...(matched[v.id] ?? [])])];
    const areas = v.steps.flatMap((s) => (s.tags.area ? [s.tags.area] : []));
    const latest = (xs: (string | undefined)[]) => xs.filter((x): x is string => !!x).sort().pop();
    const started = v.run?.started_at ?? v.steps.map((s) => s.started_at).filter((x): x is string => !!x).sort()[0];
    const finished = v.status === "done" ? (v.run?.ended_at ?? latest(v.steps.map((s) => s.finished_at))) : undefined;
    const commit = [...v.steps].reverse().find((s) => s.commit)?.commit;
    return {
      id: v.id, title: v.title, status: v.status, refs,
      ...(areas.length ? { areas } : {}),
      ...(v.created_at ? { created_at: v.created_at } : {}),
      ...(v.approvals.length ? { approved_at: latest(v.approvals.map((a) => a.at)) } : {}),
      ...(started ? { started_at: started } : {}),
      ...(finished ? { finished_at: finished } : {}),
      ...(commit ? { commit } : {}),
    };
  });
}

// ---------------------------------------------------------------- matching earlier queues to the notes

/**
 * How a suggestion was found: an `exact` reference (`<file>.md#<date>`), a note named with one of its entries' dates
 * in the same sentence (`dated`), or a note named alone (`file`: its latest entry dated on or before the queue).
 */
type MatchKind = "exact" | "dated" | "file";
const MATCH_RANK: Record<MatchKind, number> = { exact: 0, dated: 1, file: 2 };

/** A suggested match of a queue that names no note to a note's entry, with the sentence it came from. */
export interface MatchSuggestion { queue: string; ref: string; kind: MatchKind; quote: string }

/** What suggestMatches reads of a queue: its words, when it was created, its source and status. */
export interface MatchQueue {
  id: string;
  title: string;
  description?: string;
  steps: readonly { title: string; goal?: string }[];
  created_at?: string;
  source?: readonly QueueSource[];
  status: QueueStatus;
}

/** A queue's words as sentences: paragraphs and list items apart, lines joined, split after . ! or ?. */
function sentences(text: string): string[] {
  return text.replace(/\r\n?/g, "\n").split(/\n\s*\n|\n(?=\s*(?:[-*+]|\d+\.)\s)/)
    .flatMap((p) => p.replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s+(?=\S)/))
    .map((s) => s.trim()).filter(Boolean);
}

/**
 * The suggestions for matching the queues that name no note in their source (the earlier ones; cancelled ones left
 * out) to the notes' entries, from the references in their title, description and step goals: a mention of
 * `<notes folder>/<file>.md` (the README and files that are not notes skipped) with `#<date>` of one of its entries
 * (exact), else with dates of its entries in the same sentence (dated, one each), else the note's latest entry dated
 * on or before the queue's creation (file). One per queue and entry, the strongest kind, with its first sentence.
 */
export function suggestMatches(queues: readonly MatchQueue[], notes: readonly IdeaNote[], notesDir: string | undefined): MatchSuggestion[] {
  if (!notesDir) return [];
  const byFile = new Map(notes.map((n) => [n.file, n]));
  const dir = notesDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const out: MatchSuggestion[] = [];
  for (const q of queues) {
    if (q.status === "cancelled" || noteRefs(q.source).length) continue;
    const found = new Map<string, MatchSuggestion>();
    const add = (ref: string, kind: MatchKind, quote: string) => {
      const had = found.get(ref);
      if (!had || MATCH_RANK[kind] < MATCH_RANK[had.kind]) found.set(ref, { queue: q.id, ref, kind, quote: had && MATCH_RANK[had.kind] === MATCH_RANK[kind] ? had.quote : clip(quote) });
    };
    const created = q.created_at?.slice(0, 10);
    const text = [q.title, q.description ?? "", ...q.steps.flatMap((s) => [s.title, s.goal ?? ""])].join("\n\n");
    for (const sentence of sentences(text)) {
      const dates = [...sentence.matchAll(/\d{4}-\d{2}-\d{2}/g)].map((m) => m[0]);
      for (const m of sentence.matchAll(new RegExp(`${dir}/([^\\s#()\\[\\]\`'",;]+?\\.md)(?:#(\\d{4}-\\d{2}-\\d{2}))?`, "g"))) {
        const note = byFile.get(`${notesDir}/${m[1]}`);
        if (!note || !note.entries.length) continue;
        const has = (d: string) => note.entries.some((e) => e.date === d);
        if (m[2] && has(m[2])) { add(noteRef(note.file, m[2]), "exact", sentence); continue; }
        const dated = [...new Set(dates)].filter(has);
        for (const d of dated) add(noteRef(note.file, d), "dated", sentence);
        if (dated.length) continue;
        const before = note.entries.filter((e) => !created || e.date <= created).at(-1);
        if (before) add(noteRef(note.file, before.date), "file", sentence);
      }
    }
    out.push(...found.values());
  }
  return out;
}

const clip = (s: string) => (s.length > 320 ? `${s.slice(0, 319).trimEnd()}…` : s);

/** The entries the user accepted for each queue (by queue id), from the decisions in idea-matches.yaml. */
export function acceptedMatches(matches: readonly { queue: string; ref: string; accepted: boolean }[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const m of matches) if (m.accepted) (out[m.queue] ??= []).push(m.ref);
  return out;
}

/** A suggestion as the dashboard shows it: its queue as it stands, the entry's lead, and the user's decision. */
export interface MatchItem extends MatchSuggestion {
  title: string;
  status: QueueStatus;
  finished_at?: string;
  commit?: string;
  lead?: string;
  decision?: { accepted: boolean; at: string };
}
/** GET /api/projects/:id/ideas/matches: the suggestions and decisions, queue by queue in the queues' order. */
export interface IdeaMatchesResponse { items: MatchItem[] }
