// The orchestrator against the fake `claude`: the chat, drafting a queue, starting its run, answering a worker's
// question, and being told when the run finishes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectStore, approveQueue, loadProjectState, routeAnswers } from "@nexus/protocol";
import { Engine } from "../src/engine.ts";
import { Orchestrator } from "../src/orchestrator.ts";

process.env.NEXUS_CLAUDE = join(dirname(fileURLToPath(import.meta.url)), "fake-claude.ts");

const QUEUE = `id: R
title: Planned in the chat
stop_conditions:
  - Something outside the repository would change.
steps:
  - id: R1
    title: Ask first
    goal: "FAKE: ask"
    acceptance: [The question is answered]
  - id: R2
    title: Then finish
    goal: "FAKE: done"
    acceptance: [Done]
`;

function setup() {
  const root = mkdtempSync(join(tmpdir(), "nexus-orch-"));
  process.env.NEXUS_HOME = join(root, "home");
  delete process.env.FAKE_LOG;
  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  let orchestrator: Orchestrator;
  const engine: Engine = new Engine(store, () => tick());
  orchestrator = new Orchestrator(store, engine, () => tick());
  // Stands in for the server's file watcher.
  function tick() { routeAnswers(store); orchestrator.onChange(loadProjectState(store)); engine.onChange(loadProjectState(store)); }
  const timer = setInterval(tick, 150);
  const state = () => loadProjectState(store);
  const until = async (what: string, pred: () => boolean, ms = 30_000) => {
    const t = Date.now();
    while (!pred()) {
      if (Date.now() - t > ms) assert.fail(`timed out waiting for ${what}; chat: ${JSON.stringify(orchestrator.view().chat.slice(-4))}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  const stop = () => { clearInterval(timer); engine.shutdown(); orchestrator.shutdown(); };
  return { store, engine, orchestrator, state, until, stop };
}

test("the orchestrator drafts a queue, runs it, answers the worker and hears that it finished", async () => {
  const { store, orchestrator, state, until, stop } = setup();
  try {
    orchestrator.say(`FAKE-DRAFT:\n${QUEUE}`);
    await until("the drafted queue", () => state().queues.some((q) => q.id === "R"));
    const r = state().queues.find((q) => q.id === "R")!;
    assert.equal(r.status, "proposed");
    assert.equal(r.approved, false);
    await until("the result in the chat", () => orchestrator.view().chat.some((c) => /queue R created as proposed/.test(c.text)));

    // Only the user approves; the orchestrator's start before that is refused.
    orchestrator.say(`FAKE-NEXUS: ["run","R","start","--reason","early"]`);
    await until("the refusal", () => orchestrator.view().chat.some((c) => /approve the queue/.test(c.text)));

    approveQueue(store, "R", "Go.");
    orchestrator.say(`FAKE-NEXUS: ["run","R","start","--reason","approved"]`);
    await until("the run to finish", () => state().queues.find((q) => q.id === "R")?.run?.state === "finished");

    const s = state();
    const question = s.questions.find((x) => x.queue === "R")!;
    assert.equal(question.state, "answered");
    assert.equal(question.answers[0]!.by, "orchestrator");
    assert.equal(question.answers[0]!.text, "fake answer");
    assert.deepEqual(s.queues.find((q) => q.id === "R")!.steps.map((x) => x.status), ["done", "done"]);

    await until("the finish notice", () => orchestrator.view().chat.some((c) => c.from === "nexus" && /Queue R finished/.test(c.text)));
    const chat = orchestrator.view().chat;
    assert.ok(chat.some((c) => c.from === "user"));
    assert.ok(chat.some((c) => c.from === "nexus" && /A worker asked a question in queue R, step R1/.test(c.text)));
  } finally { stop(); }
});

test("changing an approved queue makes a new revision that needs approval again", async () => {
  const { store, orchestrator, state, until, stop } = setup();
  try {
    orchestrator.say(`FAKE-DRAFT:\n${QUEUE}`);
    await until("the drafted queue", () => state().queues.some((q) => q.id === "R"));
    approveQueue(store, "R");
    assert.equal(state().queues.find((q) => q.id === "R")!.approved, true);

    orchestrator.say(`FAKE-DRAFT:\n${QUEUE.replace("Then finish", "Then finish, renamed")}`);
    await until("revision 2", () => state().queues.find((q) => q.id === "R")!.revision === 2);
    const r = state().queues.find((q) => q.id === "R")!;
    assert.equal(r.approved, false);
    assert.equal(r.status, "proposed");
    assert.equal(r.history.length, 1);
    await until("the result in the chat", () => orchestrator.view().chat.some((c) => /revision 2; it needs the user's approval again/.test(c.text)));
  } finally { stop(); }
});

test("a worker may not draft queues or start runs", async () => {
  const { store, stop } = setup();
  try {
    const { execFileSync } = await import("node:child_process");
    store.writeSession({ protocol: 1, id: "w1", project: "p", role: "worker", runtime: "external", cwd: store.dir, launched_by: "external", created_at: new Date().toISOString() });
    const cli = join(dirname(fileURLToPath(import.meta.url)), "../../../packages/cli/bin/nexus.js");
    assert.throws(
      () => execFileSync(process.execPath, [cli, "run", "R", "start", "--reason", "x"], { env: { ...process.env, NEXUS_SESSION: "w1", NEXUS_DIR: store.dir }, stdio: "pipe" }),
      (e: { stderr: Buffer }) => /only an orchestrator/.test(e.stderr.toString()),
    );
  } finally { stop(); }
});
