// Runs test files under made-up load, to bring out tests that fail only on a busy machine (queues SF3 and FU4).
//
//   node scripts/load-tests.mjs [--burners N] [--copies N] [--rounds N] [--pattern TEXT] [--wait-ms N] <test file>...
//
//   --burners  busy-loop processes pinning cores (default 12; the user's machine has 16 logical cores)
//   --copies   how many `node --test` processes run the files at once (default 4)
//   --rounds   how many times to do that (default 1): copies × rounds runs in all
//   --pattern  a --test-name-pattern for each run
//   --wait-ms  the tests' wait (NEXUS_TEST_WAIT_MS, apps/server/test/wait.ts) for these runs: default 50000, five
//              times the usual, as under this load the waits took four to five times as long as in a full suite run
//              (queue TS1). A load run looks for races, not for slowness; with --wait-ms 10000 it looks for both.
//
// Each run is reported with what failed and the "timed out waiting for …" lines it printed, and a failed run's whole
// output is kept in a file the report names; the end says how many runs passed. Only the processes this script started are ended (by their own handles). The environment of a Nexus
// session (NEXUS_HANDOVER, NEXUS_DIR, NEXUS_SESSION) is cleared for the runs, as the test helpers expect.
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values: o, positionals: files } = parseArgs({
  allowPositionals: true,
  options: { burners: { type: "string", default: "12" }, copies: { type: "string", default: "4" }, rounds: { type: "string", default: "1" }, pattern: { type: "string" }, "wait-ms": { type: "string", default: "50000" } },
});
if (!files.length) { console.error("usage: node scripts/load-tests.mjs [--burners N] [--copies N] [--rounds N] [--pattern TEXT] <test file>..."); process.exit(2); }
const [burners, copies, rounds] = [o.burners, o.copies, o.rounds].map(Number);

const burn = Array.from({ length: burners }, () => spawn(process.execPath, ["-e", "for(;;){}"], { stdio: "ignore", windowsHide: true }));
const stopBurners = () => { for (const b of burn) if (b.exitCode === null) b.kill(); };
process.on("SIGINT", () => { stopBurners(); process.exit(130); });
const env = { ...process.env };
delete env.NEXUS_HANDOVER; delete env.NEXUS_DIR; delete env.NEXUS_SESSION;
env.NEXUS_TEST_WAIT_MS = o["wait-ms"];
let logs;

const one = (n) => new Promise((resolve) => {
  const args = ["--test", ...(o.pattern ? [`--test-name-pattern=${o.pattern}`] : []), ...files];
  const t = Date.now();
  const p = spawn(process.execPath, args, { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let out = "";
  p.stdout.on("data", (d) => (out += d));
  p.stderr.on("data", (d) => (out += d));
  p.on("exit", () => {
    const pass = Number(/ℹ pass (\d+)/.exec(out)?.[1] ?? 0), fail = Number(/ℹ fail (\d+)/.exec(out)?.[1] ?? -1);
    const failed = [...out.matchAll(/^✖ (.+?) \(\d/gm)].map((m) => m[1]).filter((x, i, a) => a.indexOf(x) === i && x !== "failing tests:");
    const why = [...out.matchAll(/(timed out waiting for [^\n]{0,700}|AssertionError[^\n]{0,400})/g)].map((m) => m[0]).filter((x, i, a) => a.indexOf(x) === i);
    // Tests (and files) that took over a minute: a wait that hangs shows here even when the run passes in the end.
    const slow = [...out.matchAll(/^\s*[✔✖] (.+?) \((\d+(?:\.\d+)?)ms\)/gm)].filter((m) => Number(m[2]) > 60_000).map((m) => `${m[1]} (${Math.round(Number(m[2]) / 1000)} s)`);
    let log;
    if (fail !== 0) { logs ??= mkdtempSync(join(tmpdir(), "load-tests-")); log = join(logs, `run-${n}-${Date.now()}.log`); writeFileSync(log, out); }
    resolve({ n, secs: Math.round((Date.now() - t) / 1000), pass, fail, failed, why, slow, log });
  });
});

let total = 0, bad = 0;
try {
  for (let r = 1; r <= rounds; r++) {
    const res = await Promise.all(Array.from({ length: copies }, (_, i) => one(i + 1)));
    for (const x of res) {
      total++; if (x.fail !== 0) bad++;
      console.log(`round ${r} copy ${x.n}: ${x.fail === 0 ? "PASS" : "FAIL"} pass=${x.pass} fail=${x.fail} ${x.secs}s${x.failed.length ? `\n  failed: ${x.failed.join(" | ")}` : ""}${x.why.length ? `\n  ${x.why.join("\n  ")}` : ""}${x.slow.length ? `\n  slow: ${x.slow.join(" | ")}` : ""}${x.log ? `\n  output: ${x.log}` : ""}`);
    }
  }
} finally { stopBurners(); }
console.log(`\n${burners} burners, ${copies} copies x ${rounds} rounds, waits of ${o["wait-ms"]} ms: ${total - bad}/${total} runs passed`);
process.exit(0);
