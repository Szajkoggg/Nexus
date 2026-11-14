// The `nexus` command. Agents report through it; the user (or Nexus itself) also uses it for setup.
// Every agent-side command validates its input and appends one event to the session's own log.
import { readFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import YAML from "yaml";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { execFileSync } from "node:child_process";
import {
  Event, HOLDING_RUN_STATES, ProjectStore, findNexusDir, inReportFolder, loadProjectState, stepValuesText, stopPlace, newId, normPath, now, readRegistry, writeRegistry,
  PICTURE_ROLES, REVIEW_HELP, checkPicture, pictureSize,
  type PictureRole, type ReviewItem, type Role, type Runtime, type SessionFile,
} from "@nexus/protocol";
import { importMarkdownQueues } from "./import-md.ts";
import { HELP_TOPICS, topicList } from "./help.ts";

const HELP = `nexus — report to and manage Nexus (protocol 1)

Agent commands (session from NEXUS_SESSION or --session):
  nexus status                                  current queue, step, notes and open questions (without a
                                                session: the queues at work, then the approved ones not running)
  nexus step start <step>
  nexus step progress <step> <text> [--pct N]
  nexus step done <step> --summary <text> [--commit <sha>]
  nexus step failed <step> --reason <text>
  nexus review add <step> <path|url>... [--label <text>] [--kind image|sheet|doc|data|link] [--round N]
                    [--key <view@width> --role before|mockup|after|variant-a|variant-b|result]   (one picture; pairs by key)
                    [--before <path>]   (older material without a key: the "before" of one picture)
                    Read nexus help review before preparing review material.
  nexus check <step> <name> --ok|--fail [--summary <text>]
  nexus stop <step> --condition <text> --reason <text>
  nexus ask <text> [--step <step>] [--option <text>]... [--can-continue]
  nexus withdraw <qid> --reason <text>
  nexus context <text|-> [--topics a,b] [--files a,b] [--step <step>]
  nexus report <queue> --file <path> --summary <text>
  nexus log <text> [--level info|warn|error]
  nexus answer <qid> <text> [--escalate] [--continue|--wait]     (orchestrator only)
  nexus queue draft <file.yaml|->                                 (orchestrator only) create or change a queue
  nexus review accept <queue> <step> [--note <text>]             (orchestrator only) a step waiting for your review
  nexus review send-back <queue> <step> <what to fix>             (orchestrator only) back to its worker
  nexus review ask-user <queue> <step> <why>                      (orchestrator only) hand the review to the user
  nexus queue set <queue> [--step <step>] skipped|finished|cancelled|propose-lift --reason <text>   (orchestrator only)
                                      housekeeping: skip a pending, stopped or failed step; close a halted run of a
                                      queue whose steps are all done or skipped; cancel a queue that is not running;
                                      propose that the user lift a stop. Done, approving and lifting are the user's
  nexus run <queue> start|pause|resume|stop --reason <text> [--use-session <id>] [--runtime claude|codex] [--model <m>] [--effort <e>] [--after <queue> | --at "YYYY-MM-DD HH:MM" | --at usage-reset]   (orchestrator only; start --after: when that queue is done; --at: at that local time, or when the runtime's usage window resets)
  nexus run <queue> cancel-start --reason <text>   (orchestrator only: cancels the queue's planned start)
  (--queue <id> picks the queue when the session has none or the step id is ambiguous)

Help:
  nexus help [<topic>]                 Nexus's standards; topics: ${Object.keys(HELP_TOPICS).join(", ")}

Setup:
  nexus project add <path> [--id <id>] [--name <text>]
  nexus project list
  nexus import <file.md> [--prefix <text>] [--dry-run] [--replace]
  nexus attach [--role worker|orchestrator] [--runtime claude|codex|external] [--queue <id>] [--title <text>]
  nexus note <queue> <step> <text> [--from user|orchestrator]

The server (NEXUS_PORT, default 4317):
  nexus server status                 version, the steps running in each project, and an update in progress
  nexus server update [--now] [--ref <commit|branch>]
                                      let running steps finish (or stop them with --now), move the live worktree to
                                      <ref> (default main), build, restart; queues held for it go on by themselves
  nexus server cancel                 give up waiting; the held queues go on
`;

const { values: o, positionals: args } = parseArgs({
  allowPositionals: true,
  options: {
    session: { type: "string" }, queue: { type: "string" }, step: { type: "string" },
    summary: { type: "string" }, commit: { type: "string" }, reason: { type: "string" },
    condition: { type: "string" }, pct: { type: "string" }, label: { type: "string" },
    kind: { type: "string" }, round: { type: "string" }, ok: { type: "boolean" }, fail: { type: "boolean" },
    option: { type: "string", multiple: true }, "can-continue": { type: "boolean" },
    "use-session": { type: "string" }, model: { type: "string" }, effort: { type: "string" }, after: { type: "string" }, at: { type: "string" },
    topics: { type: "string" }, files: { type: "string" }, file: { type: "string" }, level: { type: "string" },
    escalate: { type: "boolean" }, continue: { type: "boolean" }, wait: { type: "boolean" },
    id: { type: "string" }, name: { type: "string" }, prefix: { type: "string" },
    "dry-run": { type: "boolean" }, replace: { type: "boolean" },
    role: { type: "string" }, runtime: { type: "string" }, title: { type: "string" }, from: { type: "string" },
    help: { type: "boolean", short: "h" }, key: { type: "string" }, note: { type: "string" }, before: { type: "string" }, now: { type: "boolean" }, ref: { type: "string" },
  },
});

class UsageError extends Error {}
const need = <T>(v: T | undefined, what: string): T => {
  if (v === undefined || v === "") throw new UsageError(`missing ${what}`);
  return v;
};

function store(): ProjectStore {
  const dir = process.env.NEXUS_DIR ?? findNexusDir();
  if (!dir) throw new UsageError("no .nexus directory found here (set NEXUS_DIR, or run `nexus project add`)");
  return new ProjectStore(dir);
}

function session(st: ProjectStore): SessionFile {
  const id = need(o.session ?? process.env.NEXUS_SESSION, "session (NEXUS_SESSION or --session; `nexus attach` creates one)");
  try { return st.readSession(id); } catch { throw new UsageError(`unknown session ${id}`); }
}

/** The queue a step belongs to: --queue, else the session's queue, else the only queue with that step. */
function queueFor(st: ProjectStore, s: SessionFile, step?: string): string {
  if (o.queue) return o.queue;
  if (s.queue) return s.queue;
  if (step) {
    const owners = st.queueIds().filter((q) => st.readQueue(q).steps.some((x) => x.id === step));
    if (owners.length === 1) return owners[0]!;
    if (owners.length > 1) throw new UsageError(`step ${step} is in several queues (${owners.join(", ")}): add --queue`);
  }
  throw new UsageError("no queue: add --queue");
}

function checkStep(st: ProjectStore, queue: string, step: string): void {
  let q;
  try { q = st.readQueue(queue); } catch { throw new UsageError(`unknown queue ${queue}`); }
  if (!q.steps.some((x) => x.id === step)) throw new UsageError(`queue ${queue} has no step ${step} (has ${q.steps.map((x) => x.id).join(", ")})`);
}

function emit(st: ProjectStore, s: SessionFile, body: Record<string, unknown>): Event {
  const r = Event.safeParse({ v: 1, id: newId(), at: now(), session: s.id, ...body });
  if (!r.success) throw new UsageError(r.error.issues.map((i) => `${i.path.join(".") || "event"}: ${i.message}`).join("; "));
  st.appendEvent(r.data);
  return r.data;
}

function stepEvent(type: string, step: string | undefined, extra: () => Record<string, unknown> = () => ({})): void {
  const st = store(); const s = session(st);
  step = need(step, "<step>");
  const queue = queueFor(st, s, step);
  checkStep(st, queue, step);
  emit(st, s, { type, queue, step, ...extra() });
  console.log(`ok: ${type} ${queue}/${step}`);
}

type QueueOf = ReturnType<typeof loadProjectState>["queues"][number];

/** A stopped queue's ways out: where the stop is, how the user lifts it, and the orchestrator's proposal to lift it. */
function stopLines(q: QueueOf): string[] {
  if (q.status !== "stopped") return [];
  const how = q.approved ? "the user lifts it with Continue, or by approving a new revision" : `the user lifts it by approving revision ${q.revision}`;
  const p = q.lift_proposal;
  return [`  stopped${stopPlace(q)}; ${how}`, ...(p ? [`  proposal to lift (orchestrator, ${p.at}): ${p.reason.replace(/\s+/g, " ").slice(0, 300)}`] : [])];
}

/** "YYYY-MM-DD HH:MM" in this machine's local time, as ISO 8601. */
function localTime(text: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/.exec(text.trim());
  if (!m) throw new UsageError(`--at takes "YYYY-MM-DD HH:MM" (local time) or usage-reset, not ${text}`);
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  if (d.getMonth() !== Number(m[2]) - 1 || d.getDate() !== Number(m[3]) || d.getHours() !== Number(m[4])) throw new UsageError(`no such time: ${text}`);
  return d.toISOString();
}

/** What an orchestrator needs to see: every queue, run, open question and worker session with its context card. */
function overview(state: ReturnType<typeof loadProjectState>): void {
  const pct = (t?: number, w?: number) => (t && w ? `${Math.round((100 * t) / w)} % context` : "context unknown");
  const done = state.queues.filter((q) => q.status === "done" || q.status === "cancelled");
  console.log(`
Queues (${state.queues.length - done.length} open; finished: ${done.map((q) => q.id).join(", ") || "none"})`);
  for (const q of state.queues.filter((x) => !done.includes(x))) {
    const run = q.run ? `; run ${q.run.state}${q.run.step ? ` at ${q.run.step}` : ""} in session ${q.run.session}${q.run.reason ? ` (${q.run.reason})` : ""}` : "";
    console.log(`- ${q.id} [${q.status}] ${q.title}: revision ${q.revision}, ${q.approved ? "approved" : "not approved"}${run}`);
    // A revision waiting for approval comes first: nothing runs and no planned start fires until the user approves it.
    if (!q.approved) console.log(`  needs approval (revision ${q.revision})${q.start && !q.start.failed ? ": the planned start below waits for it" : ""}`);
    console.log(`  steps: ${q.steps.map((x) => `${x.id} ${x.status}${x.review_with ? ` (for ${x.review_with === "user" ? "the user" : "you"})` : ""}${stepValuesText(x) ? ` [on ${stepValuesText(x)}]` : ""}`).join(", ")}`);
    if (q.status_reason && q.status !== "running") console.log(`  why: ${q.status_reason.replace(/\s+/g, " ").slice(0, 300)}`);
    for (const line of stopLines(q)) console.log(line);
    if (q.start) {
      const p = q.start;
      const when = p.after ? `after ${p.after}` : `at ${new Date(p.at!).toLocaleString("sv-SE").slice(0, 16)}${p.usage ? " (usage reset)" : ""}`;
      console.log(p.failed
        ? `  planned start ${when} did not happen: ${p.failed.reason} (the user sees it; start the queue or cancel the plan with nexus run ${q.id} cancel-start)`
        : p.after ? `  ${q.approved ? "" : "then "}starts when ${p.after} is done${p.session ? `, in session ${p.session}` : ""}; now: ${p.waiting}`
          : `  ${q.approved ? "" : "then "}starts ${when}${p.session ? `, in session ${p.session}` : ""}${p.held ? `; its time came, now: ${p.waiting} (it starts by itself)` : ""}`);
    }
  }
  const open = state.questions.filter((x) => x.state === "open" || x.state === "escalated");
  console.log(`
Open questions (${open.length})`);
  for (const x of open) console.log(`- ${x.qid} [${x.state}] ${x.queue ?? ""}${x.step ? `/${x.step}` : ""}: ${x.text}`);
  const workers = state.sessions.filter((x) => x.role === "worker");
  console.log(`
Worker sessions (${workers.length})`);
  for (const w of workers) {
    const busy = state.queues.find((q) => q.run?.session === w.id && HOLDING_RUN_STATES.includes(q.run.state));
    console.log(`- ${w.id} "${w.title ?? ""}" ${w.runtime}${w.launched_by === "nexus" ? "" : " (external)"}, ${w.live?.state ?? "not live"}, ${w.live?.model ?? w.model ?? "model ?"}, ${pct(w.live?.context_tokens, w.live?.context_window)}${busy ? `, running queue ${busy.id}` : ", free"}`);
    if (w.context) console.log(`  knows: ${w.context.topics.join(", ") || "-"}; ${w.context.text.replace(/\s+/g, " ").slice(0, 300)}`);
  }
  const attention = state.attention.filter((a) => a.kind !== "question");
  if (attention.length) {
    console.log(`
Waiting for the user`);
    for (const a of attention) {
      const where = a.lift ? `${a.queue}${a.lift.place}` : `${a.queue ?? ""}${a.step ? `/${a.step}` : ""}`;
      console.log(`- ${a.kind} ${where}: ${a.text.replace(/\s+/g, " ").slice(0, 160)}`);
      if (!a.lift) continue;
      console.log(`  ${a.lift.continue ? "Continue lifts it" : `approving revision ${a.lift.revision} lifts it`}`);
      const p = a.lift.proposal;
      if (p) console.log(`  proposal to lift (orchestrator, ${p.at}): ${p.reason.replace(/\s+/g, " ").slice(0, 300)}`);
    }
  }
}

function orchestrator(st: ProjectStore): SessionFile {
  const s = session(st);
  if (s.role !== "orchestrator") throw new UsageError("only an orchestrator session may do this");
  return s;
}

/** The server carries out an orchestrator's request when it sees the event; this waits for its result. */
function waitApplied(st: ProjectStore, session: string, event: string, ms = 15_000): { ok: boolean; message: string } | undefined {
  const until = Date.now() + ms;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  while (Date.now() < until) {
    const a = st.readApplied(session).entries.find((x) => x.event === event);
    if (a) return a;
    Atomics.wait(pause, 0, 0, 150);
  }
  return undefined;
}

/** The orchestrator's decision on a step waiting for its review: accept, send back, or hand it to the user. */
function reviewDecision(action: "accept" | "send-back" | "ask-user"): void {
  const st = store(); const s = orchestrator(st);
  const queue = need(args[2], "<queue>"); const step = need(args[3], "<step>");
  checkStep(st, queue, step);
  const view = loadProjectState(st).queues.find((q) => q.id === queue)!.steps.find((x) => x.id === step)!;
  if (view.status !== "review") throw new UsageError(`step ${queue}/${step} is not waiting for review (it is ${view.status})`);
  if (view.review_with !== "orchestrator") throw new UsageError(`step ${queue}/${step} waits for the user's review, not yours`);
  if (action === "accept") {
    emit(st, s, { type: "review.accepted", queue, step, text: o.note?.trim() || undefined });
    console.log(`ok: ${queue}/${step} accepted; the run goes on`);
    return;
  }
  const text = need(args.slice(4).join(" ").trim(), action === "send-back" ? "<what to fix>" : "<why>");
  const e = emit(st, s, { type: action === "send-back" ? "review.sent_back" : "review.asked_user", queue, step, text });
  // The server carries out a send-back (the worker's inbox, or the user beyond the limit); this waits for its result.
  if (action === "send-back") report(waitApplied(st, s.id, e.id));
  else console.log(`ok: ${queue}/${step} waits for the user's review`);
}

function report(r: { ok: boolean; message: string } | undefined): void {
  if (!r) { console.log("sent; the Nexus server has not answered yet (is it running?). Check later with `nexus status`."); return; }
  if (!r.ok) throw new UsageError(r.message);
  console.log(`ok: ${r.message}`);
}

const list = (v?: string) => (v ? v.split(",").map((x) => x.trim()).filter(Boolean) : []);
const readText = (v: string) => (v === "-" ? readFileSync(0, "utf8").trim() : v);

function gitBranch(cwd: string): string | null {
  try { return execFileSync("git", ["branch", "--show-current"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null; }
  catch { return null; }
}

// ---------------------------------------------------------------- commands

/** Talks to the running server; only `nexus server` does, everything else is files. */
async function server(method: "GET" | "POST", path: string, body?: unknown): Promise<Record<string, any>> {
  const url = `http://127.0.0.1:${process.env.NEXUS_PORT ?? 4317}${path}`;
  let r: Response;
  try { r = await fetch(url, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }); }
  catch { throw new UsageError(`no Nexus server answers at ${url}`); }
  const j = (await r.json().catch(() => ({}))) as Record<string, any>;
  if (!r.ok) throw new UsageError(j.error ?? `${r.status} ${r.statusText}`);
  return j;
}

function printUpdate(u: Record<string, any>): void {
  console.log(`update: ${u.phase}${u.held?.length ? `; holding ${u.held.join(", ")}` : ""}${u.waiting?.length ? `; waiting for ${u.waiting.join(", ")}` : ""}`);
  for (const l of u.log ?? []) console.log(`  ${l}`);
  if (u.error) console.log(`  error: ${u.error}`);
}

const commands: Record<string, () => void | Promise<void>> = {
  async server() {
    const sub = args[1] ?? "status";
    if (sub === "status") {
      const s = await server("GET", "/api/server");
      console.log(`Nexus ${s.commit} "${s.subject}" from ${s.root} (${s.live ? "live worktree" : `development checkout, branch ${s.branch}`})`);
      // What an update would wait for (or interrupt with --now).
      const running = (s.running ?? []) as { project: string; name: string; steps: { queue: string; step: string; title: string; session: string | null }[] }[];
      if (!running.length) console.log("running steps: none");
      for (const p of running) {
        console.log(`running steps in ${p.name} (${p.project}):`);
        for (const x of p.steps) console.log(`  ${x.queue}/${x.step} ${x.title}${x.session ? `  (session ${x.session})` : ""}`);
      }
      return printUpdate(s.update);
    }
    let by: { project: string; session: string } | undefined;
    if (sub === "update" || sub === "cancel") {
      // Restarting Nexus restarts every agent's runtime: the user's call, which an orchestrator may carry out when
      // asked. A worker or a thinking partner never may (they run on the very server they would restart).
      const sid = o.session ?? process.env.NEXUS_SESSION;
      if (sid) {
        const dir = process.env.NEXUS_DIR ?? findNexusDir();
        let role: string | undefined;
        let project: string | undefined;
        try { const st = dir ? new ProjectStore(dir) : undefined; role = st?.readSession(sid).role; project = st?.readProject().id; } catch { role = undefined; }
        if (role !== "orchestrator") throw new UsageError(`only the user or an orchestrator may ${sub} the Nexus server, not a ${role ?? "session"}`);
        // The orchestrator that asks is told the outcome after the restart (or if the update fails).
        if (project) by = { project, session: sid };
      }
    }
    if (sub === "update") return printUpdate(await server("POST", "/api/server/update", { now: !!o.now, ref: o.ref, by }));
    if (sub === "cancel") return printUpdate(await server("POST", "/api/server/cancel"));
    throw new UsageError("nexus server status|update|cancel");
  },

  status() {
    const st = store();
    const state = loadProjectState(st);
    const sid = o.session ?? process.env.NEXUS_SESSION;
    const s = sid ? state.sessions.find((x) => x.id === sid) : undefined;
    console.log(`project ${state.project.name} (${state.project.id})`);
    if (s?.role === "orchestrator" || s?.role === "conversation") return overview(state);
    if (s) console.log(`session ${s.id}: ${s.role}, ${s.runtime}, queue ${s.queue ?? "-"}`);
    // Without a queue of its own: the queues at work, then the approved ones not running (ready to start or resume).
    const queues = s?.queue ? state.queues.filter((q) => q.id === s.queue) : [
      ...state.queues.filter((q) => ["running", "waiting", "stopped"].includes(q.status)),
      ...state.queues.filter((q) => ["approved", "paused"].includes(q.status)),
    ];
    for (const q of queues) {
      console.log(`\nqueue ${q.id} [${q.status}] ${q.title}${q.approved ? "" : ` (needs approval: revision ${q.revision})`}`);
      if (q.status_reason) console.log(`  why: ${q.status_reason.slice(0, 300)}`);
      for (const line of stopLines(q)) console.log(line);
      if (q.run && q.status !== "running") {
        const why = q.run.reason ? ` (${q.run.reason.replace(/\s+/g, " ").slice(0, 200)})` : "";
        console.log(`  run: ${q.run.state}${q.run.step ? ` at ${q.run.step}` : ""}${why}`);
      }
      // A planned start, and why it has not come (also: waiting for its checkout or for a place under the limit).
      const p = q.start;
      if (p) {
        const when = p.after ? `after ${p.after}` : `at ${new Date(p.at!).toLocaleString("sv-SE").slice(0, 16)}`;
        console.log(p.failed ? `  planned start ${when} did not happen: ${p.failed.reason}` : `  planned start ${when}; now: ${p.waiting}${p.held ? " (it starts by itself)" : ""}`);
      }
      for (const step of q.steps) {
        const unread = step.notes.filter((n) => !n.read_at && n.to !== "orchestrator");
        const own = stepValuesText(step);
        console.log(`  ${step.id.padEnd(5)} ${step.status.padEnd(8)} ${step.title}${own ? `  [on ${own}]` : ""}${unread.length ? `  (${unread.length} unread note${unread.length > 1 ? "s" : ""})` : ""}`);
      }
      const open = q.questions.filter((x) => x.state === "open" || x.state === "escalated");
      for (const x of open) console.log(`  question ${x.qid} [${x.state}]: ${x.text}`);
    }
    // The session's inbox: messages and answers not yet seen. Shown here is delivered, so each is recorded as read.
    for (const m of s?.inbox.filter((x) => !x.read_at) ?? []) {
      if (m.type === "answer") {
        const q = state.questions.find((x) => x.qid === m.qid);
        const how = m.continue === true ? " (go on)" : m.continue === false ? " (wait before going on)" : "";
        console.log(`\nanswer from the ${m.from} to ${m.qid}${q ? ` ("${q.text}")` : ""}${how}:\n${m.text}`);
      } else if (m.type === "message") {
        console.log(`\nmessage from the ${m.from}${m.step ? ` about ${m.queue}/${m.step}` : ""} (${m.at}):\n${m.text}`);
      } else if (m.type === "send_back") {
        console.log(`\n${m.queue}/${m.step} sent back by the ${m.from} (round ${m.round}):\n${m.text}${m.from === "user" ? "\n(The user's words win over the step's acceptance criteria where they conflict.)" : ""}`);
      } else {
        console.log(`\nSTOP requested by the ${m.from}${m.text ? `: ${m.text}` : ""}. Finish the current action, then stop and report.`);
      }
      st.appendEvent({ v: 1, id: newId(), at: now(), session: s!.id, type: "message.read", message: m.id });
    }
    if (s?.queue) {
      const q = state.queues.find((x) => x.id === s.queue);
      for (const step of q?.steps ?? []) for (const n of step.notes.filter((x) => !x.read_at && x.to !== "orchestrator")) {
        console.log(`\nnote ${n.id} for ${step.id} from ${n.from} (${n.at}):\n${n.body}`);
        // Shown to the session's agent: that is the delivery, so it is recorded as read.
        st.appendEvent({ v: 1, id: newId(), at: now(), session: s.id, type: "note.read", note: n.id });
      }
    }
    if (state.warnings.length) console.log(`\n${state.warnings.length} warning(s); first: ${state.warnings[0]}`);
  },

  step() {
    const sub = args[1];
    if (sub === "start") return stepEvent("step.started", args[2]);
    if (sub === "progress") return stepEvent("step.progress", args[2], () => ({ text: need(args[3], "<text>"), pct: o.pct ? Number(o.pct) : undefined }));
    if (sub === "done") return stepEvent("step.done", args[2], () => ({ summary: need(o.summary, "--summary"), commit: o.commit }));
    if (sub === "failed") return stepEvent("step.failed", args[2], () => ({ reason: need(o.reason, "--reason") }));
    throw new UsageError("nexus step start|progress|done|failed <step>");
  },

  review() {
    if (args[1] === "accept" || args[1] === "send-back" || args[1] === "ask-user") return reviewDecision(args[1]);
    if (args[1] !== "add") throw new UsageError("nexus review add <step> <path|url>... (orchestrators: nexus review accept|send-back|ask-user <queue> <step>)");
    const st = store(); const s = session(st);
    const step = need(args[2], "<step>");
    const queue = queueFor(st, s, step);
    checkStep(st, queue, step);
    const targets = args.slice(3);
    if (!targets.length) throw new UsageError("missing <path|url>");
    if (o.key !== undefined || o.role !== undefined) return reviewAddKeyed(st, s, queue, step, targets);
    let before: string | undefined;
    if (o.before !== undefined) {
      if (targets.length !== 1 || /^https?:\/\//.test(targets[0]!)) throw new UsageError("--before goes with exactly one picture (a file)");
      before = normPath(o.before);
      if (!existsSync(before)) throw new UsageError(`no such file: ${before}`);
    }
    const items: ReviewItem[] = targets.map((t) => {
      if (/^https?:\/\//.test(t)) return { url: t, label: o.label, kind: (o.kind as ReviewItem["kind"]) ?? "link" };
      const p = normPath(t);
      if (!existsSync(p)) throw new UsageError(`no such file: ${p}`);
      return { path: p, label: o.label ?? basename(p), kind: (o.kind as ReviewItem["kind"]) ?? guessKind(p), before };
    });
    emit(st, s, { type: "review.added", queue, step, items, round: o.round ? Number(o.round) : undefined });
    console.log(`ok: ${items.length} review item(s) for ${queue}/${step}`);
  },

  help() {
    const topic = args[1];
    if (!topic) { console.log(`${HELP}\n${topicList()}`); return; }
    const t = HELP_TOPICS[topic];
    if (!t) throw new UsageError(`no help topic "${topic}" (topics: ${Object.keys(HELP_TOPICS).join(", ")})`);
    console.log(t.text);
  },

  check() {
    if (o.ok === o.fail) throw new UsageError("give exactly one of --ok or --fail");
    const name = need(args[2], "<name>");
    stepEvent("check.result", args[1], () => ({ name, ok: !!o.ok, summary: o.summary }));
  },

  stop() {
    stepEvent("queue.stop", args[1], () => ({ condition: need(o.condition, "--condition"), reason: need(o.reason, "--reason") }));
  },

  ask() {
    const st = store(); const s = session(st);
    const text = readText(need(args[1], "<text>"));
    const step = o.step;
    let queue: string | undefined;
    try { queue = queueFor(st, s, step); } catch { queue = undefined; }
    if (queue && step) checkStep(st, queue, step);
    const qid = newId();
    emit(st, s, { type: "question.asked", queue, step, qid, text, options: o.option, can_continue: !!o["can-continue"] });
    console.log(`ok: question ${qid} sent to the orchestrator.${o["can-continue"] ? " Go on with independent work meanwhile." : " Wait for the answer (nexus status shows it)."}`);
  },

  withdraw() {
    const st = store(); const s = session(st);
    emit(st, s, { type: "question.withdrawn", qid: need(args[1], "<qid>"), reason: need(o.reason, "--reason") });
    console.log("ok: question withdrawn");
  },

  context() {
    const st = store(); const s = session(st);
    const text = readText(need(args[1], "<text|->"));
    let queue: string | undefined;
    try { queue = queueFor(st, s, o.step); } catch { queue = undefined; }
    emit(st, s, { type: "context.summary", queue, step: o.step, text, topics: list(o.topics), files: list(o.files) });
    console.log("ok: context summary recorded");
  },

  report() {
    const st = store(); const s = session(st);
    const queue = need(args[1], "<queue>");
    const file = normPath(need(o.file, "--file"));
    if (!existsSync(file)) throw new UsageError(`no such file: ${file}`);
    const summary = need(o.summary, "--summary");
    try { st.readQueue(queue); } catch { throw new UsageError(`unknown queue ${queue}`); }
    // The report lives in the queue's folder, where the dashboard and the run digest read it. Workers may not write
    // under .nexus with their file tools, so they write it anywhere and this command (its only writer) copies it in.
    const target = normPath(join(st.queueDir(queue), "report.md"));
    const same = process.platform === "win32" ? target.toLowerCase() === file.toLowerCase() : target === file;
    if (!same) writeFileSync(target, readFileSync(file));
    emit(st, s, { type: "queue.report", queue, path: target, summary });
    // A source in the project's folder for reports (outside every working tree) is removed once copied; one anywhere
    // else is the worker's or the user's, and stays.
    const removed = !same && inReportFolder(st.readProject().id, file);
    if (removed) rmSync(file, { force: true });
    console.log(`ok: report for queue ${queue} in ${target}${same ? "" : ` (copied from ${file}${removed ? ", which is removed" : ""})`}`);
  },

  log() {
    const st = store(); const s = session(st);
    emit(st, s, { type: "log", level: (o.level ?? "info") as "info", text: need(args[1], "<text>") });
    console.log("ok");
  },

  queue() {
    if (args[1] === "set") {
      const st = store(); const s = orchestrator(st);
      const queue = need(args[2], "<queue>");
      const to = need(args[3], "skipped|finished|cancelled|propose-lift");
      // The server checks it against the queue's state and gives the reason when it refuses.
      const e = emit(st, s, { type: "status.set", queue, step: o.step, to, reason: need(o.reason, "--reason") });
      report(waitApplied(st, s.id, e.id));
      return;
    }
    if (args[1] !== "draft") throw new UsageError("nexus queue draft <file.yaml|-> | nexus queue set <queue> [--step <step>] <status> --reason <text>");
    const st = store(); const s = orchestrator(st);
    const src = need(args[2], "<file.yaml|->");
    const text = src === "-" ? readFileSync(0, "utf8") : readFileSync(normPath(src), "utf8");
    let definition: unknown;
    try { definition = YAML.parse(text); } catch (e) { throw new UsageError(`not valid YAML: ${(e as Error).message}`); }
    const id = (definition as { id?: unknown } | null)?.id;
    if (typeof id !== "string") throw new UsageError("the queue needs an id");
    const e = emit(st, s, { type: "queue.drafted", queue: id, definition });
    report(waitApplied(st, s.id, e.id));
  },

  run() {
    const st = store(); const s = orchestrator(st);
    const queue = need(args[1], "<queue>");
    const action = need(args[2], "start|pause|resume|stop|cancel-start");
    if (!["start", "pause", "resume", "stop", "cancel-start"].includes(action)) throw new UsageError("the action is start, pause, resume, stop or cancel-start");
    if ((o.after || o.at) && action !== "start") throw new UsageError("--after and --at go with start");
    if (o.after && o.at) throw new UsageError("give --after or --at, not both");
    const startAt = o.at === undefined ? undefined : o.at === "usage-reset" ? o.at : localTime(o.at);
    const e = emit(st, s, {
      type: "session.request", action: action === "cancel-start" ? "cancel_start" : action, queue, use_session: o["use-session"],
      model: o.model, effort: o.effort, runtime: o.runtime, after: o.after, start_at: startAt, reason: need(o.reason, "--reason"),
    });
    report(waitApplied(st, s.id, e.id));
  },

  answer() {
    const st = store(); const s = session(st);
    if (s.role !== "orchestrator") throw new UsageError("only an orchestrator session may answer questions");
    if (o.continue && o.wait) throw new UsageError("give at most one of --continue or --wait");
    emit(st, s, {
      type: "answer.given", qid: need(args[1], "<qid>"), text: readText(need(args[2], "<text>")),
      escalate: o.escalate, continue: o.continue ? true : o.wait ? false : undefined,
    });
    console.log(o.escalate ? "ok: escalated to the user" : "ok: answered");
  },

  project() {
    const sub = args[1];
    if (sub === "list") {
      for (const p of readRegistry().projects) console.log(`${p.id.padEnd(16)} ${p.root}`);
      return;
    }
    if (sub !== "add") throw new UsageError("nexus project add <path> | nexus project list");
    const root = normPath(need(args[2], "<path>"));
    if (!existsSync(root)) throw new UsageError(`no such directory: ${root}`);
    const id = o.id ?? basename(root).toLowerCase().replace(/[^a-z0-9-]+/g, "-");
    const st = ProjectStore.init(root, { id, name: o.name ?? basename(root), root });
    const reg = readRegistry();
    if (!reg.projects.some((p) => p.id === id)) { reg.projects.push({ id, root }); writeRegistry(reg); }
    console.log(`ok: project ${id} at ${root}\n    ${st.dir}`);
  },

  import() {
    const st = store();
    const file = normPath(need(args[1], "<file.md>"));
    const result = importMarkdownQueues(readFileSync(file, "utf8"), { source: file, prefix: o.prefix, now: now() });
    const existing = new Set(st.queueIds());
    for (const q of result.queues) {
      const clash = existing.has(q.id);
      console.log(`${clash && !o.replace ? "skip " : o["dry-run"] ? "would " : ""}queue ${q.id} [${q.status}] ${q.title}: ${q.steps.map((s) => `${s.id}=${s.status ?? "pending"}`).join(" ")}${clash && !o.replace ? " (exists; --replace to overwrite)" : ""}`);
      if (!o["dry-run"] && (!clash || o.replace)) st.writeQueue(q);
    }
    for (const s of result.skipped) console.log(`  not a queue: "${s.heading}" (${s.reason})`);
    if (result.defaultStopConditions.length) {
      const p = st.readProject();
      if (!p.defaults.stop_conditions.length) {
        console.log(`${o["dry-run"] ? "would set" : "set"} ${result.defaultStopConditions.length} project-wide stop conditions`);
        if (!o["dry-run"]) st.writeProject({ ...p, defaults: { ...p.defaults, stop_conditions: result.defaultStopConditions } });
      }
    }
  },

  attach() {
    const st = store();
    const project = st.readProject();
    const role = (o.role ?? "worker") as Role;
    const runtime = (o.runtime ?? "external") as Runtime;
    if (o.queue) st.readQueue(o.queue);
    const cwd = normPath(process.cwd());
    const s: SessionFile = {
      protocol: 1, id: newId(), project: project.id, role, runtime, native_id: null, title: o.title,
      cwd, branch: gitBranch(cwd), queue: o.queue ?? null, launched_by: "external", created_at: now(), forked_from: null,
    };
    st.writeSession(s);
    console.log(`ok: session ${s.id}\nPass --session ${s.id} to every nexus command, or set NEXUS_SESSION=${s.id}.`);
  },

  note() {
    const st = store();
    const queue = need(args[1], "<queue>"); const step = need(args[2], "<step>");
    checkStep(st, queue, step);
    const file = st.writeNote(queue, { id: newId(), step, from: (o.from ?? "user") as "user", at: now() }, readText(need(args[3], "<text>")));
    console.log(`ok: note ${resolve(file)}`);
  },
};

/**
 * `nexus review add <step> <picture> --key KEY --role ROLE`: one picture with its view key and role. Its pixel size is
 * read from the file; a wrong pair (no counterpart of its key, other pixel dimensions) is refused with the reason and
 * the pointer to `nexus help review`, and nothing is recorded. Recorded in the given round, else the step's current one.
 */
function reviewAddKeyed(st: ProjectStore, s: SessionFile, queue: string, step: string, targets: string[]): void {
  const key = need(o.key, `--key (it goes with --role). ${REVIEW_HELP}`);
  const role = need(o.role, `--role (it goes with --key: ${PICTURE_ROLES.join(", ")}). ${REVIEW_HELP}`) as PictureRole;
  if (!PICTURE_ROLES.includes(role)) throw new UsageError(`--role is one of ${PICTURE_ROLES.join(", ")}, not "${role}". ${REVIEW_HELP}`);
  if (o.before !== undefined) throw new UsageError(`--before is for pictures without a key; a keyed picture pairs by its key. ${REVIEW_HELP}`);
  if (targets.length !== 1 || /^https?:\/\//.test(targets[0]!)) throw new UsageError(`--key and --role go with exactly one picture (a file). ${REVIEW_HELP}`);
  const path = normPath(targets[0]!);
  if (!existsSync(path)) throw new UsageError(`no such file: ${path}`);
  const kind = (o.kind as ReviewItem["kind"]) ?? guessKind(path);
  if (kind !== "image" && kind !== "sheet") throw new UsageError(`a keyed picture is an image or a sheet, not ${kind ?? "this kind of file"}. ${REVIEW_HELP}`);
  const size = pictureSize(readFileSync(path));
  if (!size) throw new UsageError(`cannot read the pixel size of ${path}: a keyed picture is a PNG, JPEG, GIF or WebP file. ${REVIEW_HELP}`);
  const view = loadProjectState(st).queues.find((q) => q.id === queue)?.steps.find((x) => x.id === step);
  const items = view?.review_items ?? [];
  // The step's current round: the one its latest delivered send-back opened, else the first.
  const round = o.round ? Number(o.round) : view?.sent_back.filter((x) => x.delivered).at(-1)?.round ?? 1;
  const check = checkPicture(items, { path, key, role, round, size }, `${queue}/${step}`);
  if (!check.ok) throw new UsageError(check.message);
  const item: ReviewItem = { path, label: o.label ?? basename(path), kind, key, role, size };
  emit(st, s, { type: "review.added", queue, step, items: [item], round });
  const c = check.counterpart;
  const paired = !c ? (role === "after" || role === "variant-b" ? "" : role === "result" ? ", stands alone" : ", waits for its pair")
    : c.compare === "round" ? `, compared with the ${c.item.role} of round ${c.item.round} (${c.item.path})`
    : `, compared with ${c.compare === "variant" ? "variant-a" : `its ${c.compare}`} (${c.item.path})`;
  console.log(`ok: ${key} ${role}, ${size.width}×${size.height} px, round ${round}, for ${queue}/${step}${paired}`);
}

function guessKind(p: string): ReviewItem["kind"] {
  if (/\.(png|jpe?g|gif|webp|svg)$/i.test(p)) return /sheet/i.test(p) ? "sheet" : "image";
  if (/\.(md|html?|pdf|txt)$/i.test(p)) return "doc";
  if (/\.(json|csv|ya?ml|log)$/i.test(p)) return "data";
  return undefined;
}

try {
  const cmd = args[0];
  if (!cmd || o.help) { console.log(HELP); process.exit(0); }
  const run = commands[cmd];
  if (!run) throw new UsageError(`unknown command "${cmd}" (nexus --help)`);
  await run();
} catch (e) {
  if (e instanceof UsageError) { console.error(`nexus: ${e.message}`); process.exit(2); }
  throw e;
}
