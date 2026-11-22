// The server's file watchers (watchers.ts) with stand-in watchers from an injected factory (queue LH): what each report
// does to the project's model and decisions, a watcher's error, and NEXUS_HOME's watchers. No server, no file system.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { watchHome, watchProject, type NativeWatcher, type TreeOptions, type TreeWatcher, type WatchFactory } from "../src/watchers.ts";

class NativeStand extends EventEmitter implements NativeWatcher {
  closed = false;
  readonly listener: (event: "rename" | "change", name: string | null) => void;
  constructor(listener: NativeStand["listener"]) { super(); this.listener = listener; }
  close(): void { this.closed = true; }
}

class TreeStand extends EventEmitter implements TreeWatcher {
  readonly paths: string | string[];
  readonly options: TreeOptions;
  added: string[] = [];
  constructor(paths: string | string[], options: TreeOptions) { super(); this.paths = paths; this.options = options; }
  add(path: string): void { this.added.push(path); }
  unwatch(path: string): void { this.added = this.added.filter((p) => p !== path); }
  close(): Promise<void> { return Promise.resolve(); }
}

function stands(o: { nativeThrows?: boolean } = {}) {
  const natives: NativeStand[] = [], trees: TreeStand[] = [];
  const factory: WatchFactory = {
    native: (_dir, listener) => { if (o.nativeThrows) throw new Error("EMFILE"); const n = new NativeStand(listener); natives.push(n); return n; },
    tree: (paths, options) => { const t = new TreeStand(paths, options); trees.push(t); return t; },
  };
  return { factory, natives, trees };
}

function project() {
  const calls: string[] = [];
  const model = {
    watched: (event: string, path: string) => { calls.push(`watched:${event}:${path.split(/[\\/]/).at(-1)}`); return path.endsWith("activity.jsonl") ? "log" as const : "state" as const; },
    touched: (path: string) => { calls.push(`touched:${path.split(/[\\/]/).at(-1)}`); },
    rebuild: () => { calls.push("rebuild"); },
  };
  const hooks = { model: () => model, changed: () => { calls.push("changed"); }, log: (path: string) => { calls.push(`log:${path.split(/[\\/]/).at(-1)}`); } };
  return { calls, hooks };
}

const dir = join("C:", "p", ".nexus");
const home = mkdtempSync(join(tmpdir(), "nexus-watch-home-"));

test("a project's watchers: Node's feeds the model, chokidar's touches it, each leaves out temporary files (queue LH)", () => {
  const { factory, natives, trees } = stands();
  const { calls, hooks } = project();
  const w = watchProject("p", dir, hooks, factory);
  assert.equal(w.native(), natives[0]);
  assert.equal(w.tree, trees[0]);
  assert.equal(trees[0]!.paths, dir);
  natives[0]!.listener("change", join("queues", "Q", "run.yaml"));
  natives[0]!.listener("change", join("sessions", "S", "activity.jsonl"));
  natives[0]!.listener("rename", join("queues", "Q", "run.yaml.123.tmp"));
  natives[0]!.listener("change", "clock.json");
  natives[0]!.listener("rename", null);
  assert.deepEqual(calls.splice(0), ["watched:change:run.yaml", "changed", "watched:change:activity.jsonl", "log:activity.jsonl", "rebuild", "changed"], "a temporary file and the clock mark are left out; no name: everything read again");
  assert.equal(trees[0]!.options.ignored!(join(dir, "uploads", "a.png")), true);
  assert.equal(trees[0]!.options.ignored!(join(dir, "queues", "Q", "run.yaml")), false);
  trees[0]!.emit("all", "change", join(dir, "sessions", "S", "chat.jsonl"));
  trees[0]!.emit("all", "change", join(dir, "queues", "Q", "queue.yaml"));
  assert.deepEqual(calls.splice(0), ["touched:chat.jsonl", "log:chat.jsonl", "touched:queue.yaml", "changed"]);
});

test("a project's watcher that fails: the model is read again and the decisions run (queue LH)", () => {
  const { factory, natives, trees } = stands();
  const { calls, hooks } = project();
  watchProject("p", dir, hooks, factory);
  natives[0]!.emit("error", new Error("EPERM"));
  trees[0]!.emit("error", new Error("overflow"));
  assert.deepEqual(calls, ["rebuild", "changed", "rebuild", "changed"]);
});

test("Node's watcher not made: chokidar's still watches (queue LH)", () => {
  const { factory, trees } = stands({ nativeThrows: true });
  const { calls, hooks } = project();
  const w = watchProject("p", dir, hooks, factory);
  assert.equal(w.native(), undefined);
  trees[0]!.emit("all", "change", join(dir, "queues", "Q", "queue.yaml"));
  assert.deepEqual(calls, ["touched:queue.yaml", "changed"]);
});

test("NEXUS_HOME's watchers: the shared files and the registry (queue LH)", () => {
  const { factory, trees } = stands();
  const seen: string[] = [];
  watchHome(home, { touched: (path) => seen.push(`touched:${path.split(/[\\/]/).at(-1)}`), settings: () => seen.push("settings"), registry: () => seen.push("registry"), failed: () => seen.push("failed") }, factory);
  assert.deepEqual([trees.length, trees[0]!.paths, trees[0]!.options.depth], [1, home, 0], "the folder, not the files: a file not there yet is reported once made");
  assert.deepEqual(["away.yaml", "projects.yaml", "other.yaml", "uploads"].map((f) => trees[0]!.options.ignored!(join(home, f))), [false, false, true, true]);
  assert.equal(trees[0]!.options.ignored!(home), false);
  trees[0]!.emit("all", "change", join(home, "away.yaml"));
  trees[0]!.emit("all", "add", join(home, "projects.yaml"));
  assert.deepEqual(seen, ["touched:away.yaml", "settings", "registry"]);
});

test("Node's watcher after its error: a new one is made, the dead one closed (queue LH, finding 4)", async () => {
  const { factory, natives } = stands();
  const { calls, hooks } = project();
  const w = watchProject("p", dir, hooks, factory, { retryMs: 10 });
  natives[0]!.emit("error", new Error("EPERM"));
  assert.deepEqual(calls.splice(0), ["rebuild", "changed"]);
  assert.equal(natives[0]!.closed, true, "Node closes a watcher's handle at its error: closed here too");
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(natives.length, 2, "watched again");
  natives[1]!.listener("change", join("queues", "Q", "run.yaml"));
  assert.deepEqual(calls.splice(0), ["rebuild", "changed", "watched:change:run.yaml", "changed"], "made again: the model read again whole, then fed by the new one");
  await w.close();
  assert.equal(natives[1]!.closed, true);
});

test("Node's watcher not made at the start: tried again until it is (queue LH, finding 4)", async () => {
  let fails = 2;
  const { factory, natives } = stands();
  const make = factory.native;
  factory.native = (d, l) => { if (fails-- > 0) throw new Error("EMFILE"); return make(d, l); };
  const { calls, hooks } = project();
  const w = watchProject("p", dir, hooks, factory, { retryMs: 10 });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(natives.length, 1, "made at the third try");
  assert.ok(calls.filter((c) => c === "rebuild").length >= 1, "once made, the model is read again: changes before it went unseen");
  await w.close();
  const made = natives.length;
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(natives.length, made, "closed: no more tries");
});

test("NEXUS_HOME's watchers: an error is handled, and a change of the settings or away mode is a change of every project (queue LH, finding 5)", () => {
  const { factory, trees } = stands();
  const seen: string[] = [];
  watchHome(home, {
    touched: (path) => seen.push(`touched:${path.split(/[\\/]/).at(-1)}`),
    settings: () => seen.push("settings"),
    registry: () => seen.push("registry"),
    failed: (err) => seen.push(`failed:${err.message}`),
  }, factory);
  trees[0]!.emit("all", "change", join(home, "turns.jsonl"));
  trees[0]!.emit("all", "change", join(home, "settings.yaml"));
  trees[0]!.emit("error", new Error("overflow"));
  trees[0]!.emit("error", new Error("EPERM"));
  assert.deepEqual(seen, ["touched:turns.jsonl", "touched:settings.yaml", "settings", "failed:overflow", "failed:EPERM"]);
});
