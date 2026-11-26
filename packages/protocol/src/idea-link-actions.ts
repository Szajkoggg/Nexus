// Dashboard-only mutations: one atomic file replacement contains the overlay and its compensating history.
import { closeSync, openSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { ActionError } from "./actions.ts";
import { deriveIdeaLinks, ideaHash, type IdeaLinksResponse, type IdeaLinkView } from "./idea-links.ts";
import { readNotes } from "./ideas-read.ts";
import { noteRefIssue, noteRefs, type IdeaNote } from "./ideas.ts";
import { type IdeaLinkAction, type IdeaLinkRecord, type IdeaMatchesFile } from "./schemas.ts";
import { loadProjectState, type ProjectState } from "./state.ts";
import { now, type ProjectStore } from "./store.ts";
import { reconcileIdeaStatuses } from "./idea-status-actions.ts";

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
  return withIdeaLinks(store, (links) => {
    const previous = saved(links.file);
    if (previous) return previous;
    if (links.view.revision !== req.revision) throw new ActionError("Changed since you opened this; review the newer decision", 409);
    const { view, file } = links;
    const edit = linkEditor(links, `manual:${req.request_id}`);
    const { changes, find, validate, change, add } = edit;
    if (req.operation === "add") add(req.queue, req.ref, req.reason);
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
        const suggestion = view.items.find((v) => v.id === r.id)!.current_suggestion;
        if (d.accept === true) {
          validate(r.queue, r.ref);
        }
        change(r, { ...r, ...(d.accept === true ? suggestion : {}), state: d.accept === null ? "pending" : d.accept ? "linked" : "rejected", at: links.at });
      }
    } else {
      const r = find(req.origin);
      const source = req.operation === "ignore-source" || req.operation === "correct-source";
      if (source !== (r.origin === "source")) throw new ActionError("Queue sources require the separate ignore-source or correct-source operation");
      if (r.state !== "linked") throw new ActionError("This origin is not linked", 409);
      edit.unlink(r);
      if (req.operation === "replace" || req.operation === "correct-source") {
        if (req.ref === r.ref) throw new ActionError("Choose a different target");
        add(r.queue, req.ref, req.reason);
      }
    }
    const action: IdeaLinkAction = { id: req.request_id, request: fingerprint, at: links.at, actor: "user", reason: req.reason,
      operation: req.operation, ...(req.operation === "undo" ? { undo: req.action } : {}), changes };
    recordAction(links, action);
    return action;
  });
}

/**
 * The relationships as they stand under the writer's lock (idea-matches.lock), for one write: the file, the project's
 * state and notes, the derived origins, and the time of the write. recordAction adds an action to it (several may go
 * into one write: the user's acceptance of several proposals, idea-proposals.ts); the file is written once, when the
 * run returns, and the idea statuses are reconciled after it.
 */
export interface IdeaLinksWrite {
  file: IdeaMatchesFile; state: ProjectState; notes: IdeaNote[]; view: IdeaLinksResponse; at: string; written: boolean;
}

/** Runs `run` under the relationships' lock and writes what it recorded; refused (409) while another write holds it. */
export function withIdeaLinks<T>(store: ProjectStore, run: (links: IdeaLinksWrite) => T): T {
  const lock = join(store.dir, "idea-matches.lock");
  let fd: number;
  try { fd = openSync(lock, "wx"); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new ActionError("Another relationship save is in progress; retry the same request", 409);
    throw e;
  }
  try {
    const file = store.readIdeaMatches();
    const state = loadProjectState(store);
    reconcileIdeaStatuses(store, state);
    const notes = readNotes(state.project.root, state.project.conversations.notes_dir);
    const links: IdeaLinksWrite = { file, state, notes, view: deriveIdeaLinks(file, state, notes), at: now(), written: false };
    const out = run(links);
    if (links.written) {
      store.writeIdeaMatches(links.file);
      reconcileIdeaStatuses(store, state);
    }
    return out;
  } finally { closeSync(fd); unlinkSync(lock); }
}

/** An action into the write: the file gets it and the origins' new records, and the origins are derived again. */
export function recordAction(links: IdeaLinksWrite, action: IdeaLinkAction): void {
  // Snapshot all known origins on a successful save so later deletions retain their last-known identity.
  const records = new Map(links.view.items.map((r) => [r.id, linkRecord(r)]));
  for (const c of action.changes) records.set(c.after.id, c.after);
  links.file = { ...links.file, records: [...records.values()], history: [...(links.file.history ?? []), action] };
  links.view = deriveIdeaLinks(links.file, links.state, links.notes);
  links.written = true;
}

const linkRecord = (r: IdeaLinkView): IdeaLinkRecord => {
  const { effective: _effective, diagnostics: _diagnostics, current_suggestion: _current, recorded_evidence: _recorded, evidence_status: _status, ...value } = r;
  return value;
};

/**
 * The changes of one action, on the origins as they stand: `add` a manual link (its id `manualId`; refused when the
 * edge is effective already and this action does not unlink it), `unlink` an origin (a queue's source is ignored, a
 * match or manual link removed).
 */
export function linkEditor(links: IdeaLinksWrite, manualId: string) {
  const { view, state, notes, at } = links;
  const changes: IdeaLinkAction["changes"] = [];
  const find = (id: string | undefined) => {
    const found = view.items.find((r) => r.id === id);
    if (!found) throw new ActionError("Relationship origin not found", 404);
    return linkRecord(found);
  };
  const validate = (queue: string | undefined, ref: string | undefined) => {
    const q = state.queues.find((q) => q.id === queue);
    if (!q) throw new ActionError(`Queue ${queue ?? ""} is missing`, 404);
    const issue = noteRefIssue(ref ?? "", state.project.conversations.notes_dir, notes);
    if (issue) throw new ActionError(issue);
    return q;
  };
  const change = (before: IdeaLinkRecord | null, after: IdeaLinkRecord) => {
    if (changes.some((c) => c.after.id === after.id)) throw new ActionError("An origin can only be changed once per action");
    changes.push({ before, after });
  };
  const add = (queue: string | undefined, ref: string | undefined, reason: string) => {
    const q = validate(queue, ref);
    if (view.items.some((r) => r.queue === q.id && r.ref === ref && r.effective && !changes.some((c) => c.after.id === r.id && c.after.state !== "linked"))) {
      throw new ActionError("Already linked; review the existing origins", 409);
    }
    const n = notes.find((n) => n.entries.some((e) => `${n.file}#${e.date}` === ref))!;
    change(null, { id: manualId, queue: q.id, ref: ref!, origin: "manual", state: "linked", title: q.title,
      note_title: n.title, lead: n.entries.find((e) => `${n.file}#${e.date}` === ref)!.lead, quote: reason, at });
  };
  const unlink = (r: IdeaLinkRecord) => change(r, { ...r, state: r.origin === "source" ? "ignored" : "removed", at });
  return { changes, find, validate, change, add, unlink };
}
