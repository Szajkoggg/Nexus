// Closed queues over the API (queue AQ; docs/protocol/api.md, "Closed queues"): the state's full read holds a closed
// queue that waits for nothing as its summary (`archived`), GET /api/projects/:id/queues/:queue gives its whole view;
// an open queue is whole in the state. A real server process on a free port with a temporary NEXUS_HOME; no runtime.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectStore, approveQueue, writeRegistry, type Event, type ProjectState, type QueueView } from "@nexus/protocol";
import { spawnServer } from "./helpers.ts";
import { serverUp } from "./wait.ts";

const freePort = () => new Promise<number>((resolve) => {
  const s = createServer();
  s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); });
});

test("the state holds a closed queue as its summary; GET …/queues/:queue gives its whole view", async () => {
  const base = mkdtempSync(join(tmpdir(), "nexus-archive-api-"));
  process.env.NEXUS_HOME = join(base, "home");
  const root = join(base, "p");
  mkdirSync(root, { recursive: true });
  const store = ProjectStore.init(root, { id: "p", name: "p", root });
  const at = (h: number) => new Date(Date.UTC(2026, 10, 15, h)).toISOString();
  store.writeSession({ protocol: 1, id: "w", project: "p", role: "worker", runtime: "claude", cwd: root, launched_by: "nexus", created_at: at(0), queue: "Q" });
  store.writeSession({ protocol: 1, id: "o", project: "p", role: "orchestrator", runtime: "claude", cwd: root, launched_by: "nexus", created_at: at(0) });
  for (const id of ["Q", "R"]) {
    store.writeQueue({ protocol: 1, id, title: `${id} title`, description: "what it is for", revision: 1, status: "proposed", checks: [], stop_conditions: ["stop"], kind: "docs",
      steps: [{ id: `${id}1`, title: "one", goal: "the goal", acceptance: ["it is done"] }] } as never);
  }
  approveQueue(store, "Q");
  const emit = (h: number, session: string, body: Record<string, unknown>) => store.appendEvent({ v: 1, id: `e${h}`, at: at(h), session, queue: "Q", step: "Q1", ...body } as Event);
  emit(1, "w", { type: "step.started" });
  emit(2, "w", { type: "step.done", summary: "written" });
  emit(3, "o", { type: "review.accepted" });
  writeRegistry({ protocol: 1, projects: [{ id: "p", root }] });

  const port = await freePort();
  const child = spawnServer({ NEXUS_PORT: String(port), NEXUS_LOG: "" });
  const url = `http://127.0.0.1:${port}`;
  const get = async <T>(path: string) => { const r = await fetch(url + path); return { status: r.status, body: await r.json() as T }; };
  try {
    await serverUp(url + "/api/projects");
    const state = (await get<ProjectState>("/api/projects/p/state")).body;
    const q = state.queues.find((x) => x.id === "Q")!;
    assert.deepEqual([q.status, q.archived, q.description, q.stop_conditions], ["done", true, undefined, []]);
    assert.deepEqual(q.steps.map((s) => [s.id, s.status, s.goal, s.acceptance, s.timeline, s.summary, s.started_at]), [["Q1", "done", "", [], [], undefined, at(1)]]);
    const r = state.queues.find((x) => x.id === "R")!;
    assert.deepEqual([r.archived, r.description, r.steps[0]!.goal], [undefined, "what it is for", "the goal"], "an open queue is whole");

    const whole = await get<QueueView>("/api/projects/p/queues/Q");
    assert.equal(whole.status, 200);
    assert.deepEqual([whole.body.archived, whole.body.description, whole.body.stop_conditions], [undefined, "what it is for", ["stop"]]);
    assert.deepEqual(whole.body.steps.map((s) => [s.goal, s.summary, s.timeline.map((e) => e.type)]), [["the goal", "written", ["step.started", "step.done", "review.accepted"]]]);
    assert.equal((await get("/api/projects/p/queues/NOPE")).status, 404);
    assert.equal((await get("/api/projects/nope/queues/Q")).status, 404);
  } finally {
    child.kill();
  }
});
