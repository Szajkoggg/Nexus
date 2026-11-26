// The guard that keeps scripts off the user's real NEXUS_HOME (scripts/temp-home.ts, queue NHG): its rule, the rule that
// every script writing NEXUS_HOME's files calls it (scripts/temp-home-rule.ts, on a faulty example and on the
// repository's scripts), and a seed script run as a process without, with a simulated real and with a temporary
// NEXUS_HOME. The processes always get a temporary APPDATA and LOCALAPPDATA, so a broken guard writes only there.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startInstance } from "../capture/run.ts";
import { HOME_WRITE_EXCEPTIONS, homeGuardFindings } from "../temp-home-rule.ts";
import { assertTempHome, tempHomeProblem } from "../temp-home.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

/** The scripts the rule covers: scripts/ without its tests and the guard's own files, paths with forward slashes. */
function scripts(): { path: string; text: string }[] {
  const files: { path: string; text: string }[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const path = `${dir}/${e.name}`;
      if (e.isDirectory()) { if (path !== "scripts/test") walk(path); }
      else if (/\.(ts|mjs)$/.test(e.name) && !/^scripts\/temp-home(-rule)?\.ts$/.test(path)) files.push({ path, text: readFileSync(join(ROOT, path), "utf8") });
    }
  };
  walk("scripts");
  return files;
}

test("a temporary NEXUS_HOME is set, lies inside the temporary folder, and is not the folder Nexus uses without it", () => {
  const appdata = join(tmpdir(), "nexus-guard-appdata");
  const env = { APPDATA: appdata };
  assert.match(tempHomeProblem(undefined, env)!, /not set/);
  assert.match(tempHomeProblem("C:/Users/someone/AppData/Roaming/Nexus", env)!, /must lie inside/);
  assert.match(tempHomeProblem(join(appdata, "Nexus"), env)!, /the folder Nexus uses without it/, "a real home simulated in the temporary folder");
  assert.match(tempHomeProblem(join(appdata, "Nexus") + "/", env)!, /the folder Nexus uses without it/);
  assert.equal(tempHomeProblem(join(tmpdir(), "nexus-guard-home"), env), undefined);
  assert.throws(() => assertTempHome(join(appdata, "Nexus"), env), /a test's or a script's NEXUS_HOME is the folder/);
});

test("the rule finds a writing script without the guard, through its imports too, and a guard that comes too late", () => {
  const findings = homeGuardFindings([
    { path: "scripts/capture/seed-a.ts", text: `import { writeRegistry } from "@nexus/protocol";\n// requireTempHome() in a comment is no call\nwriteRegistry({ protocol: 1, projects: [] });\n` },
    { path: "scripts/capture/seed-b.ts", text: `import "./seed-a.ts";\nconsole.log("b");\n` },
    { path: "scripts/capture/seed-c.ts", text: `import { appendTurn } from "@nexus/protocol";\nimport { requireTempHome } from "../temp-home.ts";\nappendTurn(x);\nrequireTempHome();\n` },
    { path: "scripts/d.ts", text: `import { requireTempHome } from "./temp-home.ts";\nrequireTempHome();\nprocess.env.NEXUS_HOME = home;\nwriteRegistry(r);\n` },
    { path: "scripts/e.ts", text: `import { nexusHome } from "@nexus/protocol";\nwriteFileSync(join(nexusHome(), "crash.json"), "{}");\n` },
    { path: "scripts/f.ts", text: `const { writeRegistry } = await import("@nexus/protocol");\nconsole.log("names it, never calls it");\n` },
  ], [{ file: "scripts/gone.ts", call: "appendServerSpeed", why: "x" }]);
  assert.deepEqual(findings, [
    "scripts/capture/seed-a.ts: calls a writer of NEXUS_HOME's files, but does not call requireTempHome() (scripts/temp-home.ts)",
    "scripts/capture/seed-b.ts: imports scripts/capture/seed-a.ts, which writes NEXUS_HOME's files, but does not call requireTempHome() (scripts/temp-home.ts)",
    "scripts/capture/seed-c.ts: writes NEXUS_HOME's files before it calls requireTempHome()",
    "scripts/d.ts: sets NEXUS_HOME and writes without calling requireTempHome() again",
    "scripts/e.ts: calls a writer of NEXUS_HOME's files, but does not call requireTempHome() (scripts/temp-home.ts)",
    "scripts/gone.ts: listed as an exception, but no such script",
  ]);
  const fixed = homeGuardFindings([
    { path: "scripts/s.ts", text: `import { requireTempHome } from "./temp-home.ts";\nconst target = file();\nfunction m() { process.env.NEXUS_HOME = h; requireTempHome(); writeRegistry(r); }\nappendServerSpeed(run, target);\n` },
  ], [{ file: "scripts/s.ts", call: "appendServerSpeed", why: "on purpose" }]);
  assert.deepEqual(fixed, [], "an excepted call needs no guard before it");
  assert.ok(homeGuardFindings([{ path: "scripts/s.ts", text: "writeRegistry(r);" }], [{ file: "scripts/s.ts", call: "appendServerSpeed", why: "x" }])
    .includes("scripts/s.ts: the exception for appendServerSpeed() is listed, but the file no longer calls it: take it off the list"));
});

test("every script that writes NEXUS_HOME's files calls the guard; the one exception is server-speed's result", (t) => {
  const files = scripts();
  assert.ok(files.length > 50, `the scripts were found (${files.length})`);
  assert.deepEqual(homeGuardFindings(files), []);
  assert.deepEqual(HOME_WRITE_EXCEPTIONS.map((e) => `${e.file} ${e.call}`), ["scripts/server-speed.ts appendServerSpeed"]);
  t.diagnostic(`${files.length} scripts checked; exception: ${HOME_WRITE_EXCEPTIONS.map((e) => `${e.file} ${e.call}() (${e.why})`).join("; ")}`);
});

test("the capture tool's instance refuses a NEXUS_HOME that is not a temporary one, before it starts anything", async () => {
  await assert.rejects(startInstance({ root: ROOT, home: "C:/Users/someone/AppData/Roaming/Nexus", port: 4399 }), /must lie inside/);
});

test("a seed script exits without writing unless its NEXUS_HOME is a temporary one", (t) => {
  const base = mkdtempSync(join(tmpdir(), "nexus-guard-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const appdata = join(base, "appdata"), localappdata = join(base, "localappdata");
  const seed = join(ROOT, "scripts/capture/seed-checks.ts");
  const run = (name: string, home: string | undefined) => {
    const env: NodeJS.ProcessEnv = { ...process.env, APPDATA: appdata, LOCALAPPDATA: localappdata };
    for (const k of ["NEXUS_HOME", "NEXUS_DIR", "NEXUS_SESSION", "NEXUS_HANDOVER", "NODE_TEST_CONTEXT"]) delete env[k];
    if (home) env.NEXUS_HOME = home;
    const data = join(base, name);
    const r = spawnSync(process.execPath, [seed, data], { cwd: ROOT, env, encoding: "utf8", windowsHide: true });
    t.diagnostic(`${name}: exit ${r.status}${r.stderr.trim() ? `; ${r.stderr.trim().split("\n")[0]}` : ""}`);
    return { ...r, data };
  };

  const none = run("without", undefined);
  assert.notEqual(none.status, 0);
  assert.match(none.stderr, /refused: NEXUS_HOME is not set/);
  assert.equal(existsSync(join(appdata, "Nexus")), false, "nothing under the (temporary) APPDATA");
  assert.equal(existsSync(none.data), false, "nothing written at all");

  const real = run("real", join(appdata, "Nexus"));
  assert.notEqual(real.status, 0);
  assert.match(real.stderr, /refused: NEXUS_HOME is the folder Nexus uses without it/);
  assert.equal(existsSync(join(appdata, "Nexus")), false);
  assert.equal(existsSync(real.data), false);

  const home = join(base, "home");
  const temp = run("temporary", home);
  assert.equal(temp.status, 0, temp.stderr);
  assert.ok(existsSync(join(home, "projects.yaml")), "the registry is written into the temporary NEXUS_HOME");
  assert.equal(existsSync(join(appdata, "Nexus")), false);
});
