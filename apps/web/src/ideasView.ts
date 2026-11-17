// The ideas overview's list (components/Ideas.tsx; docs/ux/ideas-overview.md): which entries a status filter and a
// text filter keep, how many entries each filter has, and the notes grouped by area and sub-group in the project's
// order. Pure and unit tested; the derivation itself is the server's (@nexus/protocol ideas.ts).
import type { IdeaEntryView, IdeaNoteView } from "@nexus/protocol/ideas";

/** A status filter of the list: all, one status of an entry (dropped with replaced), or the topics with no entry yet. */
export const IDEA_FILTERS = ["all", "worked_out", "unconfirmed", "partial", "full", "decided", "handed_over", "queued", "built", "dropped", "attention"] as const;
export type IdeaFilter = (typeof IDEA_FILTERS)[number];

const needsAttention = (e: IdeaEntryView) => !!e.effective && !!(e.effective.diagnostics.length || e.effective.blockers.length || e.effective.caveats.length || e.effective.stale_reasons.length);
export const dispositionOf = (e: IdeaEntryView) => e.effective?.disposition ?? (e.status === "dropped" || e.status === "replaced" ? e.status : "active");
export const implementationOf = (e: IdeaEntryView) => e.effective?.implementation ?? "unconfirmed";
export const workOf = (e: IdeaEntryView) => e.effective?.work.state ?? (e.status === "built" ? "finished" : e.queues.length ? "linked" : "none");
const inFilter = (e: IdeaEntryView, f: IdeaFilter) => {
  if (f === "all") return true;
  if (f === "attention") return needsAttention(e);
  if (f === "dropped") return dispositionOf(e) !== "active";
  if (dispositionOf(e) !== "active") return false;
  if (f === "full" || f === "partial") return implementationOf(e) === f;
  if (f === "unconfirmed") return !["full", "partial"].includes(implementationOf(e));
  if (f === "built") return workOf(e) === "finished";
  if (f === "queued") return ["linked", "some_finished"].includes(workOf(e));
  if (f === "handed_over" || f === "decided") return workOf(e) === "none" && e.history.some((h) => h.kind === "handed_over") === (f === "handed_over");
  return false;
};

/** How many each filter shows: entries for a status, topics for `worked_out`, entries and empty topics for `all`. */
export function filterCounts(notes: readonly IdeaNoteView[]): Record<IdeaFilter, number> {
  const out = Object.fromEntries(IDEA_FILTERS.map((f) => [f, 0])) as Record<IdeaFilter, number>;
  for (const n of notes) {
    if (!n.entries.length) { out.worked_out++; out.all++; continue; }
    for (const e of n.entries) {
      out.all++;
      for (const f of IDEA_FILTERS) if (f !== "all" && f !== "worked_out" && inFilter(e, f)) out[f]++;
    }
  }
  return out;
}

/** A note as the list shows it: the note, and the entries the filters keep. */
export interface ShownNote { note: IdeaNoteView; entries: IdeaEntryView[] }

/**
 * The notes a filter keeps, each with its entries that pass: a status filter keeps the entries with that status (and
 * their notes), `worked_out` the topics with no entry; the text (any case) matches a note's title, file, Summary or
 * area, or an entry's lead or headings (then only those entries stay, unless the note itself matched).
 */
export function shownNotes(notes: readonly IdeaNoteView[], filter: IdeaFilter, text = ""): ShownNote[] {
  const q = text.trim().toLowerCase();
  const has = (s: string | undefined) => !!s && s.toLowerCase().includes(q);
  const out: ShownNote[] = [];
  for (const note of notes) {
    if (filter === "worked_out") {
      if (!note.entries.length && (!q || has(note.title) || has(note.file) || has(note.summary))) out.push({ note, entries: [] });
      continue;
    }
    let entries = note.entries.filter((e) => inFilter(e, filter));
    if (filter !== "all" && !entries.length) continue;
    if (q) {
      const self = has(note.title) || has(note.file) || has(note.summary) || has(note.area) || has(note.group);
      if (!self) {
        entries = entries.filter((e) => has(e.lead) || e.headings.some(has));
        if (!entries.length) continue;
      }
    }
    out.push({ note, entries });
  }
  return out;
}

/** An area of the list: its name (null: Unsorted), its notes with no sub-group, then its sub-groups. */
export interface AreaGroup { area: string | null; count: number; groups: { group: string | null; notes: ShownNote[] }[] }

/**
 * The notes by area, then sub-group, each in title order: the areas in the project's order (its tag list), the
 * others after them by name, Unsorted (no area) last; in an area, the notes with no sub-group first, then the
 * sub-groups by name.
 */
export function groupByArea(notes: readonly ShownNote[], order: readonly string[]): AreaGroup[] {
  const byArea = new Map<string | null, ShownNote[]>();
  for (const n of notes) {
    const a = n.note.area ?? null;
    byArea.set(a, [...(byArea.get(a) ?? []), n]);
  }
  // The project's areas by their place in its list, then the others by name, then Unsorted.
  const place = (a: string | null) => (a === null ? Infinity : order.includes(a) ? order.indexOf(a) : order.length);
  const areas = [...byArea.keys()].sort((x, y) => place(x) - place(y) || (x ?? "").localeCompare(y ?? ""));
  const byTitle = (x: ShownNote, y: ShownNote) => x.note.title.localeCompare(y.note.title);
  return areas.map((area) => {
    const own = byArea.get(area)!;
    const groups = new Map<string | null, ShownNote[]>();
    for (const n of own) { const g = n.note.group ?? null; groups.set(g, [...(groups.get(g) ?? []), n]); }
    const names = [...groups.keys()].sort((x, y) => (x === null ? -1 : y === null ? 1 : x.localeCompare(y)));
    return { area, count: own.length, groups: names.map((group) => ({ group, notes: groups.get(group)!.sort(byTitle) })) };
  });
}
