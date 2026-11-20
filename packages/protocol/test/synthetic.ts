// A synthetic .nexus shaped like Nexus's own (queue SM, the decision of 2026-11-18): its counts and line sizes
// calibrated on Nexus's .nexus as counted on 2026-11-20 (NEXUS_SIZE below; only sizes were read, never its contents),
// scalable (1x, 4x), and the same tree for the same seed: no clock, no random ids. Never a copy of a real .nexus,
// which holds the user's chats and paths.
//
// Used by the work gate (work-gate.test.ts) and by scripts/synthetic-nexus.ts.
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  Activity, ChatEntry, Delivery, Event, InboxEntry, NEXUS_SESSION, ProjectStore, QueueFile, Refusal, USER_SESSION, Applied,
  revisionHash, type QueueInput,
} from "../src/index.ts";

/** Nexus's own .nexus on 2026-11-20 (counted with ls and wc, the state's files only: not review files, logs, uploads). */
export const NEXUS_SIZE = {
  queues: 137, steps: 375, sessions: 260,
  roles: { worker: 194, helper: 41, orchestrator: 10, conversation: 13, user: 1, nexus: 1 },
  lines: { events: 6151, activity: 39583, chat: 6418, inbox: 131, delivered: 99, applied: 1617, refusals: 25 },
  bytes: { events: 4_684_912, activity: 9_758_169, chat: 3_141_739, inbox: 330_460, applied: 208_395, queue: 929_107 },
  files: { run: 127, git: 106, push: 125, checks: 22, start: 13, plan: 78, notes: 8, runtime: 255 },
} as const;

export interface SyntheticOptions { seed?: number; scale?: number }
export interface SyntheticSize {
  queues: number; steps: number; sessions: number;
  roles: Record<string, number>;
  lines: Record<"events" | "activity" | "chat" | "inbox" | "delivered" | "applied" | "refusals", number>;
  bytes: Record<"events" | "activity" | "chat" | "inbox" | "applied" | "queue", number>;
  files: Record<"run" | "git" | "push" | "checks" | "start" | "plan" | "notes" | "runtime", number>;
}

const WORDS = ("the server reads every file of the project and rebuilds its state then the engine decides what to start next " +
  "while the dashboard asks again for the queue steps sessions activity worker review check commit test lint build " +
  "orchestrator model context summary turn tool output branch merge base worktree").split(" ");
const T0 = Date.UTC(2026, 8, 1);
const DAY = 86_400_000;

/** Builds `<root>/.nexus`; `root` should be empty. Returns what it wrote, counted as NEXUS_SIZE counts. */
export function generateNexus(root: string, o: SyntheticOptions = {}): SyntheticSize {
  const scale = o.scale ?? 1;
  let seed = o.seed ?? 20261120;
  const rnd = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
  const text = (n: number) => Array.from({ length: n }, () => WORDS[Math.floor(rnd() * WORDS.length)]).join(" ");
  const iso = (t: number) => new Date(t).toISOString();
  let ids = 0;
  const id = (p: string) => `${p}${String(++ids).padStart(8, "0")}`;

  const st = ProjectStore.forRoot(root);
  mkdirSync(join(st.dir, "queues"), { recursive: true });
  mkdirSync(join(st.dir, "sessions"), { recursive: true });
  writeFileSync(join(st.dir, ".gitignore"), "*\n");
  writeFileSync(st.projectFile, `protocol: 1\nfollows_global: true\nid: synthetic\nname: Synthetic\nroot: ${JSON.stringify(root)}\n`);

  // Each log's lines, written once at the end (one file write each: fast, and a line per entry as appendJsonl writes).
  const logs = new Map<string, string[]>();
  const put = (session: string, log: string, line: unknown) => {
    const f = join(st.sessionDir(session), `${log}.jsonl`);
    let l = logs.get(f);
    if (!l) logs.set(f, (l = []));
    l.push(JSON.stringify(line));
  };
  const event = (e: Record<string, unknown>) => put(e.session as string, "events", Event.parse({ v: 1, ...e }));
  const session = (sid: string, role: string, created: number, extra: Record<string, unknown> = {}) =>
    st.writeSession({ protocol: 1, id: sid, project: "synthetic", role: role as "worker", runtime: "claude", title: `${role} ${sid}`, cwd: root, launched_by: "nexus", created_at: iso(created), ...extra });
  const runtime = (sid: string, turns: number) =>
    writeFileSync(join(st.sessionDir(sid), "runtime.json"), JSON.stringify({ state: "exited", model: "claude-opus", context_tokens: int(20_000, 400_000), context_window: 1_000_000, turns, updated_at: iso(T0) }));
  const activity = (sid: string, n: number, at: number, queue?: string, step?: string) => {
    for (let a = 0; a < n; a++) {
      const kind = a % 9 === 0 ? "turn_start" : a % 9 === 8 ? "turn_end" : a % 6 === 1 ? "text" : a % 50 === 7 ? "tool_error" : "tool";
      put(sid, "activity", Activity.parse({ at: iso(at + a * 20_000), kind, text: text(int(10, 45)), queue, step }));
    }
  };
  // Activity lines per session: most sessions a few dozen to a few hundred, one long one (calibrated on the median
  // of 89 and the total).
  const activityLines = () => 20 + Math.round(420 * rnd() ** 2.4);

  session(USER_SESSION, "user", T0);
  session(NEXUS_SESSION, "nexus", T0);
  const queues = Math.round(NEXUS_SIZE.queues * scale);
  const span = 80 * DAY;
  const done: { q: string; step: string; at: number }[] = [];
  let steps = 0;
  for (let i = 0; i < queues; i++) {
    const qid = `Q${String(i + 1).padStart(4, "0")}`;
    const start = T0 + (i / queues) * span;
    const n = int(1, 4) + (rnd() < 0.15 ? 1 : 0);
    steps += n;
    const stepDefs = Array.from({ length: n }, (_, s) => ({ id: `${qid}.${s + 1}`, title: text(6), goal: text(int(130, 360)), acceptance: [text(20), text(20)] }));
    const def: QueueInput = {
      protocol: 1, id: qid, title: `Queue ${qid}: ${text(6)}`, description: text(int(40, 160)), revision: 1, status: "approved",
      stop_conditions: [text(25), text(25)], checks: ["npm run lint", "npm run typecheck", "npm test"], created_at: iso(start), updated_at: iso(start),
      steps: stepDefs,
    };
    const hash = revisionHash(QueueFile.parse(def));
    st.writeQueue({ ...def, approvals: [{ revision: 1, at: iso(start), hash }] });
    const workers = [`w-${qid}`, ...(i < Math.round(57 * scale) ? [`w2-${qid}`] : [])];
    for (const w of workers) session(w, "worker", start, { queue: qid });
    let t = start + 60_000;
    const open = i >= queues - Math.max(1, Math.round(3 * scale)); // the newest few are still at work
    for (let s = 0; s < n; s++) {
      const step = `${qid}.${s + 1}`;
      const w = workers[Math.min(workers.length - 1, Math.floor((s * workers.length) / n))]!;
      const at = () => iso((t += int(60_000, 900_000)));
      event({ id: id("E"), at: at(), session: w, type: "step.started", queue: qid, step });
      for (let p = 0; p < 3; p++) event({ id: id("E"), at: at(), session: w, type: "step.progress", queue: qid, step, text: text(int(8, 20)) });
      if (open && s === n - 1) break;
      for (const name of ["npm run lint", "npm run typecheck", "npm test", "npm run build"]) event({ id: id("E"), at: at(), session: w, type: "check.result", queue: qid, step, name, ok: true, duration: int(5, 900), summary: text(int(5, 20)) });
      for (let r = 0; r < 3; r++) event({ id: id("E"), at: at(), session: w, type: "review.added", queue: qid, step, items: [{ path: `C:/tmp/review/${step}-${r}.md`, label: text(6), kind: "doc" }] });
      event({ id: id("E"), at: at(), session: w, type: "step.done", queue: qid, step, summary: text(int(250, 500)), commit: id("c"), activities: ["code"] });
      for (let c = rnd() < 0.35 ? 2 : 1; c > 0; c--) event({ id: id("E"), at: at(), session: w, type: "context.summary", queue: qid, step, text: text(int(300, 600)), topics: ["model"], files: ["a.ts"] });
      const acc = id("E");
      event({ id: acc, at: at(), session: USER_SESSION, type: "review.accepted", queue: qid, step });
      done.push({ q: qid, step, at: t });
    }
    if (!open) event({ id: id("E"), at: iso((t += 60_000)), session: workers.at(-1)!, type: "queue.report", queue: qid, path: `queues/${qid}/report.md`, summary: text(int(100, 300)) });
    if (i % 7 === 3) {
      const qn = id("Q");
      event({ id: id("E"), at: iso((t += 60_000)), session: workers[0]!, type: "question.asked", queue: qid, step: stepDefs[0]!.id, qid: qn, text: text(int(40, 120)), options: [text(5), text(5)], can_continue: false });
      event({ id: id("E"), at: iso((t += 60_000)), session: USER_SESSION, type: "answer.given", qid: qn, text: text(int(10, 40)) });
    }
    for (const w of workers) { activity(w, activityLines(), start, qid, stepDefs[0]!.id); runtime(w, int(3, 40)); }
    if (i < Math.round(41 * scale)) { const h = `h-${qid}`; session(h, "helper", t); activity(h, activityLines(), t); runtime(h, 1); }
    // The server's files, in about Nexus's share of queues.
    const share = (n2: number) => i < Math.round(n2 * scale);
    if (share(127)) st.writeRun(qid, { protocol: 1, session: workers.at(-1)!, state: open ? "running" : "finished", step: stepDefs.at(-1)!.id, started_at: iso(start), updated_at: iso(t), revision: 1, runtime: "claude" });
    if (share(106)) st.writeGit(qid, { protocol: 1, steps: Object.fromEntries(stepDefs.map((x) => [x.id, [{ session: workers[0]!, start: id("c"), started_at: iso(start), end: id("c"), ended_at: iso(t), turns: [{ start: id("c"), end: id("c") }] }]])) });
    if (share(125)) st.writePush(qid, { protocol: 1, review: Object.fromEntries(stepDefs.map((x) => [x.id, { sha: id("c"), finished_at: iso(t), at: iso(t) }])), steps: {} });
    if (share(22)) st.writeChecks(qid, { protocol: 1, steps: {} });
    if (i > 0 && share(78)) st.writePlan(qid, { protocol: 1, by: "user", after: [{ queue: `Q${String(i).padStart(4, "0")}`, by: "user", at: iso(start) }], created_at: iso(start), updated_at: iso(start), started_at: iso(start), decisions: [] });
    if (share(13)) st.writeStart(qid, { protocol: 1, by: "user", revision: 1, created_at: iso(start) });
    if (share(8)) st.writeNote(qid, { id: id("N"), step: stepDefs[0]!.id, from: "user", at: iso(start) }, text(40));
    if (share(54)) {
      const w = workers[0]!;
      for (let k = int(2, 3); k > 0; k--) {
        const m = id("M");
        put(w, "inbox", InboxEntry.parse({ v: 1, id: m, at: iso((t += 60_000)), from: "user", type: "message", text: text(int(250, 500)), queue: qid, step: stepDefs[0]!.id }));
        if (rnd() < 0.75) put(w, "delivered", Delivery.parse({ at: iso(t + 1000), kind: "inbox", id: m, via: "turn" }));
      }
    }
    if (share(21)) put(workers[0]!, "refusals", Refusal.parse({ at: iso(t), session: workers[0]!, runtime: "claude", by: "permissions", tool: "Bash", input: text(12), ref: id("R"), queue: qid, step: stepDefs[0]!.id }));
  }

  // The orchestrator's sessions: its requests (each with the server's result in applied.jsonl), its chat; a long
  // activity of its own.
  const orchestrators = Math.max(1, Math.round(10 * scale));
  for (let o2 = 0; o2 < orchestrators; o2++) {
    const sid = `o-${o2 + 1}`;
    const created = T0 + (o2 / orchestrators) * span;
    session(sid, "orchestrator", created);
    runtime(sid, int(50, 400));
    let t = created;
    for (let r = 0; r < 70; r++) {
      const e = id("E");
      const q = `Q${String(int(1, queues)).padStart(4, "0")}`;
      if (r % 7 < 3) event({ id: e, at: iso((t += 120_000)), session: sid, type: "queue.drafted", queue: q, definition: { title: text(8), description: text(80), steps: [{ id: "A", goal: text(120) }, { id: "B", goal: text(120) }] } });
      else event({ id: e, at: iso((t += 120_000)), session: sid, type: "session.request", action: "start", queue: q, reason: text(int(20, 60)) });
      put(sid, "applied", Applied.parse({ at: iso(t + 500), event: e, ok: true, message: text(int(5, 32)) }));
    }
    for (let k = 0; k < 92; k++) put(sid, "applied", Applied.parse({ at: iso((t += 60_000)), event: `notify:${id("K")}`, ok: true, message: "told" }));
    for (let l = 0; l < 500; l++) put(sid, "chat", ChatEntry.parse({ at: iso((t += 60_000)), from: l % 3 === 0 ? "user" : "orchestrator", kind: l % 4 === 3 ? "tool" : "message", text: text(int(28, 110)) }));
    activity(sid, o2 === 0 ? 2392 : activityLines(), created);
  }
  const conversations = Math.max(1, Math.round(13 * scale));
  for (let c = 0; c < conversations; c++) {
    const sid = `c-${c + 1}`;
    const created = T0 + (c / conversations) * span;
    session(sid, "conversation", created, { archived: c > 3 });
    if (c < Math.round(11 * scale)) {
      let t = created;
      for (let l = 0; l < 128; l++) put(sid, "chat", ChatEntry.parse({ at: iso((t += 90_000)), from: l % 2 ? "partner" : "user", text: text(int(30, 110)) }));
      runtime(sid, int(5, 60));
    }
  }

  for (const [f, lines] of logs) { mkdirSync(join(f, ".."), { recursive: true }); writeFileSync(f, lines.map((l) => `${l}\n`).join("")); }
  return measure(st.dir, steps);
}

/** What a .nexus holds, counted as NEXUS_SIZE counts. */
function measure(dir: string, steps: number): SyntheticSize {
  const size: SyntheticSize = {
    queues: 0, steps, sessions: 0, roles: {},
    lines: { events: 0, activity: 0, chat: 0, inbox: 0, delivered: 0, applied: 0, refusals: 0 },
    bytes: { events: 0, activity: 0, chat: 0, inbox: 0, applied: 0, queue: 0 },
    files: { run: 0, git: 0, push: 0, checks: 0, start: 0, plan: 0, notes: 0, runtime: 0 },
  };
  for (const q of readdirSync(join(dir, "queues"))) {
    size.queues++;
    size.bytes.queue += statSync(join(dir, "queues", q, "queue.yaml")).size;
    for (const f of readdirSync(join(dir, "queues", q))) {
      const k = f.replace(/\.yaml$/, "") as keyof SyntheticSize["files"];
      if (k in size.files) size.files[k]++;
      else if (f === "notes") for (const s of readdirSync(join(dir, "queues", q, f))) size.files.notes += readdirSync(join(dir, "queues", q, f, s)).length;
    }
  }
  for (const s of readdirSync(join(dir, "sessions"))) {
    size.sessions++;
    const role = /^role: (\w+)$/m.exec(readFileSync(join(dir, "sessions", s, "session.yaml"), "utf8"))![1]!;
    size.roles[role] = (size.roles[role] ?? 0) + 1;
    for (const f of readdirSync(join(dir, "sessions", s))) {
      if (f === "runtime.json") size.files.runtime++;
      const k = f.replace(/\.jsonl$/, "") as keyof SyntheticSize["lines"];
      if (!f.endsWith(".jsonl") || !(k in size.lines)) continue;
      const b = readFileSync(join(dir, "sessions", s, f));
      size.lines[k] += b.toString("utf8").split("\n").length - 1;
      if (k in size.bytes) size.bytes[k as keyof SyntheticSize["bytes"]] += b.length;
    }
  }
  return size;
}
