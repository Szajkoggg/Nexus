// The orchestrator's view of a project's state, as text: what `nexus status` prints in an orchestrator's session, and
// what a fresh orchestrator session starts from (apps/server/src/orchestrator.ts). Pure: it reads a derived state.
import { stopPlace } from "./attention.ts";
import { openPlan } from "./plan.ts";
import { trainText } from "./train.ts";
import type { BasePull } from "./schemas.ts";
import type { ProjectState, QueueView } from "./state.ts";
import { isOpenQuestion, runGoing } from "./status-rules.ts";
import { stepValuesText } from "./steps.ts";

/** A stopped queue's ways out: where the stop is, how the user lifts it, and the orchestrator's proposal to lift it. */
export function stopLines(q: QueueView): string[] {
  if (q.status !== "stopped") return [];
  const how = q.approved ? "the user lifts it with Continue, or by approving a new revision" : `the user lifts it by approving revision ${q.revision}`;
  const p = q.lift_proposal;
  return [`  stopped${stopPlace(q)}; ${how}`, ...(p ? [`  proposal to lift (orchestrator, ${p.at}): ${p.reason.replace(/\s+/g, " ").slice(0, 300)}`] : [])];
}

/**
 * A queue's place in the plan: the queues it waits for (each with who set it and how it stands), a proposal waiting for
 * the user, its planned start, and why it has not started; and its place in the merge train (train.ts).
 */
export function planLines(q: QueueView): string[] {
  const out: string[] = [];
  const plan = openPlan(q);
  const p = q.start;
  if (plan) {
    const entries = plan.after.map((e) => `${e.queue} (${e.by === "user" ? "set by the user" : "yours"}${e.done ? ", done" : ""})`);
    out.push(`  in the plan${plan.by === "user" ? " (put in by the user)" : ""}: ${entries.length ? `starts after ${entries.join(", ")}` : "starts as soon as it may"}${p?.session ? `, in session ${p.session}` : ""}`);
    if (plan.proposal) out.push(`  your proposal waits for the user: ${plan.proposal.after.length ? `after ${plan.proposal.after.join(", ")}` : "with no queue before it"} (${plan.proposal.reason.replace(/\s+/g, " ").slice(0, 200)})`);
  }
  if (p?.at) out.push(`  scheduled at ${new Date(p.at).toLocaleString("sv-SE").slice(0, 16)}${p.usage ? " (usage reset)" : ""}${p.session ? `, in session ${p.session}` : ""}`);
  if (p?.failed) out.push(`  the planned start did not happen: ${p.failed.reason} (the user sees it; start the queue or take it out of the plan with nexus run ${q.id} cancel-start)`);
  else if (p || plan) out.push(`  now: ${(p?.waiting || plan?.waiting || "it may start")}${p?.held ? " (it starts by itself)" : ""}`);
  if (q.train) out.push(`  integration: ${trainText(q.train)}; it goes on by itself`);
  const pull = conflictingPull(q);
  if (pull) out.push(`  base: ${pull.base} (${pull.sha.slice(0, 12)}) conflicts with the queue's branch in ${fileList(pull.conflicts ?? [], 5)} (found before step ${pull.before}, ${pull.at.slice(0, 16).replace("T", " ")}); Nexus did not merge it, the integration step will`);
  return out;
}

/**
 * The base Nexus did not merge into the queue's branch at its last step boundary because it conflicts (git.yaml
 * `pulls`, queue MI): the last pull, while it is a conflict and the queue is not over.
 */
function conflictingPull(q: Pick<QueueView, "git" | "status">): BasePull | undefined {
  const last = q.git?.pulls?.at(-1);
  return last && !last.to && q.status !== "done" && q.status !== "cancelled" ? last : undefined;
}

/** A short list of files: the first `most`, and how many more. */
export function fileList(files: readonly string[], most = 8): string {
  return files.length > most ? `${files.slice(0, most).join(", ")} and ${files.length - most} more` : files.join(", ");
}

/** A provisional acceptance in the overview: waiting for the user, confirmed, or sent to a fix. */
function provisionalText(x: { provisional?: { confirmed?: string; fix?: { text: string } } }): string {
  const p = x.provisional;
  if (!p) return "";
  return p.fix ? ` (accepted provisionally; the user asked a fix: ${p.fix.text.replace(/\s+/g, " ").slice(0, 120)})`
    : p.confirmed ? " (accepted provisionally, confirmed by the user)" : " (accepted provisionally, waits for the user's confirmation)";
}

/** The user's skip of the queue's closing refactoring step (at Continue or with an approval), with its reason; empty without one. */
function closingSkipped(q: QueueView): string {
  const c = q.steps.find((x) => x.closing);
  return c?.status === "skipped" ? `closing refactoring skipped by the user: ${(c.reason ?? "").replace(/\s+/g, " ").slice(0, 200)}` : "";
}

/**
 * What an orchestrator needs to see (`nexus status` in its session, and the first message of a fresh orchestrator
 * session): every queue, run, open question and worker session with its context card.
 */
export function orchestratorOverview(state: ProjectState): string {
  const out: string[] = [];
  const pct = (t?: number, w?: number) => (t && w ? `${Math.round((100 * t) / w)} % context` : "context unknown");
  const done = state.queues.filter((q) => q.status === "done" || q.status === "cancelled");
  out.push(`
Queues (${state.queues.length - done.length} open; finished: ${done.map((q) => `${q.id}${closingSkipped(q) ? ` (${closingSkipped(q)})` : ""}`).join(", ") || "none"})`);
  for (const q of state.queues.filter((x) => !done.includes(x))) {
    const run = q.run ? `; run ${q.run.state}${q.run.step ? ` at ${q.run.step}` : ""} in session ${q.run.session}${q.run.reason ? ` (${q.run.reason})` : ""}` : "";
    out.push(`- ${q.id} [${q.status}] ${q.title}: revision ${q.revision}, ${q.approved ? "approved" : "not approved"}${run}`);
    // A revision waiting for approval comes first: nothing runs and no planned start fires until the user approves it.
    if (!q.approved) out.push(`  needs approval (revision ${q.revision})${(q.start && !q.start.failed) || openPlan(q) ? ": its planned start below waits for it" : ""}`);
    out.push(`  steps: ${q.steps.map((x) => `${x.id} ${x.status} (level ${x.level}${x.level_from === "user" ? ", set by the user" : ""})${provisionalText(x)}${x.closing && x.status === "skipped" ? ` (${closingSkipped(q)})` : ""}${x.review_with ? ` (for ${x.review_with === "user" ? "the user" : "you"})` : ""}${stepValuesText(x) ? ` [on ${stepValuesText(x)}]` : ""}${x.tags.kind || x.tags.size ? ` {${[x.tags.kind, x.tags.size].filter(Boolean).join(" ")}}` : ""}`).join(", ")}`);
    if (q.status_reason && q.status !== "running") out.push(`  why: ${q.status_reason.replace(/\s+/g, " ").slice(0, 300)}`);
    for (const line of stopLines(q)) out.push(line);
    for (const line of planLines(q)) out.push(line);
  }
  const open = state.questions.filter(isOpenQuestion);
  out.push(`
Open questions (${open.length})`);
  for (const x of open) out.push(`- ${x.qid} [${x.state}] ${x.queue ?? ""}${x.step ? `/${x.step}` : ""}: ${x.text}`);
  const workers = state.sessions.filter((x) => x.role === "worker");
  out.push(`
Worker sessions (${workers.length})`);
  for (const w of workers) {
    const busy = state.queues.find((q) => q.run?.session === w.id && runGoing(q.run));
    out.push(`- ${w.id} "${w.title ?? ""}" ${w.runtime}${w.launched_by === "nexus" ? "" : " (external)"}, ${w.live?.state ?? "not live"}, ${w.live?.model ?? w.model ?? "model ?"}, ${pct(w.live?.context_tokens, w.live?.context_window)}${busy ? `, running queue ${busy.id}` : ", free"}`);
    if (w.context) out.push(`  knows: ${w.context.topics.join(", ") || "-"}; ${w.context.text.replace(/\s+/g, " ").slice(0, 300)}`);
  }
  const attention = state.attention.filter((a) => a.kind !== "question");
  if (attention.length) {
    out.push(`
Waiting for the user`);
    for (const a of attention) {
      const where = a.lift ? `${a.queue}${a.lift.place}` : `${a.queue ?? ""}${a.step ? `/${a.step}` : ""}`;
      // A stop's waiting item has its reason as its text and its condition apart: the agent reads both, as before.
      const text = a.condition ? `${a.condition}: ${a.text}` : a.text;
      out.push(`- ${a.kind} ${where}: ${text.replace(/\s+/g, " ").slice(0, 160)}`);
      if (!a.lift) continue;
      out.push(`  ${a.lift.continue ? "Continue lifts it" : `approving revision ${a.lift.revision} lifts it`}`);
      const p = a.lift.proposal;
      if (p) out.push(`  proposal to lift (orchestrator, ${p.at}): ${p.reason.replace(/\s+/g, " ").slice(0, 300)}`);
    }
  }
  return out.join("\n");
}
