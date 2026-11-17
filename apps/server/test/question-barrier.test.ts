// A partial answer is saved but cannot start work until this step's last open question closes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { answerAsUser, loadProjectState, newId, now, sendMessage, type Event } from "@nexus/protocol";
import { setup, restart } from "./engine-setup.ts";
import { LONGER } from "./wait.ts";

for (const runtime of ["claude", "codex"] as const) {
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
