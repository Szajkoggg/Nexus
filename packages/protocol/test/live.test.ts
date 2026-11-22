// The live stream's state delta (queue SD): applying the diff of two states to the first gives the second, over a
// derived state changing as a project does (an event, a new queue, a session rewritten, a queue gone) and over the
// cases a list can meet (a member added, removed, moved; a whole part replaced); nothing differs: no delta.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectStore, approveQueue, deriveProjectState, newId, type Event, type ProjectState } from "../src/index.ts";
import { applyState, deltaJson, diffState, stateJson, stateTexts } from "../src/live.ts";
import { generateNexus } from "./synthetic.ts";

/** What a view shows: the state as JSON (a part the state leaves out reads as null in both). */
const shown = (s: ProjectState) => JSON.parse(stateJson(stateTexts(s)!)) as unknown;
const step = (a: ProjectState, b: ProjectState) => {
  const d = diffState(a, b);
  const applied = d ? applyState(a, d) : a;
  assert.ok(applied, "the delta applies");
  assert.deepEqual(shown(applied), shown(b));
  return d;
};

test("a derived state's deltas, applied one after another, give what a full read gives", () => {
  const root = mkdtempSync(join(tmpdir(), "nexus-live-"));
  process.env.NEXUS_HOME = join(root, "home");
  try {
    generateNexus(root, { scale: 0.05 });
    const st = ProjectStore.forRoot(root);
    let held = deriveProjectState(st);
    const next = () => { const b = deriveProjectState(st); const d = step(held, b); held = b; return d; };
    const same = diffState(held, deriveProjectState(st));
    assert.deepEqual(Object.keys(same?.set ?? {}).filter((k) => k !== "generated_at"), [], "nothing changed but the time");
    assert.equal(same?.upsert, undefined);

    // An event of a queue's step: that queue (and its worker's session) only.
    const q = held.queues.find((x) => x.steps.length)!;
    const session = held.sessions.find((s) => s.role === "worker")!;
    st.appendEvent({ v: 1, id: newId(), at: "2026-11-21T10:00:00.000Z", session: session.id, queue: q.id, step: q.steps[0]!.id, type: "step.progress", text: "half way" } as Event);
    const d1 = next()!;
    assert.deepEqual(d1.upsert?.queues?.map((x) => x.id), [q.id]);
    assert.equal(d1.order, undefined, "the order stays");

    // A new queue: added, with the list's order.
    st.writeQueue({ protocol: 1, id: "ZNEW", title: "New", revision: 1, status: "proposed", stop_conditions: [], checks: [], steps: [{ id: "ZNEW1", title: "One", goal: "", acceptance: [] }] });
    approveQueue(st, "ZNEW");
    const d2 = next()!;
    assert.ok(d2.upsert?.queues?.some((x) => x.id === "ZNEW"));
    assert.ok(d2.order?.queues?.includes("ZNEW"));

    // A session rewritten (its title): that session.
    st.writeSession({ ...st.readSession(session.id), title: "Renamed" });
    assert.deepEqual(next()!.upsert?.sessions?.map((s) => s.id), [session.id]);

    // A queue gone.
    rmSync(st.queueDir("ZNEW"), { recursive: true });
    assert.deepEqual(next()!.remove?.queues, ["ZNEW"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

const base = (queues: string[], extra: Partial<ProjectState> = {}) => ({
  project: { id: "p" }, away: null, tags: {}, metrics: {}, attention: [], warnings: [], generated_at: "t0",
  queues: queues.map((id) => ({ id, title: id })), sessions: [], questions: [], recurring: [], ...extra,
}) as unknown as ProjectState;

test("a list's members added, removed and moved, and a whole part replaced, apply to the same state", () => {
  step(base(["A", "B", "C"]), base(["C", "A", "D"], { generated_at: "t1", warnings: ["w"] } as Partial<ProjectState>));
  step(base(["A", "B"]), base([]));
  step(base([]), base(["A"]));
  const moved = diffState(base(["A", "B"]), base(["B", "A"]))!;
  assert.deepEqual(moved, { order: { queues: ["B", "A"] } }, "a move sends the order only");
  assert.equal(diffState(base(["A"]), base(["A"])), undefined, "nothing differs: no delta");
});

test("a delta whose order names a member neither held nor sent does not apply; a repeated key gives no texts", () => {
  assert.equal(applyState(base(["A"]), { order: { queues: ["A", "X"] } }), undefined);
  assert.equal(stateTexts(base(["A", "A"])), undefined);
});

test("the full read from the texts is the state's JSON, and a delta names what it touched", () => {
  const a = base(["A", "B"]), b = base(["A", "C"], { generated_at: "t1" } as Partial<ProjectState>);
  assert.deepEqual(JSON.parse(stateJson(stateTexts(a)!)), JSON.parse(JSON.stringify(a)));
  const d = deltaJson(stateTexts(a)!, stateTexts(b)!)!;
  assert.deepEqual(d.touched.queues, ["C", "B"]);
  assert.deepEqual(d.set, ["generated_at"]);
});
