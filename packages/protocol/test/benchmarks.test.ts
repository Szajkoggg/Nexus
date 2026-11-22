// The server's speed benchmark's result file (queue SB; store.ts readServerSpeed, appendServerSpeed; benchmarks.ts): runs
// appended and read back as the server reads them, a damaged line and a line still being written skipped, the file's
// place under NEXUS_HOME, and the panels the Stats view draws: one per configuration in a fixed order, the runs in the
// order they ended, the range leaving a panel without points rather than dropping it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendServerSpeed, readServerSpeed, serverSpeedFile, speedKey, speedPanels, speedValue,
  type ServerSpeedConfig, type ServerSpeedRun,
} from "../src/index.ts";

function config(scale: number, tests: boolean, base: number): ServerSpeedConfig {
  return {
    scale, tests, startup_ms: base * 100,
    requests: [{ what: "state", count: 10, errors: 0, p50_ms: base, p95_ms: base * 2, max_ms: base * 3 }],
    reads_p95_ms: base * 2, change: { count: 5, p50_ms: base * 4, p95_ms: base * 5, max_ms: base * 6 },
    loop: { p50_ms: 10, p99_ms: base * 7, max_ms: base * 8 }, blocks: 1, block_max_ms: 250,
  };
}
const run = (at: string, base: number, configs = [config(1, false, base), config(1, true, base + 1), config(4, false, base + 2)]): ServerSpeedRun =>
  ({ v: 1, at, commit: "abc1234", machine: { cores: 16, node: "v24.0.0" }, configs });

test("runs appended are read back in order; a damaged line and an unfinished one are skipped", () => {
  const file = join(mkdtempSync(join(tmpdir(), "nexus-speed-")), "benchmarks", "server-speed.jsonl");
  appendServerSpeed(run("2026-11-20T10:00:00.000Z", 10), file);
  appendFileSync(file, "{\"v\":1,\"at\":\"2026-11-20T11:00:00.000Z\"}\nnot json\n");
  appendServerSpeed(run("2026-11-21T10:00:00.000Z", 20), file);
  appendFileSync(file, "{\"v\":1,\"at\":\"2026-11-22");
  const r = readServerSpeed(file);
  assert.deepEqual(r.entries.map((x) => x.at), ["2026-11-20T10:00:00.000Z", "2026-11-21T10:00:00.000Z"]);
  assert.equal(r.errors.length, 2);
  assert.equal(r.entries[1]!.configs[2]!.reads_p95_ms, 44);
  assert.ok(readFileSync(file, "utf8").split("\n")[0]!.startsWith("{\"v\":1,"));
});

test("a run that does not match the schema is refused before it is written", () => {
  const file = join(mkdtempSync(join(tmpdir(), "nexus-speed-")), "server-speed.jsonl");
  assert.throws(() => appendServerSpeed({ ...run("2026-11-20T10:00:00.000Z", 1), configs: [{ scale: 0 } as ServerSpeedConfig] }, file));
  assert.deepEqual(readServerSpeed(file).entries, []);
});

test("the file is under NEXUS_HOME/benchmarks", () => {
  const before = process.env.NEXUS_HOME;
  process.env.NEXUS_HOME = join(tmpdir(), "some-home");
  try { assert.equal(serverSpeedFile(), join(tmpdir(), "some-home", "benchmarks", "server-speed.jsonl")); }
  finally { if (before === undefined) delete process.env.NEXUS_HOME; else process.env.NEXUS_HOME = before; }
});

test("the panels: one per configuration, by scale and tests last, the runs oldest first", () => {
  const runs = [run("2026-11-21T10:00:00.000Z", 20), run("2026-11-20T10:00:00.000Z", 10, [config(4, false, 12), config(1, false, 10)])];
  const panels = speedPanels(runs, "reads");
  assert.deepEqual(panels.map((p) => p.key), ["1x", "1x+tests", "4x"]);
  assert.deepEqual(panels[0]!.points.map((p) => p.value), [20, 40]);
  assert.deepEqual(panels[1]!.points.map((p) => p.value), [42]);
  assert.deepEqual(panels[2]!.points.map((p) => [p.at.slice(0, 10), p.value]), [["2026-11-20", 24], ["2026-11-21", 44]]);
  // The range: the older run left out, its panel kept.
  const since = speedPanels(runs, "startup", "2026-11-21T00:00:00.000Z");
  assert.deepEqual(since.map((p) => p.points.length), [1, 1, 1]);
  assert.deepEqual(speedPanels([run("2026-11-20T10:00:00.000Z", 10)], "loop", "2026-11-21T00:00:00.000Z").map((p) => [p.key, p.points.length]), [["1x", 0], ["1x+tests", 0], ["4x", 0]]);
});

test("each measure reads its own figure", () => {
  const c = config(1, true, 3);
  assert.deepEqual([speedValue(c, "reads"), speedValue(c, "change"), speedValue(c, "startup"), speedValue(c, "loop")], [6, 15, 300, 21]);
  assert.equal(speedKey(c), "1x+tests");
});
