// The orchestrator's view of a project's state, as text: what `nexus status` prints in an orchestrator's session, and
// what a fresh orchestrator session starts from (apps/server/src/orchestrator.ts). Pure: it reads a derived state.
import { stopPlace } from "./attention.ts";
import { openPlan } from "./plan.ts";
import { reviewRound } from "./checks.ts";
import { decisionsCount } from "./review-decisions.ts";
import { formatDuration } from "./times.ts";
import { trainText } from "./train.ts";
import type { BasePull } from "./schemas.ts";
import type { ProjectState, QueueView, SessionView, StepView } from "./state.ts";
import { isOpenQuestion, runGoing } from "./status-rules.ts";
import { stepValuesText } from "./steps.ts";
import { tokenCount } from "./tokens.ts";

/** A stopped queue's ways out: where the stop is, how the user lifts it, and the orchestrator's proposal to lift it. */
export function stopLines(q: QueueView): string[] {
  if (q.status !== "stopped") return [];
  const how = q.approved ? "the user lifts it with Continue, or by approving a new revision" : `the user lifts it by approving revision ${q.revision}`;
  const p = q.lift_proposal;
  return [`  stopped${stopPlace(q)}; ${how}`, ...(p ? [`  proposal to lift (orchestrator, ${p.at}): ${p.reason.replace(/\s+/g, " ").slice(0, 300)}`] : [])];
}

/**
 * Each time the queue's run went on in a fresh session (run.yaml `switches`), as `nexus status` says it: the step, when,
 * why, and what the fresh session started from; the dashboard's run panel says the same.
 */
export function switchLines(q: Pick<QueueView, "run">): string[] {
  return (q.run?.switches ?? []).map((s) => {
    const why = s.why === "runtime" ? "the step runs on another runtime"
      : s.why === "refactor" ? "the closing refactoring step reads the queue's work with fresh eyes"
      : s.why === "usage" ? "the old session's runtime was beyond the usage threshold"
      : s.why === "idle" ? `the old session was idle for ${formatDuration((s.idle_minutes ?? 60) * 60_000)}, past its cache's life`
      : `the old session's context was full${s.tokens !== undefined ? ` (${tokenCount(s.tokens)} tokens${s.fill !== undefined ? `, ${Math.round(s.fill * 100)} %` : ""})` : ""}`;
    const seed = s.summary === "written" ? "seeded with its context summary" : s.summary === "asked" ? "seeded with the summary it wrote when asked" : "seeded with the queue's text and its steps' summaries";
    return `  fresh session ${s.to} from ${s.step} at ${s.at.slice(0, 16).replace("T", " ")}: ${why}; ${seed}`;
  });
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

/**
 * What an agent's acceptance ran on, as the orchestrator and the CLI say it (queue RH): the runtime's name, model and
 * effort, those recorded.
 */
export function acceptedOn(a: { runtime?: string; model?: string; effort?: string }): string {
  return [a.runtime === "codex" ? "Codex" : "Claude Code", a.model, a.effort].filter(Boolean).join(", ");
}

/**
 * A review helper on the step (queue RH, H17): it reviews it now, or it accepted it (on which runtime, model and
 * effort). Empty otherwise, so what the orchestrator and the user saw before helpers stays as it was.
 */
/** A step in review: its decisions (queue RVD), " (review decisions: 3, 1 open (D2))", or a list nobody declared. */
function reviewDecisionsText(q: QueueView, x: StepView): string {
  const count = decisionsCount(x.decisions, reviewRound(q, x));
  if (count) return ` (review decisions: ${count})`;
  return x.decision_list === "missing" ? " (no review decision list declared)" : "";
}

export function helperText(x: Pick<StepView, "status" | "helper" | "accepted">): string {
  if (x.status === "review" && x.helper?.state === "running") return " (the review helper reviews it)";
  const a = x.accepted;
  if (x.status !== "done" || a?.by !== "helper") return "";
  return ` (accepted by the review helper, ${acceptedOn(a)})`;
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
 * How much of the project `orchestratorOverview` shows (queue ND). `all` (the default, what a fresh orchestrator session
 * starts from, and `nexus status --all`): every queue and worker session, cards whole. Without it (`nexus status`): the
 * open queues, the finished ones only counted, and of the worker sessions the live ones, those of open queues and the
 * FREE_SESSIONS latest others, cards cut to CARD_CHARS. `queue`: that queue alone (open or finished), its sessions and
 * what waits about it.
 */
export interface OverviewOptions { all?: boolean; queue?: string }

/** How many free sessions besides the live and open queues' ones the short overview shows, and how long a card. */
const FREE_SESSIONS = 10;
const CARD_CHARS = 300;

const isFinished = (q: QueueView): boolean => q.status === "done" || q.status === "cancelled";

/**
 * The worker sessions the short overview keeps, in their order: the live ones, those running a queue or of an open
 * queue, and the FREE_SESSIONS latest others (session ids are ULIDs).
 */
function recentSessions(state: ProjectState, shown: SessionView[], busyWith: (w: SessionView) => QueueView | undefined): SessionView[] {
  const openIds = new Set(state.queues.filter((q) => !isFinished(q)).map((q) => q.id));
  const first = shown.filter((w) => (w.live && w.live.state !== "exited") || busyWith(w) || (w.queue && openIds.has(w.queue)));
  const rest = shown.filter((w) => !first.includes(w)).sort((a, b) => (a.id < b.id ? 1 : -1)).slice(0, FREE_SESSIONS);
  return shown.filter((w) => first.includes(w) || rest.includes(w));
}

/**
 * What an orchestrator needs to see (`nexus status` in its session, and the first message of a fresh orchestrator
 * session): queues, runs, open questions and worker sessions with their context cards; how many, by `opts`.
 */
export function orchestratorOverview(state: ProjectState, opts: OverviewOptions = { all: true }): string {
  const out: string[] = [];
  const all = opts.all || opts.queue !== undefined;
  // A session's size in tokens first (queue CT): the orchestrator continues one only under about REUSE_TOKENS.
  const context = (t?: number, w?: number) => (t ? `context ${tokenCount(t)} tokens${w ? ` (${Math.round((100 * t) / w)} % of ${tokenCount(w)})` : ""}` : "context unknown");
  const queues = opts.queue === undefined ? state.queues : state.queues.filter((q) => q.id === opts.queue);
  const done = queues.filter(isFinished);
  const finished = all
    ? done.map((q) => `${q.id}${closingSkipped(q) ? ` (${closingSkipped(q)})` : ""}`).join(", ") || "none"
    : `${done.length}; nexus status --all names them`;
  out.push(`
Queues (${queues.length - done.length} open; finished: ${finished})`);
  // A finished queue asked for by name shows as an open one does: its steps and how it ended.
  for (const q of opts.queue === undefined ? queues.filter((x) => !done.includes(x)) : queues) {
    const run = q.run ? `; run ${q.run.state}${q.run.step ? ` at ${q.run.step}` : ""} in session ${q.run.session}${q.run.reason ? ` (${q.run.reason})` : ""}` : "";
    out.push(`- ${q.id} [${q.status}] ${q.title}: revision ${q.revision}, ${q.approved ? "approved" : "not approved"}${run}`);
    // A revision waiting for approval comes first: nothing runs and no planned start fires until the user approves it.
    if (!q.approved) out.push(`  needs approval (revision ${q.revision})${(q.start && !q.start.failed) || openPlan(q) ? ": its planned start below waits for it" : ""}`);
    out.push(`  steps: ${q.steps.map((x) => `${x.id} ${x.status}${x.continued ? ` → ${x.continued.in.join(", ")}` : ""} (level ${x.level}${x.level_from === "user" ? ", set by the user" : ""})${provisionalText(x)}${helperText(x)}${x.closing && x.status === "skipped" ? ` (${closingSkipped(q)})` : ""}${x.review_with ? ` (for ${x.review_with === "user" ? "the user" : "you"})` : ""}${x.status === "review" ? reviewDecisionsText(q, x) : ""}${stepValuesText(x) ? ` [on ${stepValuesText(x)}]` : ""}${x.tags.kind || x.tags.size ? ` {${[x.tags.kind, x.tags.size].filter(Boolean).join(" ")}}` : ""}`).join(", ")}`);
    if (q.status_reason && q.status !== "running") out.push(`  why: ${q.status_reason.replace(/\s+/g, " ").slice(0, 300)}`);
    for (const line of stopLines(q)) out.push(line);
    for (const line of planLines(q)) out.push(line);
    for (const line of switchLines(q)) out.push(line);
  }
  const ofQueue = (queue: string | undefined) => opts.queue === undefined || queue === opts.queue;
  const open = state.questions.filter((x) => isOpenQuestion(x) && ofQueue(x.queue));
  out.push(`
Open questions (${open.length})`);
  for (const x of open) out.push(`- ${x.qid} [${x.state}] ${x.queue ?? ""}${x.step ? `/${x.step}` : ""}: ${x.text}`);
  const workers = state.sessions.filter((x) => x.role === "worker");
  const busyWith = (w: SessionView) => state.queues.find((q) => q.run?.session === w.id && runGoing(q.run));
  const shown = opts.queue === undefined ? workers
    : workers.filter((w) => w.queue === opts.queue || state.queues.some((q) => q.id === opts.queue && q.run?.session === w.id));
  const kept = all ? shown : recentSessions(state, shown, busyWith);
  out.push(`
Worker sessions (${opts.queue === undefined ? workers.length : `${shown.length} of queue ${opts.queue}`}${kept.length < shown.length ? `; shown: the ${kept.length} live, of open queues and latest, cards cut to ${CARD_CHARS} characters; nexus status --all shows every one whole` : ""})`);
  for (const w of kept) {
    const busy = busyWith(w);
    out.push(`- ${w.id} "${w.title ?? ""}" ${w.runtime}${w.launched_by === "nexus" ? "" : " (external)"}, ${w.live?.state ?? "not live"}, ${w.live?.model ?? w.model ?? "model ?"}, ${context(w.live?.context_tokens, w.live?.context_window)}${busy ? `, running queue ${busy.id}` : ", free"}`);
    if (!w.context) continue;
    const card = `  knows: ${w.context.topics.join(", ") || "-"}; ${w.context.text.replace(/\s+/g, " ")}`;
    out.push(all || card.length <= CARD_CHARS ? card : `${card.slice(0, CARD_CHARS - 1)}…`);
  }
  const attention = state.attention.filter((a) => a.kind !== "question" && ofQueue(a.queue));
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
