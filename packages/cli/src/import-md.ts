// One-time import of queues written as Markdown: a section per queue with a table of steps.
// Recognises the shapes in use (Project Honeycomb's docs/QUEUE.md and Dev/Workflow/QUEUE.md) by their table headers,
// not by project. What it cannot place goes into the queue's description, so nothing is lost.
import type { QueueFile, QueueStatus, StepDef, StepStatus } from "@nexus/protocol";

export interface ImportResult {
  queues: QueueFile[];
  skipped: { heading: string; reason: string }[];
  defaultStopConditions: string[];
}

interface Section { heading: string; level: number; lines: string[] }

export function importMarkdownQueues(md: string, opts: { source: string; prefix?: string; now: string }): ImportResult {
  const lines = md.replaceAll("\r\n", "\n").split("\n");
  const sections = splitSections(lines);
  const result: ImportResult = { queues: [], skipped: [], defaultStopConditions: [] };

  // The common stop conditions, written before the first queue as "**Stop conditions every queue has**: a; b; c."
  const preface = sections.filter((s) => s.level <= 1).map((s) => s.lines.join("\n")).join("\n");
  const common = /\*\*Stop conditions[^*]*\*\*:?\s*([\s\S]*?)(?:\n\s*\n|\n- |$)/i.exec(preface);
  if (common?.[1]) result.defaultStopConditions = splitTopLevel(oneLine(common[1]), ";").map(cleanSentence).filter(Boolean);

  for (const s of sections) {
    const table = findStepTable(s.lines);
    if (!table) {
      if (s.level === 2) result.skipped.push({ heading: s.heading, reason: "no step table" });
      continue;
    }
    result.queues.push(buildQueue(s, table, opts));
  }
  return result;
}

// ---------------------------------------------------------------- sections and paragraphs

function splitSections(lines: string[]): Section[] {
  const out: Section[] = [{ heading: "", level: 0, lines: [] }];
  let fence = false;
  for (const line of lines) {
    if (/^```/.test(line)) fence = !fence;
    const h = fence ? null : /^(#{1,2})\s+(.*)$/.exec(line);
    if (h) out.push({ heading: (h[2] ?? "").trim(), level: (h[1] ?? "").length, lines: [] });
    else out.at(-1)!.lines.push(line);
  }
  return out;
}

function paragraphs(lines: string[]): string[][] {
  const out: string[][] = [];
  let cur: string[] = [];
  for (const l of lines) {
    if (l.trim() === "") { if (cur.length) out.push(cur); cur = []; } else cur.push(l);
  }
  if (cur.length) out.push(cur);
  return out;
}

const oneLine = (s: string) => s.replace(/\s*\n\s*/g, " ").trim();
const cleanSentence = (s: string) => s.trim().replace(/^and\s+/i, "").replace(/\.$/, "").trim().replace(/^\w/, (c) => c.toUpperCase());

/** Splits on a separator outside parentheses, brackets and backticks. */
function splitTopLevel(s: string, sep: string): string[] {
  const out: string[] = []; let depth = 0; let code = false; let cur = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === "`") code = !code;
    else if (!code && (c === "(" || c === "[")) depth++;
    else if (!code && (c === ")" || c === "]")) depth = Math.max(0, depth - 1);
    if (!code && depth === 0 && s.startsWith(sep, i)) { out.push(cur); cur = ""; i += sep.length - 1; continue; }
    cur += c;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

// ---------------------------------------------------------------- the step table

interface Table { start: number; end: number; cols: { id?: number; step: number; acceptance?: number; status?: number }; rows: string[][] }

function cells(line: string): string[] {
  const inner = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return splitTopLevel(inner.replaceAll("\\|", "\u0000"), "|").map((c) => c.replaceAll("\u0000", "|"));
}

function findStepTable(lines: string[]): Table | null {
  for (let i = 0; i + 1 < lines.length; i++) {
    if (!lines[i]!.trim().startsWith("|") || !/^\s*\|?\s*:?-{3,}/.test(lines[i + 1]!)) continue;
    const header = cells(lines[i]!).map((h) => h.toLowerCase());
    const step = header.findIndex((h) => h === "step" || h.startsWith("step"));
    if (step < 0) continue;
    const id = header.findIndex((h) => h === "#" || h === "id");
    const acceptance = header.findIndex((h) => /done when|acceptance|criteria/.test(h));
    const status = header.findIndex((h) => h === "status" || h === "state");
    const rows: string[][] = [];
    let j = i + 2;
    for (; j < lines.length && lines[j]!.trim().startsWith("|"); j++) rows.push(cells(lines[j]!));
    return {
      start: i, end: j,
      cols: { step, id: id >= 0 ? id : undefined, acceptance: acceptance >= 0 ? acceptance : undefined, status: status >= 0 ? status : undefined },
      rows,
    };
  }
  return null;
}

// ---------------------------------------------------------------- one queue

function buildQueue(s: Section, table: Table, opts: { source: string; prefix?: string; now: string }): QueueFile {
  const { id: rawId, title, branch, aside } = parseHeading(s.heading);
  const id = (opts.prefix ?? "") + rawId;

  const before = s.lines.slice(0, table.start);
  const after = s.lines.slice(table.end);
  let statusPara: string | undefined;
  const description: string[] = [];
  const checks: string[] = [];
  const stops: string[] = [];

  const pre = paragraphs(before);
  for (const p of pre) {
    const text = p.join("\n");
    if (!statusPara && /^\*\*Status/i.test(text)) statusPara = oneLine(text);
    else description.push(text);
  }
  const post = paragraphs(after);
  for (let k = 0; k < post.length; k++) {
    const p = post[k]!;
    const text = oneLine(p.join("\n"));
    if (/^Checks\b[^:]*:/i.test(text)) { checks.push(capitalize(text.replace(/^Checks\b[^:]*:\s*/i, ""))); continue; }
    if (/^Stop conditions\b/i.test(text) || /^Stop (at|when|if)\b/i.test(text)) {
      const bullets = p.filter((l) => /^\s*- /.test(l));
      const items = bullets.length ? collectBullets(p) : [text];
      // Bullets may be in the next paragraph when a blank line follows the lead-in.
      if (!bullets.length && /:\s*$/.test(text) && post[k + 1]?.every((l) => /^\s*(- |\s)/.test(l))) {
        stops.push(...collectBullets(post[k + 1]!)); k++;
      } else stops.push(...items);
      continue;
    }
    description.push(p.join("\n"));
  }
  if (aside) description.unshift(`(${aside})`);

  const steps = table.rows.map((r) => buildStep(r, table.cols, opts.prefix ?? "")).filter((x): x is StepDef => !!x);
  const sectionText = s.lines.join("\n");
  const status = queueStatus(statusPara, steps, sectionText);
  if (status === "done") {
    for (const st of steps) {
      if (!st.status) { st.status = "done"; st.status_note = "Assumed at import: the queue is done and the table gives this step no state."; }
    }
  }

  return {
    protocol: 1,
    id,
    title,
    track: rawId,
    description: description.join("\n\n").trim() || undefined,
    worktree: undefined,
    branch,
    base: undefined,
    revision: 1,
    status,
    status_note: statusPara?.replace(/^\*\*Status:?\s*/i, "").replace(/\*\*/g, ""),
    review_level: undefined,
    stop_conditions: stops,
    checks,
    steps,
    approvals: [],
    withdrawals: [],
    history: [],
    changes: [],
    source: { path: opts.source, imported_at: opts.now },
    created_at: opts.now,
    updated_at: opts.now,
  };
}

function collectBullets(lines: string[]): string[] {
  const out: string[] = [];
  for (const l of lines) {
    if (/^\s*- /.test(l)) out.push(l.replace(/^\s*- /, ""));
    else if (out.length) out[out.length - 1] += " " + l.trim();
  }
  return out.map((x) => x.trim());
}

function parseHeading(h: string): { id: string; title: string; branch?: string; aside?: string } {
  let rest = h.trim();
  let aside: string | undefined;
  const paren = /\s*\(([^()]*(?:\([^()]*\)[^()]*)*)\)\s*$/.exec(rest);
  if (paren) { aside = paren[1]; rest = rest.slice(0, paren.index).trim(); }
  const branch = aside ? /branch\s+`([^`]+)`/.exec(aside)?.[1] : undefined;
  if (branch && aside && /^branch\s+`[^`]+`$/.test(aside.trim())) aside = undefined;

  const track = /^(?:Track|Queue)\s+([\w.-]+)\s*[:—-]\s*(.+)$/i.exec(rest);
  if (track) return { id: track[1]!, title: capitalize(track[2]!), branch, aside };
  const tail = /^(.*?\b(?:queue|track))\s+([\w.-]+)$/i.exec(rest); // "Workflow queue W"
  if (tail) return { id: tail[2]!, title: rest, branch, aside };
  return { id: rest.replace(/[^\w.-]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "Q", title: rest, branch, aside };
}

const capitalize = (s: string) => s.replace(/^\w/, (c) => c.toUpperCase());

function buildStep(row: string[], cols: Table["cols"], prefix: string): StepDef | null {
  const stepCell = (row[cols.step] ?? "").trim();
  if (!stepCell) return null;
  let id = cols.id !== undefined ? (row[cols.id] ?? "").trim() : "";
  let cell = stepCell;
  if (!id) {
    const m = /^([A-Z]+\d+\w*)\s+(.*)$/.exec(cell); // "W1 Current decisions and handoffs"
    if (m) { id = m[1]!; cell = m[2]!; }
  }
  if (!id) return null;

  let title: string; let body: string;
  const bold = /^\*\*(.+?)\*\*\s*(.*)$/.exec(cell);
  if (bold) { title = bold[1]!.replace(/[.:]\s*$/, ""); body = bold[2]!; }
  else { title = cell; body = ""; }

  // A state sentence right after the title: "Done 2026-11-12 (...)", "Built 2026-11-12, ... (stopped)."
  let statusNote: string | undefined;
  const aside = /^\(([^()]*)\)\.?\s*/.exec(body); // "(the user's choice). Done ..."
  if (aside) { title += ` (${aside[1]})`; body = body.slice(aside[0].length); }
  const lead = /^((?:Done|Built|Sent|Sheets? sent|Answered|Met|Stopped|Parked)\b[^]*?)(?:\.\s+(?=\*\*|[A-Z])|$)/.exec(body);
  if (lead) {
    statusNote = lead[1]!.trim();
    body = body.slice(lead[0].length).trim();
    const again = new RegExp(`^\\*\\*${escapeRe(title)}\\.?\\*\\*\\s*`); // the title repeated after the note
    body = body.replace(again, "");
  }

  const acceptanceCell = cols.acceptance !== undefined ? (row[cols.acceptance] ?? "").trim() : "";
  const statusCell = cols.status !== undefined ? (row[cols.status] ?? "").trim() : "";
  const status = stepStatus(statusNote, acceptanceCell, statusCell);
  if (!statusNote && statusCell) statusNote = statusCell;

  return {
    id: prefix + id,
    title,
    goal: body,
    acceptance: acceptanceCell ? splitTopLevel(acceptanceCell, ";").map((x) => x.trim()) : [],
    review: undefined,
    status,
    status_note: statusNote,
  };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function stepStatus(note: string | undefined, acceptance: string, statusCell: string): StepStatus | undefined {
  const cell = statusCell.toLowerCase();
  if (cell) {
    if (cell.startsWith("done")) return "done";
    if (cell.startsWith("running") || cell.startsWith("in progress")) return "running";
    if (cell.startsWith("wait") || cell.startsWith("blocked")) return "waiting";
    if (cell.startsWith("stopped")) return "stopped";
    if (cell.startsWith("failed")) return "failed";
    if (cell.startsWith("skipped")) return "skipped";
    return "pending";
  }
  if (note) {
    if (/\(stopped\)|\bstopped\b/i.test(note)) return "stopped";
    return "done";
  }
  if (/^(Done|Met)\b/.test(acceptance)) return "done";
  return undefined;
}

function queueStatus(statusPara: string | undefined, steps: StepDef[], sectionText: string): QueueStatus {
  const head = (statusPara ?? "").replace(/^\*\*Status:?\s*/i, "").split("**")[0]!.toLowerCase();
  if (head) {
    if (/^stopped/.test(head)) return "stopped";
    if (/^running/.test(head)) return "running";
    if (/^done/.test(head)) return "done";
    if (/^parked|^paused/.test(head)) return "paused";
    if (/^proposed/.test(head)) return "proposed";
    if (/^approved/.test(head)) return "approved";
    if (/\bwait/.test(head)) return "waiting";
    if (/^cancel/.test(head)) return "cancelled";
  }
  const st = steps.map((x) => x.status ?? "pending");
  if (st.length && st.every((x) => x === "done" || x === "skipped")) return "done";
  if (st.includes("stopped")) return "stopped";
  if (st.includes("waiting")) return "waiting";
  if (st.includes("running")) return "running";
  return /approved by the user/i.test(sectionText) ? "approved" : "proposed";
}
