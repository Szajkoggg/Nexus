// Origin-specific relationship overlays. Legacy decisions and queue sources are immutable inputs.
import { createHash } from "node:crypto";
import { noteRef, noteRefIssue, noteRefs, suggestMatches, type IdeaNote, type MatchSuggestion } from "./ideas.ts";
import type { IdeaLinkAction, IdeaLinkRecord, IdeaMatchesFile } from "./schemas.ts";
import type { ProjectState } from "./state.ts";

export interface IdeaLinkView extends IdeaLinkRecord {
  effective: boolean;
  diagnostics: string[];
  /** Live suggestion evidence is separate from a stored decision or last-known snapshot. */
  current_suggestion?: MatchSuggestion | null;
  recorded_evidence?: IdeaLinkRecord;
  evidence_status?: "current" | "historical";
}
export interface IdeaLinksResponse {
  revision: string;
  items: IdeaLinkView[];
  history: IdeaLinkAction[];
}

export const ideaOriginId = (origin: "source" | "match", queue: string, ref: string): string => JSON.stringify([origin, queue, ref]);
export const ideaHash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Derive every origin, including tombstones and references whose queue or target disappeared. */
export function deriveIdeaLinks(file: IdeaMatchesFile, state: ProjectState, notes: IdeaNote[]): IdeaLinksResponse {
  const queues = new Map(state.queues.map((q) => [q.id, q]));
  const targets = new Map(notes.flatMap((n) => n.entries.map((e) => [noteRef(n.file, e.date), { note_title: n.title, lead: e.lead }] as const)));
  const records = new Map<string, IdeaLinkRecord>();
  const add = (r: IdeaLinkRecord) => records.set(r.id, r);
  for (const q of state.queues) for (const ref of noteRefs(q.source)) add({
    id: ideaOriginId("source", q.id, ref), queue: q.id, ref, origin: "source", state: "linked",
    title: q.title, ...targets.get(ref), quote: ref, location: "source",
  });
  const suggestions = suggestMatches(state.queues, notes, state.project.conversations.notes_dir);
  const current = new Map(suggestions.map((m) => [ideaOriginId("match", m.queue, m.ref), m]));
  for (const m of suggestions) add({
    ...m, id: ideaOriginId("match", m.queue, m.ref), origin: "match", state: "pending",
    title: queues.get(m.queue)!.title, ...targets.get(m.ref),
  });
  const recorded = new Map<string, IdeaLinkRecord>();
  const remember = (r: IdeaLinkRecord) => { add(r); if (r.origin === "match") recorded.set(r.id, r); };
  for (const m of file.matches) remember({
    id: ideaOriginId("match", m.queue, m.ref), queue: m.queue, ref: m.ref, origin: "match",
    state: m.accepted ? "linked" : "rejected", title: queues.get(m.queue)?.title ?? m.queue,
    ...targets.get(m.ref), kind: m.kind, quote: m.quote ?? "", at: m.at,
  });
  for (const r of file.records ?? []) remember(r);
  const items = [...records.values()].map((r): IdeaLinkView => {
    const suggestion = current.get(r.id);
    const saved = recorded.get(r.id);
    // Pending snapshots are historical observations, never an override of today's suggestion.
    if (r.origin === "match" && r.state === "pending" && suggestion) r = {
      ...r, ...suggestion, title: queues.get(r.queue)!.title, ...targets.get(r.ref),
    };
    const q = queues.get(r.queue);
    const diagnostics: string[] = [];
    if (!q) diagnostics.push(`Queue ${r.queue} is missing`);
    if (r.origin === "source" && q && !noteRefs(q.source).includes(r.ref)) diagnostics.push("Queue source is missing");
    const issue = noteRefIssue(r.ref, state.project.conversations.notes_dir, notes);
    if (issue) diagnostics.push(issue);
    if (r.origin === "match" && !suggestion) diagnostics.push("The historical suggestion is no longer present in the queue's current references");
    // A missing target stays an effective but broken edge; a vanished source is no longer an input.
    return { ...r, effective: r.state === "linked" && !(r.origin === "source" && q && !noteRefs(q.source).includes(r.ref)), diagnostics,
      ...(r.origin === "match" ? { current_suggestion: suggestion ?? null, ...(saved ? { recorded_evidence: saved } : {}),
        evidence_status: r.state === "pending" && suggestion ? "current" as const : "historical" as const } : {}),
    };
  });
  return {
    // Include current inputs as well as stored corrections: stale suggestions and deleted targets cannot be accepted.
    revision: ideaHash({ file, items, suggestions, notes, queues: state.queues.map((q) => [q.id, q.title, q.source]) }),
    items, history: file.history ?? [],
  };
}
