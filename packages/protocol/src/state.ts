// Derives the dashboard's view of a project from its files. Pure apart from reading through the store;
// nothing here is ever written back (state.json, if kept, is only a cache of this).
import { ORCHESTRATOR_ONLY, type Event, type Note, type ProjectFile, type QueueFile, type QueueStatus, type ReviewItem, type SessionFile, type StepDef, type StepStatus } from "./schemas.ts";
import { ProjectStore, revisionHash } from "./store.ts";

export interface CheckView { name: string; ok: boolean; summary?: string; at: string }
export interface QuestionView {
  qid: string; session: string; queue?: string; step?: string; text: string; options?: string[];
  can_continue: boolean; asked_at: string;
  state: "open" | "answered" | "escalated" | "withdrawn";
  answers: { text: string; at: string; escalate?: boolean; continue?: boolean; session: string }[];
}
export interface StepView extends StepDef {
  status: StepStatus;
  started_at?: string; finished_at?: string;
  progress?: { text: string; pct?: number; at: string };
  session?: string;
  summary?: string; reason?: string; commit?: string;
  review_items: (ReviewItem & { at: string; round?: number })[];
  checks: CheckView[];
  notes: (Note & { read_at?: string })[];
  timeline: Event[];
}
export interface QueueView extends Omit<QueueFile, "steps"> {
  status: QueueStatus;
  status_reason?: string;
  current_step?: string;
  approved: boolean;   // the latest approval pins the current revision
  revision_hash: string;
  steps: StepView[];
  report?: { path: string; summary: string; at: string };
  questions: QuestionView[];
  updated?: string;    // time of the latest event about this queue
}
export interface SessionView extends SessionFile {
  last_event_at?: string;
  last_event?: string;
  context?: { text: string; topics: string[]; files: string[]; at: string };
  event_count: number;
}
export interface ProjectState {
  project: ProjectFile;
  queues: QueueView[];
  sessions: SessionView[];
  questions: QuestionView[];
  warnings: string[];
  generated_at: string;
}

const FINISHED_STEP: ReadonlySet<StepStatus> = new Set(["done", "skipped", "failed"]);
const TERMINAL_QUEUE: ReadonlySet<QueueStatus> = new Set(["done", "cancelled"]);

export function loadProjectState(store: ProjectStore): ProjectState {
  const warnings: string[] = [];
  const project = store.readProject();

  const queues = new Map<string, QueueView>();
  for (const id of store.queueIds()) {
    try {
      const q = store.readQueue(id);
      const { notes, errors } = store.readNotes(id);
      warnings.push(...errors);
      queues.set(id, initQueue(q, notes));
    } catch (e) { warnings.push(`queue ${id}: ${(e as Error).message}`); }
  }

  const sessions = new Map<string, SessionView>();
  const events: Event[] = [];
  for (const id of store.sessionIds()) {
    try {
      const s = store.readSession(id);
      const r = store.readEvents(id);
      warnings.push(...r.errors);
      sessions.set(id, { ...s, event_count: r.entries.length });
      for (const e of r.entries) {
        if (e.session !== id) { warnings.push(`session ${id}: event ${e.id} claims session ${e.session}; ignored`); continue; }
        if (ORCHESTRATOR_ONLY.has(e.type) && s.role !== "orchestrator") {
          warnings.push(`session ${id}: ${e.type} is for orchestrators; ignored`); continue;
        }
        events.push(e);
      }
    } catch (e) { warnings.push(`session ${id}: ${(e as Error).message}`); }
  }
  events.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));

  const questions = new Map<string, QuestionView>();
  for (const e of events) apply(e, queues, sessions, questions, warnings);

  for (const q of queues.values()) {
    q.questions = [...questions.values()].filter((x) => x.queue === q.id);
    q.current_step = q.steps.find((s) => s.status === "running" || s.status === "waiting" || s.status === "review" || s.status === "stopped")?.id;
  }

  return {
    project,
    queues: [...queues.values()],
    sessions: [...sessions.values()],
    questions: [...questions.values()],
    warnings,
    generated_at: new Date().toISOString(),
  };
}

function initQueue(q: QueueFile, notes: Note[]): QueueView {
  const hash = revisionHash(q);
  const latest = q.approvals.at(-1);
  return {
    ...q,
    status: q.status,
    status_reason: q.status_note,
    approved: !!latest && latest.revision === q.revision && latest.hash === hash,
    revision_hash: hash,
    questions: [],
    steps: q.steps.map((s) => ({
      ...s,
      status: s.status ?? "pending",
      review_items: [], checks: [], timeline: [],
      notes: notes.filter((n) => n.step === s.id),
    })),
  };
}

function apply(
  e: Event, queues: Map<string, QueueView>, sessions: Map<string, SessionView>,
  questions: Map<string, QuestionView>, warnings: string[],
): void {
  const s = sessions.get(e.session);
  if (s) {
    s.last_event_at = e.at;
    s.last_event = e.type;
    if (e.type === "context.summary") s.context = { text: e.text, topics: e.topics, files: e.files, at: e.at };
  }

  const queueOf = (id: string | undefined) => {
    if (id === undefined) return undefined;
    const q = queues.get(id);
    if (!q) warnings.push(`event ${e.id} (${e.type}) names unknown queue ${id}`);
    else q.updated = e.at;
    return q;
  };
  const stepOf = (q: QueueView | undefined, id: string | undefined) => {
    if (!q || id === undefined) return undefined;
    const st = q.steps.find((x) => x.id === id);
    if (!st) warnings.push(`event ${e.id} (${e.type}) names unknown step ${q.id}/${id}`);
    else st.timeline.push(e);
    return st;
  };

  switch (e.type) {
    case "step.started": {
      const q = queueOf(e.queue); const st = stepOf(q, e.step);
      if (!q || !st) return;
      st.status = "running"; st.started_at = e.at; st.session = e.session;
      st.finished_at = undefined; st.reason = undefined;
      if (!TERMINAL_QUEUE.has(q.status)) { q.status = "running"; q.status_reason = undefined; }
      return;
    }
    case "step.progress": {
      const st = stepOf(queueOf(e.queue), e.step);
      if (st) st.progress = { text: e.text, pct: e.pct, at: e.at };
      return;
    }
    case "review.added": {
      const st = stepOf(queueOf(e.queue), e.step);
      if (st) st.review_items.push(...e.items.map((i) => ({ ...i, at: e.at, round: e.round })));
      return;
    }
    case "check.result": {
      const st = stepOf(queueOf(e.queue), e.step);
      if (st) st.checks.push({ name: e.name, ok: e.ok, summary: e.summary, at: e.at });
      return;
    }
    case "step.done": {
      const q = queueOf(e.queue); const st = stepOf(q, e.step);
      if (!q || !st) return;
      const policy = st.review?.policy ?? q.review_policy ?? "continue";
      st.status = policy === "wait" ? "review" : "done";
      st.finished_at = e.at; st.summary = e.summary; st.commit = e.commit;
      if (q.steps.every((x) => FINISHED_STEP.has(x.status))) q.status = "done";
      else if (policy === "wait") q.status = "waiting";
      return;
    }
    case "step.failed": {
      const q = queueOf(e.queue); const st = stepOf(q, e.step);
      if (!q || !st) return;
      st.status = "failed"; st.finished_at = e.at; st.reason = e.reason;
      return;
    }
    case "queue.stop": {
      const q = queueOf(e.queue); const st = stepOf(q, e.step);
      if (!q) return;
      q.status = "stopped"; q.status_reason = `${e.condition}: ${e.reason}`;
      if (st && !FINISHED_STEP.has(st.status)) { st.status = "stopped"; st.reason = e.reason; }
      return;
    }
    case "question.asked": {
      const q = queueOf(e.queue); const st = stepOf(q, e.step);
      questions.set(e.qid, {
        qid: e.qid, session: e.session, queue: e.queue, step: e.step, text: e.text, options: e.options,
        can_continue: e.can_continue, asked_at: e.at, state: "open", answers: [],
      });
      if (!e.can_continue && st && st.status === "running") st.status = "waiting";
      if (!e.can_continue && q && q.status === "running") q.status = "waiting";
      return;
    }
    case "question.withdrawn": {
      const x = questions.get(e.qid);
      if (x) { x.state = "withdrawn"; resume(x, queues, e); }
      return;
    }
    case "answer.given": {
      const x = questions.get(e.qid);
      if (!x) { warnings.push(`answer ${e.id} to unknown question ${e.qid}`); return; }
      x.answers.push({ text: e.text, at: e.at, escalate: e.escalate, continue: e.continue, session: e.session });
      x.state = e.escalate ? "escalated" : "answered";
      if (!e.escalate) resume(x, queues, e);
      return;
    }
    case "note.read": {
      for (const q of queues.values()) for (const st of q.steps) {
        const n = st.notes.find((x) => x.id === e.note);
        if (n) { n.read_at = e.at; st.timeline.push(e); }
      }
      return;
    }
    case "queue.report": {
      const q = queueOf(e.queue);
      if (q) q.report = { path: e.path, summary: e.summary, at: e.at };
      return;
    }
    case "context.summary": {
      stepOf(queueOf(e.queue), e.step);
      return;
    }
    default:
      return;
  }
}

function resume(x: QuestionView, queues: Map<string, QueueView>, e: Event): void {
  const q = x.queue ? queues.get(x.queue) : undefined;
  const st = q?.steps.find((s) => s.id === x.step);
  if (st?.status === "waiting") { st.status = "running"; st.timeline.push(e); }
  if (q?.status === "waiting" && !q.steps.some((s) => s.status === "waiting" || s.status === "review")) q.status = "running";
}

