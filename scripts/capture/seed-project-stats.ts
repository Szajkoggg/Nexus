// A seed for the capture tool: a project's Stats tab and a step with a metric beyond its threshold (queue ST3). The
// test project "demo" defines five metrics (bundle-kb: a line with a target and a warning threshold; known-bugs: a
// number; long-files: bars with a threshold; startup-ms: a line no worker has recorded yet), and fourteen accepted
// steps over the last four weeks each record values and two checks' times. The last of them, UI4/UI4.1, waits for
// the user's review with bundle-kb at 457 KB, above its 450 KB threshold. Seeded random, so two runs give the same
// picture. It uses only what the protocol has had since queue ST2 (metric.recorded, metrics.yaml), so it also seeds
// the code of a base commit from then on. Run by scripts/capture.ts as `node <this> <data dir>` with NEXUS_HOME set
// to the development instance's; it writes only there.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ProjectStore, approveQueue, newId, writeRegistry, type Event } from "@nexus/protocol";
import { requireTempHome } from "../temp-home.ts";

requireTempHome();

const dir = process.argv[2];
if (!dir) throw new Error("usage: node seed-project-stats.ts <data dir>");
const root = join(dir, "demo");
mkdirSync(root, { recursive: true });
const st = ProjectStore.init(root, { id: "demo", name: "Demo app", root });
writeRegistry({ protocol: 1, projects: [{ id: "demo", root }] });

let seed = 21;
const rnd = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const hex = () => Array.from({ length: 7 }, () => "0123456789abcdef"[Math.floor(rnd() * 16)]).join("");
const iso = (t: number) => new Date(t).toISOString();
const now = Date.now();
const created = iso(now - 40 * 86_400_000);

st.writeMetrics({ protocol: 1, metrics: [
  { name: "bundle-kb", unit: "KB", show: "line", target: 400, warn_above: 450, at: created },
  { name: "known-bugs", unit: "bugs", show: "number", target: 0, at: created },
  { name: "long-files", unit: "files", show: "bar", target: 0, warn_above: 12, at: created },
  { name: "startup-ms", unit: "ms", show: "line", target: 800, at: created },
] });
st.writeSession({ protocol: 1, id: "user", project: "demo", role: "user", runtime: "claude", title: "You", cwd: root, launched_by: "nexus", created_at: created } as never);

const steps: [string, string, string][] = [
  ["FB", "FB1", "Fallback rules"], ["FB", "FB2", "Fallback in the rail"], ["RX", "RX1", "One keyed query"], ["RX", "RX2", "Snapshots per change"],
  ["ST1", "ST1.1", "Tags in queue.yaml"], ["ST1", "ST1.2", "Tags on the cards"], ["ST2", "ST2.1", "Metric define and record"], ["ST2", "ST2.2", "Turn records"],
  ["ST2", "ST2.3", "nexus stats and the endpoints"], ["MX", "MX1", "Merge-back"], ["TS", "TS1", "Test files in parallel"], ["TS", "TS2", "Slow tests split"],
  ["MX", "MX2", "Merge-back on by default"], ["UI4", "UI4.1", "Rail overflow"],
];
const bundle = [388, 391, 396, 402, 405, 409, 418, 426, 431, 424, 419, 421, 421, 457];
const bugs = [6, 6, 5, 5, 7, 6, 5, 5, 4, 5, 4, 3, 3, 3];
const tests = [212, 218, 223, 231, 238, 244, 251, 262, 271, 268, 181, 164, 169, 172];
const build = [21, 21, 22, 22, 23, 22, 23, 24, 24, 24, 24, 23, 24, 25];
const files = [15, 15, 14, 14, 13, 13, 12, 12, 11, 11, 10, 9, 9, 8];

for (const q of [...new Set(steps.map((s) => s[0]))]) {
  const own = steps.filter((s) => s[0] === q);
  st.writeQueue({ protocol: 1, id: q, title: `Queue ${q}`, revision: 1, status: "proposed", stop_conditions: [], checks: [],
    steps: own.map(([, id, title]) => ({ id, title, goal: "g", acceptance: ["Done"] })) });
  approveQueue(st, q);
  st.writeSession({ protocol: 1, id: `w-${q}`, project: "demo", role: "worker", runtime: "claude", title: `${q} worker`, cwd: root, launched_by: "nexus", created_at: created, queue: q });
}

steps.forEach(([q, id], i) => {
  const start = now - (27 - i * 2) * 86_400_000 - Math.floor(rnd() * 6) * 3_600_000;
  const done = start + 40 * 60_000;
  const commit = hex();
  const emit = (t: number, session: string, body: Record<string, unknown>) => st.appendEvent({ v: 1, id: newId(), at: iso(t), session, queue: q, step: id, ...body } as Event);
  const w = `w-${q}`;
  emit(start, w, { type: "step.started" });
  emit(done - 6 * 60_000, w, { type: "check.result", name: "npm test", ok: true, duration: tests[i], commit });
  emit(done - 5 * 60_000, w, { type: "check.result", name: "npm run build -w @nexus/web", ok: true, duration: build[i], commit });
  emit(done - 4 * 60_000, w, { type: "metric.recorded", name: "bundle-kb", value: bundle[i], unit: "KB", commit });
  emit(done - 3 * 60_000, w, { type: "metric.recorded", name: "known-bugs", value: bugs[i], unit: "bugs", commit });
  emit(done - 2 * 60_000, w, { type: "metric.recorded", name: "long-files", value: files[i], unit: "files", commit });
  emit(done, w, { type: "step.done", summary: `${id} is done: the bundle is ${bundle[i]} KB.` });
  if (i < steps.length - 1) emit(done + 15 * 60_000, "user", { type: "review.accepted" });
});
console.log(`seeded ${root}`);
