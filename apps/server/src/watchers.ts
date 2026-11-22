// The server's file watchers (moved out of main.ts, queue LH): each project's two watchers of its .nexus folder, and
// the watcher of NEXUS_HOME's files. The watchers themselves come from a factory, so a test can give stand-ins and
// make them report, fail or stay silent without a server.
import { watch as watchFiles, type WatchEventType } from "node:fs";
import { join } from "node:path";
import chokidar from "chokidar";
import { isLogOnly } from "@nexus/protocol";

/** Node's recursive watcher, as the server uses it. */
export interface NativeWatcher {
  on(event: "error", fn: (err: Error) => void): unknown;
  close(): void;
}

/** chokidar's watcher, as the server uses it. */
export interface TreeWatcher {
  on(event: "all", fn: (event: string, path: string) => void): this;
  on(event: "error", fn: (err: unknown) => void): this;
  add(path: string): unknown;
  unwatch(path: string): unknown;
  close(): Promise<void>;
}

export interface TreeOptions { ignoreInitial: boolean; followSymlinks?: boolean; ignored?: (path: string) => boolean }

/** Makes the watchers: by default Node's and chokidar's (realWatch); tests give stand-ins. */
export interface WatchFactory {
  native(dir: string, listener: (event: WatchEventType, name: string | null) => void): NativeWatcher;
  tree(paths: string | string[], options: TreeOptions): TreeWatcher;
}

export const realWatch: WatchFactory = {
  native: (dir, listener) => watchFiles(dir, { recursive: true }, listener),
  tree: (paths, options) => chokidar.watch(paths, options),
};

/** The project's model, as its watchers feed it (ProjectModel). */
interface WatchedModel {
  watched(event: string, path: string): "state" | "log" | undefined;
  touched(path: string): void;
  rebuild(): void;
}

export interface ProjectWatchHooks {
  /** The project's model now (undefined once the project is gone). */
  model(): WatchedModel | undefined;
  /** A file of the project's state changed: its decisions run and its state goes out. */
  changed(): void;
  /** A line of a session's log only. */
  log(path: string): void;
}

/**
 * What a project's watchers leave out: uploaded pictures (a 10 MB write need not reload the project), the server's own
 * clock mark for the CLI (clock.json), temporary and lock files.
 */
const unwatched = (dir: string, p: string): boolean => p.endsWith(".tmp") || p.endsWith(".lock") || /^[\\/](uploads([\\/]|$)|clock\.json$)/.test(p.slice(dir.length));

/**
 * A project's watchers of its .nexus folder. Node's own recursive watcher feeds its model: chokidar drops a share of a
 * file's atomic rewrites on Windows (measured: 7 of 40 rewrites of one file a few tens of ms apart; Node's watcher
 * missed none of 100), and a model that misses one keeps that file's old copy until its next reported change.
 * chokidar's (`tree`) reports too, and is the one the notes folder is added to. `native` is undefined when Node's
 * watcher could not be made.
 */
export function watchProject(id: string, dir: string, hooks: ProjectWatchHooks, factory: WatchFactory = realWatch): { tree: TreeWatcher; native?: NativeWatcher } {
  const reported = (path: string, kind: "state" | "log" | undefined) => {
    if (kind === "log") hooks.log(path);
    else if (kind === "state") hooks.changed();
  };
  // A watcher that failed may have missed a change: the model reads everything again at its next read.
  const failed = (err: Error) => { console.error(`watch ${id}: ${err.message}; its model is read again`); hooks.model()?.rebuild(); hooks.changed(); };
  let native: NativeWatcher | undefined;
  try {
    native = factory.native(dir, (event, name) => {
      const model = hooks.model();
      if (!model) return;
      if (!name) { model.rebuild(); hooks.changed(); return; }
      const path = join(dir, name);
      if (!unwatched(dir, path)) reported(path, model.watched(event, path));
    });
    native.on("error", failed);
  } catch (err) { console.error(`watch ${id}: ${(err as Error).message}`); }
  const tree = factory.tree(dir, { ignoreInitial: true, followSymlinks: false, ignored: (p) => unwatched(dir, p) })
    .on("all", (_event, path) => {
      hooks.model()?.touched(path);
      reported(path, isLogOnly(path) ? "log" : "state");
    })
    .on("error", (err) => failed(err as Error));
  return { tree, native };
}

export interface HomeWatchHooks {
  /** One of NEXUS_HOME's files every project reads changed (settings.yaml, away.yaml, turns.jsonl). */
  touched(path: string): void;
  /** projects.yaml changed. */
  registry(): void;
}

/**
 * NEXUS_HOME's files that every project's state, the statistics and the estimates read, kept in memory (model.ts):
 * this server's writes reach the model as they are made, a change by hand through these watchers.
 */
export function watchHome(home: string, hooks: HomeWatchHooks, factory: WatchFactory = realWatch): TreeWatcher[] {
  return [
    factory.tree(["settings.yaml", "away.yaml", "turns.jsonl"].map((f) => join(home, f)), { ignoreInitial: true }).on("all", (_event, path) => hooks.touched(path)),
    factory.tree(join(home, "projects.yaml"), { ignoreInitial: true }).on("all", () => hooks.registry()),
  ];
}
