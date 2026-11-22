// The test seam for a server that ends between two writes (ProjectStore.faultWrites, queue LH): the named file's writes
// past the allowed ones throw, leave the file as it was, and leave no temporary file behind.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectStore } from "../src/store.ts";
import { now } from "../src/clock.ts";

test("faultWrites: the named file's writes after the allowed ones throw and change nothing, until cleared", () => {
  const root = mkdtempSync(join(tmpdir(), "nexus-fault-"));
  process.env.NEXUS_HOME = join(root, "home");
  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  const projectFile = join(store.dir, "project.yaml");
  const fault = ProjectStore.faultWrites({ file: "project.yaml", after: 1 });
  try {
    store.writeStoredProject({ ...store.readStoredProject(), name: "First" });
    const before = readFileSync(projectFile, "utf8");
    assert.throws(() => store.writeStoredProject({ ...store.readStoredProject(), name: "Second" }), /injected write fault/);
    assert.throws(() => store.writeStoredProject({ ...store.readStoredProject(), name: "Third" }), /injected write fault/, "every later write too");
    assert.equal(readFileSync(projectFile, "utf8"), before, "the file as the last write that went through left it");
    assert.deepEqual(readdirSync(store.dir).filter((f) => f.endsWith(".tmp")), [], "no temporary file left");
    assert.deepEqual([fault.writes(), fault.failed()], [3, 2]);
    store.appendActivity("S1", { at: now(), kind: "text", text: "another file is not touched by the fault" });
  } finally { fault.clear(); }
  store.writeStoredProject({ ...store.readStoredProject(), name: "Fourth" });
  assert.equal(store.readStoredProject().name, "Fourth", "cleared: writes go through again");

  const log = ProjectStore.faultWrites({ file: "sessions/S1/activity.jsonl", error: "server ended" });
  try {
    assert.throws(() => store.appendActivity("S1", { at: now(), kind: "text", text: "lost" }), /server ended/);
  } finally { log.clear(); }
  const lines = readFileSync(join(store.dir, "sessions", "S1", "activity.jsonl"), "utf8").trim().split("\n");
  assert.equal(lines.length, 1, "the refused append wrote nothing");
  assert.ok(existsSync(projectFile));
});
