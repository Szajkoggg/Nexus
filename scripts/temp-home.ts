// The guard that keeps scripts and tests off the user's real NEXUS_HOME (queue NHG, after the 2026-11-26 incident: a
// seed script run by hand without NEXUS_HOME rewrote the live %APPDATA%\Nexus\projects.yaml, and the live server lost
// its projects). One rule, used by every script that writes NEXUS_HOME's files (requireTempHome) and by the tests'
// servers (apps/server/test/helpers.ts assertTempHome):
// - NEXUS_HOME is set explicitly (without it, nexusHome() is the real one);
// - its resolved path lies inside the system's temporary folder (os.tmpdir());
// - it is not the folder nexusHome() would give without NEXUS_HOME (join(APPDATA ?? homedir()/.config, "Nexus")), even
//   when APPDATA itself points into the temporary folder.
// The server, the CLI and `npm run dev` (scripts/dev.ts) do not use it: they work on the real NEXUS_HOME on purpose.
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const key = (p: string) => resolve(p).replaceAll("\\", "/").toLowerCase().replace(/\/+$/, "");

/** What is wrong with `home` as a script's or a test's NEXUS_HOME under `env`; undefined when it is a temporary one. */
export function tempHomeProblem(home: string | undefined, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!home) return "NEXUS_HOME is not set, so the real one (%APPDATA%\\Nexus) would be written";
  if (!key(home).startsWith(key(tmpdir()) + "/")) return `NEXUS_HOME must lie inside ${tmpdir()}: ${home}`;
  const real = join(env.APPDATA ?? join(homedir(), ".config"), "Nexus");
  if (key(home) === key(real)) return `NEXUS_HOME is the folder Nexus uses without it (${real}): ${home}`;
  return undefined;
}

/** Throws unless `home` is a temporary NEXUS_HOME (tempHomeProblem). */
export function assertTempHome(home: string | undefined, env: NodeJS.ProcessEnv = process.env): void {
  const problem = tempHomeProblem(home, env);
  if (problem) throw new Error(`a test's or a script's ${problem}`);
}

/**
 * Ends this script, before it writes anything, unless this process's NEXUS_HOME is a temporary one: with the reason and
 * what to do on stderr, exit code 2. Call it at the top of a script's body, and again after the script sets NEXUS_HOME.
 */
export function requireTempHome(env: NodeJS.ProcessEnv = process.env): void {
  const problem = tempHomeProblem(env.NEXUS_HOME, env);
  if (!problem) return;
  process.stderr.write(`refused: ${problem}.\n` +
    `This script writes NEXUS_HOME's files (projects.yaml and others). Run it with NEXUS_HOME set to a new folder in ` +
    `${tmpdir()}, or let node scripts/capture.ts run it.\n`);
  process.exit(2);
}
