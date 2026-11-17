// Server-only status writer. The CLI exposes no user-decision operation.
import { closeSync, openSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { ActionError } from "./actions.ts";
import { ideaHash } from "./idea-links.ts";
import { ideaStatuses } from "./ideas-read.ts";
import { assessmentChanges, type IdeaStatusesResponse } from "./idea-status.ts";
import type { IdeaStatusAction, IdeaStatusRecord, IdeaStatusesFile } from "./schemas.ts";
import { loadProjectState, type ProjectState } from "./state.ts";
import { now, type ProjectStore } from "./store.ts";
import { rememberIdeaSources } from "./idea-source-observations.ts";

const Request = z.object({
  request_id: z.string().min(1).max(200), revision: z.string().min(1), reason: z.string().trim().min(1),
  ref: z.string().min(1), operation: z.enum(["drop", "replace", "reopen", "partial", "confirm", "revoke", "keep", "adopt-marker", "undo"]),
  target: z.string().optional(), action: z.string().optional(),
  evidence_refs: z.array(z.string().trim().min(1)).optional(), caveat_reason: z.string().trim().min(1).optional(),
}).strict();

function locked<T>(store: ProjectStore, action: () => T): T {
  const lock = join(store.dir, "idea-statuses.lock");
  let fd: number;
  try { fd = openSync(lock, "wx"); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new ActionError("Another status save is in progress; retry the same request", 409);
    throw e;
  }
  try { return action(); } finally { closeSync(fd); unlinkSync(lock); }
}

/** Remember the first observed divergence even for a suspended or revoked assessment (undo must not revive it). */
function invalidate(file: IdeaStatusesFile, view: IdeaStatusesResponse): IdeaStatusesFile {
  const assessments = new Map([...file.records, ...file.history.flatMap((a) => [a.before, a.after])]
    .flatMap((r) => r?.assessment ? [[r.assessment.id, { ref: r.ref, assessment: r.assessment }] as const] : []));
  const invalidations = [...file.invalidations];
  for (const [id, { ref, assessment }] of assessments) {
    if (invalidations.some((i) => i.assessment === id)) continue;
    const entry = view.entries.find((e) => e.ref === ref);
    const reasons = entry ? assessmentChanges(assessment.snapshot, entry.snapshot) : ["Dated decision is missing"];
    if (entry && entry.disposition !== "active" && !file.records.find((r) => r.ref === ref)?.disposition) reasons.push("Legacy disposition changed");
    if (reasons.length) invalidations.push({ assessment: id, ref, at: now(), reasons });
  }
  return invalidations.length === file.invalidations.length ? file : { ...file, invalidations };
}

/** Called by the server on startup, observed file changes and before serving Ideas. Never confirms anything. */
export function reconcileIdeaStatuses(store: ProjectStore, state: ProjectState): void {
  rememberIdeaSources(store, state);
  const initial = store.readIdeaStatuses();
  if (!initial.history.length) return;
  locked(store, () => {
    const file = store.readIdeaStatuses();
    const next = invalidate(file, ideaStatuses(store, state, file));
    if (next !== file) store.writeIdeaStatuses(next);
  });
}

export function changeIdeaStatus(store: ProjectStore, input: unknown): IdeaStatusAction {
  const parsed = Request.safeParse(input);
  if (!parsed.success) throw new ActionError(`invalid status action: ${parsed.error.message}`);
  const req = parsed.data, fingerprint = ideaHash(req);
  const saved = (file: IdeaStatusesFile) => {
    const previous = file.history.find((a) => a.id === req.request_id);
    if (previous && previous.request !== fingerprint) throw new ActionError("request_id was already used for a different action", 409);
    return previous;
  };
  const committed = saved(store.readIdeaStatuses());
  if (committed) return committed;
  return locked(store, () => {
    const file = store.readIdeaStatuses(), previous = saved(file);
    if (previous) return previous;
    const state = loadProjectState(store);
    const view = ideaStatuses(store, state, file);
    const observed = invalidate(file, view);
    // Persist observations even if this request turns out to be stale or invalid.
    if (observed !== file) store.writeIdeaStatuses(observed);
    if (req.revision !== view.revision || observed !== file) throw new ActionError("Changed since you opened this; review the newer decision", 409);
    const entry = view.entries.find((e) => e.ref === req.ref);
    if (!entry) throw new ActionError("Dated decision is missing", 404);
    const at = now(), before = file.records.find((r) => r.ref === req.ref) ?? null;
    let after: IdeaStatusRecord | null = before ? structuredClone(before) : { ref: req.ref };
    const disposition = (status: "active" | "dropped" | "replaced", target?: string) => {
      after!.disposition = { state: status, ...(target ? { target } : {}), marker: entry.marker };
    };
    if (req.operation === "undo") {
      const action = file.history.find((a) => a.id === req.action && a.ref === req.ref);
      if (!action) throw new ActionError("Status action not found", 404);
      if (file.history.slice(file.history.indexOf(action) + 1).some((a) => a.ref === req.ref)) throw new ActionError("A newer action changed this entry; review its history", 409);
      after = action.before;
    } else if (req.operation === "drop") disposition("dropped");
    else if (req.operation === "replace") {
      if (!req.target) throw new ActionError("Replacement target is required");
      disposition("replaced", req.target);
    } else if (req.operation === "reopen") {
      disposition("active"); delete after.assessment;
    } else if (req.operation === "revoke") delete after.assessment;
    else if (req.operation === "keep") disposition(entry.disposition, entry.replacement);
    else if (req.operation === "adopt-marker") {
      disposition(entry.marker.replaced_by ? "replaced" : entry.marker.dropped ? "dropped" : "active", entry.marker.replaced_by);
      delete after.assessment;
    } else {
      if (entry.disposition !== "active") throw new ActionError("Reopen this entry before assessing implementation");
      if (req.operation === "confirm") {
        if (entry.blockers.length) throw new ActionError(entry.blockers.join("; "));
        if (entry.caveats.length && !req.caveat_reason) throw new ActionError("Explain why the cancelled work or skipped steps do not leave the decision incomplete");
        if (!entry.snapshot.links.length && !req.evidence_refs?.length) throw new ActionError("Implementation without linked queues requires an explicit evidence reference");
      }
      after.assessment = { id: req.request_id, kind: req.operation === "confirm" ? "full" : "partial", at, reason: req.reason,
        evidence_refs: req.evidence_refs ?? [], ...(req.caveat_reason ? { caveat_reason: req.caveat_reason } : {}), snapshot: entry.snapshot };
    }
    const records = file.records.filter((r) => r.ref !== req.ref);
    if (after) records.push(after);
    const candidate = { ...file, records };
    const restored = ideaStatuses(store, state, candidate).entries.find((e) => e.ref === req.ref)!;
    // Recheck the entire effective graph, including legacy targets, for every replacement or undo.
    if (restored.disposition === "replaced" && restored.diagnostics.some((d) => d.includes("Replacement"))) {
      throw new ActionError(restored.diagnostics.filter((d) => d.includes("Replacement")).join("; "));
    }
    const action: IdeaStatusAction = { id: req.request_id, request: fingerprint, at, actor: "user", reason: req.reason, ref: req.ref,
      operation: req.operation, ...(req.operation === "undo" ? { undo: req.action } : {}), before, after };
    store.writeIdeaStatuses({ ...candidate, history: [...file.history, action] });
    rememberIdeaSources(store, state);
    return action;
  });
}
