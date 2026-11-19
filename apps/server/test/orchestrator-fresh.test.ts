// The orchestrator's context care against the fake `claude` (queue CC): when its context is fuller than its threshold at
// the end of a turn, it is asked once for a summary, and a fresh orchestrator session goes on from it, its first message
// the summary, what to do, and `nexus status`. FAKE_CONTEXT_FILL_FILE sets the fill each turn reports (fake-behaviour.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectStore, answerAsUser, loadProjectState, routeAnswers } from "@nexus/protocol";
import { Engine } from "../src/engine.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import { WAIT_MS, until as waitUntil, untilAsync, sleep } from "./wait.ts";

process.env.NEXUS_CLAUDE = join(dirname(fileURLToPath(import.meta.url)), "fake-claude.ts");

const ASKED = /^\[Nexus\] Your context holds /;
const SEED = "[Nexus] You go on as the project's orchestrator in a fresh session";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "nexus-fresh-"));
  process.env.NEXUS_HOME = join(root, "home");
  process.env.FAKE_LOG = join(root, "fake.log");
  process.env.FAKE_CONTEXT_FILL_FILE = join(root, "fill");
  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  const engine: Engine = new Engine(store, () => tick());
  const orchestrator = new Orchestrator(store, engine, () => tick());
  // Stands in for the server's file watcher.
  function tick() { routeAnswers(store); orchestrator.onChange(loadProjectState(store)); engine.onChange(loadProjectState(store)); }
  const timer = setInterval(tick, 150);
  const fill = (x: number) => writeFileSync(join(root, "fill"), String(x));
  /** What reached the fake orchestrator (FAKE_LOG), with the session it reached. */
  type Sent = { text: string; session: string; priority: string | null };
  const log = (): Sent[] => (existsSync(process.env.FAKE_LOG!)
    ? readFileSync(process.env.FAKE_LOG!, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Sent)
    : []);
  const until = (what: string, pred: () => boolean, ms = WAIT_MS) => waitUntil(what, pred, ms, () => `; chat: ${JSON.stringify(orchestrator.view().chat.slice(-4))}`);
  const replies = () => orchestrator.view().chat.filter((c) => c.from === "orchestrator").length;
  const stop = () => {
    clearInterval(timer); engine.shutdown(); orchestrator.shutdown();
    for (const k of ["FAKE_LOG", "FAKE_CONTEXT_FILL_FILE", "FAKE_CONTEXT_WINDOW", "FAKE_NO_SUMMARY", "FAKE_CHAT_SLOW_MS", "FAKE_SUMMARY_MS", "FAKE_LATE_NEXT", "FAKE_RELEASE"]) delete process.env[k];
  };
  return { root, store, orchestrator, fill, log, until, replies, stop };
}

test("below its threshold the orchestrator's session goes on as it is", async () => {
  const x = setup();
  try {
    x.fill(0.8);
    x.orchestrator.say("Hello");
    await x.until("the reply", () => x.replies() === 1);
    const first = x.orchestrator.session()!.id;
    x.orchestrator.say("Again");
    await x.until("the second reply", () => x.replies() === 2);
    await sleep(700);
    assert.equal(x.orchestrator.session()!.id, first);
    assert.ok(!x.log().some((l) => ASKED.test(l.text)), "no summary asked for");
    assert.ok(!x.store.readApplied(first).entries.some((a) => a.event.startsWith("context:")));
  } finally { x.stop(); }
});

test("with a 1M window its default threshold is 500k tokens: 490k goes on, 510k asks for the summary", async () => {
  process.env.FAKE_CONTEXT_WINDOW = "1000000";
  const x = setup();
  try {
    x.fill(0.49);
    x.orchestrator.say("Hello");
    await x.until("the reply", () => x.replies() === 1);
    const first = x.orchestrator.session()!.id;
    await sleep(700);
    assert.ok(!x.log().some((l) => ASKED.test(l.text)), "490k: no summary asked for");
    x.fill(0.51);
    x.orchestrator.say("Again");
    await untilAsync("the request", async () => x.log().some((l) => ASKED.test(l.text)), WAIT_MS);
    const asked = x.log().find((l) => ASKED.test(l.text))!;
    assert.equal(asked.session, first);
    assert.match(asked.text, /holds 510k tokens \(the threshold is 500k tokens\)/);
  } finally { x.stop(); }
});

test("above its threshold, after an idle turn, it is asked once for a summary and goes on in a fresh session; answers follow", async () => {
  const x = setup();
  try {
    // The old session asks the user a question before its context fills.
    x.fill(0.3);
    x.orchestrator.say(`FAKE-NEXUS: ["ask","Which plan?","--option","A","--option","B"]`);
    await x.until("the question", () => loadProjectState(x.store).questions.some((q) => q.text === "Which plan?"));
    await x.until("the reply", () => x.replies() >= 1);
    const old = x.orchestrator.session()!;

    x.fill(0.9);
    x.orchestrator.say("Hello");
    await x.until("the fresh session", () => x.orchestrator.session()?.id !== old.id);
    const fresh = x.orchestrator.session()!;
    assert.equal(fresh.continues, old.id);
    assert.equal(x.store.readSession(old.id).continued_by, fresh.id);
    assert.equal(x.store.readProject().orchestrator?.session, fresh.id);

    // The request went to the old session once; the old chat says why.
    const asked = x.log().filter((l) => ASKED.test(l.text));
    assert.equal(asked.length, 1);
    assert.equal(asked[0]!.session, old.id);
    assert.match(asked[0]!.text, /holds 900 tokens \(the threshold is 800 tokens\).*nexus context/);
    const oldChat = x.store.readChat(old.id).entries.filter((c) => c.from === "nexus").map((c) => c.text);
    assert.ok(oldChat.some((t) => t.startsWith("The orchestrator's context is 900 tokens (90 % full; its threshold is 800 tokens)")), oldChat.join("\n"));
    assert.ok(oldChat.includes(`The orchestrator goes on in a fresh session (${fresh.id}).`));

    // The fresh session's first message: the summary, the instruction and the project's state as nexus status shows it.
    await x.until("the seed", () => x.log().some((l) => l.session === fresh.id));
    const seed = x.log().find((l) => l.session === fresh.id)!.text;
    assert.ok(seed.startsWith(SEED), seed);
    assert.match(seed, /context was 90 % full/);
    assert.match(seed, /Its summary, written for you at the switch[^\n]*\nfake orchestrator summary\nTopics: plan, promises\nFiles: docs\/plan\.md/);
    assert.match(seed, /Your briefing \(the system prompt\) is the current one/);
    assert.match(seed, /The project now \(nexus status\):\nproject P \(p\)\n\nQueues \(0 open; finished: none\)/);
    assert.match(seed, /Open questions \(1\)\n- \S+ \[open\] : Which plan\?/);
    const md = readFileSync(x.store.orchestratorSummaryFile, "utf8");
    assert.match(md, new RegExp(`^# Orchestrator summary\\n\\nWritten by orchestrator session ${old.id} at .*context was 90 % full\\. The fresh session ${fresh.id} started from it\\.\\n\\nfake orchestrator summary\\n\\nTopics: plan, promises\\nFiles: docs/plan\\.md\\n$`));
    assert.ok(x.store.readChat(fresh.id).entries.some((c) => c.from === "nexus" && c.text.startsWith("A fresh orchestrator session: the previous one's context was 90 % full. It starts from the summary")));

    // The chat view: the fresh session's chat, and above it the old one's with its switch (the dashboard's one chat).
    const view = x.orchestrator.view();
    assert.equal(view.session?.id, fresh.id);
    assert.deepEqual(view.earlier.map((b) => b.session), [old.id]);
    assert.ok(view.earlier[0]!.chat.some((c) => c.from === "user" && c.text === "Hello"));
    assert.equal(view.earlier[0]!.switch.fill, 0.9);
    assert.equal(view.earlier[0]!.switch.tokens, 900, "its context tokens then");
    assert.equal(view.earlier[0]!.switch.at, fresh.created_at);
    assert.deepEqual(view.earlier[0]!.switch.summary && { ...view.earlier[0]!.switch.summary, at: "" }, { text: "fake orchestrator summary", topics: ["plan", "promises"], files: ["docs/plan.md"], at: "" });

    // Its first turn ended as full: it is not switched again (another would be no emptier).
    await x.until("the seed's reply", () => x.store.readChat(fresh.id).entries.some((c) => c.from === "orchestrator"));
    x.orchestrator.say("Still there?");
    await x.until("the reply", () => x.store.readChat(fresh.id).entries.filter((c) => c.from === "orchestrator").length >= 2);
    await sleep(700);
    assert.equal(x.orchestrator.session()!.id, fresh.id);
    assert.equal(x.log().filter((l) => ASKED.test(l.text)).length, 1, "asked once");

    // The user's answer to the old session's question goes to the fresh session.
    const qid = loadProjectState(x.store).questions.find((q) => q.text === "Which plan?")!.qid;
    answerAsUser(x.store, qid, "A");
    await x.until("the answer delivered", () => x.log().some((l) => l.text.startsWith("[Nexus] Answer from the user to your question \"Which plan?\"")));
    const answer = x.log().find((l) => l.text.startsWith("[Nexus] Answer from the user"))!;
    assert.equal(answer.session, fresh.id);
    assert.ok(!x.store.readInbox(old.id).entries.some((m) => m.type === "answer"), "nothing in the old session's inbox");
    assert.ok(x.store.readInbox(fresh.id).entries.some((m) => m.type === "answer" && m.qid === qid));
    assert.ok(x.store.readChat(fresh.id).entries.some((c) => c.from === "nexus" && c.text === "The user answered the orchestrator's question \"Which plan?\":\nA"));
  } finally { x.stop(); }
});

test("without a summary the fresh session still starts, from nexus status, and a line says so", async () => {
  process.env.FAKE_NO_SUMMARY = "1";
  const x = setup();
  try {
    x.fill(0.95);
    x.orchestrator.say("Hello");
    const old = x.orchestrator.session()!;
    await x.until("the fresh session", () => x.orchestrator.session()?.id !== old.id);
    const fresh = x.orchestrator.session()!;
    await x.until("the seed", () => x.log().some((l) => l.session === fresh.id));
    const seed = x.log().find((l) => l.session === fresh.id)!.text;
    assert.ok(seed.startsWith(SEED));
    assert.match(seed, /context was 95 % full/);
    assert.match(seed, /The previous session left no summary: start from your briefing and the state below/);
    assert.ok(!seed.includes("Its summary"));
    assert.match(seed, /The project now \(nexus status\):\nproject P \(p\)/);
    assert.ok(!existsSync(x.store.orchestratorSummaryFile), "no summary.md");
    assert.deepEqual(x.orchestrator.view().earlier.map((b) => [b.session, b.switch.fill, b.switch.summary]), [[old.id, 0.95, null]]);
    assert.ok(x.store.readChat(fresh.id).entries.some((c) => c.from === "nexus" && c.text.includes("It left no summary, so the fresh session starts from its current briefing and nexus status only.")));
  } finally { x.stop(); }
});

test("it is not switched while it works: the request waits for the turn's end", async () => {
  process.env.FAKE_CHAT_SLOW_MS = "2500";
  const x = setup();
  try {
    // A 1M-token window: 700k tokens are over the default 500k but under its own threshold of 750k: nothing.
    process.env.FAKE_CONTEXT_WINDOW = "1000000";
    x.store.updateProject((p) => ({ ...p, orchestrator: { runtime: "claude", notify: true, session: null, ...p.orchestrator, context_threshold_tokens: 750_000 } }), [], ["orchestrator.context_threshold_tokens"]);
    x.fill(0.7);
    x.orchestrator.say("Hello");
    await x.until("the reply", () => x.replies() === 1);
    const old = x.orchestrator.session()!;
    // A slow turn; meanwhile the threshold drops below the fill: the running turn is not cut into.
    x.orchestrator.say("FAKE-SLOW");
    await x.until("the slow turn", () => x.orchestrator.view().state === "working");
    x.store.updateProject((p) => ({ ...p, orchestrator: { runtime: "claude", notify: true, session: null, ...p.orchestrator, context_threshold_tokens: 600_000 } }), [], ["orchestrator.context_threshold_tokens"]);
    await sleep(1000);
    assert.equal(x.orchestrator.view().state, "working");
    assert.ok(!x.log().some((l) => ASKED.test(l.text)), "not asked while it works");
    assert.equal(x.orchestrator.session()!.id, old.id);
    // Once the turn is over: asked, and switched after the summary.
    await untilAsync("the request", async () => x.log().some((l) => ASKED.test(l.text)), WAIT_MS);
    await x.until("the fresh session", () => x.orchestrator.session()?.id !== old.id);
    const fresh = x.orchestrator.session()!;
    await x.until("the seed", () => x.log().some((l) => l.session === fresh.id));
    assert.equal(x.log().filter((l) => l.session === old.id && l.text === "FAKE-SLOW").length, 1);
  } finally { x.stop(); }
});

test("a message sent as a turn ends, run by the runtime as a turn of its own, is not taken for the turns' end (queue OF)", async () => {
  // The fake holds the first turn's result until the next message comes, so that message is sent into the turn (`next`)
  // but reaches the runtime after it: Claude Code runs it as a turn of its own, which starts after the result Nexus
  // reads. Above the threshold, that result must not count as the end of the orchestrator's work.
  process.env.FAKE_LATE_NEXT = "1";
  const x = setup();
  process.env.FAKE_RELEASE = join(x.root, "release");
  try {
    x.fill(0.9);
    x.orchestrator.say("Hello");
    await x.until("the reply", () => x.replies() === 1);
    delete process.env.FAKE_LATE_NEXT; // for the fresh session's process
    const old = x.orchestrator.session()!;
    x.orchestrator.say("FAKE-HOLD");
    await x.until("the held turn", () => x.store.readChat(old.id).entries.some((c) => c.kind === "tool" && c.text.includes("FAKE-HOLD")));
    assert.ok(x.log().some((l) => l.text === "FAKE-HOLD" && l.priority === "next"), "sent into the first turn");
    assert.ok(!x.store.readChat(old.id).entries.some((c) => c.from === "nexus" && c.text.includes("Nexus asked it for a summary")), "not asked while it works");
    assert.equal(x.orchestrator.view().state, "working");
    // Once the held turn is over: asked, and switched after the summary.
    writeFileSync(process.env.FAKE_RELEASE, "");
    await x.until("the fresh session", () => x.orchestrator.session()?.id !== old.id);
    const asked = x.log().filter((l) => ASKED.test(l.text));
    assert.equal(asked.length, 1);
    assert.equal(asked[0]!.session, old.id);
    assert.ok(x.log().findIndex((l) => ASKED.test(l.text)) > x.log().findIndex((l) => l.text === "FAKE-HOLD"));
    assert.ok(x.store.readChat(old.id).entries.some((c) => c.from === "orchestrator" && c.text === "held reply"), "the held turn ended before the switch");
  } finally { x.stop(); }
});

test("a message read inside the turn: the request comes once the moment for a turn of the runtime's own is over", async () => {
  const x = setup();
  process.env.FAKE_RELEASE = join(x.root, "release");
  try {
    x.fill(0.3);
    x.orchestrator.say("FAKE-HOLD");
    const old = x.orchestrator.session()!;
    await x.until("the held turn", () => x.store.readChat(old.id).entries.some((c) => c.kind === "tool" && c.text.includes("FAKE-HOLD")));
    x.fill(0.9);
    x.orchestrator.say("A word in the turn");
    await x.until("the word sent into the turn", () => x.log().some((l) => l.text.includes("A word in the turn") && l.priority === "next"));
    writeFileSync(process.env.FAKE_RELEASE, "");
    await x.until("the fresh session", () => x.orchestrator.session()?.id !== old.id);
    assert.equal(x.log().filter((l) => ASKED.test(l.text)).length, 1);
    assert.ok(x.store.readChat(old.id).entries.some((c) => c.from === "orchestrator" && c.text.startsWith("held reply")));
  } finally { x.stop(); }
});

test("the user's message while the summary is written waits for the fresh session and goes into its first turn", async () => {
  process.env.FAKE_SUMMARY_MS = "1500";
  const x = setup();
  try {
    x.fill(0.9);
    x.orchestrator.say("Hello");
    const old = x.orchestrator.session()!;
    await untilAsync("the request", async () => x.log().some((l) => ASKED.test(l.text)), WAIT_MS);
    assert.equal(x.orchestrator.session()!.id, old.id, "the summary turn still runs");
    x.orchestrator.say("A word in between");
    await x.until("the fresh session", () => x.orchestrator.session()?.id !== old.id);
    const fresh = x.orchestrator.session()!;
    await x.until("the seed", () => x.log().some((l) => l.session === fresh.id));
    const seed = x.log().find((l) => l.session === fresh.id)!.text;
    assert.match(seed, /Messages that came for the previous session and were not read yet:\n\n\[Nexus\] Message from the user:\nA word in between/);
    assert.ok(!x.log().some((l) => l.session === old.id && l.text.includes("A word in between")), "not sent to the old session");
    assert.ok(x.store.readChat(old.id).entries.some((c) => c.from === "user" && c.text === "A word in between"));
  } finally { x.stop(); }
});
