// The chats while Nexus updates (queue OP1, decided 2026-11-15): the orchestrator and the thinking partners keep
// answering while an update waits for the running steps, the drain does not wait for their turns, and a chat turn still
// running at the hand-over is cut off and goes on in the same session after the restart, its message quoting what it
// was answering, the chat saying so in a line of its own. The workers' drain is as before, and no run starts meanwhile.
//
// The predecessor is this process, wired as main.ts wires a project (projectPart) with a Lifecycle whose checkout is
// a temporary development checkout (nothing is moved, npm is a stand-in held by the test); its successor is a real
// server (src/main.ts) that takes over through the hand-over folder. Every agent is the fake `claude`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ActionError, ProjectStore, approveQueue, loadProjectState, routeAnswers, writeRegistry, type StepDef } from "@nexus/protocol";
import { Conversations } from "../src/conversations.ts";
import { Engine } from "../src/engine.ts";
import { Lifecycle, projectPart } from "../src/lifecycle.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import { RESTARTED } from "../src/chats.ts";
import { isAlive } from "../src/handover.ts";
import { acceptReviews } from "./fake-reviewer.ts";
import { MAIN, assertTempHome } from "./helpers.ts";
import { LONGER, QUICK_ENGINE, holdWork, until } from "./wait.ts";

const here = dirname(fileURLToPath(import.meta.url));
process.env.NEXUS_CLAUDE = join(here, "fake-claude.ts");

const freePort = () => new Promise<number>((resolve) => {
  const s = createServer();
  s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); });
});

/** What the fake agents received (FAKE_LOG): the text and the session it reached. */
function received(log: string) {
  return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { text: string; session: string | null }) : [];
}

/** The fake runtimes' command lines (FAKE_ARGS). */
function launches(file: string) {
  return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").map((l) => (JSON.parse(l) as { argv: string[] }).argv) : [];
}

for (const now of [false, true]) {
  test(`${now ? "--now: " : ""}the chats answer while an update waits; a chat turn running at the hand-over goes on in the same session after the restart`, async () => {
    const base = mkdtempSync(join(tmpdir(), "nexus-chat-update-"));
    const home = join(base, "home");
    assertTempHome(home);
    // The successor gets this process's environment (Lifecycle.restart): its home, port and fakes are set here.
    const port = await freePort();
    const log = join(base, "fake.log");
    const args = join(base, "fake-args.log");
    Object.assign(process.env, { NEXUS_HOME: home, NEXUS_PORT: String(port), NEXUS_LOG: "", FAKE_LOG: log, FAKE_ARGS: args, FAKE_CHAT_SLOW_MS: "600000" });
    // Not a worker session's own (the tests may run inside one): the successor and its agents must not see them.
    delete process.env.NEXUS_SESSION; delete process.env.NEXUS_DIR;
    const work = holdWork();

    // The checkout the predecessor runs from: a development checkout (a branch), which an update never moves.
    const repo = join(base, "checkout");
    mkdirSync(repo);
    const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...a], { cwd: repo, encoding: "utf8" }).trim();
    git("init", "-q", "-b", "dev");
    writeFileSync(join(repo, "a.txt"), "A\n"); git("add", "a.txt"); git("commit", "-q", "-m", "A");

    const root = join(base, "project");
    mkdirSync(root);
    const store = ProjectStore.init(root, { id: "p", name: "P", root });
    const steps = (id: string, ...goals: string[]): StepDef[] => goals.map((g, i) => ({ id: `${id}${i + 1}`, title: `Step ${id}${i + 1}`, goal: `FAKE: ${g}`, acceptance: [] }));
    for (const [id, goals] of [["Q", ["slow", "done"]], ["R", ["done"]]] as const) {
      store.writeQueue({ protocol: 1, id, title: `Queue ${id}`, revision: 1, status: "proposed", stop_conditions: [], checks: [], steps: steps(id, ...goals), approvals: [], history: [] });
      approveQueue(store, id);
    }
    writeRegistry({ protocol: 1, projects: [{ id: "p", root }] });

    const engine: Engine = new Engine(store, () => { routeAnswers(store); acceptReviews(store); engine.onChange(loadProjectState(store)); }, QUICK_ENGINE);
    const orchestrator = new Orchestrator(store, engine, () => {});
    const conversations = new Conversations(store, orchestrator, () => {});
    const conv = conversations.create({ runtime: "claude", title: "Ideas" });
    const part = projectPart({ id: "p", engine, orchestrator, conversations, merger: { shutdown() {} } });
    let build!: () => void;
    const built = new Promise<void>((r) => { build = r; });
    let exited = false;
    const lifecycle = new Lifecycle(() => [part], () => {}, {
      root: repo, successor: [process.execPath, MAIN], timeoutMs: LONGER.processes,
      npm: async () => { await built; },
      // As main.ts releases: the chats' running turns cut off and recorded, every agent stopped.
      release: async () => {
        part.shutdown();
        await until("every agent to exit", () => !engine.alive() && !orchestrator.alive() && !conversations.alive(), LONGER.processes);
      },
      exit: () => { exited = true; },
    });
    const show = () => `; update: ${JSON.stringify(lifecycle.status)}; received: ${JSON.stringify(received(log).map((m) => m.text.slice(0, 80)))}`;
    const orchSession = () => store.readProject().orchestrator!.session!;
    const chat = (session: string) => store.readChat(session).entries;
    const replied = (session: string, from: "orchestrator" | "partner", after: string) => () => {
      const c = chat(session);
      const i = c.findIndex((e) => e.from === "user" && e.text === after);
      return i >= 0 && c.slice(i + 1).some((e) => e.from === from && e.kind === "message");
    };
    let successor: number | undefined;
    try {
      engine.start("Q");
      await until("the worker's step to run", () => loadProjectState(store).queues.find((q) => q.id === "Q")!.steps[0]!.status === "running", LONGER.step);

      lifecycle.start({ now });
      assert.deepEqual(lifecycle.status.held, ["p/Q"], "the running queue is held, as before");
      if (now) await until("the drain (with --now: the step interrupted)", () => lifecycle.status.phase === "updating", LONGER.step, show);
      else {
        await until("the drain to wait for the worker", () => lifecycle.status.waiting.includes("p"), LONGER.step, show);
        assert.equal(lifecycle.status.phase, "draining");
      }
      assert.throws(() => engine.start("R"), (e: unknown) => e instanceof ActionError && e.status === 409 && /Nexus is updating/.test(e.message), "no run starts meanwhile");

      // Messages while the update waits: they reach the orchestrator and the partner, and get answers.
      orchestrator.say("Hello while it waits");
      conversations.say(conv.id, "Hello while it waits");
      await until("the orchestrator's answer", replied(orchSession(), "orchestrator", "Hello while it waits"), LONGER.step, show);
      await until("the partner's answer", replied(conv.id, "partner", "Hello while it waits"), LONGER.step, show);
      assert.equal(lifecycle.status.phase, now ? "updating" : "draining", "answered while the update waits");

      // Turns that are still running when the drain is over: it goes on without them.
      orchestrator.say("FAKE-SLOW: plan the layout");
      conversations.say(conv.id, "FAKE-SLOW: think about the layout");
      await until("both chat turns at work", () => !orchestrator.idle() && !conversations.idle()
        && chat(orchSession()).some((e) => e.kind === "tool" && /FAKE-SLOW/.test(e.text)) && chat(conv.id).some((e) => e.kind === "tool" && /FAKE-SLOW/.test(e.text)), LONGER.step, show);
      if (!now) {
        work.release(); // the worker's step ends: the drain is over, though both chat turns still run
        await until("the update past its drain", () => lifecycle.status.phase === "updating", LONGER.step, show);
      }
      assert.ok(!orchestrator.idle() && !conversations.idle(), "the drain did not wait for the chat turns");
      const run = store.readRun("Q")!;
      assert.equal(run.state, "paused");
      assert.equal(run.resume_after_restart, true, "the worker's queue goes on after the restart");
      assert.equal(loadProjectState(store).queues.find((q) => q.id === "Q")!.steps[0]!.status === "running", now, now ? "--now interrupted the step" : "the step ended first");

      // The successor's fakes answer the resumed turn at once.
      process.env.FAKE_CHAT_SLOW_MS = "100";
      build();
      await until("the hand-over", () => exited, LONGER.processes, show);
      successor = Number(/the successor runs as pid (\d+)/.exec(lifecycle.status.log.join("\n"))?.[1]);

      // The successor goes on with each cut-off turn in its session, quoting what it answered; the chat says so.
      for (const [session, quote, from] of [[orchSession(), "FAKE-SLOW: plan the layout", "orchestrator"], [conv.id, "FAKE-SLOW: think about the layout", "partner"]] as const) {
        const told = () => received(log).filter((m) => m.session === session && m.text.startsWith("[Nexus] The server restarted while you were answering"));
        await until(`the restart notice in ${from}'s session`, () => told().length > 0, LONGER.processes, show);
        assert.equal(told()[0]!.text, `[Nexus] The server restarted while you were answering this message:\n> ${quote}\nAnswer it again. The cut-off turn may have done part of it: check before you repeat anything.`);
        await until(`${from}'s answer after the restart`, () => {
          const c = chat(session);
          const i = c.findIndex((e) => e.from === "nexus" && e.text === RESTARTED);
          return i >= 0 && c.slice(i + 1).some((e) => e.from === from && e.text === "slow reply");
        }, LONGER.processes, () => `${show()}; chat: ${JSON.stringify(chat(session).slice(-6))}`);
        assert.equal(chat(session).filter((e) => e.text === RESTARTED).length, 1, "one line in the chat");
        assert.equal(store.readRuntime(session)?.interrupted, undefined, "the record no longer holds the cut-off turn");
      }
      // The same sessions: their runtimes were resumed, not started anew.
      const native = (id: string) => store.readSession(id).native_id!;
      for (const id of [orchSession(), conv.id]) {
        const resumed = launches(args).filter((a) => a.includes("--resume") && a.includes(native(id)));
        assert.ok(resumed.length >= 1, `the session ${id} resumed`);
      }
      assert.ok(!received(log).some((m) => m.text.startsWith("[Nexus] The server restarted") && m.text.includes("Hello while it waits")), "only the cut-off turn's message is quoted");
    } finally {
      if (successor && isAlive(successor)) {
        if (process.platform === "win32") { try { execFileSync("taskkill", ["/PID", String(successor), "/T", "/F"], { stdio: "ignore" }); } catch { /* gone */ } }
        else process.kill(successor);
      }
      build();
      work.done();
      engine.shutdown(); orchestrator.shutdown(); conversations.shutdown();
      await until("this process's agents to exit", () => !engine.alive() && !orchestrator.alive() && !conversations.alive(), LONGER.processes).catch(() => {});
    }
  });
}
