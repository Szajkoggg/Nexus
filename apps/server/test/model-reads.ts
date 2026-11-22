// Runs a test file's stores through models of their folders, as the server reads (queues SM and MF;
// docs/design/model.md, "Its reads are read-only"; docs/design/tests.md, "The tests read through the model"). npm test,
// test:times, test:files and the load tool load it before every file:
//   node --import ./apps/server/test/model-reads.ts --test <files>
// Every ProjectStore made without a reader reads through one ProjectModel per folder, and loadProjectState over it is
// the model's state, frozen: a test or code that changes what the model hands out fails in the checks as it would in
// the server. The model is fed by this process's writes and by a watcher of the folder as main.ts's is; and since
// other processes write to the folder (a server an API test started, the fake runtimes' `nexus`) and a test reads at
// once after them, before a watcher could report, each read first looks whether a file, folder or log the model holds
// changed on disk (a stat, no read), as the files would show it. A file that compares the model with the files
// themselves calls `useProjectReaders(undefined)`.
import { existsSync, statSync, watch } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ProjectModel, useProjectReaders, type FileCache } from "@nexus/protocol";

const models = new Map<string, ProjectModel>();
const keyOf = (dir: string) => { const k = resolve(dir).replaceAll("\\", "/"); return process.platform === "win32" ? k.toLowerCase() : k; };

/** What a stat shows of a file or folder: its id, size and time (an atomic replace is another id). */
function stampOf(path: string): string {
  try { const s = statSync(path, { bigint: true }); return `${s.ino}:${s.size}:${s.mtimeNs}`; } catch { return "gone"; }
}

/**
 * Makes the model's cache look before each read whether what it holds changed on disk since it was read: a file or a
 * folder's listing whose stamp moved, a path that came or went, a log that grew. Before the state is read, everything
 * it holds is looked at so, and the state is derived again if any of it changed.
 */
function checkingFiles(cache: FileCache): void {
  const proto = Object.getPrototypeOf(cache) as FileCache;
  const stamps = new Map<string, string>(), probes = new Map<string, boolean>(), logs = new Set<string>();
  const look = (path: string) => {
    const now = stampOf(path), was = stamps.get(path);
    if (was !== undefined && was !== now) cache.touched(path);
    stamps.set(path, now);
  };
  const probe = (path: string) => {
    const now = existsSync(path), was = probes.get(path);
    if (was !== undefined && was !== now) cache.touched(path);
    probes.set(path, now);
  };
  cache.has = (file) => { probe(file); return proto.has.call(cache, file); };
  cache.parsed = <T>(file: string, parse: (text: string) => T): T => { look(file); return proto.parsed.call(cache, file, parse) as T; };
  cache.dirs = (dir) => { look(dir); return proto.dirs.call(cache, dir); };
  cache.names = (dir) => { look(dir); return proto.names.call(cache, dir); };
  cache.jsonl = ((file, schema, o) => { logs.add(file); return proto.jsonl.call(cache, file, schema, o); }) as FileCache["jsonl"];
  // Every log read looks whether its file grew, as a running agent's does in the server.
  cache.live = () => true;
  const state = cache.state!;
  cache.state = () => {
    for (const p of [...stamps.keys()]) look(p);
    for (const p of [...probes.keys()]) probe(p);
    cache.sync([...logs]);
    return state();
  };
}

useProjectReaders((dir) => {
  const key = keyOf(dir);
  let model = models.get(key);
  if (!model) {
    const m = new ProjectModel(dir);
    model = m;
    models.set(key, m);
    checkingFiles(m.cache);
    // As main.ts's watcher of the model reports a project's changes (another process's lines): Node's own recursive
    // watcher, not keeping the test's process alive.
    // A store is made before its folder (ProjectStore.init): then the folder above it is watched (the model takes only
    // what lies under its own).
    const at = existsSync(dir) ? dir : dirname(dir);
    try {
      const w = watch(at, { recursive: true, persistent: false }, (event, name) => {
        if (!name) { m.rebuild(); return; }
        const path = join(at, name);
        if (!path.endsWith(".tmp") && !path.endsWith(".lock")) m.watched(event, path);
      });
      // Closed once its folder is gone (the test removed it): on Windows a watcher of a removed folder can hold the
      // process at its end.
      const gone = setInterval(() => { if (!existsSync(at)) { clearInterval(gone); w.close(); } }, 1000).unref();
      w.on("error", () => { m.rebuild(); clearInterval(gone); w.close(); });
    } catch { /* neither exists: this process's own writes still reach the model */ }
  }
  return model.cache;
});
