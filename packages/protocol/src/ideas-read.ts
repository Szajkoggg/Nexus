// Reading what the ideas overview (ideas.ts) is derived from: a project's notes folder (every Markdown note in it and
// its subfolders, the README, the folder's conventions, left out; only read: the notes are the thinking partner's), the
// hand-over records in the partners' own events, and its queues.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { deriveIdeas, ideaQueues, parseNote, type HandOver, type IdeaNote, type IdeasResponse } from "./ideas.ts";
import type { ProjectStore } from "./store.ts";
import type { ProjectState } from "./state.ts";

/** The notes of a project: `notesDir` is relative to its root (conversations.notes_dir); none without a folder. */
export function readNotes(root: string, notesDir: string | undefined): IdeaNote[] {
  if (!notesDir) return [];
  const base = join(root, notesDir);
  if (!existsSync(base)) return [];
  const out: IdeaNote[] = [];
  const walk = (dir: string, rel: string) => {
    for (const d of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = rel ? `${rel}/${d.name}` : d.name;
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
 * A project's ideas overview: its notes as they are now, each entry's status from its queues (the derived state) and
 * the hand-over records. `matched`: the references the user accepted for queues without a source (by queue id).
 */
export function projectIdeas(store: ProjectStore, state: ProjectState, matched: Readonly<Record<string, readonly string[]>> = {}): IdeasResponse {
  const dir = state.project.conversations.notes_dir;
  const view = deriveIdeas({ notes: readNotes(state.project.root, dir), queues: ideaQueues(state.queues, matched), handovers: readHandOvers(store) });
  return { notes_dir: dir ?? null, ...view };
}
