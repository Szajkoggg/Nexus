// Searching a project's whole history (queue SR; docs/protocol/api.md, "Searching a project"), without an index; the
// protocol's pure functions (packages/protocol/src/search.ts) decide what each entry offers and whether it is a hit.
// The queues, notes and events come from the store (the server's model: queue SM, docs/design/model.md); the chats,
// logs the model keeps only once opened, are read from their files line by line in chunks (memory stays small however
// long a log is), a line parsed only when every word occurs in it raw, a file not changed since `since` not read. Only
// the newest `limit` hits are kept.
import { errorText } from "@nexus/protocol/errors";
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import {
  ChatEntry, SearchHits, chatItem, eventItems, lineMayMatch, normPath, noteItem, queueItems,
  type ProjectStore, type SearchKind, type SearchQuery, type SearchResult, type SessionFile,
} from "@nexus/protocol";

const CHUNK = 64 * 1024;

/**
 * Calls `each` with every complete line of a file and its index (from 0); a last line without its newline is still
 * being written and is left out, as readJsonl does. A missing file has no lines.
 */
function eachLine(file: string, each: (line: string, index: number) => void): void {
  let fd: number;
  try { fd = openSync(file, "r"); } catch { return; }
  try {
    const buf = Buffer.alloc(CHUNK);
    const decoder = new StringDecoder("utf8");
    let rest = "", index = 0;
    for (let n = readSync(fd, buf, 0, CHUNK, null); n > 0; n = readSync(fd, buf, 0, CHUNK, null)) {
      const parts = (rest + decoder.write(buf.subarray(0, n))).split("\n");
      rest = parts.pop()!;
      for (const line of parts) each(line, index++);
    }
  } finally { closeSync(fd); }
}

/** Whether a file may hold something newer than `since`: it exists and was written at or after it. */
function changedSince(file: string, since: string | undefined): boolean {
  try { return !since || statSync(file).mtimeMs >= Date.parse(since); } catch { return false; }
}

function parsed<T>(line: string, schema: { safeParse(x: unknown): { success: true; data: T } | { success: false } }): T | undefined {
  try { const r = schema.safeParse(JSON.parse(line)); return r.success ? r.data : undefined; } catch { return undefined; }
}

/** Searches a project's queues, notes, reports, events and chats; the newest hits first. */
export function searchProject(store: ProjectStore, q: SearchQuery): SearchResult {
  const hits = new SearchHits(q);
  const wants = (kind: SearchKind) => q.kinds.includes(kind);
  const questions = wants("question");

  for (const id of store.queueIds()) {
    if (wants("queue")) {
      try { for (const item of queueItems(store.readQueue(id))) hits.add(item); } catch (e) { console.warn(`nexus: search: ${errorText(e)}; the queue offers nothing`); }
    }
    const report = join(store.queueDir(id), "report.md");
    if (wants("report") && existsSync(report) && changedSince(report, q.since)) {
      const text = readFileSync(report, "utf8");
      hits.add({ kind: "report", at: statSync(report).mtime.toISOString(), queue: id, path: normPath(report), text });
    }
    if (wants("note")) for (const n of store.readNotes(id).notes) hits.add(noteItem(n));
  }

  // An answer names only its question: where each question was asked (every one, matching or not).
  const asked = new Map<string, { queue?: string; step?: string }>();
  const events = questions || wants("step") || wants("review");
  for (const id of store.sessionIds()) {
    const dir = store.sessionDir(id);
    if (events) {
      for (const e of store.readEvents(id).entries) {
        if (e.type === "question.asked") asked.set(e.qid, { queue: e.queue, step: e.step });
        for (const item of eventItems(e)) hits.add(item);
      }
    }
    if (wants("chat")) {
      const file = join(dir, "chat.jsonl");
      if (!changedSince(file, q.since)) continue;
      let s: SessionFile;
      try { s = store.readSession(id); } catch (e) { console.warn(`nexus: search: ${errorText(e)}; its chat is left out`); continue; }
      if (s.role !== "orchestrator" && s.role !== "conversation") continue;
      eachLine(file, (line, index) => {
        if (!lineMayMatch(line, q)) return;
        const entry = parsed(line, ChatEntry);
        if (entry) hits.add(chatItem(entry, id, index, s.title));
      });
    }
  }

  // The kept hits' places: an answer's question, and the title of each hit's queue.
  const titles = new Map<string, string | undefined>();
  const titleOf = (queue: string) => {
    if (!titles.has(queue)) {
      let title: string | undefined;
      try { if (store.hasQueue(queue)) title = store.readQueue(queue).title; } catch { /* unreadable: warned of above, no title */ }
      titles.set(queue, title);
    }
    return titles.get(queue);
  };
  for (const item of hits.items()) {
    if (item.qid && !item.queue) Object.assign(item, asked.get(item.qid) ?? {});
    if (item.queue) item.title ??= titleOf(item.queue);
  }
  return hits.result();
}
