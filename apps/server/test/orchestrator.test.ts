// The orchestrator against the fake `claude`: the chat, drafting a queue, starting its run, answering a worker's
// question, and being told when the run finishes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectStore, approveQueue, loadProjectState, routeAnswers } from "@nexus/protocol";
import { Engine } from "../src/engine.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import { longReply } from "./fake-behaviour.ts";

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
    await until("the process to start", () => existsSync(args));
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
    await until("the process to start", () => existsSync(args));
    const { readFileSync } = await import("node:fs");
    const argv = (JSON.parse(readFileSync(args, "utf8").trim().split("\n")[0]!) as { argv: string[] }).argv;
    assert.equal(argv[argv.indexOf("--permission-mode") + 1], "dontAsk");
    const allowed = argv.slice(argv.indexOf("--allowedTools") + 1);
    assert.ok(allowed.includes("Write(.nexus/drafts/**)") && allowed.includes("Edit(.nexus/drafts/**)"), "drafts are writable");
    const writes = allowed.filter((t) => /^(Write|Edit|MultiEdit|NotebookEdit)\b/.test(t));
    assert.deepEqual(writes.sort(), ["Edit(.nexus/drafts/**)", "Write(.nexus/drafts/**)"], "nothing else is writable");
    const disallowed = argv[argv.indexOf("--disallowedTools") + 1]!.split(",");
    assert.deepEqual(disallowed.sort(), ["MultiEdit", "NotebookEdit"], "a Write or Edit rule here would beat the drafts rules");
    const brief = argv[argv.indexOf("--append-system-prompt") + 1]!;
    assert.match(brief, /nexus queue draft \.nexus\/drafts\//);
    assert.doesNotMatch(brief, /<<|heredoc/i);
    assert.match(brief, /no cd, no &&, no pipes/);
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
