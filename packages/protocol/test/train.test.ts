// The merge train's rule (train.ts): who holds a base, who waits in line and in which order, a wait that takes a queue
// out of the train and a queue back from one at the end of the line, and that the train is off with merge_back off.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mayIntegrate, mayMergeBack, trainPlace, trainText, trainsOf, type QueueView } from "../src/index.ts";

const ON = { defaults: { merge_back: true, provisional_counts: true } } as const;

/**
 * A worktree queue whose own step ended at `ready` (minutes past the hour) and whose integration step is `integ`;
 * `run` its run's state, `merge` its git.yaml merge record.
 */
function q(id: string, o: {
  ready: number; integ: "pending" | "running" | "review" | "done"; run?: "running" | "paused" | "held" | "halted" | "finished";
  started?: number; merge?: Record<string, unknown>; merged?: boolean; base?: string;
}): QueueView {
  const at = (m: number) => `2026-11-16T10:${String(m).padStart(2, "0")}:00.000Z`;
  const run = o.run ?? (o.integ === "done" ? "finished" : "running");
  return {
    id, status: o.integ === "done" ? "done" : "running", rejection: undefined,
    run: { state: run === "held" ? "paused" : run, ...(run === "held" ? { resume_after_restart: true } : {}) },
    git: {
      base: { ref: o.base ?? "main" }, steps: {}, ...(o.merge ? { merge: o.merge } : {}),
      ...(o.merged ? { merged: { at: at(59), into: "main", path: "p", sha: "s", fast_forward: true } } : {}),
    },
    steps: [
      { id: `${id}1`, status: "done", finished_at: at(o.ready), segments: [] },
      {
        id: `${id}.integrate`, integration: true, status: o.integ,
        ...(o.integ === "pending" ? {} : { started_at: at(o.started ?? o.ready), finished_at: o.integ === "done" ? at((o.started ?? o.ready) + 1) : undefined }),
        segments: o.integ === "pending" ? [] : [{ start: at(o.started ?? o.ready) }],
      },
    ],
  } as unknown as QueueView;
}

test("one queue holds the base; the others wait in the order their own steps ended, wherever their runs are", () => {
  const queues = [
    q("C", { ready: 7, integ: "pending", run: "held" }),
    q("A", { ready: 1, integ: "running" }),
    q("B", { ready: 5, integ: "pending", run: "held" }),
    q("D", { ready: 9, integ: "pending", run: "running" }), // just at its step's end
  ];
  const t = trainsOf(ON, queues).get("main")!;
  assert.deepEqual(t, { base: "main", active: ["A"], line: ["B", "C", "D"] });
  assert.equal(mayIntegrate(t, "B"), false, "A holds main");
  const trains = trainsOf(ON, queues);
  assert.deepEqual(trainPlace(trains, queues[2]!), { base: "main", position: 1, after: "A" });
  assert.deepEqual(trainPlace(trains, queues[0]!), { base: "main", position: 2, after: "B" });
  assert.equal(trainPlace(trains, queues[1]!), undefined, "the one integrating is not waiting");
  assert.equal(trainText(trainPlace(trains, queues[0]!)!), "waits to integrate after B (one queue at a time merges back into main)");
});

test("a queue integrated and waiting for its fast-forward, or asked to run again, holds the base; merged, it is out", () => {
  const waitingFf = q("A", { ready: 1, integ: "done" });
  const b = q("B", { ready: 5, integ: "pending", run: "held" });
  assert.deepEqual(trainsOf(ON, [waitingFf, b]).get("main")!.active, ["A"]);
  assert.equal(mayMergeBack(trainsOf(ON, [waitingFf, b]).get("main"), "A"), true);
  const again = q("A", { ready: 1, integ: "pending", run: "running", merge: { reintegrating: "2026-11-16T10:30:00.000Z" } });
  assert.deepEqual(trainsOf(ON, [again, b]).get("main")!.active, ["A"]);
  const merged = q("A", { ready: 1, integ: "done", merged: true });
  const t = trainsOf(ON, [merged, b]).get("main")!;
  assert.deepEqual(t, { base: "main", active: [], line: ["B"] });
  assert.equal(mayIntegrate(t, "B"), true, "B goes next");
  assert.deepEqual(trainPlace(trainsOf(ON, [merged, b]), b), { base: "main", position: 1 });
  assert.equal(trainText({ base: "main", position: 1 }), "integrates next into main");
});

test("a fast-forward that waits takes its queue out of the train; back from the wait it queues up at the end of the line", () => {
  const stuck = q("A", { ready: 1, integ: "done", merge: { waiting: { reason: "dirty", since: "2026-11-16T10:20:00.000Z" } } });
  const b = q("B", { ready: 5, integ: "running", started: 21 });
  const c = q("C", { ready: 25, integ: "pending", run: "held" });
  assert.deepEqual(trainsOf(ON, [stuck, b, c]).get("main"), { base: "main", active: ["B"], line: ["C"] });
  // Back from the wait while B holds main: it queues up, ordered by when its wait began (before C got there).
  const queued = q("A", { ready: 1, integ: "done", merge: { queued: { since: "2026-11-16T10:20:00.000Z" } } });
  const t = trainsOf(ON, [queued, b, c]).get("main")!;
  assert.deepEqual(t, { base: "main", active: ["B"], line: ["A", "C"] });
  assert.equal(mayMergeBack(t, "A"), false, "not while B holds main");
  assert.equal(mayMergeBack(t, "B"), true);
  // A stuck queue back with nobody holding the base and nobody in line may go at once.
  assert.equal(mayMergeBack(trainsOf(ON, [stuck]).get("main"), "A"), true);
});

test("out of the train: a halted run, a queue paused by the user or still at its own steps; another base; merge_back off", () => {
  const halted = q("A", { ready: 1, integ: "running", run: "halted" });
  const paused = q("B", { ready: 2, integ: "pending", run: "paused" });
  const other = q("C", { ready: 3, integ: "running", base: "release" });
  const d = q("D", { ready: 4, integ: "pending", run: "held" });
  const trains = trainsOf(ON, [halted, paused, other, d]);
  assert.deepEqual(trains.get("main"), { base: "main", active: [], line: ["D"] });
  assert.deepEqual(trains.get("release"), { base: "release", active: ["C"], line: [] });
  const working = q("E", { ready: 5, integ: "pending" });
  working.steps[0]!.status = "running";
  assert.equal(trainsOf(ON, [working]).size, 0, "its own steps are not in the train");
  assert.equal(trainsOf({ defaults: { merge_back: false, provisional_counts: true } }, [halted, d]).size, 0);
});
