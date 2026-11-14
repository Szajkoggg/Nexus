// A turn that ends while the agent's background work runs (a command, a sub-agent) is not a turn without an outcome:
// the engine waits for the work's end, up to a limit, and then the usual rule applies (DESIGN.md, "Background work").
// Against the fake runtimes, which report background work as the probes of 2026-11-14 saw it: Claude Code starts a
// turn by itself when the work ends, Codex does not.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectStore, approveQueue, loadProjectState, routeAnswers, type StepDef } from "@nexus/protocol";
import { Engine, type EngineOptions } from "../src/engine.ts";
import { acceptReviews } from "./fake-reviewer.ts";
import { WAIT_MS, until as waitUntil, LONGER } from "./wait.ts";

const here = dirname(fileURLToPath(import.meta.url));
process.env.NEXUS_CLAUDE = join(here, "fake-claude.ts");
process.env.NEXUS_CODEX = join(here, "fake-codex.ts");
process.env.FAKE_BG_MS = "1500";

function setup(behaviour: string, options: EngineOptions) {
  const root = mkdtempSync(join(tmpdir(), "nexus-background-"));
  process.env.NEXUS_HOME = join(root, "home");
  process.env.FAKE_LOG = join(root, "fake.log");
  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  const steps: StepDef[] = [{ id: "B1", title: "Background", goal: `FAKE: ${behaviour}`, acceptance: [] }];
  store.writeQueue({ protocol: 1, id: "Q", title: "Queue", revision: 1, status: "proposed", stop_conditions: [], checks: [], steps, approvals: [], history: [] });
  approveQueue(store, "Q");
  const engine: Engine = new Engine(store, () => { routeAnswers(store); acceptReviews(store); engine.onChange(loadProjectState(store)); }, { retryBaseMs: 30, usageMarginMs: 100, ...options });
  const queue = () => loadProjectState(store).queues.find((q) => q.id === "Q")!;
  const received = () => (existsSync(process.env.FAKE_LOG!) ? readFileSync(process.env.FAKE_LOG!, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { text: string }) : []);
  const activity = () => store.readActivity(queue().run!.session).entries.map((a) => a.text);
  const until = (what: string, pred: () => boolean, ms = WAIT_MS) => waitUntil(what, pred, ms, () => `; run: ${JSON.stringify(queue().run)}`);
  return { engine, queue, received, activity, until };
}

const cases = [["claude", "background"], ["claude", "bgagent"], ["codex", "background"], ["codex", "bgagent"]] as const;
for (const [runtime, behaviour] of cases) {
  test(`${runtime}: a turn that ends with ${behaviour === "bgagent" ? "a sub-agent" : "a command"} in the background waits for it, then the step goes on`, async () => {
    const { engine, queue, received, activity, until } = setup(behaviour, { backgroundLimitMs: 60_000 });
    try {
      engine.start("Q", { runtime });
      await until("the wait for the background work", () => activity().some((t) => /Nexus waits for it, up to 1 min/.test(t)));
      // While the work runs, the turn's end is no turn without an outcome: no nudge, no halt.
      assert.equal(queue().run?.state, "running");
      assert.equal(received().filter((m) => m.text.includes("has no outcome yet")).length, 0);
      await until("the run to finish", () => queue().run?.state === "finished", LONGER.run);
      assert.equal(queue().steps[0]!.status, "done");
      assert.match(queue().steps[0]!.summary ?? "", /after its background work/);
      const nudges = received().filter((m) => m.text.includes("has no outcome yet")).map((m) => m.text);
      // Claude Code starts a turn by itself when the work ends; Codex does not, so Nexus tells it the work has finished.
      if (runtime === "claude") assert.deepEqual(nudges, []);
      else { assert.equal(nudges.length, 1); assert.match(nudges[0]!, /^\[Nexus\] The background work you started has finished, and step B1 has no outcome yet/); }
    } finally { engine.shutdown(); }
  });

  if (behaviour === "background") test(`${runtime}: background work that outlasts the limit gets the usual rule: one nudge, then the run halts`, async () => {
    const { engine, queue, received, activity, until } = setup("bglong", { backgroundLimitMs: 1500 });
    try {
      const started = Date.now();
      engine.start("Q", { runtime });
      await until("the run to halt", () => queue().run?.state === "halted", LONGER.run);
      assert.ok(Date.now() - started >= 1500, "the halt comes after the limit");
      assert.match(queue().run!.reason!, /ended twice without an outcome/);
      const nudges = received().filter((m) => m.text.includes("has no outcome yet")).map((m) => m.text);
      assert.equal(nudges.length, 1);
      assert.match(nudges[0]!, /with work still running in the background \(.+\), and step B1 has no outcome yet\. Nexus waits for it no longer/);
      assert.ok(activity().some((t) => /background work still runs after .* Nexus waits no longer/.test(t)));
    } finally { engine.shutdown(); }
  });
}
