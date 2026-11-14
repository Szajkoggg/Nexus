// AgentHost with a stand-in process: what it keeps for each role (the runtime record, the runtime's own session id,
// the usage windows) and how it ends a process. The real runtimes against the fakes: runtime-records.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectStore, newId, now, readUsage, type SessionFile } from "@nexus/protocol";
import type { AgentEvents, AgentProcess } from "../src/agent.ts";
import { AgentHost, ROLE_RECORDS, type Launch, type RoleRecord } from "../src/agent-host.ts";

class Stand extends EventEmitter<AgentEvents> implements AgentProcess {
  state: "working" | "idle" | "exited" = "idle";
  readonly pid = 4242;
  calls: string[] = [];
  readonly launch: Launch;
  constructor(launch: Launch) { super(); this.launch = launch; }
  send(): void { this.calls.push("send"); this.state = "working"; }
  stop(): boolean { this.calls.push("stop"); return true; }
  close(): void { this.calls.push("close"); }
  kill(): void { this.calls.push("kill"); this.exit(null); }
  exit(code: number | null): void { if (this.state === "exited") return; this.state = "exited"; this.emit("exit", code); }
  turn(): void { this.state = "idle"; this.emit("turnEnd", { ok: true, text: "" }); }
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
    assert.deepEqual({ ...store.readRuntime(s.id), updated_at: undefined }, { state: "idle", pid: 4242, turns: 0, updated_at: undefined });
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
  const { host, s, spawned, events, start, proc } = setup(ROLE_RECORDS.conversation);
  start();
  assert.equal((spawned[0]!.launch.options as { resume: boolean }).resume, false);
  assert.equal(host.running(s.id)?.proc, proc());
  proc().send();
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
