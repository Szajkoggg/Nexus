// The reviews' quality on three levels (queue RH, H16; PROTOCOL.md, "The review helper"): the user's signals (Fix it,
// Reject, a provisional acceptance returned), the cost signals (send-backs by who sent them, check-fix rounds, the
// review helper's reviews passed on to the orchestrator, by reason and as a share), and the audit (the helper's
// acceptances the orchestrator reviewed again, and how many it disagreed with), by the helper's runtime, model and
// effort. Pure and free of Node: `nexus stats --reviews` and the server's statistics endpoint use it.
import type { PassOnReason } from "./schemas.ts";
import type { ProjectState, StepView } from "./state.ts";

/** Above this share of passed-on reviews the packet probably lacks something (DESIGN.md, "Routine reviews by a helper"). */
const PASS_ON_HIGH = 0.25;

/** The review helper's group: its runtime, model and effort, as a session recorded them. */
const helperGroup = (x: { runtime?: string; model?: string; effort?: string }) =>
  `review helper ${[x.runtime ?? "claude", x.model ?? "default model", x.effort ?? "default effort"].join(" ")}`;

export interface ReviewStats {
  project?: string;
  since?: string;
  /** Steps accepted, by who accepted them: each review helper group, the orchestrator, the user, Nexus. */
  accepted: Record<string, number>;
  /** The user's signals. */
  user: { fix_it: number; rejected: number; provisional_returned: number };
  /** The cost signals: send-backs by who sent them, check-fix rounds after failed checks, the helper's passed-on share. */
  sent_back: { helper: number; orchestrator: number; user: number };
  check_fix_rounds: number;
  /**
   * Review rounds the helpers took (a helper started, or Nexus passed the step on without one), how many reached the
   * orchestrator, their share, and by reason (a pass-on's every reason counts). `high`: above PASS_ON_HIGH.
   */
  passed_on: { reviews: number; passed_on: number; share?: number; high: boolean; by_reason: Partial<Record<PassOnReason, number>> };
  /** The audit, by review helper group: its acceptances, how many were audited, how many the orchestrator disagreed with. */
  audit: { group: string; acceptances: number; audited: number; disagreed: number }[];
}

/** The review figures of the projects given (one, with `project`), counting what happened at or after `since`. */
export function reviewStats(states: readonly Pick<ProjectState, "project" | "queues" | "sessions">[], o: { project?: string; since?: string } = {}): ReviewStats {
  const out: ReviewStats = {
    project: o.project, since: o.since, accepted: {}, user: { fix_it: 0, rejected: 0, provisional_returned: 0 },
    sent_back: { helper: 0, orchestrator: 0, user: 0 }, check_fix_rounds: 0,
    passed_on: { reviews: 0, passed_on: 0, high: false, by_reason: {} }, audit: [],
  };
  const after = (at: string | undefined) => !!at && (!o.since || at >= o.since);
  const audit = new Map<string, ReviewStats["audit"][number]>();
  for (const state of states) {
    if (o.project && state.project.id !== o.project) continue;
    const role = (id: string) => state.sessions.find((s) => s.id === id)?.role;
    // The review rounds helpers took: by a helper session's step and round, and by a pass-on of Nexus's.
    const rounds = new Set<string>();
    const passed = new Map<string, readonly PassOnReason[]>();
    for (const s of state.sessions) {
      const a = s.role === "helper" && s.about && "round" in s.about ? s.about : undefined;
      if (a && after(s.created_at)) rounds.add(`${a.queue}/${a.step}/${a.round}`);
    }
    for (const q of state.queues) for (const st of q.steps) {
      countStep(out, st, after, audit);
      for (const set of q.check_runs?.steps[st.id]?.sets ?? []) if (set.state === "failed" && after(set.requested_at)) out.check_fix_rounds++;
      for (const e of st.timeline) {
        if (!after(e.at)) continue;
        if (e.type === "review.rejected" && role(e.session) === "user") out.user.rejected++;
        if (e.type === "review.passed_on" && (role(e.session) === "helper" || role(e.session) === "nexus")) {
          const key = `${q.id}/${st.id}/${e.round}`;
          rounds.add(key);
          if (!passed.has(key)) passed.set(key, e.reasons);
        }
      }
    }
    out.passed_on.reviews += rounds.size;
    out.passed_on.passed_on += passed.size;
    for (const reasons of passed.values()) for (const r of reasons) out.passed_on.by_reason[r] = (out.passed_on.by_reason[r] ?? 0) + 1;
  }
  const p = out.passed_on;
  if (p.reviews) { p.share = p.passed_on / p.reviews; p.high = p.share > PASS_ON_HIGH; }
  out.audit = [...audit.values()].sort((a, b) => a.group.localeCompare(b.group));
  return out;
}

/** One step's acceptance, send-backs, returned provisional acceptance and audit. */
function countStep(out: ReviewStats, st: StepView, after: (at: string | undefined) => boolean, audit: Map<string, ReviewStats["audit"][number]>): void {
  const a = st.accepted;
  if (a && after(a.at)) {
    const who = a.by === "helper" ? helperGroup(a) : a.by === "nexus" ? "Nexus" : a.by;
    out.accepted[who] = (out.accepted[who] ?? 0) + 1;
    if (a.by === "helper") {
      const g = audit.get(who) ?? { group: who, acceptances: 0, audited: 0, disagreed: 0 };
      g.acceptances++;
      if (st.audit) { g.audited++; if (st.audit.verdict === "disagree") g.disagreed++; }
      audit.set(who, g);
    }
  }
  for (const b of st.sent_back) {
    if (!after(b.at)) continue;
    out.sent_back[b.by]++;
    if (b.by === "user") out.user.fix_it++;
  }
  if (after(st.provisional?.fix?.at)) out.user.provisional_returned++;
}

const pctText = (x: number) => `${Math.round(x * 100)} %`;

/** The figures as `nexus stats --reviews` prints them. */
export function reviewStatsText(r: ReviewStats): string {
  const head = `Reviews (${r.project ? `project ${r.project}` : "all projects"}${r.since ? `, since ${r.since}` : ""})`;
  const accepted = Object.entries(r.accepted).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(", ") || "none";
  const p = r.passed_on;
  const reasons = Object.entries(p.by_reason).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(", ");
  const passed = p.reviews
    ? `${p.passed_on} of ${p.reviews} passed on to the orchestrator (${pctText(p.share ?? 0)}${p.high ? ", above 25 %: the packet may lack something" : ""})${reasons ? `; by reason: ${reasons}` : ""}`
    : "no review by the helper";
  const audits = r.audit.length
    ? r.audit.map((g) => `- ${g.group}: ${g.acceptances} accepted, ${g.audited} audited, ${g.disagreed} disagreed${g.audited ? ` (${pctText(g.disagreed / g.audited)} of the audited)` : ""}`).join("\n")
    : "- no acceptance of the review helper";
  return [
    head,
    `Accepted by: ${accepted}`,
    `1. The user's signals: ${r.user.fix_it} Fix it, ${r.user.rejected} rejected, ${r.user.provisional_returned} provisional acceptances returned`,
    `2. The cost signals: send-backs by the review helper ${r.sent_back.helper}, the orchestrator ${r.sent_back.orchestrator}, the user ${r.sent_back.user}; ${r.check_fix_rounds} check-fix rounds; the review helper: ${passed}`,
    `3. The audit:\n${audits}`,
  ].join("\n");
}
