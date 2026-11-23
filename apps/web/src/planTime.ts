// The plan's time axis (docs/ux/plan-view-modes.md, "The time axis: the estimate contract"; queue PVA, step PVA4): a row
// per queue, in the plan's order, a bar from its expected start to its expected end by the dependencies and the
// estimates (GET /estimates: work time by model and effort, a running step counted whole). It decides nothing and
// models no scheduler: what it does not know stays unknown. A wait for the user (a review, an answer, an approval) and a
// wait of unknown length (a checkout, the limit) make the rest of the bar, and every follower's, conditional (hatched,
// its note saying "if …"); a stopped, paused or gone predecessor gives no bar to it and its followers; a missing
// estimate is never 0 h. Pure, with the clock passed in, and unit tested (test/plan-time.test.ts).
import { formatClock, t, type Key, type Params } from "./i18n.ts";
import { planList, stepsLeftOf, waitsForUser, workOf, type Estimates, type PlanLayout, type PlanNode, type PlanQueue, type ReviewWho, type Words } from "./plan.ts";

/** What the axis reads of a queue beyond the plan's (a QueueView fits). */
export interface TimeQueue extends PlanQueue {
  /** The run; `resume_at`: when a wait for the usage window (or a retry) ends. */
  run?: NonNullable<PlanQueue["run"]> & { resume_at?: string };
  steps: readonly { id: string; title?: string; status: string; level?: number; review_with?: "orchestrator" | "user" }[];
}

/** The estimates as the axis reads them: none (not loaded, failed, or too few finished steps) is `undefined`. */
export type TimeEstimates = Estimates | undefined;

/** Why a bar becomes conditional from some point: a wait for the user, or one Nexus keeps for an unknown time. */
interface Cause { queue: string; kind: "review" | "answer" | "approval" | "held" }

export interface TimeRow {
  id: string;
  title: string;
  /** Its expected start, ms from now; absent: no bar (it waits for the user first, a loop, or an unknown start). */
  start?: number;
  /** Its expected end, ms from now; absent with a start: its work is not known (an open bar from the start). */
  end?: number;
  /** From here on (ms from now) the bar is hatched: what comes after a wait of unknown length. */
  cond?: number;
  /** A wait Nexus keeps by itself before the start (the usage window, a retry): dotted, ms from now. */
  wait?: [number, number];
  /** The steps that wait for the user's review, ms from now (where its queue's estimate puts them). */
  marks: number[];
  /** No bar, but it cannot start before this (ms from now): what its predecessors are known to take at least. */
  notBefore?: number;
  /** The bar's colour: at work, waiting by itself for the usage window, or planned. */
  tone: "running" | "usage" | "planned";
  /** An open bar's word (its work unknown): "running", "from 22:10", "if reviewed", "if approved", "at 22:00". */
  open?: Words;
  /** What the row says, in parts ("after RX", "if ST2 is reviewed by then", "no estimate"). */
  note: Words[];
  /** No time at all: it, or a queue before it, waits for the user first (a stop, a pause, a predecessor gone), or a loop. */
  blocked?: boolean;
}

export interface TimeAxis {
  rows: TimeRow[];
  /** Estimates are used (loaded, enough finished steps): else only the set times are placed. */
  known: boolean;
}

const w = (key: Key, params?: Params): Words => (params ? { key, params } : { key });
const clockIn = (ms: number, now: Date) => formatClock(new Date(now.getTime() + ms).toISOString(), now);
const and = (ids: readonly string[]) => ids.join(" and ");

/** The steps left that surely wait for the user's review (PVAR's rule, plan.ts userReviewsOf): their place among the steps left. */
function reviewPoints(q: TimeQueue | undefined, who: ReviewWho): { id: string; at: number; left: number; waiting: boolean }[] {
  if (!q) return [];
  const left = stepsLeftOf(q.steps);
  return left.flatMap((s, i) => (waitsForUser(s, who) ? [{ id: s.id, at: i + 1, left: left.length, waiting: s.status === "review" }] : []));
}

/** A cause in words: "ST2 is reviewed", "CH is approved". */
const causeWords = (c: Cause) => `${c.queue} ${c.kind === "review" ? "is reviewed" : c.kind === "answer" ? "is answered" : c.kind === "approval" ? "is approved" : "is through its wait"}`;

interface Placed {
  start?: number; end?: number; cond?: number;
  /** The least its end can be (a start known, its work not; or its start's own least). */
  least: number;
  /** It has no bar because something waits for the user (or a loop): followers have none either; who. */
  blocked?: string;
  causes: Cause[];
}

/**
 * The time axis of the plan at `now`: each shown queue's row by the contract (docs/ux/plan-view-modes.md). `estimates`
 * undefined: no estimates (too few finished steps, not loaded, a failed fetch): only the set times are placed (a run
 * at work, the usage window's reset, a schedule) and the rest named in its order.
 */
export function timeAxis(l: PlanLayout, queues: readonly TimeQueue[], estimates: TimeEstimates, who: ReviewWho, now: Date): TimeAxis {
  const byId = new Map(queues.map((q) => [q.id, q]));
  const nodes = new Map(planList(l).map((n) => [n.id, n]));
  const placed = new Map<string, Placed>();
  const rows = new Map<string, TimeRow>();
  const at = (iso: string | undefined) => (iso ? Math.max(0, new Date(iso).getTime() - now.getTime()) : undefined);

  const place = (id: string, path: Set<string>): Placed => {
    const known = placed.get(id);
    if (known) return known;
    const n = nodes.get(id)!;
    const q = byId.get(id);
    const row: TimeRow = { id, title: n.title, marks: [], tone: "planned", note: [] };
    const done = (p: Placed) => { placed.set(id, p); rows.set(id, row); return p; };
    if (path.has(id)) { row.note.push(w("plan.time.loop")); return { least: 0, blocked: id, causes: [] }; }

    // What only the user can change first: no time would be true.
    const own = ownBlock(n);
    if (own) { row.note.push(own); row.blocked = true; return done({ least: 0, blocked: id, causes: [] }); }

    // Its predecessors shown and not done, and the queue it waits to integrate after (the merge train).
    const before = [...n.before.filter((b) => !b.done && nodes.has(b.queue)).map((b) => b.queue),
      ...(q?.train?.after && nodes.has(q.train.after) && q.train.after !== id ? [q.train.after] : [])];
    path.add(id);
    const preds = before.map((b) => ({ id: b, p: place(b, path) }));
    path.delete(id);
    const blockedBy = preds.find((x) => x.p.blocked);
    if (blockedBy) {
      row.note.push(w("plan.time.after", { queues: and(before) }), w("plan.time.blockedBy", { queue: blockedBy.p.blocked! }));
      row.blocked = true;
      return done({ least: 0, blocked: blockedBy.p.blocked!, causes: [] });
    }
    let start: number | undefined = 0, least = 0;
    const causes: Cause[] = [];
    for (const { p } of preds) {
      start = start === undefined || p.end === undefined ? undefined : Math.max(start, p.end);
      least = Math.max(least, p.end ?? p.least);
      if (p.cond !== undefined) for (const c of p.causes) if (!causes.some((x) => x.queue === c.queue)) causes.push(c);
    }
    let cond: number | undefined;
    const ownCause = (kind: Cause["kind"]) => causes.unshift({ queue: id, kind });

    // The set times: a run at work, a wait by itself until a known time, a schedule.
    const says = n.status.says?.key;
    if (n.now) {
      const resume = q?.run && (says === "status.usage" || says === "status.retry") ? at(q.run.resume_at) : undefined;
      if (resume !== undefined) {
        row.wait = [0, resume]; row.tone = "usage"; start = Math.max(start ?? 0, resume); least = Math.max(least, resume);
        row.open = w("plan.time.from", { time: clockIn(resume, now) });
        row.note.push(w(says === "status.usage" ? "plan.time.usage" : "plan.time.retryAt", { time: clockIn(resume, now) }));
      } else if (n.status.tone === "review" && says !== "status.orchestratorReviews") {
        cond = 0; ownCause("review"); row.open = w("plan.time.ifReviewed");
        row.note.push(w("plan.time.reviewNow", { step: n.status.step ?? id }));
      } else if (n.status.tone === "waiting" && says !== "status.heldLimit") {
        cond = 0; ownCause("answer"); row.open = w("plan.time.ifAnswered"); row.note.push(w("plan.time.answerNow"));
      } else if (n.status.tone === "approval") {
        cond = 0; ownCause("approval"); row.open = w("plan.time.ifApproved");
        row.note.push(w("plan.time.approveNow", { revision: q?.revision ?? 1 }));
      } else if (says === "status.heldLimit") {
        cond = 0; ownCause("held"); row.note.push(w("plan.time.heldNow"));
      } else {
        row.tone = "running"; row.open = w("plan.time.running");
        row.note.push(estimates ? w("plan.time.runningWhole", { label: n.status.label }) : w("plan.time.runningNow", { label: n.status.label }));
      }
      if (before.length) row.note.push(w("plan.time.after", { queues: and(before) }));
    } else {
      const set = at(q?.start?.at);
      if (set !== undefined && !q?.start?.held) {
        if (q?.start?.usage) row.wait = [0, set];
        start = start === undefined ? undefined : Math.max(start, set);
        least = Math.max(least, set);
        if (!before.length) row.open = w(q?.start?.usage ? "plan.time.from" : "plan.time.at", { time: clockIn(set, now) });
        row.note.push(w(q?.start?.usage ? "plan.time.usage" : "plan.time.startsAt", { time: clockIn(set, now) }));
      }
      if (before.length) row.note.push(w("plan.time.after", { queues: and(before) }));
      if (q?.approved === false) {
        cond = start; ownCause("approval");
        if (!before.length && set === undefined) { row.open = w("plan.time.ifApproved"); row.note.push(w("plan.time.approveNow", { revision: q.revision ?? 1 })); }
        else row.note.push(w("plan.time.onceApproved"));
      }
      const held = q?.start?.held && q.start.held.kind !== "approval" ? q.start.held : undefined;
      if (held || n.resting?.tone === "waiting") {
        cond = cond ?? start; ownCause("held");
        row.note.push(w("plan.time.held", { reason: held?.reason ?? n.resting!.label }));
      }
    }
    if (cond === undefined && causes.length && start !== undefined) cond = start;

    // The work: the estimate from the start; the review points where the queue's estimate shares it evenly.
    const work = workOf(id, estimates);
    const end = start !== undefined && work !== undefined ? start + work : undefined;
    const reviews = reviewPoints(q, who);
    for (const r of reviews) {
      const m = r.waiting ? start : start !== undefined && work !== undefined ? start + (work * r.at) / Math.max(1, r.left) : undefined;
      if (m === undefined) continue;
      row.marks.push(Math.round(m));
      if (cond === undefined || m < cond) cond = m;
      if (!causes.some((c) => c.queue === id)) ownCause("review");
    }
    const points = reviews.filter((r) => !r.waiting);
    if (points.length && !(n.now && n.status.tone === "review")) row.note.push(w("plan.time.reviewLater", { count: points.length, steps: and(points.map((x) => x.id)) }));
    const inherited = causes.filter((c) => c.queue !== id);
    if (inherited.length) row.note.push(w("plan.time.ifBy", { conds: inherited.map(causeWords).join(" and ") }));

    if (start !== undefined) {
      row.start = start;
      if (end !== undefined) row.end = end;
      if (cond !== undefined) row.cond = Math.max(start, cond);
    } else if (least > 0) row.notBefore = least;
    // Without estimates a row with a set start says only that (an open bar); every other says it has none.
    if (work === undefined && (estimates || start === undefined)) row.note.push(w("plan.time.noEstimate"));
    if (start === undefined) delete row.open;
    if (start !== undefined && end === undefined && !row.open) row.open = w("plan.time.unknownLength");
    return done({ ...(start !== undefined ? { start } : {}), ...(end !== undefined ? { end } : {}), ...(row.cond !== undefined ? { cond: row.cond } : {}), least: end ?? Math.max(least, start ?? 0), causes });
  };

  for (const n of planList(l)) place(n.id, new Set());
  return { rows: planList(l).map((n) => rows.get(n.id)!).filter(Boolean), known: !!estimates };
}

/** What gives a queue no bar of its own: stopped or paused (only the user lifts it), a failed start, a predecessor gone. */
function ownBlock(n: PlanNode): Words | undefined {
  const tone = n.resting?.tone ?? (n.now ? n.status.tone : undefined);
  if (tone === "stopped" || tone === "failed") return w("plan.time.stopped", { label: n.resting?.label ?? n.status.label });
  if (tone === "paused") return w("plan.time.paused", { label: n.resting?.label ?? n.status.label });
  const failed = n.why.find((x) => x.tone === "failed");
  if (failed) return w("plan.time.failed", failed.params);
  const gone = n.why.find((x) => x.tone === "blocked");
  if (gone) return w("plan.time.gone", { what: t(gone.key, gone.params) });
  return undefined;
}

/** The axis's length in ms: a little after the last thing placed; at least three hours. */
export function timeSpan(a: TimeAxis, openMs = 2.5 * 3_600_000): number {
  let last = 0;
  for (const r of a.rows) {
    last = Math.max(last, r.end ?? 0, r.wait?.[1] ?? 0, r.notBefore ?? 0, ...r.marks, r.start !== undefined && r.end === undefined ? r.start + openMs : 0);
  }
  return Math.max(3 * 3_600_000, last + 30 * 60_000);
}

/** The ruler's hours: each whole hour after now (every `every` hours where they would crowd), midnight naming the day. */
export function rulerTicks(now: Date, span: number, pxPerHour: number): { ms: number; day: boolean; hour: number; date: Date }[] {
  const every = [1, 2, 3, 6, 12].find((h) => h * pxPerHour >= 52) ?? 24;
  const first = new Date(now); first.setMinutes(0, 0, 0); first.setHours(first.getHours() + 1);
  const out: { ms: number; day: boolean; hour: number; date: Date }[] = [];
  for (let t = first.getTime(); t - now.getTime() <= span; t += 3_600_000) {
    const d = new Date(t), hour = d.getHours();
    if (hour % every && hour !== 0) continue;
    out.push({ ms: t - now.getTime(), day: hour === 0, hour, date: d });
  }
  return out;
}
