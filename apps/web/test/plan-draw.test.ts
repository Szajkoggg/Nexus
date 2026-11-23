// Layout A of the plan view (src/plan.ts drawPlan): the boxes where planLayout orders them, a gap kept free in each
// column a line skips, and lines at right angles that never run through a box nor along another line. Checked on
// Nexus's own plan (scripts/capture/seed-plan-nexus.ts) and on many random plans.
import { test } from "node:test";
import assert from "node:assert/strict";
import { drawPlan, planLayout, roundedPath, type PlanBox, type PlanDrawing, type PlanLayout, type PlanQueue } from "../src/plan.ts";

const q = (id: string, over: Partial<PlanQueue> = {}): PlanQueue => ({ id, title: `Queue ${id}`, status: "approved", steps: [], questions: [], approved: true, revision: 1, ...over });
const planned = (minutesAgo: number, ...entries: [string, "user" | "orchestrator"][]): NonNullable<PlanQueue["plan"]> =>
  ({ used: false, created_at: new Date(Date.UTC(2026, 10, 15, 12) - minutesAgo * 60_000).toISOString(), after: entries.map(([queue, by]) => ({ queue, by, done: false })) });

/** Nexus's own plan, as scripts/capture/seed-plan-nexus.ts seeds it. */
const NEXUS: PlanQueue[] = [
  q("FB", { status: "done" }), q("PW", { status: "done" }), q("MT", { status: "done" }),
  q("MX", { status: "running", run: { state: "running" } }),
  q("ST2", { status: "waiting" }),
  q("PL", { run: { state: "usage_wait" } }),
  q("RX", { plan: planned(300, ["MX", "orchestrator"]) }),
  q("IO", { plan: planned(280, ["PL", "user"]) }),
  q("CH", { plan: { ...planned(260), after: [{ queue: "PW", by: "orchestrator", done: true }] } }),
  q("NB", { start: { at: "2026-11-15T22:00:00", created_at: "2026-11-15T08:00:00Z" } }),
  q("ST3", { plan: planned(220, ["RX", "orchestrator"], ["ST2", "user"]) }),
  q("TS", { plan: planned(200, ["RX", "orchestrator"]) }),
  q("LG", { plan: { ...planned(180, ["CH", "orchestrator"]), after: [{ queue: "CH", by: "orchestrator", done: false }, { queue: "MT", by: "user", done: true }] } }),
  q("DG", { plan: planned(160, ["ST3", "orchestrator"], ["IO", "user"]) }),
  q("RA", { plan: planned(140, ["LG", "orchestrator"], ["MX", "orchestrator"]) }),
];

type Seg = { a: [number, number]; b: [number, number] };
const segments = (points: [number, number][]): Seg[] => points.slice(1).map((b, i) => ({ a: points[i]!, b }));

/** A segment (at right angles) with a stretch inside the box shrunk by a pixel, as scripts/capture/faults.ts judges. */
function through(s: Seg, r: PlanBox): boolean {
  const [l, t, rt, bt] = [r.left + 1, r.top + 1, r.left + r.width - 1, r.top + r.height - 1];
  const [x0, x1] = [Math.min(s.a[0], s.b[0]), Math.max(s.a[0], s.b[0])], [y0, y1] = [Math.min(s.a[1], s.b[1]), Math.max(s.a[1], s.b[1])];
  return x0 < rt && x1 > l && y0 < bt && y1 > t;
}

/** Two segments running along each other: parallel, under 2 px apart, sharing more than a pixel of length. */
function along(s: Seg, u: Seg): boolean {
  const hs = s.a[1] === s.b[1], hu = u.a[1] === u.b[1];
  if (hs !== hu) return false;
  const k = hs ? 1 : 0, o = hs ? 0 : 1;
  if (Math.abs(s.a[k] - u.a[k]) >= 2) return false;
  const shared = Math.min(Math.max(s.a[o], s.b[o]), Math.max(u.a[o], u.b[o])) - Math.max(Math.min(s.a[o], s.b[o]), Math.min(u.a[o], u.b[o]));
  return shared > 1;
}

/** Every fault of a drawing, as text: lines through boxes, lines along each other, boxes overlapping, a slanted stretch. */
function faults(d: PlanDrawing): string[] {
  const out: string[] = [];
  const boxes = [...d.boxes];
  for (const r of d.routes) {
    for (const s of segments(r.points)) {
      if (s.a[0] !== s.b[0] && s.a[1] !== s.b[1]) out.push(`${r.key} slants`);
      for (const [id, b] of boxes) if (through(s, b)) out.push(`${r.key} runs through ${id}`);
    }
  }
  d.routes.forEach((r, i) => d.routes.slice(i + 1).forEach((u) => {
    if (segments(r.points).some((s) => segments(u.points).some((v) => along(s, v)))) out.push(`${r.key} runs along ${u.key}`);
  }));
  const all = [...boxes, ...d.gaps];
  all.forEach(([a, x], i) => all.slice(i + 1).forEach(([b, y]) => {
    if (Math.min(x.left + x.width, y.left + y.width) > Math.max(x.left, y.left) && Math.min(x.top + x.height, y.top + y.height) > Math.max(x.top, y.top)) out.push(`${a} overlaps ${b}`);
  }));
  return out;
}

const ids = (l: PlanLayout) => l.columns.map((c) => c.map((n) => n.id));
/** The boxes of each column, top to bottom. */
const stacked = (l: PlanLayout, d: PlanDrawing) => l.columns.map((c) => c.map((n) => n.id).sort((a, b) => d.boxes.get(a)!.top - d.boxes.get(b)!.top));

test("Nexus's plan: today's columns and order, a gap in each column a line skips, placed where the line comes from", () => {
  const l = planLayout(NEXUS);
  assert.deepEqual(ids(l), [["MX", "PL", "ST2"], ["RX", "IO", "CH", "NB"], ["TS", "ST3", "LG"], ["DG", "RA"]]);
  const d = drawPlan(l, new Map(l.columns.flat().map((n) => [n.id, 100])), 788);
  assert.deepEqual(stacked(l, d), ids(l), "the order is planLayout's");
  l.columns.forEach((c, i) => c.forEach((n) => assert.equal(d.boxes.get(n.id)!.left, d.x[i])));
  assert.equal(d.column, (788 - 3 * 36) / 4);
  // As the mockup has it (docs/ux/mockups/plan-mock.js, A_COLUMNS): MX > RA at the top of Next and Then, ST2 > ST3
  // before CH, IO > DG before ST3.
  const order = (c: number) => [...l.columns[c]!.map((n) => [n.id, d.boxes.get(n.id)!.top] as const),
    ...[...d.gaps].filter(([k]) => k.endsWith(`@${c}`)).map(([k, b]) => [k.split("@")[0]!, b.top] as const)]
    .sort((a, b) => a[1] - b[1]).map(([k]) => k);
  assert.deepEqual(order(1), ["MX>RA", "RX", "IO", "ST2>ST3", "CH", "NB"]);
  assert.deepEqual(order(2), ["MX>RA", "TS", "IO>DG", "ST3", "LG"]);
  assert.deepEqual(faults(d), []);
});

test("Nexus's plan with boxes of different heights, at several widths: no line through a box, none along another", () => {
  const l = planLayout(NEXUS);
  const nodes = l.columns.flat();
  for (const width of [640, 788, 1160]) {
    for (let k = 0; k < 6; k++) {
      const d = drawPlan(l, new Map(nodes.map((n, i) => [n.id, 56 + ((i * 37 + k * 53) % 90)])), width);
      assert.deepEqual(faults(d), [], `width ${width}, heights ${k}`);
      assert.deepEqual(stacked(l, d), ids(l));
    }
  }
});

test("a line that skips a column runs through its gap, not under a box", () => {
  // The fault seen in the built view: ST2 > ST3 drawn across RX's box.
  const l = planLayout([
    q("A", { status: "running", run: { state: "running" } }),
    q("B", { status: "running", run: { state: "running" } }),
    q("C", { plan: planned(30, ["A", "user"]) }),
    q("D", { plan: planned(20, ["C", "user"], ["B", "user"]) }),
  ]);
  assert.deepEqual(ids(l), [["A", "B"], ["C"], ["D"]]);
  const d = drawPlan(l, new Map([["A", 80], ["B", 80], ["C", 200], ["D", 80]]), 600);
  const gap = d.gaps.get("B>D@1")!;
  const line = d.routes.find((r) => r.key === "B>D")!;
  const inColumn = segments(line.points).filter((s) => s.a[0] <= d.x[1]! + 1 && s.b[0] >= d.x[1]! + d.column - 1);
  assert.equal(inColumn.length, 1, "it crosses the middle column in one straight stretch");
  assert.ok(inColumn[0]!.a[1] > gap.top && inColumn[0]!.a[1] < gap.top + gap.height, "inside its gap");
  assert.ok(gap.top + gap.height < d.boxes.get("C")!.top, "above C: B's line would run beside C, so C moves down");
  assert.deepEqual(faults(d), []);
  // Today's line, straight from B to D, is a fault here: the check sees it.
  const b = d.boxes.get("B")!, e = d.boxes.get("D")!;
  const straight = { ...line, points: [[b.left + b.width, b.top + 40], [e.left - 1, b.top + 40]] as [number, number][] };
  assert.deepEqual(faults({ ...d, routes: [straight] }), ["B>D runs through C"]);
});

test("random plans: the order is planLayout's and the drawing has no fault", () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  let skipping = 0;
  for (let k = 0; k < 300; k++) {
    const now = 1 + Math.floor(rnd() * 3), more = 2 + Math.floor(rnd() * 10);
    const all: PlanQueue[] = [];
    for (let i = 0; i < now; i++) all.push(q(`N${i}`, { status: "running", run: { state: "running" } }));
    for (let i = 0; i < more; i++) {
      const before = all.filter(() => rnd() < 0.3).slice(0, 3).map((p) => [p.id, rnd() < 0.5 ? "user" : "orchestrator"] as [string, "user" | "orchestrator"]);
      all.push(q(`P${i}`, { plan: planned(500 - i, ...before) }));
    }
    const l = planLayout(all);
    const d = drawPlan(l, new Map(l.columns.flat().map((n) => [n.id, 50 + Math.floor(rnd() * 120)])), 500 + Math.floor(rnd() * 900));
    assert.deepEqual(faults(d), [], `plan ${k}`);
    assert.deepEqual(stacked(l, d), ids(l), `plan ${k}`);
    skipping += d.gaps.size;
  }
  assert.ok(skipping > 100, `lines skip columns in the random plans (${skipping} gaps)`);
});

test("the path: corners rounded, less on a short stretch; nothing for no points", () => {
  assert.equal(roundedPath([[0, 0], [20, 0], [20, 30], [40, 30]]), "M0,0 L14,0 Q20,0 20,6 L20,24 Q20,30 26,30 L40,30");
  assert.equal(roundedPath([[0, 0], [4, 0], [4, 30]]), "M0,0 L2,0 Q4,0 4,2 L4,30");
  assert.equal(roundedPath([]), "");
});

// ---------------------------------------------------------------- lanes by area (PVA3)

/** Nexus's plan in its lanes, as docs/ux/mockups/26-plan-modes.html?m=lanes draws them. */
const NEXUS_LANES = [["PL", "ST2", "IO", "ST3", "LG", "DG"], ["MX", "RX", "TS"], ["CH", "RA"], ["NB"]];

/** What lanes add to the faults: a box outside its lane, lanes overlapping, a line in the gutter (the lanes' names), a line not drawn. */
function laneFaults(l: PlanLayout, d: PlanDrawing, lanes: readonly (readonly string[])[], gutter = 30): string[] {
  const out = faults(d);
  lanes.forEach((ids, i) => {
    const b = d.bands[i]!;
    for (const id of ids) {
      const x = d.boxes.get(id)!;
      if (x.top < b.top || x.top + x.height > b.bottom) out.push(`${id} outside lane ${i}`);
    }
    for (const [key, g] of d.gaps) if (lanes[i]!.includes(key.split(">")[1]!.split("@")[0]!) && (g.top < b.top || g.top + g.height > b.bottom)) out.push(`gap ${key} outside lane ${i}`);
    if (i && d.bands[i - 1]!.bottom > b.top) out.push(`lane ${i - 1} overlaps lane ${i}`);
  });
  for (const r of d.routes) if (r.points.some(([x]) => x < gutter)) out.push(`${r.key} runs in the gutter`);
  const drawn = new Set(d.routes.map((r) => r.key));
  for (const e of l.edges) if (!drawn.has(`${e.from}>${e.to}`)) out.push(`${e.from}>${e.to} not drawn`);
  return out;
}

test("lanes: Nexus's plan in a band per lane, the columns kept, at several widths and with long titles: no fault", () => {
  const l = planLayout(NEXUS);
  const nodes = l.columns.flat();
  for (const width of [640, 788, 1160]) {
    for (let k = 0; k < 6; k++) {
      // k = 5: long titles, boxes three times as high.
      const heights = new Map(nodes.map((n, i) => [n.id, (k === 5 ? 3 : 1) * (56 + ((i * 37 + k * 53) % 90))]));
      const d = drawPlan(l, heights, width, undefined, { lanes: NEXUS_LANES, min: [60, 60, 120, 80] });
      assert.deepEqual(laneFaults(l, d, NEXUS_LANES), [], `width ${width}, heights ${k}`);
      l.columns.forEach((c, i) => c.forEach((n) => assert.equal(d.boxes.get(n.id)!.left, d.x[i], `${n.id} stays in its column`)));
      assert.equal(d.x[0], 30, "the gutter for the lanes' names");
      assert.ok(d.bands[2]!.bottom - d.bands[2]!.top >= 120, "a lane is as high as its name needs");
      // Within a lane and column, the plan's order.
      for (const lane of NEXUS_LANES) for (const c of l.columns) {
        const here = c.map((n) => n.id).filter((id) => lane.includes(id));
        assert.deepEqual([...here].sort((a, b) => d.boxes.get(a)!.top - d.boxes.get(b)!.top), here);
      }
    }
  }
});

test("lanes: a line that skips a column passes it in its target's lane; one between lanes changes height between the columns", () => {
  const l = planLayout(NEXUS);
  const d = drawPlan(l, new Map(l.columns.flat().map((n) => [n.id, 100])), 788, undefined, { lanes: NEXUS_LANES });
  // MX (engine) > RA (orchestrator) skips Next and Then: its gaps are in the orchestrator's lane.
  for (const c of [1, 2]) {
    const g = d.gaps.get(`MX>RA@${c}`)!;
    assert.ok(g.top >= d.bands[2]!.top && g.top + g.height <= d.bands[2]!.bottom, `MX>RA's gap in column ${c}`);
  }
  // Every vertical stretch of a line between lanes is in a gap between two columns.
  for (const r of d.routes) for (const s of segments(r.points)) {
    if (s.a[0] !== s.b[0]) continue;
    assert.ok(d.x.some((x) => s.a[0] > x + d.column && s.a[0] < x + d.column + 36), `${r.key}'s vertical run at ${s.a[0]} is between columns`);
  }
  assert.deepEqual(laneFaults(l, d, NEXUS_LANES), []);
});

test("lanes: random plans in random lanes have no fault and draw every line", () => {
  let seed = 11;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  for (let k = 0; k < 300; k++) {
    const now = 1 + Math.floor(rnd() * 3), more = 2 + Math.floor(rnd() * 10);
    const all: PlanQueue[] = [];
    for (let i = 0; i < now; i++) all.push(q(`N${i}`, { status: "running", run: { state: "running" } }));
    for (let i = 0; i < more; i++) {
      const before = all.filter(() => rnd() < 0.3).slice(0, 3).map((p) => [p.id, rnd() < 0.5 ? "user" : "orchestrator"] as [string, "user" | "orchestrator"]);
      all.push(q(`P${i}`, { plan: planned(500 - i, ...before) }));
    }
    const l = planLayout(all);
    const count = 1 + Math.floor(rnd() * 4);
    const lanes: string[][] = Array.from({ length: count }, () => []);
    for (const n of l.columns.flat()) lanes[Math.floor(rnd() * count)]!.push(n.id);
    const shown = lanes.filter((x) => x.length);
    const d = drawPlan(l, new Map(l.columns.flat().map((n) => [n.id, 50 + Math.floor(rnd() * 120)])), 500 + Math.floor(rnd() * 900), undefined, { lanes: shown });
    assert.deepEqual(laneFaults(l, d, shown), [], `plan ${k}`);
    assert.equal(d.boxes.size, l.columns.flat().length, `plan ${k}: every queue once`);
  }
});

test("lanes: a queue in no lane given still gets a box (a last lane); an empty plan draws nothing", () => {
  const l = planLayout(NEXUS);
  const d = drawPlan(l, new Map(l.columns.flat().map((n) => [n.id, 80])), 788, undefined, { lanes: [["MX", "PL"]] });
  assert.equal(d.boxes.size, l.columns.flat().length);
  assert.equal(d.bands.length, 2);
  const empty = drawPlan(planLayout([]), new Map(), 788, undefined, { lanes: [] });
  assert.deepEqual([empty.width, empty.boxes.size, empty.routes.length, empty.bands.length], [0, 0, 0, 0]);
});
