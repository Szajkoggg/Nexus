// The plan as the Queues view shows it (docs/protocol/planning.md, "The plan"): what runs now, then what follows, in columns; lines
// from each queue to those it waits for; on every queue what it waits for. Pure and unit tested; components/Plan.tsx
// draws it (lanes on a desktop, an ordered list on the phone).
import { runGoing } from "@nexus/protocol/status-rules";
import { compareIds } from "@nexus/protocol/ids";
import { renamedTag } from "@nexus/protocol/tags";
import type { TagsFile } from "@nexus/protocol";
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

/** What the lanes read of a queue (a QueueView fits): its own area, and its steps' (their own over the queue's, renamed). */
export interface LaneQueue {
  id: string;
  area?: string;
  steps: readonly { id: string; status: string; closing?: boolean; integration?: boolean; tags?: { area?: string } }[];
}

/** The project's tag lists as the lanes read them (.nexus/tags.yaml): its areas in the user's order, its renames. */
export interface LaneTags { areas: readonly string[]; renames: TagsFile["renames"] }

/** A lane: an area (none: "No area") and its queues in the plan's order. */
export interface Lane { area?: string; ids: string[] }

export interface AreaLanes {
  lanes: Lane[];
  /** A queue's steps left in other areas than its lane's, by area in the order its steps come. */
  also: Map<string, { area: string; steps: string[] }[]>;
}

const CLOSED_STEP = new Set(["done", "skipped", "rejected"]);

/** The steps still to come: not done, skipped or rejected. */
export const stepsLeftOf = <S extends { status: string }>(steps: readonly S[]): S[] => steps.filter((s) => !CLOSED_STEP.has(s.status));

/** A queue's own steps (not Nexus's closing or integration step) that are left: the steps its lane is chosen by. */
function stepsLeft(q: LaneQueue) {
  const own = q.steps.filter((s) => !s.closing && !s.integration);
  const left = stepsLeftOf(own);
  return left.length ? left : own;
}

/**
 * A queue's lane (docs/ux/plan-view-modes.md, "Lanes by area"): its own area tag; without one, the area most of its steps
 * left carry (a tie: the first such step's); with none at all, none ("No area"). Renamed areas read as their new name.
 */
export function areaOf(q: LaneQueue, renames: TagsFile["renames"]): string | undefined {
  if (q.area) return renamedTag(q.area, renames);
  const count = new Map<string, number>();
  for (const s of stepsLeft(q)) if (s.tags?.area) { const a = renamedTag(s.tags.area, renames); count.set(a, (count.get(a) ?? 0) + 1); }
  let best: string | undefined, most = 0;
  for (const [a, n] of count) if (n > most) { best = a; most = n; }
  return best;
}

/**
 * The plan in lanes by area: each shown queue in exactly one lane, in the plan's order (planList: the columns, each in
 * its order); the lanes in the project's area list's order, then the areas not in it by name, "No area" last; an
 * empty lane is not drawn. A queue's steps left in another area are named (`also`), not drawn twice.
 */
export function areaLanes(l: PlanLayout, queues: readonly LaneQueue[], tags: LaneTags): AreaLanes {
  const byId = new Map(queues.map((q) => [q.id, q]));
  const lanes = new Map<string | undefined, string[]>();
  const also = new Map<string, { area: string; steps: string[] }[]>();
  for (const n of planList(l)) {
    const q = byId.get(n.id);
    const area = q ? areaOf(q, tags.renames) : undefined;
    lanes.set(area, [...(lanes.get(area) ?? []), n.id]);
    const other = new Map<string, string[]>();
    for (const s of q ? stepsLeft(q) : []) {
      const a = s.tags?.area ? renamedTag(s.tags.area, tags.renames) : undefined;
      if (a && a !== area) other.set(a, [...(other.get(a) ?? []), s.id]);
    }
    if (other.size) also.set(n.id, [...other].map(([a, steps]) => ({ area: a, steps })));
  }
  const listed = tags.areas.map((a) => renamedTag(a, tags.renames));
  const place = (a: string | undefined) => (a === undefined ? 2e9 : listed.includes(a) ? listed.indexOf(a) : 1e9);
  const order = [...lanes.keys()].sort((a, b) => place(a) - place(b) || (a ?? "").localeCompare(b ?? ""));
  return { lanes: order.map((area) => ({ ...(area !== undefined ? { area } : {}), ids: lanes.get(area)! })), also };
}

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
  /** Lanes: the room left of the columns for each lane's name (written upwards). */
  gutter: 30,
  /** Lanes: inside a lane, above and below its boxes. */
  pad: 10,
  /** Lanes: between two lanes. */
  laneGap: 8,
};

/** The lanes to draw the plan in (areaLanes): each lane's queues, and the least height each needs (its name's). */
export interface PlanBands { lanes: readonly (readonly string[])[]; min?: readonly number[] }

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
  /** Lanes: each lane's top and bottom (none without lanes). */
  bands: { top: number; bottom: number }[];
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
 *
 * With `bands` (lanes by area) the columns stay, but each lane is a band of its own across them, one under another, its
 * name in the gutter left of the first column: a column's queues of a lane stack inside the lane, and a line that
 * skips a column passes it in its target's lane. A line from one lane to another changes height in the gaps between
 * the columns, so it never crosses a box or a lane's name.
 */
export function drawPlan(l: PlanLayout, heights: ReadonlyMap<string, number>, width: number, s = PLAN_SIZES, bands?: PlanBands): PlanDrawing {
  const n = l.columns.length;
  const left = bands ? s.gutter : 0;
  const column = Math.max(s.minColumn, (width - left - Math.max(0, n - 1) * s.gap) / Math.max(1, n));
  const x = l.columns.map((_, c) => left + c * (column + s.gap));
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
  // Without lanes, one band of every queue. A queue in no lane given goes in a last one (so every queue has a box).
  const given = bands ? bands.lanes.map((ids) => ids.filter((id) => col.has(id))) : [[...col.keys()]];
  const inLane = new Map<string, number>();
  given.forEach((ids, b) => ids.forEach((id) => { if (!inLane.has(id)) inLane.set(id, b); }));
  const rest = [...col.keys()].filter((id) => !inLane.has(id));
  if (rest.length) { rest.forEach((id) => inLane.set(id, given.length)); given.push(rest); }
  /** Where a gap wants to be when its line comes from a lane not placed yet (one below): after the lane's boxes. */
  const BELOW = 1e9;
  let height = s.head, top = s.head;
  const laneBoxes: { top: number; bottom: number }[] = [];
  given.forEach((_, b) => {
    const y0 = top + (bands ? s.pad : 0);
    let bottom = y0;
    l.columns.forEach((all, c) => {
      const nodes = all.filter((q) => inLane.get(q.id) === b);
      const passing = edges.filter((e) => e.c0 < c && c < e.c1 && inLane.get(e.to) === b)
        .map((e) => ({ key: e.key, want: e.c0 === c - 1 ? (boxes.has(e.from) ? mid(e.from) : BELOW) : gapMid(e.key, c - 1) }))
        .sort((a, b) => a.want - b.want || compareIds(a.key, b.key));
      let y = y0, qi = 0, gi = 0;
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
      if (y > y0) bottom = Math.max(bottom, y - s.vgap);
      if (!bands) height = Math.max(height, y - s.vgap);
    });
    if (bands) {
      const end = Math.max(bottom + s.pad, top + (bands.min?.[b] ?? 0));
      laneBoxes.push({ top, bottom: end });
      height = end;
      top = end + s.laneGap;
    }
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
  return { x, column, width: n ? x[n - 1]! + column : 0, height, boxes, gaps, routes, bands: laneBoxes };
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

// ---------------------------------------------------------------- where the plan will wait for the user's review

/** The estimates by queue (GET /estimates): each queue's steps left and their expected work. */
export type Estimates = Readonly<Record<string, { steps: number; ms?: number }>>;

/** Who reviews: whether the project's orchestrator takes reviews (it exists, its notices on), and away mode now. */
export interface ReviewWho { orchestrating: boolean; away: boolean }

/** A queue's steps as the review points read them (a QueueView fits). */
export interface ReviewQueue { id: string; steps: readonly { id: string; title?: string; status: string; level?: number; review_with?: string }[] }

/**
 * The step will surely wait for the user's review (docs/protocol/review.md, "Review"): level 1; any level when no
 * orchestrator takes reviews (they go to the user). A level-2 step goes to the orchestrator, which may or may not hand
 * it on; in away mode it runs as level 3 and goes on: neither is a sure wait.
 */
export function userReviews(level: number | undefined, who: ReviewWho): boolean {
  if (!who.orchestrating) return true;
  return level === 1;
}

/** The steps of a queue still to come that wait for the user's review, and how many steps are left up to the next. */
export interface UserReviews {
  count: number;
  next: { id: string; title?: string };
  /** The next already waits for the user's review. */
  waiting: boolean;
  /** The steps left up to and with the next (its own work included), of `left`. */
  upTo: number;
  left: number;
}

/**
 * A step left waits for the user's review: one in review for the user does, one in review for the orchestrator does
 * not (it is the orchestrator's now); the others by their level (the step's own, its queue's, the project's: the state
 * derives it), as `userReviews` says.
 */
export const waitsForUser = (s: ReviewQueue["steps"][number], who: ReviewWho): boolean =>
  s.status === "review" ? s.review_with !== "orchestrator" : userReviews(s.level, who);

/** The steps left in a queue (not done, skipped or rejected) that wait for the user's review (`waitsForUser`). */
export function userReviewsOf(q: ReviewQueue, who: ReviewWho): UserReviews | undefined {
  const left = stepsLeftOf(q.steps);
  const mine = left.filter((s) => waitsForUser(s, who));
  const next = mine[0];
  if (!next) return undefined;
  return {
    count: mine.length, next: { id: next.id, ...(next.title ? { title: next.title } : {}) }, waiting: next.status === "review",
    upTo: left.indexOf(next) + 1, left: left.length,
  };
}

/** The first point where the plan will wait for the user's review, and when, by the estimates (ms from now). */
export interface FirstWait { queue: string; step: string; title?: string; now: boolean; ms?: number }

/**
 * The first point where the plan will wait for the user's review: of each queue's next such step, the earliest by the
 * estimates when every one has a time (the plan's order among equal ones), else the first in the plan's order
 * (planList). One waiting now has the time 0. A step's time from now, as far as the estimates go: its queue starts when
 * the latest of its predecessors shown ends (the first column now), then its steps up to that one (the queue's
 * estimate shared evenly over its steps left); none when an estimate on the way is missing.
 */
export function firstUserWait(l: PlanLayout, queues: readonly ReviewQueue[], who: ReviewWho, estimates?: Estimates): FirstWait | undefined {
  const byId = new Map(queues.map((q) => [q.id, q]));
  const nodes = new Map(planList(l).map((n) => [n.id, n]));
  const starts = new Map<string, number | undefined>();
  const startOf = (id: string, path: Set<string>): number | undefined => {
    if (starts.has(id)) return starts.get(id);
    const n = nodes.get(id);
    let at: number | undefined = 0;
    if (n && n.column > 0 && !path.has(id)) {
      path.add(id);
      for (const b of n.before) {
        if (b.done || !nodes.has(b.queue)) continue;
        const s = startOf(b.queue, path), e = estimates?.[b.queue];
        const end = s === undefined ? undefined : !e?.steps ? s : e.ms === undefined ? undefined : s + e.ms;
        at = at === undefined || end === undefined ? undefined : Math.max(at, end);
      }
      path.delete(id);
    }
    starts.set(id, at);
    return at;
  };
  const points: FirstWait[] = [];
  for (const n of planList(l)) {
    const q = byId.get(n.id);
    const r = q && userReviewsOf(q, who);
    if (!r) continue;
    const base = { queue: n.id, step: r.next.id, ...(r.next.title ? { title: r.next.title } : {}) };
    if (r.waiting) { points.push({ ...base, now: true, ms: 0 }); continue; }
    const start = startOf(n.id, new Set()), e = estimates?.[n.id];
    const ms = start === undefined || e?.ms === undefined || !e.steps ? undefined : Math.round(start + (e.ms * r.upTo) / Math.max(1, e.steps));
    points.push({ ...base, now: false, ...(ms !== undefined ? { ms } : {}) });
  }
  if (!points.every((p) => p.ms !== undefined)) return points[0];
  return points.reduce<FirstWait | undefined>((a, p) => (!a || p.ms! < a.ms! ? p : a), undefined);
}

// ---------------------------------------------------------------- the marks: critical path, what blocks
// docs/ux/plan-view-modes.md (queue PVA): highlights on the plan as it is laid out; they move no queue and write nothing.

/**
 * A queue's expected work in ms from the estimates; undefined: not known (no estimates, or none for it; never 0 for a
 * missing estimate). No step left: none to do.
 */
export function workOf(id: string, estimates: Estimates | undefined): number | undefined {
  const e = estimates?.[id];
  if (!e) return undefined;
  return e.steps ? e.ms : 0;
}

/** Two totals within a minute are as long as each other (the estimates are rounder than that). */
const TIE_MS = 60_000;

export interface CriticalPath {
  /** The chain, first to last: each waits for the one before. */
  path: string[];
  /** Its work by the estimates, in ms. */
  ms: number;
  /** How many other chains are as long (to the minute). */
  ties: number;
  /** Shown queues without an estimate: chains through them are not compared. */
  unknown: string[];
}

/**
 * The critical path (docs/ux/plan-view-modes.md, "Critical path"): of the chains along the plan's lines (each queue
 * waiting for the one before), the one whose work adds up to the most by the estimates. Not the run order: reviews,
 * approvals, the limit, checkouts and the usage window are not in it. A tie goes to the chain whose last queue comes
 * first in the plan's order (then whose earlier queues do). A queue without an estimate counts as no time known: a chain
 * through it is not compared (it starts again after it), and it is named in `unknown`. A loop (refused in the files,
 * possible in damaged ones) is cut where it closes. Undefined when no chain has a known length.
 */
export function criticalPath(l: PlanLayout, estimates: Estimates): CriticalPath | undefined {
  const order = planList(l).map((n) => n.id);
  const rank = new Map(order.map((id, i) => [id, i]));
  const preds = new Map<string, string[]>(order.map((id) => [id, []]));
  for (const e of l.edges) if (rank.has(e.from) && rank.has(e.to) && e.from !== e.to) preds.get(e.to)!.push(e.from);
  for (const p of preds.values()) p.sort((a, b) => rank.get(a)! - rank.get(b)!);
  const dist = new Map<string, number | undefined>(), from = new Map<string, string>(), tiesAt = new Map<string, number>();
  const visiting = new Set<string>();
  const d = (id: string): number | undefined => {
    if (dist.has(id)) return dist.get(id);
    if (visiting.has(id)) return undefined; // a loop: cut here
    visiting.add(id);
    const w = workOf(id, estimates);
    let best: number | undefined, ties = 0;
    for (const p of preds.get(id) ?? []) {
      const v = d(p);
      if (v === undefined) continue;
      if (best === undefined || v > best + TIE_MS) { best = v; from.set(id, p); ties = 0; } else if (Math.abs(v - best) <= TIE_MS) ties++;
    }
    visiting.delete(id);
    const out = w === undefined ? undefined : w + (best ?? 0);
    if (w === undefined) from.delete(id);
    dist.set(id, out);
    tiesAt.set(id, ties);
    return out;
  };
  order.forEach(d);
  let end: string | undefined, endTies = 0;
  for (const id of order) {
    const v = dist.get(id);
    if (v === undefined) continue;
    const best = end === undefined ? undefined : dist.get(end)!;
    if (best === undefined || v > best + TIE_MS) { end = id; endTies = 0; } else if (Math.abs(v - best) <= TIE_MS) endTies++;
  }
  if (end === undefined) return undefined;
  const path = [end];
  while (from.has(path[0]!) && !path.includes(from.get(path[0]!)!)) path.unshift(from.get(path[0]!)!);
  const ties = endTies + path.reduce((a, id) => a + (tiesAt.get(id) ?? 0), 0);
  return { path, ms: dist.get(end)!, ties, unknown: order.filter((id) => workOf(id, estimates) === undefined) };
}

/** Why a queue waits for the user now: what its button opens. */
export type RootKind = "review" | "question" | "approval" | "failed" | "stopped" | "paused" | "blocked";

/** A queue that waits for the user now, and the item its button opens (the step, the question, else the queue). */
export interface BlockRoot { queue: string; kind: RootKind; step?: string; qid?: string }

export interface Blocks {
  /** What waits for the user now, in the plan's order. */
  roots: BlockRoot[];
  /** The queues held up by the roots (each with the roots it waits for, in the plan's order); a root held by another is here too. */
  held: Map<string, string[]>;
  /** Queues that wait by themselves (the usage window, a time, a checkout, the limit, the merge train) and hold others up. */
  byItself: string[];
}

/** What the roots read of a queue (a QueueView fits). */
export interface BlockQueue extends PlanQueue {
  steps: readonly { id: string; status: string; review_with?: "orchestrator" | "user" }[];
  questions: readonly { qid?: string; state: string; can_continue: boolean; step?: string }[];
}

/**
 * What blocks (docs/ux/plan-view-modes.md, "What blocks"): the shown queues that wait for the user now (a step in the
 * user's review, an open question, a permission or a check decision, its approval, a failed start, a stop, a pause, a
 * predecessor cancelled or gone), what each holds up along the plan's lines, and the queues that wait by themselves
 * (they end without the user) while holding others up.
 */
export function whatBlocks(l: PlanLayout, queues: readonly BlockQueue[], now = new Date()): Blocks {
  const byId = new Map(queues.map((q) => [q.id, q]));
  const nodes = planList(l);
  const roots: BlockRoot[] = [];
  for (const n of nodes) {
    const q = byId.get(n.id);
    if (!q || ENDED.has(q.status)) continue;
    const review = q.steps.find((s) => s.status === "review" && s.review_with !== "orchestrator");
    const question = q.questions.find((x) => x.state === "open" || x.state === "escalated");
    const waiting = q.steps.find((s) => s.status === "waiting");
    const s = queueStatus(q as QueueLike, now);
    const root: BlockRoot | undefined =
      review ? { queue: n.id, kind: "review", step: review.id }
      : question ? { queue: n.id, kind: "question", ...(question.step ? { step: question.step } : {}), ...(question.qid && question.step ? { qid: question.qid } : {}) }
      : waiting ? { queue: n.id, kind: "question", step: waiting.id }
      : q.approved === false ? { queue: n.id, kind: "approval" }
      : q.start?.failed || s.tone === "failed" ? { queue: n.id, kind: "failed" }
      : q.status === "stopped" ? { queue: n.id, kind: "stopped" }
      : s.tone === "paused" || n.resting?.tone === "paused" ? { queue: n.id, kind: "paused" }
      : n.why.some((w) => w.tone === "blocked" && w.key !== "plan.why.stopped") ? { queue: n.id, kind: "blocked" }
      : undefined;
    if (root) roots.push(root);
  }
  const next = new Map<string, string[]>();
  for (const e of l.edges) (next.get(e.from) ?? next.set(e.from, []).get(e.from)!).push(e.to);
  const held = new Map<string, string[]>();
  for (const r of roots) {
    const seen = new Set<string>([r.queue]);
    const walk = [r.queue];
    while (walk.length) {
      for (const to of next.get(walk.pop()!) ?? []) {
        if (seen.has(to)) continue;
        seen.add(to); walk.push(to);
        (held.get(to) ?? held.set(to, []).get(to)!).push(r.queue);
      }
    }
  }
  const isRoot = new Set(roots.map((r) => r.queue));
  const byItself = nodes.filter((n) => !isRoot.has(n.id) && next.has(n.id) && (
    (n.now && n.status.tone === "waiting") || n.why.some((w) => w.tone === "time" || w.tone === "usage" || w.tone === "checkout" || w.tone === "limit")
    || n.resting?.tone === "waiting")).map((n) => n.id);
  return { roots, held, byItself };
}

/** A mark on the plan: none or one at a time (docs/ux/plan-view-modes.md, "The switcher"). */
export type PlanMark = "critical" | "blocked";

/** Where the dashboard keeps a project's mark: the browser's storage, never the project's files. */
export const markStoreKey = (project: string): string => `nexus.plan.mark.${project}`;

/** The mark shown: the one chosen, while it can work (the critical path needs estimates; what blocks, a root). */
export function shownMark(chosen: string | null | undefined, can: Readonly<Record<PlanMark, boolean>>): PlanMark | undefined {
  return (chosen === "critical" || chosen === "blocked") && can[chosen] ? chosen : undefined;
}

/** A view of the plan: its layout (a mark highlights on whichever is shown). */
export type PlanViewKind = "columns" | "lanes" | "time";

/** Where the browser keeps a project's view (docs/ux/plan-view-modes.md: the device's, not the project's files). */
export const viewStoreKey = (project: string): string => `nexus.plan.view.${project}`;

/** The view shown: the one chosen if there is such a view, else the base view (Columns). */
export const shownView = (chosen: string | null | undefined): PlanViewKind => (chosen === "lanes" || chosen === "time" ? chosen : "columns");

/** How a mark draws a queue: on the path, a root, held up, dimmed; and a line: lit (on the path, or held) or dimmed. */
export interface MarkLook {
  card: (id: string) => "path" | "root" | "held" | "dim";
  edge: (from: string, to: string) => "path" | "lit" | "dim";
}

export function markLook(mark: PlanMark, cp: CriticalPath | undefined, b: Blocks): MarkLook {
  if (mark === "critical") {
    const on = new Set(cp?.path ?? []);
    const next = new Map((cp?.path ?? []).map((id, i, p) => [id, p[i + 1]]));
    return { card: (id) => (on.has(id) ? "path" : "dim"), edge: (from, to) => (next.get(from) === to ? "path" : "dim") };
  }
  const roots = new Set(b.roots.map((r) => r.queue));
  return {
    card: (id) => (roots.has(id) ? "root" : b.held.has(id) ? "held" : "dim"),
    edge: (from, to) => ((roots.has(from) || b.held.has(from)) && b.held.has(to) ? "lit" : "dim"),
  };
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
