// Immediate user stops against both real adapters with fake runtimes, never a model or a registered project.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readTurns } from "@nexus/protocol";
import { ClaudeSession } from "../src/claude.ts";
import { CodexSession } from "../src/codex.ts";
import type { AgentProcess, Priority } from "../src/agent.ts";
import { userStopNow } from "../src/prompts.ts";
import { setup } from "./engine-setup.ts";
import { assertTempHome } from "./helpers.ts";
import { holdWork, LONGER } from "./wait.ts";

for (const runtime of ["claude", "codex"] as const) for (const worktree of [false, true]) {
  test(`${runtime}: Stop at once keeps ${worktree ? "worktree" : "checkout"} changes and resumes the same session`, async () => {
    const work = holdWork();
    const processes: AgentProcess[] = [];
    const calls: string[] = [];
    const x = setup(["slow"], { spawn: (launch) => {
      const proc = launch.runtime === "codex" ? new CodexSession(launch.options) : new ClaudeSession(launch.options);
      const stop = proc.stop.bind(proc), kill = proc.kill.bind(proc);
      proc.stop = () => { calls.push("stop"); return stop(); };
      proc.kill = () => { calls.push("kill"); kill(); };
      processes.push(proc);
      return proc;
    } });
    assertTempHome(process.env.NEXUS_HOME);
    process.env.NEXUS_DIR = x.store.dir;
    delete process.env.NEXUS_HANDOVER;
    const root = dirname(x.store.dir);
    const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", stdio: "pipe" });
    git(root, "init", "-q", "-b", "main");
    writeFileSync(join(root, "tracked.txt"), "before\n");
    git(root, "add", "tracked.txt"); git(root, "commit", "-qm", "initial");
    const cwd = worktree ? join(root, "tree") : root;
    if (worktree) {
      git(root, "worktree", "add", "-b", "test-work", cwd);
      x.store.writeQueue({ ...x.store.readQueue("Q"), worktree: cwd.replaceAll("\\", "/") });
    }
    try {
      x.engine.start("Q", { runtime });
      await x.until("the worker's running step", () => x.queue().steps[0]!.status === "running", LONGER.step);
      const session = x.queue().run!.session;
      const native = x.store.readSession(session).native_id;
      assert.ok(native);
      const pid = processes[0]!.pid!;
      writeFileSync(join(cwd, "tracked.txt"), "uncommitted edit\n");
      writeFileSync(join(cwd, "new.txt"), "untracked work\n");
      const stopping = x.engine.stopAtOnce("Q");
      assert.equal(x.queue().run?.state, "paused");
      assert.throws(() => x.engine.resume("Q"), /still exiting/);
      await stopping;
      assert.deepEqual(calls, ["stop", "kill"]);
      assert.equal(processes[0]!.state, "exited");
      assert.throws(() => process.kill(pid, 0), "the OS process is gone");
      assert.equal(x.store.readRuntime(session)?.state, "exited");
      assert.equal(x.queue().run?.state, "paused");
      assert.equal(x.queue().run?.retries, undefined);
      const event = x.queue().steps[0]!.timeline.find((e) => e.type === "step.interrupted");
      assert.ok(event);
      assert.equal(x.store.readSession(event.session).role, "user");
      assert.equal(x.queue().steps[0]!.segments[0]!.end, event.at);
      assert.equal(readTurns().entries.find((t) => t.session === session)?.outcome, "interrupted");
      assert.equal(readFileSync(join(cwd, "tracked.txt"), "utf8"), "uncommitted edit\n");
      assert.equal(readFileSync(join(cwd, "new.txt"), "utf8"), "untracked work\n");
      await assert.rejects(x.engine.stopAtOnce("Q"), /not running/);
      x.engine.resume("Q");
      await x.until("the same step to reopen", () => x.received().filter((m) => /step Q1 \(1 of/.test(m.text)).length === 2, LONGER.step);
      assert.equal(x.queue().run!.session, session);
      assert.equal(processes.length, 2);
      work.release();
      await x.until("the resumed step to finish", () => x.queue().run?.state === "finished", LONGER.run);
      assert.equal(x.store.readSession(session).native_id, native);
      assert.notEqual(processes[1]!.pid, pid);
      assert.equal(x.received().filter((m) => /step Q1 \(1 of/.test(m.text)).length, 2);
      assert.equal(readFileSync(join(cwd, "tracked.txt"), "utf8"), "uncommitted edit\n");
      assert.equal(readFileSync(join(cwd, "new.txt"), "utf8"), "untracked work\n");
    } finally {
      x.engine.shutdown(); work.done();
      await x.until("all fake worker processes to exit", () => processes.every((p) => p.state === "exited"));
    }
  });
}

for (const runtime of ["claude", "codex"] as const) {
  test(`${runtime}: Stop now still sends its message, then Stop at once can end the paused worker`, async () => {
    const work = holdWork();
    const sent: { text: string; priority?: Priority }[] = [];
    const x = setup(["slow"], { spawn: (launch) => {
      const proc = launch.runtime === "codex" ? new CodexSession(launch.options) : new ClaudeSession(launch.options);
      const send = proc.send.bind(proc);
      proc.send = (text, priority) => { sent.push({ text, priority }); send(text, priority); };
      return proc;
    } });
    assertTempHome(process.env.NEXUS_HOME);
    process.env.NEXUS_DIR = x.store.dir;
    delete process.env.NEXUS_HANDOVER;
    try {
      x.engine.start("Q", { runtime });
      await x.until("the running step", () => x.queue().steps[0]!.status === "running", LONGER.step);
      x.engine.stopNow("Q", "Wrong branch");
      assert.deepEqual(sent.at(-1), { text: userStopNow("Wrong branch"), priority: "now" });
      assert.equal(x.queue().run?.state, "paused");
      assert.notEqual(x.store.readRuntime(x.queue().run!.session)?.state, "exited");
      assert.equal(x.queue().steps[0]!.timeline.some((e) => e.type === "step.interrupted"), false);
      await x.engine.stopAtOnce("Q");
      assert.equal(x.store.readRuntime(x.queue().run!.session)?.state, "exited");
    } finally { x.engine.shutdown(); work.done(); }
  });
}
