// The language settings in what agents receive, against the fake runtimes (LG2): the worker's, the orchestrator's
// and the thinking partner's briefings name the languages of the project's effective settings; a project's own value
// wins over the global one; a change reaches a running worker at its next step or message (the step's opening and
// each inbox message carry the language line) and the orchestrator and a partner at their next message (their process
// is resumed with the new briefing). With the defaults every text is as before (also test/prompts.test.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ProjectStore, approveQueue, loadProjectState, readGlobalSettings, routeAnswers, sendMessage, updateSettings, writeGlobalSettings,
  type GlobalSettings, type StepDef,
} from "@nexus/protocol";
import { Engine } from "../src/engine.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import { Conversations } from "../src/conversations.ts";
import { WORKER_BRIEFING } from "../src/prompts.ts";
import { acceptReviews } from "./fake-reviewer.ts";
import { WAIT_MS, until as waitUntil, LONGER, WORK_MS } from "./wait.ts";

const here = dirname(fileURLToPath(import.meta.url));
process.env.NEXUS_CLAUDE = join(here, "fake-claude.ts");
process.env.NEXUS_CODEX = join(here, "fake-codex.ts");

const lines = (file: string | undefined) => (file && existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, any>) : []);
/** A Claude Code process's start: resumed or not, and its appended system prompt (the briefing). */
const claudeStart = (a: Record<string, any>) => {
  const argv = a.argv as string[];
  const i = argv.indexOf("--append-system-prompt");
  return { resume: argv.includes("--resume"), briefing: i >= 0 ? argv[i + 1]! : "" };
};
const setGlobal = (change: (g: GlobalSettings) => void) => { const g = readGlobalSettings(); change(g); writeGlobalSettings(g); };
const until = (what: string, pred: () => boolean, ms = WAIT_MS) => waitUntil(what, pred, ms);

function base() {
  const root = mkdtempSync(join(tmpdir(), "nexus-languages-"));
  process.env.NEXUS_HOME = join(root, "home");
  process.env.FAKE_LOG = join(root, "fake.log");
  process.env.FAKE_ARGS = join(root, "args.log");
  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  return { root, store, args: () => lines(process.env.FAKE_ARGS), heard: () => lines(process.env.FAKE_LOG).map((l) => l.text as string) };
}

function worker(steps: (Partial<StepDef> & { fake: string })[]) {
  const b = base();
  process.env.FAKE_SLOW_MS = WORK_MS;
  b.store.writeQueue({
    protocol: 1, id: "Q", title: "Queue", revision: 1, status: "proposed", stop_conditions: [], checks: [], approvals: [], withdrawals: [], history: [],
    steps: steps.map(({ fake, ...s }, i) => ({ id: `Q${i + 1}`, title: `Step ${i + 1}`, goal: `FAKE: ${fake}`, acceptance: [], ...s })),
  });
  approveQueue(b.store, "Q");
  const engine: Engine = new Engine(b.store, () => { routeAnswers(b.store); acceptReviews(b.store); engine.onChange(loadProjectState(b.store)); }, { retryBaseMs: 30, usageMarginMs: 100 });
  const queue = () => loadProjectState(b.store).queues.find((q) => q.id === "Q")!;
  const done = () => { engine.shutdown(); delete process.env.FAKE_SLOW_MS; };
  return { ...b, engine, queue, done };
}

const DANISH = "write what is meant for the user in Danish";
const FRENCH = "write what is meant for the user in French";

test("claude worker: the briefing, the step's opening and an inbox message carry the languages; the project's own reader's language wins; a change reaches the next message and step", async () => {
  const x = worker([{ fake: "slow" }, { fake: "done" }]);
  try {
    setGlobal((g) => { g.languages.reader = "hu"; });
    updateSettings(x.store, { languages: { reader: "da", working: "de" } });
    x.engine.start("Q", { runtime: "claude" });
    await until("Q1 to run", () => x.queue().steps[0]!.status === "running", LONGER.step);
    const first = claudeStart(x.args().find((a) => a.argv)!);
    assert.ok(first.briefing.startsWith(WORKER_BRIEFING), "the standing briefing");
    assert.ok(first.briefing.includes(DANISH), "the project's own reader's language, not the global Hungarian");
    assert.ok(first.briefing.includes("Work in German: files, code, comments, commit messages, context summaries"));
    assert.ok(!first.briefing.includes("Hungarian"));
    const opening = x.heard().find((t) => t.includes("step Q1 (1 of 2)"))!;
    assert.ok(opening.includes(DANISH), "the step's opening has the language line");

    // A change while Q1 runs: the next inbox message carries it at once; the next step's opening and briefing too.
    updateSettings(x.store, { languages: { reader: "fr" } });
    sendMessage(x.store, x.queue().run!.session, "A remark.", { queue: "Q", step: "Q1" });
    await until("the message", () => x.heard().some((t) => t.includes("A remark.")));
    const message = x.heard().find((t) => t.includes("A remark."))!;
    assert.ok(message.endsWith(`${FRENCH}: step summaries, questions, progress lines, stop and failure reasons, labels of review material. Work in German: files, code, comments, commit messages, context summaries (nexus context). Ids, commands and YAML keys stay as they are.`), message);

    await until("the run to finish", () => x.queue().run?.state === "finished", LONGER.run);
    const q2 = x.heard().find((t) => t.includes("step Q2 (2 of 2)"))!;
    assert.ok(q2.includes(FRENCH) && !q2.includes(DANISH), "Q2's opening: the new reader's language");
    const starts = x.args().filter((a) => a.argv).map(claudeStart);
    assert.deepEqual(starts.map((s) => [s.resume, s.briefing.includes(DANISH), s.briefing.includes(FRENCH)]), [[false, true, false], [true, false, true]],
      "the session resumed with the new briefing before Q2");
  } finally { x.done(); }
});

test("the global reader's language reaches a project that follows it; following again drops the project's own", async () => {
  const x = worker([{ fake: "slow" }, { fake: "done" }]);
  try {
    updateSettings(x.store, { languages: { reader: "da" } });
    x.engine.start("Q", { runtime: "claude" });
    await until("Q1 to run", () => x.queue().steps[0]!.status === "running", LONGER.step);
    setGlobal((g) => { g.languages.reader = "fr"; });
    updateSettings(x.store, { follow: ["languages.reader"] });
    await until("the run to finish", () => x.queue().run?.state === "finished", LONGER.run);
    const q2 = x.heard().find((t) => t.includes("step Q2 (2 of 2)"))!;
    assert.ok(q2.includes(FRENCH), "follows the global French");
    assert.ok(q2.includes("Work in English"), "the working language: the default");
  } finally { x.done(); }
});

test("codex worker: the developer instructions carry the languages", async () => {
  const x = worker([{ fake: "done" }]);
  try {
    setGlobal((g) => { g.languages.reader = "pl"; });
    x.engine.start("Q", { runtime: "codex" });
    await until("the run to finish", () => x.queue().run?.state === "finished", LONGER.run);
    const start = x.args().find((a) => a.method === "thread/start")!;
    assert.ok((start.instructions as string).startsWith(WORKER_BRIEFING));
    assert.ok((start.instructions as string).includes("write what is meant for the user in Polish"));
    assert.ok(x.heard().find((t) => t.includes("step Q1 (1 of 1)"))!.includes("in Polish"));
  } finally { x.done(); }
});

test("with the defaults the worker gets today's texts: no language line", async () => {
  const x = worker([{ fake: "slow" }, { fake: "done" }]);
  try {
    x.engine.start("Q", { runtime: "claude" });
    await until("Q1 to run", () => x.queue().steps[0]!.status === "running", LONGER.step);
    sendMessage(x.store, x.queue().run!.session, "A remark.", { queue: "Q", step: "Q1" });
    await until("the run to finish", () => x.queue().run?.state === "finished", LONGER.run);
    assert.deepEqual(x.args().filter((a) => a.argv).map((a) => claudeStart(a).briefing), [WORKER_BRIEFING]);
    assert.ok(x.heard().length >= 3 && x.heard().every((t) => !t.includes("Languages (")), "no opening or message names languages");
  } finally { x.done(); }
});

test("the orchestrator's briefing names the reader's language for its replies and queue text, and follows a change from its next message", async () => {
  const b = base();
  const engine = new Engine(b.store, () => {});
  const orchestrator = new Orchestrator(b.store, engine, () => {});
  const replies = () => orchestrator.view().chat.filter((c) => c.from === "orchestrator" && c.kind !== "tool").length;
  try {
    setGlobal((g) => { g.languages.reader = "de"; });
    orchestrator.say("first");
    await until("the first reply", () => replies() === 1);
    setGlobal((g) => { g.languages.reader = "it"; });
    orchestrator.say("second");
    await until("the second reply", () => replies() === 2);
    const starts = b.args().filter((a) => a.argv).map(claudeStart);
    assert.equal(starts.length, 2, "a new process for the second message");
    const [de, it] = starts.map((s) => s.briefing);
    assert.ok(de!.includes("The user talks with you in the dashboard's chat; write to them in German (Nexus's settings, the reader's language): your replies, and the text of the queues you draft"));
    assert.ok(de!.includes("Everything else you write into files is in English, the project's working language."));
    assert.ok(de!.includes("Queue YAML (ids and keys in English, the text in German):"));
    assert.ok(de!.includes("have it review the draft (tell it the queue's text is to be in German)"));
    assert.ok(!de!.includes("all text in English"));
    assert.ok(it!.includes("write to them in Italian") && it!.includes("the text in Italian"), "the changed setting, from the next message");
    assert.equal(starts[1]!.resume, true, "the conversation goes on");
  } finally { orchestrator.shutdown(); engine.shutdown(); }
});

test("without a reader's language the orchestrator's queue text is in the working language, as before", async () => {
  const b = base();
  const engine = new Engine(b.store, () => {});
  const orchestrator = new Orchestrator(b.store, engine, () => {});
  try {
    updateSettings(b.store, { languages: { working: "es" } });
    orchestrator.say("first");
    await until("the reply", () => orchestrator.view().chat.some((c) => c.from === "orchestrator"));
    const briefing = claudeStart(b.args().find((a) => a.argv)!).briefing;
    assert.ok(briefing.includes("reply in the language they write in. Everything you write into files or queues is in Spanish."));
    assert.ok(briefing.includes("Queue YAML (all text in Spanish):"));
  } finally { orchestrator.shutdown(); engine.shutdown(); }
});

test("a thinking partner replies in the reader's language and writes files in the working language, from its next message after a change", async () => {
  const b = base();
  const engine = new Engine(b.store, () => {});
  const orchestrator = new Orchestrator(b.store, engine, () => {});
  const conversations = new Conversations(b.store, orchestrator, () => {});
  const replies = (id: string) => b.store.readChat(id).entries.filter((e) => e.from === "partner").length;
  try {
    const c = conversations.create({ title: "Ideas" });
    conversations.say(c.id, "first");
    await until("the first reply", () => replies(c.id) === 1);
    updateSettings(b.store, { languages: { reader: "es", working: "fr" } });
    conversations.say(c.id, "second");
    await until("the second reply", () => replies(c.id) === 2);
    const [before, after] = b.args().filter((a) => a.argv).map((a) => claudeStart(a).briefing);
    assert.ok(before!.includes("Reply in the language the user writes in; anything you write into files is in English."), "the defaults: today's text");
    assert.ok(after!.includes("Reply in Spanish (Nexus's settings, the reader's language); anything you write into files is in French."));
  } finally { conversations.shutdown(); orchestrator.shutdown(); engine.shutdown(); }
});
