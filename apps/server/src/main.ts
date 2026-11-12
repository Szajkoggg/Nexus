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
import { ProjectStore, loadProjectState, nexusHome, readRegistry, type ProjectState } from "@nexus/protocol";

const PORT = Number(process.env.NEXUS_PORT ?? 4317);
const HOST = process.env.NEXUS_HOST ?? "127.0.0.1";
const WEB_DIST = resolve(dirname(fileURLToPath(import.meta.url)), "../../web/dist");

// ---------------------------------------------------------------- projects

interface Entry { id: string; root: string; store: ProjectStore; state?: ProjectState; error?: string }
const projects = new Map<string, Entry>();

function refreshRegistry(): void {
  const reg = readRegistry();
  for (const p of reg.projects) {
    if (projects.has(p.id)) continue;
    const store = ProjectStore.forRoot(p.root);
    projects.set(p.id, { id: p.id, root: p.root, store });
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
    if (e) { e.state = undefined; e.error = undefined; }
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

const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  if (req.url !== "/ws") { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => {
    sockets.add(ws);
    ws.on("close", () => sockets.delete(ws));
  });
});
