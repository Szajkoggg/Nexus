// The one atomic replace every whole-file writer uses (store.ts, writeFileAtomic): a reader sees the old content or the
// new one, never half; a rename Windows refuses for a moment is tried again; a failed write leaves the target as it was
// and no temporary file behind.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectStore, faultRenames, writeFileAtomic, writeJson, writeYaml } from "../src/store.ts";

const tempDir = () => mkdtempSync(join(tmpdir(), "nexus-atomic-"));

test("creates the folder and writes text, bytes, YAML and JSON whole", () => {
  const dir = tempDir();
  writeFileAtomic(join(dir, "a", "b", "note.md"), "hello\n");
  assert.equal(readFileSync(join(dir, "a", "b", "note.md"), "utf8"), "hello\n");
  writeFileAtomic(join(dir, "pic.png"), new Uint8Array([1, 2, 3]));
  assert.deepEqual([...readFileSync(join(dir, "pic.png"))], [1, 2, 3]);
  writeYaml(join(dir, "x.yaml"), { state: "running" });
  assert.equal(readFileSync(join(dir, "x.yaml"), "utf8"), "state: running\n");
  writeJson(join(dir, "x.json"), { a: 1 });
  assert.equal(readFileSync(join(dir, "x.json"), "utf8"), '{\n  "a": 1\n}\n');
  assert.deepEqual(readdirSync(dir).filter((n) => n.endsWith(".tmp")), []);
});

test("after a passing EPERM the write goes through", () => {
  const dir = tempDir();
  const file = join(dir, "plan.json");
  writeJson(file, { v: "old" });
  const fault = faultRenames({ file: "plan.json", code: "EPERM", times: 2 });
  try {
    writeJson(file, { v: "new" });
    assert.equal(fault.failed(), 2, "refused twice, then renamed");
  } finally { fault.clear(); }
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { v: "new" });
  assert.deepEqual(readdirSync(dir), ["plan.json"]);
});

test("a write that fails leaves the old content and no temporary file", () => {
  const dir = tempDir();
  const file = join(dir, "run.yaml");
  writeYaml(file, { state: "running" });
  const renames = faultRenames({ file: "run.yaml", code: "EIO" }); // not passing: thrown at once
  try { assert.throws(() => writeYaml(file, { state: "finished" }), /EIO/); } finally { renames.clear(); }
  assert.equal(readFileSync(file, "utf8"), "state: running\n");
  const writes = ProjectStore.faultWrites({ file: "run.yaml" }); // the write refused before the rename
  try { assert.throws(() => writeYaml(file, { state: "finished" }), /injected write fault/); } finally { writes.clear(); }
  assert.equal(readFileSync(file, "utf8"), "state: running\n");
  assert.deepEqual(readdirSync(dir), ["run.yaml"]);
  assert.ok(!existsSync(`${file}.${process.pid}.tmp`));
});

test("a reader beside the writes sees the old content or the new one, never half", async () => {
  const dir = tempDir();
  const file = join(dir, "big.txt");
  const versions = ["a", "b", "c", "d"].map((c) => c.repeat(256 * 1024)); // large enough for a write in parts
  writeFileAtomic(file, versions[0]!);
  // Another thread reads the file over and over until told to stop, and reports every content it saw.
  const reader = new Worker(`
    const { parentPort, workerData } = require("node:worker_threads");
    const fs = require("node:fs");
    const seen = new Set(); let stop = false;
    parentPort.on("message", () => { stop = true; });
    const loop = () => {
      for (let i = 0; i < 5; i++) { try { seen.add(fs.readFileSync(workerData, "utf8")); } catch { /* refused for a moment */ } }
      if (stop) parentPort.postMessage([...seen].map((s) => s.length + ":" + s[0] + ":" + new Set(s).size)); else setTimeout(loop, 1);
    };
    parentPort.postMessage("ready"); loop();`, { eval: true, workerData: file });
  const ready = new Promise((resolve) => reader.once("message", resolve));
  const done = new Promise<string[]>((resolve) => reader.on("message", (m) => { if (Array.isArray(m)) resolve(m as string[]); }));
  await ready;
  for (let i = 1; i <= 30; i++) {
    writeFileAtomic(file, versions[i % versions.length]!);
    await new Promise((r) => setImmediate(r));
  }
  reader.postMessage("stop");
  const seen = await done;
  await reader.terminate();
  assert.ok(seen.length > 0, "the reader read the file");
  for (const s of seen) assert.match(s, /^262144:[abcd]:1$/, `whole content of one version, not ${s}`);
});
