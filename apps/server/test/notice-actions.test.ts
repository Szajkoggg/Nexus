// The commands the approval, away-on and held-plan notices suggest (ACX, recommended addition 11; the slips O1-O3 of the
// agent-contract survey): in each state (in the plan, not in it, the user away) every `nexus ...` command the notice's
// text names is taken from the text, filled in, run by the fake orchestrator through its handler, and must be
// accepted and do what the text says; what the text says Nexus refuses or does itself is checked too. The notices are
// rendered from the queue's view as the orchestrator renders them (prompts.ts), so a change of their wording that
// suggests another command fails here until the command is tested.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  ProjectStore, applyDraft, approveQueue, loadProjectState, newId, readAway, routeAnswers, turnAway, writeAway,
  type Event, type QueueView, type StepDef,
} from "@nexus/protocol";
import { Engine } from "../src/engine.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import { approvalNotice, awayOnNotice, planHeldNotice } from "../src/prompts.ts";
import { acceptReviews } from "./fake-reviewer.ts";
import { tempDir } from "./temp-dirs.ts";
import { QUICK_ENGINE, WAIT_MS, until as waitUntil, LONGER } from "./wait.ts";
import { inProcessRuntime } from "./in-process-runtime.ts";

/** Queues by id (one step each, `FAKE: done`); those in `approved` are approved. An orchestrator is set up. */
function setup(queues: string[], approved: string[] = queues) {
  const root = tempDir("nexus-notice-actions-");
  process.env.NEXUS_HOME = join(root, "home");
  process.env.FAKE_LOG = join(root, "fake.log");
  const store = ProjectStore.init(root, { id: "p", name: "P", root, orchestrator: { notify: false } });
  for (const id of queues) {
    const steps: StepDef[] = [{ id: `${id}1`, title: "Step 1", goal: "FAKE: done", acceptance: [] }];
    applyDraft(store, { id, title: `Queue ${id}`, steps });
    if (approved.includes(id)) approveQueue(store, id);
  }
  const tick = () => { routeAnswers(store); acceptReviews(store); const s = loadProjectState(store); orchestrator.onChange(s); engine.onChange(s); };
  const engine = new Engine(store, tick, { spawn: inProcessRuntime(), ...QUICK_ENGINE });
  const orchestrator = new Orchestrator(store, engine, tick, {}, { spawn: inProcessRuntime() });
  const timer = setInterval(tick, 150);
  const queue = (id: string): QueueView => loadProjectState(store).queues.find((q) => q.id === id)!;
  const chat = () => orchestrator.view().chat.map((c) => c.text);
  const until = (what: string, pred: () => boolean, ms = WAIT_MS) => waitUntil(what, pred, ms, () => `; chat: ${JSON.stringify(chat().slice(-3))}`);
  /** Runs a command as the orchestrator and waits for its answer in the chat (the handler's result or refusal). */
  const run = async (args: string[], answer: RegExp) => {
    const before = chat().length;
    orchestrator.say(`FAKE-NEXUS: ${JSON.stringify(args)}`);
    const answered = () => chat().slice(before).find((t) => /^(ok: |nexus failed)/m.test(t));
    await until(`the answer to nexus ${args.join(" ")}`, () => !!answered());
    assert.match(answered()!, answer, `nexus ${args.join(" ")}`);
  };
  const hello = async () => { orchestrator.say("Hello"); await until("the orchestrator's session", () => !!orchestrator.session()); };
  const stop = () => { clearInterval(timer); orchestrator.shutdown(); engine.shutdown(); writeAway(turnAway(readAway(), null)); };
  return { store, engine, queue, run, hello, until, stop };
}

/** An external worker session, for events written by hand. */
function external(store: ProjectStore): string {
  const session = newId();
  store.writeSession({ protocol: 1, id: session, project: "p", role: "worker", runtime: "external", cwd: ".", launched_by: "external", created_at: new Date().toISOString() });
  return session;
}
const stopQueue = (store: ProjectStore, queue: string) => store.appendEvent({ v: 1, id: newId(), at: new Date().toISOString(), session: external(store), type: "queue.stop", queue, step: `${queue}1`, condition: "a stop", reason: "by hand" } as Event);
const doneByHand = (store: ProjectStore, queue: string) => {
  const session = external(store);
  for (const type of ["step.started", "step.done"] as const) {
    store.appendEvent({ v: 1, id: newId(), at: new Date().toISOString(), session, type, queue, step: `${queue}1`, ...(type === "step.done" ? { summary: "by hand" } : {}) } as Event);
  }
  acceptReviews(store);
};
const away = (on: boolean) => writeAway(turnAway(readAway(), on ? new Date(Date.now() + 3_600_000).toISOString() : null));

/** The `nexus ...` commands a notice's text names, each up to its `--reason "..."`, in order. */
function commandsIn(text: string): string[] {
  return [...text.matchAll(/nexus ((?:run|plan|review) [^"]*?)\s*--reason "\.\.\."/g)].map((m) => m[1]!);
}
/** A command of a notice as arguments: `<queue>...` is `queue`; a bracketed optional part is in or left out (`optional`). */
function filled(command: string, queue: string, optional: boolean): string[] {
  const text = command.replace(/\[([^\]]*)\]\.\.\./g, optional ? "$1" : "").replaceAll("<queue>...", queue).replaceAll("<queue>", queue);
  return [...text.split(/\s+/).filter(Boolean), "--reason", "test"];
}

test("approvalNotice, not in the plan: start it now, put it into the plan with --after, --next or --at; each accepted and done", async () => {
  const x = setup(["A", "U", "V", "W", "X"]);
  try {
    await x.hello();
    const { todo } = approvalNotice(x.queue("U"), { revision: 1 });
    assert.match(todo, /^It is not in the plan, so nothing starts it: start it now, or put it into the plan/);
    assert.deepEqual(commandsIn(todo), ["run U start --after <queue>..."], "the one command the text spells out");
    assert.match(todo, /; or --next, or --at\), or tell the user why it waits\.$/);

    // --after: in the plan after A, which has not run: U waits for it, nothing starts.
    await x.run(filled(commandsIn(todo)[0]!, "A", false), /queue U starts when queue A is done/);
    assert.deepEqual(x.store.readPlan("U")?.after.map((e) => [e.queue, e.by]), [["A", "orchestrator"]]);
    assert.equal(x.queue("U").run, undefined);
    // --next: in the plan with none before it, so it starts now.
    await x.run(["run", "V", "start", "--next", "--reason", "test"], /queue V started now in session /);
    await x.until("V to finish", () => x.queue("V").run?.state === "finished", LONGER.run);
    // --at: a start at a time.
    const tomorrow = new Date(Date.now() + 86_400_000);
    const day = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, "0")}-${String(tomorrow.getDate()).padStart(2, "0")}`;
    await x.run(["run", "W", "start", "--at", `${day} 23:59`, "--reason", "test"], /queue W starts at /);
    assert.ok(x.queue("W").start?.at, "W has its time");
    // Start it now: the plain start (the briefing's command).
    await x.run(["run", "X", "start", "--reason", "test"], /queue X started in session /);
    await x.until("X to finish", () => x.queue("X").run?.state === "finished", LONGER.run);
  } finally { x.stop(); }
});

test("approvalNotice, in the plan: Nexus starts it itself once its predecessor is done; the text suggests no command", async () => {
  const x = setup(["A", "P"], ["A"]);
  try {
    x.engine.plan("P", { after: ["A"], by: "user" });
    approveQueue(x.store, "P");
    const { todo } = approvalNotice(x.queue("P"), { revision: 1 });
    assert.match(todo, /^It is in the plan \(.*\): Nexus starts it itself, so start nothing; tell the user if anything follows from the approval\.$/);
    assert.deepEqual(commandsIn(todo), []);
    assert.equal(x.queue("P").run, undefined);
    doneByHand(x.store, "A");
    await x.until("P started by Nexus and finished", () => x.queue("P").run?.state === "finished", LONGER.run);
  } finally { x.stop(); }
});

test("approvalNotice while the user is away, not in the plan: leave it for the user; a start and planning it are refused, as the text says", async () => {
  const x = setup(["U"]);
  try {
    await x.hello();
    away(true);
    const { todo } = approvalNotice(x.queue("U"), { revision: 1 }, true);
    assert.match(todo, /the user is away: until they are back, Nexus refuses to start it or put it into the plan .* Leave it for the user's return, and say so in the chat\.$/);
    assert.deepEqual(commandsIn(todo), []);
    await x.run(["run", "U", "start", "--reason", "test"], /the user is away: only the plan's next queue starts meanwhile/);
    await x.run(["run", "U", "start", "--next", "--reason", "test"], /the user is away: only the queues in the plan start meanwhile; queue U is approved but not in the plan/);
    assert.equal(x.queue("U").run, undefined);
    assert.equal(x.store.readPlan("U"), undefined);
  } finally { x.stop(); }
});

test("awayOnNotice: no start outside the plan and no approved queue put into it (both refused); the plan's next queue Nexus starts itself", async () => {
  const x = setup(["A", "B", "C"]);
  try {
    await x.hello();
    x.engine.plan("B", { after: ["A"], by: "user" });
    away(true);
    const { todo } = awayOnNotice({ until: readAway().current!.until! });
    assert.match(todo, /Nexus starts those itself, so start no queue outside the plan and put no approved queue into it \(Nexus refuses both\)\.$/);
    assert.deepEqual(commandsIn(todo), [], "the review command it names takes no --reason");
    await x.run(["run", "C", "start", "--reason", "test"], /the user is away: only the plan's next queue starts meanwhile, and Nexus starts it by itself; queue C is not in the plan/);
    await x.run(["run", "C", "start", "--after", "A", "--reason", "test"], /the user is away: only the queues in the plan start meanwhile; queue C is approved but not in the plan/);
    assert.equal(x.store.readPlan("C"), undefined);
    doneByHand(x.store, "A");
    await x.until("B started by Nexus and finished", () => x.queue("B").run?.state === "finished", LONGER.run);
    assert.equal(x.queue("C").run, undefined);
  } finally { x.stop(); }
});

test("planHeldNotice, the orchestrator's dependency: --after replaces it, cancel-start takes the queue out, a start without either starts it now, --next starts it", async () => {
  const x = setup(["A", "B", "Q", "R"]);
  try {
    await x.hello();
    for (const q of ["Q", "R"]) x.engine.plan(q, { after: ["A"], by: "orchestrator" });
    stopQueue(x.store, "A");
    await x.until("Q held", () => x.queue("Q").start?.blocked === true);
    const { todo } = planHeldNotice(x.queue("Q"), { queue: "A", by: "orchestrator", waiting: "queue A is stopped" });
    const [after, cancel, ...rest] = commandsIn(todo);
    assert.deepEqual([after, cancel, rest], ["run Q start --after <queue>...", "run Q cancel-start", []]);
    assert.match(todo, /\(or --next for none before it; without either the command starts the queue now, outside the plan\)/);

    await x.run(filled(after!, "B", false), /queue Q starts when queue B is done/);
    assert.deepEqual(x.store.readPlan("Q")?.after.map((e) => e.queue), ["B"], "the stopped A replaced");
    await x.run(filled(cancel!, "B", false), /queue Q/);
    await x.until("Q out of the plan", () => !x.queue("Q").start && !x.store.readPlan("Q")?.after.length);
    await x.run(["run", "Q", "start", "--reason", "test"], /queue Q started in session /);
    await x.until("Q to finish", () => x.queue("Q").run?.state === "finished", LONGER.run);
    await x.run(["run", "R", "start", "--next", "--reason", "test"], /queue R started now in session /);
    await x.until("R to finish", () => x.queue("R").run?.state === "finished", LONGER.run);
  } finally { x.stop(); }
});

test("planHeldNotice, the user's dependency: plan propose with and without --after records a proposal for the user", async () => {
  const x = setup(["A", "B", "Q"]);
  try {
    await x.hello();
    x.engine.plan("Q", { after: ["A"], by: "user" });
    stopQueue(x.store, "A");
    const { todo } = planHeldNotice(x.queue("Q"), { queue: "A", by: "user", waiting: "queue A is stopped" });
    assert.deepEqual(commandsIn(todo), ["plan propose Q [--after <queue>]..."]);
    await x.run(filled(commandsIn(todo)[0]!, "B", true), /propos/);
    await x.until("the proposal after B", () => x.store.readPlan("Q")?.proposal?.after.join() === "B");
    await x.run(filled(commandsIn(todo)[0]!, "B", false), /propos/);
    await x.until("the proposal with none before it", () => x.store.readPlan("Q")?.proposal?.after.length === 0);
    assert.deepEqual(x.store.readPlan("Q")?.after.map((e) => [e.queue, e.by]), [["A", "user"]], "the user's dependency stays until they decide");
  } finally { x.stop(); }
});

test("planHeldNotice while the user is away: --after is accepted (the queue is in the plan); a start without either is refused, as the text says", async () => {
  const x = setup(["A", "B", "Q"]);
  try {
    await x.hello();
    x.engine.plan("Q", { after: ["A"], by: "orchestrator" });
    stopQueue(x.store, "A");
    away(true);
    const { todo } = planHeldNotice(x.queue("Q"), { queue: "A", by: "orchestrator", waiting: "queue A is stopped" }, true);
    assert.match(todo, /\(or --next for none before it; without either Nexus refuses it while the user is away\)/);
    await x.run(["run", "Q", "start", "--reason", "test"], /the user is away: only the plan's next queue starts meanwhile, and Nexus starts it by itself; queue Q is not next in the plan/);
    assert.equal(x.queue("Q").run, undefined);
    await x.run(filled(commandsIn(todo)[0]!, "B", false), /queue Q starts when queue B is done/);
    assert.deepEqual(x.store.readPlan("Q")?.after.map((e) => e.queue), ["B"]);
  } finally { x.stop(); }
});
