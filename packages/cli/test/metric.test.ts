// `nexus metric define|record|list` (queue ST2, docs/protocol/stats.md "Project metrics"): the orchestrator defines a metric
// (unit, how it is shown, a target, one warning threshold), which the server writes into .nexus/metrics.yaml; a worker
// records a value for its step at work, with the HEAD commit; bad input is refused before anything is written; a
// worker cannot define and an orchestrator cannot record. The server's part is played here by a stand-in that applies
// the orchestrator's events as the server does (defineMetric, then applied.jsonl).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActionError, ProjectStore, defineMetric, loadProjectState, newId, now, type Event } from "@nexus/protocol";
import { cliOut, cliRun } from "./run-cli.ts";

const G = ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false"];

function setup() {
  const root = mkdtempSync(join(tmpdir(), "nexus-cli-metric-"));
  const git = (...a: string[]) => execFileSync("git", [...G, ...a], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q", "-b", "main");
  writeFileSync(join(root, ".gitignore"), ".nexus/\n");
  git("add", ".gitignore"); git("commit", "-qm", "init");
  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  const at = new Date().toISOString();
  store.writeSession({ protocol: 1, id: "w", project: "p", role: "worker", runtime: "claude", cwd: root, launched_by: "nexus", created_at: at, queue: "Q" });
  store.writeSession({ protocol: 1, id: "o", project: "p", role: "orchestrator", runtime: "claude", cwd: root, launched_by: "nexus", created_at: at });
  store.writeQueue({ protocol: 1, id: "Q", title: "Queue", revision: 1, status: "approved", stop_conditions: [], checks: [], steps: [{ id: "Q1", title: "Step", goal: "", acceptance: [] }, { id: "Q2", title: "Next", goal: "", acceptance: [] }] });
  const run = async (session: string, a: string[]) => {
    const env: NodeJS.ProcessEnv = { ...process.env, NEXUS_DIR: store.dir, NEXUS_SESSION: session };
    try { return { out: await cliOut([...a], { cwd: root, env }), err: "" }; }
    catch (e) { return { out: "", err: String((e as { stderr?: string }).stderr ?? e) }; }
  };
  /** The orchestrator's command while a stand-in for the server applies its metric.defined events. */
  const define = async (...a: string[]): Promise<string> => {
    const env: NodeJS.ProcessEnv = { ...process.env, NEXUS_DIR: store.dir, NEXUS_SESSION: "o" };
    const child = cliRun(["metric", "define", ...a], { cwd: root, env }).then((r) => (r.status ? `ERR ${r.stderr}` : r.stdout));
    let done = false;
    void child.then(() => { done = true; });
    while (!done) {
      const applied = new Set(store.readApplied("o").entries.map((x) => x.event));
      for (const e of store.readEvents("o").entries) {
        if (e.type !== "metric.defined" || applied.has(e.id)) continue;
        let ok = true; let message: string;
        try { message = defineMetric(store, e, e.session); } catch (err) { ok = false; message = (err as Error).message; }
        store.appendApplied("o", { at: now(), event: e.id, ok, message });
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    return child;
  };
  const start = (step: string) => store.appendEvent({ v: 1, id: newId(), at: now(), session: "w", type: "step.started", queue: "Q", step } as Event);
  const events = (session: string, type: string) => store.readEvents(session).entries.filter((e) => e.type === type);
  return { root, git, store, run, define, start, events };
}

test("the orchestrator defines a metric with its unit, how it shows, a target and a threshold; changing it replaces the whole definition", async () => {
  const x = setup();
  assert.match(await x.define("bundle-kb", "--unit", "KB", "--show", "bar", "--target", "400", "--warn-above", "500"), /^ok: metric bundle-kb \(KB, bar; target 400; warn above 500\) defined; workers record it with nexus metric record bundle-kb <value>/);
  assert.match(await x.define("fps.p95", "--unit", "fps", "--warn-below=-1.5"), /^ok: metric fps\.p95 \(fps, line; warn below -1\.5\) defined/);
  // A check's time: seconds, without --unit.
  assert.match(await x.define("check:npm test", "--warn-above", "300"), /^ok: metric check:npm test \(s, line; warn above 300\) defined; its values are the check's times/);
  const file = x.store.readMetrics();
  assert.deepEqual(file.metrics.map(({ at: _at, ...m }) => m), [
    { name: "bundle-kb", unit: "KB", show: "bar", target: 400, warn_above: 500, session: "o" },
    { name: "fps.p95", unit: "fps", show: "line", warn_below: -1.5, session: "o" },
    { name: "check:npm test", unit: "s", show: "line", warn_above: 300, session: "o" },
  ]);
  assert.match(await x.define("bundle-kb", "--unit", "KB", "--warn-above", "600"), /^ok: metric bundle-kb \(KB, line; warn above 600\) changed/);
  assert.deepEqual(x.store.readMetrics().metrics.map((m) => [m.name, m.target, m.warn_above]), [["bundle-kb", undefined, 600], ["fps.p95", undefined, undefined], ["check:npm test", undefined, 300]], "the whole definition is replaced, in its place");
  assert.equal(loadProjectState(x.store).metrics.metrics.length, 3, "the state carries the definitions");
  const list = (await x.run("w", ["metric", "list"])).out;
  assert.match(list, /^ {2}bundle-kb \(KB, line; warn above 600\)$/m);
  assert.match(list, /every check's time is a metric too: check:<the check's name> \(s\)/);
});

test("a bad definition is refused before anything is written", async () => {
  const x = setup();
  const bad: [string[], RegExp][] = [
    [["Bundle KB", "--unit", "KB"], /a metric's name is lowercase words/],
    [["bundle-kb"], /a metric needs its unit/],
    [["bundle-kb", "--unit", "kilo bytes"], /a unit is one short word/],
    [["bundle-kb", "--unit", "KB", "--show", "pie"], /--show is one of line, bar, number, not pie/],
    [["bundle-kb", "--unit", "KB", "--target", "lots"], /--target takes a number/],
    [["bundle-kb", "--unit", "KB", "--warn-above", "5", "--warn-below", "1"], /one warning threshold: --warn-above or --warn-below, not both/],
    [["check:npm test", "--unit", "ms"], /a check's time is in seconds: its unit is s/],
    [["check:"], /a check's time is check:<the check's name/],
  ];
  for (const [a, re] of bad) {
    const r = await x.run("o", ["metric", "define", ...a]);
    assert.match(r.err, re, a.join(" "));
  }
  assert.equal(x.events("o", "metric.defined").length, 0, "nothing was written");
  // The server checks it too, should an event come in another way.
  assert.throws(() => defineMetric(x.store, { name: "x y", unit: "KB" }), (e: unknown) => e instanceof ActionError && /lowercase words/.test(e.message));
});

test("a worker records a value for its step at work, with the metric's unit and the HEAD commit", async () => {
  const x = setup();
  await x.define("bundle-kb", "--unit", "KB", "--warn-above", "500");
  x.start("Q1");
  writeFileSync(join(x.root, "a.txt"), "a\n"); x.git("add", "a.txt"); x.git("commit", "-qm", "work");
  const head = x.git("rev-parse", "HEAD");
  assert.match((await x.run("w", ["metric", "record", "bundle-kb", "512.5"])).out, new RegExp(`^ok: bundle-kb = 512\\.5 KB for Q/Q1 at ${head.slice(0, 7)}`));
  await x.run("w", ["metric", "record", "bundle-kb", "480", "--step", "Q2"]);
  const recorded = x.events("w", "metric.recorded") as Extract<Event, { type: "metric.recorded" }>[];
  assert.deepEqual(recorded.map((e) => [e.queue, e.step, e.name, e.value, e.unit, e.commit]), [["Q", "Q1", "bundle-kb", 512.5, "KB", head], ["Q", "Q2", "bundle-kb", 480, "KB", head]]);
  // In the step's view, with the mark of a value beyond the threshold; a check's time is a metric too.
  await x.run("w", ["check", "Q1", "npm test", "--ok", "--duration", "12"]);
  const steps = loadProjectState(x.store).queues[0]!.steps;
  assert.deepEqual(steps[0]!.metrics.map((m) => [m.name, m.value, m.unit, m.commit, m.warn]), [
    ["bundle-kb", 512.5, "KB", head, { side: "above", limit: 500 }],
    ["check:npm test", 12, "s", head, undefined],
  ]);
  assert.equal(steps[1]!.metrics[0]!.warn, undefined, "480 is within the threshold");
});

test("a bad value, an unknown metric, a check's time, or no step at work is refused, and nothing is written", async () => {
  const x = setup();
  await x.define("bundle-kb", "--unit", "KB");
  assert.match((await x.run("w", ["metric", "record", "bundle-kb", "12"])).err, /none of your steps is at work: add --step <step>/);
  x.start("Q1");
  for (const bad of ["12kb", "", "Infinity", "abc"]) assert.match((await x.run("w", ["metric", "record", "bundle-kb", bad])).err, /takes a number|missing <value>/, bad);
  assert.match((await x.run("w", ["metric", "record", "size", "12"])).err, /the project has no metric size \(it has bundle-kb\); the orchestrator defines metrics with nexus metric define/);
  assert.match((await x.run("w", ["metric", "record", "check:npm test", "12"])).err, /is recorded by nexus check <step> <name> --ok\|--fail --duration/);
  assert.match((await x.run("w", ["metric", "record", "bundle-kb", "12", "--step", "Q9"])).err, /queue Q has no step Q9/);
  assert.equal(x.events("w", "metric.recorded").length, 0);
});

test("a worker cannot define a metric, and an orchestrator cannot record one; the loader ignores a recording that is not a worker's", async () => {
  const x = setup();
  assert.match((await x.run("w", ["metric", "define", "bundle-kb", "--unit", "KB"])).err, /only an orchestrator session may do this/);
  assert.equal(x.events("w", "metric.defined").length, 0);
  await x.define("bundle-kb", "--unit", "KB", "--warn-above", "1");
  x.start("Q1");
  assert.match((await x.run("o", ["metric", "record", "bundle-kb", "12", "--step", "Q1"])).err, /only a worker records a metric's value/);
  assert.equal(x.events("o", "metric.recorded").length, 0);
  // Written by hand into the orchestrator's log: ignored, with a warning.
  x.store.appendEvent({ v: 1, id: newId(), at: now(), session: "o", type: "metric.recorded", queue: "Q", step: "Q1", name: "bundle-kb", value: 9, unit: "KB" });
  const state = loadProjectState(x.store);
  assert.deepEqual(state.queues[0]!.steps[0]!.metrics, []);
  assert.ok(state.warnings.some((w) => /metric\.recorded is for workers; ignored/.test(w)));
});
