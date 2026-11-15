// Reading a project's notes folder for the ideas overview (ideas.ts): every Markdown note in it and its subfolders,
// the README (the folder's conventions, not a note) left out. Only read: the notes are the thinking partner's.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseNote, type IdeaNote } from "./ideas.ts";

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
