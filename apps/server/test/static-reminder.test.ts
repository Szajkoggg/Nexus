// The static analysis reminder (PROTOCOL.md, "Static analysis reminder") against the fake runtimes, on a clock the test
// moves: a project without static analysis tells its orchestrator once a month; one with static analysis never; after
// the user's no (`nexus static-analysis decline`, an event of the orchestrator's) nothing comes for 90 days.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectStore, loadProjectState, newId, now, routeAnswers, type Event } from "@nexus/protocol";
import { Engine } from "../src/engine.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import type { Clock } from "../src/scheduler.ts";
import { until as waitUntil, LONGER } from "./wait.ts";

process.env.NEXUS_CLAUDE = join(dirname(fileURLToPath(import.meta.url)), "fake-claude.ts");
const DAY = 24 * 3600_000;

/** A clock that moves only when told; its timers fire in order as it passes them. */
class TestClock implements Clock {
  t = Date.now();
  private timers: { at: number; fn: () => void }[] = [];
  now() { return this.t; }
  setTimeout(fn: () => void, ms: number) { const h = { at: this.t + ms, fn }; this.timers.push(h); return h; }
  clearTimeout(h: unknown) { this.timers = this.timers.filter((x) => x !== h); }
  advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      const next = this.timers.filter((x) => x.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      this.timers = this.timers.filter((x) => x !== next);
      this.t = next.at;
      next.fn();
    }
    this.t = end;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const REMINDER = /^This project has no static analysis set up/;

function setup(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "nexus-static-reminder-"));
  process.env.NEXUS_HOME = join(root, "home");
  process.env.FAKE_LOG = join(root, "fake.log");
  for (const [p, text] of Object.entries(files)) writeFileSync(join(root, p), text);
  const store = ProjectStore.init(root, { id: "p", name: "P", root, orchestrator: { notify: true } });
  const clock = new TestClock();
  let orchestrator: Orchestrator | undefined;
  const tick = () => { routeAnswers(store); const s = loadProjectState(store); orchestrator?.onChange(s); engine.onChange(s); };
  const engine = new Engine(store, tick, { retryBaseMs: 30, startupMs: 20, clock });
  orchestrator = new Orchestrator(store, engine, tick);
  const timer = setInterval(tick, 100);
  const reminders = () => orchestrator!.view().chat.filter((c) => c.from === "nexus" && REMINDER.test(c.text)).length;
  const until = (what: string, pred: () => boolean) => waitUntil(what, pred, LONGER.run, () => `; reminders: ${reminders()}; note: ${JSON.stringify(store.readStaticAnalysisNote())}`);
  const stop = () => { clearInterval(timer); orchestrator!.shutdown(); engine.shutdown(); };
  return { store, clock, engine, orchestrator: orchestrator!, reminders, until, stop };
}

test("a project without static analysis: one reminder a month; after the user's no, none for 90 days", async () => {
  const x = setup({ "package.json": JSON.stringify({ name: "x", scripts: { test: "node --test" } }) });
  try {
    x.orchestrator.say("hello"); // the orchestrator's session, as a project has one
    await x.until("the first reminder", () => x.reminders() === 1);
    assert.ok(x.store.readStaticAnalysisNote().reminded_at);
    x.clock.advance(29 * DAY);
    await sleep(500);
    assert.equal(x.reminders(), 1, "not again within the month");
    x.clock.advance(2 * DAY);
    await x.until("the second reminder, a month after the first", () => x.reminders() === 2);
    // The user says no: the orchestrator runs nexus static-analysis decline.
    const s = x.orchestrator.session()!;
    x.store.appendEvent({ v: 1, id: newId(), at: now(), session: s.id, type: "static_analysis.declined", reason: "we lint in CI elsewhere" } as Event);
    await x.until("the no noted", () => x.store.readStaticAnalysisNote().declined?.reason === "we lint in CI elsewhere");
    assert.match(x.store.readApplied(s.id).entries.at(-1)!.message, /^noted: the user declined setting up static analysis; no reminder until /);
    x.clock.advance(60 * DAY);
    await sleep(500);
    x.clock.advance(29 * DAY);
    await sleep(500);
    assert.equal(x.reminders(), 2, "none within 90 days of the no");
    x.clock.advance(2 * DAY);
    await x.until("a reminder again after 90 days", () => x.reminders() === 3);
  } finally { x.stop(); }
});

test("a project with static analysis is never reminded", async () => {
  const x = setup({ "package.json": JSON.stringify({ name: "x", scripts: { lint: "eslint ." } }), "eslint.config.js": "export default [];\n" });
  try {
    x.orchestrator.say("hello");
    await x.until("the orchestrator's turn", () => x.orchestrator.view().chat.some((c) => c.from !== "user" && c.from !== "nexus"));
    for (let i = 0; i < 4; i++) { x.clock.advance(31 * DAY); await sleep(200); }
    await sleep(300);
    assert.equal(x.reminders(), 0);
    assert.equal(x.store.readStaticAnalysisNote().reminded_at, undefined);
  } finally { x.stop(); }
});
