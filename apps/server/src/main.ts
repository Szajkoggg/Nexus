// The Nexus server: reads every registered project's .nexus/ directory, serves the dashboard and its API,
// and tells connected dashboards when a project's files change. It writes nothing in phase 1.
import { createReadStream, createWriteStream, existsSync, mkdirSync, realpathSync, statSync, type WriteStream } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { Hono } from "hono";
import { serve, type HttpBindings } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { WebSocketServer, type WebSocket } from "ws";
import chokidar, { type FSWatcher } from "chokidar";
import type { Server } from "node:http";
import {
  ActionError, Effort, ProjectStore, addNote, updateSettings, answerAsUser, approveQueue, deleteNote, loadProjectState, nexusHome, withdrawApproval, addAllowRule,
  readRegistry, readUsage, routeAnswers, routeSendBacks, sendBack, sendMessage, setQueueSettings, type ProjectState,
} from "@nexus/protocol";
import { Engine } from "./engine.ts";
import { branchState, stepCommits } from "./gitinfo.ts";
import { Orchestrator } from "./orchestrator.ts";
import { Conversations } from "./conversations.ts";
import { listModels } from "./models.ts";
import { readDeployChanges, readDeploySettings, writeDeploySettings } from "./deploy.ts";
import { Standby, refuseHandoverDir, smokeCheck, takeHandoverEnv } from "./handover.ts";
import { Lifecycle, version } from "./lifecycle.ts";
import {
  AttentionWatch, allowed, auth, authCookie, isLocal, loginPage, push, pushDevices, pushKey, qrSvg, rotateToken,
  subscribe, tailscaleInfo, tokenMatches, unsubscribe,
} from "./remote.ts";

// Started by an update (src/handover.ts): NEXUS_HANDOVER names the folder to take over through. It is read once and
// removed from the environment, so nothing this server starts inherits it: an agent's test server that inherited it
// would take the live predecessor's folder for its own.
const HANDOVER = takeHandoverEnv();

// NEXUS_LOG: the server writes its own log (1: <NEXUS_HOME>/server.log, or a path). Node opens it shared, so a
// successor after an update can append while its predecessor still holds it (a shell's `>>` would lock it).
let log: WriteStream | undefined;
if (process.env.NEXUS_LOG) {
  const file = process.env.NEXUS_LOG === "1" ? join(nexusHome(), "server.log") : process.env.NEXUS_LOG;
  mkdirSync(dirname(file), { recursive: true });
  log = createWriteStream(file, { flags: "a" });
  const logTo = log;
  for (const stream of [process.stdout, process.stderr]) {
    const write = stream.write.bind(stream) as (chunk: unknown, ...rest: unknown[]) => boolean;
    stream.write = ((chunk: unknown, ...rest: unknown[]) => { logTo.write(chunk as string); return write(chunk, ...rest); }) as typeof stream.write;
  }
  process.on("uncaughtException", (err) => { logTo.write(`${new Date().toISOString()} uncaught: ${err.stack ?? err}\n`); process.exit(1); });
  console.log(`---- ${new Date().toISOString()} pid ${process.pid}`);
}

// A backstop: a hand-over folder that is not this NEXUS_HOME's is not ours. Refuse it before anything is written or
// started, and exit non-zero: a real predecessor then sees a failure and rolls back.
const refusal = HANDOVER ? refuseHandoverDir(HANDOVER) : undefined;
if (refusal) {
  console.error(`refusing to take over: ${refusal}; exiting without starting`);
  if (log) await new Promise<void>((r) => log!.end(() => r()));
  process.exit(1);
}

const PORT = Number(process.env.NEXUS_PORT ?? 4317);
const HOST = process.env.NEXUS_HOST ?? "127.0.0.1";
const WEB_DIST = resolve(dirname(fileURLToPath(import.meta.url)), "../../web/dist");
// Started by an update: read-only until the predecessor hands over. A plain start, or one by an older server that
// does not hand over, is active at once.
/** Only an active server builds engines, recovers runs, starts agents or writes under a project's .nexus/. */
let active = !HANDOVER;
/** Waiting to take over (NEXUS_HANDOVER): until then a failure goes to failed.json for the predecessor. */
let standingBy = !!HANDOVER;

// ---------------------------------------------------------------- projects

interface Entry { id: string; root: string; store: ProjectStore; engine: Engine; orchestrator: Orchestrator; conversations: Conversations; state?: ProjectState; error?: string }
const projects = new Map<string, Entry>();

function refreshRegistry(): void {
  if (!active) return;
  const reg = readRegistry();
  for (const p of reg.projects) {
    if (projects.has(p.id)) continue;
    const store = ProjectStore.forRoot(p.root);
    const engine = new Engine(store, () => changed(p.id));
    // Through its usual notices it is told the outcome of an update it asked for (lifecycle.notice), and what changed
    // for agents in each deploy since its session began (deploy-changes.jsonl).
    const orchestrator = new Orchestrator(store, engine, () => changed(p.id), { update: () => lifecycle.notice(), changes: readDeployChanges, push: (n) => void push(n) });
    projects.set(p.id, { id: p.id, root: p.root, store, engine, orchestrator, conversations: new Conversations(store, orchestrator, () => changed(p.id)) });
    watchProject(p.id, store.dir);
  }
  for (const id of projects.keys()) if (!reg.projects.some((p) => p.id === id)) projects.delete(id);
}

function stateOf(e: Entry): ProjectState | undefined {
  if (!e.state && !e.error) {
    try { e.state = loadProjectState(e.store); } catch (err) { e.error = (err as Error).message; }
  }
  return e.state;
}

// ---------------------------------------------------------------- change notification

const sockets = new Set<WebSocket>();
const pending = new Map<string, NodeJS.Timeout>();

function changed(id: string): void {
  if (!active) return;
  clearTimeout(pending.get(id));
  pending.set(id, setTimeout(() => {
    pending.delete(id);
    if (!active) return;
    const e = projects.get(id);
    if (e) {
      e.state = undefined; e.error = undefined;
      // Deliver new answers to the sessions that asked. Its own inbox writes come back here and route nothing.
      const s = stateOf(e);
      if (s) {
        try { if (routeAnswers(e.store, s) > 0) e.state = undefined; }
        catch (err) { console.error(`routing answers in ${id}: ${(err as Error).message}`); }
        // Send-backs not delivered yet (the action delivers its own at once; this is the backstop).
        try { const fresh = stateOf(e); if (fresh && routeSendBacks(e.store, fresh) > 0) e.state = undefined; }
        catch (err) { console.error(`routing send-backs in ${id}: ${(err as Error).message}`); }
        try { const fresh = stateOf(e); if (fresh) e.orchestrator.onChange(fresh); }
        catch (err) { console.error(`orchestrator in ${id}: ${(err as Error).message}`); }
        e.state = undefined;
        try { const fresh = stateOf(e); if (fresh) e.engine.onChange(fresh); }
        catch (err) { console.error(`engine in ${id}: ${(err as Error).message}`); }
        e.state = undefined;
      }
    }
    if (e) { const s = stateOf(e); if (s) watch.check({ id, name: s.project.name }, s.attention); }
    const msg = JSON.stringify({ type: "changed", project: id });
    for (const s of sockets) if (s.readyState === s.OPEN) s.send(msg);
  }, 150));
}

const watchers: FSWatcher[] = [];
function watchProject(id: string, dir: string): void {
  watchers.push(chokidar
    .watch(dir, { ignoreInitial: true, ignored: (p) => p.endsWith(".tmp") })
    .on("all", () => changed(id))
    .on("error", (err) => console.error(`watch ${id}: ${(err as Error).message}`)));
}

chokidar.watch(join(nexusHome(), "projects.yaml"), { ignoreInitial: true }).on("all", () => {
  if (!active) return;
  refreshRegistry();
  for (const s of sockets) if (s.readyState === s.OPEN) s.send(JSON.stringify({ type: "projects" }));
});

// ---------------------------------------------------------------- files the dashboard may show

/** A file is served when it lies under the project, its worktree directory or a session's working directory. */
function allowedRoots(e: Entry, state: ProjectState): string[] {
  const roots = [e.root, state.project.defaults.worktree_dir, ...state.sessions.map((s) => s.cwd)];
  return roots.filter((r): r is string => !!r && existsSync(r)).map((r) => realpathSync(r).toLowerCase());
}

const MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".svg": "image/svg+xml", ".md": "text/markdown; charset=utf-8", ".txt": "text/plain; charset=utf-8",
  ".json": "application/json", ".yaml": "text/plain; charset=utf-8", ".yml": "text/plain; charset=utf-8",
  ".log": "text/plain; charset=utf-8", ".csv": "text/plain; charset=utf-8", ".html": "text/plain; charset=utf-8",
  ".pdf": "application/pdf",
};

// ---------------------------------------------------------------- HTTP

const app = new Hono<{ Bindings: HttpBindings }>();
const lifecycle = new Lifecycle(() => [...projects.values()].map((e) => ({
  id: e.id,
  idle: () => e.engine.idle() && e.orchestrator.idle() && e.conversations.idle(),
  drain: (now: boolean) => { e.conversations.draining = true; return e.engine.drainForUpdate(now); },
  cancel: () => { e.conversations.draining = false; e.engine.cancelDrain(); },
  shutdown: () => { e.engine.shutdown(); e.orchestrator.shutdown(); e.conversations.shutdown(); },
})), () => { for (const s of sockets) if (s.readyState === s.OPEN) s.send(JSON.stringify({ type: "server" })); }, {
  release, reacquire,
  notify: (text) => void push({ title: "Nexus: update failed", body: text.slice(0, 180), url: "/?settings", tag: "nexus-update" }),
  // Settled (up and pushed, failed, cancelled): what was held while it drained, and its outcome, go out now.
  settled: () => { for (const id of projects.keys()) changed(id); },
});
const watch = new AttentionWatch();

// Remote devices sign in once with the access token; this machine needs nothing (src/remote.ts).
const OPEN = new Set(["/login", "/manifest.webmanifest", "/sw.js"]);
app.use("*", async (c, next) => {
  if (OPEN.has(c.req.path) || c.req.path.startsWith("/icons/") || allowed(c.env.incoming)) return next();
  if (c.req.path.startsWith("/api/")) return c.json({ error: "sign in first" }, 401);
  return c.redirect("/login");
});
// A successor waiting for its predecessor serves no project yet (it has none loaded) and starts no update.
const starting = (c: import("hono").Context) => c.json({ error: "Nexus is starting" }, 503);
app.use("/api/projects", async (c, next) => (active ? next() : starting(c)));
app.use("/api/projects/*", async (c, next) => (active ? next() : starting(c)));
app.use("/api/server/*", async (c, next) => (active || c.req.method === "GET" ? next() : starting(c)));
const secure = (c: { req: { header: (n: string) => string | undefined } }) =>
  c.req.header("x-forwarded-proto") === "https" || !!c.req.header("tailscale-user-login") || /\.ts\.net(:\d+)?$/.test(c.req.header("host") ?? "");
app.get("/login", (c) => {
  const t = c.req.query("token");
  if (t && tokenMatches(t)) { c.header("set-cookie", authCookie(secure(c))); return c.redirect("/"); }
  return c.html(loginPage(t ? "That token is not valid (it may have been replaced)." : undefined));
});
app.post("/login", async (c) => {
  const form = await c.req.parseBody();
  if (!tokenMatches(typeof form.token === "string" ? form.token.trim() : undefined)) return c.html(loginPage("That token is not valid."), 401);
  c.header("set-cookie", authCookie(secure(c)));
  return c.redirect("/");
});

app.get("/api/projects", (c) => {
  refreshRegistry();
  return c.json([...projects.values()].map((e) => {
    const s = stateOf(e);
    const count = (st: string) => s?.queues.filter((q) => q.status === st).length ?? 0;
    return {
      id: e.id, root: e.root, name: s?.project.name ?? e.id, error: e.error,
      running: count("running"), waiting: count("waiting"), stopped: count("stopped"),
      open_questions: s?.questions.filter((q) => q.state === "open" || q.state === "escalated").length ?? 0,
      attention: s?.attention ?? [],
    };
  }));
});

app.get("/api/projects/:id/state", (c) => {
  const e = projects.get(c.req.param("id"));
  if (!e) return c.json({ error: "unknown project" }, 404);
  const s = stateOf(e);
  return s ? c.json(s) : c.json({ error: e.error }, 500);
});

app.get("/api/projects/:id/file", (c) => {
  const e = projects.get(c.req.param("id"));
  const s = e && stateOf(e);
  const path = c.req.query("path");
  if (!e || !s || !path) return c.json({ error: "unknown project or no path" }, 404);
  let real: string;
  try { real = realpathSync(path); } catch { return c.json({ error: "not found" }, 404); }
  const lower = real.toLowerCase();
  if (!allowedRoots(e, s).some((r) => lower === r || lower.startsWith(r + "\\") || lower.startsWith(r + "/"))) {
    return c.json({ error: "outside the project" }, 403);
  }
  if (!statSync(real).isFile()) return c.json({ error: "not a file" }, 404);
  const type = MIME[extname(real).toLowerCase()] ?? "application/octet-stream";
  return new Response(Readable.toWeb(createReadStream(real)) as ReadableStream, {
    headers: { "content-type": type, "cache-control": "no-cache", "x-content-type-options": "nosniff" },
  });
});

// ---------------------------------------------------------------- writes (the user's actions)

/**
 * Writes accept JSON only and only from this server's own pages: a cross-site form cannot send JSON without a
 * preflight this server never grants, and a stray Origin is refused outright.
 *
 * Every write is a user action, so it must come from the dashboard's own page: a browser sends its Origin (and
 * Sec-Fetch-Site) with every such request; an agent's script or a curl on this machine does not. Agents change
 * things through the nexus CLI, which writes files. The only exceptions are what `nexus server` itself sends
 * (`update` and `cancel`, which the CLI keeps to the user and to an orchestrator the user asked).
 */
const CLI_WRITES = new Set(["/api/server/update", "/api/server/cancel"]);
app.use("/api/*", async (c, next) => {
  if (c.req.method === "GET" || c.req.method === "HEAD") return next();
  const origin = c.req.header("origin");
  if (origin && new URL(origin).host !== c.req.header("host")) return c.json({ error: "cross-origin write refused" }, 403);
  if (!c.req.header("content-type")?.startsWith("application/json")) return c.json({ error: "JSON only" }, 415);
  if (CLI_WRITES.has(c.req.path)) return next();
  const site = c.req.header("sec-fetch-site");
  if (!origin || (site !== undefined && site !== "same-origin")) {
    return c.json({ error: "only the user does this, from the dashboard (agents use the nexus CLI)" }, 403);
  }
  return next();
});

// While an update drains, nothing new starts: no run, no orchestrator turn.
app.use("/api/projects/:id/*", async (c, next) => {
  if (c.req.method === "POST" && lifecycle.busy) {
    const orchestrator = c.req.path.endsWith("/orchestrator/messages");
    const action = c.req.path.endsWith("/run") ? ((await c.req.json().catch(() => ({}))) as { action?: string }).action : undefined;
    if (orchestrator || action === "start" || action === "resume" || c.req.path.endsWith("/continue")) {
      return c.json({ error: "Nexus is updating; try again in a moment" }, 409);
    }
  }
  return next();
});

type Body = Record<string, unknown>;
function act(handler: (store: ProjectStore, body: Body, p: (name: string) => string) => unknown) {
  return async (c: import("hono").Context) => {
    const e = projects.get(c.req.param("id") ?? "");
    if (!e) return c.json({ error: "unknown project" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as Body;
    try {
      const result = handler(e.store, body, (n) => c.req.param(n) ?? "");
      changed(e.id);
      return c.json({ ok: true, result: result ?? null });
    } catch (err) {
      if (err instanceof ActionError) return c.json({ error: err.message }, err.status as 400);
      console.error(err);
      return c.json({ error: (err as Error).message }, 500);
    }
  };
}

app.post("/api/projects/:id/queues/:queue/steps/:step/notes", act((st, b, p) => addNote(st, p("queue"), p("step"), b.text)));
app.delete("/api/projects/:id/queues/:queue/steps/:step/notes/:note", act((st, _b, p) => deleteNote(st, p("queue"), p("step"), p("note"))));
app.post("/api/projects/:id/sessions/:session/messages", act((st, b, p) =>
  sendMessage(st, p("session"), b.text, { queue: b.queue as string | undefined, step: b.step as string | undefined })));
app.post("/api/projects/:id/queues/:queue/approve", act((st, b, p) => approveQueue(st, p("queue"), b.words)));
// Withdrawing an approval and adding an allow rule are the user's too, like every write (see the guard above): an agent
// must not take an approval back or widen its own permissions.
app.post("/api/projects/:id/queues/:queue/withdraw", act((st, b, p) => withdrawApproval(st, p("queue"), b.reason)));
app.post("/api/projects/:id/settings/allow-rule", act((st, b) => addAllowRule(st, b.rule)));
app.patch("/api/projects/:id/queues/:queue", act((st, b, p) => setQueueSettings(st, p("queue"), b)));
app.post("/api/projects/:id/questions/:qid/answer", act((st, b, p) => answerAsUser(st, p("qid"), b.text, b.continue)));

// The engine: running queues through Nexus-launched sessions.
const engineOf = (st: ProjectStore) => [...projects.values()].find((e) => e.store === st)!.engine;
app.post("/api/projects/:id/queues/:queue/run", act((st, b, p) => {
  const engine = engineOf(st); const q = p("queue");
  switch (b.action) {
    case "start": {
      const options = {
        model: (b.model as string) || undefined, session: (b.session as string) || undefined,
        effort: Effort.safeParse(b.effort).success ? (b.effort as Effort) : undefined,
        runtime: b.runtime === "codex" || b.runtime === "claude" ? b.runtime as "claude" | "codex" : undefined,
      };
      // With `after`: a chain, the queue starts when that one is done. With `at` (ISO 8601, or usage-reset): a schedule.
      if (typeof b.after === "string" && b.after && typeof b.at === "string" && b.at) throw new ActionError("give after or at, not both");
      if (typeof b.after === "string" && b.after) return { message: engine.chain(q, { ...options, after: b.after, by: "user" }) };
      if (typeof b.at === "string" && b.at) return { message: engine.scheduleStart(q, { ...options, at: b.at, by: "user" }) };
      return engine.start(q, options);
    }
    case "pause": return engine.pause(q);
    case "resume": return engine.resume(q);
    case "stop": return engine.stopNow(q, b.text as string | undefined);
    case "cancel_start": return { message: engine.cancelStart(q) };
    default: throw new ActionError("action is start, pause, resume, stop or cancel_start");
  }
}));
// Continue on a stopped queue: the user's lift of the stop, then the run goes on (only from the dashboard, as every write).
app.post("/api/projects/:id/queues/:queue/continue", act((st, _b, p) => engineOf(st).continueQueue(p("queue"))));
// Fix it: the user sends a step waiting for their review back to its worker, with what they want (required).
app.post("/api/projects/:id/queues/:queue/steps/:step/send-back", act((st, b, p) => ({ message: sendBack(st, { queue: p("queue"), step: p("step"), from: "user", text: b.text }) })));
// Push again: the last failed push of an accepted step of this queue, tried again.
app.post("/api/projects/:id/queues/:queue/push", act((st, _b, p) => ({ message: engineOf(st).pushAgain(p("queue")) })));
// Reject: the user's, on a step waiting for their review; the run pauses until a new revision is approved.
app.post("/api/projects/:id/queues/:queue/steps/:step/reject", act((st, b, p) => ({ message: engineOf(st).rejectStep(p("queue"), p("step"), b.text) })));
app.post("/api/projects/:id/queues/:queue/steps/:step/accept", act((st, b, p) => engineOf(st).acceptReview(p("queue"), p("step"), b.text, b.note_to)));

app.get("/api/projects/:id/sessions/:session/activity", (c) => {
  const e = projects.get(c.req.param("id"));
  if (!e) return c.json({ error: "unknown project" }, 404);
  return c.json(e.engine.activity(c.req.param("session"), c.req.query("queue"), c.req.query("step"), Number(c.req.query("limit") ?? 300)));
});

// Git on the dashboard (src/gitinfo.ts; local git only, never a fetch): a step's commits per round, a queue's branch.
// null when the project is not a git repository (or nothing was recorded).
app.get("/api/projects/:id/queues/:queue/steps/:step/commits", (c) => {
  const e = projects.get(c.req.param("id"));
  const q = e ? stateOf(e)?.queues.find((x) => x.id === c.req.param("queue")) : undefined;
  if (!e || !q) return c.json({ error: "unknown project or queue" }, 404);
  return c.json(stepCommits(e.store, q, c.req.param("step")) ?? null);
});
app.get("/api/projects/:id/queues/:queue/git", (c) => {
  const e = projects.get(c.req.param("id"));
  const q = e ? stateOf(e)?.queues.find((x) => x.id === c.req.param("queue")) : undefined;
  if (!e || !q) return c.json({ error: "unknown project or queue" }, 404);
  return c.json(branchState(e.store, q) ?? null);
});

// Refused actions of every session of the project, oldest first; with ?queue= (and &step=) only those of a step.
app.get("/api/projects/:id/refusals", (c) => {
  const e = projects.get(c.req.param("id"));
  if (!e) return c.json({ error: "unknown project" }, 404);
  const queue = c.req.query("queue"), step = c.req.query("step");
  const all = e.store.sessionIds().flatMap((s) => e.store.readRefusals(s).entries)
    .filter((r) => (!queue || r.queue === queue) && (!step || r.step === step));
  return c.json(all.sort((a, b) => a.at.localeCompare(b.at)));
});

app.get("/api/usage", (c) => c.json(readUsage() ?? null));

// Nexus itself: its version, and updating it without cutting off running work (src/lifecycle.ts).
app.get("/api/server", async (c) => c.json({ ...(await version()), update: lifecycle.status, push_on_deploy: readDeploySettings().push_on_deploy, running: runningSteps() }));

/** The steps running now, per project: what an update would wait for (nexus server status shows them). */
function runningSteps() {
  return [...projects.values()].flatMap((e) => {
    const s = stateOf(e);
    const steps = (s?.queues ?? []).flatMap((q) => q.steps.filter((x) => x.status === "running")
      .map((x) => ({ queue: q.id, step: x.id, title: x.title, session: q.run?.session ?? null, run: q.run?.state ?? null })));
    return steps.length ? [{ project: e.id, name: s?.project.name ?? e.id, steps }] : [];
  });
}
// Whether a deploy pushes the deployed main (src/deploy.ts): the user's to switch, from the dashboard only.
app.post("/api/server/settings", async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as { push_on_deploy?: unknown };
  if (typeof b.push_on_deploy !== "boolean") return c.json({ error: "push_on_deploy is true or false" }, 400);
  writeDeploySettings({ ...readDeploySettings(), push_on_deploy: b.push_on_deploy });
  for (const s of sockets) if (s.readyState === s.OPEN) s.send(JSON.stringify({ type: "server" }));
  return c.json({ ok: true, push_on_deploy: b.push_on_deploy });
});
app.post("/api/server/update", async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as { now?: unknown; ref?: unknown; by?: { project?: unknown; session?: unknown } };
  // `by`: the orchestrator session that ran `nexus server update` (the CLI sends it); it is told the outcome. Only an
  // orchestrator session of a registered project counts; the dashboard sends none.
  let by: { project: string; session: string } | undefined;
  const e = typeof b.by?.project === "string" ? projects.get(b.by.project) : undefined;
  if (e && typeof b.by?.session === "string") {
    try { if (e.store.readSession(b.by.session).role === "orchestrator") by = { project: e.id, session: b.by.session }; } catch { /* no such session */ }
  }
  try { return c.json(lifecycle.start({ now: b.now === true, ref: typeof b.ref === "string" ? b.ref : undefined, by })); }
  catch (e) { return c.json({ error: (e as Error).message }, 409); }
});
app.post("/api/server/cancel", (c) => {
  try { lifecycle.cancel(); return c.json(lifecycle.status); } catch (e) { return c.json({ error: (e as Error).message }, 409); }
});

// Remote access: shown and changed only from this machine.
app.get("/api/remote", async (c) => {
  const local = isLocal(c.env.incoming);
  const ts = await tailscaleInfo();
  const base = (c.req.query("base") || ts.url || "").replace(/\/$/, "");
  const login = local && base ? `${base}/login?token=${encodeURIComponent(auth().token)}` : undefined;
  return c.json({
    local, tailscale: ts, base: base || null, devices: pushDevices(),
    token: local ? auth().token : undefined, login_url: login, qr: login ? await qrSvg(login) : undefined,
  });
});
app.post("/api/remote/rotate", (c) => {
  if (!isLocal(c.env.incoming)) return c.json({ error: "only from this machine" }, 403);
  rotateToken();
  return c.json({ ok: true });
});
app.get("/api/push/key", (c) => c.json({ key: pushKey() }));
app.post("/api/push/subscribe", async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as { subscription?: unknown; label?: unknown };
  try { subscribe(b.subscription, b.label); return c.json({ ok: true }); } catch (e) { return c.json({ error: (e as Error).message }, 400); }
});
app.post("/api/push/unsubscribe", async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as { endpoint?: unknown };
  unsubscribe(b.endpoint);
  return c.json({ ok: true });
});
app.post("/api/push/test", async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as { endpoint?: unknown };
  const only = typeof b.endpoint === "string" ? b.endpoint : undefined;
  return c.json({ sent: await push({ title: "Nexus", body: "Notifications reach this device.", url: "/", tag: "test" }, only) });
});
app.get("/api/models/:runtime", async (c) => {
  const r = c.req.param("runtime");
  return r === "claude" || r === "codex" ? c.json(await listModels(r)) : c.json({ error: "runtime is claude or codex" }, 404);
});

// The orchestrator chat.
const orchestratorOf = (st: ProjectStore) => [...projects.values()].find((e) => e.store === st)!.orchestrator;
app.get("/api/projects/:id/orchestrator", (c) => {
  const e = projects.get(c.req.param("id"));
  return e ? c.json(e.orchestrator.view()) : c.json({ error: "unknown project" }, 404);
});
app.post("/api/projects/:id/orchestrator/messages", act((st, b) => orchestratorOf(st).say(b.text)));
app.post("/api/projects/:id/orchestrator/reset", act((st) => orchestratorOf(st).reset()));
// Conversations: thinking partners for the project.
const conversationsOf = (st: ProjectStore) => [...projects.values()].find((e) => e.store === st)!.conversations;
app.get("/api/projects/:id/conversations", (c) => {
  const e = projects.get(c.req.param("id"));
  return e ? c.json(e.conversations.list()) : c.json({ error: "unknown project" }, 404);
});
app.get("/api/projects/:id/conversations/:cid", (c) => {
  const e = projects.get(c.req.param("id"));
  if (!e) return c.json({ error: "unknown project" }, 404);
  try { return c.json(e.conversations.view(c.req.param("cid"))); } catch (err) { return c.json({ error: (err as Error).message }, 404); }
});
app.post("/api/projects/:id/conversations", act((st, b) => conversationsOf(st).create(b)));
// The step's latest conversation that is not archived ("Chat about this" opens it, or starts one when there is none).
app.get("/api/projects/:id/queues/:q/steps/:s/conversation", (c) => {
  const e = projects.get(c.req.param("id"));
  if (!e) return c.json({ error: "unknown project" }, 404);
  return c.json({ conversation: e.conversations.latestFor(c.req.param("q"), c.req.param("s")) ?? null });
});
app.patch("/api/projects/:id/conversations/:cid", act((st, b, p) => conversationsOf(st).update(p("cid"), b)));
app.post("/api/projects/:id/conversations/:cid/messages", act((st, b, p) => conversationsOf(st).say(p("cid"), b.text)));
app.post("/api/projects/:id/conversations/:cid/handoff", act((st, _b, p) => conversationsOf(st).handoff(p("cid"))));
app.post("/api/projects/:id/orchestrator/settings", act((st, b) => orchestratorOf(st).settings(b.model, b.effort)));
app.patch("/api/projects/:id/settings", act((st, b) => updateSettings(st, b)));

if (existsSync(WEB_DIST)) {
  app.use("/*", serveStatic({ root: WEB_DIST.replaceAll("\\", "/") }));
  app.get("*", serveStatic({ path: join(WEB_DIST, "index.html").replaceAll("\\", "/") }));
}

// ---------------------------------------------------------------- start

/** Builds the engines (which recover and resume held runs) and starts watching: this server now owns the files. */
function activate(): void {
  active = true;
  refreshRegistry();
  // The first look at each project is the baseline for push notifications: old news is not pushed after a restart.
  for (const e of projects.values()) { const s = stateOf(e); if (s) watch.check({ id: e.id, name: s.project.name }, s.attention); }
  // Then one pass over every project, as after a change: the watchers report only changes from now on, so what came
  // up while the predecessor drained or restarted (a run finished, an approval, a question) would wait for the next
  // write in that project. This tells each orchestrator now, and starts its turn.
  for (const id of projects.keys()) changed(id);
}

/** The successor's side of an update: prove it is up, say so, and take over once the predecessor has let go. */
async function takeOver(standby: Standby): Promise<void> {
  const host = HOST === "0.0.0.0" || HOST === "::" ? "127.0.0.1" : HOST.includes(":") ? `[${HOST}]` : HOST;
  const problems = await smokeCheck(`http://${host}:${PORT}`, existsSync(WEB_DIST));
  if (problems.length) {
    console.error(`smoke check failed: ${problems.join("; ")}`);
    standby.failed(problems.join("; "));
    process.exit(1);
  }
  const v = await version();
  standby.ready({ commit: v.commit, subject: v.subject });
  console.log("smoke check passed; waiting for the predecessor to hand over");
  const { released, predecessor } = await standby.released();
  standingBy = false;
  activate();
  lifecycle.arrived(v, predecessor, released);
  console.log(`took over from ${predecessor ? `${predecessor.commit} (pid ${predecessor.pid})` : "no recorded predecessor"}${released ? "" : ", which exited without handing over"}`);
}

/** The predecessor's side of an update: stop every agent and every write, and free the port. It stays alive. */
async function release(): Promise<void> {
  active = false;
  for (const t of pending.values()) clearTimeout(t);
  pending.clear();
  await Promise.all(watchers.splice(0).map((w) => w.close()));
  for (const e of projects.values()) { e.engine.shutdown(); e.orchestrator.shutdown(); e.conversations.shutdown(); }
  // An agent's exit is written to its runtime file: wait for those last writes.
  const alive = () => [...projects.values()].some((e) => e.engine.alive() || e.orchestrator.alive() || e.conversations.alive());
  for (const until = Date.now() + 10_000; alive() && Date.now() < until;) await new Promise((r) => setTimeout(r, 100));
  for (const s of sockets) s.terminate();
  const http = server as Server;
  await new Promise<void>((r) => { http.close(() => r()); http.closeAllConnections(); });
}

/**
 * After a failed hand-over: take the port again (the stopped successor may take a moment to free it) and start over
 * on the files with new engines, whose recovery resumes the queues the update held. The work goes on even if the
 * port cannot be had; the error says so.
 */
async function reacquire(): Promise<void> {
  projects.clear(); // their engines are shut down for good
  const http = server as Server;
  reacquiring = true;
  try {
    await new Promise<void>((resolve, reject) => {
      let tries = 40;
      const onError = (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE" && tries-- > 0) { setTimeout(() => http.listen(PORT, HOST), 500); return; }
        done(); reject(err);
      };
      const onListening = () => { done(); resolve(); };
      const done = () => { http.off("error", onError); http.off("listening", onListening); };
      http.on("error", onError);
      http.on("listening", onListening);
      http.listen(PORT, HOST);
    });
    console.log(`Nexus server on http://${HOST}:${PORT} again`);
  } finally {
    reacquiring = false;
    activate();
    for (const s of sockets) if (s.readyState === s.OPEN) s.send(JSON.stringify({ type: "projects" }));
  }
}
let reacquiring = false;

if (active) activate();
auth(); // creates the access token on the first start
const server = serve({ fetch: app.fetch, port: PORT, hostname: HOST }, (info) => {
  console.log(`Nexus server on http://${HOST}:${info.port} (${projects.size} project(s); registry in ${nexusHome()})${HANDOVER ? "; taking over from an update" : ""}`);
  if (!existsSync(WEB_DIST)) console.log("No built dashboard: run the web dev server (npm run dev) or npm start.");
  if (HANDOVER) {
    takeOver(new Standby(HANDOVER)).catch((err: Error) => {
      console.error(`taking over failed: ${err.message}`);
      if (standingBy) { new Standby(HANDOVER).failed(err.message); process.exit(1); }
    });
  }
});
// After an update the successor may start while its predecessor still holds the port (an older predecessor frees it
// only as it exits): it waits (NEXUS_WAIT_PORT seconds).
let portTries = Number(process.env.NEXUS_WAIT_PORT ?? 0) * 2;
server.on("error", (err: NodeJS.ErrnoException) => {
  if (reacquiring) return; // reacquire() handles its own
  if (err.code === "EADDRINUSE" && portTries-- > 0) { setTimeout(() => server.listen(PORT, HOST), 500); return; }
  console.error(`cannot listen on ${HOST}:${PORT}: ${err.message}`);
  if (standingBy) new Standby(HANDOVER!).failed(`cannot listen on ${HOST}:${PORT}: ${err.message}`);
  process.exit(1);
});

const shutdown = () => { for (const e of projects.values()) { e.engine.shutdown(); e.orchestrator.shutdown(); e.conversations.shutdown(); } process.exit(0); };
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  if (req.url !== "/ws" || !allowed(req)) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => {
    sockets.add(ws);
    ws.on("close", () => sockets.delete(ws));
  });
});
