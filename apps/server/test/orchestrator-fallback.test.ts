// Automatic orchestrator routing against both fake runtimes, with a movable usage clock. No model calls.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectStore, applyDraft, approveQueue, loadProjectState, updateSettings, writeUsage } from "@nexus/protocol";
import { Engine } from "../src/engine.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import { until, LONGER } from "./wait.ts";

const here = dirname(fileURLToPath(import.meta.url));
process.env.NEXUS_CLAUDE = join(here, "fake-claude.ts");
process.env.NEXUS_CODEX = join(here, "fake-codex.ts");
type Runtime = "claude" | "codex";
const HOUR = 3_600_000;
const key = (runtime: Runtime) => runtime === "claude" ? "five_hour" : "codex_5h";

function setup(primary: Runtime, fallback?: Runtime) {
  const root = mkdtempSync(join(tmpdir(), "nexus-orch-fallback-"));
  process.env.NEXUS_HOME = join(root, "home");
  process.env.FAKE_LOG = join(root, "fake.log");
  process.env.FAKE_ARGS = join(root, "args.log");
  process.env.FAKE_RELEASE = join(root, "release");
  process.env.FAKE_CONTEXT_FILL_FILE = join(root, "fill");
  writeFileSync(join(root, "fill"), "0.1");
  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  updateSettings(store, { orchestrator: { runtime: primary, model: "primary-model", effort: "high",
    fallback: fallback ? { runtime: fallback, model: "backup-model", effort: "low" } : null } });
  let clock = Date.now();
  const engine = new Engine(store, () => {});
  let orchestrator = new Orchestrator(store, engine, tick, {}, { nowMs: () => clock });
  function tick() { orchestrator.onChange(loadProjectState(store)); }
  const timer = setInterval(tick, 100);
  const log = (): { text: string; session: string }[] => existsSync(join(root, "fake.log"))
    ? readFileSync(join(root, "fake.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { text: string; session: string }) : [];
  const received = (session: string, text: string) => log().some((l) => l.session === session && l.text.includes(text));
  const usage = (primaryFill: number, fallbackFill = 0, primaryReset = clock + HOUR, fallbackReset = clock + HOUR) => {
    writeUsage({ updated_at: new Date(clock).toISOString(), windows: {
      ...(fallback && fallback !== primary ? { [key(fallback)]: { utilization: fallbackFill, resets_at: new Date(fallbackReset).toISOString() } } : {}),
      [key(primary)]: { utilization: primaryFill, resets_at: new Date(primaryReset).toISOString() },
    } });
  };
  const notice = () => {
    applyDraft(store, { id: "Q", title: "Pending plan", steps: [{ id: "Q1", title: "One", goal: "Nothing starts", acceptance: ["Ready"] }] });
    approveQueue(store, "Q");
    tick();
  };
  return {
    root, store, tick, log, received, usage, notice, get orchestrator() { return orchestrator; },
    clock: () => clock,
    advance: (ms: number) => { clock += ms; tick(); },
    release: () => writeFileSync(join(root, "release"), ""),
    fill: (value: number) => writeFileSync(join(root, "fill"), String(value)),
    hold: () => { if (existsSync(join(root, "release"))) unlinkSync(join(root, "release")); },
    idle: () => until("the orchestrator idle", () => orchestrator.idle(), LONGER.step),
    restart: async (resume = false) => {
      orchestrator.shutdown();
      await until("the old process ended", () => !orchestrator.alive());
      orchestrator = new Orchestrator(store, engine, tick, {}, { nowMs: () => clock });
      if (resume) orchestrator.resumeCutOff();
      tick();
    },
    stop: () => {
      writeFileSync(join(root, "release"), "");
      clearInterval(timer); orchestrator.shutdown(); engine.shutdown();
      for (const k of ["FAKE_LOG", "FAKE_ARGS", "FAKE_RELEASE", "FAKE_CONTEXT_FILL_FILE"]) delete process.env[k];
    },
  };
}

for (const primary of ["claude", "codex"] as const) {
  const fallback = primary === "claude" ? "codex" : "claude";
  test(`${primary} primary -> ${fallback} fallback -> primary: between turns, summary, pending message and notice, restart and reset`, async () => {
    const x = setup(primary, fallback);
    try {
      x.orchestrator.say('FAKE-NEXUS: ["context","Keep the agreed plan","--topics","plan","--files","plan.md"]');
      const first = x.orchestrator.session()!;
      await until("the summary event", () => x.store.readEvents(first.id).entries.some((e) => e.type === "context.summary"), LONGER.step);
      await x.idle();
      x.orchestrator.say("FAKE-HOLD");
      await until("the held primary turn", () => x.received(first.id, "FAKE-HOLD") && !x.orchestrator.idle());
      const reset = x.clock() + HOUR;
      x.usage(0.95, 0, reset);
      x.orchestrator.say("Remember my waiting message");
      x.notice();
      assert.equal(x.orchestrator.session()!.id, first.id, "the running turn is never switched");
      assert.ok(!x.received(first.id, "Remember my waiting message"), "the waiting message stays out of the full runtime");
      x.release();
      await until("the fallback session", () => x.orchestrator.session()?.runtime === fallback, LONGER.step);
      const second = x.orchestrator.session()!;
      await until("the seed and pending message", () => x.received(second.id, "Remember my waiting message"), LONGER.step);
      const seed = x.log().find((l) => l.session === second.id)!.text;
      assert.match(seed, /Keep the agreed plan/);
      assert.match(seed, /Topics: plan/);
      assert.match(seed, /The project now \(nexus status\)/);
      assert.match(seed, /95 % \(limit 90 %\)/);
      assert.match(readFileSync(x.store.orchestratorSummaryFile, "utf8"), /Keep the agreed plan/);
      assert.equal(second.continues, first.id);
      assert.equal(x.store.readSession(first.id).continued_by, second.id);
      await until("the held approval notice", () => x.orchestrator.view().chat.some((c) => c.from === "nexus" && /approved/.test(c.text)), LONGER.step);
      assert.equal(x.store.readProject().orchestrator?.runtime, primary, "primary settings stay intact");
      assert.equal(x.store.readProject().orchestrator?.model, "primary-model");
      assert.equal(second.model, "backup-model");
      assert.equal(second.effort, "low");
      assert.equal(second.orchestrator_fallback?.until, new Date(reset).toISOString());
      await x.idle();
      x.usage(0.1, 0, reset); // a lower reading must not bounce back before the recorded reset
      await x.restart();
      assert.equal(x.orchestrator.session()!.id, second.id, "fallback latch survives restart and lower readings");
      x.hold();
      x.orchestrator.say("FAKE-HOLD on fallback");
      await until("the held fallback turn", () => x.received(second.id, "FAKE-HOLD on fallback") && !x.orchestrator.idle(), LONGER.step);
      x.advance(HOUR + 1);
      assert.equal(x.orchestrator.session()!.id, second.id, "return also waits for a turn boundary");
      x.release();
      await until("back to primary", () => x.orchestrator.session()?.runtime === primary, LONGER.step);
      const third = x.orchestrator.session()!;
      await until("primary seed", () => x.received(third.id, "Keep the agreed plan"), LONGER.step);
      assert.equal(third.continues, second.id);
      assert.equal(third.model, "primary-model");
      assert.equal(third.effort, "high");
      assert.equal(third.orchestrator_fallback, undefined);
      assert.ok(x.store.readChat(second.id).entries.some((c) => c.from === "nexus" && /switches to its fallback/.test(c.text)));
      assert.ok(x.store.readChat(third.id).entries.some((c) => c.from === "nexus" && /returns to its primary/.test(c.text)));
      assert.deepEqual(x.orchestrator.view().earlier.map((e) => e.session), [first.id, second.id]);
      const codex = primary === "codex" ? first : second;
      const args = readFileSync(join(x.root, "args.log"), "utf8");
      assert.ok(args.includes("nexus_orchestrator"), "Codex uses the chosen permission profile on either side");
      assert.ok(args.includes(`${codex.id}/events.jsonl`));
      await x.idle();
    } finally { x.stop(); }
  });
}

test("both runtimes full: pending messages wait, then use the fallback when its earlier window resets", async () => {
  const x = setup("claude", "codex");
  try {
    updateSettings(x.store, { orchestrator: { fallback: { runtime: "codex" } } });
    x.usage(0.95, 0.95, x.clock() + 2 * HOUR, x.clock() + HOUR);
    x.orchestrator.say("Waiting while both are full");
    const first = x.orchestrator.session()!;
    x.tick();
    assert.equal(x.orchestrator.view().state, "exited");
    assert.equal(x.log().length, 0);
    x.advance(HOUR + 1);
    await until("fallback received the pending message", () => x.received(x.orchestrator.session()!.id, "Waiting while both are full"), LONGER.step);
    assert.equal(x.orchestrator.session()!.runtime, "codex");
    assert.equal(x.orchestrator.view().model, null, "the fallback's default does not display the primary's model");
    assert.equal(x.orchestrator.view().effort, null);
    assert.equal(x.orchestrator.session()!.continues, first.id);
    await x.idle();
    const second = x.orchestrator.session()!;
    x.usage(0.95, 0.95, x.clock() + HOUR, x.clock() + 2 * HOUR);
    x.orchestrator.say("Waiting on exhausted fallback");
    x.tick();
    assert.ok(!x.received(second.id, "Waiting on exhausted fallback"));
    assert.equal(x.orchestrator.session()!.id, second.id, "no third runtime");
    x.advance(HOUR + 1);
    await until("pending message back on primary", () => x.received(x.orchestrator.session()!.id, "Waiting on exhausted fallback"), LONGER.step);
    assert.equal(x.orchestrator.session()!.runtime, "claude");
    await x.idle();
  } finally { x.stop(); }
});

test("context care preserves the fallback and its reset deadline in the next session", async () => {
  const x = setup("claude", "codex");
  try {
    x.usage(0.95);
    x.orchestrator.say("Hello on backup");
    const first = x.orchestrator.session()!;
    await until("the first reply", () => x.orchestrator.view().chat.some((c) => c.from === "orchestrator"));
    await x.idle();
    x.tick();
    x.fill(0.9);
    x.orchestrator.say("A fuller conversation");
    await until("context care's fresh session", () => x.orchestrator.session()?.id !== first.id, LONGER.step);
    const fresh = x.orchestrator.session()!;
    assert.equal(fresh.runtime, "codex");
    assert.deepEqual(fresh.orchestrator_fallback, first.orchestrator_fallback);
    await until("the new seed", () => x.received(fresh.id, "fake orchestrator summary"), LONGER.step);
    await x.idle();
    x.advance(HOUR + 1);
    await until("back to primary", () => x.orchestrator.session()?.runtime === "claude", LONGER.step);
    await x.idle();
  } finally { x.stop(); }
});

test("a manual runtime change after a summary waits on the destination quota, not the old runtime's", async () => {
  const x = setup("claude");
  try {
    x.orchestrator.say('FAKE-NEXUS: ["context","Summary before changing runtime"]');
    const first = x.orchestrator.session()!;
    await until("the summary", () => x.store.readEvents(first.id).entries.some((e) => e.type === "context.summary"));
    await x.idle();
    // Context care's request is durable; the user changed runtime before its next onChange.
    x.store.appendApplied(first.id, { at: first.created_at, event: "context:asked", ok: true, message: "0.9" });
    x.usage(0.95);
    updateSettings(x.store, { orchestrator: { runtime: "codex", model: null, effort: null } });
    x.tick();
    assert.equal(x.orchestrator.session()!.runtime, "codex");
    await until("the summary on Codex", () => x.received(x.orchestrator.session()!.id, "Summary before changing runtime"), LONGER.step);
    await x.idle();
  } finally { x.stop(); }
});

test("a runtime change waits while a message sent as a turn ended may still run as a turn of its own (queue KM)", async () => {
  // The fake holds the first turn's result until the next message comes, so that message is sent into the turn (`next`)
  // but runs as a turn of its own after the result Nexus reads (FAKE_LATE_NEXT). The process is settling then, not idle:
  // the runtime change made meanwhile waits for that turn's end.
  process.env.FAKE_LATE_NEXT = "1";
  const x = setup("claude");
  try {
    x.orchestrator.say("Hello");
    const first = x.orchestrator.session()!;
    await until("the first reply", () => x.orchestrator.view().chat.some((c) => c.from === "orchestrator"));
    delete process.env.FAKE_LATE_NEXT; // for the Codex session's process
    x.orchestrator.say("FAKE-HOLD");
    updateSettings(x.store, { orchestrator: { runtime: "codex", model: null, effort: null } });
    await until("the held turn", () => x.store.readChat(first.id).entries.some((c) => c.kind === "tool" && c.text.includes("FAKE-HOLD")), LONGER.step);
    assert.equal(x.orchestrator.session()!.id, first.id, "not switched while the late turn runs");
    x.release();
    await until("the Codex session", () => x.orchestrator.session()?.runtime === "codex", LONGER.step);
    const chat = x.store.readChat(first.id).entries;
    const held = chat.findIndex((c) => c.from === "orchestrator" && c.text === "held reply");
    assert.ok(held >= 0 && held < chat.findIndex((c) => c.from === "nexus" && c.text.startsWith("The orchestrator goes on on Codex")), "the held turn ended before the switch");
    await x.idle();
  } finally { delete process.env.FAKE_LATE_NEXT; x.stop(); }
});

test("restart carries an interrupted turn to the available fallback, with the seed first", async () => {
  const x = setup("claude", "codex");
  try {
    x.orchestrator.say("Hello");
    const first = x.orchestrator.session()!;
    await until("first reply", () => x.orchestrator.view().chat.some((c) => c.from === "orchestrator"));
    await x.idle();
    // The durable record left by AgentHost.cutOff before the server went down.
    x.store.writeRuntime(first.id, { ...x.store.readRuntime(first.id)!, interrupted: { at: new Date().toISOString(), asked: ["Interrupted request"] } });
    x.usage(0.95);
    await x.restart(true);
    const fresh = x.orchestrator.session()!;
    await until("the interrupted work on fallback", () => x.received(fresh.id, "Interrupted request"), LONGER.step);
    assert.equal(fresh.runtime, "codex");
    assert.equal(x.store.readRuntime(first.id)?.interrupted, undefined);
    const received = x.log().filter((l) => l.session === fresh.id).map((l) => l.text).join("\n");
    assert.ok(received.indexOf("fresh session on Codex") < received.indexOf("Interrupted request"));
    await x.idle();
  } finally { x.stop(); }
});

test("same-runtime fallback shares the quota: wait, keep the session and primary model (user decision OC4)", async () => {
  const x = setup("claude", "claude");
  try {
    x.orchestrator.say("Hello");
    const first = x.orchestrator.session()!;
    await until("first reply", () => x.orchestrator.view().chat.some((c) => c.from === "orchestrator"));
    await x.idle();
    x.usage(0.95);
    x.orchestrator.say("Shared quota message");
    x.tick();
    assert.equal(x.orchestrator.session()!.id, first.id);
    assert.equal(x.orchestrator.session()!.model, "primary-model");
    assert.ok(!x.received(first.id, "Shared quota message"));
    x.advance(HOUR + 1);
    await until("message after shared reset", () => x.received(first.id, "Shared quota message"));
    assert.equal(x.orchestrator.session()!.id, first.id);
    assert.equal(x.orchestrator.session()!.orchestrator_fallback, undefined);
    await x.idle();
  } finally { x.stop(); }
});

test("without a fallback notices still wait, no runtime change; a manual same-runtime model change resumes the session", async () => {
  const x = setup("claude");
  try {
    x.orchestrator.say("Hello");
    const first = x.orchestrator.session()!;
    await until("first reply", () => x.orchestrator.view().chat.some((c) => c.from === "orchestrator"));
    await x.idle();
    x.usage(0.95);
    x.notice();
    assert.ok(x.store.readInbox(first.id).entries.some((m) => m.id.startsWith("notice-")));
    assert.equal(x.orchestrator.session()!.id, first.id);
    assert.ok(!x.orchestrator.view().chat.some((c) => c.from === "nexus" && /approved/.test(c.text)));
    x.advance(HOUR + 1);
    await until("the notice after reset", () => x.orchestrator.view().chat.some((c) => c.from === "nexus" && /approved/.test(c.text)));
    await x.idle();
    x.orchestrator.settings("another-model", "low");
    x.orchestrator.say("Same conversation");
    await until("the message", () => x.received(first.id, "Same conversation"));
    assert.equal(x.orchestrator.session()!.id, first.id);
    assert.equal(x.orchestrator.session()!.model, "another-model");
    await x.idle();
  } finally { x.stop(); }
});
