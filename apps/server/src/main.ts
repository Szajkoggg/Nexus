// The Nexus server: reads every registered project's .nexus/ directory, serves the dashboard and its API,
// and tells connected dashboards when a project's files change. It writes nothing in phase 1.
import { appendFileSync, createWriteStream, existsSync, mkdirSync, watch as watchFiles, type FSWatcher as FilesWatcher, type WriteStream } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { serve, type HttpBindings } from "@hono/node-server";
import { WebSocketServer, type WebSocket } from "ws";
import chokidar, { type FSWatcher } from "chokidar";
import type { Server } from "node:http";
import {
  ActionError, Effort, ProjectStore, addNote, closingToSkip, closingToSkipAtApproval, updateSettings, answerAsUser, approveQueue, deleteNote, loadProjectState, nexusHome, withdrawApproval, addAllowRule,
  ensureGlobalSettings, readGlobalSettings, updateGlobalSettings, MaxRunning, ownKeys, OVERRIDABLE, settingKey, readRegistry, readCapacity, readUsage, readTurns, commentOnPicture, markPicture, routeAnswers, routeSendBacks, sendBack, sendMessage, setQueueSettings, setStepLevel, confirmProvisional, type ProjectState,
  readAway, writeAway, awayNow, awayUntil, turnAway, expireAway, acceptPlanProposal, declinePlanProposal, handBackPlan, acceptTagProposal, declineTagProposal,
  STAT_DIMENSIONS, STAT_FILTERS, projectMetrics, sinceTime, statDimension, statsReport, stepStats, reviewStats, type ReviewStats, usageDays, type ProjectMetrics, type StatsReport, type UsageDays,
  SearchError, parseSearch, MIN_SAMPLES, queueEstimate, stepSamples, isOpenQuestion, queueWorkedOn, stepsWorkedOn, ProjectModel, FileCache, isLogOnly, useHomeReader, type EstimatesResponse, type LeftView, type TemplatesResponse, readTemplates, type ProjectSummary, type RemovalView,
  projectIdeas, ideaMatches, ideaLinks, changeIdeaLinks, decideIdeaMatches, ideaStatuses, changeIdeaStatus, reconcileIdeaStatuses, readNotes, type IdeasResponse, type IdeaMatchesResponse,
  previewIdeaHandoff, sendIdeaHandoff, retryIdeaHandoff,
} from "@nexus/protocol";
import { newestFirst, projectDigest, projectRunning, usageSince, type DigestEvent, type DigestResponse, type DigestRunning, type UsageRun } from "@nexus/protocol/digest";
import { Engine } from "./engine.ts";
import { Coordinator } from "./coordinator.ts";
import { Capacity } from "./capacity.ts";
import { readSnapshots } from "./snapshots.ts";
import { lowerOwnedProcesses } from "./worker-process.ts";
import { branchState, leftBehind, stepCommits } from "./gitinfo.ts";
import { cleanUp, mergeBack } from "./mergeback.ts";
import { Merger } from "./merger.ts";
import { fixProjectRules, projectRules } from "./rulesfix.ts";
import { RemovalBlocked, checkRemoval, deleteNexusDir, removalView, stopProject, unregister } from "./removal.ts";
import { decideStoppedWork, discardRecorded, readStoppedWork } from "./stopwork.ts";
import { Orchestrator } from "./orchestrator.ts";
import { Conversations } from "./conversations.ts";
import { listModels } from "./models.ts";
import { readDeployChanges, readDeploySettings, writeDeploySettings } from "./deploy.ts";
import { crashNotice, dismissCrash, readCrash, recordCrash } from "./crash.ts";
import { Standby, refuseHandoverDir, smokeCheck, takeHandoverEnv } from "./handover.ts";
import { Lifecycle, ROOT, projectPart, version } from "./lifecycle.ts";
import { DeployPlanner, PlanError, planTime } from "./deploy-plan.ts";
import { UploadError, readLimited, saveUpload } from "./uploads.ts";
import { COMMIT_HASH, commitDetail, fileResponse, locate } from "./files.ts";
import { chatRange, pin, searchLines } from "./chats.ts";
import { searchProject } from "./search.ts";
import { perf } from "./perf.ts";
import { dashboardFiles, isPublicFile } from "./web-static.ts";
import {
  AttentionWatch, allowed, auth, authCookie, isLocal, loginPage, push, pushDevices, pushKey, qrSvg, rotateToken,
  NotSubscribed, deviceNotify, setDeviceNotify, subscribe, tailscaleInfo, tokenMatches, unsubscribe,
} from "./remote.ts";

// Started by an update (src/handover.ts): NEXUS_HANDOVER names the folder to take over through. It is read once and
// removed from the environment, so nothing this server starts inherits it: an agent's test server that inherited it
// would take the live predecessor's folder for its own.
const HANDOVER = takeHandoverEnv();

// NEXUS_LOG: the server writes its own log (1: <NEXUS_HOME>/server.log, or a path). Node opens it shared, so a
// successor after an update can append while its predecessor still holds it (a shell's `>>` would lock it).
let log: WriteStream | undefined;
let logFile: string | undefined;
if (process.env.NEXUS_LOG) {
  const file = process.env.NEXUS_LOG === "1" ? join(nexusHome(), "server.log") : process.env.NEXUS_LOG;
  logFile = file;
  mkdirSync(dirname(file), { recursive: true });
  log = createWriteStream(file, { flags: "a" });
  const logTo = log;
  for (const stream of [process.stdout, process.stderr]) {
    const write = stream.write.bind(stream) as (chunk: unknown, ...rest: unknown[]) => boolean;
    stream.write = ((chunk: unknown, ...rest: unknown[]) => { logTo.write(chunk as string); return write(chunk, ...rest); }) as typeof stream.write;
  }
  console.log(`---- ${new Date().toISOString()} pid ${process.pid}`);
}
// An uncaught exception ends the server, as it always did: its stack goes to the log (or to stderr without one) and the
// process exits with 1. It is also recorded in <NEXUS_HOME>/crash.json (src/crash.ts), which the next server shows on
// the dashboard and tells every project's orchestrator.
process.on("uncaughtException", (err) => {
  const line = `${new Date().toISOString()} uncaught: ${err.stack ?? err}\n`;
  // Written at once: the stream's write would still be pending when the process exits.
  try { if (logFile) appendFileSync(logFile, line); else process.stderr.write(line); } catch { /* the record below still tells */ }
  recordCrash(err);
  process.exit(1);
});
// A rejected promise nobody handled is logged, and the server goes on (queue LF, F1): such a promise is a background
// chain (a check, a timer's work) whose failure belongs to one run, not a reason to end every worker with the server.
// The code handles its chains' failures where they belong (a halted run); this is the backstop that keeps them local.
process.on("unhandledRejection", (reason) => {
  console.error(`${new Date().toISOString()} unhandled rejection (the server goes on): ${reason instanceof Error ? reason.stack : String(reason)}`);
});

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

/**
 * A project loaded in this server. `model`: its files kept in memory (docs/design/model.md). `store` is the model's:
 * every reader in this server (the requests, the user's actions, the engine, the orchestrator, the merger and the rest)
 * reads through it, and the state it derives (loadProjectState over it) is the model's, once per change.
 */
interface Entry { id: string; root: string; store: ProjectStore; model: ProjectModel; engine: Engine; orchestrator: Orchestrator; conversations: Conversations; merger: Merger; error?: string }
const projects = new Map<string, Entry>();
/** Over every project's engine: one queue per checkout, and the limit on queues running at once (src/coordinator.ts). */
const coordinator = new Coordinator();
// The workers' and checks' processes run below normal priority: the server and the user's programs go first (queue SV3).
lowerOwnedProcesses(true);
/**
 * One heavy operation on the workstation at a time, across projects (src/capacity.ts). Made when this server becomes
 * active, which writes <NEXUS_HOME>/capacity.yaml anew: the grants of a server before it ended with its processes.
 */
let capacity: Capacity | undefined;

function refreshRegistry(): void {
  if (!active) return;
  capacity ??= new Capacity({ onChange: () => broadcast({ type: "server" }) });
  // Global settings (docs/protocol/settings.md, "Global settings"): the file exists from the first start on, with the built-in defaults; each project's
  // project.yaml from before them is migrated once, before anything reads it (effective values unchanged).
  ensureGlobalSettings();
  const reg = readRegistry();
  for (const p of reg.projects) {
    if (projects.has(p.id)) continue;
    const files = ProjectStore.forRoot(p.root);
    try { if (files.migrateProject()) console.log(`settings of project ${p.id}: migrated to follow the global settings where equal`); }
    catch (err) { console.error(`settings of project ${p.id}: not migrated: ${(err as Error).message}`); }
    // Steps done before review levels keep the meaning they had (docs/protocol/review.md, "Before review levels").
    try { if (files.markReviewLevels()) console.log(`project ${p.id}: steps done from now on are reviewed by level`); }
    catch (err) { console.error(`project ${p.id}: review levels not marked: ${(err as Error).message}`); }
    // A deploy planned after a step or queue of this project holds the run at that step's end (src/deploy-plan.ts); so
    // does Nexus merging a worktree queue back into the run's checkout (src/merger.ts), until its fast-forward.
    let merger: Merger | undefined;
    // The project's files read once, here, and kept (docs/design/model.md): the engine's recovery reads its state, and
    // everything after reads through its store.
    const model = new ProjectModel(files.dir);
    const store = model.store;
    // Measured: making the engine recovers the project's runs after a restart (queue SV1 found it reading the whole
    // state once per queue).
    const engine = perf.measure(`engine start ${p.id}`, () => new Engine(store, () => changed(p.id), { coordinator, capacity, snapshots: readSnapshots, boundary: (q, step, state) => planner.atBoundary(p.id, q, step, state) || (merger?.atBoundary(q, step, state) ?? false) }));
    merger = new Merger(store, { start: (q) => void engine.start(q), release: (q, why) => engine.releaseHold(q, why), busy: () => engine.draining || lifecycle.busy, poke: () => changed(p.id) });
    // Through its usual notices it is told the outcome of an update it asked for (lifecycle.notice), and what changed
    // for agents in each deploy since its session began (deploy-changes.jsonl).
    // Its routine reviews go to short-lived review helpers (src/review-helper.ts) while review_helper.enabled is on.
    const orchestrator = new Orchestrator(store, engine, () => changed(p.id), { update: () => lifecycle.notice(), plan: () => planner.notices(), changes: readDeployChanges, crash: readCrash, push: ({ kind, ...n }) => void push(n, { kind }) }, { helpers: {} });
    projects.set(p.id, { id: p.id, root: p.root, store, model, engine, orchestrator, merger, conversations: new Conversations(store, orchestrator, () => changed(p.id)) });
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
  modelWatchers.get(e.id)?.close();
  modelWatchers.delete(e.id);
  watchedNotes.delete(e.id);
  watch.forget(e.id);
  e.model.close();
  return { parts: [e.engine, e.orchestrator, e.conversations, e.merger], closed: (w?.close() ?? Promise.resolve()).catch((err: Error) => console.error(`watch ${e.id}: not closed: ${err.message}`)) };
}

/**
 * The project's state, from its model (docs/design/model.md): derived again, from memory, only after a file of it
 * changed (this process's write, or the watcher's report) or changed() was called; otherwise the same snapshot.
 */
function stateOf(e: Entry): ProjectState | undefined {
  if (e.error) return undefined;
  try { return e.model.stale() ? perf.measure(`state ${e.id}`, () => e.model.current()) : e.model.current(); } catch (err) { e.error = (err as Error).message; return undefined; }
}

// ---------------------------------------------------------------- change notification

const sockets = new Set<WebSocket>();
/** Tells every open dashboard what changed: a project, the project list, or the server's own state. */
function broadcast(m: { type: "changed"; project: string } | { type: "log"; project: string; session: string } | { type: "projects" | "server" }): void {
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
      e.model.changed(); e.error = undefined;
      // The decisions on a change, in order. Each gets the state as it stands: one snapshot, rebuilt only after a write
      // of the decisions before it (stateOf; a change from another process comes back here through the watcher). One
      // that fails is logged and the next goes on.
      const decisions: [string, (s: ProjectState) => unknown][] = [
        ["idea assessment validity", (s) => { syncNotesWatcher(id, s); reconcileIdeaStatuses(e.store, s); }],
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
        try { perf.measure(`${what} (${id})`, () => decide(s)); } catch (err) { console.error(`${what} in ${id}: ${(err as Error).message}`); }
      }
      const s = stateOf(e);
      if (s) watch.check({ id, name: s.project.name }, s.attention);
    }
    broadcast({ type: "changed", project: id });
  }, 150));
}

/** Each project's watcher of its .nexus folder, by project id. */
const watchers = new Map<string, FSWatcher>();
const watchedNotes = new Map<string, string>();
function syncNotesWatcher(id: string, state: ProjectState): void {
  const watcher = watchers.get(id);
  if (!watcher) return;
  const dir = state.project.conversations.notes_dir;
  const path = dir ? join(state.project.root, dir) : undefined;
  if (watchedNotes.get(id) === path) return;
  // Validate the configured boundary before watching it; never follow symlinks.
  readNotes(state.project.root, dir);
  const old = watchedNotes.get(id);
  if (old) { void watcher.unwatch(old); watchedNotes.delete(id); }
  if (path) { watcher.add(path); watchedNotes.set(id, path); }
}
/**
 * A line of a session's log only (activity, chat, refusals, pins: docs/design/model.md): no state changes and no
 * decision runs; the dashboards ask again for that project's logs (a `log` message), once per 150 ms per session.
 */
const logPending = new Map<string, NodeJS.Timeout>();
function logChanged(id: string, path: string): void {
  if (!active) return;
  const session = /[\\/]sessions[\\/]([^\\/]+)[\\/][^\\/]+$/.exec(path)?.[1];
  if (!session) return;
  const key = `${id}/${session}`;
  if (logPending.has(key)) return;
  logPending.set(key, setTimeout(() => { logPending.delete(key); broadcast({ type: "log", project: id, session }); }, 150));
}
/**
 * What a project's watchers leave out: uploaded pictures (a 10 MB write need not reload the project), the server's own
 * clock mark for the CLI (clock.json), temporary and lock files.
 */
const unwatched = (dir: string, p: string): boolean => p.endsWith(".tmp") || p.endsWith(".lock") || /^[\\/](uploads([\\/]|$)|clock\.json$)/.test(p.slice(dir.length));
/**
 * Each project's own recursive watcher of its .nexus folder (Node's), feeding its model: chokidar drops a share of a
 * file's atomic rewrites on Windows (measured: 7 of 40 rewrites of one file a few tens of ms apart; Node's watcher
 * missed none of 100), and a model that misses one keeps that file's old copy until its next reported change.
 */
const modelWatchers = new Map<string, FilesWatcher>();
function watchProject(id: string, dir: string): void {
  const reported = (path: string, kind: "state" | "log" | undefined) => {
    if (kind === "log") logChanged(id, path);
    else if (kind === "state") changed(id);
  };
  // A watcher that failed may have missed a change: the model reads everything again at its next read.
  const failed = (err: Error) => { console.error(`watch ${id}: ${err.message}; its model is read again`); projects.get(id)?.model.rebuild(); changed(id); };
  try {
    const native = watchFiles(dir, { recursive: true }, (event, name) => {
      const model = projects.get(id)?.model;
      if (!model) return;
      if (!name) { model.rebuild(); changed(id); return; }
      const path = join(dir, name);
      if (!unwatched(dir, path)) reported(path, model.watched(event, path));
    });
    native.on("error", failed);
    modelWatchers.set(id, native);
  } catch (err) { console.error(`watch ${id}: ${(err as Error).message}`); }
  watchers.set(id, chokidar
    .watch(dir, { ignoreInitial: true, followSymlinks: false, ignored: (p) => unwatched(dir, p) })
    .on("all", (_event, path) => {
      projects.get(id)?.model.touched(path);
      reported(path, isLogOnly(path) ? "log" : "state");
    })
    .on("error", (err) => failed(err as Error)));
}

// NEXUS_HOME's files that every project's state, the statistics and the estimates read, kept in memory (model.ts):
// this server's writes reach the model as they are made, a change by hand through this watcher.
const homeFiles = new FileCache(nexusHome());
useHomeReader(homeFiles);
chokidar.watch(["settings.yaml", "away.yaml", "turns.jsonl"].map((f) => join(nexusHome(), f)), { ignoreInitial: true }).on("all", (_event, path) => {
  homeFiles.touched(path);
  if (!path.endsWith("turns.jsonl")) for (const e of projects.values()) e.model.changed();
});
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
const lifecycle = new Lifecycle(() => [...projects.values()].map(projectPart), () => broadcast({ type: "server" }), {
  release, reacquire,
  notify: (text) => void push({ title: "Nexus: update failed", body: text.slice(0, 180), url: "/?settings", tag: "nexus-update" }, { kind: "update_failed" }),
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
  push: ({ kind, ...n }) => void push(n, { kind }),
  changed: () => {
    if (!active) return;
    broadcast({ type: "server" });
    for (const id of projects.keys()) changed(id); // its orchestrator is told when a plan is dropped
  },
});
const watch = new AttentionWatch();

// Every request is timed by its route, its synchronous part measured as a span (src/perf.ts).
app.use("*", perf.middleware);
// Remote devices sign in once with the access token; this machine needs nothing (src/remote.ts).
app.use("*", async (c, next) => {
  if (c.req.path === "/login" || isPublicFile(c.req.path) || allowed(c.env.incoming)) return next();
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
    // Running: at work now; a queue whose run the user stopped is not (queue EF, queueWorkedOn).
    const running = s?.queues.filter(queueWorkedOn).length ?? 0;
    return {
      id: e.id, root: e.root, name: s?.project.name ?? e.id, error: e.error,
      running, waiting: count("waiting"), stopped: count("stopped"),
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

// The ideas overview (docs/ux/ideas-overview.md; @nexus/protocol ideas.ts): the notes as they are now, each Decided
// entry's status and history from the queues that name it and the hand-over records. The notes are read, never written.
app.get("/api/projects/:id/ideas", (c) => {
  const e = c.get("entry");
  const s = stateOf(e);
  if (!s) return c.json({ error: e.error }, 500);
  reconcileIdeaStatuses(e.store, s);
  return c.json(projectIdeas(e.store, s) satisfies IdeasResponse);
});

// The suggestions for matching the project's earlier queues (whose source names no note) to its notes' entries, with
// the user's decisions (idea-matches.yaml); the dashboard's "To match" view.
app.get("/api/projects/:id/ideas/matches", (c) => {
  const e = c.get("entry");
  const s = stateOf(e);
  if (!s) return c.json({ error: e.error }, 500);
  return c.json(ideaMatches(e.store, s) satisfies IdeaMatchesResponse);
});
app.get("/api/projects/:id/ideas/links", (c) => {
  const e = c.get("entry");
  const s = stateOf(e);
  if (!s) return c.json({ error: e.error }, 500);
  return c.json(ideaLinks(e.store, s));
});
app.get("/api/projects/:id/ideas/statuses", (c) => {
  const e = c.get("entry");
  const s = stateOf(e);
  if (!s) return c.json({ error: e.error }, 500);
  reconcileIdeaStatuses(e.store, s);
  return c.json(ideaStatuses(e.store, s));
});

// The queue templates in effect for the project (docs/protocol/planning.md, "Queue templates"), for "New queue from template".
app.get("/api/projects/:id/templates", (c) => {
  const e = c.get("entry");
  const { templates, problems } = readTemplates(e.root);
  return c.json({
    templates: templates.map((t) => ({ id: t.id, title: t.title, description: t.description, layer: t.layer, replaces: t.replaces, params: t.params, maintenance: t.maintenance })),
    problems,
  } satisfies TemplatesResponse);
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

app.get("/api/projects/:id/commits/:hash", async (c) => {
  const e = c.get("entry");
  const hash = c.req.param("hash");
  if (!COMMIT_HASH.test(hash)) return c.json({ error: "not a commit hash (7 to 40 lowercase hex digits)" }, 400);
  const commit = await commitDetail(e.root, hash);
  return commit ? c.json(commit) : c.json({ error: "not found" }, 404);
});

// ---------------------------------------------------------------- writes (the user's actions)

// While an update drains, no run starts or goes on. The chats stay open (src/lifecycle.ts).
app.use("/api/projects/:id/*", async (c, next) => {
  if (c.req.method === "POST" && lifecycle.busy) {
    const action = c.req.path.endsWith("/run") ? ((await c.req.json().catch(() => ({}))) as { action?: string }).action : undefined;
    if (action === "start" || action === "resume" || c.req.path.endsWith("/continue")) {
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
// The stopped step's work is read first (its git without holding the loop); then the action checks, decides and writes
// in one go, as before (src/stopwork.ts).
app.post("/api/projects/:id/queues/:queue/approve", act(async (st, b, p) => {
  const left = await readStoppedWork(st, p("queue"));
  if (b.skip_closing !== undefined && typeof b.skip_closing !== "boolean") throw new ActionError("skip_closing is true or false");
  const skipClosing = b.skip_closing === true;
  if (skipClosing) closingToSkipAtApproval(st, p("queue"));
  const d = decideStoppedWork(st, p("queue"), b.work, "user_approval", left);
  if (!d.proceed) return { message: d.message };
  return approveQueue(st, p("queue"), b.words, { skipClosing });
}));
// The user's decision on suggested matches of earlier queues to the notes (accept: true, false, or null to take it back),
// written to idea-matches.yaml; a user's write like every other (no agent may: the nexus command has no such action).
app.post("/api/projects/:id/ideas/matches", act((st, b) => decideIdeaMatches(st, b.items, b.accept, { revision: b.revision, request_id: b.request_id })));
app.post("/api/projects/:id/ideas/statuses", act((st, b) => changeIdeaStatus(st, b)));
app.get("/api/projects/:id/ideas/handoffs", (c) => c.json(c.get("entry").store.readIdeaHandoffs().records));
app.post("/api/projects/:id/ideas/handoffs/preview", act((st, b) => previewIdeaHandoff(st, b)));
app.post("/api/projects/:id/ideas/handoffs", act((st, b, _p, e) => sendIdeaHandoff(st, b, (id, text) => e.orchestrator.enqueueIdea(id, text))));
app.post("/api/projects/:id/ideas/handoffs/:hid/retry", act((st, _b, p, e) => retryIdeaHandoff(st, p("hid"), (id, text) => e.orchestrator.enqueueIdea(id, text))));
app.post("/api/projects/:id/ideas/links", act((st, b) => changeIdeaLinks(st, b)));
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
// The user's answers about the plan (docs/protocol/planning.md, "The plan"): accept or decline the orchestrator's proposal for the
// queue, or hand a dependency they set back to the orchestrator (`after`: one predecessor; without it, all of them);
// the user's reorder: `move` the queue after `after` (null: with no queue before it), as in a list; `add` a
// predecessor (`after`) or `remove` one; and `undo` (`change`) a move, an add or a remove within its window. The three
// changes answer `{ message, undo: { change, until, queues } }`.
app.post("/api/projects/:id/queues/:queue/plan", act((st, b, p, e) => {
  const one = () => {
    if (typeof b.after !== "string" || !b.after) throw new ActionError("after is a queue id");
    return b.after;
  };
  switch (b.action) {
    case "move": {
      if (b.after !== null && (typeof b.after !== "string" || !b.after)) throw new ActionError("after is a queue id, or null for none before it");
      return e.engine.move(p("queue"), b.after as string | null);
    }
    case "add": return e.engine.addPredecessor(p("queue"), one());
    case "remove": return e.engine.removePredecessor(p("queue"), one());
    case "undo": {
      if (typeof b.change !== "string" || !b.change) throw new ActionError("change is the id a change to the plan answered with");
      return { message: e.engine.undoPlan(p("queue"), b.change) };
    }
    case "accept": return { message: acceptPlanProposal(st, p("queue")) };
    case "decline": return { message: declinePlanProposal(st, p("queue")) };
    case "hand_back": {
      if (b.after !== undefined && (typeof b.after !== "string" || !b.after)) throw new ActionError("after is a queue id");
      return { message: handBackPlan(st, p("queue"), b.after as string | undefined) };
    }
    default: throw new ActionError("action is move, add, remove, undo, accept, decline or hand_back");
  }
}));
// The user's decision on the orchestrator's proposal for the project's tag lists (docs/protocol/stats.md, "Tags"): accept or
// decline. Only the user: there is no CLI command and no event for it.
app.post("/api/projects/:id/tags/:proposal", act((st, b, p) => {
  switch (b.action) {
    case "accept": return { message: acceptTagProposal(st, p("proposal")) };
    case "decline": return { message: declineTagProposal(st, p("proposal")) };
    default: throw new ActionError("action is accept or decline");
  }
}));
// The user's decisions on a recurring queue (docs/protocol/planning.md, "Recurring queues"): the standing approval, a pause and its
// end, the removal. Only the user: there is no CLI command and no event for them.
app.post("/api/projects/:id/recurring/:rid", act((_st, b, p, e) => {
  switch (b.action) {
    case "approve": return { message: e.engine.approveRecurring(p("rid")) };
    case "pause": return { message: e.engine.pauseRecurring(p("rid"), true) };
    case "resume": return { message: e.engine.pauseRecurring(p("rid"), false) };
    default: throw new ActionError("action is approve, pause or resume");
  }
}));
app.delete("/api/projects/:id/recurring/:rid", act((_st, _b, p, e) => ({ message: e.engine.removeRecurring(p("rid")) })));
// Continue on a stopped queue: the user's lift of the stop, then the run goes on (only from the dashboard, as every write).
// `skip_closing: true`: the user skips the queue's closing refactoring step with it (checked before anything is recorded).
app.post("/api/projects/:id/queues/:queue/continue", act(async (st, b, p, e) => {
  const left = await readStoppedWork(st, p("queue"));
  if (b.skip_closing !== undefined && typeof b.skip_closing !== "boolean") throw new ActionError("skip_closing is true or false");
  const skipClosing = b.skip_closing === true;
  if (skipClosing) {
    const q = loadProjectState(st).queues.find((x) => x.id === p("queue"));
    if (!q) throw new ActionError(`unknown queue ${p("queue")}`, 404);
    closingToSkip(q);
  }
  const d = decideStoppedWork(st, p("queue"), b.work, "user_continue", left);
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
// refuses a request that does not come from the dashboard's own page.
/**
 * What removing the project would be now: from its state read again from its files (a write from another process may
 * not have come through yet), and from what the server's live parts say.
 */
function removalNow(e: Entry): RemovalView {
  e.model.rebuild(); e.error = undefined;
  const s = stateOf(e);
  const plan = planner.view()?.after;
  return removalView(e.root, s?.project.name ?? e.id, s, {
    engineIdle: e.engine.idle(), orchestratorIdle: e.orchestrator.idle(), conversationsIdle: e.conversations.idle(),
    merging: e.merger.merging(), updating: lifecycle.busy,
    deploy: plan?.project === e.id ? { queue: plan.queue, step: plan.step } : undefined,
  });
}
app.get("/api/projects/:id/removal", (c) => c.json(removalNow(c.get("entry"))));
// `delete_data: true` (with `name`, the project's name as typed): its .nexus folder is deleted too. Refused (409, with
// `blockers`) while anything runs in the project.
app.post("/api/projects/:id/remove", async (c) => {
  const e = c.get("entry");
  const body = (await c.req.json().catch(() => ({}))) as Body;
  try {
    const view = removalNow(e);
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

// A picture for a chat message (src/uploads.ts): the body's size is checked before it is parsed (from its
// Content-Length, or while it streams in), and the guard above has already taken it as the user's, from the dashboard.
// A body over the limit is read on and thrown away (up to MAX_UPLOAD_DRAIN, for UPLOAD_DRAIN_MS) before the 413, so the
// socket closes with nothing unread on it: Windows resets one that has, and the client loses the answer.
app.post("/api/projects/:id/uploads", async (c, next) => {
  const length = c.req.header("content-length");
  const declared = length !== undefined && !c.req.header("transfer-encoding") ? Number(length) : undefined;
  const read = await readLimited(c.req.raw.body, declared).catch(() => undefined);
  if (!read) return c.json({ error: "the body could not be read" }, 400, { connection: "close" });
  if ("body" in read) { c.req.raw = new Request(c.req.raw, { body: read.body }); return next(); }
  // Closed even when drained: the drain may have stopped at its bound, and a refused upload ends its connection.
  return c.json({ error: "only PNG, JPEG, WebP or GIF up to 10 MB" }, 413, { connection: "close" });
}, async (c) => {
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

// The project's whole history searched, from its files without an index (src/search.ts): the newest hits first.
app.get("/api/projects/:id/search", (c) => {
  const e = c.get("entry");
  try {
    return c.json(searchProject(e.store, parseSearch(c.req.query())));
  } catch (err) {
    if (err instanceof SearchError) return c.json({ error: err.message }, 400);
    console.error(err);
    return c.json({ error: (err as Error).message }, 500);
  }
});

app.get("/api/projects/:id/sessions/:session/activity", (c) => {
  const e = c.get("entry");
  const queue = c.req.query("queue"), step = c.req.query("step");
  const items = e.store.readActivity(c.req.param("session")).entries.filter((a) => (!queue || a.queue === queue) && (!step || a.step === step));
  return c.json(items.slice(-Number(c.req.query("limit") ?? 300)));
});

// Git on the dashboard (src/gitinfo.ts; local git only, never a fetch): a step's commits per round, a queue's branch.
// null when the project is not a git repository (or nothing was recorded).
app.get("/api/projects/:id/queues/:queue/steps/:step/commits", async (c) => {
  const e = c.get("entry");
  const q = stateOf(e)?.queues.find((x) => x.id === c.req.param("queue"));
  if (!q) return c.json({ error: "unknown queue" }, 404);
  return c.json((await stepCommits(e.store, q, c.req.param("step"))) ?? null);
});
// What a stopped queue's stopped step left (its own commits, the checkout's uncommitted changes) and whether a Discard
// is recorded for this stop; null when the queue is not stopped at a step.
app.get("/api/projects/:id/queues/:queue/left", async (c) => {
  const e = c.get("entry");
  const q = stateOf(e)?.queues.find((x) => x.id === c.req.param("queue"));
  if (!q) return c.json({ error: "unknown queue" }, 404);
  const left = await leftBehind(e.store, q);
  const view: LeftView | null = left ? { ...left, discarded: discardRecorded(q) ?? null } : null;
  return c.json(view);
});
app.get("/api/projects/:id/queues/:queue/git", async (c) => {
  const e = c.get("entry");
  const q = stateOf(e)?.queues.find((x) => x.id === c.req.param("queue"));
  if (!q) return c.json({ error: "unknown queue" }, 404);
  return c.json((await branchState(e.store, q)) ?? null);
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
  // `reviews`: the reviews' quality on three levels (queue RH), for the same project and range.
  const report: StatsReport & { reviews: ReviewStats } = { ...statsReport(stepStats(states, readTurns().entries), { by, project, since, filter }), reviews: reviewStats(states, { project, since }) };
  return c.json(report);
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
    const st = e.store;
    const ids = st.sessionIds();
    const recent = <T extends { at: string }>(xs: T[]) => xs.filter((x) => x.at > since);
    events.push(...projectDigest({
      state,
      events: ids.flatMap((s) => recent(st.readEvents(s).entries)),
      refusals: ids.flatMap((s) => recent(st.readRefusals(s).entries)),
      activity: ids.flatMap((s) => recent(st.readActivity(s).entries.filter((a) => a.kind === "retry"))),
    }, since));
    running.push(...projectRunning(state));
  }
  // The usage line: the account's windows are server-wide, so its turns are every project's (turns.jsonl).
  const usage = usageSince(readTurns().entries, runs, since);
  return c.json({ since, events: newestFirst(events).slice(0, 200), running, usage } satisfies DigestResponse);
});

app.get("/api/usage", (c) => c.json(readUsage() ?? null));
// The workstation's heavy slot (<NEXUS_HOME>/capacity.yaml): what a step whose checks are queued waits behind.
app.get("/api/capacity", (c) => c.json(readCapacity() ?? null));

// Nexus itself: its version, and updating it without cutting off running work (src/lifecycle.ts).
// `local`: whether this request comes straight from this machine (src/remote.ts isLocal), so the dashboard shows what
// only makes sense on the server machine ("Open in editor": a path on another device points nowhere).
app.get("/api/server", async (c) => c.json({ ...(await version()), local: isLocal(c.env.incoming), update: lifecycle.status, plan: planner.view(), push_on_deploy: readDeploySettings().push_on_deploy, max_running: readGlobalSettings().defaults.max_running, running: runningSteps(), away: awayNow(readAway()), crash: crashNotice() }));

// The server's measurements of itself (src/perf.ts): its event loop's delay, the requests by route, the blocks over
// 200 ms and what ran in them. Read-only, also while standing by.
app.get("/api/server/perf", (c) => c.json(perf.view()));

// ---------------------------------------------------------------- away mode (docs/protocol/review.md, "Away mode")

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
    // Only steps whose run is going: a run the user stopped leaves its step "running" in the derivation, with no agent
    // at work on it and nothing an update waits for (queue EF, stepWorkedOn).
    const steps = stepsWorkedOn(s?.queues ?? [])
      .map(({ queue: q, step: x }) => ({ queue: q.id, step: x.id, title: x.title, session: q.run?.session ?? null, run: q.run?.state ?? null }));
    return steps.length ? [{ project: e.id, name: s?.project.name ?? e.id, steps }] : [];
  });
}
// The server's settings, the user's to change, from the dashboard only: whether a deploy pushes the deployed main
// (src/deploy.ts), and how many queues may run at once across all projects (the global `defaults.max_running`,
// src/coordinator.ts).
app.post("/api/server/settings", async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as { push_on_deploy?: unknown; max_running?: unknown };
  if (b.push_on_deploy === undefined && b.max_running === undefined) return c.json({ error: "give push_on_deploy or max_running" }, 400);
  if (b.push_on_deploy !== undefined && typeof b.push_on_deploy !== "boolean") return c.json({ error: "push_on_deploy is true or false" }, 400);
  const limit = MaxRunning.safeParse(b.max_running);
  if (b.max_running !== undefined && !limit.success) return c.json({ error: "max_running is a whole number from 1 to 20" }, 400);
  if (typeof b.push_on_deploy === "boolean") writeDeploySettings({ ...readDeploySettings(), push_on_deploy: b.push_on_deploy });
  if (limit.success) {
    updateGlobalSettings({ defaults: { max_running: limit.data } });
    // Every project that follows it has a new effective limit; a higher one lets waiting starts go.
    for (const id of projects.keys()) changed(id);
    coordinator.wake();
  }
  broadcast({ type: "server" });
  return c.json({ ok: true, push_on_deploy: readDeploySettings().push_on_deploy, max_running: readGlobalSettings().defaults.max_running });
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
// The user closed the notice of the server's last crash (src/crash.ts): it is not shown again, in any dashboard.
app.post("/api/server/crash/dismiss", async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as { at?: unknown };
  if (typeof b.at !== "string") return c.json({ error: "at: the crash's time is missing" }, 400);
  if (!dismissCrash(b.at)) return c.json({ error: "no such crash: a later one replaced it" }, 409);
  broadcast({ type: "server" });
  return c.json({ crash: crashNotice() });
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
  const b = (await c.req.json().catch(() => ({}))) as { subscription?: unknown; label?: unknown; timezone?: unknown };
  try { subscribe(b.subscription, b.label, b.timezone); return c.json({ ok: true }); } catch (e) { return c.json({ error: (e as Error).message }, 400); }
});
// A device's notification settings (@nexus/protocol notify.ts), by its subscription's endpoint: read, and replaced.
app.get("/api/push/settings", (c) => {
  const settings = deviceNotify(c.req.query("endpoint"));
  return settings ? c.json({ settings }) : c.json({ error: new NotSubscribed().message }, 404);
});
app.put("/api/push/settings", async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as { endpoint?: unknown; settings?: unknown };
  try { return c.json({ settings: setDeviceNotify(b.endpoint, b.settings) }); }
  catch (e) { return c.json({ error: (e as Error).message }, e instanceof NotSubscribed ? 404 : 400); }
});
app.post("/api/push/unsubscribe", async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as { endpoint?: unknown };
  unsubscribe(b.endpoint);
  return c.json({ ok: true });
});
app.post("/api/push/test", async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as { endpoint?: unknown };
  const only = typeof b.endpoint === "string" ? b.endpoint : undefined;
  return c.json({ sent: await push({ title: "Nexus", body: "Notifications reach this device.", url: "/", tag: "test" }, { kind: "test", endpoint: only }) });
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
app.post("/api/projects/:id/conversations/:cid/compact", act((_st, _b, p, e) => e.conversations.compact(p("cid"))));
app.post("/api/projects/:id/orchestrator/settings", act((_st, b, _p, e) => e.orchestrator.settings(b.model, b.effort)));
app.patch("/api/projects/:id/settings", act((st, b) => updateSettings(st, b)));
// Which settings the project has its own value of (the others follow the global ones), and the global values.
app.get("/api/projects/:id/settings", (c) => {
  const e = c.get("entry");
  return c.json({ own: ownKeys(e.store.readStoredProject()), global: readGlobalSettings() });
});
// The global settings, which every project follows where it has no value of its own (docs/protocol/settings.md, "Global settings").
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
  app.route("/", dashboardFiles(WEB_DIST));
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
  // Chat turns an update's hand-over cut off (its predecessor's, or this server's own before a failed one) go on.
  for (const e of projects.values()) { e.orchestrator.resumeCutOff(); e.conversations.resumeCutOff(); }
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
  for (const w of modelWatchers.values()) w.close();
  modelWatchers.clear();
  await Promise.all(closing);
  planner.shutdown(); // its timers write the plan file: no longer this server's
  capacity?.shutdown(); // so does the coordinator: the successor writes capacity.yaml anew
  capacity = undefined;
  // Chat turns still running are cut off first and recorded: the successor goes on with them (src/lifecycle.ts).
  for (const e of projects.values()) projectPart(e).shutdown();
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

perf.start();
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

const shutdown = () => { capacity?.shutdown(); for (const e of projects.values()) { e.engine.shutdown(); e.orchestrator.shutdown(); e.conversations.shutdown(); e.merger.shutdown(); } process.exit(0); };
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
