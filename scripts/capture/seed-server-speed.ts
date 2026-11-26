// A seed for the capture tool: the demo project (seed-demo.ts) and eight runs of the server's speed benchmark over the
// last three weeks (queue SB) in <NEXUS_HOME>/benchmarks/server-speed.jsonl, as scripts/server-speed.ts appends them,
// for the global Stats view's "Server speed" section. Made-up figures of the size a real run measures, the same for
// every run of the seed but for the dates (relative to now, so they fall in the 30-day range). Run by
// scripts/capture.ts as `node <this> <data dir>` with NEXUS_HOME set to the development instance's; it writes only there.
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { appendServerSpeed, type ServerSpeedConfig } from "@nexus/protocol";
import { requireTempHome } from "../temp-home.ts";

requireTempHome();

const dir = process.argv[2];
if (!dir) throw new Error("usage: node seed-server-speed.ts <data dir>");
execFileSync(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), "seed-demo.ts"), dir], { stdio: "inherit" });

const DAY = 86_400_000;
// Per run, oldest first: how much slower than the latest run it was (a fix landed between the fourth and the fifth).
const SLOWER = [1.9, 1.85, 2.0, 1.8, 1.15, 1.1, 1.2, 1];
const commits = ["3f2a9c1", "8b41d07", "c90e3a4", "17d5b2e", "a4c8f60", "5e9d1b3", "d27f4a8", "7e252f1"];
function config(scale: number, tests: boolean, k: number): ServerSpeedConfig {
  const busy = tests ? 2.6 : 1, f = k * busy * (scale === 1 ? 1 : 3.2);
  const r = (v: number) => Math.round(v * 10) / 10;
  return {
    scale, tests, startup_ms: Math.round((scale === 1 ? 2300 : 9800) * busy * (0.6 + k * 0.4)),
    requests: [
      { what: "state", count: 10, errors: 0, p50_ms: r(8 * f), p95_ms: r(14 * f), max_ms: r(18 * f) },
      { what: "queue git", count: 10, errors: 0, p50_ms: r(120 * f), p95_ms: r(150 * f), max_ms: r(170 * f) },
      { what: "digest", count: 10, errors: 0, p50_ms: r(16 * f), p95_ms: r(24 * f), max_ms: r(30 * f) },
    ],
    reads_p95_ms: r(150 * f), change: { count: 10, p50_ms: r(230 * f * 0.8), p95_ms: r(270 * f * 0.8), max_ms: r(300 * f * 0.8) },
    loop: { p50_ms: r(10.2 * busy), p99_ms: r(60 * f * 0.9), max_ms: r(300 * f) }, blocks: Math.round(k * busy * (scale === 1 ? 1 : 3)), block_max_ms: r(240 * f),
  };
}
SLOWER.forEach((k, i) => {
  const at = new Date(Date.now() - (21 - i * 3) * DAY + 3600_000).toISOString();
  appendServerSpeed({
    v: 1, at, commit: commits[i], machine: { cores: 16, node: "v26.13.1" },
    configs: [config(1, false, k), config(1, true, k), config(4, false, k), config(4, true, k)],
  });
});
