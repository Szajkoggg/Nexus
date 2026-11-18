// Never two queues in one checkout, and the limits on queues running at once, across all projects and a project's own
// (src/coordinator.ts), against the fake runtimes: projects whose engines share one coordinator, as the server's do.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MAX_RUNNING, ensureGlobalSettings, loadProjectState, readGlobalSettings, updateGlobalSettings } from "@nexus/protocol";
import type { Clock } from "../src/engine.ts";
import { Coordinator } from "../src/coordinator.ts";
import { doneByHand, going, world } from "./coordinator-world.ts";
import { LONGER, holdWork } from "./wait.ts";

const MIN = 60_000;

/** A clock that moves only when told; its timers fire in order as it passes them (as in schedules.test.ts). */
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

test("two queues chained after the same queue in the project's checkout run one after the other, in plan order", async () => {
  const work = holdWork();
  const w = world();
  const p = w.add("p", { A: ["done"], B: ["slow"], C: ["slow"] });
  try {
    // C's plan is made first: it goes first, though B comes first by name.
    p.engine.plan("C", { after: ["A"], by: "user" });
    await sleep(10);
    p.engine.plan("B", { after: ["A"], by: "user" });
    p.engine.start("A");
    await w.until("C to start", () => !!p.queue("C").run, LONGER.step);
    assert.equal(p.queue("B").run, undefined, "B waits while C works in the checkout");
    await w.until("B to say why it waits", () => !!p.queue("B").start?.held);
    assert.equal(p.queue("B").start!.waiting, "queue A is done; waits for the checkout: queue C runs there");
    assert.equal(p.queue("B").start!.held!.kind, "checkout");
    assert.equal(p.queue("B").start!.blocked, false);
    work.release();
    await w.until("B to finish", () => p.queue("B").run?.state === "finished", LONGER.processes);
    const b = p.queue("B").run!, c = p.queue("C").run!;
    assert.ok(c.ended_at! <= b.started_at, `B started (${b.started_at}) only after C ended (${c.ended_at})`);
    assert.equal(p.store.readStart("B"), undefined, "the plan is used up");
  } finally { w.stop(); work.done(); }
});

test("two queues in worktrees of their own run side by side", async () => {
  const work = holdWork();
  const w = world();
  const p = w.add("p", { A: { steps: ["slow"], own: true }, B: { steps: ["slow"], own: true } });
  try {
    p.engine.start("A");
    p.engine.start("B");
    // Both steps held at work at once: neither run waited for the other's.
    await w.until("both steps at work", () => p.queue("A").steps[0]!.status === "running" && p.queue("B").steps[0]!.status === "running", LONGER.step);
    work.release();
    await w.until("both to finish", () => p.queue("A").run?.state === "finished" && p.queue("B").run?.state === "finished", LONGER.run);
    const [a, b] = ["A", "B"].map((q) => ({ began: p.queue(q).run!.started_at, ended: p.queue(q).steps[0]!.segments[0]!.end! }));
    assert.ok(a!.began < b!.ended && b!.began < a!.ended, `side by side: A began ${a!.began}, its step ended ${a!.ended}; B began ${b!.began}, ended ${b!.ended}`);
  } finally { w.stop(); work.done(); }
});

test("a direct start, a resume and a continue in a checkout another queue holds are refused with the reason", async () => {
  const work = holdWork();
  const w = world();
  const p = w.add("p", { A: ["slow", "done"], B: ["done"], S: ["stop"], H: ["noop"] });
  try {
    // S meets a stop condition, H ends its step twice without an outcome: their runs halt and hold the checkout no more.
    p.engine.start("S");
    await w.until("S to halt", () => p.queue("S").run?.state === "halted", LONGER.run);
    p.engine.start("H");
    await w.until("H to halt", () => p.queue("H").run?.state === "halted", LONGER.run);
    p.engine.start("A");
    await w.until("A at work", () => p.queue("A").steps[0]!.status === "running", LONGER.step);
    assert.throws(() => p.engine.start("B"), /^Error: queue B cannot start: its checkout is in use, queue A runs there$/);
    assert.equal(p.queue("B").run, undefined);
    assert.throws(() => p.engine.continueQueue("S"), /queue S cannot continue: its checkout is in use, queue A runs there/);
    assert.equal(p.queue("S").status, "stopped", "a refused continue leaves the stop as it was");
    assert.throws(() => p.engine.resume("H"), /queue H cannot go on: its checkout is in use, queue A runs there/);
    assert.equal(p.queue("H").run?.state, "halted");
    // A paused run holds its checkout too.
    p.engine.pause("A");
    work.release();
    await w.until("A paused", () => p.queue("A").run?.state === "paused", LONGER.run);
    assert.throws(() => p.engine.start("B"), /queue B cannot start: its checkout is in use, queue A is paused there/);
    p.engine.resume("A");
    await w.until("A to finish", () => p.queue("A").run?.state === "finished", LONGER.run);
    p.engine.start("B");
    await w.until("B to finish", () => p.queue("B").run?.state === "finished", LONGER.run);
  } finally { w.stop(); work.done(); }
});

test("a third queue over the limit waits and starts when one ends, also across two projects; a direct one is refused", async () => {
  const work = holdWork();
  const w = world({ limit: 2 });
  const p = w.add("p", { A: { steps: ["slow"], own: true }, B: { steps: ["slow", "slow"], own: true }, D: { steps: ["done"], own: true } });
  const r = w.add("r", { Z0: ["done"], Z: ["done"] });
  try {
    p.engine.start("A");
    p.engine.start("B");
    await w.until("A and B at work", () => going(p.queue("A").run?.state) && going(p.queue("B").run?.state), LONGER.step);
    assert.throws(() => p.engine.start("D"), /^Error: queue D cannot start: 2 queues run, the limit is 2$/);
    assert.throws(() => r.engine.start("Z"), /queue Z cannot start: 2 queues run, the limit is 2/, "the limit counts every project's queues");
    // A planned start in the other project waits for a place.
    doneByHand(r.store, "Z0", ["Z01"]);
    assert.equal(r.engine.plan("Z", { after: ["Z0"], by: "user" }), "queue Z0 is done; queue Z waits: 2 queues run, the limit is 2; it starts by itself then");
    assert.equal(r.queue("Z").start!.waiting, "queue Z0 is done; waits: 2 queues run, the limit is 2");
    assert.equal(r.queue("Z").start!.held!.kind, "limit");
    work.release("A1"); // B stays at work
    await w.until("A to finish", () => p.queue("A").run?.state === "finished", LONGER.processes);
    await w.until("Z to start once A ended", () => !!r.queue("Z").run, LONGER.step);
    assert.ok(going(p.queue("B").run?.state), "B was still at work: Z took A's place");
    await w.until("Z to finish", () => r.queue("Z").run?.state === "finished", LONGER.run);
  } finally { w.stop(); work.done(); }
});

test("a queue in review holds its checkout but does not count toward the limit", async () => {
  const w = world({ limit: 1 });
  const p = w.add("p", { R: { steps: ["done", "done"], level: 1 }, B: ["done"], W: { steps: ["done"], own: true } });
  try {
    p.engine.start("R");
    await w.until("R1 in review", () => p.queue("R").steps[0]!.status === "review", LONGER.step);
    assert.equal(p.queue("R").run?.state, "running");
    assert.throws(() => p.engine.start("B"), /queue B cannot start: its checkout is in use, queue R runs there/);
    // R counts no more: with a limit of 1, a queue in its own worktree may start.
    p.engine.start("W");
    await w.until("W to finish", () => p.queue("W").run?.state === "finished", LONGER.run);
    p.engine.acceptReview("R", "R1");
    await w.until("R2 in review", () => p.queue("R").steps[1]!.status === "review", LONGER.step);
  } finally { w.stop(); }
});

test("a schedule waiting for its checkout is not marked missed, and starts once the checkout is free", async () => {
  const work = holdWork();
  const clock = new TestClock();
  const w = world({ clock });
  const p = w.add("p", { A: ["slow"], B: ["done"] });
  try {
    p.engine.start("A");
    await w.until("A at work", () => p.queue("A").steps[0]!.status === "running", LONGER.step);
    p.engine.scheduleStart("B", { at: new Date(clock.now() + MIN).toISOString(), by: "user" });
    clock.advance(MIN);
    await w.until("B to wait for the checkout", () => !!p.queue("B").start?.held);
    assert.equal(p.queue("B").start!.waiting, "waits for the checkout: queue A runs there");
    // Long past its time while it waits: not missed.
    clock.advance(30 * MIN);
    w.tick();
    assert.equal(p.queue("B").start!.failed, undefined, "a waiting schedule is never missed");
    work.release();
    await w.until("B to finish once A is done", () => p.queue("B").run?.state === "finished", LONGER.run);
    assert.equal(p.store.readStart("B"), undefined);
  } finally { w.stop(); work.done(); }
});

test("a project's own limit holds beside the global one: one of its queues at a time, while another project's start", async () => {
  const work = holdWork();
  const w = world({ limit: 3 });
  const p = w.add("p", { A: { steps: ["slow"], own: true }, B: { steps: ["done"], own: true }, B0: ["done"] }, 1);
  const r = w.add("r", { Z: { steps: ["slow"], own: true } });
  try {
    assert.equal(loadProjectState(p.store).project.defaults.max_running, 1, "its own value");
    assert.equal(loadProjectState(r.store).project.defaults.max_running, 3, "the other follows the global one");
    p.engine.start("A");
    await w.until("A at work", () => going(p.queue("A").run?.state), LONGER.step);
    assert.throws(() => p.engine.start("B"), /^Error: queue B cannot start: 1 queue of Project p runs, its limit is 1$/);
    // The other project starts meanwhile: one queue runs of the three the global limit allows.
    r.engine.start("Z");
    await w.until("Z at work beside A", () => going(r.queue("Z").run?.state), LONGER.step);
    // A planned start in the project waits for its own limit, and starts by itself once A ends.
    doneByHand(p.store, "B0", ["B01"]);
    assert.equal(p.engine.plan("B", { after: ["B0"], by: "user" }), "queue B0 is done; queue B waits: 1 queue of Project p runs, its limit is 1; it starts by itself then");
    assert.equal(p.queue("B").start!.held!.kind, "limit");
    work.release("A1"); // Z stays at work
    await w.until("B to finish once A ended", () => p.queue("B").run?.state === "finished", LONGER.processes);
    assert.ok(going(r.queue("Z").run?.state), "Z still at work: B waited for its project's limit, not the global one");
  } finally { w.stop(); work.done(); }
});

test("the global limit holds whatever the projects' own limits are", async () => {
  const work = holdWork();
  const w = world({ limit: 2 });
  const p = w.add("p", { A: { steps: ["slow"], own: true }, B: { steps: ["slow"], own: true }, C: { steps: ["done"], own: true } }, 5);
  const r = w.add("r", { Z: { steps: ["done"], own: true } }, 4);
  try {
    p.engine.start("A");
    p.engine.start("B");
    await w.until("A and B at work", () => going(p.queue("A").run?.state) && going(p.queue("B").run?.state), LONGER.step);
    assert.throws(() => p.engine.start("C"), /^Error: queue C cannot start: 2 queues run, the limit is 2$/, "its own limit of 5 does not lift the global one");
    assert.throws(() => r.engine.start("Z"), /queue Z cannot start: 2 queues run, the limit is 2/);
    work.release();
    await w.until("A and B to finish", () => p.queue("A").run?.state === "finished" && p.queue("B").run?.state === "finished", LONGER.processes);
    r.engine.start("Z");
    await w.until("Z to finish", () => r.queue("Z").run?.state === "finished", LONGER.run);
  } finally { w.stop(); work.done(); }
});

test("the limit is a global setting: limits.json's value moves into it once, and the file stays as its copy", () => {
  const fresh = () => { const home = mkdtempSync(join(tmpdir(), "nexus-limits-")); process.env.NEXUS_HOME = home; return home; };
  const limits = (home: string) => JSON.parse(readFileSync(join(home, "limits.json"), "utf8")) as { max_running: number };
  const settings = (home: string) => join(home, "settings.yaml");

  // Nothing set: the default, 2.
  let home = fresh();
  assert.equal(DEFAULT_MAX_RUNNING, 2);
  assert.equal(new Coordinator().limit(), 2);
  assert.equal(ensureGlobalSettings().defaults.max_running, 2);

  // Global settings from before the setting, and the old file: its value moves in; the other settings stay.
  home = fresh();
  writeFileSync(join(home, "limits.json"), JSON.stringify({ max_running: 3 }));
  writeFileSync(settings(home), "protocol: 1\ndefaults:\n  review_level: 3\n");
  assert.equal(ensureGlobalSettings().defaults.max_running, 3);
  assert.equal(readGlobalSettings().defaults.max_running, 3, "written into settings.yaml");
  assert.equal(readGlobalSettings().defaults.review_level, 3);
  assert.equal(new Coordinator().limit(), 3);
  assert.ok(existsSync(join(home, "limits.json")), "the old file stays");
  assert.equal(limits(home).max_running, 3);

  // No global settings yet (a first start of this version over an old home): the same.
  home = fresh();
  writeFileSync(join(home, "limits.json"), JSON.stringify({ max_running: 4 }));
  assert.equal(ensureGlobalSettings().defaults.max_running, 4);

  // Moved once: from then on the setting decides, and every change is copied into limits.json for an older server.
  updateGlobalSettings({ defaults: { max_running: 5 } });
  assert.equal(limits(home).max_running, 5, "the copy follows the setting");
  writeFileSync(join(home, "limits.json"), JSON.stringify({ max_running: 7 }));
  assert.equal(ensureGlobalSettings().defaults.max_running, 5, "the file no longer decides");

  // An older server (an update rolled back) rewrote settings.yaml without the setting and changed limits.json: the
  // next start takes the limit it set.
  writeFileSync(settings(home), readFileSync(settings(home), "utf8").replace(/^ {2}max_running: \d+\n/m, ""));
  assert.doesNotMatch(readFileSync(settings(home), "utf8"), /max_running/);
  assert.equal(ensureGlobalSettings().defaults.max_running, 7);

  // An unreadable or invalid old file is ignored.
  home = fresh();
  writeFileSync(join(home, "limits.json"), JSON.stringify({ max_running: 50 }));
  assert.equal(ensureGlobalSettings().defaults.max_running, 2);
});
