// Withdrawing an approval: only the user, from the dashboard, and a withdrawn queue does not start. A real server
// process on a free port, and the engine against the fake `claude`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ActionError, ProjectStore, approveQueue, loadProjectState, routeAnswers, withdrawApproval, writeRegistry } from "@nexus/protocol";
import { Engine } from "../src/engine.ts";

const here = dirname(fileURLToPath(import.meta.url));
process.env.NEXUS_CLAUDE = join(here, "fake-claude.ts");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise<number>((resolve) => {
  const s = createServer();
  s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); });
});

function project() {
  const base = mkdtempSync(join(tmpdir(), "nexus-withdraw-"));
  process.env.NEXUS_HOME = join(base, "home");
  const root = join(base, "project");
  mkdirSync(root, { recursive: true });
  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  store.writeQueue({ protocol: 1, id: "Q", title: "Queue", revision: 1, status: "proposed", stop_conditions: [], checks: [],
    steps: [{ id: "Q1", title: "One", goal: "FAKE: done", acceptance: [] }] });
  approveQueue(store, "Q");
  return { base, root, store };
}

test("the engine refuses to start a queue whose approval was withdrawn", () => {
  const { store } = project();
  withdrawApproval(store, "Q", "not yet");
  const engine: Engine = new Engine(store, () => { routeAnswers(store); engine.onChange(loadProjectState(store)); });
  try {
    assert.throws(() => engine.start("Q"), (e: ActionError) => e.status === 409 && /approve/.test(e.message));
    assert.equal(store.readRun("Q"), undefined, "no run was written");
  } finally { engine.shutdown(); }
});

test("the API takes a withdrawal only from the dashboard's page, and refuses a start afterwards", async () => {
  const { root, store } = project();
  writeRegistry({ protocol: 1, projects: [{ id: "p", root }] });
  const port = await freePort();
  const child = spawn(process.execPath, [join(here, "../src/main.ts")], {
    env: { ...process.env, NEXUS_PORT: String(port), NEXUS_LOG: "" }, stdio: "ignore", windowsHide: true,
  });
  const base = `http://127.0.0.1:${port}`;
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  try {
    for (let i = 0; i < 100; i++) { try { if ((await fetch(base + "/api/projects")).ok) break; } catch { /* not up yet */ } await sleep(100); }
    const withdraw = "/api/projects/p/queues/Q/withdraw";

    // An agent's script or curl on this machine: JSON, but no Origin.
    let r = await post(withdraw, { reason: "an agent tries" });
    assert.equal(r.status, 403);
    // A request that says it is not from the page itself.
    r = await post(withdraw, {}, { origin: base, "sec-fetch-site": "none" });
    assert.equal(r.status, 403);
    // Another site.
    r = await post(withdraw, {}, { origin: "http://evil.example" });
    assert.equal(r.status, 403);
    assert.equal(loadProjectState(store).queues[0]!.approved, true, "nothing was withdrawn");

    // The dashboard's own request.
    r = await post(withdraw, { reason: "the art is missing" }, { origin: base, "sec-fetch-site": "same-origin" });
    assert.equal(r.status, 200, await r.text());
    const q = loadProjectState(store).queues[0]!;
    assert.equal(q.status, "proposed");
    assert.equal(q.withdrawals.at(-1)!.reason, "the art is missing");

    // A start request for the withdrawn queue is refused.
    r = await post("/api/projects/p/queues/Q/run", { action: "start" }, { origin: base });
    assert.equal(r.status, 409);
    assert.match(((await r.json()) as { error: string }).error, /approve/);
    assert.equal(store.readRun("Q"), undefined);
  } finally {
    child.kill();
  }
});
