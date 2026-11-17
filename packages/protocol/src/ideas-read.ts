// Reading what the ideas overview (ideas.ts) is derived from: a project's notes folder (every Markdown note in it and
// its subfolders, the README, the folder's conventions, left out; only read: the notes are the thinking partner's), the
// hand-over records in the partners' own events, and its queues.

import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { deriveIdeas, ideaQueues, noteRef, parseNote, type HandOver, type IdeaMatchesResponse, type IdeaNote, type IdeasResponse, type MatchItem } from "./ideas.ts";
import { deriveIdeaLinks } from "./idea-links.ts";
import { ideaOutcome } from "./idea-outcomes.ts";
import type { ProjectStore } from "./store.ts";
import type { ProjectState } from "./state.ts";

/** The notes of a project: `notesDir` is relative to its root (conversations.notes_dir); none without a folder. */
export function readNotes(root: string, notesDir: string | undefined): IdeaNote[] {
  if (!notesDir) return [];
  const base = join(root, notesDir);
  const inside = (parent: string, child: string) => { const r = relative(parent, child); return r !== ".." && !r.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(r); };
  if (isAbsolute(notesDir) || notesDir.replaceAll("\\", "/").split("/").includes("..") || !inside(resolve(root), resolve(base))) throw new Error("Notes folder escapes the project");
  if (!existsSync(base)) return [];
  if (!inside(realpathSync(root), realpathSync(base))) throw new Error("Notes folder resolves outside the project");
  const out: IdeaNote[] = [];
  const walk = (dir: string, rel: string) => {
    for (const d of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = rel ? `${rel}/${d.name}` : d.name;
      if (d.isSymbolicLink()) continue;
      if (!inside(realpathSync(base), realpathSync(join(dir, d.name)))) throw new Error("Note resolves outside the notes folder");
      if (d.isDirectory()) { if (!d.name.startsWith(".")) walk(join(dir, d.name), path); continue; }
      if (!d.isFile() || !d.name.toLowerCase().endsWith(".md") || d.name.toLowerCase() === "readme.md") continue;
      out.push(parseNote(`${notesDir}/${path}`, readFileSync(join(dir, d.name), "utf8")));
    }
  };
  walk(base, "");
  return out;
}

/**
 * The hand-over records (`nexus covers`, the `ideas.covered` events) of the project's thinking partners, oldest first:
 * one per entry covered, with the conversation's title. Only a conversation's own events count.
 */
export function readHandOvers(store: ProjectStore): HandOver[] {
  const out: HandOver[] = [];
  for (const id of store.sessionIds()) {
    let title: string | undefined;
    try {
      const s = store.readSession(id);
      if (s.role !== "conversation") continue;
      title = s.title;
    } catch { continue; }
    for (const e of store.readEvents(id).entries) {
      if (e.type !== "ideas.covered" || e.session !== id) continue;
      for (const ref of e.refs) out.push({ ref, at: e.at, session: id, ...(title ? { conversation: title } : {}) });
    }
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

/**
 * The suggestions for matching the project's earlier queues (those whose source names no note) to its notes' entries,
 * each with its queue as it stands, the entry's lead and the user's decision (idea-matches.yaml); a decision whose
 * suggestion is gone (the queue got a source, a note changed) is kept in the list. In the queues' order.
 */
export function ideaMatches(store: ProjectStore, state: ProjectState, notes = readNotes(state.project.root, state.project.conversations.notes_dir)): IdeaMatchesResponse {
  const links = deriveIdeaLinks(store.readIdeaMatches(), state, notes);
  const queues = new Map(ideaQueues(state.queues).map((q) => [q.id, q]));
  const leads = new Map(notes.flatMap((n) => n.entries.map((e) => [noteRef(n.file, e.date), e.lead] as const)));
  const order = new Map(state.queues.map((q, i) => [q.id, i]));
  const items = links.items.filter((r) => r.origin === "match").flatMap((m): MatchItem[] => {
    const q = queues.get(m.queue);
    const lead = leads.get(m.ref);
    return [{
      queue: m.queue, ref: m.ref, kind: m.kind!, quote: m.quote, title: q?.title ?? m.title, status: q?.status ?? "missing",
      diagnostics: m.diagnostics,
      current_suggestion: m.current_suggestion, recorded_evidence: m.recorded_evidence, evidence_status: m.evidence_status,
      ...(m.location ? { location: m.location } : {}),
      ...(q?.finished_at ? { finished_at: q.finished_at } : {}), ...(q?.commit ? { commit: q.commit } : {}),
      ...(lead ? { lead } : {}),
      ...(m.state !== "pending" ? { decision: { accepted: m.state === "linked", at: m.at ?? "" } } : {}),
    }];
  });
  return { revision: links.revision, items: items.sort((a, b) => (order.get(a.queue) ?? 0) - (order.get(b.queue) ?? 0)) };
}

export function ideaLinks(store: ProjectStore, state: ProjectState) {
  return deriveIdeaLinks(store.readIdeaMatches(), state, readNotes(state.project.root, state.project.conversations.notes_dir));
}

/**
 * A project's ideas overview: its notes as they are now, each entry's status from its queues (the derived state) and
 * the hand-over records, with the matches the user accepted (idea-matches.yaml) counted as the queues' source; and how
 * many suggestions still wait for the user's decision (`to_match`).
 */
export function projectIdeas(store: ProjectStore, state: ProjectState): IdeasResponse {
  const dir = state.project.conversations.notes_dir;
  const notes = readNotes(state.project.root, dir);
  const links = deriveIdeaLinks(store.readIdeaMatches(), state, notes);
  const queues = ideaQueues(state.queues).map((q) => ({ ...q,
    refs: [...new Set(links.items.filter((r) => r.queue === q.id && r.effective).map((r) => r.ref))],
    outcome: ideaOutcome(store, state.queues.find((v) => v.id === q.id)!),
  }));
  const view = deriveIdeas({ notes, queues, handovers: readHandOvers(store) });
  const open = ideaMatches(store, state, notes).items.filter((m) => !m.decision);
  return { notes_dir: dir ?? null, ...view, links, to_match: { suggestions: open.length, queues: new Set(open.map((m) => m.queue)).size } };
}
