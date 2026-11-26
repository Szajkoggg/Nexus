// The tests' own global folders (apps/server/test/temp-home.ts, loaded first by model-reads.ts; queue NHG): a test that
// sets no NEXUS_HOME resolves nexusHome() and its fallback into the system's temporary folder, two test files run at
// once get folders of their own, a folder already temporary is kept, a session's NEXUS_DIR and NEXUS_SESSION are
// removed, and the folders are gone when the files' processes end. The runs get a made-up APPDATA, LOCALAPPDATA and
// NEXUS_DIR outside the temporary folder that nothing creates: the test files write nothing there.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { nexusHome } from "@nexus/protocol";

const MODEL_READS = new URL("./model-reads.ts", import.meta.url).href;
const PROTOCOL = pathToFileURL(resolve(import.meta.dirname, "../../../packages/protocol/src/index.ts")).href;
const key = (p: string) => resolve(p).replaceAll("\\", "/").toLowerCase();
const inTemp = (p: string | undefined) => !!p && key(p).startsWith(key(tmpdir()) + "/");

interface Seen { pid: number; NEXUS_HOME?: string; APPDATA?: string; LOCALAPPDATA?: string; NEXUS_JOB_CACHE?: string; NEXUS_DIR?: string; NEXUS_SESSION?: string; home: string; fallback: string }

test("a test that sets no NEXUS_HOME resolves it, and the fallback without it, into the temporary folder", () => {
  const env = process.env;
  assert.ok(inTemp(env.NEXUS_HOME), `NEXUS_HOME ${env.NEXUS_HOME}`);
  assert.ok(inTemp(env.APPDATA), `APPDATA ${env.APPDATA}`);
  assert.ok(inTemp(env.LOCALAPPDATA), `LOCALAPPDATA ${env.LOCALAPPDATA}`);
  assert.ok(inTemp(nexusHome()));
  const without = { ...env };
  delete without.NEXUS_HOME;
  assert.ok(inTemp(nexusHome(without)), `the fallback ${nexusHome(without)}`);
  assert.notEqual(key(nexusHome()), key(nexusHome(without)), "NEXUS_HOME is not the place Nexus uses without it");
  assert.equal(key(env.NEXUS_JOB_CACHE!), key(join(tmpdir(), "nexus-job-host")), "the job host's cache: one shared folder of the tests");
});

/** Runs the files under `node --import model-reads.ts --test` with `env`; what each saw, by pid. */
function runFiles(dir: string, env: NodeJS.ProcessEnv, n: number): Seen[] {
  const out = join(dir, "seen");
  const files = Array.from({ length: n }, (_, i) => {
    const f = join(dir, `f${i}.test.ts`);
    writeFileSync(f, `import { test } from "node:test";\nimport { writeFileSync, mkdirSync } from "node:fs";\nimport { join } from "node:path";\n` +
      `import { nexusHome } from ${JSON.stringify(PROTOCOL)};\n` +
      `test("sees", () => { const e = process.env; const without = { ...e }; delete without.NEXUS_HOME; mkdirSync(${JSON.stringify(out)}, { recursive: true });\n` +
      `  writeFileSync(join(${JSON.stringify(out)}, String(process.pid)), JSON.stringify({ pid: process.pid, NEXUS_HOME: e.NEXUS_HOME, APPDATA: e.APPDATA, LOCALAPPDATA: e.LOCALAPPDATA, NEXUS_JOB_CACHE: e.NEXUS_JOB_CACHE, NEXUS_DIR: e.NEXUS_DIR, NEXUS_SESSION: e.NEXUS_SESSION, home: nexusHome(), fallback: nexusHome(without) })); });\n`);
    return f;
  });
  const r = spawnSync(process.execPath, ["--import", MODEL_READS, "--test", "--test-concurrency=" + n, ...files], { env, encoding: "utf8", windowsHide: true });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  return readdirSync(out).map((p) => JSON.parse(readFileSync(join(out, p), "utf8")) as Seen);
}

/** A clean environment for a run: no NEXUS_* or test context of this process's. */
function baseEnv(over: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("NEXUS_") && k !== "NODE_TEST_CONTEXT"));
  return { ...env, ...over };
}

test("two test files at once get folders of their own, a session's project is removed, and the folders go with the processes", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "nexus-temp-home-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // Made-up places outside the temporary folder, as a worker's shell has them: nothing creates or writes them.
  const outside = resolve(tmpdir(), "..", "nexus-nhg-not-there");
  const seen = runFiles(dir, baseEnv({ APPDATA: join(outside, "Roaming"), LOCALAPPDATA: join(outside, "Local"), NEXUS_DIR: join(outside, ".nexus"), NEXUS_SESSION: "real-session" }), 2);
  assert.equal(seen.length, 2);
  for (const s of seen) {
    for (const v of [s.NEXUS_HOME, s.APPDATA, s.LOCALAPPDATA, s.home, s.fallback]) assert.ok(inTemp(v), `${v} in the temporary folder`);
    assert.equal(s.NEXUS_DIR, undefined, "the session's project is removed");
    assert.equal(s.NEXUS_SESSION, undefined);
    assert.equal(key(s.NEXUS_JOB_CACHE!), key(join(tmpdir(), "nexus-job-host")));
    assert.notEqual(key(s.home), key(s.fallback));
  }
  assert.notEqual(key(seen[0]!.NEXUS_HOME!), key(seen[1]!.NEXUS_HOME!), "each file its own NEXUS_HOME");
  assert.notEqual(key(seen[0]!.APPDATA!), key(seen[1]!.APPDATA!), "and its own APPDATA");
  for (const s of seen) assert.equal(existsSync(resolve(s.NEXUS_HOME!, "..")), false, `${resolve(s.NEXUS_HOME!, "..")} removed when its process ended`);
  assert.equal(existsSync(outside), false, "nothing outside the temporary folder");
  t.diagnostic(`file folders: ${seen.map((s) => resolve(s.NEXUS_HOME!, "..")).join(", ")}`);
});

test("folders that are already temporary are kept: a test's own server or a nested run uses the test's", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "nexus-temp-home-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const given = { NEXUS_HOME: join(dir, "home"), APPDATA: join(dir, "appdata"), LOCALAPPDATA: join(dir, "local"), NEXUS_DIR: join(dir, "p", ".nexus"), NEXUS_SESSION: "s1", NEXUS_JOB_CACHE: join(dir, "jobs") };
  const [s] = runFiles(dir, baseEnv(given), 1);
  for (const k of ["NEXUS_HOME", "APPDATA", "LOCALAPPDATA", "NEXUS_DIR", "NEXUS_SESSION", "NEXUS_JOB_CACHE"] as const) assert.equal(s![k], given[k], k);
  const real = runFiles(dir, baseEnv({ ...given, NEXUS_HOME: join(dir, "appdata", "Nexus") }), 1)
    .find((x) => x.pid !== s!.pid)!;
  assert.notEqual(key(real.NEXUS_HOME!), key(join(dir, "appdata", "Nexus")), "a NEXUS_HOME that is the place Nexus uses without it is replaced");
  assert.ok(inTemp(real.NEXUS_HOME));
});
