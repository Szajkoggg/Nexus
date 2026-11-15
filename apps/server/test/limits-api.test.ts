// The limits on queues running at once through a real server (queue OP2): an old home's limits.json moves into the
// global settings at the start; the server panel's setting writes the global value (and its copy in limits.json); a
// project's own value is set like any of its settings.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectStore, readGlobalSettings, writeRegistry } from "@nexus/protocol";
import { spawnServer } from "./helpers.ts";
import { LONGER, untilAsync } from "./wait.ts";

const freePort = () => new Promise<number>((resolve) => {
  const s = createServer();
  s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); });
});

test("a real server takes an old limits.json into the global setting, writes the global limit from the server panel, and a project's own", async () => {
  const base = mkdtempSync(join(tmpdir(), "nexus-limits-api-"));
  const home = join(base, "home");
  process.env.NEXUS_HOME = home;
  mkdirSync(home, { recursive: true });
  // A home from before: the limit in limits.json, global settings without it.
  writeFileSync(join(home, "limits.json"), JSON.stringify({ max_running: 4 }));
  writeFileSync(join(home, "settings.yaml"), "protocol: 1\ndefaults:\n  review_level: 3\n");
  const root = join(base, "p");
  mkdirSync(root);
  ProjectStore.init(root, { id: "p", name: "P", root });
  writeRegistry({ protocol: 1, projects: [{ id: "p", root }] });

  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const child: ChildProcess = spawnServer({ NEXUS_HOME: home, NEXUS_PORT: String(port), NEXUS_LOG: "", NEXUS_DIR: "", NEXUS_SESSION: "" });
  const write = (method: string, path: string, body: unknown) => fetch(url + path, { method, headers: { "content-type": "application/json", origin: url, "sec-fetch-site": "same-origin" }, body: JSON.stringify(body) });
  const server = async () => (await (await fetch(url + "/api/server")).json()) as { max_running: number };
  const limits = () => (JSON.parse(readFileSync(join(home, "limits.json"), "utf8")) as { max_running: number }).max_running;
  try {
    await untilAsync("the server", async () => { try { return (await fetch(url + "/api/server")).ok; } catch { return false; } }, LONGER.processes);
    assert.equal((await server()).max_running, 4, "taken from limits.json");
    assert.equal(readGlobalSettings().defaults.max_running, 4);
    assert.equal(readGlobalSettings().defaults.review_level, 3, "the other global settings stay");

    assert.equal((await write("POST", "/api/server/settings", { max_running: 25 })).status, 400);
    assert.equal((await write("POST", "/api/server/settings", { max_running: 6 })).status, 200);
    assert.equal((await server()).max_running, 6);
    assert.equal(readGlobalSettings().defaults.max_running, 6, "the global setting");
    assert.equal(limits(), 6, "and its copy for an older server");

    // A project follows the global limit until it has its own.
    const effective = async () => ((await (await fetch(url + "/api/projects/p/state")).json()) as { project: { defaults: { max_running: number } } }).project.defaults.max_running;
    assert.equal(await effective(), 6);
    assert.equal((await write("PATCH", "/api/projects/p/settings", { defaults: { max_running: 1 }, own: ["defaults.max_running"] })).status, 200);
    await untilAsync("its own limit", async () => (await effective()) === 1);
    const own = (await (await fetch(url + "/api/projects/p/settings")).json()) as { own: string[]; global: { defaults: { max_running: number } } };
    assert.ok(own.own.includes("defaults.max_running"));
    assert.equal(own.global.defaults.max_running, 6, "the global limit stays");
  } finally {
    child.kill();
    await new Promise((r) => (child.exitCode !== null ? r(null) : child.on("exit", r)));
  }
});
