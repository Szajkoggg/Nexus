// An unknown project is a 404 on every route under /api/projects/:id, read or write, looked up in one place
// (src/main.ts). The routes are read from src/main.ts, so a new one is covered too. A real server on a free port.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectStore, writeRegistry } from "@nexus/protocol";
import { spawnServer } from "./helpers.ts";
import { serverUp } from "./wait.ts";

const here = dirname(fileURLToPath(import.meta.url));
const freePort = () => new Promise<number>((resolve) => {
  const s = createServer();
  s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); });
});

/** Every route of a project, with its method and its parameters filled in (the project's id left as `:id`). */
function projectRoutes(): { method: string; path: string }[] {
  const src = readFileSync(join(here, "../src/main.ts"), "utf8");
  return [...src.matchAll(/app\.(get|post|patch|put|delete)\("(\/api\/projects\/:id\/[^"]+)"/g)]
    .map((m) => ({ method: m[1]!.toUpperCase(), path: m[2]!.replace(/:(?!id\b)(\w+)/g, "x") }));
}

test("an unknown project is a 404 on every route under it; a known one is found", async () => {
  const base = mkdtempSync(join(tmpdir(), "nexus-unknown-"));
  process.env.NEXUS_HOME = join(base, "home");
  const root = join(base, "project");
  mkdirSync(root, { recursive: true });
  ProjectStore.init(root, { id: "p", name: "P", root });
  writeRegistry({ protocol: 1, projects: [{ id: "p", root }] });
  const port = await freePort();
  const child = spawnServer({ NEXUS_PORT: String(port), NEXUS_LOG: "" });
  const url = `http://127.0.0.1:${port}`;
  // As the dashboard sends a write: JSON, from its own page.
  const page = { "content-type": "application/json", origin: url, "sec-fetch-site": "same-origin" };
  try {
    await serverUp(url + "/api/projects");
    const routes = projectRoutes();
    const groups = new Set(routes.map((r) => r.path.split("/")[4]));
    for (const g of ["state", "file", "queues", "sessions", "questions", "orchestrator", "conversations", "settings", "uploads", "tags", "refusals"]) {
      assert.ok(groups.has(g), `the route list has the ${g} group`);
    }
    for (const r of routes) {
      const write = r.method !== "GET";
      const res = await fetch(url + r.path.replace(":id", "nope"), { method: r.method, ...(write ? { headers: page, body: "{}" } : {}) });
      assert.equal(res.status, 404, `${r.method} ${r.path}: ${res.status}`);
      assert.deepEqual(await res.json(), { error: "unknown project" }, `${r.method} ${r.path}`);
    }
    // The lookup lets a known project through.
    assert.equal((await fetch(`${url}/api/projects/p/state`)).status, 200);
    const unknownQueue = await fetch(`${url}/api/projects/p/queues/nope/git`);
    assert.deepEqual([unknownQueue.status, await unknownQueue.json()], [404, { error: "unknown queue" }]);
  } finally {
    child.kill();
  }
});
