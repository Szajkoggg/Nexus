// `nexus ideas status`: the short text an agent reads by default (queue ND). The full JSON carries every entry's
// snapshot (its whole text and its queues' evidence), megabytes on a real project; the summary names, per note and
// entry, the reference, the effective decision, the linked queues and the problems, in a few lines each.
import type { IdeaStatusesResponse, IdeaStatusView } from "@nexus/protocol";

/** The note a reference belongs to (the part before the #; a note's own path as it is). */
export const noteOf = (ref: string): string => (ref.includes("#") ? ref.slice(0, ref.lastIndexOf("#")) : ref);

/** An entry's effective decision: its disposition (with what replaces it) and the user's implementation assessment. */
function decision(e: IdeaStatusView): string {
  const d = e.disposition === "replaced" ? `replaced by ${e.replacement ?? "?"}` : e.disposition;
  return `${d}; ${e.implementation.replace("_", " ")}`;
}

/** An entry's problems: a stale assessment, a broken reference, a conflict, and what its work still lacks. */
function problems(e: IdeaStatusView): string[] {
  return [
    ...e.stale_reasons.map((r) => `stale: ${r}`),
    ...e.diagnostics.map((r) => `${/conflict|differ/i.test(r) ? "conflict" : "reference"}: ${r}`),
    ...(e.marker_status === "conflict" && !e.diagnostics.some((r) => /differ/i.test(r)) ? ["conflict: the note's marker and the user's decision differ"] : []),
    ...e.blockers.map((r) => `blocked: ${r}`),
    ...e.caveats.map((r) => `caveat: ${r}`),
  ];
}

/** The summary `nexus ideas status` prints: a head line with the counts and how to read more, then each note's entries. */
export function ideaStatusSummary(s: IdeaStatusesResponse): string {
  const notes = new Map<string, IdeaStatusView[]>();
  for (const e of s.entries) notes.set(noteOf(e.ref), [...(notes.get(noteOf(e.ref)) ?? []), e]);
  const count = (d: IdeaStatusView["disposition"]) => s.entries.filter((e) => e.disposition === d).length;
  const troubled = s.entries.filter((e) => problems(e).length).length;
  const lines = [
    `${s.entries.length} decided entr${s.entries.length === 1 ? "y" : "ies"} in ${notes.size} note(s): ${count("active")} active, ${count("dropped")} dropped, ${count("replaced")} replaced; ${troubled} with problems; ${s.history.length} user action(s)`,
    "One entry in full: nexus ideas status <file>.md#<date>; its text: nexus doc <file>.md#<date>; everything: nexus ideas status --full (JSON, large)",
  ];
  for (const [note, entries] of notes) {
    lines.push("", note);
    for (const e of entries) {
      const queues = e.work.queues.length ? `queues ${e.work.queues.map((q) => `${q.id} ${q.status}`).join(", ")}` : "no queue";
      lines.push(`  ${e.ref.slice(note.length)}  ${decision(e)}; ${queues}`);
      for (const p of problems(e)) lines.push(`    ${p}`);
    }
  }
  if (s.missing.length) lines.push("", `reference: the user's decisions name entries no note has: ${s.missing.join(", ")}`);
  return lines.join("\n");
}

/** The full status narrowed to the entries of one reference (a note's entry, or every entry of a note), as JSON. */
export function ideaStatusFor(s: IdeaStatusesResponse, ref: string): Pick<IdeaStatusesResponse, "revision" | "entries" | "history" | "invalidations"> {
  const match = (r: string) => r === ref || noteOf(r) === ref;
  return { revision: s.revision, entries: s.entries.filter((e) => match(e.ref)), history: s.history.filter((h) => match(h.ref)), invalidations: s.invalidations.filter((i) => match(i.ref)) };
}
