// Every test file's process gets global folders of its own (queue NHG): NEXUS_HOME, APPDATA and LOCALAPPDATA in a new
// folder in the system's temporary folder, removed when the process ends. Loaded first by model-reads.ts, which npm
// test, test:times, test:files, the load tool, crash-server.ts and server-speed.ts's test load put before every file
// (`node --import`): an ESM module's imports run before its body, so the environment is set here, in a module of its
// own, before anything else of the test is loaded.
//
// Without it a test that sets no NEXUS_HOME would use the real one: the checks Nexus runs start `npm test` without
// NEXUS_HOME (apps/server/src/check-runs.ts), so nexusHome() is then the live server's %APPDATA%\Nexus.
// - A value that is already a temporary one is kept: a test's own server or crash-server.ts process (started with the
//   test's folders), or a nested run. The test runner's own process (node --test, which loads this too) sets nothing:
//   its files must not share one folder through it.
// - NEXUS_HOME is never join(APPDATA, "Nexus"): the guard's rule (scripts/temp-home.ts) refuses that as the real place.
// - NEXUS_DIR, NEXUS_SESSION and NEXUS_HANDOVER of a Nexus session (a worker running npm test by hand) are removed
//   unless they point into the temporary folder, so a CLI call that does not name its project cannot reach the real one.
// - The Windows job host's compiled type stays shared between the tests, in one folder of the temporary folder
//   (NEXUS_JOB_CACHE; decided by the user, queue NHG1): one compile per machine, never the user's LOCALAPPDATA.
// - USERPROFILE and HOME stay: git reads its configuration there. The homedir() fallback of nexusHome() applies only
//   without APPDATA, which is always set here.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { tempHomeProblem } from "../../../scripts/temp-home.ts";

const key = (p: string) => resolve(p).replaceAll("\\", "/").toLowerCase().replace(/\/+$/, "");
const inTemp = (p: string | undefined) => !!p && key(p).startsWith(key(tmpdir()) + "/");

/** The test runner's own process: `node --test` without a test context (its files run in processes of their own). */
const runner = process.execArgv.includes("--test") && !process.env.NODE_TEST_CONTEXT;

if (!runner) {
  const env = process.env;
  let base: string | undefined;
  const folder = (name: string) => join(base ??= mkdtempSync(join(tmpdir(), "nexus-test-env-")), name);
  if (!inTemp(env.APPDATA)) env.APPDATA = folder("appdata");
  if (!inTemp(env.LOCALAPPDATA)) env.LOCALAPPDATA = folder("localappdata");
  if (tempHomeProblem(env.NEXUS_HOME, env)) env.NEXUS_HOME = folder("home");
  env.NEXUS_JOB_CACHE ??= join(tmpdir(), "nexus-job-host");
  if (!inTemp(env.NEXUS_DIR)) { delete env.NEXUS_DIR; delete env.NEXUS_SESSION; }
  if (env.NEXUS_HANDOVER && !inTemp(env.NEXUS_HANDOVER)) delete env.NEXUS_HANDOVER;
  if (base) {
    const made = base;
    process.on("exit", () => { try { rmSync(made, { recursive: true, force: true, maxRetries: 3 }); } catch { /* a child still holds a file: the system's temporary folder keeps it */ } });
  }
}
