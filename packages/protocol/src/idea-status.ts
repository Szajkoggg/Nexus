// Pure effective status and assessment validity. Queue completion is never user confirmation.
import { ideaHash, type IdeaLinksResponse } from "./idea-links.ts";
import { noteRef, type IdeaNote, type IdeaOutcome } from "./ideas.ts";
import type { IdeaAssessmentSnapshot, IdeaStatusRecord, IdeaStatusesFile } from "./schemas.ts";
import type { ProjectState, QueueView } from "./state.ts";

export interface IdeaStatusView {
  ref: string;
  disposition: "active" | "dropped" | "replaced";
  replacement?: string;
  marker: NonNullable<IdeaStatusRecord["disposition"]>["marker"];
  marker_status: "legacy" | "overridden" | "current" | "conflict";
  implementation: "unconfirmed" | "partial" | "full" | "needs_review" | "suspended";
  assessment?: IdeaStatusRecord["assessment"];
  stale_reasons: string[];
  diagnostics: string[];
  blockers: string[];
  caveats: string[];
  work: { state: "none" | "linked" | "some_finished" | "finished"; queues: { id: string; status: string; issues: string[] }[] };
  snapshot: IdeaAssessmentSnapshot;
}
export interface IdeaStatusesResponse {
  revision: string;
  entries: IdeaStatusView[];
  history: IdeaStatusesFile["history"];
  invalidations: IdeaStatusesFile["invalidations"];
  missing: string[];
}

function workIssues(q: QueueView): { blockers: string[]; caveats: string[] } {
  const blockers: string[] = [], caveats: string[] = [];
  if (q.status !== "done" && q.status !== "cancelled") blockers.push(`${q.id}: work is ${q.status}`);
  if (q.status === "cancelled") caveats.push(`${q.id}: cancelled work needs a coverage explanation`);
  for (const s of q.steps) {
    if (q.status !== "cancelled" && (s.status === "failed" || s.status === "stopped")) blockers.push(`${q.id}/${s.id}: step is ${s.status}`);
    if (s.status === "skipped") caveats.push(`${q.id}/${s.id}: skipped step needs a coverage explanation`);
    if (s.provisional && (!s.provisional.confirmed || s.provisional.fix)) blockers.push(`${q.id}/${s.id}: awaiting final review`);
    if (q.status === "done" && s.status !== "done" && s.status !== "skipped") blockers.push(`${q.id}/${s.id}: result is not accepted`);
  }
  if (q.git?.merge?.waiting) blockers.push(`${q.id}: merge needs attention: ${q.git.merge.waiting.reason}`);
  else if (q.git?.merge?.reintegrating || q.git?.merge?.queued || ((q.integration || q.git?.base) && !q.git?.merged)) blockers.push(`${q.id}: awaiting merge`);
  return { blockers, caveats };
}

/** Only acceptance-relevant evidence; sort edges so origin/order/reason changes do not invalidate assessments. */
function queueEvidence(q: QueueView, outcome?: IdeaOutcome) {
  return { id: q.id, status: q.status, rejection: q.rejection,
    steps: q.steps.map((s) => ({ id: s.id, goal: s.goal, acceptance: s.acceptance, status: s.status, summary: s.summary, commit: s.commit,
      provisional: s.provisional, rounds: s.timeline.filter((e) => e.type === "step.done" || e.type.startsWith("review.")) })),
    merge: { base: q.git?.base, merged: q.git?.merged, merge: q.git?.merge },
    report: outcome?.report, accepted: outcome?.accepted };
}

export function assessmentChanges(before: IdeaAssessmentSnapshot, after: IdeaAssessmentSnapshot): string[] {
  return [before.content !== after.content ? "Decided content changed" : "",
    ideaHash(before.links) !== ideaHash(after.links) ? "Effective linked work changed" : "",
    before.evidence !== after.evidence ? "Work evidence or acceptance changed" : ""].filter(Boolean);
}

export function deriveIdeaStatuses(file: IdeaStatusesFile, state: ProjectState, notes: IdeaNote[], links: IdeaLinksResponse,
  outcomes: ReadonlyMap<string, IdeaOutcome> = new Map()): IdeaStatusesResponse {
  const records = new Map(file.records.map((r) => [r.ref, r]));
  const all = new Map(notes.flatMap((n) => n.entries.map((e) => [noteRef(n.file, e.date), e] as const)));
  const targetOf = (ref: string) => {
    const ui = records.get(ref)?.disposition;
    return ui ? ui.state === "replaced" ? ui.target : undefined : all.get(ref)?.replaced_by;
  };
  const replacementIssue = (ref: string, target: string) => {
    const seen = new Set([ref]);
    let next: string | undefined = target;
    while (next) {
      if (seen.has(next)) return "Replacement cycle";
      if (!all.has(next)) return `Replacement target is missing: ${next}`;
      seen.add(next); next = targetOf(next);
    }
    return undefined;
  };
  const entries = [...all].map(([ref, e]): IdeaStatusView => {
    const record = records.get(ref), ui = record?.disposition;
    const marker = { ...(e.dropped ? { dropped: e.dropped } : {}), ...(e.replaced_by ? { replaced_by: e.replaced_by } : {}) };
    const disposition = ui?.state ?? (e.replaced_by ? "replaced" : e.dropped ? "dropped" : "active");
    const replacement = ui ? ui.target : e.replaced_by;
    const diagnostics: string[] = [];
    if (e.dropped && e.replaced_by) diagnostics.push("Conflicting legacy markers");
    const marker_status = !ui ? "legacy" : ideaHash(ui.marker) !== ideaHash(marker) ? "conflict"
      : (e.dropped || e.replaced_by) ? "overridden" : "current";
    if (marker_status === "conflict") diagnostics.push("Note and decision differ");
    if (replacement) { const issue = replacementIssue(ref, replacement); if (issue) diagnostics.push(issue); }
    const origins = links.items.filter((l) => l.ref === ref && l.effective);
    const ids = [...new Set(origins.map((l) => l.queue))].sort();
    const blockers: string[] = [], caveats: string[] = [];
    const queues = ids.map((id) => {
      const q = state.queues.find((q) => q.id === id);
      if (!q) { blockers.push(`Queue ${id} is missing`); return { id, status: "missing", issues: [`Queue ${id} is missing`] }; }
      const issues = workIssues(q); blockers.push(...issues.blockers); caveats.push(...issues.caveats);
      return { id, status: q.status, issues: [...issues.blockers, ...issues.caveats] };
    });
    const snapshot = { content: e.content, links: ids, evidence: JSON.stringify(ids.map((id) => {
      const q = state.queues.find((q) => q.id === id); return q ? queueEvidence(q, outcomes.get(id)) : { id, missing: true };
    })) };
    const assessment = record?.assessment;
    const stale_reasons = [...new Set(assessment ? [...assessmentChanges(assessment.snapshot, snapshot),
      ...file.invalidations.filter((i) => i.assessment === assessment.id).flatMap((i) => i.reasons)] : [])];
    const finished = queues.filter((q) => q.status === "done").length;
    return { ref, disposition, ...(replacement ? { replacement } : {}), marker, marker_status,
      implementation: !assessment ? "unconfirmed" : disposition !== "active" ? "suspended" : stale_reasons.length ? "needs_review" : assessment.kind,
      ...(assessment ? { assessment } : {}), stale_reasons, diagnostics, blockers, caveats, snapshot,
      work: { state: !queues.length ? "none" : finished === queues.length ? "finished" : finished ? "some_finished" : "linked", queues } };
  });
  const missing = file.records.filter((r) => !all.has(r.ref)).map((r) => r.ref);
  return { revision: ideaHash({ file, entries, notes, links: links.revision }), entries, history: file.history, invalidations: file.invalidations, missing };
}
