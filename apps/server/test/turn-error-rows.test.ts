// A failed turn's error row in both chats, the orchestrator's and a thinking partner's, by one rule (queue CHC, step
// CHC4, D1; src/chats.ts, TurnErrorRows): one error row at the end of a turn that is neither ok nor stopped, its text
// the turn's end's reason; none for a turn that ends ok or stopped, whatever words its texts hold. The four cases run
// against a stand-in process that emits exactly what a runtime adapter emits (the words matter here, and the fakes'
// texts are fixed); the Codex turn/start that is refused runs against the fake Codex (FAKE_CODEX_RPC).
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectStore, type ChatEntry } from "@nexus/protocol";
import { Engine } from "../src/engine.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import { Conversations } from "../src/conversations.ts";
import type { ActivityItem, AgentEvents, AgentProcess } from "../src/agent.ts";
import { QUICK_ENGINE, LONGER, until } from "./wait.ts";
import { inProcessRuntime } from "./in-process-runtime.ts";

/** A stand-in agent process: a send opens a turn; the test emits its activities and ends it. A stop ends it stopped. */
class Stand extends EventEmitter<AgentEvents> implements AgentProcess {
  state: AgentProcess["state"] = "idle";
  readonly pid = 4244;
  send(): void { this.state = "working"; }
  stop(): boolean {
    if (this.state !== "working") return false;
    this.act("turn_end", "turn stopped by the user");
    this.end({ ok: false, stopped: true, text: "stopped" });
    return true;
  }
  close(): void { this.state = "exited"; }
  kill(): void { this.state = "exited"; }
  act(kind: ActivityItem["kind"], text: string): void { this.emit("activity", { kind, text }); }
  end(e: AgentEvents["turnEnd"][0]): void { this.state = "idle"; this.emit("turnEnd", e); }
}

interface Chat {
  /** Opens a turn of the chat's process (a message from the user). */
  turn(text: string): Stand;
  /** The user's Stop of the turn at work. */
  stop(): void;
  chat(): ChatEntry[];
  close(): void;
}

function base(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  process.env.NEXUS_HOME = join(root, "home");
  return ProjectStore.init(root, { id: "p", name: "P", root });
}

function orchestratorChat(): Chat {
  const store = base("nexus-error-rows-o-");
  const stands: Stand[] = [];
  const engine = new Engine(store, () => {}, { spawn: inProcessRuntime(), ...QUICK_ENGINE });
  const orchestrator = new Orchestrator(store, engine, () => {}, {}, { spawn: () => { const p = new Stand(); stands.push(p); return p; } });
  return {
    turn: (text) => { orchestrator.say(text); const s = stands.at(-1)!; assert.equal(s.state, "working", "a turn is open"); return s; },
    stop: () => orchestrator.stop(),
    chat: () => store.readChat(orchestrator.session()!.id).entries,
    close: () => { orchestrator.shutdown(); engine.shutdown(); },
  };
}

function partnerChat(): Chat {
  const store = base("nexus-error-rows-c-");
  const stands: Stand[] = [];
  const engine = new Engine(store, () => {}, { spawn: inProcessRuntime(), ...QUICK_ENGINE });
  const orchestrator = new Orchestrator(store, engine, () => {}, {}, { spawn: inProcessRuntime() });
  const conversations = new Conversations(store, orchestrator, () => {}, { spawn: () => { const p = new Stand(); stands.push(p); return p; } });
  const c = conversations.create({ title: "Rows" });
  return {
    turn: (text) => { conversations.say(c.id, text); const s = stands.at(-1)!; assert.equal(s.state, "working", "a turn is open"); return s; },
    stop: () => conversations.stop(c.id),
    chat: () => store.readChat(c.id).entries,
    close: () => { conversations.shutdown(); orchestrator.shutdown(); engine.shutdown(); },
  };
}

const errorRows = (x: Chat) => x.chat().filter((e) => e.kind === "error").map((e) => e.text);

const CASES: [string, (x: Chat) => void][] = [
  ["a failed turn whose texts hold no \"error\" has one row, the turn's end's reason", (x) => {
    const s = x.turn("first");
    s.act("turn_start", "turn started");
    s.act("turn_end", "turn ended early: the model gave up");
    s.end({ ok: false, stopped: false, text: "the model gave up" });
    assert.deepEqual(errorRows(x), ["turn ended early: the model gave up"]);
  }],
  ["an ok turn whose texts are full of \"error\" (a reply, its end, an error the runtime got past) has none", (x) => {
    const s = x.turn("second");
    s.act("turn_start", "turn started");
    s.emit("message", "No error here: the error count is zero.");
    s.act("error", "error: a request failed, the runtime went on");
    s.act("turn_end", "turn ended (no errors)");
    s.end({ ok: true, stopped: false, text: "No error here: the error count is zero." });
    assert.deepEqual(errorRows(x), []);
  }],
  ["a Stop has none (the chat's own \"Stopped.\" notice is no error row)", (x) => {
    const s = x.turn("third");
    s.act("turn_start", "turn started");
    x.stop();
    assert.equal(s.state, "idle");
    assert.deepEqual(errorRows(x), []);
    assert.ok(x.chat().some((e) => e.from === "nexus" && e.text === "Stopped."));
  }],
  ["an error, then a failed turn with no turn_end (Codex's refused turn/start), has one row, not two", (x) => {
    const s = x.turn("fourth");
    s.act("error", "turn/start: bad request");
    s.end({ ok: false, stopped: false, text: "bad request", failure: { kind: "lasting", code: "turnStartRejected", text: "bad request" } });
    assert.deepEqual(errorRows(x), ["turn failed (lasting, turnStartRejected): bad request"]);
    // Outside a turn, the process's own error (it exited with output on stderr) is shown at once, as before.
    s.act("error", "the process exited: out of memory");
    assert.deepEqual(errorRows(x), ["turn failed (lasting, turnStartRejected): bad request", "the process exited: out of memory"]);
  }],
];

for (const [name, open] of [["the orchestrator's chat", orchestratorChat], ["a thinking partner's chat", partnerChat]] as const) {
  for (const [what, run] of CASES) {
    test(`${name}: ${what}`, () => {
      const x = open();
      try { run(x); } finally { x.close(); }
    });
  }
}

test("the fake Codex's refused turn/start: one error row in each chat", async () => {
  process.env.FAKE_CODEX_RPC = JSON.stringify({ "turn/start": [{ error: { code: -32000, message: "the input is too long" } }] });
  const root = mkdtempSync(join(tmpdir(), "nexus-error-rows-codex-"));
  process.env.NEXUS_HOME = join(root, "home");
  const store = ProjectStore.init(root, { id: "p", name: "P", root, orchestrator: { runtime: "codex", notify: false } });
  store.updateProject((p) => ({ ...p, conversations: { ...p.conversations, runtime: "codex" } }));
  const engine = new Engine(store, () => {}, { spawn: inProcessRuntime(), ...QUICK_ENGINE });
  const orchestrator = new Orchestrator(store, engine, () => {}, {}, { spawn: inProcessRuntime() });
  const conversations = new Conversations(store, orchestrator, () => {}, { spawn: inProcessRuntime() });
  try {
    const rows = (id: string) => store.readChat(id).entries.filter((e) => e.kind === "error").map((e) => e.text);
    orchestrator.say("Hello");
    await until("the orchestrator's error row", () => !!orchestrator.session() && rows(orchestrator.session()!.id).length > 0, LONGER.step);
    const c = conversations.create({ title: "Codex" });
    conversations.say(c.id, "Hello");
    await until("the partner's error row", () => rows(c.id).length > 0, LONGER.step);
    await new Promise((r) => setTimeout(r, 300));
    for (const id of [orchestrator.session()!.id, c.id]) {
      assert.deepEqual(rows(id), ["turn failed (lasting, turnStartRejected): turn/start: the input is too long"], "one row, the turn's reason");
    }
  } finally {
    delete process.env.FAKE_CODEX_RPC;
    conversations.shutdown(); orchestrator.shutdown(); engine.shutdown();
    await until("owned runtimes to exit", () => !conversations.alive() && !orchestrator.alive() && !engine.alive(), LONGER.processes);
  }
});
