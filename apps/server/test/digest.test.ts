// The morning digest over the API: what happened in every project after ?since=, newest first, with refused actions
// and retries, and what runs now. A real server process on a free port, two projects; no runtime is started.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectStore, approveQueue, writeRegistry, type Event } from "@nexus/protocol";
import type { DigestResponse } from "@nexus/protocol/digest";
import { spawnServer } from "./helpers.ts";
import { serverUp } from "./wait.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise<number>((resolve) => {
  const s = createServer();
  s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); });
});

test("GET /api/digest: every project's steps, stops, refusals and retries after the time, newest first", async () => {
  const base = mkdtempSync(join(tmpdir(), "nexus-digest-"));
  process.env.NEXUS_HOME = join(base, "home");
  const at = (h: number, m = 0) => new Date(Date.UTC(2026, 10, 13, h, m)).toISOString();
  const project = (id: string, name: string) => {
    const root = join(base, id);
    mkdirSync(root, { recursive: true });
    const store = ProjectStore.init(root, { id, name, root });
    store.writeSession({ protocol: 1, id: "s1", project: id, role: "worker", runtime: "claude", cwd: root, launched_by: "nexus", created_at: at(0) });
    store.writeQueue({ protocol: 1, id: "Q", title: `${name} queue`, revision: 1, status: "proposed", checks: [], stop_conditions: ["c"],
      steps: [{ id: "Q1", title: "one", goal: "g", acceptance: [] }, { id: "Q2", title: "two", goal: "g", acceptance: [] }] } as never);
    approveQueue(store, "Q");
    const emit = (when: string, body: Record<string, unknown>) => store.appendEvent({ v: 1, id: `${id}-${when}`, at: when, session: "s1", ...body } as Event);
    return { root, store, emit };
  };
  const a = project("a", "Alpha");
  a.emit(at(1), { type: "step.started", queue: "Q", step: "Q1" });
  a.emit(at(2), { type: "step.done", queue: "Q", step: "Q1", summary: "first done" });
  a.emit(at(3), { type: "step.started", queue: "Q", step: "Q2" });
  a.store.appendActivity("s1", { at: at(3, 30), kind: "retry", text: "overloaded", queue: "Q", step: "Q2" });
  a.emit(at(4), { type: "queue.stop", queue: "Q", step: "Q2", condition: "c", reason: "unclear" });
  const b = project("b", "Beta");
  b.emit(at(0, 30), { type: "step.started", queue: "Q", step: "Q1" });
  b.store.appendRefusal({ at: at(5), session: "s1", runtime: "claude", by: "permissions", tool: "Write", input: "x.md", queue: "Q", step: "Q1" });
  writeRegistry({ protocol: 1, projects: [{ id: "a", root: a.root }, { id: "b", root: b.root }] });

  const port = await freePort();
  const child = spawnServer({ NEXUS_PORT: String(port), NEXUS_LOG: "" });
  const url = `http://127.0.0.1:${port}`;
  try {
    await serverUp(url + "/api/projects");
    const d = (await (await fetch(`${url}/api/digest?since=${encodeURIComponent(at(1, 30))}`)).json()) as DigestResponse;
    assert.equal(d.since, at(1, 30));
    assert.deepEqual(d.events.map((e) => `${e.project}:${e.kind}:${e.step ?? ""}`), ["b:refused:Q1", "a:stopped:Q2", "a:retried:Q2", "a:done:Q1"]);
    assert.equal(d.events[1]!.project_name, "Alpha");
    const later = (await (await fetch(`${url}/api/digest?since=${encodeURIComponent(at(4, 30))}`)).json()) as DigestResponse;
    assert.deepEqual(later.events.map((e) => e.kind), ["refused"]);
    const bad = (await (await fetch(`${url}/api/digest?since=nonsense`)).json()) as DigestResponse;
    assert.ok(Date.now() - Date.parse(bad.since) > 86_000_000, "an unreadable time means the last 24 hours");
    assert.deepEqual(d.running, [], "no run is at work");
  } finally {
    child.kill();
  }
});
