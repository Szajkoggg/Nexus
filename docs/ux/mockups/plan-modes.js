// The plan view's modes (queue PVA, step PVA1; docs/ux/plan-view-modes.md): PL's four features fitted to the dashboard
// as built (PB, PVA0, PVAR) and to the data it has. Loaded before plan-mock.js, whose hooks it fills (PLAN_FEATURE).
// The plan is Nexus's own, as scripts/capture/seed-plan-nexus.ts seeds it, with an orchestrator that takes the
// level-2 reviews and a fixed clock: now is 21:10. ?m=<mode> picks what is shown:
//   base      the plan as today, with the switcher above it (View: Columns | Lanes by area | Time axis; Mark: Critical
//             path | What blocks)
//   critical  the critical path marked on the columns: the longest chain of work by the dependencies and the estimates
//   blocked   what blocks: the queues that wait for the user now, each with what it holds up and the button that opens
//             the exact review or approval; what they hold up stays lit, the rest is dimmed
//   lanes     a lane per area tag (the queue's own; "No area" last), the columns kept, compact cards
//   time      the time axis: a row per queue, its expected start and end from the estimates, if every wait for the user
//             ended at once (hatched after one); review points marked
//   unknown   the time axis without estimates (fewer than five finished steps on the server): only the set times (a
//             schedule, the usage window) are placed, the rest is named in its order
// Desktop at 1440 px; below 1024 px (492, 390) the list, as the dashboard shows it there.

const PLAN_FEATURE = (() => {
  const M = new URLSearchParams(location.search).get("m") ?? "base";
  const VIEW = M === "lanes" ? "lanes" : M === "time" || M === "unknown" ? "time" : "columns";
  const NOW = 21 + 10 / 60;
  const hours = (q) => parseFloat(q.est);
  const clock = (t) => { const m = Math.round((NOW + t) * 60) % (24 * 60); return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`; };

  // What the built dashboard shows on the cards beyond PL's data: the area tags (lanes), the steps that wait for the
  // user's review (PVAR), and ST3's step in another area.
  const EXTRA = {
    MX: { area: "engine" }, PL: { area: "dashboard" },
    ST2: { area: "dashboard", reviews: "2 steps for your review · next ST21 Durations by tag", first: true },
    RX: { area: "engine" }, IO: { area: "dashboard", reviews: "1 step for your review · next IO3 Phone" },
    CH: { area: "orchestrator" }, NB: {}, TS: { area: "engine" }, ST3: { area: "dashboard", also: "engine" },
    LG: { area: "dashboard" }, DG: { area: "dashboard", reviews: "1 step for your review · next DG2 Phone" }, RA: { area: "orchestrator" },
  };

  // ---------------------------------------------------------------- the page around the plan
  const HINT = {
    columns: "What runs now and what follows it. A line joins a queue to the one that waits for it.",
    critical: "", // from the path
    blocked: "", // from the roots
    lanes: "A lane per area tag, the columns kept; on a compact card a line says what the chips said.",
    time: "When each queue may run, from the estimates and the dependencies, if every wait for you ended at once.",
    unknown: "When each queue may run: no estimates yet, so only the set times are placed.",
  };
  const page = (hint) => {
    const head = document.querySelector(".plan-head");
    head.querySelector(".hint").textContent = hint;
    const views = [["columns", "Columns"], ["lanes", "Lanes by area"], ["time", "Time axis"]];
    const marks = [["critical", "Critical path"], ["blocked", "What blocks · 2"]];
    head.after(el("div", { class: "modes", "data-box": "modes" },
      el("span", { class: "grp" }, el("span", { class: "gk" }, "View"),
        el("span", { class: "seg" }, ...views.map(([k, l]) => el("span", { class: `sg${VIEW === k ? " on" : ""}` }, l)))),
      el("span", { class: "grp" }, el("span", { class: "gk" }, "Mark"),
        ...marks.map(([k, l]) => (M === "unknown" && k === "critical"
          // The critical path needs the estimates: shown, not usable, and saying why.
          ? el("span", { class: "tg off", title: "Needs the estimates: 3 of 5 finished steps" }, `${l} · no estimates`)
          : el("span", { class: `tg${M === k ? " on" : ""}` }, l, ...(M === k ? [el("b", { class: "x", "aria-label": "clear" }, " ×")] : [])))))));
    const fw = el("p", { class: "fwl", "data-box": "first wait" }, "First wait for your review: ST21 Durations by tag · waiting now");
    document.querySelector(".modes").after(fw);
    if (VIEW === "time") {
      const lg = document.querySelector(".legend");
      lg.replaceChildren(
        el("span", {}, el("i", { class: "lg-mark" }), "waits for your review"),
        el("span", {}, el("i", { class: "lg-cond" }), "after a wait of unknown length"),
        el("span", {}, el("i", { class: "lg-wait" }), "waits by itself"));
      // The phone has no room for the legend in the head: a line of its own.
      fw.after(el("div", { class: "legend tlegend", "data-box": "legend" }, ...[...lg.children].map((c) => c.cloneNode(true))));
    }
    if (M === "unknown") {
      fw.after(el("div", { class: "notice", "data-box": "notice" },
        el("b", {}, "No estimates yet"), ": 3 of the 5 finished steps they need. Only the set times are placed (NB's schedule, PL's usage window); the rest is in the order it may run."));
    }
  };

  // ---------------------------------------------------------------- a card as the dashboard draws it
  const face = (q) => [
    el("div", { class: "top" }, el("span", { class: "mono id" }, q.id),
      ...(VIEW === "lanes" ? [el("span", { class: "colw" }, columnTitle(rank.get(q.id)))] : []),
      ...(q.now ? [] : [el("span", { class: "after" }, "After…")])),
    el("div", { class: "title" }, q.title),
    ...(q.now ? [el("div", { class: `st tone-${q.now[0]}` }, q.now[1])] : []),
    ...(q.why ? [el("div", { class: `why tone-${q.why[0]}` }, q.why[1])] : []),
    ...(q.reviews ? [el("div", { class: "rv" }, ...(q.first ? [el("span", { class: "fw" }, "first wait for you"), " "] : []), q.reviews)] : []),
    ...(VIEW === "lanes" && q.also ? [el("div", { class: "also" }, `also ${q.also}: ST31`)] : []),
    ...(q.after?.length ? [chips(q)] : []), // lanes: hidden on the desktop (compact), kept on the phone (no lines there)
    el("div", { class: "estl" }, `about ${q.est} (estimate)`),
  ];
  const setup = () => { for (const q of QUEUES) Object.assign(q, EXTRA[q.id]); };

  // ---------------------------------------------------------------- critical path
  /** The longest chain of work by the dependencies and the estimates; a tie goes to the chain first in the plan's order. */
  const critical = () => {
    const dist = new Map(), from = new Map();
    const d = (id) => {
      if (!dist.has(id)) {
        let best = 0;
        for (const e of EDGES.filter((x) => x.to === id)) if (d(e.from) > best) { best = d(e.from); from.set(id, e.from); }
        dist.set(id, best + hours(byId.get(id)));
      }
      return dist.get(id);
    };
    const end = QUEUES.map((q) => q.id).sort((a, b) => d(b) - d(a))[0];
    const path = [end];
    while (from.has(path[0])) path.unshift(from.get(path[0]));
    return { path, hours: dist.get(end) };
  };
  const downstream = (ids) => {
    const out = new Set();
    const walk = (id) => { for (const e of EDGES.filter((x) => x.from === id)) if (!out.has(e.to)) { out.add(e.to); walk(e.to); } };
    ids.forEach(walk);
    return out;
  };

  if (M === "critical") {
    let cp;
    const on = () => (cp ??= critical());
    return {
      setup, face,
      page: () => { const c = on(); page(`Critical path: ${c.path.join(" → ")}, about ${c.hours} h of work by the dependencies (estimate). Waits for you, the limit on queues at once and checkouts are not in it.`); },
      card: (q, c) => c.classList.add(on().path.includes(q.id) ? "crit" : "dim"),
      edge: (e, p) => {
        const i = on().path.indexOf(e.from);
        if (i >= 0 && on().path[i + 1] === e.to) { p.classList.add("crit"); p.setAttribute("marker-end", "url(#arrow-crit)"); } else p.classList.add("dim");
      },
      desktop: ({ svg, bottom }) => {
        const m = svgEl("marker", { id: "arrow-crit", viewBox: "0 0 6 6", refX: "1", refY: "3", markerWidth: "5", markerHeight: "5", orient: "auto" }, svg.querySelector("defs"));
        svgEl("path", { d: "M0,0 L6,3 L0,6 z", class: "arrow-crit" }, m);
        return bottom;
      },
    };
  }

  // ---------------------------------------------------------------- what blocks
  if (M === "blocked") {
    // The roots: what waits for the user now (a review for them, an approval). PL waits for the usage window by
    // itself: not a root.
    const roots = { ST2: ["review", "Open ST21's review", "your review"], CH: ["approval", "Open the approval", "your approval"] };
    let heldSet; // once plan-mock.js has loaded (EDGES)
    const held = () => (heldSet ??= downstream(Object.keys(roots)));
    const by = (id) => Object.keys(roots).filter((r) => downstream([r]).has(id));
    return {
      setup, face,
      page: () => page(`What blocks: 2 queues wait for you and hold up ${held().size} more. PL waits for the usage window by itself (22:10).`),
      card: (q, c) => {
        if (roots[q.id]) {
          c.classList.add("block", `block-${roots[q.id][0]}`);
          c.querySelector(".estl").before(el("div", { class: "holds" }, `Holds up ${[...downstream([q.id])].join(", ")}`),
            el("div", { class: "acts" }, el("span", { class: "btn sm primary" }, roots[q.id][1])));
        } else if (held().has(q.id)) {
          c.classList.add("held");
          c.querySelector(".estl").before(el("div", { class: "heldby" }, `Held up by ${by(q.id).map((r) => `${r} (${roots[r][2]})`).join(", ")}`));
        } else c.classList.add("dim");
      },
      edge: (e, p) => { if (!(roots[e.from] || held().has(e.from)) || !held().has(e.to)) p.classList.add("dim"); },
    };
  }

  // ---------------------------------------------------------------- lanes by area
  const LANES = [
    { label: "dashboard · 6", columns: [["PL", "ST2"], ["IO", "ST2>ST3"], ["IO>DG", "ST3", "LG"], ["DG"]] },
    { label: "engine · 3", columns: [["MX"], ["RX"], ["TS"], []] },
    { label: "orchestrator · 2", columns: [[], ["MX>RA", "CH"], ["MX>RA"], ["RA"]] },
    { label: "no area · 1", columns: [[], ["NB"], [], []] },
  ];
  if (M === "lanes") {
    return {
      setup, face, bands: LANES, left: 30,
      page: () => page(HINT.lanes),
      card: (q, c) => c.classList.add("compact"),
      desktop: ({ host, W, L, bottom }) => {
        for (const b of L.bands) {
          host.prepend(el("div", { class: "band", style: `top:${b.top}px; height:${b.bottom - b.top}px; width:${W}px` }));
          host.append(el("div", { class: "lane", "data-box": `lane ${b.label}`, style: `top:${b.top}px; height:${b.bottom - b.top}px` }, b.label));
        }
        return Math.max(bottom, L.bands.at(-1).bottom);
      },
      // The phone: a group per lane, the cards in the plan's order, each saying its column.
      phone: ({ host, cards }) => {
        host.replaceChildren();
        for (const b of LANES) {
          host.append(el("h3", { class: "laneh", "data-box": `lane ${b.label}` }, b.label));
          for (let c = 0; c < b.columns.length; c++) for (const id of b.columns[c]) if (!id.includes(">")) host.append(cards.get(id));
        }
      },
    };
  }

  // ---------------------------------------------------------------- the time axis
  // Each queue: start and end (hours from now), by the dependencies and the estimates; `cond` from where it follows a
  // wait for the user (hatched from there); `marks` the steps that wait for the user's review; `wait` a wait Nexus
  // keeps by itself (the usage window); `note` what the row says.
  const T = {
    MX: { s: 0, e: 3.5, tone: "running", note: "running MX1, counted whole" },
    PL: { wait: [0, 1], s: 1, e: 3.5, note: "after the usage window (22:10)" },
    ST2: { s: 0, e: 2.5, cond: 0, marks: [0, 2.5 * 2 / 3], note: "if you review ST21 now" },
    RX: { s: 3.5, e: 5, note: "after MX" },
    IO: { s: 3.5, e: 7, cond: 3.5 + 3.5 * 3 / 4, marks: [3.5 + 3.5 * 3 / 4], note: "after PL; IO3 waits for your review" },
    CH: { s: 0, e: 2.5, cond: 0, note: "if you approve revision 2 now" },
    NB: { s: 50 / 60, e: 50 / 60 + 1.5, note: "starts at 22:00" },
    TS: { s: 5, e: 6.5, note: "after RX" },
    ST3: { s: 5, e: 6.5, cond: 5, note: "after RX, if ST2 is reviewed by then" },
    LG: { s: 2.5, e: 4, cond: 2.5, note: "after CH, once approved" },
    DG: { s: 7, e: 8.5, cond: 7, marks: [8.5], note: "after IO and ST3; DG2 waits for your review" },
    RA: { s: 4, e: 5.5, cond: 4, note: "after LG and MX" },
  };
  // Without estimates: only the set times; the rest named in its order.
  const U = {
    MX: { s: 0, open: "running", note: "running MX1", tone: "running" }, PL: { wait: [0, 1], s: 1, open: "from 22:10", note: "after the usage window (22:10)" },
    ST2: { s: 0, open: "if reviewed", note: "after your review of ST21", cond: true }, CH: { s: 0, open: "if approved", note: "after your approval", cond: true },
    NB: { s: 50 / 60, open: "at 22:00", note: "starts at 22:00" }, RX: { text: "after MX" }, IO: { text: "after PL" }, TS: { text: "after RX" },
    ST3: { text: "after RX and ST2" }, LG: { text: "after CH" }, DG: { text: "after ST3 and IO" }, RA: { text: "after LG and MX" },
  };
  /** An hour's label on the ruler; midnight names the new day (the clock: Monday 23 November, 21:10). */
  const tick = (hr, px) => (hr === 24
    ? el("span", { class: "tick day", style: `left:${(hr - NOW) * px - 4}px` }, "Tue 00:00")
    : el("span", { class: "tick", style: `left:${(hr - NOW) * px - 18}px` }, `${String(hr % 24).padStart(2, "0")}:00`));
  const SPAN = 9.5; // hours on the axis: 21:10 to 06:40, room for the last hour's label

  /** One row's marks on a track `px` wide per hour, `x0` the axis's left edge. */
  const rowMarks = (id, x0, px, top) => {
    const out = [];
    if (M === "unknown") {
      const u = U[id];
      if (u.wait) out.push(el("div", { class: "tl-wait", style: `left:${x0 + u.wait[0] * px}px; top:${top}px; width:${(u.wait[1] - u.wait[0]) * px - 2}px` }));
      if (u.open) out.push(el("div", { class: `tl-bar tl-open${u.cond ? " bar-maybe" : u.tone ? ` bar-${u.tone}` : ""}`, "data-box": `bar ${id}`, style: `left:${x0 + u.s * px}px; top:${top}px; width:${Math.min(2.6 * px, (SPAN - u.s) * px)}px` }, u.open));
      else out.push(el("div", { class: "tl-text", "data-box": `order ${id}`, style: `left:${x0 + 4}px; top:${top}px` }, `${u.text} · ?`));
      return out;
    }
    const w = T[id];
    if (w.wait) out.push(el("div", { class: "tl-wait", style: `left:${x0 + w.wait[0] * px}px; top:${top}px; width:${(w.wait[1] - w.wait[0]) * px - 2}px` }));
    const label = `${(w.e - w.s).toFixed(1).replace(".0", "")} h`;
    if (w.cond === undefined || w.cond > w.s) {
      const solidEnd = w.cond ?? w.e;
      out.push(el("div", { class: `tl-bar bar-${w.tone ?? "planned"}${w.cond !== undefined ? " cut-r" : ""}`, "data-box": `bar ${id}`, style: `left:${x0 + w.s * px}px; top:${top}px; width:${(solidEnd - w.s) * px}px` }, label));
    }
    if (w.cond !== undefined) {
      const from = Math.max(w.s, w.cond);
      out.push(el("div", { class: `tl-bar bar-maybe${from > w.s ? " cut-l" : ""}`, "data-box": `cond ${id}`, style: `left:${x0 + from * px}px; top:${top}px; width:${(w.e - from) * px}px` }, from > w.s ? "" : label));
    }
    for (const m of w.marks ?? []) out.push(el("i", { class: "tl-mark", style: `left:${x0 + m * px - 6}px; top:${top + 5}px` }));
    return out;
  };

  if (M === "time" || M === "unknown") {
    return {
      setup, face,
      page: () => page(HINT[M]),
      render: (host) => {
        const LABEL = 250, W = host.clientWidth, x0 = LABEL + 12, px = (W - x0 - 4) / SPAN;
        const ruler = el("div", { class: "ruler", "data-box": "ruler", style: `left:${x0}px; width:${W - x0}px` });
        host.append(ruler);
        const svg = svgEl("svg", { class: "grid" }, null);
        host.prepend(svg);
        // An hour too near now gives its label's room to "now".
        for (let hr = 22; hr <= 30; hr++) if ((hr - NOW) * px > 56) ruler.append(tick(hr, px));
        ruler.append(el("span", { class: "tick now", style: "left:0" }, `now ${clock(0)}`));
        let y = 34;
        for (const id of layoutA(new Map(QUEUES.map((q) => [q.id, 0]))).order.flat()) {
          const q = byId.get(id);
          const label = el("div", { class: "tl-label", "data-box": `label ${id}`, style: `top:${y}px; width:${LABEL}px` },
            el("span", { class: "mono fg3" }, id), " ", q.title, el("span", { class: "tl-note" }, M === "unknown" ? (U[id].note ?? `${U[id].text}; no estimate`) : T[id].note));
          host.append(label);
          const rowH = Math.max(label.offsetHeight, 26);
          host.append(...rowMarks(id, x0, px, y + Math.min(4, (rowH - 22) / 2)));
          y += rowH + 12;
        }
        svg.setAttribute("width", W); svg.setAttribute("height", y);
        for (let hr = 22; hr <= 30; hr++) svgEl("line", { x1: x0 + (hr - NOW) * px, x2: x0 + (hr - NOW) * px, y1: 26, y2: y - 6, class: "gl" }, svg);
        svgEl("line", { x1: x0, x2: x0, y1: 26, y2: y - 6, class: "gl now" }, svg);
        host.style.height = `${y}px`;
      },
      // The phone: the ruler on top, then per queue its title and its row on the same axis.
      phone: ({ host }) => {
        host.replaceChildren();
        const W = host.clientWidth, px = (W - 4) / SPAN;
        const ruler = el("div", { class: "truler", "data-box": "ruler" });
        host.append(ruler);
        for (let hr = 22; hr <= 30; hr += 2) if ((hr - NOW) * px > 40) ruler.append(tick(hr, px));
        ruler.append(el("span", { class: "tick now", style: "left:0" }, "now"));
        for (const id of layoutA(new Map(QUEUES.map((q) => [q.id, 0]))).order.flat()) {
          const q = byId.get(id);
          const row = el("div", { class: "trow" },
            el("div", { class: "tl-label", "data-box": `label ${id}` }, el("span", { class: "mono fg3" }, id), " ", q.title,
              el("span", { class: "tl-note" }, M === "unknown" ? (U[id].note ?? `${U[id].text}; no estimate`) : T[id].note)),
            el("div", { class: "ttrack" }, el("i", { class: "tnow" }), ...rowMarks(id, 0, px, 0)));
          host.append(row);
        }
      },
    };
  }

  return { setup, face, page: () => page(HINT.columns) };
})();
