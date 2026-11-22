// Measures a project's model as the server makes it (queue AQ; docs/design/archive.md, "The measurement"): the start
// (the model's read and the first derivation), the state the dashboard reads (its size and serialization), the heap,
// the digest of the last day, opening a closed queue, and the heap once the logs no one reads are let go.
//
//   node --expose-gc scripts/state-memory.ts <.nexus folder> [--age]
//
// --age first sets each log's modification time to its last line's time, as a log last written then would have it (a
// synthetic tree is written all at once: node scripts/synthetic-nexus.ts <folder> --scale 4). It changes only times.
import { existsSync, readFileSync, readdirSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { ProjectModel, isArchived, shownState } from "../packages/protocol/src/index.ts";
import { stateTexts } from "../packages/protocol/src/live.ts";
import { digestInput, projectDigest } from "../packages/protocol/src/digest.ts";

const { values: o, positionals } = parseArgs({ allowPositionals: true, options: { age: { type: "boolean" } } });
const dir = positionals[0];
if (!dir) throw new Error("usage: node --expose-gc scripts/state-memory.ts <.nexus folder> [--age]");
const gc = (globalThis as { gc?: () => void }).gc;
if (!gc) throw new Error("run with node --expose-gc");

if (o.age) {
  const sessions = join(dir, "sessions");
  for (const s of readdirSync(sessions)) for (const f of ["activity.jsonl", "refusals.jsonl", "chat.jsonl", "events.jsonl"]) {
    const p = join(sessions, s, f);
    if (!existsSync(p)) continue;
    const last = readFileSync(p, "utf8").trimEnd().split("\n").at(-1);
    const at = last ? (JSON.parse(last) as { at?: string }).at : undefined;
    if (at) utimesSync(p, new Date(at), new Date(at));
  }
}

const heap = () => { gc(); gc(); return `${(process.memoryUsage().heapUsed / 1048576).toFixed(0)} MB`; };
const ms = (t: number) => Math.round(performance.now() - t);
const out: Record<string, unknown> = { heap_at_first: heap() };
let t = performance.now();
const model = new ProjectModel(dir);
const state = model.current();
out.start_ms = ms(t);
t = performance.now();
const texts = stateTexts(shownState(state))!;
out.texts_ms = ms(t);
out.state_bytes = texts.size;
out.heap_after_start = heap();
const since = new Date(Date.now() - 86_400_000).toISOString();
t = performance.now();
out.digest_lines = projectDigest(digestInput(model.store, state, since), since).length;
out.digest_ms = ms(t);
const logs = () => model.cache.held().filter((l) => /(activity|chat|refusals)\.jsonl$/.test(l.file)).length;
out.logs_held_after_digest = logs();
out.heap_after_digest = heap();
const closed = state.queues.find((q) => isArchived(q, state.attention));
if (closed) {
  t = performance.now();
  out.open_queue = closed.id;
  out.open_bytes = JSON.stringify(closed).length;
  out.open_activity_lines = model.store.sessionIds().filter((s) => model.store.readSession(s).queue === closed.id).map((s) => model.store.readActivity(s).entries.length);
  out.open_ms = ms(t);
  out.logs_held_after_open = logs();
  out.let_go = model.cache.release(Date.now() + model.cache.logIdleMs + 1);
  out.heap_after_let_go = heap();
}
out.texts_kept = texts.size > 0;
// The whole state's size last: its texts would weigh on the heaps above.
out.whole_state_bytes = stateTexts(state)!.size;
console.log(JSON.stringify(out, null, 1));
model.close();
