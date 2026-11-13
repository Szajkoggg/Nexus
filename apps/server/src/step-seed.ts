// The context a thinking partner gets about the step a conversation is about ("Chat about this"), by the step's state:
// pending and skipped: goal, acceptance and notes; running and waiting: also the progress so far; review, done,
// failed, stopped and rejected: also the summary, checks, review material, commits and the reason. When the step
// changed state since the partner got it, a short "since then" addition goes with the user's next message.
import type { ProjectState, QueueView, StepStatus, StepView } from "@nexus/protocol";

const AT_WORK: ReadonlySet<StepStatus> = new Set(["running", "waiting"]);
const PLAIN: ReadonlySet<StepStatus> = new Set(["pending", "skipped"]);

/** The step a conversation is about, or why it cannot be found. */
export function findStep(state: ProjectState, queue: string, step: string): { q: QueueView; st: StepView } | undefined {
  const q = state.queues.find((x) => x.id === queue);
  const st = q?.steps.find((x) => x.id === step);
  return q && st ? { q, st } : undefined;
}

const oneLine = (s: string, max = 600) => { const t = s.replace(/\s+/g, " ").trim(); return t.length > max ? `${t.slice(0, max)}…` : t; };

/** Every commit the step reported, oldest first (one per round that named one). */
function commits(st: StepView): string[] {
  const all = st.timeline.flatMap((e) => (e.type === "step.done" && e.commit ? [e.commit] : []));
  if (st.commit && !all.includes(st.commit)) all.push(st.commit);
  return [...new Set(all)];
}

function progressLines(st: StepView): string[] {
  const out: string[] = [];
  if (st.started_at) out.push(`Started: ${st.started_at}${st.session ? ` (worker session ${st.session})` : ""}`);
  if (st.progress) out.push(`Progress so far (${st.progress.at}): ${oneLine(st.progress.text)}${st.progress.pct !== undefined ? ` (${st.progress.pct} %)` : ""}`);
  return out;
}

function checkLines(st: StepView): string[] {
  if (!st.checks.length) return [];
  return ["Checks:", ...st.checks.map((c) => `- ${c.name}: ${c.ok ? "ok" : "FAILED"}${c.summary ? `: ${oneLine(c.summary, 300)}` : ""}`)];
}

function reviewLines(st: StepView): string[] {
  if (!st.review_items.length) return [];
  return ["Review material (paths relative to the project's root, or links):", ...st.review_items.map((r) => `- ${r.path ?? r.url}${r.label ? `: ${r.label}` : ""}${r.round ? ` (round ${r.round})` : ""}`)];
}

function outcomeLines(st: StepView): string[] {
  const out: string[] = [];
  if (st.summary) out.push(`Summary: ${oneLine(st.summary, 1500)}`);
  if (st.reason) out.push(`Reason (${st.status}): ${oneLine(st.reason, 1000)}`);
  const c = commits(st);
  if (c.length) out.push(`Commits: ${c.join(", ")}`);
  for (const b of st.sent_back) out.push(`Sent back by the ${b.by} (${b.at}): ${oneLine(b.text, 500)}`);
  if (st.review_with) out.push(`The review waits for ${st.review_with === "user" ? "the user" : "the orchestrator"}.`);
  return out;
}

/** What the partner gets about the step before the user's first message. */
export function stepSeed(state: ProjectState, queue: string, step: string): string {
  const found = findStep(state, queue, step);
  if (!found) return `[Nexus] The user opened this conversation about step ${step} of queue ${queue}, which no longer exists in the project. Ask the user what it was about.`;
  const { q, st } = found;
  const lines = [
    `[Nexus] The user opened this conversation about step ${st.id} ("${st.title}") of queue ${q.id} ("${q.title}") in project ${state.project.name}. The step's state now: ${st.status}.`,
    `Talking here changes nothing in the run: the step keeps its state (a step in review keeps waiting) until the user acts on it in the dashboard (in review: Accept, Fix it or Reject), or hands this conversation to the orchestrator. You cannot act on the step yourself.`,
    "",
    "Goal:",
    st.goal.trim() || "(none written)",
  ];
  if (st.acceptance.length) lines.push("", "Acceptance criteria:", ...st.acceptance.map((a) => `- ${a}`));
  if (st.notes.length) lines.push("", "Notes on the step:", ...st.notes.map((n) => `- from the ${n.from} (${n.at}): ${oneLine(n.body, 1000)}`));
  if (!PLAIN.has(st.status)) {
    const progress = progressLines(st);
    if (progress.length) lines.push("", ...progress);
    if (!AT_WORK.has(st.status)) {
      const more = [...outcomeLines(st), ...checkLines(st), ...reviewLines(st)];
      if (more.length) lines.push("", ...more);
    }
  } else if (st.status === "skipped" && st.reason) {
    lines.push("", `Skipped: ${oneLine(st.reason, 1000)}`);
  }
  const questions = q.questions.filter((x) => x.step === st.id && (x.state === "open" || x.state === "escalated"));
  if (questions.length) lines.push("", "Open questions of the step:", ...questions.map((x) => `- ${oneLine(x.text, 500)}`));
  lines.push("", "The user's message follows.");
  return lines.join("\n");
}

/** A short addition for a partner whose step changed state since it got its context; undefined when it did not. */
export function sinceThen(state: ProjectState, queue: string, step: string, seeded: { status: StepStatus; at: string }): string | undefined {
  const found = findStep(state, queue, step);
  if (!found) return `[Nexus] Since you got its context (${seeded.at}), step ${step} was removed from queue ${queue}. The user's message follows.`;
  const { st } = found;
  if (st.status === seeded.status) return undefined;
  const lines = [`[Nexus] Since you got its context (${seeded.at}), step ${st.id} went from ${seeded.status} to ${st.status}.`];
  if (AT_WORK.has(st.status)) lines.push(...progressLines(st));
  else if (!PLAIN.has(st.status)) {
    lines.push(...outcomeLines(st));
    const failed = st.checks.filter((c) => !c.ok);
    if (st.checks.length) lines.push(`Checks: ${st.checks.length - failed.length} ok${failed.length ? `, failed: ${failed.map((c) => c.name).join(", ")}` : ""}.`);
    if (st.review_items.length) lines.push(`Review material: ${st.review_items.map((r) => r.path ?? r.url).join(", ")}`);
  } else if (st.reason) lines.push(`Reason: ${oneLine(st.reason, 1000)}`);
  lines.push("The user's message follows.");
  return lines.join("\n");
}
