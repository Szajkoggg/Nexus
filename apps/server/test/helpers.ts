// Starting a real server (src/main.ts) from a test. The tests often run inside a Nexus worker session, whose
// environment may carry the live instance's NEXUS_HANDOVER (from before servers removed it): a test server that
// inherited it would take the live predecessor's hand-over folder for its own. So it is always stripped here; a test
// that needs a hand-over passes NEXUS_HANDOVER explicitly in `extra`.
import { spawn, type ChildProcess, type StdioOptions } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { withoutHandover } from "../src/handover.ts";

export const MAIN = join(dirname(fileURLToPath(import.meta.url)), "../src/main.ts");

/** This process's environment without NEXUS_HANDOVER, plus `extra` (applied after the strip). */
export function serverEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...withoutHandover(process.env), ...extra };
}

/** Starts src/main.ts with serverEnv(extra). */
export function spawnServer(extra: Record<string, string> = {}, stdio: StdioOptions = "ignore"): ChildProcess {
  return spawn(process.execPath, [MAIN], { env: serverEnv(extra), stdio, windowsHide: true });
}
