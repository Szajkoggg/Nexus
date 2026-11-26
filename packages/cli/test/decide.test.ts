// The review decisions' commands (queue RVD, RVD3; docs/protocol/cli.md): `nexus decide` (the step's worker before its
// step.done, the orchestrator while it holds the review), `nexus review decide` (the review helper, the orchestrator),
// and what they change in `nexus step done`, `nexus review accept|provisional|ask-user`: each refuses what the
// derivation would ignore, before anything is written. The rules themselves: packages/protocol/test/review-decisions.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectStore, approveQueue, currentAnswer, loadProjectState, newId, writeRegistry, type Event, type ReviewLevel, type SessionFile } from "@nexus/protocol";
import { cliRun } from "./run-cli.ts";

let last = 0;
const tick = () => new Date(last = Math.max(Date.now(), last + 1)).toISOString();

function setup(o: { level?: ReviewLevel; mark?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "nexus-decide-cli-"));
  process.env.NEXUS_HOME = join(root, "home");
  const store = ProjectStore.init(root, { id: "p", name: "P", root, orchestrator: { session: null } });
  writeRegistry({ protocol: 1, projects: [{ id: "p", root }] });
  if (o.mark !== false) store.markReviewDecisions(new Date(Date.now() - 60_000).toISOString());
  const session = (role: SessionFile["role"], extra: Partial<SessionFile> = {}): SessionFile => {
    const s: SessionFile = { protocol: 1, id: newId(), project: "p", role, runtime: "claude", cwd: root, launched_by: "nexus", created_at: tick(), ...extra };
    store.writeSession(s);
    return s;
  };
  const worker = session("worker", { queue: "Q" });
  const orch = session("orchestrator");
  store.writeQueue({ protocol: 1, id: "Q", title: "Q", revision: 1, status: "proposed", stop_conditions: [], checks: [],
    steps: [{ id: "Q1", title: "Design", goal: "Design it.", acceptance: ["Drawn"], review: { level: o.level ?? 2 } }, { id: "Q2", title: "Build", goal: "", acceptance: [] }] });
  approveQueue(store, "Q");
  const emit = (s: SessionFile, body: Record<string, unknown>) => store.appendEvent({ v: 1, id: newId(), at: tick(), session: s.id, queue: "Q", step: "Q1", ...body } as Event);
  emit(worker, { type: "step.started" });
  const nexus = (s: SessionFile, ...args: string[]) => cliRun(args, { cwd: root, env: { ...process.env, NEXUS_DIR: store.dir, NEXUS_SESSION: s.id } });
  const st = () => loadProjectState(store).queues.find((q) => q.id === "Q")!.steps.find((x) => x.id === "Q1")!;
  /** A review helper of round 1, started for Q1 (as the server makes one). */
  const helper = () => session("helper", { about: { queue: "Q", step: "Q1", round: 1, level: 2 } });
  const events = (s: SessionFile) => store.readEvents(s.id).entries.map((e) => e.type);
  return { store, worker, orch, session, emit, nexus, st, helper, events };
}

const LAYOUT = ["Which layout?", "--option", "A", "--option", "B", "--recommend", "B", "--material", "layout@492", "--why", "The panel keeps it."];
const CACHE = ["Keep the cache?", "--option", "keep", "--option", "drop", "--fix-option", "drop", "--for", "reviewer"];

test("the worker declares its list before step done, which refuses a step without one; ids, versions, withdrawal and none", async () => {
  const x = setup();
  const refused = await x.nexus(x.worker, "step", "done", "Q1", "--summary", "s");
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /Record the review's decisions first: nexus decide Q1 "<question>" --option/);
  assert.ok(!x.events(x.worker).includes("step.done"), "nothing recorded");

  assert.match((await x.nexus(x.worker, "decide", "Q1", ...LAYOUT)).stdout, /^ok: decision D1 of Q\/Q1, the user's/);
  assert.match((await x.nexus(x.worker, "decide", "Q1", ...CACHE)).stdout, /decision D2 of Q\/Q1, a reviewer's/);
  const [d1, d2] = x.st().decisions.items;
  assert.deepEqual([d1!.for, d1!.recommended, d1!.material, d1!.why], ["user", "B", ["layout@492"], "The panel keeps it."]);
  assert.deepEqual(d2!.options, [{ label: "keep" }, { label: "drop", effect: "fix" }]);
  // Refused before anything is written: one option, a recommendation that is not an option, an unknown id, --none beside a list.
  for (const [args, re] of [
    [["Q1", "One?", "--option", "a"], /two or more options/],
    [["Q1", "Two?", "--option", "a", "--option", "b", "--recommend", "c"], /--recommend and --fix-option name one of the options/],
    [["Q1", "Two?", "--option", "a", "--option", "a"], /an option is given twice/],
    [["Q1", "Two?", "--option", "a", "--option", "b", "--id", "D9"], /has no decision D9/],
    [["Q1", "Two?", "--option", "a", "--option", "b", "--for", "nobody"], /--for is user .* or reviewer/],
    [["Q1", "--none", "nothing"], /has 2 decisions on its list \(D1, D2\): withdraw them first/],
  ] as const) {
    const r = await x.nexus(x.worker, "decide", ...args);
    assert.equal(r.status, 2, args.join(" "));
    assert.match(r.stderr, re);
  }
  assert.equal(x.st().decisions.items.length, 2);
  assert.match((await x.nexus(x.worker, "decide", "Q1", ...LAYOUT, "--id", "D1")).stdout, /version 2: its earlier answers no longer count/);
  assert.match((await x.nexus(x.worker, "decide", "Q1", "--withdraw", "D2", "--reason", "settled by the plan")).stdout, /withdrawn/);
  assert.equal(x.st().decisions.items[1]!.withdrawn?.text, "settled by the plan");
  assert.equal((await x.nexus(x.worker, "step", "done", "Q1", "--summary", "s")).status, 0);
  // At review: the worker writes no list and never answers.
  assert.match((await x.nexus(x.worker, "decide", "Q1", "--none", "x")).stderr, /is not at work: its worker declares its decisions before step\.done/);
  assert.match((await x.nexus(x.worker, "review", "decide", "Q", "Q1", "D1", "--choice", "B", "--reason", "mine")).stderr, /a worker proposes decisions \(nexus decide\), it never answers them/);
  assert.ok(!x.events(x.worker).includes("review.decided"));
});

test("--none is a list; a project without the mark needs none (old data and an older server)", async () => {
  const x = setup();
  assert.equal((await x.nexus(x.worker, "decide", "Q1", "--none", "a refactoring: nothing is the user's")).status, 0);
  assert.equal((await x.nexus(x.worker, "step", "done", "Q1", "--summary", "s")).status, 0);
  assert.equal(x.st().decision_list, "none");
  const y = setup({ mark: false });
  assert.equal((await y.nexus(y.worker, "step", "done", "Q1", "--summary", "s")).status, 0);
  assert.equal(y.st().decision_list, "legacy");
});

test("the review helper answers a reviewer's decision only, writes no list, and hands the user's over once the reviewer's are answered", async () => {
  const x = setup();
  await x.nexus(x.worker, "decide", "Q1", ...LAYOUT);
  await x.nexus(x.worker, "decide", "Q1", ...CACHE);
  await x.nexus(x.worker, "step", "done", "Q1", "--summary", "s");
  const h = x.helper();
  assert.equal(x.st().helper?.state, "running");
  assert.match((await x.nexus(h, "decide", "Q1", "--queue", "Q", "--none", "x")).stderr, /a review helper only reads and decides its review/);
  assert.match((await x.nexus(h, "review", "decide", "Q", "Q1", "D1", "--choice", "A", "--reason", "nicer")).stderr, /decision D1 is the user's: a review helper answers only a reviewer's decision/);
  assert.match((await x.nexus(h, "review", "decide", "Q", "Q1", "D2", "--choice", "keep")).stderr, /missing --reason/);
  assert.match((await x.nexus(h, "review", "ask-user", "Q", "Q1", "the layout")).stderr, /the reviewer's decisions D2 are not answered yet/);
  assert.match((await x.nexus(h, "review", "decide", "Q", "Q1", "D2", "--choice", "maybe", "--reason", "x")).stderr, /"maybe" is not an option of decision D2/);
  assert.match((await x.nexus(h, "review", "decide", "Q", "Q1", "D2", "--choice", "keep", "--reason", "the measurement shows it fresh")).stdout, /D2 of Q\/Q1 answered "keep"; this is no acceptance/);
  assert.equal(currentAnswer(x.st().decisions.items[1]!, 1)?.by, "helper");
  assert.match((await x.nexus(h, "review", "accept", "Q", "Q1")).stderr, /cannot be accepted yet: 1 decision is open: D1 \(not answered\)/);
  assert.ok(!x.events(h).includes("review.accepted"), "the refused acceptance is not written");
  assert.equal((await x.nexus(h, "review", "ask-user", "Q", "Q1", "D1 is the user's layout")).status, 0);
  assert.equal(x.st().review_with, "user");
});

test("the orchestrator completes a missing list, answers a reviewer's decision, a user's only at level 3 (provisionally), and accepts only a complete list", async () => {
  const x = setup({ mark: true });
  // An older CLI's step.done without a list: missing.
  x.emit(x.worker, { type: "step.done", summary: "s" });
  assert.equal(x.st().decision_list, "missing");
  assert.match((await x.nexus(x.orch, "review", "accept", "Q", "Q1")).stderr, /the step has no decision list: declare its decisions, or that it has none/);
  assert.match((await x.nexus(x.orch, "decide", "Q1", "--queue", "Q", ...LAYOUT)).stdout, /decision D1 of Q\/Q1, the user's/);
  assert.match((await x.nexus(x.orch, "review", "decide", "Q", "Q1", "D1", "--choice", "B", "--reason", "x")).stderr, /decision D1 is the user's and step Q1 is at review level 2 with away mode off: hand it to the user/);
  assert.match((await x.nexus(x.orch, "decide", "Q1", "--queue", "Q", ...LAYOUT, "--id", "D1", "--for", "reviewer")).stderr, /is the user's; the orchestrator does not make it a reviewer's/);
  assert.match((await x.nexus(x.orch, "review", "provisional", "Q", "Q1")).stderr, /a provisional acceptance is for level 3/);
  const z = setup({ level: 3 });
  await z.nexus(z.worker, "decide", "Q1", ...LAYOUT);
  await z.nexus(z.worker, "step", "done", "Q1", "--summary", "s");
  assert.match((await z.nexus(z.orch, "review", "decide", "Q", "Q1", "D1", "--choice", "B", "--reason", "as recommended")).stdout, /answered "B" provisionally/);
  assert.match((await z.nexus(z.orch, "review", "accept", "Q", "Q1")).stderr, /1 decision is open: D1 \(the user's to answer\)/);
  assert.equal((await z.nexus(z.orch, "review", "provisional", "Q", "Q1", "--note", "the layout")).status, 0);
  assert.equal(z.st().status, "done");
});
