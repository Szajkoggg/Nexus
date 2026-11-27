// The orchestrator's idea hand-off (enqueueIdea) beside an unreadable session.yaml (queue CHC, step CHC2): another
// session's broken file does not fail the hand-off, and an unreadable session's inbox is searched for the idea too,
// so that a retry does not queue it twice. No runtime is started (enqueueIdea only writes the inbox and the chat).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectStore, type SessionFile } from "@nexus/protocol";
import { Orchestrator } from "../src/orchestrator.ts";
import { Engine } from "../src/engine.ts";
import { QUICK_ENGINE, until, LONGER } from "./wait.ts";
import { inProcessRuntime } from "./in-process-runtime.ts";

const GARBAGE = "{ this is: [not yaml\n";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "nexus-enqueue-idea-"));
  process.env.NEXUS_HOME = join(root, "home");
  const store = ProjectStore.init(root, { id: "p", name: "P", root, orchestrator: { runtime: "claude", notify: false } });
  const engine = new Engine(store, () => {}, { spawn: inProcessRuntime(), ...QUICK_ENGINE });
  const orchestrator = new Orchestrator(store, engine, () => {}, {}, { spawn: inProcessRuntime() });
  const session = (id: string, role: SessionFile["role"]) =>
    store.writeSession({ protocol: 1, id, project: "p", role, runtime: "claude", cwd: root, launched_by: "nexus", created_at: new Date().toISOString() });
  const spoil = (id: string) => writeFileSync(join(store.sessionDir(id), "session.yaml"), GARBAGE);
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...a: unknown[]) => { warnings.push(a.map(String).join(" ")); };
  const stop = async () => {
    console.warn = original;
    orchestrator.shutdown(); engine.shutdown();
    await until("owned runtimes to exit", () => !orchestrator.alive() && !engine.alive(), LONGER.processes);
    rmSync(root, { recursive: true, force: true });
  };
  return { store, orchestrator, session, spoil, warnings, stop };
}

test("another session's unreadable session.yaml does not fail the hand-off; it is warned of with its path", async () => {
  const f = setup();
  try {
    f.session("broken", "worker");
    f.spoil("broken");
    const d = f.orchestrator.enqueueIdea("one", "The idea.");
    assert.notEqual(d.session, "broken");
    assert.equal(f.store.readInbox(d.session).entries.filter((e) => e.id === "idea-one").length, 1);
    assert.ok(f.warnings.some((w) => w.includes("session.yaml cannot be read") && w.includes("/sessions/broken/")), f.warnings.join("\n"));
  } finally { await f.stop(); }
});

test("an idea already in an unreadable session's inbox is found there, not queued a second time", async () => {
  const f = setup();
  try {
    f.session("old", "orchestrator");
    f.store.appendInbox("old", { v: 1, id: "idea-two", at: new Date().toISOString(), from: "user", type: "message", text: "The idea." });
    f.spoil("old");
    const d = f.orchestrator.enqueueIdea("two", "The idea.");
    assert.equal(d.session, "old");
    const everywhere = f.store.sessionIds().flatMap((s) => f.store.readInbox(s).entries.filter((e) => e.id === "idea-two"));
    assert.equal(everywhere.length, 1, "queued once");
    // Another payload under the same identity is refused, as for a readable session.
    assert.throws(() => f.orchestrator.enqueueIdea("two", "Another idea."), /another payload/);
  } finally { await f.stop(); }
});
