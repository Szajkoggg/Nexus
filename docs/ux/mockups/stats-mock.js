// Shared parts of the Stats mockups (queue ST3): seeded data, the SVG chart forms the dataviz skill picks, the hover
// tooltip, the chart/table toggle. Plain script, no build: each page includes it and calls the builders.
const params = new URLSearchParams(location.search);
if (params.get("theme")) document.documentElement.dataset.theme = params.get("theme");
const variant = params.get("v") === "b" ? "b" : "a";

/** A seeded random source (mulberry32): the same picture on every load. */
function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NS = "http://www.w3.org/2000/svg";
function svgEl(tag, attrs, parent, text) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs ?? {})) if (v !== undefined) e.setAttribute(k, String(v));
  if (text !== undefined) e.textContent = text;
  if (parent) parent.appendChild(e);
  return e;
}
function newSvg(host, height) {
  const w = host.clientWidth || 300;
  const s = svgEl("svg", { viewBox: `0 0 ${w} ${height}`, height, role: "img" }, host);
  return { s, w };
}

// ---- the tooltip: values lead, labels follow; text only through textContent ----
const tip = document.createElement("div");
tip.className = "tip";
document.addEventListener("DOMContentLoaded", () => document.body.appendChild(tip));
/** lines: [text, kind?][]; kind "b" (the value), "k" (secondary), "go" (the link to the step). */
function fillTip(box, lines) {
  box.replaceChildren();
  for (const [text, kind] of lines) {
    const d = document.createElement("div");
    if (kind === "b") { const b = document.createElement("b"); b.textContent = text; d.appendChild(b); }
    else { d.textContent = text; if (kind) d.className = kind; }
    box.appendChild(d);
  }
}
function hoverable(node, lines) {
  node.setAttribute("tabindex", "0");
  node.setAttribute("aria-label", lines.map((l) => l[0]).join(", "));
  const show = (x, y) => { fillTip(tip, lines); tip.style.display = "block"; tip.style.left = `${x + 14}px`; tip.style.top = `${y + 14}px`; };
  node.addEventListener("pointermove", (e) => show(e.clientX, e.clientY));
  node.addEventListener("pointerleave", () => { tip.style.display = "none"; });
  node.addEventListener("focus", () => { const r = node.getBoundingClientRect(); show(r.right, r.top); });
  node.addEventListener("blur", () => { tip.style.display = "none"; });
}

// ---- the chart/table toggle of every card ----
document.addEventListener("click", (e) => {
  const s = e.target.closest(".seg.view span");
  if (!s) return;
  const card = s.closest(".card");
  for (const x of s.parentElement.children) x.classList.toggle("on", x === s);
  card.classList.toggle("show-table", s.textContent === "Table");
});
const viewToggle = () => '<span class="seg small view"><span class="on">Chart</span><span>Table</span></span>';
function table(head, rows) {
  const t = document.createElement("table");
  const tr = t.createTHead().insertRow();
  for (const h of head) { const th = document.createElement("th"); th.textContent = h; tr.appendChild(th); }
  const b = t.createTBody();
  for (const r of rows) { const row = b.insertRow(); for (const c of r) row.insertCell().textContent = c; }
  return t;
}

// ---- paths: 4px rounded data-end, square at the baseline ----
function colPath(x, y0, y1, w, r = 4) { // a column from baseline y0 up to y1
  const h = y0 - y1; r = Math.min(r, h, w / 2);
  return `M${x} ${y0}V${y1 + r}Q${x} ${y1} ${x + r} ${y1}H${x + w - r}Q${x + w} ${y1} ${x + w} ${y1 + r}V${y0}Z`;
}
function barPath(x0, x1, y, h, r = 4) { // a bar from x0 right to x1
  const w = x1 - x0; r = Math.min(r, w, h / 2);
  return `M${x0} ${y}H${x1 - r}Q${x1} ${y} ${x1} ${y + r}V${y + h - r}Q${x1} ${y + h} ${x1 - r} ${y + h}H${x0}Z`;
}

/**
 * A time chart: line (with an optional ~10% wash) or columns, one series in --series, recessive grid, the reference
 * lines (a target: secondary ink; a warning threshold: the warn status, labelled with ⚠), a value beyond the
 * threshold as a warn dot with ⚠ and its value, the end value labelled. o: { kind: "line"|"col", pts: [{ y, tip, warn }],
 * yMax, ticks, fmt, xLabels: [[index, text]], refs: [{ y, text, cls }], area, end, height }
 */
function timeChart(host, o) {
  const H = o.height ?? 140, m = { l: 36, r: o.endRoom ?? 52, t: 10, b: 20 };
  const { s, w } = newSvg(host, H);
  const n = o.pts.length, pw = w - m.l - m.r, ph = H - m.t - m.b;
  const yMin = o.yMin ?? 0;
  const Y = (v) => m.t + ph - ((v - yMin) / (o.yMax - yMin)) * ph;
  const band = pw / n;
  const X = (i) => m.l + band * i + band / 2;
  for (const t of o.ticks) {
    svgEl("line", { x1: m.l, x2: w - m.r, y1: Y(t), y2: Y(t), class: t === yMin ? "base" : "gridl" }, s);
    svgEl("text", { x: m.l - 6, y: Y(t) + 3, "text-anchor": "end", class: "ax" }, s, o.fmt(t));
  }
  for (const [i, t] of o.xLabels) svgEl("text", { x: X(i), y: H - 4, "text-anchor": "middle", class: "ax" }, s, t);
  for (const r of o.refs ?? []) {
    svgEl("line", { x1: m.l, x2: w - m.r, y1: Y(r.y), y2: Y(r.y), class: r.cls }, s);
    svgEl("text", { x: w - m.r + 4, y: Y(r.y) + 3, class: "ax" }, s, r.text);
  }
  if (o.kind === "col") {
    const cw = Math.min(24, Math.max(3, band - 2));
    o.pts.forEach((p, i) => {
      if (p.y == null) return;
      const g = svgEl("g", {}, s);
      const hit = svgEl("rect", { x: X(i) - band / 2, y: m.t, width: band, height: ph, class: "hit" }, g);
      svgEl("path", { d: colPath(X(i) - cw / 2, Y(yMin), Y(p.y), cw), class: p.warn ? "mark warnfill" : "mark" }, g);
      if (p.warn) svgEl("text", { x: X(i), y: Y(p.y) - 4, "text-anchor": "middle", class: "ax" }, g, "⚠");
      hoverable(hit, p.tip);
    });
  } else {
    const ok = o.pts.map((p, i) => [p, i]).filter(([p]) => p.y != null);
    const d = ok.map(([p, i], k) => `${k ? "L" : "M"}${X(i)} ${Y(p.y)}`).join("");
    if (o.area) svgEl("path", { d: `${d}L${X(ok.at(-1)[1])} ${Y(yMin)}L${X(ok[0][1])} ${Y(yMin)}Z`, class: "wash" }, s);
    svgEl("path", { d, class: "line" }, s);
    for (const [p, i] of ok) {
      const g = svgEl("g", {}, s);
      const hit = svgEl("rect", { x: X(i) - Math.max(band, 24) / 2, y: m.t, width: Math.max(band, 24), height: ph, class: "hit" }, g);
      if (p.warn || o.dots) svgEl("circle", { cx: X(i), cy: Y(p.y), r: p.warn ? 5 : 4, class: p.warn ? "dot warn" : "dot" }, g);
      if (p.warn) svgEl("text", { x: X(i), y: Y(p.y) - 9, "text-anchor": "middle", class: "lbl warn" }, g, `⚠ ${o.fmt(p.y)}`);
      hoverable(hit, p.tip);
    }
  }
  if (o.end !== undefined) {
    const last = [...o.pts.keys()].reverse().find((i) => o.pts[i].y != null);
    const ly = Y(o.pts[last].y);
    if (o.kind !== "col") svgEl("circle", { cx: X(last), cy: ly, r: 4, class: "dot" }, s);
    svgEl("text", { x: X(last) + 8, y: ly + 4, class: "lbl strong" }, s, o.end);
  }
  return s;
}

/** A horizontal bar in a comparison cell, its value at the tip; a few-data group in the de-emphasis gray. */
function cellBar(host, o) {
  const H = 36, { s, w } = newSvg(host, H), pr = 64;
  const x1 = Math.max(2, (o.v / o.max) * (w - pr));
  const g = svgEl("g", {}, s);
  const hit = svgEl("rect", { x: 0, y: 0, width: w, height: H, class: "hit" }, g);
  svgEl("path", { d: barPath(0, x1, 12, 12), class: o.few ? "mark few" : "mark" }, g);
  svgEl("text", { x: x1 + 6, y: 22, class: "lbl" }, g, o.label);
  hoverable(hit, o.tip);
}
/** A dot on a scale that need not start at zero (rounds on average: from 1). */
function cellDot(host, o) {
  const H = 36, { s, w } = newSvg(host, H), pr = 44;
  const X = (v) => ((v - o.min) / (o.max - o.min)) * (w - pr);
  svgEl("line", { x1: 0, x2: w - pr, y1: 18, y2: 18, class: "gridl" }, s);
  const g = svgEl("g", {}, s);
  const hit = svgEl("rect", { x: 0, y: 0, width: w, height: H, class: "hit" }, g);
  if (o.lo !== undefined) svgEl("line", { x1: X(o.lo), x2: X(o.hi), y1: 18, y2: 18, class: "range" }, g);
  svgEl("circle", { cx: X(o.v), cy: 18, r: 5, class: o.few ? "dot few" : "dot" }, g);
  svgEl("text", { x: Math.max(X(o.hi ?? o.v), X(o.v)) + 9, y: 22, class: "lbl" }, g, o.label);
  hoverable(hit, o.tip);
}
/** The tick row under a comparison column. */
function cellAxis(host, o) {
  const H = 16, { s, w } = newSvg(host, H), pr = o.pr;
  for (const t of o.ticks) {
    const x = ((t - (o.min ?? 0)) / (o.max - (o.min ?? 0))) * (w - pr);
    svgEl("text", { x, y: 11, "text-anchor": t === (o.min ?? 0) ? "start" : "middle", class: "ax" }, s, o.fmt(t));
  }
}
/** A 12-point sparkline in the de-emphasis ink, the current value in the series colour. */
function sparkline(host, vals, height = 34) {
  const { s, w } = newSvg(host, height);
  const max = Math.max(...vals), min = Math.min(...vals);
  const X = (i) => 2 + (i / (vals.length - 1)) * (w - 8), Y = (v) => 4 + (1 - (v - min) / (max - min || 1)) * (height - 8);
  svgEl("path", { d: vals.map((v, i) => `${i ? "L" : "M"}${X(i)} ${Y(v)}`).join(""), fill: "none", stroke: "var(--fg-3)", "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }, s);
  svgEl("circle", { cx: X(vals.length - 1), cy: Y(vals.at(-1)), r: 4, class: "dot" }, s);
}

const DAY = 86400000;
const TODAY = Date.UTC(2026, 10, 15);
const dayName = (t) => new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const pct = (v) => `${Math.round(v)} %`;
