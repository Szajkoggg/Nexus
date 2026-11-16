// Real descendants of fake runtimes, never real models or user projects. Windows Job Object integration tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { setStepLevel } from "@nexus/protocol";
import { ClaudeSession } from "../src/claude.ts";
import { CodexSession } from "../src/codex.ts";
import { setup } from "./engine-setup.ts";
import { holdWork, until, LONGER } from "./wait.ts";

interface Family { root: number; direct: number; orphan: number; bridge: number }
function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }
function family(file: string): Family { return JSON.parse(readFileSync(file, "utf8")) as Family; }
function gone(f: Family): boolean { return !alive(f.direct) && !alive(f.orphan); }

for (const runtime of ["claude", "codex"] as const) {
  test(`${runtime}: step cleanup preserves the runtime, interruption ends its tree and leaves another worker alone`, { skip: process.platform !== "win32" }, async () => {
    const work = holdWork();
    const first = setup(["procdone", "prochold"]);
    const log = process.env.FAKE_LOG!;
    first.engine.start("Q", { runtime });
    const other = setup(["prochold"]);
    const otherLog = process.env.FAKE_LOG!;
    other.engine.start("Q", { runtime });
    try {
      await until("second step and other worker children", () => existsSync(`${log}.children-Q2`) && existsSync(`${otherLog}.children-Q1`), LONGER.run);
      const before = family(`${log}.children-Q1`), after = family(`${log}.children-Q2`), separate = family(`${otherLog}.children-Q1`);
      assert.equal(before.root, after.root, "the same runtime takes the next step");
      assert.ok(gone(before), "even the orphaned grandchild is gone before the next step");
      assert.ok(alive(after.root) && alive(after.direct) && alive(after.orphan));
      await first.engine.stopAtOnce("Q");
      assert.ok(gone(after) && !alive(after.root), "interruption waits for the whole tree");
      assert.ok(alive(separate.root) && alive(separate.direct) && alive(separate.orphan), "another worker is untouched");
      other.engine.shutdown();
      await until("shutdown to end the other worker tree", () => gone(separate) && !alive(separate.root));
    } finally {
      first.engine.shutdown(); other.engine.shutdown(); work.release(); work.done();
      await until("both hosts to exit", () => !first.engine.alive() && !other.engine.alive(), LONGER.processes);
    }
  });

  test(`${runtime}: a reported stop cleans descendants and retains the idle runtime`, { skip: process.platform !== "win32" }, async () => {
    const fixture = setup(["procstop"]);
    const file = `${process.env.FAKE_LOG}.children-Q1`;
    try {
      fixture.engine.start("Q", { runtime });
      await fixture.until("stopped run", () => fixture.queue().run?.state === "halted", LONGER.run);
      const f = family(file);
      assert.ok(gone(f));
      assert.ok(alive(f.root));
    } finally {
      fixture.engine.shutdown();
      await until("host exit", () => !fixture.engine.alive(), LONGER.processes);
    }
  });

  test(`${runtime}: Stop now cleans after the turn, and review cleans before acceptance`, { skip: process.platform !== "win32" }, async () => {
    for (const stop of [true, false]) {
      const work = holdWork();
      const fixture = setup([stop ? "prochold" : "procdone", "done"]);
      const file = `${process.env.FAKE_LOG}.children-Q1`;
      if (!stop) setStepLevel(fixture.store, "Q", "Q1", 1);
      try {
        fixture.engine.start("Q", { runtime });
        await until("children recorded", () => existsSync(file), LONGER.step);
        const f = family(file);
        if (stop) { fixture.engine.stopNow("Q"); work.release(); }
        await until("children cleaned", () => gone(f), LONGER.step);
        assert.ok(alive(f.root));
        assert.equal(fixture.queue().steps[1]!.status, "pending");
        assert.equal(stop ? fixture.queue().run?.state : fixture.queue().steps[0]!.status, stop ? "paused" : "review");
      } finally {
        fixture.engine.shutdown(); work.release(); work.done();
        await until("host exit", () => !fixture.engine.alive(), LONGER.processes);
      }
    }
  });

  test(`${runtime}: cleanup failure halts the queue before its next step`, { skip: process.platform !== "win32" }, async () => {
    const fixture = setup(["procdone", "done"], { spawn: (launch) => {
      const proc = launch.runtime === "claude" ? new ClaudeSession(launch.options) : new CodexSession(launch.options);
      proc.cleanup = () => Promise.reject(new Error("injected cleanup failure"));
      return proc;
    } });
    const file = `${process.env.FAKE_LOG}.children-Q1`;
    try {
      fixture.engine.start("Q", { runtime });
      await fixture.until("cleanup failure", () => fixture.queue().run?.state === "halted", LONGER.step);
      assert.match(fixture.queue().run!.reason!, /injected cleanup failure/);
      assert.equal(fixture.queue().steps[1]!.status, "pending");
      const f = family(file);
      await until("failed worker tree exits", () => gone(f) && !alive(f.root));
    } finally {
      fixture.engine.shutdown();
      await until("host exit", () => !fixture.engine.alive(), LONGER.processes);
    }
  });

  test(`${runtime}: a resume during cleanup waits for it, then continues`, { skip: process.platform !== "win32" }, async () => {
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    let cleaning = false;
    const fixture = setup(["procdone", "done"], { spawn: (launch) => {
      const proc = launch.runtime === "claude" ? new ClaudeSession(launch.options) : new CodexSession(launch.options);
      const cleanup = proc.cleanup.bind(proc);
      proc.cleanup = async () => { cleaning = true; await barrier; await cleanup(); };
      return proc;
    } });
    try {
      fixture.engine.start("Q", { runtime });
      await until("cleanup barrier", () => cleaning, LONGER.step);
      fixture.engine.pause("Q");
      fixture.engine.resume("Q");
      assert.equal(fixture.queue().run?.state, "paused");
      assert.equal(fixture.queue().steps[1]!.status, "pending");
      release();
      await fixture.until("resumed run finishes", () => fixture.queue().run?.state === "finished", LONGER.run);
    } finally {
      release(); fixture.engine.shutdown();
      await until("host exit", () => !fixture.engine.alive(), LONGER.processes);
    }
  });

  test(`${runtime}: accepting review before a delayed exit never retries the completed step`, { skip: process.platform !== "win32" }, async () => {
    const work = holdWork();
    const fixture = setup(["doneexitheld", "done"]);
    setStepLevel(fixture.store, "Q", "Q1", 1);
    try {
      fixture.engine.start("Q", { runtime });
      await fixture.until("review", () => fixture.queue().steps[0]!.status === "review", LONGER.step);
      fixture.engine.acceptReview("Q", "Q1");
      work.release();
      await fixture.until("run finishes", () => fixture.queue().run?.state === "finished", LONGER.run);
      assert.ok(!fixture.store.readActivity(fixture.queue().run!.session).entries.some((a) => a.kind === "retry"));
    } finally {
      fixture.engine.shutdown(); work.release(); work.done();
      await until("host exit", () => !fixture.engine.alive(), LONGER.processes);
    }
  });

  test(`${runtime}: session completion and runtime crash remove every descendant`, { skip: process.platform !== "win32" }, async () => {
    for (const behaviour of ["procdone", "proccrash"]) {
      const fixture = setup([behaviour], { retryBaseMs: 60_000 });
      const file = `${process.env.FAKE_LOG}.children-Q1`;
      try {
        fixture.engine.start("Q", { runtime });
        await until("family recorded", () => existsSync(file), LONGER.run);
        const f = family(file);
        await until("runtime and descendants exit", () => !alive(f.root) && gone(f), LONGER.run);
        if (behaviour === "procdone") assert.equal(fixture.queue().run?.state, "finished");
      } finally {
        fixture.engine.shutdown();
        await until("host exit", () => !fixture.engine.alive(), LONGER.processes);
      }
    }
  });
}
