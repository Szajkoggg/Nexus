// Atomic writes while another process has the file open (store.ts, renameRetrying). On Windows a rename onto a file
// that another process holds open fails with EPERM until it is closed; the write tries again instead of failing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renameRetrying, writeYaml } from "../src/store.ts";

/**
 * Another process that opens `file` for reading and holds it until `release` exists, then closes it 150 ms later.
 * Resolves once it holds the file; `closed` resolves when it has exited.
 */
async function holdOpen(file: string, release: string) {
  const code = `const fs = require("fs"); const fd = fs.openSync(process.argv[1], "r"); process.stdout.write("open");
    const t = setInterval(() => { if (fs.existsSync(process.argv[2])) { clearInterval(t); setTimeout(() => fs.closeSync(fd), 150); } }, 20);`;
  const p = spawn(process.execPath, ["-e", code, file, release], { stdio: ["ignore", "pipe", "inherit"] });
  await new Promise((r) => p.stdout!.once("data", r));
  return { closed: new Promise<void>((r) => p.on("exit", () => r())) };
}

test("a write goes through while another process reads the file for a moment", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nexus-rename-"));
  const file = join(dir, "run.yaml");
  writeYaml(file, { state: "running" });
  const release = join(dir, "release");
  const { closed } = await holdOpen(file, release); // the reader has it open now, until released
  if (process.platform === "win32") {
    // The condition itself: a plain rename onto the file is refused while the reader has it open.
    writeFileSync(join(dir, "plain.tmp"), "state: plain\n");
    assert.throws(() => renameSync(join(dir, "plain.tmp"), file), /EPERM|EACCES|EBUSY/);
  }
  writeFileSync(release, ""); // the reader closes the file 150 ms (and a poll) after this
  const t = Date.now();
  writeYaml(file, { state: "finished" }); // Windows: EPERM until the reader closes it; tried again meanwhile
  assert.match(readFileSync(file, "utf8"), /state: finished/);
  assert.ok(Date.now() - t < 2_000, "within the retry time");
  await closed;
});

test("other errors are not retried", () => {
  const dir = mkdtempSync(join(tmpdir(), "nexus-rename-"));
  const t = Date.now();
  assert.throws(() => renameRetrying(join(dir, "missing.tmp"), join(dir, "x.yaml")), /ENOENT/);
  assert.ok(Date.now() - t < 500);
  writeFileSync(join(dir, "a.tmp"), "a");
  renameRetrying(join(dir, "a.tmp"), join(dir, "a"));
  assert.equal(readFileSync(join(dir, "a"), "utf8"), "a");
});
