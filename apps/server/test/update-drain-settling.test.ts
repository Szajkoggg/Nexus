// An update's drain beside a settling worker (queue LCF; LC2's finding 6; the loss LS 14 described, fixed in 5516082):
// a message sent into the step's last turn reaches Claude Code as that turn ends and runs as a late turn of its own.
// Until that turn has run, the worker is not idle (AgentHost.idle: settling counts), so the drain waits; once it has
// ended, the drain goes on to the update. The message is worked on in the late turn, not lost with the restart.
//
// The engine runs the fake `claude` in process (FAKE_LATE_NEXT with its gate: the late turn starts once the test opens
// it); the Lifecycle is wired as main.ts wires a project (projectPart) and looks every 20 ms (tickMs). Its checkout is
// a temporary development checkout, and its npm a stand-in that refuses the build: the update fails there, before any
// hand-over, and the server goes on.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectStore, approveQueue, loadProjectState, routeAnswers, sendMessage, type StepDef } from "@nexus/protocol";
import { Engine } from "../src/engine.ts";
import { Lifecycle, projectPart } from "../src/lifecycle.ts";
import { acceptReviews } from "./fake-reviewer.ts";
import { inProcessRuntime } from "./in-process-runtime.ts";
import { LONGER, QUICK_ENGINE, until } from "./wait.ts";

interface Received { text: string; priority: string | null; busy: boolean; session: string | null }

test("an update's drain waits for a worker settling after its step's last turn: the late turn with the message runs and ends, then the drain goes on (queue LCF, LC2 finding 6)", async () => {
  const base = mkdtempSync(join(tmpdir(), "nexus-drain-settling-"));
  const root = join(base, "project");
  mkdirSync(root);
  process.env.NEXUS_HOME = join(base, "home");
  process.env.FAKE_LOG = join(base, "fake.log");
  const gate = join(base, "late-gate");
  process.env.FAKE_LATE_NEXT = "1";
  process.env.FAKE_LATE_GATE = gate;
  const received = (): Received[] => (existsSync(process.env.FAKE_LOG!) ? readFileSync(process.env.FAKE_LOG!, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Received) : []);

  // The checkout the server runs from: a development checkout (a branch), which an update never moves.
  const checkout = join(base, "checkout");
  mkdirSync(checkout);
  const git = (...a: string[]) => execFileSync("git", ["-c", "core.autocrlf=false", "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...a], { cwd: checkout, encoding: "utf8" });
  git("init", "-q", "-b", "dev");
  writeFileSync(join(checkout, "a.txt"), "A\n"); git("add", "a.txt"); git("commit", "-q", "-m", "A");

  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  const steps: StepDef[] = ["Q1", "Q2"].map((id) => ({ id, title: `Step ${id}`, goal: "FAKE: done", acceptance: [] }));
  store.writeQueue({ protocol: 1, id: "Q", title: "Queue", revision: 1, status: "proposed", stop_conditions: [], checks: [], steps, approvals: [], withdrawals: [], history: [] });
  approveQueue(store, "Q");
  // Q1's review is accepted by the test (a message reaches no step in its review); the drain holds the run before Q2.
  // The settling moment is held open past the test's waits: the gate, not a time, decides when the late turn starts.
  const engine: Engine = new Engine(store, () => { routeAnswers(store); engine.onChange(loadProjectState(store)); }, { spawn: inProcessRuntime(), ...QUICK_ENGINE, lateTurnMs: 4 * LONGER.run });
  const queue = () => loadProjectState(store).queues.find((q) => q.id === "Q")!;

  // The drain's view of the project: projectPart's, with how often it was asked whether the workers are idle.
  const builds: { lateTurnEnded: boolean }[] = [];
  let looks = 0;
  let session = "";
  const lateTurnEnded = () => store.readActivity(session).entries.filter((e) => e.kind === "turn_end").length >= 2;
  const part = projectPart({ id: "p", engine, orchestrator: { cutOff() {}, shutdown() {} } as never, conversations: { cutOff() {}, shutdown() {} } as never, merger: { shutdown() {} } });
  const lifecycle = new Lifecycle(() => [{ ...part, idle: () => { looks++; return part.idle(); } }], () => {}, {
    root: checkout, tickMs: 20,
    npm: async (_root, ...args) => {
      if (args[0] === "run") builds.push({ lateTurnEnded: lateTurnEnded() });
      throw new Error("stand-in npm: no build in this test");
    },
  });
  try {
    engine.start("Q", { runtime: "claude" });
    // The step's turn has reported its done and holds its result until a message comes.
    await until("Q1 in review in its turn", () => queue().steps[0]!.status === "review" && loadProjectState(store).sessions.find((s) => s.id === queue().run?.session)?.live?.state === "working", LONGER.step);
    session = queue().run!.session!;
    acceptReviews(store);
    engine.onChange(loadProjectState(store));
    sendMessage(store, session, "FAKE-HISTORY: keep the grassland settings.", { queue: "Q", step: "Q1" });
    engine.onChange(loadProjectState(store)); // delivered into the running turn (next)
    await until("the message sent into the turn", () => received().some((m) => m.session === session && m.text.includes("grassland") && m.priority === "next"));
    await until("the step's last turn to end", () => store.readActivity(session).entries.some((e) => e.kind === "turn_end"));

    lifecycle.start({});
    assert.deepEqual([lifecycle.status.phase, lifecycle.status.held, lifecycle.status.waiting], ["draining", ["p/Q"], ["p"]], "the drain holds the queue and lists the settling worker's project as waiting");
    const before = looks;
    await until("the drain to look a few times more", () => looks >= before + 3);
    assert.deepEqual([lifecycle.status.phase, lifecycle.status.waiting, builds.length], ["draining", ["p"], 0], "while the worker settles, the drain waits");

    writeFileSync(gate, "");
    await until("the drain to go on and the stand-in build to refuse", () => lifecycle.status.phase === "failed", LONGER.step);
    assert.deepEqual(builds, [{ lateTurnEnded: true }], "the drain went on to the update only after the late turn had ended");
    const activity = store.readActivity(session).entries.filter((e) => ["turn_start", "turn_end", "text"].includes(e.kind) && !/^Nexus /.test(e.text));
    const lateStart = activity.findIndex((e, i) => e.kind === "turn_start" && i > activity.findIndex((x) => x.kind === "turn_end"));
    assert.ok(lateStart > 0, `a late turn started after the step's last turn: ${JSON.stringify(activity.map((e) => e.kind))}`);
    // Only the message (FAKE-HISTORY) makes the fake reply "history: …"; the reply lists the step's opening first, and
    // the activity keeps its first 600 characters, so the message's own words may be cut off there.
    assert.ok(activity.slice(lateStart).some((e) => e.kind === "text" && e.text.startsWith("history: [Nexus] Queue Q")),
      `the message was taken in as the late turn: ${JSON.stringify(activity.slice(lateStart).map((e) => e.text))}`);
    assert.equal(received().filter((m) => m.text.includes("grassland")).length, 1, "the message was sent once, into the turn");
  } finally {
    engine.shutdown();
    delete process.env.FAKE_LATE_NEXT; delete process.env.FAKE_LATE_GATE; delete process.env.FAKE_LOG;
  }
});
