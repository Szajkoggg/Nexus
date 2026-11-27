// AgentHost with a stand-in process: what it keeps for each role (the runtime record, the runtime's own session id,
// the usage windows) and how it ends a process. The real runtimes against the fakes: runtime-records.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectStore, newId, now, readUsage, type SessionFile } from "@nexus/protocol";
import type { AgentEvents, AgentProcess } from "../src/agent.ts";
import { AgentHost, ROLE_RECORDS, type Launch, type RoleRecord } from "../src/agent-host.ts";

class Stand extends EventEmitter<AgentEvents> implements AgentProcess {
  state: "working" | "idle" | "exited" = "idle";
  /** AgentProcess.settling: the test sets it (queue LH). */
  settling = false;
  readonly pid = 4242;
  calls: string[] = [];
  readonly launch: Launch;
  constructor(launch: Launch) { super(); this.launch = launch; }
  send(): void { this.calls.push("send"); this.state = "working"; }
  stop(): boolean { this.calls.push("stop"); return true; }
  close(): void { this.calls.push("close"); }
  kill(): void { this.calls.push("kill"); this.exit(null); }
  exit(code: number | null): void { if (this.state === "exited") return; this.state = "exited"; this.emit("exit", code); }
  turn(): void { this.state = "idle"; this.emit("turnEnd", { ok: true, stopped: false, text: "" }); }
}

function setup(record: RoleRecord, runtime: "claude" | "codex" = "claude") {
  const root = mkdtempSync(join(tmpdir(), "nexus-host-"));
  process.env.NEXUS_HOME = join(root, "home");
  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  const s: SessionFile = { protocol: 1, id: newId(), project: "p", role: "conversation", runtime, title: "S", native_id: runtime === "claude" ? "uuid-1" : null, cwd: root, launched_by: "nexus", created_at: now() };
  store.writeSession(s);
  const spawned: Stand[] = [];
  const host = new AgentHost<{ note?: string }>(store, record, { spawn: (l) => { const p = new Stand(l); spawned.push(p); return p; } });
  const events: string[] = [];
  const start = () => host.start(s, (resume) => ({ runtime: "claude", options: { cwd: root, uuid: "uuid-1", resume, permissionMode: "dontAsk", allowedTools: [], env: host.env(s.id) } }), {}, () => ({
    turnEnd: () => events.push(`turnEnd:${store.readRuntime(s.id)?.state}`),
    exit: (code, byNexus) => events.push(`exit:${code}:${byNexus}:${store.readRuntime(s.id)?.state}`),
  }));
  return { store, s, host, spawned, events, start, proc: () => spawned.at(-1)! };
}

for (const [role, record] of Object.entries(ROLE_RECORDS)) {
  test(`${role}: the facts go into the runtime record as the role kept them`, () => {
    const { store, s, start, proc } = setup(record);
    start();
    assert.deepEqual({ ...store.readRuntime(s.id), updated_at: undefined }, { state: "idle", pid: 4242, turns: 0, conversation_saved: false, updated_at: undefined }, "a fresh Claude session: nothing saved yet");
    proc().send();
    proc().emit("facts", { model: "m" });
    assert.equal(store.readRuntime(s.id)?.state, record.workingFromModel ? "working" : "idle", "a turn's start marks the record working for workers only");
    proc().emit("facts", { contextTokens: 50 });
    assert.equal(store.readRuntime(s.id)?.state, "working");
    proc().emit("facts", { contextWindow: 1000, costUsd: 0.5 });
    assert.equal(store.readRuntime(s.id)?.cost_usd, record.cost ? 0.5 : undefined);
    proc().turn();
    proc().send();
    proc().turn();
    const r = store.readRuntime(s.id)!;
    assert.equal(r.turns, record.countTurns ? 2 : 0);
    assert.deepEqual([r.state, r.model, r.context_tokens, r.context_window], ["idle", "m", 50, 1000]);
  });

  test(`${role}: the usage windows reach usage.json (every session counts)`, () => {
    const { start, proc } = setup(record);
    start();
    proc().emit("facts", { usage: { five_hour: { utilization: 40, resets_at: "2026-11-14T12:00:00.000Z" } } });
    proc().emit("facts", { usage: { seven_day: { utilization: 10 } } });
    assert.deepEqual(readUsage()?.windows, { five_hour: { utilization: 40, resets_at: "2026-11-14T12:00:00.000Z" }, seven_day: { utilization: 10 } });
  });
}

test("the runtime's own session id is recorded once it is known (Codex)", () => {
  const { store, s, start, proc } = setup(ROLE_RECORDS.conversation, "codex");
  start();
  proc().emit("facts", { nativeId: "thread-7" });
  assert.equal(store.readSession(s.id).native_id, "thread-7");
});

test("a session that ran before is resumed; the role's handlers run after the record is kept", () => {
  const { store, host, s, spawned, events, start, proc } = setup(ROLE_RECORDS.conversation);
  start();
  assert.equal((spawned[0]!.launch.options as { resume: boolean }).resume, false);
  assert.equal(host.running(s.id)?.proc, proc());
  proc().send();
  proc().emit("facts", { saved: true }); // the runtime read the message: it saved the conversation
  assert.equal(store.readRuntime(s.id)?.conversation_saved, true);
  proc().turn();
  proc().exit(1);
  assert.deepEqual(events, ["turnEnd:idle", "exit:1:false:exited"], "a crash is not ended by Nexus");
  assert.equal(host.get(s.id), undefined, "an exited process is forgotten");
  start();
  assert.equal((spawned[1]!.launch.options as { resume: boolean }).resume, true);
});

test("retire ends an idle process now and a working one after its turn; either way the next start makes a new one", () => {
  const { host, s, events, start, proc } = setup(ROLE_RECORDS.conversation);
  start();
  host.retire(s.id);
  assert.deepEqual(proc().calls, ["kill"]);
  assert.deepEqual(events, ["exit:null:true:exited"]);
  start();
  proc().send();
  host.retire(s.id);
  assert.deepEqual(proc().calls, ["send", "close"]);
  assert.equal(host.get(s.id), undefined);
  assert.equal(host.alive(), false, "a retired process is no longer the host's");
});

test("restartAfterTurn ends a working process when its turn ends, an idle one now", () => {
  const { host, s, events, start, proc } = setup(ROLE_RECORDS.orchestrator);
  start();
  proc().send();
  host.restartAfterTurn(s.id);
  assert.deepEqual(proc().calls, ["send"], "the running turn is not cut short");
  assert.equal(host.idle(), false);
  proc().turn();
  assert.deepEqual(proc().calls, ["send", "kill"]);
  assert.deepEqual(events, ["exit:null:true:exited", "turnEnd:exited"]);
  assert.equal(host.get(s.id), undefined);
  start();
  host.restartAfterTurn(s.id);
  assert.deepEqual(proc().calls, ["kill"]);
});

test("restartAfterTurn: a turn sent to follow the running one (afterTurn) still runs; the process ends after it (queue CM)", () => {
  const { host, s, start, proc } = setup(ROLE_RECORDS.conversation);
  const l = start();
  host.send(l, "the reply's question");
  host.send(l, "the hand-over's instruction", { afterTurn: true });
  host.restartAfterTurn(s.id);
  proc().turn();
  assert.deepEqual(proc().calls, ["send", "send"], "not killed with the hand-over's turn queued in it");
  assert.equal(host.get(s.id), l);
  proc().state = "working"; // the queued turn runs
  proc().turn();
  assert.deepEqual(proc().calls, ["send", "send", "kill"], "ended after it");
  assert.equal(host.get(s.id), undefined);
});

test("launchedWith: the model and effort the running process was started with", () => {
  const { host, s, store } = setup(ROLE_RECORDS.conversation);
  assert.equal(host.launchedWith(s.id), undefined, "no process");
  host.start(s, (resume) => ({ runtime: "claude", options: { cwd: store.dir, uuid: "uuid-1", resume, model: "m", effort: "high", permissionMode: "dontAsk", allowedTools: [], env: {} } }), {}, () => ({}));
  assert.deepEqual(host.launchedWith(s.id), { model: "m", effort: "high" });
  host.retire(s.id);
  assert.equal(host.launchedWith(s.id), undefined);
});

test("close ends the process after its turn and shutdown kills them all, both as ended by Nexus", () => {
  const { host, s, events, start, proc } = setup(ROLE_RECORDS.worker);
  start();
  host.close(s.id);
  assert.deepEqual(proc().calls, ["close"]);
  assert.equal(host.get(s.id), undefined);
  proc().exit(0);
  start();
  host.shutdown();
  assert.deepEqual(events, ["exit:0:true:exited", "exit:null:true:exited"]);
  assert.equal(host.alive(), false);
});

test("only worker sessions get process ownership, regardless of the host's record settings", () => {
  for (const role of ["worker", "orchestrator", "conversation"] as const) {
    const { s, start, proc } = setup(ROLE_RECORDS.worker);
    s.role = role;
    start();
    assert.equal(!!proc().launch.options.ownProcesses, role === "worker");
  }
});

test("lateTurnMs: a host's own goes to every Claude process whose launch sets none (queue LH)", () => {
  const root = mkdtempSync(join(tmpdir(), "nexus-host-"));
  process.env.NEXUS_HOME = join(root, "home");
  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  const s: SessionFile = { protocol: 1, id: newId(), project: "p", role: "conversation", runtime: "claude", title: "S", native_id: "uuid-1", cwd: root, launched_by: "nexus", created_at: now() };
  store.writeSession(s);
  const spawned: Stand[] = [];
  const host = new AgentHost(store, ROLE_RECORDS.conversation, { lateTurnMs: 7, spawn: (l) => { const p = new Stand(l); spawned.push(p); return p; } });
  const claude = (late?: number): Launch => ({ runtime: "claude", options: { cwd: root, uuid: "uuid-1", resume: false, permissionMode: "dontAsk", allowedTools: [], env: {}, ...(late === undefined ? {} : { lateTurnMs: late }) } });
  const late = () => (spawned.at(-1)!.launch.options as { lateTurnMs?: number }).lateTurnMs;
  host.start(s, () => claude(), {}, () => ({}));
  assert.equal(late(), 7, "the host's");
  host.start(s, () => claude(40), {}, () => ({}));
  assert.equal(late(), 40, "the launch's own wins");
  host.start(s, () => ({ runtime: "codex", options: { cwd: root, resume: false, sandbox: "read-only", env: {} } } as unknown as Launch), {}, () => ({}));
  assert.equal("lateTurnMs" in spawned.at(-1)!.launch.options, false, "Codex has none");
  const plain = new AgentHost(store, ROLE_RECORDS.conversation, { spawn: (l) => { const p = new Stand(l); spawned.push(p); return p; } });
  plain.start(s, () => claude(), {}, () => ({}));
  assert.equal(late(), undefined, "without one: Claude's default");
});

test("idle: not while a process settles, when a turn of the runtime's own may still start (queue LH, finding 13)", () => {
  const { host, start, proc } = setup(ROLE_RECORDS.worker);
  start();
  assert.equal(host.idle(), true);
  proc().send();
  assert.equal(host.idle(), false, "working");
  proc().turn();
  proc().settling = true;
  assert.equal(host.idle(), false, "settling: an update's drain would end the process with the message sent into its last turn");
  proc().settling = false;
  proc().emit("settled");
  assert.equal(host.idle(), true);
});

test("cutOff quotes a message sent into a turn that the runtime runs as a late turn of its own (queue CI12)", () => {
  const { store, s, host, start, proc } = setup(ROLE_RECORDS.conversation);
  const l = start();
  host.send(l, "first");
  host.send(l, "sent into it", { quote: ["the message"] });
  // The turn ends before the runtime read that message: it settles, and runs the message as a turn of its own.
  proc().settling = true;
  proc().turn();
  proc().settling = false;
  proc().state = "working";
  proc().emit("activity", { kind: "turn_start", text: "turn started" });
  assert.deepEqual(host.cutOff(), [s.id]);
  assert.deepEqual(store.readRuntime(s.id)?.interrupted?.asked, ["the message"], "the late turn answers the message sent into the turn before");
});

test("a message read in the turn it was sent into is not quoted by the next one: not when no late turn came (settled), nor when the turn did not settle (queue CI12)", () => {
  for (const settles of [true, false]) {
    const { store, s, host, start, proc } = setup(ROLE_RECORDS.conversation);
    const l = start();
    host.send(l, "first");
    host.send(l, "read in it");
    host.send(l, "after it", { afterTurn: true });
    proc().settling = settles;
    proc().turn();
    if (settles) { proc().settling = false; proc().emit("settled"); }
    proc().state = "working"; // the turn after it, from the message queued for it
    host.cutOff();
    assert.deepEqual(store.readRuntime(s.id)?.interrupted?.asked, ["after it"], settles ? "settled" : "no settling");
  }
});

/** A conversation's process with the hand-over's hooks seen: queuedStart (the held turn given to it) and turn ends. */
function heldSetup() {
  const x = setup(ROLE_RECORDS.conversation);
  const seen: string[] = [];
  const l = x.host.start(x.s, (resume) => ({ runtime: "claude", options: { cwd: x.store.dir, uuid: "uuid-1", resume, permissionMode: "dontAsk", allowedTools: [], env: {} } }), {}, () => ({
    turnEnd: () => seen.push("turnEnd"), queuedStart: () => seen.push("queuedStart"), exit: () => seen.push("exit"),
  }));
  return { ...x, l, seen };
}

test("a turn sent to follow (afterTurn) is held while the process settles, and starts after the late turn of the runtime's own; a held restart after it (queue LCF, LCF7)", () => {
  const { host, s, l, proc, seen } = heldSetup();
  host.send(l, "first");
  host.send(l, "sent into it");
  host.send(l, "the hand-over's instruction", { afterTurn: true });
  host.restartAfterTurn(s.id);
  assert.deepEqual(proc().calls, ["send", "send"], "held, not written to the runtime during the turn");
  proc().settling = true;
  proc().turn();
  assert.deepEqual(proc().calls, ["send", "send"], "nor while it settles: the next turn may be the runtime's own");
  assert.equal(host.idle(), false);
  // The late turn: the runtime's own, for the message sent into the last one.
  proc().settling = false;
  proc().state = "working";
  proc().emit("activity", { kind: "turn_start", text: "turn started" });
  assert.deepEqual(seen, ["turnEnd"], "the late turn is not the held one");
  proc().turn();
  assert.deepEqual(seen, ["turnEnd", "turnEnd", "queuedStart"], "the held turn starts after the late turn's end");
  assert.deepEqual(proc().calls, ["send", "send", "send"], "and is written now; the process is not ended with it");
  proc().turn();
  assert.deepEqual(proc().calls, ["send", "send", "send", "kill"], "the restart after it");
});

test("a held turn starts once the moment is over without a late turn (settled); a cutOff while it is held quotes it", () => {
  {
    const { host, l, proc, seen } = heldSetup();
    host.send(l, "first");
    host.send(l, "read in it");
    host.send(l, "after it", { afterTurn: true });
    proc().settling = true;
    proc().turn();
    proc().settling = false;
    proc().emit("settled");
    assert.deepEqual(seen, ["turnEnd", "queuedStart"]);
    assert.deepEqual(proc().calls, ["send", "send", "send"]);
  }
  {
    const { store, s, host, l, proc } = heldSetup();
    host.send(l, "first");
    host.send(l, "after it", { afterTurn: true, quote: ["the hand-over"] });
    proc().settling = true;
    proc().turn();
    assert.deepEqual(host.cutOff(() => ({ handoff: true })), [s.id], "a held turn is cut off though the process is between turns");
    assert.deepEqual(store.readRuntime(s.id)?.interrupted, { at: store.readRuntime(s.id)!.interrupted!.at, asked: ["the hand-over"], handoff: true });
  }
});

test("an unreadable runtime record is set aside with a warning, and the session starts on", (t) => {
  const { store, s, start, proc } = setup(ROLE_RECORDS.conversation);
  const file = join(store.sessionDir(s.id), "runtime.json");
  writeFileSync(file, "{ half");
  const warn = t.mock.method(console, "warn", () => {});
  start();
  assert.ok(proc(), "the process started");
  assert.equal(readFileSync(`${file}.corrupt`, "utf8"), "{ half", "the old record is kept beside");
  assert.equal(store.readRuntime(s.id)?.state, "idle", "a new record is written");
  const lines = warn.mock.calls.map((c) => c.arguments.join(" "));
  assert.ok(lines.some((l) => l.includes("runtime.json")), `warned with the path: ${lines.join(" | ")}`);
});
