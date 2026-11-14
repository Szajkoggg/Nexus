// Every write to the API is a user action and must come from the dashboard's own page: without its Origin (an agent's
// script, a curl on this machine) it is refused. The routes are read from src/main.ts, so a new one is covered too.
// The only exceptions are what `nexus server` sends (update, cancel). A real server process on a free port.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectStore, loadProjectState, writeRegistry } from "@nexus/protocol";
import { spawnServer } from "./helpers.ts";
import { serverUp } from "./wait.ts";

const here = dirname(fileURLToPath(import.meta.url));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise<number>((resolve) => {
  const s = createServer();
  s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); });
});

/** Every POST, PATCH, PUT and DELETE route of the API, with its parameters filled in. */
function writeRoutes(): { method: string; path: string }[] {
  const src = readFileSync(join(here, "../src/main.ts"), "utf8");
  return [...src.matchAll(/app\.(post|patch|put|delete)\("(\/api\/[^"]+)"/g)]
    .map((m) => ({ method: m[1]!.toUpperCase(), path: m[2]!.replace(":id", "p").replace(/:(\w+)/g, "x") }));
}

test("every write without the dashboard's origin is refused; approve and settings work from the dashboard", async () => {
  const base = mkdtempSync(join(tmpdir(), "nexus-guard-"));
  process.env.NEXUS_HOME = join(base, "home");
  const root = join(base, "project");
  mkdirSync(root, { recursive: true });
  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  store.writeQueue({ protocol: 1, id: "Q", title: "Queue", revision: 1, status: "proposed", stop_conditions: [], checks: [],
    steps: [{ id: "Q1", title: "One", goal: "", acceptance: [] }] });
  writeRegistry({ protocol: 1, projects: [{ id: "p", root }] });
  const port = await freePort();
  const child = spawnServer({ NEXUS_PORT: String(port), NEXUS_LOG: "" });
  const url = `http://127.0.0.1:${port}`;
  const send = (method: string, path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(url + path, { method, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  try {
    await serverUp(url + "/api/projects");

    const routes = writeRoutes();
    assert.ok(routes.some((r) => r.path === "/api/projects/p/queues/x/approve") && routes.some((r) => r.method === "PATCH" && r.path === "/api/projects/p/settings")
      && routes.some((r) => r.path === "/api/projects/p/queues/x/continue"), "the list holds approve, settings and Continue");
    assert.ok(routes.some((r) => r.path === "/api/projects/p/queues/x/merge") && routes.some((r) => r.path === "/api/projects/p/queues/x/cleanup"), "and merge back and cleanup");
    const open = new Set(["/api/server/update", "/api/server/cancel", "/api/server/away"]); // the CLI's own: not sent here, they would act
    for (const r of routes.filter((x) => !open.has(x.path))) {
      const res = await send(r.method, r.path, {});
      assert.equal(res.status, 403, `${r.method} ${r.path} without an Origin: ${res.status} ${await res.text()}`);
      const other = await send(r.method, r.path, {}, { origin: url, "sec-fetch-site": "cross-site" });
      assert.equal(other.status, 403, `${r.method} ${r.path} not from the page itself`);
    }
    assert.equal(loadProjectState(store).queues[0]!.approved, false, "nothing was approved");
    assert.equal(store.readProject().name, "P", "no setting changed");

    const page = { origin: url, "sec-fetch-site": "same-origin" };
    let res = await send("POST", "/api/projects/p/queues/Q/approve", { words: "go" }, page);
    assert.equal(res.status, 200, await res.text());
    assert.equal(loadProjectState(store).queues[0]!.approved, true);
    res = await send("PATCH", "/api/projects/p/settings", { name: "Renamed" }, page);
    assert.equal(res.status, 200, await res.text());
    assert.equal(store.readProject().name, "Renamed");
  } finally {
    child.kill();
  }
});
