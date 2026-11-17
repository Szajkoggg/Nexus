// Server observations retain source identities before deletion; this never accepts a suggested relationship.
import { closeSync, openSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { deriveIdeaLinks } from "./idea-links.ts";
import { readNotes } from "./ideas-read.ts";
import type { ProjectState } from "./state.ts";
import type { ProjectStore } from "./store.ts";

export function rememberIdeaSources(store: ProjectStore, state: ProjectState): void {
  const lock = join(store.dir, "idea-matches.lock");
  let fd: number;
  try { fd = openSync(lock, "wx"); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "EEXIST") return; throw e; }
  try {
    const file = store.readIdeaMatches();
    const known = new Set(file.records?.map((r) => r.id));
    const sources = deriveIdeaLinks(file, state, readNotes(state.project.root, state.project.conversations.notes_dir)).items
      .filter((r) => r.origin === "source" && !known.has(r.id))
      .map(({ effective: _effective, diagnostics: _diagnostics, ...record }) => record);
    if (sources.length) store.writeIdeaMatches({ ...file, records: [...(file.records ?? []), ...sources] });
  } finally { closeSync(fd); unlinkSync(lock); }
}
