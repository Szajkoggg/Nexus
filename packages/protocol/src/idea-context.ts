// Exact, fresh note/date context shared by idea conversations and direct handoff previews. No model synthesis.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { ActionError } from "./actions.ts";
import { ideaHash } from "./idea-links.ts";
import { projectIdeas } from "./ideas-read.ts";
import { IdeaScope } from "./schemas.ts";
import { loadProjectState } from "./state.ts";
import type { ProjectStore } from "./store.ts";

/** Complete Open/Ideas sections, preserving prose and nested lists; code fences cannot introduce sections. */
function undecided(text: string): { open: string; ideas: string } {
  const out = { open: "", ideas: "" };
  let section: { kind: keyof typeof out; level: number } | undefined;
  let fence: { char: string; length: number } | undefined;
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (section) out[section.kind] += `${line}\n`;
      if (delimiter && delimiter[1]![0] === fence.char && delimiter[1]!.length >= fence.length && !delimiter[2]!.trim()) fence = undefined;
      continue;
    }
    if (delimiter) fence = { char: delimiter[1]![0]!, length: delimiter[1]!.length };
    const heading = !delimiter && /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      if (section && heading[1]!.length <= section.level) section = undefined;
      const name = /^(open|ideas)\b/i.exec(heading[2]!);
      if (name) { section = { kind: name[1]!.toLowerCase() as "open" | "ideas", level: heading[1]!.length }; continue; }
    }
    if (section) out[section.kind] += `${line}\n`;
  }
  return { open: out.open.trim(), ideas: out.ideas.trim() };
}

export function ideaContext(store: ProjectStore, input: unknown, selectedDates?: readonly string[]) {
  const parsed = IdeaScope.safeParse(input);
  if (!parsed.success) throw new ActionError("Invalid idea scope: exact note file and optional Decided date required");
  const scope = parsed.data, state = loadProjectState(store), view = projectIdeas(store, state);
  // projectIdeas/readNotes checks the notes boundary and excludes symlinks. Match an exact discovered identity.
  const note = view.notes.find((n) => n.file === scope.file);
  if (!note) throw new ActionError("The idea note is missing or outside the configured notes folder", 404);
  const dates = selectedDates ?? (scope.date ? [scope.date] : note.entries.map((e) => e.date));
  if (dates.some((d) => !note.entries.some((e) => e.date === d))) throw new ActionError("The selected Decided date is missing", 404);
  const decisions = note.entries.filter((e) => dates.includes(e.date)).map((e) => ({
    ref: e.ref, date: e.date, content: e.content, effective: e.effective,
    links: view.links.items.filter((l) => l.ref === e.ref),
  }));
  const snapshot = { project: state.project.id, file: note.file, title: note.title, summary: note.summary ?? "",
    decisions, undecided: undecided(readFileSync(join(state.project.root, note.file), "utf8")) };
  const revision = ideaHash(snapshot);
  const text = [
    `[Nexus idea context] Project: ${snapshot.project}\nNote: ${note.file}\nTitle: ${note.title}`,
    `Scope: ${scope.date ? `${note.file}#${scope.date}` : selectedDates ? `selected dates: ${dates.join(", ") || "none (context only)"}` : "whole note"}`,
    `Summary\n${snapshot.summary || "(none)"}`,
    `Decided / selected dates\n${decisions.map((d) => `${d.ref}\n${d.content}\nEffective status and provenance (user decisions take precedence over historical note markers):\n${JSON.stringify({ effective: d.effective, links: d.links }, null, 2)}`).join("\n\n") || "(none selected)"}`,
    `Not decided — Open\n${snapshot.undecided.open || "(none)"}`,
    `Not decided — Ideas\n${snapshot.undecided.ideas || "(none)"}`,
    "This context does not approve, start, stop or reopen a queue, change a start plan, or lift any start prohibition. Linked work completion is not user confirmation or proof of deployment. References to other notes are see-also links only; their contents are outside this scope.",
  ].join("\n\n");
  return { scope, snapshot, revision, text };
}

const Selection = z.object({ file: z.string().min(1), dates: z.array(z.string()).max(500),
  purpose: z.enum(["plan", "context"]), instruction: z.string().trim().max(20000).default("") }).strict();

export function previewIdeaHandoff(store: ProjectStore, input: unknown) {
  const parsed = Selection.safeParse(input);
  if (!parsed.success) throw new ActionError(`Invalid handoff selection: ${parsed.error.message}`);
  const selection = { ...parsed.data, dates: [...new Set(parsed.data.dates)].sort() };
  const context = ideaContext(store, { file: selection.file }, selection.dates);
  if (selection.purpose === "plan" && (!selection.dates.length || context.snapshot.decisions.some((d) => d.effective?.disposition !== "active" || d.effective.implementation === "full"))) {
    throw new ActionError("Planning requires selected active, not fully confirmed dates. Include completed/dropped/replaced dates as context only, or explicitly reopen them first.");
  }
  const payload = [
    "[Direct idea handoff from the user]",
    `Purpose: ${selection.purpose === "plan" ? "Discuss / plan next work. This is not approval or permission to start work." : "Context only. Do not propose reimplementation or treat this as a request to start work."}`,
    `User instruction\n${selection.instruction || "(none)"}`, context.text,
  ].join("\n\n");
  return { selection, revision: context.revision, snapshot: context.snapshot, payload };
}
