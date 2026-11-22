// The server's file watchers (moved out of main.ts, queue LH): each project's two watchers of its .nexus folder, and
// the watcher of NEXUS_HOME's files. The watchers themselves come from a factory, so a test can give stand-ins and
// make them report, fail or stay silent without a server.
import { mkdirSync, watch as watchFiles, type WatchEventType } from "node:fs";
import { basename, join, resolve } from "node:path";
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

export interface TreeOptions { ignoreInitial: boolean; followSymlinks?: boolean; depth?: number; ignored?: (path: string) => boolean }

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

/** How long after Node's watcher failed (or could not be made) a new one is made. */
const REWATCH_MS = 1_000;

/** A project's watchers: chokidar's, and Node's as it stands now (it is made again after an error). */
export interface ProjectWatch {
  tree: TreeWatcher;
  native(): NativeWatcher | undefined;
  /** Closes Node's watcher and stops making new ones (chokidar's is closed by its owner). */
  close(): void;
}

/**
 * A project's watchers of its .nexus folder. Node's own recursive watcher feeds its model: chokidar drops a share of a
 * file's atomic rewrites on Windows (measured: 7 of 40 rewrites of one file a few tens of ms apart; Node's watcher
 * missed none of 100), and a model that misses one keeps that file's old copy until its next reported change.
 * chokidar's (`tree`) reports too, and is the one the notes folder is added to.
 *
 * Node closes a watcher's handle when it emits `error`: the model is read again whole (it may have missed a change) and
 * a new watcher is made `retryMs` later (queue LH), and again while making it fails, also at the start; once made
 * after a failure, the model is read again whole too.
 */
export function watchProject(id: string, dir: string, hooks: ProjectWatchHooks, factory: WatchFactory = realWatch, o: { retryMs?: number } = {}): ProjectWatch {
  const retryMs = o.retryMs ?? REWATCH_MS;
  const reported = (path: string, kind: "state" | "log" | undefined) => {
    if (kind === "log") hooks.log(path);
    else if (kind === "state") hooks.changed();
  };
  // A watcher that failed may have missed a change: the model reads everything again at its next read.
  const failed = (err: Error) => { console.error(`watch ${id}: ${err.message}; its model is read again`); hooks.model()?.rebuild(); hooks.changed(); };
  let native: NativeWatcher | undefined;
  let timer: NodeJS.Timeout | undefined;
  let closed = false;
  const again = () => {
    if (closed || timer) return;
    timer = setTimeout(() => { timer = undefined; watchNative(true); }, retryMs);
    timer.unref?.();
  };
  const watchNative = (after: boolean) => {
    if (closed) return;
    try {
      const w = factory.native(dir, (event, name) => {
        const model = hooks.model();
        if (!model || native !== w) return;
        if (!name) { model.rebuild(); hooks.changed(); return; }
        const path = join(dir, name);
        if (!unwatched(dir, path)) reported(path, model.watched(event, path));
      });
      native = w;
      w.on("error", (err) => {
        if (native !== w) return;
        native = undefined;
        try { w.close(); } catch { /* closed already */ }
        failed(err);
        again();
      });
      if (after) { console.error(`watch ${id}: watched again; its model is read again`); hooks.model()?.rebuild(); hooks.changed(); }
    } catch (err) {
      console.error(`watch ${id}: ${(err as Error).message}; tried again in ${retryMs} ms`);
      again();
    }
  };
  watchNative(false);
  const tree = factory.tree(dir, { ignoreInitial: true, followSymlinks: false, ignored: (p) => unwatched(dir, p) })
    .on("all", (_event, path) => {
      hooks.model()?.touched(path);
      reported(path, isLogOnly(path) ? "log" : "state");
    })
    .on("error", (err) => failed(err as Error));
  return {
    tree,
    native: () => native,
    close: () => { closed = true; clearTimeout(timer); timer = undefined; native?.close(); native = undefined; },
  };
}

export interface HomeWatchHooks {
  /** One of NEXUS_HOME's files every project reads changed (settings.yaml, away.yaml, turns.jsonl). */
  touched(path: string): void;
  /** settings.yaml or away.yaml changed: every project's state, and its decisions, may change (queue LH). */
  settings(): void;
  /** projects.yaml changed. */
  registry(): void;
  /** A watcher failed: it may have missed a change (queue LH). */
  failed(err: Error): void;
}

/** NEXUS_HOME's files the server keeps watching, by name. */
const HOME_FILES = ["settings.yaml", "away.yaml", "turns.jsonl", "projects.yaml"];

/**
 * NEXUS_HOME's files that every project's state, the statistics and the estimates read, kept in memory (model.ts):
 * this server's writes reach the model as they are made, a change by hand through this watcher. The folder is watched,
 * not the files by name: chokidar reports nothing of a file named to it that did not exist yet (away.yaml before away
 * mode was first turned on, queue LH).
 */
export function watchHome(home: string, hooks: HomeWatchHooks, factory: WatchFactory = realWatch): TreeWatcher {
  mkdirSync(home, { recursive: true });
  const named = (p: string) => HOME_FILES.find((f) => p.length > home.length && basename(p) === f);
  return factory.tree(home, { ignoreInitial: true, depth: 0, ignored: (p) => resolve(p) !== resolve(home) && !named(p) })
    .on("all", (_event, path) => {
      const name = named(path);
      if (name === "projects.yaml") return hooks.registry();
      if (!name) return;
      hooks.touched(path);
      if (name !== "turns.jsonl") hooks.settings();
    })
    .on("error", (err) => hooks.failed(err instanceof Error ? err : new Error(String(err))));
}
