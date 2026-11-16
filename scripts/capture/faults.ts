// Layout faults of a page, as the dashboard's design work checks for them (docs/DESIGN.md, "Layout faults"): a line
// that runs through a box, boxes that overlap, and text cut short. The page side (collector) only gathers geometry:
// the boxes' rectangles, each line sampled into points, and the elements whose content is wider than they are (or
// taller, where the overflow is hidden). The judging is here, in plain functions, so it can be tested without a
// browser. Used by scripts/layout-faults.ts on the mockups (docs/ux/mockups) and on the dashboard itself.

interface Rect { left: number; top: number; right: number; bottom: number }
export interface Box { name: string; rect: Rect }
export interface Line { name: string; points: [number, number][] }
interface Cut { name: string; axis: "x" | "y"; text: string; scroll: number; client: number }
export interface Page { boxes: Box[]; lines: Line[]; cut: Cut[] }

export interface Faults {
  /** A line with a point inside a box (the box shrunk by a pixel, so a line ending on its edge is not counted). */
  through: { line: string; box: string }[];
  overlaps: { a: string; b: string }[];
  cut: Cut[];
  /** Where two lines cross: not a fault, but fewer is easier to read. */
  crossings: number;
}

/**
 * The page's side, as an expression for the browser: boxes are the elements matching `boxes`, lines the SVG shapes
 * matching `lines` (sampled every 2 px, in the page's coordinates). Text cut short: an element whose content is wider
 * than its box (scrollWidth > clientWidth), or taller where its overflow is hidden; only the innermost of a chain,
 * and nothing inside an SVG or an element marked [data-scroll] (a list meant to scroll).
 */
export function collector(boxes: string, lines: string): string {
  return `(() => {
    const name = (el) => el.getAttribute("data-plan-card") ?? el.getAttribute("data-box") ?? el.getAttribute("data-edge")
      ?? (el.tagName.toLowerCase() + (typeof el.className === "string" && el.className.trim() ? "." + el.className.trim().split(/\\s+/).slice(0, 3).join(".") : ""));
    const rectOf = (r) => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
    const boxes = [...document.querySelectorAll(${JSON.stringify(boxes)})]
      .map((el) => ({ name: name(el), rect: rectOf(el.getBoundingClientRect()) }))
      .filter((b) => b.rect.right > b.rect.left && b.rect.bottom > b.rect.top);
    const lines = [...document.querySelectorAll(${JSON.stringify(lines)})].flatMap((p) => {
      if (!(p instanceof SVGGeometryElement) || p.closest("marker, defs")) return [];
      const r = p.getBoundingClientRect();
      if (!r.width && !r.height) return [];
      const m = p.getScreenCTM(), length = p.getTotalLength(), points = [];
      for (let s = 0; ; s = Math.min(s + 2, length)) {
        const q = p.getPointAtLength(s);
        points.push([m.a * q.x + m.c * q.y + m.e, m.b * q.x + m.d * q.y + m.f]);
        if (s >= length) break;
      }
      return [{ name: name(p), points }];
    });
    let cut = [];
    for (const el of document.querySelectorAll("body *")) {
      if (el.closest("svg, [data-scroll]")) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden") continue;
      const text = (el.innerText ?? el.textContent ?? "").trim().replace(/\\s+/g, " ").slice(0, 70);
      if (el.clientWidth > 0 && el.scrollWidth > el.clientWidth) cut.push({ el, name: name(el), axis: "x", text, scroll: el.scrollWidth, client: el.clientWidth });
      else if (el.clientWidth > 0 && cs.display !== "inline" && [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) {
        // scrollWidth and clientWidth are whole pixels: text a fraction of a pixel too wide is cut (an ellipsis) but
        // equal by them. The extent of the element's own text (not its children's) against its content box says it.
        const t = { left: Infinity, right: -Infinity, width: 0 };
        for (const n of el.childNodes) {
          if (n.nodeType !== 3 || !n.textContent.trim()) continue;
          const range = document.createRange();
          range.selectNodeContents(n);
          const q = range.getBoundingClientRect();
          t.left = Math.min(t.left, q.left); t.right = Math.max(t.right, q.right); t.width = t.right - t.left;
        }
        const r = el.getBoundingClientRect();
        const left = r.left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft), right = r.right - parseFloat(cs.borderRightWidth) - parseFloat(cs.paddingRight);
        if (t.width && (t.right > right + 0.01 || t.left < left - 0.01))
          cut.push({ el, name: name(el), axis: "x", text, scroll: Math.round(t.width * 10) / 10, client: Math.round((right - left) * 10) / 10 });
      }
      else if (el.clientHeight > 0 && el.scrollHeight > el.clientHeight && (cs.overflowY === "hidden" || cs.overflowY === "clip"))
        cut.push({ el, name: name(el), axis: "y", text, scroll: el.scrollHeight, client: el.clientHeight });
    }
    // An overflow shows in every ancestor whose own overflow is visible: keep the innermost.
    cut = cut.filter((c) => !cut.some((d) => d !== c && d.axis === c.axis && c.el.contains(d.el)));
    return { boxes, lines, cut: cut.map(({ el, ...c }) => c) };
  })()`;
}

const inside = (p: [number, number], r: Rect, by = 1) => p[0] > r.left + by && p[0] < r.right - by && p[1] > r.top + by && p[1] < r.bottom - by;
const overlap = (a: Rect, b: Rect) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5;

/** Where segments p1-p2 and p3-p4 cross, if they do (touching ends included). */
function cross(p1: [number, number], p2: [number, number], p3: [number, number], p4: [number, number]): [number, number] | undefined {
  const d = (p2[0] - p1[0]) * (p4[1] - p3[1]) - (p2[1] - p1[1]) * (p4[0] - p3[0]);
  if (Math.abs(d) < 1e-9) return undefined;
  const t = ((p3[0] - p1[0]) * (p4[1] - p3[1]) - (p3[1] - p1[1]) * (p4[0] - p3[0])) / d;
  const u = ((p3[0] - p1[0]) * (p2[1] - p1[1]) - (p3[1] - p1[1]) * (p2[0] - p1[0])) / d;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? [p1[0] + t * (p2[0] - p1[0]), p1[1] + t * (p2[1] - p1[1])] : undefined;
}

/** The faults of a page from what the collector gathered. */
export function findFaults(page: Page): Faults {
  const through: Faults["through"] = [];
  for (const l of page.lines) {
    for (const b of page.boxes) if (l.points.some((p) => inside(p, b.rect))) through.push({ line: l.name, box: b.name });
  }
  const overlaps: Faults["overlaps"] = [];
  page.boxes.forEach((a, i) => page.boxes.slice(i + 1).forEach((b) => { if (overlap(a.rect, b.rect)) overlaps.push({ a: a.name, b: b.name }); }));

  // Crossings: points where two lines meet away from their own ends (lines that share a port meet there by design).
  const near = (p: [number, number], q: [number, number] | undefined, by: number) => !!q && Math.hypot(p[0] - q[0], p[1] - q[1]) < by;
  const ends = (l: Line) => [l.points[0], l.points.at(-1)];
  const found: [number, number][] = [];
  page.lines.forEach((a, i) => page.lines.slice(i + 1).forEach((b) => {
    for (let s = 1; s < a.points.length; s++) {
      for (let t = 1; t < b.points.length; t++) {
        const x = cross(a.points[s - 1]!, a.points[s]!, b.points[t - 1]!, b.points[t]!);
        if (!x || [...ends(a), ...ends(b)].some((e) => near(x, e, 6)) || found.some((f) => near(x, f, 4))) continue;
        found.push(x);
      }
    }
  }));
  return { through, overlaps, cut: page.cut, crossings: found.length };
}

/** The faults as lines of text for a report. */
export function describe(f: Faults): string[] {
  return [
    `lines through boxes: ${f.through.length}`, ...f.through.map((t) => `  ${t.line} runs through ${t.box}`),
    `overlapping boxes: ${f.overlaps.length}`, ...f.overlaps.map((o) => `  ${o.a} overlaps ${o.b}`),
    `text cut short: ${f.cut.length}`, ...f.cut.map((c) => `  ${c.name} (${c.axis === "x" ? "width" : "height"} ${c.scroll} > ${c.client}): "${c.text}"`),
    `line crossings (not a fault): ${f.crossings}`,
  ];
}
