// The Nexus server: reads every registered project's .nexus/ directory, serves the dashboard and its API,
// and tells connected dashboards when a project's files change. It writes nothing in phase 1.
import { createReadStream, existsSync, realpathSync, statSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { WebSocketServer, type WebSocket } from "ws";
import chokidar from "chokidar";
import {
  ActionError, ProjectStore, addNote, answerAsUser, approveQueue, deleteNote, loadProjectState, nexusHome,
  readRegistry, readUsage, routeAnswers, sendMessage, setQueueSettings, type ProjectState,
} from "@nexus/protocol";
import { Engine } from "./engine.ts";
import { Orchestrator } from "./orchestrator.ts";
import { listCodexModels } from "./codex.ts";

const PORT = Number(process.env.NEXUS_PORT ?? 4317);
const HOST = process.env.NEXUS_HOST ?? "127.0.0.1";
const WEB_DIST = resolve(dirname(fileURLToPath(import.meta.url)), "../../web/dist");

// ---------------------------------------------------------------- projects

interface Entry { id: string; root: string; store: ProjectStore; engine: Engine; orchestrator: Orchestrator; state?: ProjectState; error?: string }
const projects = new Map<string, Entry>();

function refreshRegistry(): void {
  const reg = readRegistry();
  for (const p of reg.projects) {
    if (projects.has(p.id)) continue;
    const store = ProjectStore.forRoot(p.root);
    const engine = new Engine(store, () => changed(p.id));
    projects.set(p.id, { id: p.id, root: p.root, store, engine, orchestrator: new Orchestrator(store, engine, () => changed(p.id)) });
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
  clearTimeout(pending.get(id));
  pending.set(id, setTimeout(() => {
    pending.delete(id);
    const e = projects.get(id);
    if (e) {
      e.state = undefined; e.error = undefined;
      // Deliver new answers to the sessions that asked. Its own inbox writes come back here and route nothing.
      const s = stateOf(e);
      if (s) {
        try { if (routeAnswers(e.store, s) > 0) e.state = undefined; }
        catch (err) { console.error(`routing answers in ${id}: ${(err as Error).message}`); }
        try { const fresh = stateOf(e); if (fresh) e.orchestrator.onChange(fresh); }
        catch (err) { console.error(`orchestrator in ${id}: ${(err as Error).message}`); }
        e.state = undefined;
        try { const fresh = stateOf(e); if (fresh) e.engine.onChange(fresh); }
        catch (err) { console.error(`engine in ${id}: ${(err as Error).message}`); }
        e.state = undefined;
      }
    }
    const msg = JSON.stringify({ type: "changed", project: id });
    for (const s of sockets) if (s.readyState === s.OPEN) s.send(msg);
  }, 150));
}

function watchProject(id: string, dir: string): void {
  chokidar
    .watch(dir, { ignoreInitial: true, ignored: (p) => p.endsWith(".tmp") })
    .on("all", () => changed(id))
    .on("error", (err) => console.error(`watch ${id}: ${(err as Error).message}`));
}

chokidar.watch(join(nexusHome(), "projects.yaml"), { ignoreInitial: true }).on("all", () => {
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

const app = new Hono();

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
 */
app.use("/api/*", async (c, next) => {
  if (c.req.method === "GET" || c.req.method === "HEAD") return next();
  const origin = c.req.header("origin");
  if (origin && new URL(origin).host !== c.req.header("host")) return c.json({ error: "cross-origin write refused" }, 403);
  if (!c.req.header("content-type")?.startsWith("application/json")) return c.json({ error: "JSON only" }, 415);
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
app.patch("/api/projects/:id/queues/:queue", act((st, b, p) => setQueueSettings(st, p("queue"), b)));
app.post("/api/projects/:id/questions/:qid/answer", act((st, b, p) => answerAsUser(st, p("qid"), b.text, b.continue)));

// The engine: running queues through Nexus-launched sessions.
const engineOf = (st: ProjectStore) => [...projects.values()].find((e) => e.store === st)!.engine;
app.post("/api/projects/:id/queues/:queue/run", act((st, b, p) => {
  const engine = engineOf(st); const q = p("queue");
  switch (b.action) {
    case "start": return engine.start(q, {
      model: (b.model as string) || undefined, session: (b.session as string) || undefined,
      runtime: b.runtime === "codex" || b.runtime === "claude" ? b.runtime : undefined,
    });
    case "pause": return engine.pause(q);
    case "resume": return engine.resume(q);
    case "stop": return engine.stopNow(q, b.text as string | undefined);
    default: throw new ActionError("action is start, pause, resume or stop");
  }
}));
app.post("/api/projects/:id/queues/:queue/steps/:step/accept", act((st, b, p) => engineOf(st).acceptReview(p("queue"), p("step"), b.text as string | undefined)));

app.get("/api/projects/:id/sessions/:session/activity", (c) => {
  const e = projects.get(c.req.param("id"));
  if (!e) return c.json({ error: "unknown project" }, 404);
  return c.json(e.engine.activity(c.req.param("session"), c.req.query("queue"), c.req.query("step"), Number(c.req.query("limit") ?? 300)));
});

app.get("/api/usage", (c) => c.json(readUsage() ?? null));
app.get("/api/codex/models", async (c) => c.json(await listCodexModels()));

// The orchestrator chat.
const orchestratorOf = (st: ProjectStore) => [...projects.values()].find((e) => e.store === st)!.orchestrator;
app.get("/api/projects/:id/orchestrator", (c) => {
  const e = projects.get(c.req.param("id"));
  return e ? c.json(e.orchestrator.view()) : c.json({ error: "unknown project" }, 404);
});
app.post("/api/projects/:id/orchestrator/messages", act((st, b) => orchestratorOf(st).say(b.text)));
app.post("/api/projects/:id/orchestrator/reset", act((st) => orchestratorOf(st).reset()));

if (existsSync(WEB_DIST)) {
  app.use("/*", serveStatic({ root: WEB_DIST.replaceAll("\\", "/") }));
  app.get("*", serveStatic({ path: join(WEB_DIST, "index.html").replaceAll("\\", "/") }));
}

// ---------------------------------------------------------------- start

refreshRegistry();
const server = serve({ fetch: app.fetch, port: PORT, hostname: HOST }, (info) => {
  console.log(`Nexus server on http://${HOST}:${info.port} (${projects.size} project(s); registry in ${nexusHome()})`);
  if (!existsSync(WEB_DIST)) console.log("No built dashboard: run the web dev server (npm run dev) or npm start.");
});

const shutdown = () => { for (const e of projects.values()) { e.engine.shutdown(); e.orchestrator.shutdown(); } process.exit(0); };
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  if (req.url !== "/ws") { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => {
    sockets.add(ws);
    ws.on("close", () => sockets.delete(ws));
  });
});
