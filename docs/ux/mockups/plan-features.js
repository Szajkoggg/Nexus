// The plan view's features (queue PL, step PL2) on layout A, the user's choice in PL1. Loaded before plan-mock.js, whose
// hooks it fills (PLAN_FEATURE); ?f=<feature> picks the state shown:
//   critical  the critical path: the chain the end of the plan depends on, by the estimates; the rest dimmed
//   blocked   "what blocks": the queues waiting for the user (a review, an approval), what they hold up, the rest dimmed
//   line      a line clicked: who set the dependency, when, and Remove or "Let the orchestrator decide" there
//   drag      dragging TS onto ST2: the drop target offers "after ST2 instead" and "also after ST2"
//   undo      after "also after ST2": the new line, and Undo for a few seconds
//   lanes     the queues in lanes by their area tag, the columns kept; compact cards (no "after" chips: the lines and
//             a click on one say the same), so three lanes fit the window
//   time      the time axis: each queue's expected start and end from the estimates (a view of its own: the columns
//             are not proportional to time)
//   folded    the finished queues folded into one line below the plan (the user, PL2 round 2: they stay at the bottom)
//   phone     at 390 px: the tools, the critical path, a tapped "after" chip's details, the finished line at the list's end
// Helpers (el, svgEl, EDGES, byId, rank…) are plan-mock.js's; the hooks run once it has loaded.

const PLAN_FEATURE = (() => {
  const f = new URLSearchParams(location.search).get("f") ?? "";
  const hours = (q) => parseFloat(q.est);
  const TOOLS = [["critical", "Critical path"], ["blocked", "What blocks · 2"], ["lanes", "Lanes by area"], ["time", "Time axis"]];

  /** The tools above the plan, the one shown on; the hint's text; the finished queues' line where asked. */
  const page = (hint, folded = false) => () => {
    const tools = document.querySelector(".tools");
    tools.prepend(el("div", { class: "toggles", "data-box": "tools" },
      ...TOOLS.map(([k, label]) => el("span", { class: `tg${k === f || (f === "phone" && k === "critical") ? " on" : ""}` }, label))));
    if (hint) document.querySelector(".plan-head .hint").textContent = hint;
    if (folded) {
      document.querySelector("section[aria-label='The plan']").append(el("div", { class: "folded", "data-box": "finished" },
        el("span", { class: "fg3" }, "▸"), el("b", {}, "Finished · 3"),
        ...Object.entries(DONE).map(([id, title]) => el("span", { class: "chip done", title }, el("span", { class: "mono" }, id))),
        el("span", { class: "fg3 show" }, "show")));
    }
  };

  /** The critical path: the longest chain by the estimates, ending where the plan ends. */
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
  const arrowCrit = (svg) => {
    const m = svgEl("marker", { id: "arrow-crit", viewBox: "0 0 6 6", refX: "1", refY: "3", markerWidth: "5", markerHeight: "5", orient: "auto" }, svg.querySelector("defs"));
    svgEl("path", { d: "M0,0 L6,3 L0,6 z", class: "arrow-crit" }, m);
  };

  if (f === "critical" || f === "phone") {
    let cp;
    const on = () => (cp ??= critical());
    return {
      page: () => {
        const c = on();
        page(`Critical path: ${c.path.join(" → ")}, about ${c.hours} h to the end (estimate).`, f === "phone")();
      },
      card: (q, c) => c.classList.add(on().path.includes(q.id) ? "crit" : "dim"),
      edge: (e, p) => {
        const i = on().path.indexOf(e.from);
        if (i >= 0 && on().path[i + 1] === e.to) { p.classList.add("crit"); p.setAttribute("marker-end", "url(#arrow-crit)"); } else p.classList.add("dim");
      },
      desktop: ({ svg, bottom }) => { arrowCrit(svg); return bottom; },
      phone: ({ host, cards }) => {
        // A tapped "after MX" chip on RX: who set it, when and why, and Remove there.
        const rx = cards.get("RX");
        rx.querySelector(".chip").classList.add("sel");
        rx.after(el("div", { class: "details", "data-box": "line details" },
          el("div", { class: "t" }, "RX after MX"),
          el("div", { class: "k" }, "Set by the orchestrator · 15 Nov, 16:10"),
          el("div", {}, "The run loop's split builds on MX's fixes in the engine."),
          el("div", { class: "acts" }, el("span", { class: "btn sm" }, "Remove"), el("span", { class: "btn sm ghost" }, "Close"))));
      },
    };
  }

  if (f === "blocked") {
    const waiting = { ST2: ["review", "Open the review"], CH: ["approval", "Approve revision 2"] };
    let heldSet;
    const held = () => (heldSet ??= downstream(Object.keys(waiting)));
    const after = (id) => [...downstream([id])].join(", ");
    return {
      page: () => page(`What blocks: 2 queues wait for you, and they hold up ${held().size} more.`)(),
      card: (q, c) => {
        if (waiting[q.id]) {
          c.classList.add("block", `block-${waiting[q.id][0]}`);
          c.append(el("div", { class: "holds" }, `Holds up ${after(q.id)}`), el("div", { class: "acts" }, el("span", { class: "btn sm primary" }, waiting[q.id][1])));
        } else c.classList.add(held().has(q.id) ? "held" : "dim");
      },
      edge: (e, p) => { if (!(waiting[e.from] || held().has(e.from)) || !held().has(e.to)) p.classList.add("dim"); },
    };
  }

  if (f === "line") {
    return {
      page: page("A line clicked: who set the dependency, and Remove there."),
      edge: (e, p, pts) => {
        if (e.key !== "ST2>ST3") { p.classList.add("faint"); return; }
        p.classList.add("sel");
        p.dataset.start = JSON.stringify(pts[0]);
      },
      desktop: ({ host, svg, x, colW, L, h, bottom }) => {
        const [sx, sy] = JSON.parse(svg.querySelector(".sel").dataset.start);
        svgEl("circle", { cx: sx + 9, cy: sy, r: 4.5, class: "pick" }, svg);
        const top = L.top.get("ST2") + h.get("ST2") + 12;
        const pop = el("div", { class: "pop", "data-box": "line details", style: `left:${x(0)}px; top:${top}px; width:${colW}px` },
          el("div", { class: "t" }, "ST3 after ST2"),
          el("div", { class: "k" }, "Set by you · 15 Nov, 14:20"),
          el("div", {}, "ST3 starts when ST2 is done (and RX, set by the orchestrator)."),
          el("div", { class: "acts col" }, el("span", { class: "btn sm danger" }, "Remove"), el("span", { class: "btn sm" }, "Let the orchestrator decide")));
        host.append(pop);
        return Math.max(bottom, pop.offsetTop + pop.offsetHeight);
      },
    };
  }

  if (f === "drag") {
    return {
      page: page("Drag a queue onto another: after it instead, or also after it."),
      card: (q, c) => {
        if (q.id === "TS") c.classList.add("moving");
        if (q.id === "ST2") {
          c.classList.add("target");
          c.append(el("div", { class: "drop" }, el("div", { class: "zone" }, "After ST2 instead of RX"), el("div", { class: "zone on" }, "Also after ST2 (and RX)")));
        }
      },
      desktop: ({ host, x, colW, L, h, bottom }) => {
        const top = L.top.get("ST2") + h.get("ST2") + 14;
        const g = el("div", { class: "pc ghost", "data-box": "dragged TS", style: `left:${x(0) + 24}px; top:${top}px; width:${colW - 24}px` },
          el("div", { class: "top" }, el("span", { class: "mono id" }, "TS"), el("span", { class: "est" }, "moving")),
          el("div", { class: "title" }, byId.get("TS").title));
        host.append(g);
        return Math.max(bottom, g.offsetTop + g.offsetHeight);
      },
    };
  }

  if (f === "undo") {
    return {
      setup: () => {
        QUEUES.find((q) => q.id === "TS").after.push(["ST2", "user"]);
        A_COLUMNS[1].splice(A_COLUMNS[1].indexOf("ST2>ST3"), 0, "ST2>TS");
      },
      page: page("TS now also waits for ST2."),
      edge: (e, p) => { if (e.key === "ST2>TS") p.classList.add("new"); },
      desktop: ({ host, W, bottom }) => {
        const t = el("div", { class: "toast", "data-box": "undo", style: `left:0; top:${bottom + 14}px; width:${Math.min(W, 460)}px` },
          el("span", { class: "grow" }, "TS now also waits for ST2 (set by you)."), el("span", { class: "btn sm" }, "Undo"), el("span", { class: "fg3 secs" }, "4 s"),
          el("i", { class: "bar" }));
        host.append(t);
        return t.offsetTop + t.offsetHeight;
      },
    };
  }

  if (f === "lanes") {
    return {
      bands: [
        { label: "dashboard · 6", columns: [["PL", "ST2"], ["IO", "ST2>ST3"], ["IO>DG", "ST3", "LG"], ["DG"]] },
        { label: "engine · 4", columns: [["MX"], ["RX", "NB"], ["TS"], []] },
        { label: "orchestrator · 2", columns: [[], ["MX>RA", "CH"], ["MX>RA"], ["RA"]] },
      ],
      left: 30,
      page: page("Lanes by area tag; the chips are left to a click on a line."),
      card: (q, c) => c.classList.add("compact"),
      desktop: ({ host, W, L, bottom }) => {
        for (const b of L.bands) {
          host.prepend(el("div", { class: "band", style: `top:${b.top}px; height:${b.bottom - b.top}px; width:${W}px` }));
          host.append(el("div", { class: "lane", "data-box": `lane ${b.label}`, style: `top:${b.top}px; height:${b.bottom - b.top}px` }, b.label));
        }
        return Math.max(bottom, L.bands.at(-1).bottom);
      },
    };
  }

  if (f === "time") {
    return {
      page: () => {
        page("Expected start and end from the statistics (step durations by tag); hatched: once CH is approved.")();
        document.querySelector(".legend").remove(); // no lines here
      },
      render: (host) => {
        // When each queue is expected: now's queues end after what is left of them; a planned one starts when the
        // last of its predecessors ends (NB at 22:00); CH waits for approval, so it and what follows it are "if
        // approved now" (hatched).
        const NOW = 21 + 10 / 60, when = new Map();
        const at = (id) => {
          if (!when.has(id)) {
            const q = byId.get(id), preds = EDGES.filter((e) => e.to === id).map((e) => at(e.from));
            const start = q.now ? 0 : q.id === "NB" ? 22 - NOW : Math.max(0, ...preds.map((p) => p.end));
            when.set(id, { start, end: start + hours(q), maybe: q.why?.[0] === "approval" || preds.some((p) => p.maybe) });
          }
          return when.get(id);
        };
        const LABEL = 250, W = host.clientWidth, span = 8.5, px = (W - LABEL - 12) / span, bx = (t) => LABEL + 12 + t * px;
        const ruler = el("div", { class: "ruler", "data-box": "ruler", style: `left:${LABEL + 12}px; width:${W - LABEL - 12}px` });
        host.append(ruler);
        const svg = svgEl("svg", { class: "grid" }, null);
        host.prepend(svg);
        for (let hr = 22; hr <= 29; hr++) {
          const t = hr - NOW;
          ruler.append(el("span", { class: "tick", style: `left:${t * px - 18}px` }, `${String(hr % 24).padStart(2, "0")}:00`));
        }
        ruler.append(el("span", { class: "tick now", style: "left:0" }, "now"));
        let y = 34;
        const order = layoutA(new Map(QUEUES.map((q) => [q.id, 0]))).order.flat();
        for (const id of order) {
          const q = byId.get(id), w = at(id);
          const label = el("div", { class: "tl-label", "data-box": `label ${id}`, style: `top:${y}px; width:${LABEL}px` }, el("span", { class: "mono fg3" }, id), " ", q.title);
          host.append(label);
          const rowH = Math.max(label.offsetHeight, 26);
          const tone = q.now ? q.now[0] : w.maybe ? "maybe" : "planned";
          const bar = el("div", { class: `tl-bar bar-${tone}`, "data-box": `bar ${id}`, style: `left:${bx(w.start)}px; top:${y + (rowH - 22) / 2}px; width:${(w.end - w.start) * px}px` },
            id === "CH" ? "if approved now" : q.est);
          host.append(bar);
          y += rowH + 10;
        }
        svg.setAttribute("width", W); svg.setAttribute("height", y);
        for (let hr = 22; hr <= 29; hr++) svgEl("line", { x1: bx(hr - NOW), x2: bx(hr - NOW), y1: 26, y2: y - 6, class: "gl" }, svg);
        svgEl("line", { x1: bx(0), x2: bx(0), y1: 26, y2: y - 6, class: "gl now" }, svg);
        host.style.height = `${y}px`;
      },
    };
  }

  if (f === "folded") return { page: page("The finished queues are folded into one line below the plan.", true) };
  return {};
})();
