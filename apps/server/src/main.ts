// The Nexus server: reads every registered project's .nexus/ directory, serves the dashboard and its API,
// and tells connected dashboards when a project's files change. It writes nothing in phase 1.
import { createWriteStream, existsSync, mkdirSync, type WriteStream } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { serve, type HttpBindings } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { WebSocketServer, type WebSocket } from "ws";
import chokidar, { type FSWatcher } from "chokidar";
import type { Server } from "node:http";
import {
  ActionError, Effort, ProjectStore, addNote, closingToSkip, closingToSkipAtApproval, updateSettings, answerAsUser, approveQueue, deleteNote, loadProjectState, nexusHome, withdrawApproval, addAllowRule,
  ensureGlobalSettings, readGlobalSettings, updateGlobalSettings, ownKeys, OVERRIDABLE, settingKey, readRegistry, readUsage, readTurns, commentOnPicture, markPicture, routeAnswers, routeSendBacks, sendBack, sendMessage, setQueueSettings, setStepLevel, confirmProvisional, type ProjectState,
  readAway, writeAway, awayNow, awayUntil, turnAway, expireAway, acceptPlanProposal, declinePlanProposal, handBackPlan, acceptTagProposal, declineTagProposal,
  STAT_DIMENSIONS, STAT_FILTERS, projectMetrics, sinceTime, statDimension, statsReport, stepStats, usageDays, type ProjectMetrics, type StatsReport, type UsageDays,
  MIN_SAMPLES, queueEstimate, stepSamples, isOpenQuestion, writeCount, type EstimatesResponse, type LeftView, type ProjectSummary, type RemovalView,
} from "@nexus/protocol";
import { newestFirst, projectDigest, projectRunning, usageSince, type DigestEvent, type DigestResponse, type DigestRunning, type UsageRun } from "@nexus/protocol/digest";
import { Engine } from "./engine.ts";
import { Coordinator, readLimits, validLimit, writeLimits } from "./coordinator.ts";
import { branchState, leftBehind, stepCommits } from "./gitinfo.ts";
import { cleanUp, mergeBack } from "./mergeback.ts";
import { Merger } from "./merger.ts";
import { fixProjectRules, projectRules } from "./rulesfix.ts";
import { RemovalBlocked, checkRemoval, deleteNexusDir, removalView, stopProject, unregister } from "./removal.ts";
import { decideStoppedWork, discardRecorded } from "./stopwork.ts";
import { Orchestrator } from "./orchestrator.ts";
import { Conversations } from "./conversations.ts";
import { listModels } from "./models.ts";
import { readDeployChanges, readDeploySettings, writeDeploySettings } from "./deploy.ts";
import { Standby, refuseHandoverDir, smokeCheck, takeHandoverEnv } from "./handover.ts";
import { Lifecycle, ROOT, version } from "./lifecycle.ts";
import { DeployPlanner, PlanError, planTime } from "./deploy-plan.ts";
import { MAX_UPLOAD_BODY, UploadError, saveUpload } from "./uploads.ts";
import { COMMIT_HASH, commitDetail, fileResponse, locate } from "./files.ts";
import { chatRange, pin, searchLines } from "./chats.ts";
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

interface Entry { id: string; root: string; store: ProjectStore; engine: Engine; orchestrator: Orchestrator; conversations: Conversations; merger: Merger; state?: ProjectState; stateAt?: number; error?: string }
const projects = new Map<string, Entry>();
/** Over every project's engine: one queue per checkout, and the limit on queues running at once (src/coordinator.ts). */
const coordinator = new Coordinator();

function refreshRegistry(): void {
  if (!active) return;
  // Global settings (PROTOCOL.md): the file exists from the first start on, with the built-in defaults; each project's
  // project.yaml from before them is migrated once, before anything reads it (effective values unchanged).
  ensureGlobalSettings();
  const reg = readRegistry();
  for (const p of reg.projects) {
    if (projects.has(p.id)) continue;
    const store = ProjectStore.forRoot(p.root);
    try { if (store.migrateProject()) console.log(`settings of project ${p.id}: migrated to follow the global settings where equal`); }
    catch (err) { console.error(`settings of project ${p.id}: not migrated: ${(err as Error).message}`); }
    // Steps done before review levels keep the meaning they had (PROTOCOL.md, "Before review levels").
    try { if (store.markReviewLevels()) console.log(`project ${p.id}: steps done from now on are reviewed by level`); }
    catch (err) { console.error(`project ${p.id}: review levels not marked: ${(err as Error).message}`); }
    // A deploy planned after a step or queue of this project holds the run at that step's end (src/deploy-plan.ts); so
    // does Nexus merging a worktree queue back into the run's checkout (src/merger.ts), until its fast-forward.
    let merger: Merger | undefined;
    const engine = new Engine(store, () => changed(p.id), { coordinator, boundary: (q, step, state) => planner.atBoundary(p.id, q, step, state) || (merger?.atBoundary(q, step, state) ?? false) });
    merger = new Merger(store, { start: (q) => void engine.start(q), release: (q, why) => engine.releaseHold(q, why), busy: () => engine.draining || lifecycle.busy, poke: () => changed(p.id) });
    // Through its usual notices it is told the outcome of an update it asked for (lifecycle.notice), and what changed
    // for agents in each deploy since its session began (deploy-changes.jsonl).
    const orchestrator = new Orchestrator(store, engine, () => changed(p.id), { update: () => lifecycle.notice(), plan: () => planner.notices(), changes: readDeployChanges, push: (n) => void push(n) });
    projects.set(p.id, { id: p.id, root: p.root, store, engine, orchestrator, merger, conversations: new Conversations(store, orchestrator, () => changed(p.id)) });
    watchProject(p.id, store.dir);
  }
  // A project taken off the registry (by the server's removal, or by hand): its agents and timers stop, its watcher
  // closes, and the coordinator no longer counts it.
  for (const [id, e] of projects) if (!reg.projects.some((p) => p.id === id)) void stopProject(dropProject(e).parts);
}

/**
 * Takes a project out of this server: out of the map and the coordinator, its watcher closed, its pending change
 * dropped, its push baseline forgotten. Returns its parts that run agents or timers (for stopProject), and the closing
 * of its watcher (on Windows an open watcher may hold the folder).
 */
function dropProject(e: Entry): { parts: Parameters<typeof stopProject>[0]; closed: Promise<void> } {
  projects.delete(e.id);
  coordinator.remove(e.engine);
  clearTimeout(pending.get(e.id));
  pending.delete(e.id);
  const w = watchers.get(e.id);
  watchers.delete(e.id);
  watch.forget(e.id);
  return { parts: [e.engine, e.orchestrator, e.conversations, e.merger], closed: (w?.close() ?? Promise.resolve()).catch((err: Error) => console.error(`watch ${e.id}: not closed: ${err.message}`)) };
}

/**
 * The project's state, one snapshot passed on until this process writes (writeCount) or a change from outside clears it
 * (changed()): a rebuild reads the whole history, about 120 ms on a project of 70 queues (DESIGN.md, "The cost of
 * rebuilding state").
 */
function stateOf(e: Entry): ProjectState | undefined {
  if (!e.error && (!e.state || e.stateAt !== writeCount())) {
    const at = writeCount();
    try { e.state = loadProjectState(e.store); e.stateAt = at; } catch (err) { e.error = (err as Error).message; }
  }
  return e.state;
}

// ---------------------------------------------------------------- change notification

const sockets = new Set<WebSocket>();
/** Tells every open dashboard what changed: a project, the project list, or the server's own state. */
function broadcast(m: { type: "changed"; project: string } | { type: "projects" | "server" }): void {
  const msg = JSON.stringify(m);
  for (const s of sockets) if (s.readyState === s.OPEN) s.send(msg);
}
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
      // The decisions on a change, in order. Each gets the state as it stands: one snapshot, rebuilt only after a write
      // of the decisions before it (stateOf; a change from another process comes back here through the watcher). One
      // that fails is logged and the next goes on.
      const decisions: [string, (s: ProjectState) => unknown][] = [
        // Deliver new answers to the sessions that asked. Its own inbox writes come back here and route nothing.
        ["routing answers", (s) => routeAnswers(e.store, s)],
        // Send-backs not delivered yet (the action delivers its own at once; this is the backstop).
        ["routing send-backs", (s) => routeSendBacks(e.store, s)],
        // A worktree queue merged back by Nexus (or integrated again, or waiting): before a planned deploy looks.
        ["merging back", (s) => e.merger.onChange(s)],
        // A planned deploy whose target is in starts its update (or is dropped): before the engine goes on.
        ["deploy plan", (s) => planner.check(id, s)],
        ["orchestrator", (s) => e.orchestrator.onChange(s)],
        ["engine", (s) => e.engine.onChange(s)],
      ];
      for (const [what, decide] of decisions) {
        const s = stateOf(e);
        if (!s) break;
        try { decide(s); } catch (err) { console.error(`${what} in ${id}: ${(err as Error).message}`); }
      }
      const s = stateOf(e);
      if (s) watch.check({ id, name: s.project.name }, s.attention);
    }
    broadcast({ type: "changed", project: id });
  }, 150));
}

/** Each project's watcher of its .nexus folder, by project id. */
const watchers = new Map<string, FSWatcher>();
function watchProject(id: string, dir: string): void {
  watchers.set(id, chokidar
    // Uploaded pictures change no state: a 10 MB write need not reload the project.
    .watch(dir, { ignoreInitial: true, ignored: (p) => p.endsWith(".tmp") || /^[\\/]uploads([\\/]|$)/.test(p.slice(dir.length)) })
    .on("all", () => changed(id))
    .on("error", (err) => console.error(`watch ${id}: ${(err as Error).message}`)));
}

chokidar.watch(join(nexusHome(), "projects.yaml"), { ignoreInitial: true }).on("all", () => {
  if (!active) return;
  refreshRegistry();
  broadcast({ type: "projects" });
});

// ---------------------------------------------------------------- files the dashboard may show

/** A file is served when it lies under the project, its worktree directory or a session's working directory. */
function allowedRoots(e: Entry, state: ProjectState): string[] {
  const roots = [e.root, state.project.defaults.worktree_dir, ...state.sessions.map((s) => s.cwd)];
  return roots.filter((r): r is string => !!r && existsSync(r));
}

// ---------------------------------------------------------------- HTTP

/** The app's context: a project's routes find its entry once (the lookup below) and read it with c.get("entry"). */
type Env = { Bindings: HttpBindings; Variables: { entry: Entry } };
const app = new Hono<Env>();
const lifecycle = new Lifecycle(() => [...projects.values()].map((e) => ({
  id: e.id,
  idle: () => e.engine.idle() && e.orchestrator.idle() && e.conversations.idle(),
  drain: (now: boolean) => { e.conversations.draining = true; return e.engine.drainForUpdate(now); },
  cancel: () => { e.conversations.draining = false; e.engine.cancelDrain(); },
  hurry: () => e.engine.hurryDrain(),
  shutdown: () => { e.engine.shutdown(); e.orchestrator.shutdown(); e.conversations.shutdown(); e.merger.shutdown(); },
})), () => broadcast({ type: "server" }), {
  release, reacquire,
  notify: (text) => void push({ title: "Nexus: update failed", body: text.slice(0, 180), url: "/?settings", tag: "nexus-update" }),
  // Settled (up and pushed, failed, cancelled): what was held while it drained, and its outcome, go out now.
  settled: () => { for (const id of projects.keys()) changed(id); },
  // A planned deploy it carries ends with it (before the hand-over: the successor must not deploy again).
  ended: (id, how, reason) => planner.updateEnded(id, how, reason),
});
// Planned deploys: after a step or a queue (src/deploy-plan.ts).
const planner = new DeployPlanner({
  lifecycle,
  state: (id) => { const e = projects.get(id); return e ? stateOf(e) : undefined; },
  projects: () => [...projects.keys()],
  root: ROOT,
  release: (id, queue, reason) => projects.get(id)?.engine.releaseHold(queue, reason),
  push: (n) => void push(n),
  changed: () => {
    if (!active) return;
    broadcast({ type: "server" });
    for (const id of projects.keys()) changed(id); // its orchestrator is told when a plan is dropped
  },
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

/**
 * Writes accept JSON only and only from this server's own pages: a cross-site form cannot send JSON without a
 * preflight this server never grants, and a stray Origin is refused outright.
 *
 * Every write is a user action, so it must come from the dashboard's own page: a browser sends its Origin (and
 * Sec-Fetch-Site) with every such request; an agent's script or a curl on this machine does not. Agents change
 * things through the nexus CLI, which writes files. The only exceptions are what `nexus server` itself sends
 * (`update` and `cancel`, which the CLI keeps to the user and to an orchestrator the user asked; `away`, which it keeps
 * to the user alone).
 */
const CLI_WRITES = new Set(["/api/server/update", "/api/server/cancel", "/api/server/plan", "/api/server/cancel-plan", "/api/server/away"]);
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

// A project's routes: the project is looked up once, here; an unknown one is a 404 for every route under it.
app.use("/api/projects/:id/*", async (c, next) => {
  const e = projects.get(c.req.param("id"));
  if (!e) return c.json({ error: "unknown project" }, 404);
  c.set("entry", e);
  return next();
});

app.get("/api/projects", (c) => {
  refreshRegistry();
  const list: ProjectSummary[] = [...projects.values()].map((e) => {
    const s = stateOf(e);
    const count = (st: string) => s?.queues.filter((q) => q.status === st).length ?? 0;
    return {
      id: e.id, root: e.root, name: s?.project.name ?? e.id, error: e.error,
      running: count("running"), waiting: count("waiting"), stopped: count("stopped"),
      open_questions: s?.questions.filter(isOpenQuestion).length ?? 0,
      attention: s?.attention ?? [],
    };
  });
  return c.json(list);
});

app.get("/api/projects/:id/state", (c) => {
  const e = c.get("entry");
  const s = stateOf(e);
  return s ? c.json(s) : c.json({ error: e.error }, 500);
});

// Expected times of a project's queues, as estimates (@nexus/protocol estimates.ts): the samples are the finished
// steps of every project this server has, from the worker turns' durations in turns.jsonl.
app.get("/api/projects/:id/estimates", (c) => {
  const e = c.get("entry");
  const s = stateOf(e);
  if (!s) return c.json({ error: e.error }, 500);
  const states = new Map([...projects.values()].map(stateOf).filter((x): x is ProjectState => !!x).map((x) => [x.project.id, x]));
  const samples = stepSamples(readTurns().entries, (p, q, st) => states.get(p)?.queues.find((x) => x.id === q)?.steps.find((x) => x.id === st)?.status === "done");
  const queues = Object.fromEntries(s.queues.filter((q) => q.status !== "done" && q.status !== "cancelled").map((q) => [q.id, queueEstimate(q, s.project, samples)]));
  return c.json({ samples: samples.length, min: MIN_SAMPLES, queues } satisfies EstimatesResponse);
});

// A project's metrics and their values (@nexus/protocol stats.ts, projectMetrics), for the project's Stats views.
app.get("/api/projects/:id/metrics", (c) => {
  const e = c.get("entry");
  const s = stateOf(e);
  if (!s) return c.json({ error: e.error }, 500);
  return c.json(projectMetrics(s) satisfies ProjectMetrics);
});

app.get("/api/projects/:id/file", (c) => {
  const e = c.get("entry");
  const s = stateOf(e);
  const path = c.req.query("path");
  if (!s || !path) return c.json({ error: s ? "no path" : e.error ?? "the project's state could not be read" }, 404);
  const at = locate(e.root, allowedRoots(e, s), path);
  if ("error" in at) return c.json({ error: at.error }, at.status);
  return fileResponse(at.real);
});

// The project's rules files: does each runtime see the rules, and the fix the user may make (src/rulesfix.ts).
app.get("/api/projects/:id/rules", (c) => {
  const e = c.get("entry");
  return c.json(projectRules(e.root));
});

app.get("/api/projects/:id/commits/:hash", (c) => {
  const e = c.get("entry");
  const hash = c.req.param("hash");
  if (!COMMIT_HASH.test(hash)) return c.json({ error: "not a commit hash (7 to 40 lowercase hex digits)" }, 400);
  const commit = commitDetail(e.root, hash);
  return commit ? c.json(commit) : c.json({ error: "not found" }, 404);
});

// ---------------------------------------------------------------- writes (the user's actions)

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
/** A user's write to a project: the handler gets the project's store, the JSON body, the route's parameters and the entry. */
function act(handler: (store: ProjectStore, body: Body, p: (name: string) => string, entry: Entry) => unknown) {
  return async (c: import("hono").Context<Env>) => {
    const e = c.get("entry");
    const body = (await c.req.json().catch(() => ({}))) as Body;
    try {
      const result = await handler(e.store, body, (n) => c.req.param(n) ?? "", e);
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
// Approving a stopped queue lifts its stop: first the user's choice about the stopped step's work (src/stopwork.ts).
// `skip_closing: true`: the user skips the queue's closing refactoring step with the approval of a stopped queue's new
// revision (checked before anything is recorded), as at Continue.
app.post("/api/projects/:id/queues/:queue/approve", act((st, b, p) => {
  if (b.skip_closing !== undefined && typeof b.skip_closing !== "boolean") throw new ActionError("skip_closing is true or false");
  const skipClosing = b.skip_closing === true;
  if (skipClosing) closingToSkipAtApproval(st, p("queue"));
  const d = decideStoppedWork(st, p("queue"), b.work, "user_approval");
  if (!d.proceed) return { message: d.message };
  return approveQueue(st, p("queue"), b.words, { skipClosing });
}));
// Withdrawing an approval and adding an allow rule are the user's too, like every write (see the guard above): an agent
// must not take an approval back or widen its own permissions.
app.post("/api/projects/:id/queues/:queue/withdraw", act((st, b, p) => withdrawApproval(st, p("queue"), b.reason)));
app.post("/api/projects/:id/settings/allow-rule", act((st, b) => addAllowRule(st, b.rule)));
app.patch("/api/projects/:id/queues/:queue", act((st, b, p) => setQueueSettings(st, p("queue"), b)));
// The user's review level of a step ({ level: 1 | 2 | 3 | null }); asks for no new approval.
app.put("/api/projects/:id/queues/:queue/steps/:step/level", act((st, b, p) => setStepLevel(st, p("queue"), p("step"), b.level)));
app.post("/api/projects/:id/questions/:qid/answer", act((st, b, p) => answerAsUser(st, p("qid"), b.text, b.continue)));

// The engine: running queues through Nexus-launched sessions.
app.post("/api/projects/:id/queues/:queue/run", act((_st, b, p, e) => {
  const engine = e.engine; const q = p("queue");
  switch (b.action) {
    case "start": {
      const options = {
        model: (b.model as string) || undefined, session: (b.session as string) || undefined,
        effort: Effort.safeParse(b.effort).success ? (b.effort as Effort) : undefined,
        runtime: b.runtime === "codex" || b.runtime === "claude" ? b.runtime as "claude" | "codex" : undefined,
      };
      // With `after` (a queue id or a list): the queue's place in the plan, it starts when those are done; `next: true`:
      // in the plan with none before it. With `at` (ISO 8601, or usage-reset): a schedule.
      const after = typeof b.after === "string" && b.after ? [b.after] : Array.isArray(b.after) ? b.after : undefined;
      if (after && !after.every((x) => typeof x === "string" && x)) throw new ActionError("after is a queue id or a list of them");
      const planned = !!after?.length || b.next === true;
      if (planned && typeof b.at === "string" && b.at) throw new ActionError("give after or at, not both");
      if (planned) return { message: engine.plan(q, { ...options, after: (after ?? []) as string[], by: "user" }) };
      if (typeof b.at === "string" && b.at) return { message: engine.scheduleStart(q, { ...options, at: b.at, by: "user" }) };
      return engine.start(q, options);
    }
    case "pause": return engine.pause(q);
    case "resume": return engine.resume(q);
    case "stop": return engine.stopNow(q, b.text as string | undefined);
    case "stop_at_once": return engine.stopAtOnce(q);
    case "cancel_start": return { message: engine.cancelStart(q) };
    default: throw new ActionError("action is start, pause, resume, stop, stop_at_once or cancel_start");
  }
}));
// The user's answers about the plan (PROTOCOL.md, "The plan"): accept or decline the orchestrator's proposal for the
// queue, or hand a dependency they set back to the orchestrator (`after`: one predecessor; without it, all of them);
// and the user's reorder: `move` the queue after `after` (null: with no queue before it), as in a list.
app.post("/api/projects/:id/queues/:queue/plan", act((st, b, p, e) => {
  switch (b.action) {
    case "move": {
      if (b.after !== null && (typeof b.after !== "string" || !b.after)) throw new ActionError("after is a queue id, or null for none before it");
      return { message: e.engine.move(p("queue"), b.after as string | null) };
    }
    case "accept": return { message: acceptPlanProposal(st, p("queue")) };
    case "decline": return { message: declinePlanProposal(st, p("queue")) };
    case "hand_back": {
      if (b.after !== undefined && (typeof b.after !== "string" || !b.after)) throw new ActionError("after is a queue id");
      return { message: handBackPlan(st, p("queue"), b.after as string | undefined) };
    }
    default: throw new ActionError("action is move, accept, decline or hand_back");
  }
}));
// The user's decision on the orchestrator's proposal for the project's tag lists (PROTOCOL.md, "Tags"): accept or
// decline. Only the user: there is no CLI command and no event for it.
app.post("/api/projects/:id/tags/:proposal", act((st, b, p) => {
  switch (b.action) {
    case "accept": return { message: acceptTagProposal(st, p("proposal")) };
    case "decline": return { message: declineTagProposal(st, p("proposal")) };
    default: throw new ActionError("action is accept or decline");
  }
}));
// Continue on a stopped queue: the user's lift of the stop, then the run goes on (only from the dashboard, as every write).
// `skip_closing: true`: the user skips the queue's closing refactoring step with it (checked before anything is recorded).
app.post("/api/projects/:id/queues/:queue/continue", act((st, b, p, e) => {
  if (b.skip_closing !== undefined && typeof b.skip_closing !== "boolean") throw new ActionError("skip_closing is true or false");
  const skipClosing = b.skip_closing === true;
  if (skipClosing) {
    const q = loadProjectState(st).queues.find((x) => x.id === p("queue"));
    if (!q) throw new ActionError(`unknown queue ${p("queue")}`, 404);
    closingToSkip(q);
  }
  const d = decideStoppedWork(st, p("queue"), b.work, "user_continue");
  if (!d.proceed) return { message: d.message };
  return e.engine.continueQueue(p("queue"), { skipClosing });
}));
// Fix it: the user sends a step waiting for their review back to its worker, with what they want (required).
app.post("/api/projects/:id/queues/:queue/steps/:step/send-back", act((st, b, p) => ({ message: sendBack(st, { queue: p("queue"), step: p("step"), from: "user", text: b.text }) })));
// Merge back and clean up a finished worktree queue: the user's only (no CLI command or event leads here).
app.post("/api/projects/:id/queues/:queue/merge", act((st, _b, p, e) => ({ message: mergeBack(st, p("queue"), undefined, (q) => void e.engine.start(q)) })));
app.post("/api/projects/:id/queues/:queue/cleanup", act((st, _b, p) => ({ message: cleanUp(st, p("queue")) })));
// Push again: the last failed push of an accepted step of this queue, tried again.
// The fix of the rules files, as the user saw it (`version`): it changes the project's own files and commits nothing.
app.post("/api/projects/:id/rules/fix", act((st, b) => ({ message: fixProjectRules(st, b.version) })));
app.post("/api/projects/:id/queues/:queue/push", act((_st, _b, p, e) => ({ message: e.engine.pushAgain(p("queue")) })));
// Review pictures: the user's mark (a mark only) and comment (a Fix it while the step waits for the user, else a note
// on the next pending step).
app.post("/api/projects/:id/queues/:queue/steps/:step/pictures/mark", act((st, b, p) => markPicture(st, { queue: p("queue"), step: p("step"), path: b.path, accepted: b.accepted })));
app.post("/api/projects/:id/queues/:queue/steps/:step/pictures/comment", act((st, b, p) => ({ message: commentOnPicture(st, { queue: p("queue"), step: p("step"), path: b.path, text: b.text }) })));
// Reject: the user's, on a step waiting for their review; the run pauses until a new revision is approved.
app.post("/api/projects/:id/queues/:queue/steps/:step/reject", act((_st, b, p, e) => ({ message: e.engine.rejectStep(p("queue"), p("step"), b.text) })));
// The user confirms a step the orchestrator accepted provisionally (review level 3); Fix it on one is the send-back.
app.post("/api/projects/:id/queues/:queue/steps/:step/confirm", act((st, _b, p) => ({ message: confirmProvisional(st, p("queue"), p("step")) })));
app.post("/api/projects/:id/queues/:queue/steps/:step/accept", act((_st, b, p, e) => e.engine.acceptReview(p("queue"), p("step"), b.text, b.note_to)));

// Removing the project from Nexus (src/removal.ts), the user's only: there is no CLI command for it, and the guard above
// refuses a request that does not come from the dashboard's own page. What the server's live parts say about it:
function liveParts(e: Entry) {
  const plan = planner.view()?.after;
  return {
    engineIdle: e.engine.idle(), orchestratorIdle: e.orchestrator.idle(), conversationsIdle: e.conversations.idle(),
    merging: e.merger.merging(), updating: lifecycle.busy,
    deploy: plan?.project === e.id ? { queue: plan.queue, step: plan.step } : undefined,
  };
}
/** The project's state read again from its files (a write from another process may not have come through yet). */
function freshState(e: Entry): ProjectState | undefined {
  e.state = undefined; e.error = undefined;
  return stateOf(e);
}
app.get("/api/projects/:id/removal", (c) => {
  const e = c.get("entry");
  const s = freshState(e);
  return c.json(removalView(e.root, s?.project.name ?? e.id, s, liveParts(e)) satisfies RemovalView);
});
// `delete_data: true` (with `name`, the project's name as typed): its .nexus folder is deleted too. Refused (409, with
// `blockers`) while anything runs in the project.
app.post("/api/projects/:id/remove", async (c) => {
  const e = c.get("entry");
  const body = (await c.req.json().catch(() => ({}))) as Body;
  try {
    const s = freshState(e);
    const view = removalView(e.root, s?.project.name ?? e.id, s, liveParts(e));
    const { deleteData } = checkRemoval(e.id, e.root, view, body);
    // Off the registry and out of this server in one go: no request in between may load it again.
    unregister(e.id, e.root);
    const dropped = dropProject(e);
    const [stopped] = await Promise.all([stopProject(dropped.parts), dropped.closed]);
    broadcast({ type: "projects" });
    console.log(`project ${e.id} removed from Nexus${deleteData ? "; deleting its .nexus folder" : ""}`);
    if (!deleteData) return c.json({ ok: true, result: { removed: e.id, nexus_dir: view.nexus_dir, worktrees: view.worktrees } });
    if (!stopped) return c.json({ error: `project ${e.id} is removed from Nexus, but its agents did not exit in time: its .nexus folder was not deleted` }, 500);
    try { return c.json({ ok: true, result: { removed: e.id, deleted: deleteNexusDir(e.root), worktrees: view.worktrees } }); }
    catch (err) { return c.json({ error: `project ${e.id} is removed from Nexus, but its .nexus folder could not be deleted: ${(err as Error).message}` }, 500); }
  } catch (err) {
    if (err instanceof RemovalBlocked) return c.json({ error: err.message, blockers: err.blockers }, 409);
    if (err instanceof ActionError) return c.json({ error: err.message }, err.status as 400);
    console.error(err);
    return c.json({ error: (err as Error).message }, 500);
  }
});

// A picture for a chat message (src/uploads.ts): the body's size is checked before it is read or parsed (also when it
// comes without a Content-Length), and the guard above has already taken it as the user's, from the dashboard.
app.post("/api/projects/:id/uploads", bodyLimit({
  maxSize: MAX_UPLOAD_BODY,
  // The rest of the body is not read, so the connection is not reused: a client would send its next request on a
  // socket the server is about to close.
  onError: (c) => c.json({ error: "only PNG, JPEG, WebP or GIF up to 10 MB" }, 413, { connection: "close" }),
}), async (c) => {
  const e = c.get("entry");
  const body = (await c.req.json().catch(() => undefined)) as Body | undefined;
  if (!body || typeof body !== "object") return c.json({ error: "not a JSON object" }, 400);
  try {
    return c.json({ ok: true, result: saveUpload(e.store.dir, body.data) });
  } catch (err) {
    if (err instanceof UploadError) return c.json({ error: err.message }, err.status);
    console.error(err);
    return c.json({ error: (err as Error).message }, 500);
  }
});

// A chat's older entries, its search over the whole chat.jsonl, and its pins (src/chats.ts).
app.get("/api/projects/:id/sessions/:session/chat", (c) => {
  const e = c.get("entry");
  const from = Number(c.req.query("from") ?? 0), to = Number(c.req.query("to") ?? Number.MAX_SAFE_INTEGER);
  if (!Number.isInteger(from) || !Number.isInteger(to)) return c.json({ error: "from and to: whole numbers (lines)" }, 400);
  try { return c.json({ chat: chatRange(e.store, c.req.param("session"), from, to) }); } catch (err) { return c.json({ error: (err as Error).message }, 404); }
});
app.get("/api/projects/:id/sessions/:session/chat/search", (c) => {
  const e = c.get("entry");
  try { return c.json({ lines: searchLines(e.store, c.req.param("session"), c.req.query("q") ?? "", c.req.query("tools") === "1") }); } catch (err) { return c.json({ error: (err as Error).message }, 404); }
});
app.post("/api/projects/:id/sessions/:session/pins", act((st, b, p) => ({ pins: pin(st, p("session"), b.line, b.pinned) })));

app.get("/api/projects/:id/sessions/:session/activity", (c) => {
  const e = c.get("entry");
  return c.json(e.engine.activity(c.req.param("session"), c.req.query("queue"), c.req.query("step"), Number(c.req.query("limit") ?? 300)));
});

// Git on the dashboard (src/gitinfo.ts; local git only, never a fetch): a step's commits per round, a queue's branch.
// null when the project is not a git repository (or nothing was recorded).
app.get("/api/projects/:id/queues/:queue/steps/:step/commits", (c) => {
  const e = c.get("entry");
  const q = stateOf(e)?.queues.find((x) => x.id === c.req.param("queue"));
  if (!q) return c.json({ error: "unknown queue" }, 404);
  return c.json(stepCommits(e.store, q, c.req.param("step")) ?? null);
});
// What a stopped queue's stopped step left (its own commits, the checkout's uncommitted changes) and whether a Discard
// is recorded for this stop; null when the queue is not stopped at a step.
app.get("/api/projects/:id/queues/:queue/left", (c) => {
  const e = c.get("entry");
  const q = stateOf(e)?.queues.find((x) => x.id === c.req.param("queue"));
  if (!q) return c.json({ error: "unknown queue" }, 404);
  const left = leftBehind(e.store, q);
  const view: LeftView | null = left ? { ...left, discarded: discardRecorded(q) ?? null } : null;
  return c.json(view);
});
app.get("/api/projects/:id/queues/:queue/git", (c) => {
  const e = c.get("entry");
  const q = stateOf(e)?.queues.find((x) => x.id === c.req.param("queue"));
  if (!q) return c.json({ error: "unknown queue" }, 404);
  return c.json(branchState(e.store, q) ?? null);
});

// Refused actions of every session of the project, oldest first; with ?queue= (and &step=) only those of a step.
app.get("/api/projects/:id/refusals", (c) => {
  const e = c.get("entry");
  const queue = c.req.query("queue"), step = c.req.query("step");
  const all = e.store.sessionIds().flatMap((s) => e.store.readRefusals(s).entries)
    .filter((r) => (!queue || r.queue === queue) && (!step || r.step === step));
  return c.json(all.sort((a, b) => a.at.localeCompare(b.at)));
});

// The statistics across projects, or of one (?project=), grouped (?by=, default model) since a time (?since=): the
// same computation as nexus stats (@nexus/protocol stats.ts), the use of the windows estimated from turns.jsonl.
app.get("/api/stats", (c) => {
  refreshRegistry();
  const by = statDimension(c.req.query("by"));
  if (!by) return c.json({ error: `by is one of ${STAT_DIMENSIONS.join(", ")}` }, 400);
  const sinceText = c.req.query("since");
  const since = sinceText ? sinceTime(sinceText) : undefined;
  if (sinceText && !since) return c.json({ error: "since is a date (2026-11-14) or a time" }, 400);
  const project = c.req.query("project") || undefined;
  if (project && !projects.has(project)) return c.json({ error: "unknown project" }, 404);
  const filter = Object.fromEntries(STAT_FILTERS.map((f) => [f, c.req.query(f) || undefined]).filter(([, v]) => v));
  const states = [...projects.values()].map(stateOf).filter((x): x is ProjectState => !!x);
  return c.json(statsReport(stepStats(states, readTurns().entries), { by, project, since, filter }) satisfies StatsReport);
});

// The usage windows day by day for the global Stats view (UsageDays), from ?since= (a date or a time; default 30 days
// ago) to now, and the global usage pause threshold to draw beside them.
app.get("/api/usage/days", (c) => {
  const sinceText = c.req.query("since");
  const since = sinceText ? sinceTime(sinceText) : new Date(Date.now() - 29 * 86_400_000).toISOString();
  if (!since) return c.json({ error: "since is a date (2026-11-14) or a time" }, 400);
  const days: UsageDays = usageDays(readTurns().entries, new Date(since), new Date());
  return c.json({ ...days, threshold: readGlobalSettings().defaults.usage_pause_threshold });
});

// The morning digest across projects (UX proposals, 16): what happened after ?since= (ISO 8601; default the last 24
// hours), newest first, at most 200 lines; and the queues at work now (packages/protocol/src/digest.ts).
app.get("/api/digest", (c) => {
  refreshRegistry();
  const q = c.req.query("since");
  const since = q && !Number.isNaN(Date.parse(q)) ? new Date(q).toISOString() : new Date(Date.now() - 86_400_000).toISOString();
  const events: DigestEvent[] = [];
  const running: DigestRunning[] = [];
  const runs: UsageRun[] = [];
  for (const e of projects.values()) {
    const state = stateOf(e);
    if (!state) continue;
    for (const q of state.queues) if (q.run) runs.push({ session: q.run.session, state: q.run.state, updated_at: q.run.updated_at });
    const ids = e.store.sessionIds();
    const recent = <T extends { at: string }>(xs: T[]) => xs.filter((x) => x.at > since);
    events.push(...projectDigest({
      state,
      events: ids.flatMap((s) => recent(e.store.readEvents(s).entries)),
      refusals: ids.flatMap((s) => recent(e.store.readRefusals(s).entries)),
      activity: ids.flatMap((s) => recent(e.store.readActivity(s).entries.filter((a) => a.kind === "retry"))),
    }, since));
    running.push(...projectRunning(state));
  }
  // The usage line: the account's windows are server-wide, so its turns are every project's (turns.jsonl).
  const usage = usageSince(readTurns().entries, runs, since);
  return c.json({ since, events: newestFirst(events).slice(0, 200), running, usage } satisfies DigestResponse);
});

app.get("/api/usage", (c) => c.json(readUsage() ?? null));

// Nexus itself: its version, and updating it without cutting off running work (src/lifecycle.ts).
// `local`: whether this request comes straight from this machine (src/remote.ts isLocal), so the dashboard shows what
// only makes sense on the server machine ("Open in editor": a path on another device points nowhere).
app.get("/api/server", async (c) => c.json({ ...(await version()), local: isLocal(c.env.incoming), update: lifecycle.status, plan: planner.view(), push_on_deploy: readDeploySettings().push_on_deploy, max_running: readLimits().max_running, running: runningSteps(), away: awayNow(readAway()) }));

// ---------------------------------------------------------------- away mode (PROTOCOL.md, "Away mode")

let awayTimer: NodeJS.Timeout | undefined;

/** Every project looks again (the orchestrators are told), and the dashboards reload the server's state. */
function awayChanged(): void {
  for (const id of projects.keys()) changed(id);
  broadcast({ type: "server" });
}

/** Ends an away mode whose time has come (recorded as expired), and arms a timer for the end of the current one. */
function armAway(): void {
  clearTimeout(awayTimer);
  awayTimer = undefined;
  if (!active) return;
  const a = readAway();
  const ended = expireAway(a);
  if (ended !== a) { writeAway(ended); awayChanged(); return; }
  if (!a.current) return;
  awayTimer = setTimeout(armAway, Math.min(Math.max(0, Date.parse(a.current.until) - Date.now()) + 50, 2 ** 31 - 1));
  awayTimer.unref();
}

// The user turns away mode on until a time ({ until: "8:00" or an ISO time }) or off ({ until: null }), from the
// dashboard or with `nexus server away` (which refuses agent sessions). Never an agent's.
app.post("/api/server/away", async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as { until?: unknown };
  if (!("until" in b)) return c.json({ error: "give until: a local time such as 8:00, an ISO 8601 time, or null to turn it off" }, 400);
  let until: string | null;
  try { until = b.until === null ? null : awayUntil(b.until); } catch (err) { return c.json({ error: (err as Error).message }, 400); }
  writeAway(turnAway(readAway(), until));
  armAway();
  awayChanged();
  return c.json({ ok: true, away: awayNow(readAway()) });
});

/** The steps running now, per project: what an update would wait for (nexus server status shows them). */
function runningSteps() {
  return [...projects.values()].flatMap((e) => {
    const s = stateOf(e);
    const steps = (s?.queues ?? []).flatMap((q) => q.steps.filter((x) => x.status === "running")
      .map((x) => ({ queue: q.id, step: x.id, title: x.title, session: q.run?.session ?? null, run: q.run?.state ?? null })));
    return steps.length ? [{ project: e.id, name: s?.project.name ?? e.id, steps }] : [];
  });
}
// The server's settings, the user's to change, from the dashboard only: whether a deploy pushes the deployed main
// (src/deploy.ts), and how many queues may run at once (src/coordinator.ts).
app.post("/api/server/settings", async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as { push_on_deploy?: unknown; max_running?: unknown };
  if (b.push_on_deploy === undefined && b.max_running === undefined) return c.json({ error: "give push_on_deploy or max_running" }, 400);
  if (b.push_on_deploy !== undefined && typeof b.push_on_deploy !== "boolean") return c.json({ error: "push_on_deploy is true or false" }, 400);
  if (b.max_running !== undefined && !validLimit(b.max_running)) return c.json({ error: "max_running is a whole number from 1 to 20" }, 400);
  if (typeof b.push_on_deploy === "boolean") writeDeploySettings({ ...readDeploySettings(), push_on_deploy: b.push_on_deploy });
  if (validLimit(b.max_running)) {
    writeLimits({ ...readLimits(), max_running: b.max_running });
    coordinator.wake(); // a higher limit lets waiting starts go
  }
  broadcast({ type: "server" });
  return c.json({ ok: true, push_on_deploy: readDeploySettings().push_on_deploy, max_running: readLimits().max_running });
});
/** An orchestrator session of a registered project, as the CLI sends it (`by`); anything else counts as the user. */
function askerOf(b: { project?: unknown; session?: unknown } | undefined): { project: string; session: string } | undefined {
  const e = typeof b?.project === "string" ? projects.get(b.project) : undefined;
  if (!e || typeof b?.session !== "string") return undefined;
  try { return e.store.readSession(b.session).role === "orchestrator" ? { project: e.id, session: b.session } : undefined; } catch { return undefined; }
}
app.post("/api/server/update", async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as { now?: unknown; ref?: unknown; by?: { project?: unknown; session?: unknown } };
  // `by`: the orchestrator session that ran `nexus server update` (the CLI sends it); it is told the outcome. Only an
  // orchestrator session of a registered project counts; the dashboard sends none.
  try { return c.json(lifecycle.start({ now: b.now === true, ref: typeof b.ref === "string" ? b.ref : undefined, by: askerOf(b.by) })); }
  catch (e) { return c.json({ error: (e as Error).message }, 409); }
});
// A planned deploy (src/deploy-plan.ts): `after` { project, queue, step? }, or `at` and `deadline?` (HH:MM,
// "YYYY-MM-DD HH:MM" in this machine's time, or ISO 8601); `ref?`, `by?` (as for update). One at a time; `nexus
// server update --after|--at` sends it, `nexus server cancel-plan` cancels it.
app.post("/api/server/plan", async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as { after?: { project?: unknown; queue?: unknown; step?: unknown }; at?: unknown; deadline?: unknown; ref?: unknown; by?: { project?: unknown; session?: unknown } };
  const a = b.after;
  if (a !== undefined && (typeof a?.project !== "string" || typeof a.queue !== "string" || (a.step !== undefined && typeof a.step !== "string"))) {
    return c.json({ error: "give after: { project, queue, step? }" }, 400);
  }
  if ((b.at !== undefined && typeof b.at !== "string") || (b.deadline !== undefined && typeof b.deadline !== "string")) return c.json({ error: "at and deadline are times (text)" }, 400);
  try {
    const at = typeof b.at === "string" ? planTime(b.at) : undefined;
    // A deadline as a bare time of day is its next occurrence after the plan's time.
    const deadline = typeof b.deadline === "string" ? planTime(b.deadline, at ? new Date(at) : undefined) : undefined;
    const after = a ? { project: a.project as string, queue: a.queue as string, step: (a.step as string | undefined) || undefined } : undefined;
    const r = planner.set({ after, at, deadline, ref: typeof b.ref === "string" ? b.ref : undefined, by: askerOf(b.by) });
    return c.json({ text: r.text, plan: planner.view(), update: lifecycle.status });
  } catch (e) { return c.json({ error: (e as Error).message }, e instanceof PlanError ? 409 : 500); }
});
app.post("/api/server/cancel-plan", async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as { by?: { project?: unknown; session?: unknown } };
  try { return c.json({ text: planner.cancel(askerOf(b.by)), update: lifecycle.status }); }
  catch (e) { return c.json({ error: (e as Error).message }, e instanceof PlanError ? 409 : 500); }
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
app.get("/api/projects/:id/orchestrator", (c) => {
  return c.json(c.get("entry").orchestrator.view());
});
app.post("/api/projects/:id/orchestrator/messages", act((_st, b, _p, e) => e.orchestrator.say(b.text)));
app.post("/api/projects/:id/orchestrator/reset", act((_st, _b, _p, e) => e.orchestrator.reset()));
app.post("/api/projects/:id/orchestrator/stop", act((_st, _b, _p, e) => e.orchestrator.stop()));
// Conversations: thinking partners for the project.
app.get("/api/projects/:id/conversations", (c) => {
  return c.json(c.get("entry").conversations.list());
});
app.get("/api/projects/:id/conversations/:cid", (c) => {
  const e = c.get("entry");
  try { return c.json(e.conversations.view(c.req.param("cid"))); } catch (err) { return c.json({ error: (err as Error).message }, 404); }
});
app.post("/api/projects/:id/conversations", act((_st, b, _p, e) => e.conversations.create(b)));
// The step's latest conversation that is not archived ("Chat about this" opens it, or starts one when there is none).
app.get("/api/projects/:id/queues/:q/steps/:s/conversation", (c) => {
  const e = c.get("entry");
  return c.json({ conversation: e.conversations.latestFor(c.req.param("q"), c.req.param("s")) ?? null });
});
app.patch("/api/projects/:id/conversations/:cid", act((_st, b, p, e) => e.conversations.update(p("cid"), b)));
app.post("/api/projects/:id/conversations/:cid/messages", act((_st, b, p, e) => e.conversations.say(p("cid"), b.text)));
app.post("/api/projects/:id/conversations/:cid/stop", act((_st, _b, p, e) => e.conversations.stop(p("cid"))));
app.post("/api/projects/:id/conversations/:cid/handoff", act((_st, _b, p, e) => e.conversations.handoff(p("cid"))));
app.post("/api/projects/:id/orchestrator/settings", act((_st, b, _p, e) => e.orchestrator.settings(b.model, b.effort)));
app.patch("/api/projects/:id/settings", act((st, b) => updateSettings(st, b)));
// Which settings the project has its own value of (the others follow the global ones), and the global values.
app.get("/api/projects/:id/settings", (c) => {
  const e = c.get("entry");
  return c.json({ own: ownKeys(e.store.readStoredProject()), global: readGlobalSettings() });
});
// The global settings, which every project follows where it has no value of its own (PROTOCOL.md, "Global settings").
app.get("/api/settings", (c) => c.json({ global: readGlobalSettings(), keys: OVERRIDABLE.map((x) => settingKey(x.path)) }));
app.patch("/api/settings", async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as unknown;
  try {
    const global = updateGlobalSettings(b);
    // Every project that follows a changed value has new effective settings: each one's state is read again.
    for (const id of projects.keys()) changed(id);
    return c.json({ global });
  } catch (err) {
    if (err instanceof ActionError) return c.json({ error: err.message }, err.status as 400);
    throw err;
  }
});

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
  armAway(); // an away mode ends at its time also across restarts
  planner.recover(); // a planned deploy stays across restarts
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
  const closing = [...watchers.values()].map((w) => w.close());
  watchers.clear();
  await Promise.all(closing);
  planner.shutdown(); // its timers write the plan file: no longer this server's
  for (const e of projects.values()) { e.engine.shutdown(); e.orchestrator.shutdown(); e.conversations.shutdown(); e.merger.shutdown(); }
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
    broadcast({ type: "projects" });
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

const shutdown = () => { for (const e of projects.values()) { e.engine.shutdown(); e.orchestrator.shutdown(); e.conversations.shutdown(); e.merger.shutdown(); } process.exit(0); };
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
