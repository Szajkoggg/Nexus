// The kind of a user's pause in run.yaml (`pause`, queue CHC, step CHC3) against the fake runtimes: the orchestrator's
// notice of a requested pause goes by it, not by the reason's text: a reworded reason is told, a stop and a rejection
// are not, whatever their reason says; a run.yaml from before the field keeps today's reading of the text. And a
// thinking partner's stopped turn is told by the turn's end's `stopped`, not by its text. (The engine's own Pause, Stop
// now, restart and update: orchestrator.test.ts, "a requested pause reached is told once".)
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectStore, applyDraft, approveQueue, loadProjectState, newId, now, type RunFile } from "@nexus/protocol";
import { Engine } from "../src/engine.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import { Conversations } from "../src/conversations.ts";
import type { AgentEvents, AgentProcess } from "../src/agent.ts";
import { QUICK_ENGINE, WAIT_MS, until } from "./wait.ts";
import { inProcessRuntime } from "./in-process-runtime.ts";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "nexus-pause-kind-"));
  process.env.NEXUS_HOME = join(root, "home");
  delete process.env.FAKE_LOG;
  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  const engine = new Engine(store, () => {}, { spawn: inProcessRuntime(), ...QUICK_ENGINE });
  const orchestrator = new Orchestrator(store, engine, () => tick(), {}, { spawn: inProcessRuntime() });
  function tick() { orchestrator.onChange(loadProjectState(store)); }
  const timer = setInterval(tick, 100);
  const stop = () => { clearInterval(timer); orchestrator.shutdown(); engine.shutdown(); };
  const facts = () => orchestrator.view().chat.filter((c) => c.from === "nexus").map((c) => c.text).filter((t) => t.startsWith("Run of"));
  return { store, orchestrator, stop, facts };
}

test("a requested pause is told by run.yaml's pause, a reworded reason too; a stop and a rejection are not; an old run.yaml reads its reason as before", async () => {
  const x = setup();
  try {
    x.orchestrator.say("Hello");
    await until("the orchestrator's first turn", () => x.orchestrator.view().chat.some((c) => c.from === "orchestrator") && x.orchestrator.view().state === "idle", WAIT_MS);
    const paused = (id: string, reason: string, pause?: RunFile["pause"]) => {
      applyDraft(x.store, { id, title: id, steps: [{ id: `${id}1`, title: "One", goal: "FAKE: done", acceptance: ["Done"] }, { id: `${id}2`, title: "Two", goal: "FAKE: done", acceptance: ["Done"] }] });
      approveQueue(x.store, id);
      const at = now();
      x.store.writeRun(id, { protocol: 1, session: newId(), state: "paused", step: `${id}1`, reason, ...(pause ? { pause } : {}), started_at: at, updated_at: at, ended_at: at });
    };
    paused("A", "Paused at the user's request", "pause");            // reworded: told
    paused("B", "paused by the user, then stopped", "stop");         // a stop, whatever its reason says: not told
    paused("C", "paused by the user: step C1 was rejected", "reject"); // a rejection: not told
    paused("D", "paused by the user");                               // before the field: its text tells, as before
    paused("E", "stopped by the user");                              // before the field: a stop, as before
    await until("the requested pauses told", () => x.facts().length >= 2, WAIT_MS);
    await new Promise((r) => setTimeout(r, 700)); // several ticks: anything else would show by now
    assert.deepEqual(x.facts().sort(), ["Run of A paused after step A1.", "Run of D paused after step D1."]);
  } finally { x.stop(); }
});

test("a thinking partner's hand-over stopped by Nexus hands nothing over, by the turn's end's stopped, whatever its text", async () => {
  const root = mkdtempSync(join(tmpdir(), "nexus-pause-kind-chat-"));
  process.env.NEXUS_HOME = join(root, "home");
  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  /** A stand-in partner process: the test says what it replies and when its turn ends; a stop ends it as stopped. */
  class Stand extends EventEmitter<AgentEvents> implements AgentProcess {
    state: AgentProcess["state"] = "idle";
    readonly pid = 4243;
    send(): void { this.state = "working"; }
    stop(): boolean {
      if (this.state !== "working") return false;
      this.state = "idle";
      this.emit("turnEnd", { ok: false, stopped: true, text: "interrupted" });
      return true;
    }
    close(): void { this.state = "exited"; }
    kill(): void { this.state = "exited"; }
  }
  const stands: Stand[] = [];
  const engine = new Engine(store, () => {}, { spawn: inProcessRuntime(), ...QUICK_ENGINE });
  const orchestrator = new Orchestrator(store, engine, () => {}, {}, { spawn: inProcessRuntime() });
  const conversations = new Conversations(store, orchestrator, () => {}, { spawn: () => { const p = new Stand(); stands.push(p); return p; } });
  try {
    const c = conversations.create({ title: "Stopped hand-over" });
    conversations.handoff(c.id);
    const stand = stands[0]!;
    assert.equal(stand.state, "working");
    stand.emit("message", "A summary cut short");
    conversations.stop(c.id);
    const chat = store.readChat(c.id).entries;
    assert.ok(!chat.some((m) => m.from === "partner" && m.text === "A summary cut short"), "no summary in the partner's chat");
    assert.ok(!chat.some((m) => /went to the orchestrator/.test(m.text)), "nothing handed over");
    assert.equal(orchestrator.session(), undefined, "the orchestrator was not started for it");
    assert.ok(chat.some((m) => m.from === "nexus" && m.text === "Stopped."), "the Stop is in the chat, as before");
    assert.ok(!chat.some((m) => m.kind === "error"), "and no error row");
  } finally { conversations.shutdown(); orchestrator.shutdown(); engine.shutdown(); }
});
