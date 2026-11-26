// The projects a server loads, releases for an update and loads anew after a failed hand-over (ProjectRegistry,
// src/project-registry.ts; queue LCF, LC2 finding 4: nothing ran reacquire's drop of the released projects). Two
// projects are loaded, released and dropped as reacquire drops them, then loaded again: every old model is closed once,
// the coordinator holds only the new engines, and a write after it reaches one model per project.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ProjectStore, writeRegistry, type FileCache } from "@nexus/protocol";
import { Coordinator, type Member } from "../src/coordinator.ts";
import { ProjectRegistry, type Entry } from "../src/project-registry.ts";
import type { ProjectWatch } from "../src/watchers.ts";
import { assertTempHome } from "./helpers.ts";

/** The coordinator, with the engines it holds in view. */
class SeenCoordinator extends Coordinator {
  readonly held = new Set<Member>();
  override add(m: Member): void { this.held.add(m); super.add(m); }
  override remove(m: Member): void { this.held.delete(m); super.remove(m); }
}

/** A path as a FileCache keys its root: absolute, forward slashes, lower case on Windows. */
const key = (p: string) => { const k = resolve(p).replaceAll("\\", "/"); return process.platform === "win32" ? k.toLowerCase() : k; };

test("reacquire's start over: the released projects' old models are closed once, the coordinator holds only the new engines, and a write reaches one model per project (queue LCF, LC2 finding 4)", async () => {
  const base = mkdtempSync(join(tmpdir(), "nexus-registry-"));
  process.env.NEXUS_HOME = join(base, "home");
  assertTempHome(process.env.NEXUS_HOME);
  const roots = ["a", "b"].map((id) => {
    const root = join(base, id);
    mkdirSync(root);
    ProjectStore.init(root, { id, name: id.toUpperCase(), root });
    return { id, root };
  });
  writeRegistry({ protocol: 1, projects: roots });

  const projects = new Map<string, Entry>();
  const coordinator = new SeenCoordinator();
  const forgotten: string[] = [];
  const registry = new ProjectRegistry({
    projects, coordinator, pending: new Map(), watchers: new Map<string, ProjectWatch>(), watchedNotes: new Map(),
    live: { forget: (id) => forgotten.push(`live ${id}`) }, watch: { forget: (id) => forgotten.push(`watch ${id}`) },
    planner: { atBoundary: () => false, notices: () => [], shutdown: () => {} },
    lifecycle: { busy: false, notice: () => undefined },
    changed: () => {}, logChanged: () => {}, capacityChanged: () => {}, push: async () => 0, endAgents: () => {},
  });
  try {
    registry.refresh();
    const old = [...projects.values()];
    assert.deepEqual(old.map((e) => e.id).sort(), ["a", "b"]);
    assert.deepEqual([...coordinator.held].sort(), old.map((e) => e.engine).sort(), "the coordinator holds the loaded engines");
    const closes = new Map<Entry, number>(old.map((e) => [e, 0]));
    for (const e of old) { const close = e.model.close.bind(e.model); e.model.close = () => { closes.set(e, closes.get(e)! + 1); close(); }; }

    // An update's hand-over that fails: released, then dropped and loaded anew (main.ts, reacquire).
    await registry.release();
    registry.dropAll();
    assert.equal(projects.size, 0);
    assert.deepEqual(forgotten.sort(), ["live a", "live b", "watch a", "watch b"]);
    registry.refresh();
    const fresh = [...projects.values()];

    assert.deepEqual([...closes.values()], [1, 1], "every old model closed exactly once");
    assert.deepEqual(fresh.map((e) => e.id).sort(), ["a", "b"]);
    for (const e of fresh) assert.ok(!old.some((o) => o.model === e.model || o.engine === e.engine), `project ${e.id} loaded anew`);
    assert.deepEqual([...coordinator.held].sort(), fresh.map((e) => e.engine).sort(), "the coordinator holds only the new engines");

    // A write after it, in each project: through this process's writes it reaches the model of that project, once.
    const caches = [...old, ...fresh].map((e) => ({ e, cache: e.model.cache as FileCache, got: 0 }));
    for (const c of caches) {
      const touched = c.cache.touched.bind(c.cache);
      c.cache.touched = (path: string) => { if (key(path).startsWith(`${c.cache.root}/`)) c.got++; touched(path); };
    }
    for (const { id, root } of roots) {
      const files = ProjectStore.forRoot(root);
      files.writeProject({ ...files.readProject(), name: `${id} again` });
      const reached = caches.filter((c) => c.e.id === id && c.got > 0);
      assert.deepEqual(reached.map((c) => fresh.includes(c.e) ? "new" : "old"), ["new"], `project ${id}'s write reached one model, the new one`);
      for (const c of caches) c.got = 0;
    }
  } finally {
    await registry.release();
    registry.dropAll();
  }
});

// LCF6: an update's release waits up to 10 s for its agents' exits; an agent still running after it (a process that
// denies its termination keeps its host's K from finishing) used to run on beside the successor, whose write guard
// never knew its job. Now release ends every agent's job left (endAgents) as its last act, after the wait, not before.
test("an update's release ends the agents' jobs left after its wait for their exits, not before it", async () => {
  const base = mkdtempSync(join(tmpdir(), "nexus-registry-end-"));
  process.env.NEXUS_HOME = join(base, "home");
  assertTempHome(process.env.NEXUS_HOME);
  const root = join(base, "a");
  mkdirSync(root);
  ProjectStore.init(root, { id: "a", name: "A", root });
  writeRegistry({ protocol: 1, projects: [{ id: "a", root }] });
  const projects = new Map<string, Entry>();
  let ended: number | undefined;
  const registry = new ProjectRegistry({
    projects, coordinator: new Coordinator(), pending: new Map(), watchers: new Map<string, ProjectWatch>(), watchedNotes: new Map(),
    live: { forget: () => {} }, watch: { forget: () => {} },
    planner: { atBoundary: () => false, notices: () => [], shutdown: () => {} },
    lifecycle: { busy: false, notice: () => undefined },
    changed: () => {}, logChanged: () => {}, capacityChanged: () => {}, push: async () => 0,
    endAgents: () => { ended = Date.now(); }, exitWaitMs: 400,
  });
  registry.refresh();
  const e = projects.get("a")!;
  // The orchestrator's process does not exit.
  let stuck = true;
  e.orchestrator.alive = () => stuck;
  try {
    const started = Date.now();
    await registry.release();
    assert.ok(ended !== undefined, "the jobs left were ended");
    assert.ok(ended - started >= 400, `not before the wait's end (${ended - started} ms)`);
  } finally {
    stuck = false;
    registry.dropAll();
  }
});

test("an update's release whose agents all exited ends the jobs left (none) at once, without waiting", async () => {
  const base = mkdtempSync(join(tmpdir(), "nexus-registry-end-"));
  process.env.NEXUS_HOME = join(base, "home");
  assertTempHome(process.env.NEXUS_HOME);
  writeRegistry({ protocol: 1, projects: [] });
  let ended = 0;
  const registry = new ProjectRegistry({
    projects: new Map(), coordinator: new Coordinator(), pending: new Map(), watchers: new Map<string, ProjectWatch>(), watchedNotes: new Map(),
    live: { forget: () => {} }, watch: { forget: () => {} },
    planner: { atBoundary: () => false, notices: () => [], shutdown: () => {} },
    lifecycle: { busy: false, notice: () => undefined },
    changed: () => {}, logChanged: () => {}, capacityChanged: () => {}, push: async () => 0, endAgents: () => { ended++; },
  });
  await registry.release();
  assert.equal(ended, 1);
});
