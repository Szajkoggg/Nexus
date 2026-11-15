// Searching a project's whole history (queue SR; docs/PROTOCOL.md, "Searching a project"): the queues, the steps'
// outcomes, questions and answers, the chats, the reports, the review comments and the step notes. No index: the
// server reads the files (apps/server/src/search.ts) and these pure functions decide what an entry offers, whether it
// matches and what the hit shows. Matching ignores case and accents; with several words, an item matches when it
// holds every one of them (anywhere, in any order).
import { fold } from "./chat.ts";
import type { ChatEntry, Event, Note, QueueFile } from "./schemas.ts";

/** What can be searched, each a filter of its own. */
export const SEARCH_KINDS = ["queue", "step", "question", "chat", "report", "review", "note"] as const;
export type SearchKind = (typeof SEARCH_KINDS)[number];

/** How many hits a search answers when it names no limit, and the most it may ask for. */
const SEARCH_LIMIT = 50;
const SEARCH_MAX_LIMIT = 500;
/** The longest query taken, in characters. */
const MAX_QUERY = 200;

/**
 * Something searchable: its text and where it is. `queue`/`step` name the step it belongs to (a step's goal, outcome,
 * question, review comment or note); `session` and `line` a chat message (its line in chat.jsonl, from 0, as CH4's
 * views number them); `path` a report's file; `qid` an answer's question (the server fills in its queue and step).
 * `tool`: a chat's tool line, searched only when asked.
 */
export interface SearchItem {
  kind: SearchKind;
  at: string;
  text: string;
  queue?: string;
  step?: string;
  session?: string;
  line?: number;
  path?: string;
  qid?: string;
  /** Who wrote it, where that is known: a chat's `from`, a note's author, `user` for the user's review comments. */
  from?: string;
  /** What the dashboard names the place by: the queue's or the conversation's title. */
  title?: string;
  tool?: boolean;
}

/** A hit as the API sends it: the item without its whole text, with an excerpt and the matches in it. */
export type SearchHit = Omit<SearchItem, "text" | "tool"> & { excerpt: string; ranges: [number, number][] };

/** A search's answer: the newest hits first; `total` counts every match, `more` says there were more than sent. */
export interface SearchResult { hits: SearchHit[]; total: number; more: boolean }

/** A search as asked: the folded words, the kinds searched, from when, how many hits, and whether tool lines count. */
export interface SearchQuery {
  terms: string[];
  kinds: readonly SearchKind[];
  since?: string;
  limit: number;
  tools: boolean;
}

/** A search the server refuses (400), with what was wrong. */
export class SearchError extends Error {}

/**
 * Text as matched: accents dropped, lower case. The same folding as the chat's `fold` (character by character), so an
 * excerpt's highlights land where the match was; a final sigma is folded to σ, as `fold` folds a capital Σ.
 */
export function foldText(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replaceAll("ς", "σ");
}

/** A query's words, folded, without repeats; empty when it has none. */
export function searchTerms(query: string): string[] {
  return [...new Set(foldText(query).split(/\s+/).filter(Boolean))];
}

/**
 * A search from the request's parameters: `q` the words (required), `kinds` a comma-separated list (every kind when
 * missing), `since` a time (ISO 8601), `limit` a whole number up to SEARCH_MAX_LIMIT, `tools` "1" for tool lines.
 * Throws SearchError with what was wrong.
 */
export function parseSearch(p: { q?: string; kinds?: string; since?: string; limit?: string; tools?: string }): SearchQuery {
  const q = p.q ?? "";
  if (q.length > MAX_QUERY) throw new SearchError(`q: at most ${MAX_QUERY} characters`);
  const terms = searchTerms(q);
  if (!terms.length) throw new SearchError("q: the words to search for");
  let kinds: SearchKind[] = [...SEARCH_KINDS];
  if (p.kinds !== undefined && p.kinds.trim() !== "") {
    const asked = p.kinds.split(",").map((k) => k.trim()).filter(Boolean);
    const unknown = asked.filter((k) => !(SEARCH_KINDS as readonly string[]).includes(k));
    if (unknown.length) throw new SearchError(`kinds: ${unknown.join(", ")} unknown; one or more of ${SEARCH_KINDS.join(", ")}`);
    kinds = SEARCH_KINDS.filter((k) => asked.includes(k));
  }
  let since: string | undefined;
  if (p.since !== undefined && p.since !== "") {
    const t = Date.parse(p.since);
    if (Number.isNaN(t)) throw new SearchError("since: a time (ISO 8601, e.g. 2026-11-14 or 2026-11-14T10:00:00Z)");
    since = new Date(t).toISOString();
  }
  let limit = SEARCH_LIMIT;
  if (p.limit !== undefined && p.limit !== "") {
    limit = Number(p.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > SEARCH_MAX_LIMIT) throw new SearchError(`limit: a whole number from 1 to ${SEARCH_MAX_LIMIT}`);
  }
  return { terms, kinds, since, limit, tools: p.tools === "1" };
}

/** Characters JSON writes escaped: a word with one of them cannot be looked for in a raw line. */
const ESCAPED = /["\\\u0000-\u001f]/u;

/**
 * Whether a raw JSONL line may hold a match: every word occurs in it somewhere (keys included). A quick test before
 * the line is parsed; it never says no to a line that matches (a word JSON would escape is not tested).
 */
export function lineMayMatch(raw: string, q: SearchQuery): boolean {
  const f = foldText(raw);
  return q.terms.every((t) => ESCAPED.test(t) || f.includes(t));
}

/** Whether an item is a hit: its kind is searched, it is not older than `since`, a tool line only with `tools`, every word in it. */
export function itemMatches(item: SearchItem, q: SearchQuery): boolean {
  if (!q.kinds.includes(item.kind)) return false;
  if (item.tool && !q.tools) return false;
  if (q.since && Date.parse(item.at) < Date.parse(q.since)) return false;
  const f = foldText(item.text);
  return q.terms.every((t) => f.includes(t));
}

/**
 * An item's text as one short line around its first match: whitespace collapsed, at most about `width` characters,
 * cut at word boundaries with "…" where text is left out; `ranges` are where the words occur in it ([start, end) of
 * the excerpt, in order, not overlapping), for the highlight.
 */
export function searchExcerpt(text: string, terms: readonly string[], width = 160): { excerpt: string; ranges: [number, number][] } {
  const flat = text.replace(/\s+/g, " ").trim();
  const { folded, map } = fold(flat);
  const first = Math.min(...terms.map((t) => folded.indexOf(t)).filter((i) => i >= 0), Number.MAX_SAFE_INTEGER);
  const at = first === Number.MAX_SAFE_INTEGER ? 0 : map[first]!;
  let start = 0, end = flat.length;
  if (flat.length > width) {
    // The first match about a third of the way in, so the words before it give it context.
    start = Math.max(0, Math.min(at - Math.floor(width / 3), flat.length - width));
    end = Math.min(flat.length, start + width);
    if (start > 0) { const sp = flat.indexOf(" ", start); if (sp >= 0 && sp < at) start = sp + 1; }
    if (end < flat.length) { const sp = flat.lastIndexOf(" ", end); if (sp > start && sp > at) end = sp; }
  }
  const lead = start > 0 ? "…" : "";
  const excerpt = `${lead}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`;
  // Every occurrence of every word in the shown part, merged where they touch or overlap.
  const found: [number, number][] = [];
  for (const t of terms) {
    for (let i = folded.indexOf(t); i >= 0; i = folded.indexOf(t, i + 1)) {
      const s = map[i]!, e = map[i + t.length]!;
      if (s >= start && e <= end) found.push([s - start + lead.length, e - start + lead.length]);
    }
  }
  found.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const ranges: [number, number][] = [];
  for (const r of found) {
    const last = ranges.at(-1);
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else ranges.push([r[0], r[1]]);
  }
  return { excerpt, ranges };
}

/** What a queue offers: its title and description (one item), and each step's title and goal (one item each). */
export function queueItems(q: QueueFile): SearchItem[] {
  const at = q.updated_at ?? q.created_at ?? "1970-01-01T00:00:00.000Z";
  const title = q.title;
  return [
    { kind: "queue", at, queue: q.id, title, text: `${q.title}\n${q.description}` },
    ...q.steps.map((s): SearchItem => ({ kind: "queue", at, queue: q.id, step: s.id, title, text: `${s.title}\n${s.goal}` })),
  ];
}

/**
 * What an event offers: a step's outcome (done, failed, the queue's stop), a question or an answer, a review comment
 * the user (or the orchestrator holding the review) wrote; nothing for the rest. An answer names only its question
 * (`qid`).
 */
export function eventItems(e: Event): SearchItem[] {
  const where = { at: e.at, session: e.session };
  if (e.type === "step.done") return [{ kind: "step", ...where, queue: e.queue, step: e.step, text: e.summary }];
  if (e.type === "step.failed") return [{ kind: "step", ...where, queue: e.queue, step: e.step, text: e.reason }];
  if (e.type === "queue.stop") return [{ kind: "step", ...where, queue: e.queue, step: e.step, text: `${e.condition}
${e.reason}` }];
  if (e.type === "question.asked") return [{ kind: "question", ...where, queue: e.queue, step: e.step, qid: e.qid, text: e.text }];
  if (e.type === "answer.given") return [{ kind: "question", ...where, qid: e.qid, text: e.text }];
  if (e.type === "review.accepted" || e.type === "review.sent_back" || e.type === "review.rejected" || e.type === "review.commented"
    || e.type === "review.asked_user" || e.type === "review.provisional" || e.type === "review.fix_asked") {
    return e.text ? [{ kind: "review", ...where, queue: e.queue, step: e.step, text: e.text }] : [];
  }
  return [];
}

/** A chat message as an item: the session's chat, its line in chat.jsonl; a tool line marked as one. */
export function chatItem(entry: ChatEntry, session: string, line: number, title?: string): SearchItem {
  return { kind: "chat", at: entry.at, session, line, from: entry.from, title, text: entry.text, ...(entry.kind === "tool" ? { tool: true } : {}) };
}

/** A step note as an item. */
export function noteItem(n: Note): SearchItem {
  return { kind: "note", at: n.at, queue: n.queue, step: n.step, from: n.from, text: n.body };
}

/**
 * The hits of a search as they are found, keeping only the newest `limit` (and the count of all): memory stays bounded
 * however many items match. `result` makes the excerpts, newest first.
 */
export class SearchHits {
  private kept: SearchItem[] = [];
  total = 0;
  private readonly q: SearchQuery;
  constructor(q: SearchQuery) { this.q = q; }
  /** Takes an item if it is a hit; says whether it was. */
  add(item: SearchItem): boolean {
    if (!itemMatches(item, this.q)) return false;
    this.total++;
    this.kept.push(item);
    if (this.kept.length >= this.q.limit * 2) this.trim();
    return true;
  }
  /** The items kept, newest first (for filling in what the server learns at the end, an answer's question). */
  items(): SearchItem[] { this.trim(); return this.kept; }
  private trim(): void {
    this.kept.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    this.kept.length = Math.min(this.kept.length, this.q.limit);
  }
  result(): SearchResult {
    const hits = this.items().map(({ text, tool: _tool, ...rest }): SearchHit => ({ ...rest, ...searchExcerpt(text, this.q.terms) }));
    return { hits, total: this.total, more: this.total > hits.length };
  }
}
