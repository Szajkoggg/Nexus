// The statistics over the API (PROTOCOL.md, "Statistics"): GET /api/stats across projects or of one, grouped and since
// a time, and GET /api/projects/:id/metrics; an unknown project is 404, an unknown grouping 400. A real server process
// on a free port with a temporary NEXUS_HOME, two projects and a made-up turns.jsonl; no runtime is started.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectStore, approveQueue, writeRegistry, type Event, type ProjectMetrics, type StatsReport, type TurnRecord } from "@nexus/protocol";
import { spawnServer } from "./helpers.ts";
import { serverUp } from "./wait.ts";

const freePort = () => new Promise<number>((resolve) => {
  const s = createServer();
  s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); });
});

test("GET /api/stats and GET /api/projects/:id/metrics; unknown project 404, unknown grouping 400", async () => {
  const base = mkdtempSync(join(tmpdir(), "nexus-stats-api-"));
  const home = join(base, "home");
  process.env.NEXUS_HOME = home;
  const at = (h: number, m = 0) => new Date(Date.UTC(2026, 10, 15, h, m)).toISOString();
  const project = (id: string, kind: "code" | "docs") => {
    const root = join(base, id);
    mkdirSync(root, { recursive: true });
    const store = ProjectStore.init(root, { id, name: id, root });
    store.writeSession({ protocol: 1, id: "w", project: id, role: "worker", runtime: "claude", cwd: root, launched_by: "nexus", created_at: at(0), queue: "Q" });
    store.writeSession({ protocol: 1, id: "o", project: id, role: "orchestrator", runtime: "claude", cwd: root, launched_by: "nexus", created_at: at(0) });
    store.writeQueue({ protocol: 1, id: "Q", title: "Q", revision: 1, status: "proposed", checks: [], stop_conditions: [], kind, steps: [{ id: "Q1", title: "one", goal: "g", acceptance: [] }] } as never);
    approveQueue(store, "Q");
    const emit = (h: number, session: string, body: Record<string, unknown>) => store.appendEvent({ v: 1, id: `${id}-${h}-${session}`, at: at(h), session, queue: "Q", step: "Q1", ...body } as Event);
    return { root, store, emit };
  };
  const a = project("a", "code");
  a.emit(1, "w", { type: "step.started" });
  a.emit(2, "w", { type: "metric.recorded", name: "bundle-kb", value: 600, unit: "KB" });
  a.emit(3, "w", { type: "step.done", summary: "s" });
  a.emit(4, "o", { type: "review.accepted" });
  a.store.writeMetrics({ protocol: 1, metrics: [{ name: "bundle-kb", unit: "KB", show: "bar", warn_above: 500 }] });
  const b = project("b", "docs");
  b.emit(1, "w", { type: "step.started" });
  b.emit(2, "w", { type: "step.failed", reason: "no" });
  writeRegistry({ protocol: 1, projects: [{ id: "a", root: a.root }, { id: "b", root: b.root }] });
  const turn = (p: string, model: string): TurnRecord => ({ v: 1, at: at(2), started_at: at(1), duration_ms: 3_600_000, project: p, session: "w", role: "worker", runtime: "claude", queue: "Q", step: "Q1", model, outcome: "ok" });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "turns.jsonl"), [turn("a", "opus"), turn("b", "haiku")].map((t) => JSON.stringify(t)).join("\n") + "\n");

  const port = await freePort();
  const child = spawnServer({ NEXUS_PORT: String(port), NEXUS_LOG: "" });
  const url = `http://127.0.0.1:${port}`;
  const get = async (path: string) => { const r = await fetch(url + path); return { status: r.status, body: await r.json() as Record<string, unknown> }; };
  try {
    await serverUp(url + "/api/projects");
    const all = (await get("/api/stats")).body as unknown as StatsReport;
    assert.deepEqual([all.by, all.steps, all.groups.map((g) => [g.key, g.steps, g.first_accepted, g.failures, g.median_ms, g.few])],
      ["model", 2, [["haiku", 1, 0, 1, undefined, true], ["opus", 1, 1, 0, 3_600_000, true]]]);
    const kinds = (await get("/api/stats?by=kind&project=a")).body as unknown as StatsReport;
    assert.deepEqual([kinds.project, kinds.groups.map((g) => [g.key, g.steps])], ["a", [["code", 1]]]);
    const later = (await get(`/api/stats?since=${encodeURIComponent(at(3))}`)).body as unknown as StatsReport;
    assert.equal(later.steps, 1, "b's failure at 2:00 is before it");
    assert.equal((await get("/api/stats?project=nope")).status, 404);
    assert.equal((await get("/api/stats?by=colour")).status, 400);
    assert.equal((await get("/api/stats?since=nonsense")).status, 400);

    const m = (await get("/api/projects/a/metrics")).body as unknown as ProjectMetrics;
    assert.deepEqual(m.metrics.map((d) => [d.name, d.unit, d.warn_above]), [["bundle-kb", "KB", 500]]);
    assert.deepEqual(m.values.map((v) => [v.name, v.value, v.queue, v.step, v.warn?.side]), [["bundle-kb", 600, "Q", "Q1", "above"]]);
    const none = (await get("/api/projects/b/metrics")).body as unknown as ProjectMetrics;
    assert.deepEqual(none, { metrics: [], values: [] });
    const unknown = await get("/api/projects/nope/metrics");
    assert.deepEqual([unknown.status, unknown.body.error], [404, "unknown project"]);
  } finally {
    child.kill();
  }
});
