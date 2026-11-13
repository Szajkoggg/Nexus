// The `nexus` command. Agents report through it; the user (or Nexus itself) also uses it for setup.
// Every agent-side command validates its input and appends one event to the session's own log.
import { readFileSync, existsSync } from "node:fs";
import YAML from "yaml";
import { basename, resolve } from "node:path";
import { parseArgs } from "node:util";
import { execFileSync } from "node:child_process";
import {
  Event, ProjectStore, findNexusDir, loadProjectState, newId, normPath, now, readRegistry, writeRegistry,
  type ReviewItem, type Role, type Runtime, type SessionFile,
} from "@nexus/protocol";
import { importMarkdownQueues } from "./import-md.ts";

const HELP = `nexus — report to and manage Nexus (protocol 1)

Agent commands (session from NEXUS_SESSION or --session):
  nexus status                                  current queue, step, notes and open questions
  nexus step start <step>
  nexus step progress <step> <text> [--pct N]
  nexus step done <step> --summary <text> [--commit <sha>]
  nexus step failed <step> --reason <text>
  nexus review add <step> <path|url>... [--label <text>] [--kind image|sheet|doc|data|link] [--round N]
  nexus check <step> <name> --ok|--fail [--summary <text>]
  nexus stop <step> --condition <text> --reason <text>
  nexus ask <text> [--step <step>] [--option <text>]... [--can-continue]
  nexus withdraw <qid> --reason <text>
  nexus context <text|-> [--topics a,b] [--files a,b] [--step <step>]
  nexus report <queue> --file <path> --summary <text>
  nexus log <text> [--level info|warn|error]
  nexus answer <qid> <text> [--escalate] [--continue|--wait]     (orchestrator only)
  nexus queue draft <file.yaml|->                                 (orchestrator only) create or change a queue
  nexus run <queue> start|pause|resume|stop --reason <text> [--use-session <id>] [--runtime claude|codex] [--model <m>] [--effort <e>]   (orchestrator only)
  (--queue <id> picks the queue when the session has none or the step id is ambiguous)

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
    "use-session": { type: "string" }, model: { type: "string" }, effort: { type: "string" },
    topics: { type: "string" }, files: { type: "string" }, file: { type: "string" }, level: { type: "string" },
    escalate: { type: "boolean" }, continue: { type: "boolean" }, wait: { type: "boolean" },
    id: { type: "string" }, name: { type: "string" }, prefix: { type: "string" },
    "dry-run": { type: "boolean" }, replace: { type: "boolean" },
    role: { type: "string" }, runtime: { type: "string" }, title: { type: "string" }, from: { type: "string" },
    help: { type: "boolean", short: "h" }, now: { type: "boolean" }, ref: { type: "string" },
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

/** What an orchestrator needs to see: every queue, run, open question and worker session with its context card. */
function overview(state: ReturnType<typeof loadProjectState>): void {
  const pct = (t?: number, w?: number) => (t && w ? `${Math.round((100 * t) / w)} % context` : "context unknown");
  const done = state.queues.filter((q) => q.status === "done" || q.status === "cancelled");
  console.log(`
Queues (${state.queues.length - done.length} open; finished: ${done.map((q) => q.id).join(", ") || "none"})`);
  for (const q of state.queues.filter((x) => !done.includes(x))) {
    const run = q.run ? `; run ${q.run.state}${q.run.step ? ` at ${q.run.step}` : ""} in session ${q.run.session}${q.run.reason ? ` (${q.run.reason})` : ""}` : "";
    console.log(`- ${q.id} [${q.status}] ${q.title}: revision ${q.revision}, ${q.approved ? "approved" : "not approved"}${run}`);
    console.log(`  steps: ${q.steps.map((x) => `${x.id} ${x.status}`).join(", ")}`);
    if (q.status_reason && q.status !== "running") console.log(`  why: ${q.status_reason.replace(/\s+/g, " ").slice(0, 300)}`);
  }
  const open = state.questions.filter((x) => x.state === "open" || x.state === "escalated");
  console.log(`
Open questions (${open.length})`);
  for (const x of open) console.log(`- ${x.qid} [${x.state}] ${x.queue ?? ""}${x.step ? `/${x.step}` : ""}: ${x.text}`);
  const workers = state.sessions.filter((x) => x.role === "worker");
  console.log(`
Worker sessions (${workers.length})`);
  for (const w of workers) {
    const busy = state.queues.find((q) => q.run?.session === w.id && ["running", "pausing", "usage_wait", "retry_wait"].includes(q.run.state));
    console.log(`- ${w.id} "${w.title ?? ""}" ${w.runtime}${w.launched_by === "nexus" ? "" : " (external)"}, ${w.live?.state ?? "not live"}, ${w.live?.model ?? w.model ?? "model ?"}, ${pct(w.live?.context_tokens, w.live?.context_window)}${busy ? `, running queue ${busy.id}` : ", free"}`);
    if (w.context) console.log(`  knows: ${w.context.topics.join(", ") || "-"}; ${w.context.text.replace(/\s+/g, " ").slice(0, 300)}`);
  }
  const attention = state.attention.filter((a) => a.kind !== "question");
  if (attention.length) {
    console.log(`
Waiting for the user`);
    for (const a of attention) console.log(`- ${a.kind} ${a.queue ?? ""}${a.step ? `/${a.step}` : ""}: ${a.text.replace(/\s+/g, " ").slice(0, 160)}`);
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
    const queues = s?.queue ? state.queues.filter((q) => q.id === s.queue) : state.queues.filter((q) => ["running", "waiting", "stopped"].includes(q.status));
    for (const q of queues) {
      console.log(`\nqueue ${q.id} [${q.status}] ${q.title}${q.approved ? "" : " (no approval recorded for this revision)"}`);
      if (q.status_reason) console.log(`  why: ${q.status_reason.slice(0, 300)}`);
      for (const step of q.steps) {
        const unread = step.notes.filter((n) => !n.read_at);
        console.log(`  ${step.id.padEnd(5)} ${step.status.padEnd(8)} ${step.title}${unread.length ? `  (${unread.length} unread note${unread.length > 1 ? "s" : ""})` : ""}`);
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
      } else {
        console.log(`\nSTOP requested by the ${m.from}${m.text ? `: ${m.text}` : ""}. Finish the current action, then stop and report.`);
      }
      st.appendEvent({ v: 1, id: newId(), at: now(), session: s!.id, type: "message.read", message: m.id });
    }
    if (s?.queue) {
      const q = state.queues.find((x) => x.id === s.queue);
      for (const step of q?.steps ?? []) for (const n of step.notes.filter((x) => !x.read_at)) {
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
    if (args[1] !== "add") throw new UsageError("nexus review add <step> <path|url>...");
    const st = store(); const s = session(st);
    const step = need(args[2], "<step>");
    const queue = queueFor(st, s, step);
    checkStep(st, queue, step);
    const targets = args.slice(3);
    if (!targets.length) throw new UsageError("missing <path|url>");
    const items: ReviewItem[] = targets.map((t) => {
      if (/^https?:\/\//.test(t)) return { url: t, label: o.label, kind: (o.kind as ReviewItem["kind"]) ?? "link" };
      const p = normPath(t);
      if (!existsSync(p)) throw new UsageError(`no such file: ${p}`);
      return { path: p, label: o.label ?? basename(p), kind: (o.kind as ReviewItem["kind"]) ?? guessKind(p) };
    });
    emit(st, s, { type: "review.added", queue, step, items, round: o.round ? Number(o.round) : undefined });
    console.log(`ok: ${items.length} review item(s) for ${queue}/${step}`);
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
    emit(st, s, { type: "queue.report", queue, path: file, summary: need(o.summary, "--summary") });
    console.log(`ok: report for queue ${queue}`);
  },

  log() {
    const st = store(); const s = session(st);
    emit(st, s, { type: "log", level: (o.level ?? "info") as "info", text: need(args[1], "<text>") });
    console.log("ok");
  },

  queue() {
    if (args[1] !== "draft") throw new UsageError("nexus queue draft <file.yaml|->");
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
    const action = need(args[2], "start|pause|resume|stop");
    if (!["start", "pause", "resume", "stop"].includes(action)) throw new UsageError("the action is start, pause, resume or stop");
    const e = emit(st, s, { type: "session.request", action, queue, use_session: o["use-session"], model: o.model, effort: o.effort, runtime: o.runtime, reason: need(o.reason, "--reason") });
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
