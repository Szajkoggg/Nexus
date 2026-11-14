// The tests of a change while working on it (decided 2026-11-14, queue TS): only the files given, one after another,
// stopping at the first failing test. The whole suite (npm test) runs at the step's end, as the queue's check.
//
//   npm run test:files -- <test file>... [--pattern TEXT]
//   node scripts/test-files.mjs <test file>... [--pattern TEXT]
//
// Each file runs as `node --test <file>` with the spec reporter. At the first failing test the run is stopped (its
// own process and what it started), the failure is shown and the exit code is 1; when all pass, 0. The environment
// of a Nexus session (NEXUS_HANDOVER, NEXUS_DIR, NEXUS_SESSION) is cleared, as the test helpers expect.
import { spawn, spawnSync } from "node:child_process";
import { parseArgs } from "node:util";

const { values: o, positionals: files } = parseArgs({ allowPositionals: true, options: { pattern: { type: "string" } } });
if (!files.length) { console.error("usage: npm run test:files -- <test file>... [--pattern TEXT]"); process.exit(2); }
const env = { ...process.env };
delete env.NEXUS_HANDOVER; delete env.NEXUS_DIR; delete env.NEXUS_SESSION;

/** Ends a run and everything it started (only this script's own child, by its pid). */
function stop(child) {
  if (child.exitCode !== null) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/T", "/F", "/PID", String(child.pid)], { stdio: "ignore" });
  else try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
}

/** Runs one file; resolves with the first failing test's name, or undefined when all passed. */
const run = (file) => new Promise((resolve) => {
  const args = ["--test", "--test-reporter=spec", ...(o.pattern ? [`--test-name-pattern=${o.pattern}`] : []), file];
  const child = spawn(process.execPath, args, { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32" });
  let failed, buffer = "", code;
  const read = (d) => {
    process.stdout.write(d);
    buffer += d;
    if (failed) return;
    const m = /^\s*✖ (?!failing tests:)(.+?) \(\d/m.exec(buffer);
    if (!m) { buffer = buffer.slice(-2000); return; }
    failed = m[1];
    // A moment for the failure's details to be written, then the rest of the run is not waited for.
    setTimeout(() => stop(child), 500);
  };
  child.stdout.setEncoding("utf8").on("data", read);
  child.stderr.setEncoding("utf8").on("data", read);
  child.on("exit", (c) => { code = c; resolve(failed ?? (code === 0 ? undefined : `${file} (exit code ${code})`)); });
});

const started = Date.now();
for (const file of files) {
  const failed = await run(file);
  if (failed) {
    console.log(`\ntest:files stopped at the first failure: ${failed} (${file}), after ${Math.round((Date.now() - started) / 1000)} s`);
    process.exit(1);
  }
}
console.log(`\ntest:files: ${files.length} file(s) passed in ${Math.round((Date.now() - started) / 1000)} s`);
