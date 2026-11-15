// The plan view mockups (queue PL): Nexus's own plan as scripts/capture/seed-plan-nexus.ts seeds it, drawn two ways.
//   A (?v=a): today's columns (Now, Next, Then) with the queues stacked from the top in today's order. A line that skips
//      a column passes through a gap kept free for it in each column in between (A_COLUMNS lists the gaps, "from>to");
//      between the columns the lines run at right angles, each on its own track, so none runs over another.
//   B (?v=b): a layered graph as dagre or ELK lay it out: a long line gets a placeholder ("dummy") in each column it
//      crosses, the order in each column is chosen to cut crossings (barycenter sweeps), and each queue sits at the
//      height of its neighbours where there is room (isotonic placement); lines are curves through the placeholders.
// Phone (below 1024 px): A is today's ordered list; B the same list in the layered order, with the lines in a gutter
// on the left (leaving a queue at its lower left, arriving at its upper left).
// Both: the whole title on the card (it wraps; never cut), what the queue waits for, its "after" chips as today.
// ?theme=paper|honey; ?tip=<queue> shows the bubble with a queue's full title and its dependencies, as on hover.
// scripts/layout-faults.ts measures the result: [data-plan-card] and [data-box] are boxes, [data-edge] lines.

const QUEUES = [
  { id: "MX", title: "Small fixes from the user's notes of 14 November", now: ["running", "running · MX1"], est: "3.5 h" },
  { id: "PL", title: "Plan view design: layouts and features on mockups", now: ["usage", "waiting for the usage window · PL1"], est: "2.5 h" },
  { id: "ST2", title: "Statistics views: the project page with step durations", now: ["review", "waiting for your review · ST21"], est: "2.5 h" },
  { id: "RX", title: "Refactoring the queue engine's run loop", after: [["MX", "orchestrator"]], est: "1.5 h" },
  { id: "IO", title: "Plan view build: layered layout and routed lines", after: [["PL", "user"]], est: "3.5 h" },
  { id: "CH", title: "Chat context: what the orchestrator keeps between chats", after: [["PW", "orchestrator", true]], why: ["approval", "needs approval (revision 2)"], est: "2.5 h" },
  { id: "NB", title: "Nightly full test run and static analysis", why: ["time", "starts at 22:00"], est: "1.5 h" },
  { id: "TS", title: "Test speed: split the slow server tests", after: [["RX", "orchestrator"]], est: "1.5 h" },
  { id: "ST3", title: "Statistics views: estimates in the plan and on the phone", after: [["RX", "orchestrator"], ["ST2", "user"]], est: "1.5 h" },
  { id: "LG", title: "Reader's language across the dashboard", after: [["CH", "orchestrator"], ["MT", "user", true]], est: "1.5 h" },
  { id: "DG", title: "Morning digest: a summary of the night on the phone", after: [["ST3", "orchestrator"], ["IO", "user"]], est: "1.5 h" },
  { id: "RA", title: "Review autonomy: the orchestrator accepts look steps", after: [["LG", "orchestrator"], ["MX", "orchestrator"]], est: "1.5 h" },
];
const DONE = { FB: "Feedback buttons on review items", PW: "Parallel worktrees and merge-back", MT: "Maintenance queue templates" };
/** Variant A's columns, top to bottom: queues, and "from>to" for a gap kept free for a line that skips the column. */
const A_COLUMNS = [
  ["MX", "PL", "ST2"],
  ["MX>RA", "RX", "IO", "ST2>ST3", "CH", "NB"],
  ["MX>RA", "TS", "IO>DG", "ST3", "LG"],
  ["DG", "RA"],
];
const GAP = 36, HEAD = 24, VGAP = 12, SLOT = 18, DUMMY = 14;

const byId = new Map(QUEUES.map((q) => [q.id, q]));
const EDGES = QUEUES.flatMap((q) => (q.after ?? []).filter(([, , done]) => !done).map(([from, by]) => ({ from, to: q.id, by, key: `${from}>${q.id}` })));
const rank = new Map();
const rankOf = (id) => {
  if (!rank.has(id)) {
    const q = byId.get(id);
    rank.set(id, q.now ? 0 : Math.max(1, ...(q.after ?? []).filter(([p, , d]) => !d && byId.has(p)).map(([p]) => rankOf(p) + 1)));
  }
  return rank.get(id);
};
QUEUES.forEach((q) => rankOf(q.id));
const RANKS = Math.max(...rank.values()) + 1;
const columnTitle = (c) => (c === 0 ? "Now" : c === 1 ? "Next" : "Then");

const params = new URLSearchParams(location.search);
const VARIANT = params.get("v") === "b" ? "b" : "a";
if (params.get("theme")) document.documentElement.dataset.theme = params.get("theme");

const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined) (k === "class" ? (e.className = v) : e.setAttribute(k, v));
  e.append(...kids);
  return e;
};
const SVG = "http://www.w3.org/2000/svg";
const svgEl = (tag, attrs, parent) => {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  parent?.append(e);
  return e;
};

/** A queue's card: id, estimate and After… on top; the whole title; its state or what it waits for; the chips. */
function card(q) {
  const kids = [
    el("div", { class: "top" }, el("span", { class: "mono id" }, q.id), el("span", { class: "est", title: "estimate" }, `est. ${q.est}`),
      ...(q.now ? [] : [el("span", { class: "after" }, "After…")])),
    el("div", { class: "title" }, q.title),
  ];
  if (q.now) kids.push(el("div", { class: `st tone-${q.now[0]}` }, q.now[1]));
  if (q.why) kids.push(el("div", { class: `why tone-${q.why[0]}` }, q.why[1]));
  if (q.after?.length) {
    kids.push(el("div", { class: "chips" }, ...q.after.map(([p, by, done]) => el("span", { class: `chip${by === "user" ? " user" : ""}${done ? " done" : ""}` },
      `after ${p}${by === "user" ? " · set by you" : ""}${done ? " · done" : ""}`, ...(by === "user" ? [el("b", {}, "↩")] : [])))));
  }
  return el("div", { class: `pc${q.now ? " now" : ""}`, "data-plan-card": q.id }, ...kids);
}

/** Rounded corners on a path through `pts` at right angles. */
function orthogonal(pts, r = 6) {
  const p = pts.filter((q, i) => i === 0 || q[0] !== pts[i - 1][0] || q[1] !== pts[i - 1][1]);
  let d = `M${p[0][0]},${p[0][1]}`;
  for (let i = 1; i < p.length - 1; i++) {
    const [x0, y0] = p[i - 1], [x, y] = p[i], [x1, y1] = p[i + 1];
    const a = Math.min(r, Math.hypot(x - x0, y - y0) / 2, Math.hypot(x1 - x, y1 - y) / 2);
    d += ` L${x - a * Math.sign(x - x0)},${y - a * Math.sign(y - y0)} Q${x},${y} ${x + a * Math.sign(x1 - x)},${y + a * Math.sign(y1 - y)}`;
  }
  return `${d} L${p.at(-1)[0]},${p.at(-1)[1]}`;
}

function markers(svg) {
  const defs = svgEl("defs", {}, svg);
  for (const by of ["user", "orchestrator"]) {
    const m = svgEl("marker", { id: `arrow-${by}`, viewBox: "0 0 6 6", refX: "1", refY: "3", markerWidth: "6", markerHeight: "6", orient: "auto" }, defs);
    svgEl("path", { d: "M0,0 L6,3 L0,6 z", class: `arrow-${by}` }, m);
  }
}

/** Variant A: the columns stacked from the top, with the gaps of A_COLUMNS. Positions are tops, in the plan's pixels. */
function layoutA(h) {
  const top = new Map(), slot = new Map();
  A_COLUMNS.forEach((col) => {
    let y = HEAD;
    for (const item of col) {
      if (item.includes(">")) { slot.set(`${item}@${A_COLUMNS.indexOf(col)}`, y + SLOT / 2); y += SLOT + VGAP; }
      else { top.set(item, y); y += h.get(item) + VGAP; }
    }
  });
  return { top, slot, order: A_COLUMNS.map((c) => c.filter((i) => !i.includes(">"))) };
}

/** Variant B: a layered layout (dummies, barycenter ordering, isotonic placement), as dagre or ELK do it. */
function layoutB(h) {
  const layers = A_COLUMNS.map((c) => c.filter((i) => !i.includes(">")));
  const preds = new Map(), succs = new Map(), height = new Map(h);
  const link = (a, b) => { (succs.get(a) ?? succs.set(a, []).get(a)).push(b); (preds.get(b) ?? preds.set(b, []).get(b)).push(a); };
  for (const e of EDGES) {
    let prev = e.from;
    for (let c = rank.get(e.from) + 1; c < rank.get(e.to); c++) {
      const d = `${e.key}@${c}`;
      layers[c].push(d); height.set(d, DUMMY); link(prev, d); prev = d;
    }
    link(prev, e.to);
  }
  const crossings = (ls) => {
    let n = 0;
    for (let c = 0; c + 1 < ls.length; c++) {
      const pairs = ls[c].flatMap((a, i) => (succs.get(a) ?? []).map((b) => [i, ls[c + 1].indexOf(b)]));
      pairs.forEach(([a, b], i) => pairs.slice(i + 1).forEach(([x, y]) => { if ((a - x) * (b - y) < 0) n++; }));
    }
    return n;
  };
  const sortBy = (layer, near, other) => {
    const key = new Map(layer.map((id, i) => {
      const ns = (near.get(id) ?? []).map((n) => other.indexOf(n)).filter((i2) => i2 >= 0);
      return [id, ns.length ? ns.reduce((a, b) => a + b, 0) / ns.length : i];
    }));
    layer.sort((a, b) => key.get(a) - key.get(b));
  };
  let best = layers.map((l) => [...l]), fewest = crossings(layers);
  for (let it = 0; it < 8; it++) {
    for (let c = 1; c < layers.length; c++) sortBy(layers[c], preds, layers[c - 1]);
    for (let c = layers.length - 2; c >= 0; c--) sortBy(layers[c], succs, layers[c + 1]);
    const n = crossings(layers);
    if (n < fewest) { fewest = n; best = layers.map((l) => [...l]); }
  }
  // Heights: each queue as near the mean height of its neighbours as the order allows (the least squares placement
  // under "below the one above it", by pooling adjacent violators), a few rounds in both directions.
  const center = new Map();
  const place = (layer, want) => {
    const off = []; let o = 0;
    for (const id of layer) { off.push(o); o += height.get(id) + VGAP; }
    let last;
    const d = layer.map((id, i) => {
      const w = want(id);
      const v = w === undefined ? (last ?? 0) + (i ? height.get(layer[i - 1]) + VGAP : 0) : w - height.get(id) / 2;
      last = v;
      return v - off[i];
    });
    const blocks = [];
    d.forEach((v, i) => {
      blocks.push({ v, n: 1, from: i });
      while (blocks.length > 1 && blocks.at(-2).v > blocks.at(-1).v) {
        const b = blocks.pop(), a = blocks.at(-1);
        a.v = (a.v * a.n + b.v * b.n) / (a.n + b.n); a.n += b.n;
      }
    });
    for (const b of blocks) for (let i = b.from; i < b.from + b.n; i++) center.set(layer[i], Math.max(0, b.v) + off[i] + height.get(layer[i]) / 2);
  };
  const mean = (ids) => { const cs = ids.filter((i) => center.has(i)).map((i) => center.get(i)); return cs.length ? cs.reduce((a, b) => a + b, 0) / cs.length : undefined; };
  best.forEach((layer, c) => place(layer, (id) => (c ? mean(preds.get(id) ?? []) : undefined)));
  for (let round = 0; round < 4; round++) {
    for (let c = best.length - 1; c >= 0; c--) place(best[c], (id) => mean([...(preds.get(id) ?? []), ...(succs.get(id) ?? [])]));
    for (let c = 0; c < best.length; c++) place(best[c], (id) => mean([...(preds.get(id) ?? []), ...(succs.get(id) ?? [])]));
  }
  const lowest = Math.min(...[...center].map(([id, y]) => y - height.get(id) / 2));
  const top = new Map(), slot = new Map();
  for (const [id, y] of center) {
    const t = y - height.get(id) / 2 - lowest + HEAD;
    if (id.includes("@")) slot.set(id, t + DUMMY / 2); else top.set(id, t);
  }
  return { top, slot, order: best.map((l) => l.filter((i) => !i.includes("@"))) };
}

function desktop(host) {
  const W = host.clientWidth, colW = (W - (RANKS - 1) * GAP) / RANKS;
  const x = (c) => c * (colW + GAP);
  for (let c = 0; c < RANKS; c++) host.append(el("div", { class: "colh", "data-box": `column ${c}`, style: `left:${x(c)}px` }, columnTitle(c)));
  const cards = new Map(), h = new Map();
  for (const q of QUEUES) {
    const c = card(q);
    c.style.width = `${colW}px`;
    host.append(c); cards.set(q.id, c); h.set(q.id, c.offsetHeight);
  }
  const L = VARIANT === "a" ? layoutA(h) : layoutB(h);
  let bottom = 0;
  for (const q of QUEUES) {
    const c = cards.get(q.id);
    c.style.left = `${x(rank.get(q.id))}px`; c.style.top = `${L.top.get(q.id)}px`;
    bottom = Math.max(bottom, L.top.get(q.id) + h.get(q.id));
  }
  const mid = (id) => L.top.get(id) + h.get(id) / 2;
  // The heights a line passes at in each column: its source, the gaps (A) or dummies (B) in between, its target.
  const via = (e) => {
    const ys = [];
    for (let c = rank.get(e.from) + 1; c < rank.get(e.to); c++) ys.push(L.slot.get(`${e.key}@${c}`));
    return ys;
  };
  // Ports: a queue's lines leave and arrive 10 px apart, sorted by where they go or come from.
  const port = new Map();
  for (const q of QUEUES) {
    const out = EDGES.filter((e) => e.from === q.id).map((e) => [e, via(e)[0] ?? mid(e.to)]).sort((a, b) => a[1] - b[1]);
    out.forEach(([e], i) => port.set(`${e.key}:out`, mid(q.id) + (i - (out.length - 1) / 2) * 10));
    const inn = EDGES.filter((e) => e.to === q.id).map((e) => [e, via(e).at(-1) ?? mid(e.from)]).sort((a, b) => a[1] - b[1]);
    inn.forEach(([e], i) => port.set(`${e.key}:in`, mid(q.id) + (i - (inn.length - 1) / 2) * 10));
  }
  const svg = svgEl("svg", { class: "edges", width: W, height: bottom + 8 }, host);
  markers(svg);
  const runs = EDGES.map((e) => ({ e, ys: [port.get(`${e.key}:out`), ...via(e), port.get(`${e.key}:in`)] }));
  if (VARIANT === "a") {
    // Tracks in each gap between columns: a vertical run of its own for each line that changes height there.
    const track = new Map();
    for (let g = 0; g + 1 < RANKS; g++) {
      const here = runs.flatMap(({ e, ys }) => {
        const i = g - rank.get(e.from);
        return i >= 0 && i < ys.length - 1 && ys[i] !== ys[i + 1] ? [{ e, lo: Math.min(ys[i], ys[i + 1]), hi: Math.max(ys[i], ys[i + 1]) }] : [];
      }).sort((a, b) => a.lo - b.lo);
      const ends = [];
      for (const s of here) {
        let t = ends.findIndex((end) => end < s.lo - 6);
        if (t < 0) { t = ends.length; ends.push(0); }
        ends[t] = s.hi; s.t = t;
      }
      for (const s of here) track.set(`${s.e.key}@${g}`, x(g) + colW + (GAP * (s.t + 1)) / (ends.length + 1));
    }
    for (const { e, ys } of runs) {
      const c0 = rank.get(e.from), pts = [[x(c0) + colW, ys[0]]];
      ys.slice(1).forEach((y, i) => {
        const g = c0 + i, tx = track.get(`${e.key}@${g}`);
        if (tx !== undefined) pts.push([tx, ys[i]], [tx, y]);
        pts.push([g + 1 === rank.get(e.to) ? x(g + 1) - 5 : x(g + 1) + colW, y]);
      });
      svgEl("path", { d: orthogonal(pts), class: `edge ${e.by}`, "data-edge": e.key, "marker-end": `url(#arrow-${e.by})` }, svg);
    }
  } else {
    for (const { e, ys } of runs) {
      const c0 = rank.get(e.from);
      let d = `M${x(c0) + colW},${ys[0]}`;
      ys.slice(1).forEach((y, i) => {
        const g = c0 + i, x1 = x(g) + colW, x2 = g + 1 === rank.get(e.to) ? x(g + 1) - 5 : x(g + 1), m = (x1 + x2) / 2;
        d += ` C${m},${ys[i]} ${m},${y} ${x2},${y}`;
        if (g + 1 !== rank.get(e.to)) d += ` L${x(g + 1) + colW},${y}`;
      });
      svgEl("path", { d, class: `edge ${e.by}`, "data-edge": e.key, "marker-end": `url(#arrow-${e.by})` }, svg);
    }
  }
  // The bubble of ?tip=<queue>: under it, as on hover.
  const tip = params.get("tip");
  if (tip && byId.has(tip)) {
    const q = byId.get(tip), w = colW, c = rank.get(tip);
    const left = Math.min(x(c), W - w);
    const b = el("div", { class: "bubble", "data-box": "bubble", style: `left:${left}px; top:${L.top.get(tip) + h.get(tip) + 10}px; width:${w}px` },
      el("div", { class: "t" }, q.title),
      ...(q.after ?? []).map(([p, by, done]) => el("div", { class: "k" }, `after ${p} (${DONE[p] ?? byId.get(p).title}), set by ${by === "user" ? "you" : "the orchestrator"}${done ? ", done" : ""}`)),
      el("div", { class: "k" }, `est. ${q.est} (from the statistics)`));
    b.style.setProperty("--notch", `${x(c) - left + 18}px`);
    host.append(b);
    bottom = Math.max(bottom, b.offsetTop + b.offsetHeight);
  }
  host.style.height = `${bottom + 4}px`;
  return L.order;
}

/** The phone: the queues in order under Now, Next, Then; in B with the lines in a gutter on the left. */
function phone(host, order) {
  const list = order.flatMap((col, c) => col.map((id) => ({ id, c })));
  const cards = new Map();
  list.forEach(({ id, c }, i) => {
    if (!i || list[i - 1].c !== c) host.append(el("h3", { "data-box": `heading ${id}` }, columnTitle(c)));
    const k = card(byId.get(id));
    host.append(k); cards.set(id, k);
  });
  if (VARIANT !== "b") return;
  // Lanes: each line its own, the shorter nearer the cards; a line leaves at a queue's lower left, arrives at its upper.
  const at = (id) => ({ top: cards.get(id).offsetTop, bottom: cards.get(id).offsetTop + cards.get(id).offsetHeight });
  const outs = new Map(), ins = new Map();
  const lay = (gutter) => {
    host.style.paddingLeft = `${gutter}px`;
    // A queue's lines of the same kind leave together on one lane and part where each arrives (as a trunk).
    const outs = new Map(), ins = new Map(), trunks = new Map();
    const lines = EDGES.map((e) => ({ e })).sort((a, b) => list.findIndex((l) => l.id === a.e.from) - list.findIndex((l) => l.id === b.e.from));
    for (const l of lines) {
      const key = `${l.e.from}:${l.e.by}`;
      if (!trunks.has(key)) {
        const o = outs.get(l.e.from) ?? 0;
        outs.set(l.e.from, o + 1);
        trunks.set(key, { y1: at(l.e.from).bottom - 14 - o * 9, y2: 0, lines: [] });
      }
      const n = ins.get(l.e.to) ?? 0;
      ins.set(l.e.to, n + 1);
      const t = trunks.get(key);
      l.y1 = t.y1; l.y2 = at(l.e.to).top + 14 + n * 9; l.trunk = t;
      t.y2 = Math.max(t.y2, l.y2); t.lines.push(l);
    }
    const lanes = [];
    for (const t of [...trunks.values()].sort((a, b) => (a.y2 - a.y1) - (b.y2 - b.y1))) {
      let k = lanes.findIndex((busy) => busy.every(([lo, hi]) => t.y2 < lo - 4 || t.y1 > hi + 4));
      if (k < 0) { k = lanes.length; lanes.push([]); }
      lanes[k].push([t.y1, t.y2]);
      for (const l of t.lines) l.k = k;
    }
    return { lines, gutter: 14 + lanes.length * 7 };
  };
  // The gutter's width depends on the lanes, and the cards' heights (so the lanes) on the width left: twice.
  let { lines, gutter } = lay(54);
  if (gutter !== 54) ({ lines, gutter } = lay(gutter));
  const svg = svgEl("svg", { class: "gutter", width: gutter, height: host.offsetHeight }, null);
  host.prepend(svg);
  markers(svg);
  for (const l of lines) {
    const lx = gutter - 12 - l.k * 7;
    svgEl("path", { d: orthogonal([[gutter, l.y1], [lx, l.y1], [lx, l.y2], [gutter - 5, l.y2]], 5), class: `edge ${l.e.by}`, "data-edge": l.e.key, "marker-end": `url(#arrow-${l.e.by})` }, svg);
  }
}

addEventListener("DOMContentLoaded", () => {
  const plan = document.getElementById("plan"), list = document.getElementById("plist");
  const order = VARIANT === "a" ? layoutA(new Map(QUEUES.map((q) => [q.id, 0]))).order : null;
  if (getComputedStyle(plan).display !== "none") desktop(plan);
  else {
    // The phone's order is the desktop's: B's comes from its layout, worked out on a hidden plan of desktop width.
    let o = order;
    if (!o) {
      const shadow = el("div", { style: "position:absolute; visibility:hidden; width:788px; left:-9999px; top:0" });
      document.body.append(shadow);
      o = desktop(shadow);
      shadow.remove();
    }
    phone(list, o);
  }
});
