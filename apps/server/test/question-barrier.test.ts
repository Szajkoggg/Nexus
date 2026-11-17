// A partial answer is saved but cannot start work until this step's last open question closes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { answerAsUser, ensureUserSession, loadProjectState, newId, now, readTurns, routeAnswers, sendMessage, type Event } from "@nexus/protocol";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { setup, restart } from "./engine-setup.ts";
import { LONGER } from "./wait.ts";

for (const runtime of ["claude", "codex"] as const) {
  test(`${runtime}: escalation, failed/duplicate saves, a late question, withdrawal and pause do not release partial work`, async () => {
    const { store, engine, queue, received, until } = setup(["askthree", "done"]);
    const state = () => loadProjectState(store);
    try {
      engine.start("Q", { runtime });
      await until("three questions and idle", () => state().questions.length === 3 && state().sessions.find(s => s.id === queue().run?.session)?.live?.state === "idle", LONGER.step);
      const worker = queue().run!.session;
      const [a, b, c] = state().questions;
      assert.ok(state().questions.every(q => q.can_continue));
      const baseline = received().length, turns = readTurns().entries.filter(t => t.session === worker).length;
      const held = async () => {
        engine.onChange(state()); await new Promise(r => setTimeout(r, 450));
        assert.equal(received().length, baseline, "no injected answer, normal message or nudge");
        assert.equal(readTurns().entries.filter(t => t.session === worker).length, turns, "no additional fake turn");
        assert.equal(store.readRuntime(worker)?.state, "idle", "fake work marker stays idle");
        assert.equal(queue().steps[1]!.status, "pending");
        assert.ok(state().sessions.find(s => s.id === worker)!.inbox.every(m => !m.read_at), "no delivery trace before delivery");
      };
      store.appendEvent({ v: 1, id: newId(), at: now(), session: ensureUserSession(store).id, type: "answer.given", qid: c!.qid, text: "Please decide", escalate: true, recommended: "First" });
      assert.throws(() => answerAsUser(store, a!.qid, "  ", true), /empty/);
      await held();
      answerAsUser(store, b!.qid, "B", true); answerAsUser(store, b!.qid, "B", true);
      assert.equal(state().questions.find(q => q.qid === b!.qid)!.answers.length, 1, "repeated identical save is idempotent");
      sendMessage(store, worker, "Keep the descriptions", { queue: "Q", step: "Q1" });
      await held();
      answerAsUser(store, a!.qid, "A", true); await held();
      // The final answer and another question land before the watcher processes either file change.
      answerAsUser(store, c!.qid, "C", true);
      const ready = state();
      store.appendEvent({ v: 1, id: newId(), at: now(), session: worker, type: "question.asked", queue: "Q", step: "Q1", qid: "late", text: "One more?", can_continue: true });
      engine.onChange(ready); // A watcher snapshot taken just before the new question must not release delivery.
      await held();
      engine.pause("Q");
      store.appendEvent({ v: 1, id: newId(), at: now(), session: worker, type: "question.withdrawn", qid: "late", reason: "Resolved from the approved goal" });
      await held(); assert.equal(queue().run!.state, "paused");
      engine.resume("Q"); engine.onChange(state());
      await until("one released answer turn", () => queue().run?.state === "finished", LONGER.run);
      const answers = received().filter(m => m.text.startsWith("[Nexus] Answer"));
      assert.equal(answers.length, 1);
      for (const q of [a!, b!, c!]) assert.ok(answers[0]!.text.includes(`qid ${q.qid}`));
      assert.ok(answers[0]!.text.includes("Keep the descriptions"));
    } finally { engine.shutdown(); }
  });

  test(`${runtime}: saved partial answers follow a replacement worker session without releasing its barrier`, async () => {
    const { store, engine, queue, received, until } = setup(["askthree", "done"]);
    let active = engine;
    const state = () => loadProjectState(store);
    try {
      active.start("Q", { runtime });
      await until("asking turn idle", () => state().questions.length === 3 && state().sessions.find(s => s.id === queue().run?.session)?.live?.state === "idle", LONGER.step);
      const [a, b, c] = state().questions;
      const old = store.readSession(queue().run!.session);
      answerAsUser(store, c!.qid, "C", true);
      active.pause("Q"); active.shutdown();
      await until("old process gone", () => !active.alive(), LONGER.step);
      const fresh = { ...old, id: newId(), continues: old.id, native_id: runtime === "claude" ? randomUUID() : null };
      store.writeSession(fresh); store.writeSession({ ...old, continued_by: fresh.id });
      store.writeRun("Q", { ...store.readRun("Q")!, session: fresh.id });
      // The fake's durable current-step context, as in a replacement worker seeded from its predecessor.
      writeFileSync(join(dirname(process.env.FAKE_LOG!), `fake-step-${fresh.id}`), "Q1");
      routeAnswers(store);
      const before = received().length;
      active = restart(store); active.resume("Q");
      answerAsUser(store, a!.qid, "A", true); active.onChange(state());
      await new Promise(r => setTimeout(r, 600));
      assert.equal(received().length, before);
      assert.equal(queue().steps[0]!.status, "waiting");
      answerAsUser(store, b!.qid, "B", true); active.onChange(state());
      await until("replacement gets all answers", () => queue().run?.state === "finished", LONGER.run);
      const answers = received().filter(m => m.text.startsWith("[Nexus] Answer"));
      assert.equal(answers.length, 1);
      for (const q of [a!, b!, c!]) assert.ok(answers[0]!.text.includes(`qid ${q.qid}`));
      assert.equal(state().sessions.find(s => s.id === fresh.id)!.inbox.filter(m => m.type === "answer" && m.read_at).length, 3);
    } finally { active.shutdown(); }
  });
  test(`${runtime}: the last answer's wait decision holds earlier continue answers until explicit resume`, async () => {
    const { store, engine, queue, received, until } = setup(["ask", "done"]);
    let active = engine;
    const state = () => loadProjectState(store);
    try {
      engine.start("Q", { runtime });
      await until("asking turn idle", () => state().sessions.find(s => s.id === queue().run?.session)?.live?.state === "idle" && state().questions.length === 1, LONGER.step);
      const worker = queue().run!.session;
      for (const qid of ["second", "third"]) store.appendEvent({ v: 1, id: newId(), at: now(), session: worker, type: "question.asked", queue: "Q", step: "Q1", qid, text: qid, can_continue: true });
      answerAsUser(store, "third", "Third", true);
      answerAsUser(store, state().questions[0]!.qid, "First", true);
      const before = received().length;
      answerAsUser(store, "second", "Second; wait", false);
      engine.onChange(state());
      await new Promise(r => setTimeout(r, 600));
      assert.equal(received().length, before, "a saved continue answer cannot override the final --wait");
      assert.equal(queue().steps[1]!.status, "pending");
      assert.ok(state().sessions.find(s => s.id === worker)!.inbox.every(m => !m.read_at));
      active.drainForUpdate(false); active.shutdown();
      await until("old process exits for update", () => !active.alive(), LONGER.step);
      active = restart(store);
      await until("automatic recovery", () => queue().run?.state === "running", LONGER.step);
      active.onChange(state()); await new Promise(r => setTimeout(r, 500));
      assert.equal(received().length, before, "automatic recovery cannot release --wait");
      active.resume("Q"); active.onChange(state());
      await until("explicit resume releases all answers", () => queue().run?.state === "finished", LONGER.run);
      const turns = received().filter(m => m.text.startsWith("[Nexus] Answer"));
      assert.equal(turns.length, 1);
      for (const text of ["First", "Second; wait", "Third"]) assert.ok(turns[0]!.text.includes(text));
    } finally { active.shutdown(); }
  });
  test(`${runtime}: three questions hold partial answers and messages across resume and restart`, async () => {
    const { store, engine, queue, received, until } = setup(["ask", "done"]);
    let active = engine;
    const state = () => loadProjectState(store);
    try {
      active.start("Q", { runtime });
      await until("the asking turn to end", () => queue().steps[0]!.status === "waiting" && state().sessions.find(s => s.id === queue().run?.session)?.live?.state === "idle", LONGER.step);
      const worker = queue().run!.session;
      const emit = (body: Record<string, unknown>) => store.appendEvent({ v: 1, id: newId(), at: now(), session: worker, ...body } as Event);
      const first = state().questions[0]!.qid;
      emit({ type: "question.asked", queue: "Q", step: "Q1", qid: "second", text: "Layout?", can_continue: false });
      emit({ type: "question.asked", queue: "Q", step: "Q1", qid: "third", text: "Sound?", can_continue: true });
      // A question elsewhere is not a global hold, even with the same step id and asking session.
      store.writeQueue({ protocol: 1, id: "OTHER", title: "Other", revision: 1, status: "proposed", stop_conditions: [], checks: [], steps: [{ id: "Q1", title: "Other", goal: "", acceptance: [] }] });
      emit({ type: "question.asked", queue: "OTHER", step: "Q1", qid: "other", text: "Unrelated?", can_continue: false });
      const before = received().length;
      answerAsUser(store, "second", "Grid", true);
      sendMessage(store, worker, "Keep the descriptions", { queue: "Q", step: "Q1" });
      active.onChange(state());
      await new Promise(r => setTimeout(r, 500));
      assert.equal(queue().steps[0]!.status, "waiting");
      assert.equal(received().length, before, "partial answers and messages cannot start work");
      assert.ok(state().sessions.find(s => s.id === worker)!.inbox.some(m => m.type === "answer" && !m.read_at));

      active.stopNow("Q"); active.resume("Q"); active.onChange(state());
      await new Promise(r => setTimeout(r, 500));
      assert.equal(received().length, before, "explicit resume cannot bypass the questions");
      active.drainForUpdate(false); active.shutdown();
      await until("old worker exits", () => !active.alive(), LONGER.step);
      active = restart(store); active.onChange(state());
      answerAsUser(store, first, "Left", true); active.onChange(state());
      await new Promise(r => setTimeout(r, 500));
      assert.equal(received().length, before, "restart and second answer still wait for the third");
      assert.equal(queue().steps[0]!.status, "waiting");

      answerAsUser(store, "third", "Bell", true); active.onChange(state());
      await until("all answers release the run", () => queue().run?.state === "finished", LONGER.run);
      const answerTurns = received().filter(m => m.text.startsWith("[Nexus] Answer"));
      assert.equal(answerTurns.length, 1, "all accumulated answers start one turn");
      for (const text of ["Left", "Grid", "Bell"]) assert.ok(answerTurns[0]!.text.includes(text));
      assert.equal(state().questions.find(q => q.qid === "other")!.state, "open");
      const answers = state().sessions.find(s => s.id === worker)!.inbox.filter(m => m.type === "answer");
      assert.equal(answers.length, 3); assert.ok(answers.every(m => m.read_at));
    } finally { active.shutdown(); }
  });
}
