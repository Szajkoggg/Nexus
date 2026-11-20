// Runs a test file's stores through models of their folders, as the server reads (queue SM; docs/design/model.md):
//   node --import ./apps/server/test/model-reads.ts --test <files>
// Every ProjectStore made without a reader reads through one ProjectModel per folder, fed by this process's writes and
// by a watcher of the folder as main.ts's is (another process's lines: the fake runtimes' `nexus`), and loadProjectState
// over it is the model's state. The fake runtimes' tests of the engine, the merger and the orchestrator passing this
// way and over the files is the evidence that the decisions read the same through the model.
import { existsSync, watch } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ProjectModel, useProjectReaders } from "@nexus/protocol";

const models = new Map<string, ProjectModel>();
const keyOf = (dir: string) => { const k = resolve(dir).replaceAll("\\", "/"); return process.platform === "win32" ? k.toLowerCase() : k; };

useProjectReaders((dir) => {
  const key = keyOf(dir);
  let model = models.get(key);
  if (!model) {
    const m = new ProjectModel(dir);
    model = m;
    models.set(key, m);
    // As main.ts's watcher reports a project's changes (another process's lines), here with Node's own recursive
    // watcher: it never keeps the test's process alive, as chokidar's may.
    // A store is made before its folder (ProjectStore.init): then the folder above it is watched (the model takes only
    // what lies under its own).
    const at = existsSync(dir) ? dir : dirname(dir);
    try {
      const w = watch(at, { recursive: true, persistent: false }, (_event, name) => { if (name) m.touched(join(at, name)); else m.rebuild(); });
      // Closed once its folder is gone (the test removed it): on Windows a watcher of a removed folder can hold the
      // process at its end.
      const gone = setInterval(() => { if (!existsSync(at)) { clearInterval(gone); w.close(); } }, 1000).unref();
      w.on("error", () => { m.rebuild(); clearInterval(gone); w.close(); });
    } catch { /* neither exists: this process's own writes still reach the model */ }
  }
  return model.cache;
});
