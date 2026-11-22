// NEXUS_HOME's files changed by another process (by hand, another tool) on a real server (queue LH, the LS survey's
// finding 5): the change reaches every project's state, its decisions run, and the dashboards get the state.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectStore, updateSettings, writeAway, writeRegistry, type ProjectState } from "@nexus/protocol";
import type { LiveMessage } from "@nexus/protocol/live";
import { spawnServer } from "./helpers.ts";
import { serverUp, until } from "./wait.ts";

const freePort = () => new Promise<number>((resolve) => {
  const s = createServer();
  s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); });
});

test("away mode turned on by another process: the server sends the project's state with it, without any other change (queue LH, finding 5)", async () => {
  const root = mkdtempSync(join(tmpdir(), "nexus-home-watch-")), home = join(root, "home");
  process.env.NEXUS_HOME = home;
  const store = ProjectStore.init(root, { id: "p", name: "Home", root });
  updateSettings(store, { orchestrator: { notify: false } });
  writeRegistry({ protocol: 1, projects: [{ id: "p", root }] });
  const port = await freePort(), url = `http://127.0.0.1:${port}`;
  const child = spawnServer({ NEXUS_HOME: home, NEXUS_DIR: store.dir, NEXUS_PORT: String(port), NEXUS_LOG: "" });
  let ws: WebSocket | undefined;
  try {
    await serverUp(`${url}/api/projects`);
    const messages: LiveMessage[] = [];
    ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    ws.addEventListener("message", (e) => messages.push(JSON.parse(String(e.data)) as LiveMessage));
    await until("the socket's hello", () => messages[0]?.type === "hello");
    const read = async () => (await (await fetch(`${url}/api/projects/p/state`)).json()) as ProjectState;
    assert.equal((await read()).away.on, false);
    const before = messages.length;
    const now = Date.now();
    writeAway({ protocol: 1, current: { since: new Date(now - 60_000).toISOString(), until: new Date(now + 3_600_000).toISOString() }, past: [] });
    // away.yaml did not exist when the server began watching (queue LH): it is reported all the same.
    const withAway = (m: LiveMessage) => m.type === "state" && "project" in m && m.project === "p" && (m as { set?: { away?: { on?: boolean } } }).set?.away?.on === true;
    await until("the project's state sent with away mode on", () => messages.slice(before).some(withAway));
    assert.equal((await read()).away.on, true);
  } finally { ws?.close(); child.kill(); }
});
