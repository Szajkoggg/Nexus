// The server's speed benchmark (queue SB): a development instance of this checkout on a synthetic .nexus shaped like
// Nexus's own (packages/protocol/test/synthetic.ts: the same tree for the same seed, never a copy of a real one), at
// each scale asked (default 1x and 4x), each once on a quiet machine and once with test files running beside it (the
// machine as busy as under `npm test`). Measured each time: the start (until the server answers with the project's
// state), the dashboard's typical reads (each asked --rounds times one after another, after a first round not
// counted), a change (an event appended to a session's log until
// the dashboards are told: the watch, the rebuild, the decisions, the broadcast), and what the server measured of
// itself (GET /api/server/perf: the loop's delay, its blocks during the measurement, its longest operations).
//
//   node scripts/server-speed.ts [--scales 1,4] [--tests both|with|without] [--rounds 10] [--changes 10]
//                                [--port 4319] [--seed 20261120] [--label <name>] [--out <file>] [--no-record] [--keep]
//
// The run is appended as one line to <NEXUS_HOME>/benchmarks/server-speed.jsonl (or --out), which the global Stats view
// draws as a trend (docs/protocol/files.md; docs/design/performance.md, "The speed benchmark"); --no-record only prints
// it. Each configuration lives in a new folder in the system's temporary folder (its own NEXUS_HOME, the tree, the
// server's log), removed at its end unless --keep. Only the processes this script started are ended, by their own pids.
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import {
  ProjectStore, appendServerSpeed, newId, serverSpeedFile, updateSettings, writeRegistry,
  type Event, type ServerSpeedConfig, type ServerSpeedRun,
} from "@nexus/protocol";
import { generateNexus } from "../packages/protocol/test/synthetic.ts";
import { startInstance } from "./capture/run.ts";

const { values: o } = parseArgs({ options: {
  scales: { type: "string", default: "1,4" }, tests: { type: "string", default: "both" }, rounds: { type: "string", default: "10" },
  changes: { type: "string", default: "10" }, port: { type: "string", default: "4319" }, seed: { type: "string", default: "20261120" },
  label: { type: "string" }, out: { type: "string" }, "no-record": { type: "boolean", default: false }, keep: { type: "boolean", default: false },
} });
const ROOT = resolve(fileURLToPath(import.meta.url), "../..");
const PORT = Number(o.port);
if (!(PORT >= 4318)) throw new Error("port 4317 is the live instance's: use 4318 or above");
const SCALES = o.scales.split(",").map(Number);
if (!SCALES.length || SCALES.some((s) => !(s > 0))) throw new Error("--scales: positive numbers, e.g. 1,4");
if (!["both", "with", "without"].includes(o.tests)) throw new Error("--tests: both, with or without");
const TESTS = o.tests === "both" ? [false, true] : [o.tests === "with"];
const ROUNDS = Number(o.rounds), CHANGES = Number(o.changes), SEED = Number(o.seed);
// The file is the real NEXUS_HOME's, taken before each configuration points NEXUS_HOME at its own folder.
const target = o.out ? resolve(o.out) : serverSpeedFile();
delete process.env.NEXUS_DIR;
delete process.env.NEXUS_SESSION;
delete process.env.NEXUS_HANDOVER;

const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" }).trim();
const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]! : 0; };
const r1 = (ms: number) => Math.round(ms * 10) / 10;

/** Ends a process this script started and what it started (by its pid only). */
function stop(child: ChildProcess): void {
  if (child.exitCode !== null || !child.pid) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/T", "/F", "/PID", String(child.pid)], { stdio: "ignore" });
  else child.kill("SIGKILL");
}

/**
 * The test suite beside the server: the protocol package's test files under `node --test` (run in parallel, as npm test
 * runs them, through the server's model of the files), started again whenever a run ends, until stopped.
 */
function testLoad(): { stop: () => void; runs: () => number } {
  const env = { ...process.env };
  delete env.NEXUS_HOME;
  let child: ChildProcess | undefined, stopped = false, runs = 0;
  const next = () => {
    if (stopped) return;
    runs++;
    child = spawn(process.execPath, ["--import", "./apps/server/test/model-reads.ts", "--test", "--test-reporter=dot", "packages/protocol/test/*.test.ts"],
      { cwd: ROOT, env, stdio: "ignore", windowsHide: true });
    child.on("exit", () => setTimeout(next, 200));
  };
  next();
  return { stop: () => { stopped = true; if (child) stop(child); }, runs: () => runs };
}

type State = { queues: { id: string; steps: { id: string; status: string; session?: string | null }[] }[] };

async function measure(scale: number, tests: boolean): Promise<ServerSpeedConfig> {
  const home = mkdtempSync(join(tmpdir(), "nexus-speed-"));
  process.env.NEXUS_HOME = home;
  const root = join(home, "synthetic");
  const t0 = performance.now();
  generateNexus(root, { scale, seed: SEED });
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["-c", "user.email=speed@example.invalid", "-c", "user.name=speed", "commit", "-q", "--allow-empty", "-m", "synthetic"]);
  const st = ProjectStore.forRoot(root);
  updateSettings(st, { orchestrator: { notify: false } });
  writeRegistry({ protocol: 1, projects: [{ id: "synthetic", root }] });
  console.log(`\n${scale}x ${tests ? "with" : "without"} tests: generated in ${((performance.now() - t0) / 1000).toFixed(1)} s (${home})`);
  const load = tests ? testLoad() : undefined;
  let inst: Awaited<ReturnType<typeof startInstance>> | undefined;
  let ws: WebSocket | undefined;
  try {
    if (load) await sleep(5000); // the tests at full speed before the server starts
    const s0 = performance.now();
    inst = await startInstance({ root: ROOT, home, port: PORT, waitMs: 600_000, parentEnv: { ...process.env, NEXUS_LOG: join(home, "server.log") } });
    const url = inst.url, p = "/api/projects/synthetic";
    const state = await (await fetch(`${url}${p}/state`)).json() as State;
    const startup = performance.now() - s0;
    console.log(`  the server answered with the project's state after ${(startup / 1000).toFixed(1)} s`);

    // The dashboards are told of changes over the socket (and the server publishes only while one listens).
    let told: (() => void) | undefined;
    ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    await new Promise<void>((done, fail) => { ws!.onopen = () => done(); ws!.onerror = () => fail(new Error("the socket did not open")); });
    ws.onmessage = (m) => { const msg = JSON.parse(String(m.data)) as { type: string; project?: string }; if (msg.type === "state" && msg.project === "synthetic") told?.(); };

    const steps = state.queues.flatMap((q) => q.steps.filter((s) => s.session).map((s) => ({ queue: q.id, step: s.id, session: s.session! })));
    const pick = steps[Math.floor(steps.length / 2)];
    if (!pick) throw new Error("the synthetic tree has no step with a session");
    const reads: [string, string][] = [
      ["projects", "/api/projects"], ["server", "/api/server"], ["state", `${p}/state`], ["conversations", `${p}/conversations`],
      ["orchestrator", `${p}/orchestrator`], ["estimates", `${p}/estimates`], ["metrics", `${p}/metrics`], ["digest", "/api/digest"],
      ["stats", "/api/stats"], ["usage days", "/api/usage/days"], ["queue git", `${p}/queues/${pick.queue}/git`],
      ["activity", `${p}/sessions/${pick.session}/activity?queue=${pick.queue}&step=${pick.step}`],
    ];
    const from = new Date().toISOString();
    const times = new Map<string, { all: number[]; errors: number }>();
    // A first round not counted: each read's first answer is made from cold (its caches, the model's first reads).
    for (let r = -1; r < ROUNDS; r++) {
      for (const [what, path] of reads) {
        const t = performance.now();
        let ok = false;
        try { const res = await fetch(`${url}${path}`); await res.arrayBuffer(); ok = res.ok; } catch { /* counted */ }
        if (r < 0) continue;
        const x = times.get(what) ?? { all: [], errors: 0 };
        x.all.push(performance.now() - t); if (!ok) x.errors++;
        times.set(what, x);
      }
    }
    const requests = reads.map(([what]) => { const x = times.get(what)!; return { what, count: x.all.length, errors: x.errors, p50_ms: r1(pct(x.all, 50)), p95_ms: r1(pct(x.all, 95)), max_ms: r1(Math.max(...x.all)) }; });

    // A change: a step's progress appended to its worker's events, until the dashboards hear of the new state.
    const changes: number[] = [];
    for (let i = 0; i < CHANGES; i++) {
      const heard = new Promise<boolean>((done) => { told = () => done(true); setTimeout(() => done(false), 15_000); });
      const t = performance.now();
      st.appendEvent({ v: 1, id: newId(), at: new Date().toISOString(), session: pick.session, queue: pick.queue, step: pick.step, type: "step.progress", text: `benchmark change ${i + 1}` } as Event);
      if (await heard) changes.push(performance.now() - t);
      told = undefined;
      await sleep(400);
    }

    const perf = await (await fetch(`${url}/api/server/perf`)).json() as {
      loop: { p50_ms: number; p99_ms: number; max_ms: number }; blocks: { at: string; ms: number }[];
      spans: { what: string; count: number; mean_ms: number; max_ms: number }[];
    };
    const blocks = perf.blocks.filter((b) => b.at >= from);
    const config: ServerSpeedConfig = {
      scale, tests, startup_ms: Math.round(startup), requests,
      reads_p95_ms: r1(pct([...times.values()].flatMap((x) => x.all), 95)),
      change: { count: changes.length, p50_ms: r1(pct(changes, 50)), p95_ms: r1(pct(changes, 95)), max_ms: r1(changes.length ? Math.max(...changes) : 0) },
      loop: { p50_ms: perf.loop.p50_ms, p99_ms: perf.loop.p99_ms, max_ms: perf.loop.max_ms },
      blocks: blocks.length, block_max_ms: Math.max(0, ...blocks.map((b) => b.ms)),
      spans: perf.spans.slice(0, 8).map((s) => ({ what: s.what.replaceAll("synthetic", "<project>"), count: s.count, mean_ms: s.mean_ms, max_ms: s.max_ms })),
    };
    console.log(`  reads p95 ${config.reads_p95_ms} ms; a change told after p50 ${config.change.p50_ms} / p95 ${config.change.p95_ms} ms (${changes.length}/${CHANGES} heard); loop p99 ${config.loop.p99_ms} ms; ${config.blocks} block(s) while measured${load ? `; ${load.runs()} test run(s) beside it` : ""}`);
    for (const r of requests) console.log(`    ${r.what.padEnd(14)} p50 ${r.p50_ms} / p95 ${r.p95_ms} / max ${r.max_ms} ms${r.errors ? ` (${r.errors} failed)` : ""}`);
    return config;
  } finally {
    ws?.close();
    load?.stop();
    await inst?.stop();
    if (!o.keep) { await sleep(500); try { rmSync(home, { recursive: true, force: true }); } catch (err) { console.log(`  not removed: ${home} (${(err as Error).message})`); } }
  }
}

if (await fetch(`http://127.0.0.1:${PORT}/api/server`).then(() => true, () => false)) throw new Error(`port ${PORT} is taken: pick another with --port`);
const configs: ServerSpeedConfig[] = [];
for (const scale of SCALES) for (const tests of TESTS) configs.push(await measure(scale, tests));
const run: ServerSpeedRun = {
  v: 1, at: new Date().toISOString(), commit: git(ROOT, ["rev-parse", "--short", "HEAD"]), dirty: git(ROOT, ["status", "--porcelain"]) !== "",
  ...(o.label ? { label: o.label } : {}), machine: { cores: availableParallelism(), node: process.version }, configs,
};
if (o["no-record"]) console.log(`\n${JSON.stringify(run)}`);
else { appendServerSpeed(run, target); console.log(`\nrecorded in ${target}`); }
