// The CLI's walks over sessions (queue CHC, step CHC2): a session's line (`continues`) for nexus withdraw, and the
// orchestrator sessions nexus review audit looks for its notice in. An unreadable session.yaml on the way is named
// with its path, never taken in silence for "another session's" or "not given".
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectStore, approveQueue, loadProjectState, newId, stepView, type Event, type SessionFile } from "@nexus/protocol";
import { cliRun } from "./run-cli.ts";

const GARBAGE = "{ this is: [not yaml\n";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "nexus-session-walks-"));
  const store = ProjectStore.init(root, { id: "p", name: "P", root, orchestrator: { session: null } });
  const at = new Date().toISOString();
  const session = (id: string, role: SessionFile["role"], extra: Partial<SessionFile> = {}) =>
    store.writeSession({ protocol: 1, id, project: "p", role, runtime: "claude", cwd: root, launched_by: "nexus", created_at: at, ...extra });
  store.writeQueue({ protocol: 1, id: "Q", title: "Q", revision: 1, status: "proposed", stop_conditions: [], checks: [],
    steps: [{ id: "Q1", title: "One", goal: "Do it.", acceptance: ["Done"], review: { level: 2 } }] });
  approveQueue(store, "Q");
  const env = (s: string) => {
    const e: NodeJS.ProcessEnv = { ...process.env, NEXUS_DIR: store.dir, NEXUS_SESSION: s };
    delete e.NEXUS_PORT;
    return e;
  };
  const nexus = (s: string, ...args: string[]) => cliRun(args, { cwd: root, env: env(s) });
  const sessionFile = (id: string) => join(store.sessionDir(id), "session.yaml");
  const spoil = (id: string) => writeFileSync(sessionFile(id), GARBAGE);
  return { root, store, session, nexus, sessionFile, spoil };
}

test("nexus withdraw past an unreadable predecessor names its session.yaml instead of calling the question another session's", async () => {
  const x = setup();
  x.session("w0", "worker", { queue: "Q" });
  x.session("w1", "worker", { queue: "Q", continues: "w0" });
  x.session("w2", "worker", { queue: "Q", continues: "w1" });
  x.store.appendEvent({ v: 1, id: newId(), at: new Date().toISOString(), session: "w0", type: "step.started", queue: "Q", step: "Q1" } as Event);
  const asked = await x.nexus("w0", "ask", "Which page?", "--step", "Q1");
  assert.equal(asked.status, 0, asked.stderr);
  const qid = /question (\S+) sent/.exec(asked.stdout)![1]!;
  // w1 between them cannot be read: whether w0 is of w2's line is unknown (a readable line: guards.test.ts, W2).
  x.spoil("w1");
  const r = await x.nexus("w2", "withdraw", qid, "--reason", "settled");
  assert.equal(r.status, 2, r.stderr);
  assert.doesNotMatch(r.stderr, /another session's/);
  assert.match(r.stderr, /session\.yaml cannot be read/);
  assert.ok(r.stderr.includes(x.sessionFile("w1").replace(/\\/g, "/")), `names w1's file: ${r.stderr}`);
  assert.equal(x.store.readEvents("w2").entries.filter((e) => e.type === "question.withdrawn").length, 0, "nothing recorded");
});

test("nexus review audit warns of an unreadable orchestrator session.yaml, with its path, instead of passing over it", async () => {
  const x = setup();
  x.session("w", "worker", { queue: "Q" });
  x.session("o1", "orchestrator");
  x.session("o2", "orchestrator", { continues: "o1" });
  x.session("h", "helper", { about: { queue: "Q", step: "Q1", round: 1, level: 2 } });
  const at = () => new Date().toISOString();
  x.store.appendEvent({ v: 1, id: newId(), at: at(), session: "w", type: "step.started", queue: "Q", step: "Q1" } as Event);
  assert.equal((await x.nexus("w", "step", "done", "Q1", "--summary", "s")).status, 0);
  const accepted = await x.nexus("h", "review", "accept", "Q", "Q1", "--note", "checked");
  assert.equal(accepted.status, 0, accepted.stderr);
  const event = stepView(loadProjectState(x.store), "Q", "Q1").accepted!.event;
  // The notice went to o1, whose session.yaml cannot be read now.
  x.store.appendApplied("o1", { at: at(), event: `notify:audit:${event}`, ok: true, message: "audit" });
  x.spoil("o1");
  const r = await x.nexus("o2", "review", "audit", "Q", "Q1", "agree", "--reason", "fine");
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /warning: .*session\.yaml cannot be read/);
  assert.ok(r.stderr.includes(x.sessionFile("o1").replace(/\\/g, "/")), `names o1's file: ${r.stderr}`);
  assert.match(r.stderr, /no audit of step Q\/Q1 was given to you/);
  // A readable session's notice still counts.
  x.store.appendApplied("o2", { at: at(), event: `notify:audit:${event}`, ok: true, message: "audit" });
  const ok = await x.nexus("o2", "review", "audit", "Q", "Q1", "agree", "--reason", "fine");
  assert.equal(ok.status, 0, ok.stderr);
});
