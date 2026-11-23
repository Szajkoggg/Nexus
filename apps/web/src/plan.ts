// The plan as the Queues view shows it (docs/protocol/planning.md, "The plan"): what runs now, then what follows, in columns; lines
// from each queue to those it waits for; on every queue what it waits for. Pure and unit tested; components/Plan.tsx
// draws it (lanes on a desktop, an ordered list on the phone).
import { runGoing } from "@nexus/protocol/status-rules";
import { compareIds } from "@nexus/protocol/ids";
import { formatClock, t, type Key, type Params } from "./i18n.ts";
import { openPlan, queueStatus, type HonestStatus, type QueueLike } from "./queueStatus.ts";

/** What the plan view reads of a queue (a QueueView fits). */
export interface PlanQueue extends Omit<QueueLike, "plan" | "start"> {
  id: string;
  title: string;
  plan?: {
    used: boolean;
    created_at?: string;
    after: readonly { queue: string; by: "user" | "orchestrator"; done: boolean; at?: string; cause?: "stopped" | "cancelled" | "missing" }[];
    /** The orchestrator's proposal to change dependencies the user set, until the user decides. */
    proposal?: { after: readonly string[]; reason: string };
  };
  start?: {
    at?: string; after?: string; usage?: "claude" | "codex"; created_at?: string;
    failed?: { reason: string }; held?: { kind: "approval" | "checkout" | "limit"; reason: string };
  };
  /** Its place in the merge train: it waits for its turn to integrate, after `after`. */
  train?: { after?: string };
}

/** Words for the page, as the reader's language says them (i18n's t). */
export interface Words { key: Key; params?: Params }

/**
 * Why a queue has not started, in a word and its colour (`tone`): its approval, a queue before it stopped or gone, its time, the usage window, its checkout, the limit, a failed start; or that it starts now.
 */
export interface Why extends Words { tone: "approval" | "blocked" | "time" | "usage" | "checkout" | "limit" | "failed" | "ready" }

/** A queue it waits for, as the card names it: who set it ("set by you") and when, done or not. */
interface Before { queue: string; by: "user" | "orchestrator"; done: boolean; at?: string }

export interface PlanNode {
  id: string;
  title: string;
  /**
   * 0: now (at work or waiting for the user; a paused or stopped one with no predecessor shown); 1: next; 2 and on:
   * later.
   */
  column: number;
  /** In progress, in the first column: its honest status says where it stands. */
  now: boolean;
  /**
   * It has started but does not work now (paused, stopped, held) and stands after the queues it waits for: its state
   * in a word, for the card (its honest status may only say "starts after …").
   */
  resting?: { tone: HonestStatus["tone"]; label: string };
  /** In the plan (planned, or a schedule). A queue only some planned queue waits for may not be. */
  planned: boolean;
  status: HonestStatus;
  /** Why it has not started (planned queues): first what only the user can do. In progress: why it waits (the merge train). */
  why: Why[];
  /** The queues it waits for, in its plan's order (an unused plan). */
  before: Before[];
  /** The orchestrator's proposal for it, waiting for the user. */
  proposal?: { after: readonly string[]; reason: string };
  /** The user may move it in the plan: not in progress now. */
  movable: boolean;
  /** It has a place in the plan of its own (plan.yaml, not only a schedule): a predecessor can be added to it. */
  placed: boolean;
}

export interface PlanLayout {
  /** The columns, left to right: now, next, then …; each queue once. */
  columns: PlanNode[][];
  /** A line from a queue (`from`) to one that waits for it (`to`), with who set it. */
  edges: { from: string; to: string; by: "user" | "orchestrator" }[];
  /** Approved queues outside the plan: they wait until someone puts them in it. */
  outside: { id: string; title: string }[];
}

const NOW_STATUS = new Set(["running", "waiting", "paused", "stopped"]);
const ENDED = new Set(["done", "cancelled"]);

/** In progress: at work, waiting for a review or an answer, paused, stopped, or its run holds its checkout. */
export function isNow(q: Pick<PlanQueue, "status" | "run">): boolean {
  if (ENDED.has(q.status)) return false;
  return NOW_STATUS.has(q.status) || runGoing(q.run);
}

/**
 * At work or waiting for the user now: its run goes (not held at the limit), or its honest status is running, a
 * review, or waiting for an answer, a permission or a check decision. A paused, stopped or held queue is not.
 */
export function isActive(q: PlanQueue, now = new Date()): boolean {
  if (ENDED.has(q.status)) return false;
  if (runGoing(q.run) && !q.run?.held) return true;
  const s = queueStatus(q as QueueLike, now);
  return (s.tone === "running" || s.tone === "review" || s.tone === "waiting") && s.says?.key !== "status.heldLimit";
}

/** A started queue's state in a word when it does not work: its honest status if that says it, else "paused". */
function restingOf(q: PlanQueue, s: HonestStatus): { tone: HonestStatus["tone"]; label: string } {
  if (s.tone !== "planned" && s.tone !== "approval") return { tone: s.tone, label: s.label };
  if (s.says?.key === "status.heldCheckout" || s.says?.key === "status.heldLimit") return { tone: "waiting", label: s.label };
  const step = q.current_step ?? q.run?.step;
  return { tone: "paused", label: step ? t("status.withStep", { label: t("status.paused"), step }) : t("status.paused") };
}

/** In the plan: a place that is not used yet (planned and not started since), or a schedule. */
export const isPlanned = (q: Pick<PlanQueue, "plan" | "start" | "status">): boolean =>
  !ENDED.has(q.status) && (!!openPlan(q) || !!q.start);

/** The queues it waits for (an unused plan; a start.yaml from before the plan names one). */
function beforeOf(q: PlanQueue): Before[] {
  const plan = openPlan(q);
  if (plan) return plan.after.map((e) => ({ queue: e.queue, by: e.by, done: e.done, ...(e.at ? { at: e.at } : {}) }));
  return q.start?.after ? [{ queue: q.start.after, by: "user", done: false }] : [];
}

/** Why a planned queue has not started: what the user can do first, then what it waits for. */
export function whyOf(q: PlanQueue, now = new Date()): Why[] {
  const out: Why[] = [];
  if (q.start?.failed) out.push({ key: "plan.why.failed", params: { reason: q.start.failed.reason }, tone: "failed" });
  if (q.approved === false) out.push({ key: "plan.why.approval", params: { revision: q.revision ?? 1 }, tone: "approval" });
  for (const e of openPlan(q)?.after ?? []) {
    if (!e.done && e.cause) out.push({ key: `plan.why.${e.cause}`, params: { queue: e.queue }, tone: "blocked" });
  }
  // The queues it waits for are on the card as they are ("after RN · set by you"); a reason of their own only when
  // nothing else is said.
  const open = beforeOf(q).filter((b) => !b.done);
  if (q.start?.at && !q.start.held) {
    out.push(q.start.usage
      ? { key: "plan.why.usage", params: { time: formatClock(q.start.at, now) }, tone: "usage" }
      : { key: "plan.why.at", params: { time: formatClock(q.start.at, now) }, tone: "time" });
  }
  const held = q.start?.held;
  if (held && held.kind !== "approval") out.push({ key: held.kind === "checkout" ? "plan.why.checkout" : "plan.why.limit", params: { reason: held.reason }, tone: held.kind });
  if (!out.length && !open.length) out.push({ key: "plan.why.ready", tone: "ready" });
  return out;
}

/** Why a queue in progress waits: its turn to integrate (the merge train), after the queue before it. */
function trainWhy(q: PlanQueue): Why[] {
  return q.train?.after ? [{ key: "plan.why.train", params: { queue: q.train.after }, tone: "time" }] : [];
}

/**
 * The plan's layout: the queues at work or waiting for the user in the first column; each planned queue one column
 * right of the latest of the queues it waits for that are shown (those done are not); a queue that has started but
 * does not work now (paused, stopped, held) stands after the queues it waits for the same way, or first when it waits
 * for none shown; a queue only some planned queue waits for (approved but not planned, say) shows too, where it would
 * stand. Within a column the queues follow those they wait for (their average row), then the order they were planned
 * in.
 */
export function planLayout(all: readonly PlanQueue[], now = new Date()): PlanLayout {
  const byId = new Map(all.map((q) => [q.id, q]));
  const shown = new Set<string>();
  for (const q of all) if (isNow(q) || isPlanned(q)) shown.add(q.id);
  // The queues planned queues wait for that are neither done nor shown yet: shown too (they hold the plan).
  for (let grew = true; grew;) {
    grew = false;
    for (const id of [...shown]) {
      for (const b of beforeOf(byId.get(id)!)) {
        const p = byId.get(b.queue);
        if (p && !b.done && !ENDED.has(p.status) && !shown.has(p.id)) { shown.add(p.id); grew = true; }
      }
    }
  }

  const active = new Set([...shown].filter((id) => isActive(byId.get(id)!, now)));
  const column = new Map<string, number>();
  const columnOf = (id: string, path: Set<string>): number => {
    const known = column.get(id);
    if (known !== undefined) return known;
    const q = byId.get(id)!;
    // A started queue that does not work now: first unless it waits for a queue shown.
    let c = isNow(q) ? 0 : 1;
    if (active.has(id)) c = 0;
    else if (!path.has(id)) {
      path.add(id);
      for (const b of beforeOf(q)) if (shown.has(b.queue)) c = Math.max(c, columnOf(b.queue, path) + 1);
      path.delete(id);
    }
    column.set(id, c);
    return c;
  };
  for (const id of shown) columnOf(id, new Set());

  const nodes = new Map<string, PlanNode>();
  for (const id of shown) {
    const q = byId.get(id)!;
    const c = column.get(id)!;
    const n = isNow(q) && c === 0;
    const status = queueStatus(q as QueueLike, now);
    const proposal = openPlan(q)?.proposal;
    nodes.set(id, {
      id, title: q.title, column: c, now: n, planned: isPlanned(q),
      status, why: n ? trainWhy(q) : whyOf(q, now), before: n ? [] : beforeOf(q),
      ...(!n && isNow(q) ? { resting: restingOf(q, status) } : {}),
      ...(proposal ? { proposal } : {}), movable: !n, placed: !n && !!openPlan(q),
    });
  }
  const width = Math.max(0, ...[...nodes.values()].map((n) => n.column)) + 1;
  const columns: PlanNode[][] = Array.from({ length: shown.size ? width : 0 }, () => []);
  const madeAt = (id: string) => byId.get(id)?.plan?.created_at ?? byId.get(id)?.start?.created_at ?? "";
  const row = new Map<string, number>();
  for (let c = 0; c < columns.length; c++) {
    const here = [...nodes.values()].filter((n) => n.column === c);
    const weight = (n: PlanNode) => {
      const rows = n.before.map((b) => row.get(b.queue)).filter((r): r is number => r !== undefined);
      return rows.length ? rows.reduce((a, b) => a + b, 0) / rows.length : Number.MAX_SAFE_INTEGER;
    };
    // In the first column what works or waits for the user comes before what rests there (paused, stopped).
    const resting = (n: PlanNode) => (c === 0 && !active.has(n.id) ? 1 : 0);
    here.sort((a, b) => resting(a) - resting(b) || weight(a) - weight(b) || madeAt(a.id).localeCompare(madeAt(b.id)) || compareIds(a.id, b.id));
    here.forEach((n, i) => row.set(n.id, i));
    columns[c] = here;
  }
  const edges = [...nodes.values()].flatMap((n) => n.before.filter((b) => nodes.has(b.queue)).map((b) => ({ from: b.queue, to: n.id, by: b.by })));
  const outside = all.filter((q) => !shown.has(q.id) && q.status === "approved" && q.approved !== false && !q.run)
    .map((q) => ({ id: q.id, title: q.title }));
  return { columns, edges, outside };
}

/**
 * What the user may move a queue after: every other queue not ended (cancelled ones never come, done ones would start
 * it at once: "first" says that), those in the plan's order first.
 */
export function moveTargets(l: PlanLayout, all: readonly PlanQueue[], queue: string): { id: string; title: string }[] {
  const shown = planList(l).map((n) => n.id);
  return all.filter((q) => q.id !== queue && !ENDED.has(q.status))
    .sort((a, b) => (shown.indexOf(a.id) + 1 || 1e9) - (shown.indexOf(b.id) + 1 || 1e9) || compareIds(a.id, b.id))
    .map((q) => ({ id: q.id, title: q.title }));
}

/** The phone's list: the columns one after another, each in its order. */
export const planList = (l: PlanLayout): PlanNode[] => l.columns.flat();

/** The drawing's sizes in CSS pixels (docs/ux/plan-view-options.md, layout A). */
const PLAN_SIZES = {
  /** Between two columns: the room for the lines' tracks. */
  gap: 36,
  /** The column titles above the boxes. */
  head: 24,
  /** Between two boxes in a column. */
  vgap: 12,
  /** The height of a gap kept free in a column for a line that skips it. */
  slot: 18,
  /** A column's least width; narrower plans scroll sideways. */
  minColumn: 160,
};

export interface PlanBox { left: number; top: number; width: number; height: number }

/** A line from a queue (`from`) to one that waits for it (`to`): its corners, left to right, at right angles. */
interface PlanRoute { key: string; from: string; to: string; by: "user" | "orchestrator"; points: [number, number][] }

export interface PlanDrawing {
  /** Each column's left edge; all are `column` wide. */
  x: number[];
  column: number;
  width: number;
  height: number;
  /** Each queue's box. */
  boxes: Map<string, PlanBox>;
  /** The gaps kept free for the lines that skip a column, by "<from>><to>@<column>". */
  gaps: Map<string, PlanBox>;
  routes: PlanRoute[];
}

/** Two lines closer than this (px) would read as one: ports and tracks keep them apart. */
const APART = 3;

/**
 * Layout A (docs/ux/plan-view-options.md): the columns side by side, each stacked from the top in the plan's order
 * (planLayout's). A line that skips a column passes through a gap kept free for it there, placed before the first
 * queue it would otherwise run beside. A queue's lines leave its right edge and arrive at its left edge at ports
 * 10 px apart, sorted by where they go or come from. Between two columns each line that changes height runs on a
 * vertical track of its own, so no two lines share a stretch and none runs through a box. `heights` are the boxes'
 * heights at the column width the drawing gives (the caller measures them there). A line whose target is not to the
 * right of its source (a cycle) is not drawn: the card's chips still name it.
 */
export function drawPlan(l: PlanLayout, heights: ReadonlyMap<string, number>, width: number, s = PLAN_SIZES): PlanDrawing {
  const n = l.columns.length;
  const column = Math.max(s.minColumn, (width - Math.max(0, n - 1) * s.gap) / Math.max(1, n));
  const x = l.columns.map((_, c) => c * (column + s.gap));
  const col = new Map<string, number>();
  l.columns.forEach((nodes, c) => nodes.forEach((q) => col.set(q.id, c)));
  const h = (id: string) => Math.max(0, heights.get(id) ?? 0);
  const edges = l.edges.filter((e) => col.has(e.from) && col.has(e.to) && col.get(e.from)! < col.get(e.to)!)
    .map((e) => ({ ...e, key: `${e.from}>${e.to}`, c0: col.get(e.from)!, c1: col.get(e.to)! }));

  // The columns, left to right: each gap goes where its line comes from (the height it had in the column before).
  const boxes = new Map<string, PlanBox>(), gaps = new Map<string, PlanBox>();
  const mid = (id: string) => boxes.get(id)!.top + h(id) / 2;
  const gapKey = (key: string, c: number) => `${key}@${c}`;
  const gapMid = (key: string, c: number) => gaps.get(gapKey(key, c))!.top + s.slot / 2;
  let height = s.head;
  l.columns.forEach((nodes, c) => {
    const passing = edges.filter((e) => e.c0 < c && c < e.c1)
      .map((e) => ({ key: e.key, want: e.c0 === c - 1 ? mid(e.from) : gapMid(e.key, c - 1) }))
      .sort((a, b) => a.want - b.want || compareIds(a.key, b.key));
    let y = s.head, qi = 0, gi = 0;
    while (qi < nodes.length || gi < passing.length) {
      const q = nodes[qi], g = passing[gi];
      if (g && (!q || g.want < y + h(q.id))) {
        gaps.set(gapKey(g.key, c), { left: x[c]!, top: y, width: column, height: s.slot });
        y += s.slot + s.vgap; gi++;
      } else if (q) {
        boxes.set(q.id, { left: x[c]!, top: y, width: column, height: h(q.id) });
        y += h(q.id) + s.vgap; qi++;
      }
    }
    height = Math.max(height, y - s.vgap);
  });

  // The heights each line passes at: its port on the source, the gaps' middles, its port on the target.
  const via = (e: (typeof edges)[number]) => Array.from({ length: e.c1 - e.c0 - 1 }, (_, i) => gapMid(e.key, e.c0 + 1 + i));
  const ys = new Map(edges.map((e) => [e.key, [0, ...via(e), 0]]));
  /** The range a line may be moved within at a column: its box's (a port) or its gap's. */
  const room = new Map<string, [number, number]>();
  const ports = (id: string, list: { key: string; toward: number }[], at: (key: string) => number) => {
    list.sort((a, b) => a.toward - b.toward || compareIds(a.key, b.key));
    const b = boxes.get(id)!;
    const step = list.length > 1 ? Math.min(10, Math.max(0, h(id) - 12) / (list.length - 1)) : 0;
    list.forEach((p, i) => {
      const v = ys.get(p.key)!;
      v[at(p.key)] = mid(id) + (i - (list.length - 1) / 2) * step;
      room.set(`${p.key}#${at(p.key)}`, [b.top + 4, b.top + b.height - 4]);
    });
  };
  for (const id of col.keys()) {
    ports(id, edges.filter((e) => e.from === id).map((e) => ({ key: e.key, toward: e.c1 - e.c0 > 1 ? gapMid(e.key, e.c0 + 1) : mid(e.to) })), () => 0);
    ports(id, edges.filter((e) => e.to === id).map((e) => ({ key: e.key, toward: e.c1 - e.c0 > 1 ? gapMid(e.key, e.c1 - 1) : mid(e.from) })), (k) => ys.get(k)!.length - 1);
  }
  for (const e of edges) via(e).forEach((m, i) => room.set(`${e.key}#${i + 1}`, [m - s.slot / 2 + APART, m + s.slot / 2 - APART]));

  // Between two columns: a line arriving at the height another leaves at would share its stretch; it moves within
  // its box or gap. Then each line that changes height gets a track (a vertical run) of its own.
  const tracks = new Map<string, number>();
  for (let g = 0; g + 1 < n; g++) {
    const here = edges.filter((e) => e.c0 <= g && g < e.c1).map((e) => ({ e, i: g - e.c0 }));
    const left = (e: (typeof edges)[number], i: number) => ys.get(e.key)![i]!;
    for (const { e, i } of [...here].sort((a, b) => left(a.e, a.i + 1) - left(b.e, b.i + 1))) {
      const v = ys.get(e.key)!, [lo, hi] = room.get(`${e.key}#${i + 1}`)!;
      const taken = here.filter((o) => o.e !== e).flatMap((o) => [left(o.e, o.i), left(o.e, o.i + 1)]);
      const free = (y: number) => y >= lo && y <= hi && taken.every((t) => Math.abs(t - y) >= APART);
      const y0 = v[i + 1]!;
      for (let d = 0; d <= hi - lo; d += 2) {
        const y = [y0 + d, y0 - d].find(free);
        if (y !== undefined) { v[i + 1] = y; break; }
      }
    }
    const runs = here.filter(({ e, i }) => left(e, i) !== left(e, i + 1))
      .map(({ e, i }) => ({ key: e.key, lo: Math.min(left(e, i), left(e, i + 1)), hi: Math.max(left(e, i), left(e, i + 1)), t: 0 }))
      .sort((a, b) => a.lo - b.lo || compareIds(a.key, b.key));
    const ends: number[] = [];
    for (const r of runs) {
      let t = ends.findIndex((end) => end < r.lo - 2 * APART);
      if (t < 0) { t = ends.length; ends.push(0); }
      ends[t] = r.hi; r.t = t;
    }
    for (const r of runs) tracks.set(`${r.key}@${g}`, x[g]! + column + (s.gap * (r.t + 1)) / (ends.length + 1));
  }

  const routes: PlanRoute[] = edges.map((e) => {
    const v = ys.get(e.key)!, points: [number, number][] = [[x[e.c0]! + column, v[0]!]];
    for (let g = e.c0; g < e.c1; g++) {
      const i = g - e.c0, tx = tracks.get(`${e.key}@${g}`);
      if (tx !== undefined) points.push([tx, v[i]!], [tx, v[i + 1]!]);
      points.push([g + 1 === e.c1 ? x[g + 1]! - 1 : x[g + 1]! + column, v[i + 1]!]);
    }
    return { key: e.key, from: e.from, to: e.to, by: e.by, points };
  });
  return { x, column, width: n ? x[n - 1]! + column : 0, height, boxes, gaps, routes };
}

/** An SVG path through `points` at right angles, its corners rounded (at most `r`, less on a short stretch). */
export function roundedPath(points: readonly (readonly [number, number])[], r = 6): string {
  const p = points.filter((q, i) => i === 0 || q[0] !== points[i - 1]![0] || q[1] !== points[i - 1]![1]);
  if (!p.length) return "";
  let d = `M${p[0]![0]},${p[0]![1]}`;
  for (let i = 1; i < p.length - 1; i++) {
    const [x0, y0] = p[i - 1]!, [x, y] = p[i]!, [x1, y1] = p[i + 1]!;
    const a = Math.min(r, Math.hypot(x - x0, y - y0) / 2, Math.hypot(x1 - x, y1 - y) / 2);
    d += ` L${x - a * Math.sign(x - x0)},${y - a * Math.sign(y - y0)} Q${x},${y} ${x + a * Math.sign(x1 - x)},${y + a * Math.sign(y1 - y)}`;
  }
  return `${d} L${p.at(-1)![0]},${p.at(-1)![1]}`;
}

/**
 * A queue's expected time as the card says it (GET /api/projects/:id/estimates): "about 40 min (estimate)" (to 5
 * minutes), "about 2.5 h (estimate)" (to half an hour under 10 h, whole hours above), "no estimate" while too few steps
 * are finished; nothing when no step is left.
 */
export function estimateWords(e: { steps: number; ms?: number } | undefined): Words | undefined {
  if (!e || !e.steps) return undefined;
  if (e.ms === undefined) return { key: "plan.estimate.none" };
  const minutes = e.ms / 60_000;
  if (minutes < 55) return { key: "plan.estimate.minutes", params: { minutes: Math.max(5, Math.round(minutes / 5) * 5) } };
  const hours = minutes / 60;
  return { key: "plan.estimate.hours", params: { hours: hours < 9.75 ? Math.max(1, Math.round(hours * 2) / 2) : Math.round(hours) } };
}

const nodeOf = (l: PlanLayout, id: string): PlanNode | undefined => l.columns.flat().find((n) => n.id === id);
const names = (ids: readonly string[]) => ids.join(", ");

/**
 * A line's details (a line clicked, or an "after" chip tapped on the phone): which dependency it is, who set it and
 * when, what the queue waits for besides, and its actions: "Remove 'after ST2'" (the dependency named, so it does not
 * read as removing the queue) and, for one the user set, "Let the orchestrator decide" (a hand-back). When nothing else
 * open would be left, it says before the removal that the queue then starts as soon as it may.
 */
export function lineDetails(l: PlanLayout, from: string, to: string, now = new Date()): {
  title: Words; setBy: Words; effect: Words; remove: Words; handBack: boolean; last: boolean;
} | undefined {
  const before = nodeOf(l, to)?.before ?? [];
  const b = before.find((x) => x.queue === from);
  if (!b) return undefined;
  const others = before.filter((x) => x.queue !== from && !x.done);
  const when = b.at ? formatClock(b.at, now) : undefined;
  const setBy: Words = b.by === "user"
    ? (when ? { key: "plan.line.setByYouAt", params: { when } } : { key: "plan.line.setByYou" })
    : (when ? { key: "plan.line.setByOrchestratorAt", params: { when } } : { key: "plan.line.setByOrchestrator" });
  const effect: Words = others.length
    ? { key: "plan.line.effect", params: { queue: to, from, others: others.map((o) => `${o.queue} (${t(o.by === "user" ? "plan.setByYou" : "plan.legend.orchestrator")})`).join(", ") } }
    : { key: "plan.line.last", params: { queue: to, from } };
  return {
    title: { key: "plan.line.title", params: { queue: to, from } }, setBy, effect,
    remove: { key: "plan.line.remove", params: { from } }, handBack: b.by === "user", last: !others.length,
  };
}

/**
 * What dropping `dragged` onto `target` may do: "After ST2 instead of RX" (a move: the dependencies it replaces named,
 * done ones too) and "Also after ST2 (and RX)" (one more predecessor), the latter only for a queue with a place in the
 * plan that does not wait for `target` already. Undefined when it cannot be dropped there.
 */
export function dropChoices(l: PlanLayout, dragged: string, target: string): { instead: Words; also?: Words } | undefined {
  const n = nodeOf(l, dragged);
  if (!n || !n.movable || dragged === target) return undefined;
  const replaced = n.before.filter((b) => b.queue !== target).map((b) => b.queue);
  const instead: Words = replaced.length ? { key: "plan.drop.instead", params: { queue: target, replaced: names(replaced) } } : { key: "plan.drop.after", params: { queue: target } };
  if (!n.placed || n.before.some((b) => b.queue === target)) return { instead };
  const open = n.before.filter((b) => !b.done).map((b) => b.queue);
  return { instead, also: open.length ? { key: "plan.drop.alsoAnd", params: { queue: target, others: names(open) } } : { key: "plan.drop.also", params: { queue: target } } };
}

/** What the undo bar says a change did: a move (after `target`, or first), an added or a removed predecessor. */
export function changeWords(c: { kind: "move" | "add" | "remove"; queue: string; target: string | null; replaced?: readonly string[] }): Words {
  if (c.kind === "add") return { key: "plan.change.add", params: { queue: c.queue, target: c.target ?? "" } };
  if (c.kind === "remove") return { key: "plan.change.remove", params: { queue: c.queue, target: c.target ?? "" } };
  if (!c.target) return { key: "plan.change.first", params: { queue: c.queue } };
  const replaced = (c.replaced ?? []).filter((x) => x !== c.target);
  return replaced.length ? { key: "plan.change.moveInstead", params: { queue: c.queue, target: c.target, replaced: names(replaced) } } : { key: "plan.change.move", params: { queue: c.queue, target: c.target } };
}

/** How long the undo bar offers Undo (the server takes it 2 s longer: scheduler.ts UNDO_MS). */
export const UNDO_SHOWN_MS = 10_000;
