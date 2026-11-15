// The run API waits for the immediate stop and returns its asynchronous refusals as HTTP errors.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectStore, approveQueue, loadProjectState, updateSettings, writeRegistry } from "@nexus/protocol";
import { assertTempHome, spawnServer } from "./helpers.ts";
import { LONGER, serverUp, until } from "./wait.ts";

test("Stop at once API waits for exit, keeps the pause and refuses an absent worker", async () => {
  const root = mkdtempSync(join(tmpdir(), "nexus-stop-api-"));
  const home = join(root, "home");
  assertTempHome(home);
  process.env.NEXUS_HOME = home;
  const store = ProjectStore.init(root, { id: "p", name: "Test", root });
  updateSettings(store, { orchestrator: { notify: false } });
  store.writeQueue({ protocol: 1, id: "Q", title: "Test", revision: 1, status: "proposed", stop_conditions: [], checks: [],
    steps: [{ id: "Q1", title: "Test", goal: "FAKE: slow", acceptance: [] }] });
  approveQueue(store, "Q");
  writeRegistry({ protocol: 1, projects: [{ id: "p", root }] });
  const port = await new Promise<number>((resolve) => {
    const socket = createServer().listen(0, "127.0.0.1", () => {
      const p = (socket.address() as { port: number }).port;
      socket.close(() => resolve(p));
    });
  });
  assert.ok(port >= 4318);
  const here = dirname(fileURLToPath(import.meta.url));
  const child = spawnServer({ NEXUS_HOME: home, NEXUS_DIR: store.dir, NEXUS_PORT: String(port), NEXUS_LOG: "",
    NEXUS_CLAUDE: join(here, "fake-claude.ts"), NEXUS_CODEX: join(here, "fake-codex.ts"), FAKE_SLOW_MS: "300000" });
  const url = `http://127.0.0.1:${port}`;
  const post = (action: string, origin = url) => fetch(`${url}/api/projects/p/queues/Q/run`, {
    method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify({ action }),
  });
  try {
    await serverUp(`${url}/api/projects`);
    assert.equal((await post("start")).status, 200);
    await until("the fake worker's running step", () => loadProjectState(store).queues[0]!.steps[0]!.status === "running", LONGER.step);
    const session = store.readRun("Q")!.session;
    store.writeQueue({ ...store.readQueue("Q"), id: "OLD", steps: [{ id: "OLD1", title: "Earlier", goal: "", acceptance: [] }] });
    store.writeRun("OLD", { ...store.readRun("Q")!, state: "paused", step: "OLD1" });
    const old = await fetch(`${url}/api/projects/p/queues/OLD/run`, {
      method: "POST", headers: { "content-type": "application/json", origin: url }, body: JSON.stringify({ action: "stop_at_once" }),
    });
    assert.equal(old.status, 409, "an earlier run cannot kill a session now owned by another queue");
    assert.equal(store.readRuntime(session)?.state, "working");
    assert.equal((await post("stop_at_once", "http://foreign.invalid")).status, 403);
    const response = await post("stop_at_once");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, result: null });
    assert.equal(store.readRuntime(session)?.state, "exited");
    assert.equal(store.readRun("Q")!.state, "paused");
    const refused = await post("stop_at_once");
    assert.equal(refused.status, 409);
    assert.match((await refused.json() as { error: string }).error, /not running/);
  } finally {
    if (child.exitCode === null) {
      const gone = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill(); await gone;
    }
  }
});
