// Dashboard-only mutations: one atomic file replacement contains the overlay and its compensating history.
import { closeSync, openSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { ActionError } from "./actions.ts";
import { deriveIdeaLinks, ideaHash, type IdeaLinkView } from "./idea-links.ts";
import { readNotes } from "./ideas-read.ts";
import { noteRefIssue, noteRefs } from "./ideas.ts";
import { type IdeaLinkAction, type IdeaLinkRecord, type IdeaMatchesFile } from "./schemas.ts";
import { loadProjectState } from "./state.ts";
import { now, type ProjectStore } from "./store.ts";

const Request = z.object({
  request_id: z.string().min(1).max(200), revision: z.string().min(1), reason: z.string().trim().min(1),
  operation: z.enum(["add", "replace", "remove", "ignore-source", "correct-source", "decide", "undo"]),
  origin: z.string().optional(), queue: z.string().optional(), ref: z.string().optional(),
  action: z.string().optional(),
  decisions: z.array(z.object({ origin: z.string(), accept: z.boolean().nullable() })).min(1).optional(),
}).strict();

export function changeIdeaLinks(store: ProjectStore, input: unknown): IdeaLinkAction {
  const parsed = Request.safeParse(input);
  if (!parsed.success) throw new ActionError(`invalid relationship action: ${parsed.error.message}`);
  const req = parsed.data;
  const fingerprint = ideaHash(req);
  const saved = (file: IdeaMatchesFile) => {
    const previous = file.history?.find((a) => a.id === req.request_id);
    if (previous && previous.request !== fingerprint) throw new ActionError("request_id was already used for a different action", 409);
    return previous;
  };
  // Retrieving an already committed result is read-only, even if a crashed writer left its lock behind.
  const committed = saved(store.readIdeaMatches());
  if (committed) return committed;
  const lock = join(store.dir, "idea-matches.lock");
  let fd: number;
  try { fd = openSync(lock, "wx"); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new ActionError("Another relationship save is in progress; retry the same request", 409);
    throw e;
  }
  try {
    const file = store.readIdeaMatches();
    const previous = saved(file);
    if (previous) return previous;
    const state = loadProjectState(store);
    const notes = readNotes(state.project.root, state.project.conversations.notes_dir);
    const view = deriveIdeaLinks(file, state, notes);
    if (view.revision !== req.revision) throw new ActionError("Changed since you opened this; review the newer decision", 409);
    const at = now();
    const record = (r: IdeaLinkView): IdeaLinkRecord => {
      const { effective: _effective, diagnostics: _diagnostics, ...value } = r;
      return value;
    };
    const find = (id: string | undefined) => {
      const found = view.items.find((r) => r.id === id);
      if (!found) throw new ActionError("Relationship origin not found", 404);
      return record(found);
    };
    const validate = (queue: string | undefined, ref: string | undefined) => {
      const q = state.queues.find((q) => q.id === queue);
      if (!q) throw new ActionError(`Queue ${queue ?? ""} is missing`, 404);
      const issue = noteRefIssue(ref ?? "", state.project.conversations.notes_dir, notes);
      if (issue) throw new ActionError(issue);
      return q;
    };
    const changes: IdeaLinkAction["changes"] = [];
    const change = (before: IdeaLinkRecord | null, after: IdeaLinkRecord) => {
      if (changes.some((c) => c.after.id === after.id)) throw new ActionError("An origin can only be changed once per action");
      changes.push({ before, after });
    };
    const add = (queue: string | undefined) => {
      const q = validate(queue, req.ref);
      if (view.items.some((r) => r.queue === q.id && r.ref === req.ref && r.effective && !changes.some((c) => c.after.id === r.id && c.after.state !== "linked"))) {
        throw new ActionError("Already linked; review the existing origins", 409);
      }
      const n = notes.find((n) => n.entries.some((e) => `${n.file}#${e.date}` === req.ref))!;
      change(null, { id: `manual:${req.request_id}`, queue: q.id, ref: req.ref!, origin: "manual", state: "linked", title: q.title,
        note_title: n.title, lead: n.entries.find((e) => `${n.file}#${e.date}` === req.ref)!.lead, quote: req.reason, at });
    };
    if (req.operation === "add") add(req.queue);
    else if (req.operation === "undo") {
      const action = file.history?.find((a) => a.id === req.action);
      if (!action) throw new ActionError("Action not found", 404);
      const later = file.history!.slice(file.history!.indexOf(action) + 1);
      for (const c of action.changes) {
        if (later.some((a) => a.changes.some((x) => x.after.id === c.after.id))) throw new ActionError("A newer action changed this origin; review its history", 409);
        const current = find(c.after.id);
        if (ideaHash(current) !== ideaHash(c.after)) throw new ActionError("The origin changed since this action", 409);
        const restored = c.before ?? { ...current, state: "removed" as const };
        if (restored.state === "linked") {
          const q = validate(restored.queue, restored.ref);
          if (restored.origin === "source" && !noteRefs(q.source).includes(restored.ref)) throw new ActionError("Cannot restore a missing queue source");
        }
        change(current, restored);
      }
    } else if (req.operation === "decide") {
      if (!req.decisions?.length) throw new ActionError("decisions is required");
      for (const d of req.decisions) {
        const r = find(d.origin);
        if (r.origin !== "match") throw new ActionError("Only a historical match can be accepted or rejected");
        if (d.accept === true) validate(r.queue, r.ref);
        change(r, { ...r, state: d.accept === null ? "pending" : d.accept ? "linked" : "rejected", at });
      }
    } else {
      const r = find(req.origin);
      const source = req.operation === "ignore-source" || req.operation === "correct-source";
      if (source !== (r.origin === "source")) throw new ActionError("Queue sources require the separate ignore-source or correct-source operation");
      if (r.state !== "linked") throw new ActionError("This origin is not linked", 409);
      change(r, { ...r, state: source ? "ignored" : "removed", at });
      if (req.operation === "replace" || req.operation === "correct-source") {
        if (req.ref === r.ref) throw new ActionError("Choose a different target");
        add(r.queue);
      }
    }
    const action: IdeaLinkAction = { id: req.request_id, request: fingerprint, at, actor: "user", reason: req.reason,
      operation: req.operation, ...(req.operation === "undo" ? { undo: req.action } : {}), changes };
    // Snapshot all known origins on a successful save so later deletions retain their last-known identity.
    const records = new Map(view.items.map((r) => [r.id, record(r)]));
    for (const c of changes) records.set(c.after.id, c.after);
    store.writeIdeaMatches({ ...file, records: [...records.values()], history: [...(file.history ?? []), action] });
    return action;
  } finally { closeSync(fd); unlinkSync(lock); }
}
