// The orchestrator against the fake `claude`: the chat, drafting a queue, starting its run, answering a worker's
// question, and being told when the run finishes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectStore, applyDraft, approveQueue, loadProjectState, routeAnswers, withdrawApproval } from "@nexus/protocol";
import { Engine } from "../src/engine.ts";
import { Orchestrator, type UserNotice } from "../src/orchestrator.ts";
import { longReply } from "./fake-behaviour.ts";
import { acceptReviews } from "./fake-reviewer.ts";
import { WAIT_MS, until as waitUntil, LONGER, untilAsync, WORK_MS } from "./wait.ts";

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

/** `again`: the root of an earlier setup, as after a server restart (same files, a new engine and orchestrator). */
function setup(again?: string, push?: (n: UserNotice) => void) {
  const root = again ?? mkdtempSync(join(tmpdir(), "nexus-orch-"));
  process.env.NEXUS_HOME = join(root, "home");
  process.env.FAKE_REVIEW_ACCEPT = "1"; // the fake orchestrator accepts each step waiting for its review
  if (!again) delete process.env.FAKE_LOG;
  const store = again ? ProjectStore.forRoot(root) : ProjectStore.init(root, { id: "p", name: "P", root });
  let orchestrator: Orchestrator;
  const engine: Engine = new Engine(store, () => tick());
  orchestrator = new Orchestrator(store, engine, () => tick(), { push });
  // Stands in for the server's file watcher.
  function tick() { routeAnswers(store); acceptReviews(store); orchestrator.onChange(loadProjectState(store)); engine.onChange(loadProjectState(store)); }
  const timer = setInterval(tick, 150);
  const state = () => loadProjectState(store);
  const until = (what: string, pred: () => boolean, ms = WAIT_MS) => waitUntil(what, pred, ms, () => `; chat: ${JSON.stringify(orchestrator.view().chat.slice(-4))}`);
  const stop = () => { clearInterval(timer); engine.shutdown(); orchestrator.shutdown(); };
  return { root, store, engine, orchestrator, state, until, stop };
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
    await until("the run to finish", () => state().queues.find((q) => q.id === "R")?.run?.state === "finished", LONGER.run);

    const s = state();
    const question = s.questions.find((x) => x.queue === "R")!;
    assert.equal(question.state, "answered");
    assert.equal(question.answers[0]!.by, "orchestrator");
    assert.equal(question.answers[0]!.text, "fake answer");
    assert.deepEqual(s.queues.find((q) => q.id === "R")!.steps.map((x) => x.status), ["done", "done"]);

    await until("the finish notice", () => orchestrator.view().chat.some((c) => c.from === "nexus" && /Queue R finished/.test(c.text)), LONGER.run);
    const chat = orchestrator.view().chat;
    assert.ok(chat.some((c) => c.from === "user"));
    assert.ok(chat.some((c) => c.from === "nexus" && /A worker asked a question in queue R, step R1/.test(c.text)));
  } finally { stop(); }
});

test("the orchestrator's long reply reaches its chat file whole", async () => {
  const { store, orchestrator, until, stop } = setup();
  try {
    const reply = longReply("Reply");
    assert.ok(reply.length >= 3000);
    orchestrator.say("FAKE-LONG");
    await until("the reply", () => orchestrator.view().chat.some((c) => c.from === "orchestrator" && c.kind === "message"));
    const { readFileSync } = await import("node:fs");
    const file = join(store.sessionDir(orchestrator.session()!.id), "chat.jsonl");
    const texts = readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as { from: string; kind: string; text: string })
      .filter((c) => c.from === "orchestrator" && c.kind === "message").map((c) => c.text);
    assert.deepEqual(texts, [reply], "byte for byte, no ellipsis");
    // The activity log may keep a short form; the chat may not.
    const activity = readFileSync(join(store.sessionDir(orchestrator.session()!.id), "activity.jsonl"), "utf8");
    assert.ok(activity.includes("…") && !activity.includes("nothing after this line was cut"), "the activity log is clipped");
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

test("the orchestrator gets Nexus's helper agents, which only read", async () => {
  const { orchestrator, until, stop } = setup();
  const args = join(process.env.NEXUS_HOME!, "..", "args.log");
  process.env.FAKE_ARGS = args;
  try {
    orchestrator.say("Hello");
    await until("the process to start", () => existsSync(args), LONGER.step);
    const { readFileSync } = await import("node:fs");
    const argv = (JSON.parse(readFileSync(args, "utf8").trim().split("\n")[0]!) as { argv: string[] }).argv;
    assert.ok(argv.slice(argv.indexOf("--allowedTools") + 1).includes("Agent"), "it may call subagents");
    const agents = JSON.parse(readFileSync(argv[argv.indexOf("--agents") + 1]!, "utf8")) as Record<string, { tools: string[] }>;
    assert.deepEqual(Object.keys(agents).sort(), ["question-triage", "queue-reviewer", "run-digest"]);
    for (const [name, a] of Object.entries(agents)) {
      assert.ok(a.tools.every((t) => ["Read", "Grep", "Glob"].includes(t)), `${name} only reads (no Bash, so no nexus commands)`);
    }
  } finally { stop(); delete process.env.FAKE_ARGS; }
});

test("the orchestrator may write only queue drafts, and its briefing uploads them from files", async () => {
  const { orchestrator, until, stop } = setup();
  const args = join(process.env.NEXUS_HOME!, "..", "args.log");
  process.env.FAKE_ARGS = args;
  try {
    orchestrator.say("Hello");
    await until("the process to start", () => existsSync(args), LONGER.step);
    const { readFileSync } = await import("node:fs");
    const argv = (JSON.parse(readFileSync(args, "utf8").trim().split("\n")[0]!) as { argv: string[] }).argv;
    assert.equal(argv[argv.indexOf("--permission-mode") + 1], "dontAsk");
    const allowed = argv.slice(argv.indexOf("--allowedTools") + 1);
    assert.ok(allowed.includes("Write(.nexus/drafts/**)") && allowed.includes("Edit(.nexus/drafts/**)"), "drafts are writable");
    const writes = allowed.filter((t) => /^(Write|Edit|MultiEdit|NotebookEdit)\b/.test(t));
    assert.deepEqual(writes.sort(), ["Edit(.nexus/drafts/**)", "Write(.nexus/drafts/**)"], "nothing else is writable");
    const disallowed = argv[argv.indexOf("--disallowedTools") + 1]!.split(",");
    assert.deepEqual(disallowed.sort(), ["MultiEdit", "NotebookEdit"], "a Write or Edit rule here would beat the drafts rules (so no .nexus deny rules either: those are the workers')");
    const brief = argv[argv.indexOf("--append-system-prompt") + 1]!;
    assert.match(brief, /nexus queue draft \.nexus\/drafts\//);
    assert.doesNotMatch(brief, /<<|heredoc/i);
    assert.match(brief, /no cd, no &&, no pipes/);
    // Housekeeping is its own; consent is the user's; a replaced stopped step is kept and skipped.
    assert.match(brief, /nexus queue set <queue> --step <step> skipped --reason/);
    assert.match(brief, /Consent is the user's, and refused to you: marking a step done[^.]*, approving, lifting a stop, reopening a finished step/);
    assert.match(brief, /keep that step in the draft[\s\S]*skip it with nexus queue set/);
    assert.doesNotMatch(brief, /may not edit files|read only, like you/);
  } finally { stop(); delete process.env.FAKE_ARGS; }
});

test("the orchestrator drafts and then revises a queue from one file under .nexus/drafts/", async () => {
  const { store, orchestrator, state, until, stop } = setup();
  try {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const drafts = join(store.dir, "drafts");
    mkdirSync(drafts, { recursive: true });
    writeFileSync(join(drafts, "R.yaml"), QUEUE);
    // A relative path: the orchestrator runs in the project's root.
    orchestrator.say(`FAKE-NEXUS: ["queue","draft",".nexus/drafts/R.yaml"]`);
    await until("the drafted queue", () => orchestrator.view().chat.some((c) => /queue R created as proposed \(revision 1\)/.test(c.text)));
    writeFileSync(join(drafts, "R.yaml"), QUEUE.replace("acceptance: [Done]", "acceptance: [Done, Twice]"));
    orchestrator.say(`FAKE-NEXUS: ["queue","draft",".nexus/drafts/R.yaml"]`);
    await until("the revision", () => orchestrator.view().chat.some((c) => /queue R updated to revision 2/.test(c.text)));
    assert.deepEqual(state().queues.find((q) => q.id === "R")!.steps[1]!.acceptance, ["Done", "Twice"]);
  } finally { stop(); }
});

test("only the user or an orchestrator may update or stop updating the Nexus server", async () => {
  const { store, stop } = setup();
  try {
    const { execFileSync } = await import("node:child_process");
    const cli = join(dirname(fileURLToPath(import.meta.url)), "../../../packages/cli/bin/nexus.js");
    for (const role of ["worker", "conversation"] as const) {
      store.writeSession({ protocol: 1, id: `s-${role}`, project: "p", role, runtime: "external", cwd: store.dir, launched_by: "external", created_at: new Date().toISOString() });
      for (const sub of ["update", "cancel"]) {
        assert.throws(
          () => execFileSync(process.execPath, [cli, "server", sub], { env: { ...process.env, NEXUS_SESSION: `s-${role}`, NEXUS_DIR: store.dir, NEXUS_PORT: "1" }, stdio: "pipe" }),
          (e: { stderr: Buffer }) => new RegExp(`only the user or an orchestrator may ${sub}`).test(e.stderr.toString()),
          `${role} ${sub}`,
        );
      }
    }
  } finally { stop(); }
});

// ---------------------------------------------------------------- approvals, withdrawals and reached pauses

type Setup = ReturnType<typeof setup>;
const queueDef = (id: string, goals: string[]) =>
  ({ id, title: "Told", steps: goals.map((g, i) => ({ id: `${id}${i + 1}`, title: `Step ${i + 1}`, goal: `FAKE: ${g}`, acceptance: ["Done"] })) });
const facts = (o: Orchestrator) => o.view().chat.filter((c) => c.from === "nexus").map((c) => c.text);
const runOf = (x: Setup, id: string) => x.state().queues.find((q) => q.id === id)?.run;
/** Several ticks: anything told twice would show by now. */
const settle = () => new Promise((r) => setTimeout(r, 700));
/** What reached the fake orchestrator (FAKE_LOG). */
async function delivered(): Promise<string[]> {
  const { readFileSync } = await import("node:fs");
  const file = process.env.FAKE_LOG!;
  return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => (JSON.parse(l) as { text: string }).text) : [];
}

test("approvals and withdrawals are told once each, by their position, the chat showing only the fact", async () => {
  const { root, store, orchestrator, until, stop } = setup();
  process.env.FAKE_LOG = join(root, "fake.log");
  try {
    orchestrator.say("Hello");
    await until("the session", () => !!orchestrator.session());
    applyDraft(store, queueDef("A", ["done"]));
    approveQueue(store, "A");
    await until("the approval", () => facts(orchestrator).includes("Queue A revision 1 approved."));
    withdrawApproval(store, "A", "not yet");
    await until("the withdrawal", () => facts(orchestrator).some((t) => t.includes("withdrew")));
    approveQueue(store, "A");
    await until("the second approval", () => facts(orchestrator).filter((t) => t === "Queue A revision 1 approved.").length === 2);
    applyDraft(store, queueDef("A", ["done", "done"]));
    approveQueue(store, "A");
    await until("revision 2", () => facts(orchestrator).includes("Queue A revision 2 approved."));
    await settle();
    assert.deepEqual(facts(orchestrator), [
      "Queue A revision 1 approved.",
      "The user withdrew the approval of queue A revision 1: not yet",
      "Queue A revision 1 approved.",
      "Queue A revision 2 approved.",
    ]);
    // The chat shows the facts before the orchestrator's process has them (they reach it once its turn is over): wait
    // for the deliveries themselves, which are what is checked (queue TS1).
    await untilAsync("the deliveries", async () => (await delivered()).filter((t) => t.startsWith("[Nexus] Queue A revision")).length >= 3, LONGER.step);
    const sent = (await delivered()).filter((t) => t.startsWith("[Nexus] Queue A revision"));
    assert.equal(sent.length, 3);
    assert.ok(sent.every((t) => /If the plan puts it next, start it now; otherwise tell the user why not/.test(t)), "no run yet: start it");
  } finally { stop(); }
});

test("approving a halted queue's new revision says resume: the run goes on under it; a stopped one's is archived: start", async () => {
  for (const [first, told] of [
    ["fail", /Its run is halted at step H1\. If the plan puts it next, resume it now \(it goes on under this revision\)/],
    ["stop", /Queue H revision 2 approved\. If the plan puts it next, start it now/],
  ] as const) {
    const x = setup();
    process.env.FAKE_LOG = join(x.root, "fake.log");
    try {
      x.orchestrator.say("Hello");
      await x.until("the session", () => !!x.orchestrator.session());
      applyDraft(x.store, queueDef("H", [first, "done"]));
      approveQueue(x.store, "H");
      x.engine.start("H");
      await x.until("the halt", () => runOf(x, "H")?.state === "halted", LONGER.run);
      applyDraft(x.store, { ...queueDef("H", [first, "done"]), stop_conditions: ["Changed."] });
      approveQueue(x.store, "H");
      await x.until("the approval", () => facts(x.orchestrator).includes("Queue H revision 2 approved."));
      await untilAsync("its delivery", async () => (await delivered()).some((t) => t.startsWith("[Nexus] Queue H revision 2 approved.")), LONGER.step);
      const sent = (await delivered()).find((t) => t.startsWith("[Nexus] Queue H revision 2 approved."));
      assert.match(sent ?? "", told, first);
      if (first === "fail") {
        x.engine.resume("H"); // the run of revision 1 goes on with its step (which fails again)
        await x.until("the step again", () => runOf(x, "H")?.state === "halted" && x.state().queues.find((q) => q.id === "H")!.steps[0]!.segments.length === 2);
      } else assert.throws(() => x.engine.resume("H"), /no run/);
    } finally { x.stop(); }
  }
});

test("a requested pause reached is told once with its step; a stop, a restart's and an update's pauses are not", async () => {
  process.env.FAKE_SLOW_MS = WORK_MS;
  const first = setup();
  let second: Setup | undefined;
  let third: Setup | undefined;
  const working = (x: Setup) => runOf(x, "P")?.state === "running" && !x.engine.idle();
  try {
    const { store, engine, orchestrator, until } = first;
    orchestrator.say("Hello");
    await until("the session", () => !!orchestrator.session());
    applyDraft(store, queueDef("P", ["slow", "slow", "slow", "slow", "slow"]));
    approveQueue(store, "P");
    engine.start("P");
    await until("step 1 working", () => working(first));
    engine.pause("P");
    await until("the pause", () => facts(orchestrator).includes("Run of P paused after step P1."), LONGER.run);

    // A stop: nothing.
    engine.resume("P");
    await until("step 2 working", () => working(first));
    engine.stopNow("P");
    await until("stopped", () => runOf(first, "P")?.state === "paused" && engine.idle(), LONGER.run);
    await settle();
    assert.deepEqual(facts(orchestrator).filter((t) => t.startsWith("Run of")), ["Run of P paused after step P1."]);

    // A server restart while it runs: paused by the restart, nothing told; the same session repeats nothing.
    engine.resume("P");
    await until("working again", () => working(first));
    const before = facts(orchestrator);
    first.stop();
    second = setup(first.root);
    const s2 = second;
    await until("the restart's pause", () => /restarted/.test(runOf(s2, "P")?.reason ?? ""), LONGER.run);
    await settle();
    assert.equal(s2.orchestrator.session()!.id, orchestrator.session()!.id, "the same orchestrator session");
    assert.deepEqual(facts(s2.orchestrator), before, "nothing new, nothing repeated");

    // An update: the hold before it is not told; an approval during the drain is told once, after the restart.
    s2.engine.resume("P");
    await s2.until("working for the update", () => working(s2));
    s2.engine.drainForUpdate(false);
    applyDraft(s2.store, queueDef("D", ["done"]));
    approveQueue(s2.store, "D");
    await s2.until("the hold", () => runOf(s2, "P")?.state === "paused" && s2.engine.idle(), LONGER.run);
    await settle();
    assert.ok(!facts(s2.orchestrator).includes("Queue D revision 1 approved."), "not during the drain");
    s2.stop();
    third = setup(first.root);
    const s3 = third;
    await s3.until("the approval after the restart", () => facts(s3.orchestrator).includes("Queue D revision 1 approved."));
    await s3.until("the resumed run", () => ["running", "finished"].includes(runOf(s3, "P")?.state ?? ""));
    await settle();
    const all = facts(s3.orchestrator);
    assert.equal(all.filter((t) => t === "Queue D revision 1 approved.").length, 1);
    assert.deepEqual(all.filter((t) => t.startsWith("Run of")), ["Run of P paused after step P1."], "no pause but the requested one");
  } finally { first.stop(); second?.stop(); third?.stop(); delete process.env.FAKE_SLOW_MS; }
});

// ---------------------------------------------------------------- housekeeping: nexus queue set

/** The steps the engine opened for a queue, in order (from what reached the fake runtimes). */
async function opened(queue: string): Promise<string[]> {
  // A step turn reads "[Nexus] Queue P "title" (revision 1, approved), step P1 (1 of 3): ..."; notices to the orchestrator differ.
  return (await delivered()).flatMap((t) => {
    const m = t.startsWith(`[Nexus] Queue ${queue} "`) ? /\), step (\S+) \(\d+ of \d+\)/.exec(t) : null;
    return m ? [m[1]!] : [];
  });
}
const said = (o: Orchestrator, re: RegExp) => o.view().chat.some((c) => re.test(c.text));

test("the orchestrator skips the stopped step a new revision replaced; then a start runs the new steps", async () => {
  const x = setup();
  process.env.FAKE_LOG = join(x.root, "fake.log");
  try {
    applyDraft(x.store, queueDef("S", ["done", "stop", "done"]));
    approveQueue(x.store, "S");
    x.engine.start("S");
    await x.until("the stop", () => runOf(x, "S")?.state === "halted", LONGER.run);
    // Revision 2 keeps the stopped step and adds its replacement; the user approves it (which lifts the stop).
    const def = queueDef("S", ["done", "stop", "done"]);
    applyDraft(x.store, { ...def, steps: [def.steps[0], def.steps[1], { id: "S2b", title: "Instead", goal: "FAKE: done", acceptance: ["Done"] }, def.steps[2]] });
    approveQueue(x.store, "S");
    x.orchestrator.say(`FAKE-NEXUS: ["queue","set","S","--step","S2","skipped","--reason","replaced by S2b"]`);
    await x.until("the skip", () => said(x.orchestrator, /step S\/S2 skipped \(was pending\)/));
    x.engine.start("S");
    await x.until("the run to finish", () => runOf(x, "S")?.state === "finished", LONGER.run);
    assert.deepEqual(await opened("S"), ["S1", "S2", "S2b", "S3"], "S2 ran once, before the stop; after the skip only the new steps");
    const q = x.state().queues.find((y) => y.id === "S")!;
    assert.deepEqual(q.steps.map((st) => st.status), ["done", "skipped", "done", "done"]);
    assert.deepEqual(q.changes.map((c) => [c.kind, c.by, c.step ?? null]), [["lift", "user_approval", null], ["status", "orchestrator", "S2"]]);
  } finally { x.stop(); }
});

test("the orchestrator skips a pending step of a running queue; the engine never opens it", async () => {
  // P1 works long enough for the orchestrator's turn that skips P2 to land before P1 ends: on a busy machine a 2.5 s
  // step was over before the skip, or before a look caught it running (queue TS1).
  process.env.FAKE_SLOW_MS = String(WAIT_MS);
  const x = setup();
  process.env.FAKE_LOG = join(x.root, "fake.log");
  try {
    applyDraft(x.store, queueDef("P", ["slow", "done", "done"]));
    approveQueue(x.store, "P");
    x.engine.start("P");
    await x.until("the first step to begin", () => x.state().queues.find((q) => q.id === "P")!.steps[0]!.segments.length > 0, LONGER.step);
    x.orchestrator.say(`FAKE-NEXUS: ["queue","set","P","--step","P2","skipped","--reason","done elsewhere: queue M, step M3"]`);
    await x.until("the skip", () => said(x.orchestrator, /step P\/P2 skipped/));
    await x.until("the run to finish", () => runOf(x, "P")?.state === "finished", LONGER.run);
    assert.deepEqual(await opened("P"), ["P1", "P3"]);
  } finally { x.stop(); delete process.env.FAKE_SLOW_MS; }
});

test("the orchestrator closes a halted run of a queue whose steps are all done or skipped: run.yaml finished, and an entry", async () => {
  const x = setup();
  process.env.FAKE_LOG = join(x.root, "fake.log");
  try {
    applyDraft(x.store, queueDef("H", ["done", "fail"]));
    approveQueue(x.store, "H");
    x.engine.start("H");
    await x.until("the halt", () => runOf(x, "H")?.state === "halted", LONGER.run);
    x.orchestrator.say(`FAKE-NEXUS: ["queue","set","H","finished","--reason","the queue is done"]`);
    await x.until("the refusal", () => said(x.orchestrator, /not done or skipped: H2 \(failed\)/));
    x.orchestrator.say(`FAKE-NEXUS: ["queue","set","H","--step","H2","skipped","--reason","fixed by hand in the editor"]`);
    await x.until("the skip", () => x.state().queues.find((q) => q.id === "H")!.status === "done");
    x.orchestrator.say(`FAKE-NEXUS: ["queue","set","H","finished","--reason","the queue is done"]`);
    await x.until("the run closed", () => runOf(x, "H")?.state === "finished");
    const q = x.state().queues.find((y) => y.id === "H")!;
    assert.deepEqual(q.changes.at(-1)!.kind, "run");
    assert.deepEqual([q.changes.at(-1)!.from, q.changes.at(-1)!.to], ["halted", "finished"]);
    assert.ok(!x.state().attention.some((a) => a.queue === "H"), "nothing waits for the user");
  } finally { x.stop(); }
});

test("a cancel by the orchestrator reaches the user as a push notification, with no waiting-list item", async () => {
  const sent: UserNotice[] = [];
  const x = setup(undefined, (n) => sent.push(n));
  try {
    applyDraft(x.store, queueDef("C", ["done"]));
    approveQueue(x.store, "C");
    x.orchestrator.say(`FAKE-NEXUS: ["queue","set","C","cancelled","--reason","superseded by queue D"]`);
    await x.until("the cancel", () => x.state().queues.find((q) => q.id === "C")!.status === "cancelled");
    await x.until("the notification", () => sent.length > 0);
    assert.equal(sent.length, 1);
    assert.match(sent[0]!.title, /P: queue cancelled/);
    assert.match(sent[0]!.body, /C cancelled by the orchestrator: superseded by queue D/);
    assert.ok(!x.state().attention.some((a) => a.queue === "C"));
    assert.throws(() => x.engine.start("C"), /cancelled/);
  } finally { x.stop(); }
});

test("a proposal to lift a stop is recorded for the user, and a lift clears it", async () => {
  const x = setup();
  process.env.FAKE_LOG = join(x.root, "fake.log");
  try {
    applyDraft(x.store, queueDef("L", ["stop1", "done"]));
    approveQueue(x.store, "L");
    x.orchestrator.say(`FAKE-NEXUS: ["queue","set","L","propose-lift","--reason","early"]`);
    await x.until("the refusal", () => said(x.orchestrator, /queue L is not stopped/));
    x.engine.start("L");
    await x.until("the stop", () => runOf(x, "L")?.state === "halted", LONGER.run);
    x.orchestrator.say(`FAKE-NEXUS: ["queue","set","L","propose-lift","--reason","the art is in the shared folder now"]`);
    await x.until("the proposal", () => !!x.state().queues.find((q) => q.id === "L")!.lift_proposal);
    assert.equal(x.state().queues.find((q) => q.id === "L")!.lift_proposal!.reason, "the art is in the shared folder now");
    const def = queueDef("L", ["stop1", "done"]);
    applyDraft(x.store, { ...def, steps: [def.steps[0], { ...def.steps[1]!, title: "Then the rest" }] });
    approveQueue(x.store, "L");
    const q = x.state().queues.find((y) => y.id === "L")!;
    assert.equal(q.lift_proposal, undefined);
    assert.equal(q.status, "approved");
  } finally { x.stop(); }
});

test("the orchestrator is told once that the user lifted a stop with Continue", async () => {
  const x = setup();
  process.env.FAKE_LOG = join(x.root, "fake.log");
  try {
    x.orchestrator.say("Hello");
    await x.until("the session", () => !!x.orchestrator.session());
    applyDraft(x.store, queueDef("K", ["stop1", "done"]));
    approveQueue(x.store, "K");
    x.engine.start("K");
    await x.until("the stop", () => runOf(x, "K")?.state === "halted", LONGER.run);
    x.engine.continueQueue("K");
    await x.until("the run to finish", () => runOf(x, "K")?.state === "finished", LONGER.run);
    await x.until("the notice", () => facts(x.orchestrator).some((t) => /lifted the stop of queue K with Continue/.test(t)));
    await untilAsync("its delivery", async () => (await delivered()).some((t) => t.startsWith("[Nexus] The user lifted the stop of queue K")), LONGER.step);
    await settle(); // and nothing more after it
    assert.equal(facts(x.orchestrator).filter((t) => /lifted the stop of queue K with Continue/.test(t)).length, 1, "in the chat once");
    const sent = (await delivered()).filter((t) => t.startsWith("[Nexus] The user lifted the stop of queue K with Continue (the stop was: fake condition: fake stop); its run goes on. Nothing to start"));
    assert.equal(sent.length, 1, "to the orchestrator once");
  } finally { x.stop(); }
});
