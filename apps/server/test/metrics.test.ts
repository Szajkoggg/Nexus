// The project's metrics against the fake runtimes (docs/protocol/stats.md, "Project metrics"): the orchestrator defines one with a
// warning threshold; a worker records its values (FAKE: metric); the value beyond the threshold is marked on its step
// (StepView.metrics `warn`) with the step's commit, the orchestrator is told it once, and its review notice lists the
// round's metrics; the value within it is told nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectStore, approveQueue, loadProjectState, routeAnswers } from "@nexus/protocol";
import { Engine } from "../src/engine.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import { QUICK_ENGINE, LONGER, WAIT_MS, until as waitUntil } from "./wait.ts";

process.env.NEXUS_CLAUDE = join(dirname(fileURLToPath(import.meta.url)), "fake-claude.ts");
const G = ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false"];

function setup() {
  const root = mkdtempSync(join(tmpdir(), "nexus-metrics-"));
  process.env.NEXUS_HOME = join(root, "home");
  process.env.FAKE_LOG = join(root, "fake.log");
  process.env.FAKE_REVIEW_ACCEPT = "1";
  const git = (...a: string[]) => execFileSync("git", [...G, ...a], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q", "-b", "main");
  writeFileSync(join(root, ".gitignore"), ".nexus/\n");
  git("add", ".gitignore"); git("commit", "-qm", "init");
  const store = ProjectStore.init(root, { id: "p", name: "P", root, orchestrator: { notify: true } });
  store.writeQueue({
    protocol: 1, id: "Q", title: "Queue", revision: 1, status: "proposed", review_level: 2, stop_conditions: [], checks: [], approvals: [], withdrawals: [], history: [],
    steps: [
      { id: "Q1", title: "Build", goal: "FAKE: metric\nFAKE-METRIC: bundle-kb 900", acceptance: [] },
      { id: "Q2", title: "Shrink", goal: "FAKE: metric\nFAKE-METRIC: bundle-kb 100", acceptance: [] },
    ],
  });
  approveQueue(store, "Q");
  const tick = () => { routeAnswers(store); const s = loadProjectState(store); orchestrator.onChange(s); engine.onChange(s); };
  const engine: Engine = new Engine(store, tick, { ...QUICK_ENGINE, retryBaseMs: 30, usageMarginMs: 100 });
  const orchestrator = new Orchestrator(store, engine, tick);
  const timer = setInterval(tick, 150);
  const chat = () => orchestrator.view().chat.map((c) => c.text);
  const queue = () => loadProjectState(store).queues.find((q) => q.id === "Q")!;
  const until = (what: string, pred: () => boolean, ms = WAIT_MS) => waitUntil(what, pred, ms, () => `; chat: ${JSON.stringify(chat().slice(-3))}; steps: ${queue().steps.map((s) => `${s.id}=${s.status}`).join(" ")}`);
  const received = () => (existsSync(process.env.FAKE_LOG!) ? readFileSync(process.env.FAKE_LOG!, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { text: string; session: string | null }) : []);
  const stop = () => { clearInterval(timer); orchestrator.shutdown(); engine.shutdown(); delete process.env.FAKE_REVIEW_ACCEPT; };
  return { store, git, engine, orchestrator, chat, queue, until, received, stop };
}

test("a value beyond its metric's threshold is marked on its step and told to the orchestrator once; one within it is not", async () => {
  const x = setup();
  try {
    x.orchestrator.say("Hello");
    await x.until("the orchestrator's session", () => !!x.orchestrator.session());
    x.orchestrator.say(`FAKE-NEXUS: ${JSON.stringify(["metric", "define", "bundle-kb", "--unit", "KB", "--show", "bar", "--warn-above", "500"])}`);
    await x.until("the definition applied", () => x.chat().some((t) => /^ok: metric bundle-kb \(KB, bar; warn above 500\) defined/m.test(t)));
    assert.deepEqual(x.store.readMetrics().metrics.map((m) => [m.name, m.unit, m.show, m.warn_above, m.session]), [["bundle-kb", "KB", "bar", 500, x.orchestrator.session()!.id]]);

    const head = x.git("rev-parse", "HEAD");
    x.engine.start("Q");
    await x.until("both steps accepted", () => x.queue().steps.every((s) => s.status === "done"), LONGER.run);

    const [q1, q2] = x.queue().steps;
    assert.deepEqual(q1!.metrics.map((m) => [m.name, m.value, m.unit, m.commit, m.warn]), [["bundle-kb", 900, "KB", head, { side: "above", limit: 500 }]]);
    assert.deepEqual(q2!.metrics.map((m) => [m.name, m.value, m.warn]), [["bundle-kb", 100, undefined]]);

    const fact = `Step Q1 of queue Q: bundle-kb is 900 KB, above its warning threshold of 500 KB (at ${head.slice(0, 7)}).`;
    await x.until("the orchestrator told", () => x.chat().includes(fact));
    const o = x.orchestrator.session()!.id;
    const toOrchestrator = x.received().filter((r) => r.session === o).map((r) => r.text);
    assert.equal(toOrchestrator.filter((t) => t.includes("above its warning threshold of 500 KB (at")).length, 1, "told once");
    assert.ok(toOrchestrator.some((t) => t.startsWith(`[Nexus] ${fact} Weigh it in the step's review`)), "with what to do");
    assert.ok(!toOrchestrator.some((t) => /bundle-kb is 100 KB/.test(t)), "the value within the threshold is not told");
    // The review notice lists the round's metrics, the one beyond its threshold marked.
    assert.ok(toOrchestrator.some((t) => t.includes("Metrics recorded this round:\n- bundle-kb: 900 KB (above its warning threshold of 500 KB)")));
    assert.ok(toOrchestrator.some((t) => t.includes("Metrics recorded this round:\n- bundle-kb: 100 KB\n")));
  } finally { x.stop(); }
});
