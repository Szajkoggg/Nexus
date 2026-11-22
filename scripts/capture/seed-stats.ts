// A seed for the capture tool: the global Stats view (queue ST3) with a month of made-up history. Two projects, "demo"
// (most of the work) and "garden", their steps over the last 30 days with outcomes (accepted in the first round, sent
// back once, failed, stopped), tags on every step, and a worker turn per round in turns.jsonl with its model, effort,
// runtime, tokens and the usage windows before and after it (Claude Code's 5-hour and 7-day windows, Codex's weekly
// one), so the estimates and the windows day by day have something to show. The models: opus, sonnet, fable and
// haiku (a few-data group, its turns without an effort: the runtime's default) on Claude Code, gpt-6 on Codex, some of
// its turns a Claude step's fallback. Seeded random, so two runs of a day give the same picture. Run by
// scripts/capture.ts as `node <this> <data dir>` with NEXUS_HOME set to the development instance's; it writes only there.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ProjectStore, appendTurn, approveQueue, newId, writeRegistry, type Event, type StepDef, type TurnRecord } from "@nexus/protocol";

const dir = process.argv[2];
if (!dir) throw new Error("usage: node seed-stats.ts <data dir>");

let seed = 20261115;
const rnd = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
const weighted = <T,>(xs: readonly [T, number][]): T => { let r = rnd() * xs.reduce((a, [, w]) => a + w, 0); for (const [x, w] of xs) { r -= w; if (r <= 0) return x; } return xs.at(-1)![0]; };

const MODELS = {
  opus: { runtime: "claude", efforts: ["high", "xhigh"], minutes: 32, first: 0.82, rate: 0.0065 },
  sonnet: { runtime: "claude", efforts: ["medium", "high"], minutes: 21, first: 0.72, rate: 0.0045 },
  "gpt-6": { runtime: "codex", efforts: ["high"], minutes: 26, first: 0.66, rate: 0.0007 },
  fable: { runtime: "claude", efforts: ["max"], minutes: 42, first: 0.88, rate: 0.011 },
  haiku: { runtime: "claude", efforts: ["low"], minutes: 6, first: 0.9, rate: 0.0015 },
} as const;
type Model = keyof typeof MODELS;

function project(id: string, name: string) {
  const root = join(dir!, id);
  mkdirSync(root, { recursive: true });
  const store = ProjectStore.init(root, { id, name, root });
  store.writeTags({ ...store.readTags(), areas: ["dashboard", "engine", "protocol", "cli"].map((n) => ({ name: n, at: new Date(Date.now() - 60 * 86_400_000).toISOString() })) });
  store.writeSession({ protocol: 1, id: "user", project: id, role: "user", runtime: "claude", title: "You", cwd: root, launched_by: "nexus", created_at: new Date(Date.now() - 40 * 86_400_000).toISOString() } as never);
  return { id, root, store };
}
const demo = project("demo", "Demo app");
const garden = project("garden", "Garden app");
writeRegistry({ protocol: 1, projects: [{ id: demo.id, root: demo.root }, { id: garden.id, root: garden.root }] });

// The windows as the account sees them: each runtime's, growing with its turns and reset on schedule.
const now = Date.now();
const local = (d: Date, h: number, m = 0) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m).getTime();
const nextWeekday = (t: number, weekday: number) => { const d = new Date(t); const add = (weekday - d.getDay() + 7) % 7 || 7; return local(new Date(d.getFullYear(), d.getMonth(), d.getDate() + add), 6); };
const win = { five: { u: 0, reset: 0 }, seven: { u: 0.05, reset: 0 }, codex: { u: 0.02, reset: 0 } };
const read = (t: number) => {
  if (t >= win.five.reset) { win.five = { u: 0, reset: t + 5 * 3_600_000 }; }
  if (t >= win.seven.reset) { win.seven = { u: win.seven.reset ? 0 : win.seven.u, reset: nextWeekday(t, 4) }; }
  if (t >= win.codex.reset) { win.codex = { u: win.codex.reset ? 0 : win.codex.u, reset: nextWeekday(t, 1) }; }
};
const iso = (t: number) => new Date(t).toISOString();
const snapshot = (runtime: string): TurnRecord["windows_end"] => runtime === "claude"
  ? { five_hour: { utilization: win.five.u, resets_at: iso(win.five.reset) }, seven_day: { utilization: win.seven.u, resets_at: iso(win.seven.reset) } }
  : { codex_7d: { utilization: win.codex.u, resets_at: iso(win.codex.reset) } };

const KINDS = [["code", 5], ["design", 1], ["debugging", 1.5], ["docs", 1], ["mechanical", 1]] as const;
const ACTIVITIES = ["feature", "ui", "test", "bugfix", "refactor", "capture", "performance"] as const;
let queueNo = 0;

for (let back = 29; back >= 0; back--) {
  const day = new Date(now - back * 86_400_000);
  const weekend = day.getDay() === 0 || day.getDay() === 6;
  const count = weekend ? Math.floor(rnd() * 3) : 3 + Math.floor(rnd() * 5);
  if (!count) continue;
  const p = rnd() < 0.8 ? demo : garden;
  const qid = `S${String(++queueNo).padStart(2, "0")}`;
  const session = `w-${qid}`;
  p.store.writeSession({ protocol: 1, id: session, project: p.id, role: "worker", runtime: "claude", title: `${qid} worker`, cwd: p.root, launched_by: "nexus", created_at: iso(local(day, 7)), queue: qid });
  const steps: (StepDef & { model: Model; effort: string })[] = [];
  for (let i = 1; i <= count; i++) {
    const model = weighted<Model>([["opus", 45], ["sonnet", 30], ["gpt-6", 15], ["fable", 7], ["haiku", 2]]);
    const kind = weighted(KINDS.map(([k, w]) => [k, w] as [string, number]));
    steps.push({
      id: `${qid}.${i}`, title: `Step ${i} of ${qid}`, goal: "g", acceptance: ["Done"], model, effort: pick(MODELS[model].efforts),
      kind: kind as StepDef["kind"], activities: [pick(ACTIVITIES), ...(rnd() < 0.3 ? [pick(ACTIVITIES)] : [])].filter((a, j, xs) => xs.indexOf(a) === j) as StepDef["activities"],
      area: pick(["dashboard", "engine", "protocol", "cli"]), size: pick(["S", "M", "M", "L"]) as StepDef["size"], origin: weighted([["user", 5], ["orchestrator", 3], ["maintenance", 1]]) as StepDef["origin"],
    });
  }
  p.store.writeQueue({ protocol: 1, id: qid, title: `Queue ${qid}`, revision: 1, status: "proposed", stop_conditions: [], checks: [], steps: steps.map(({ model: _m, effort: _e, ...s }) => s) });
  approveQueue(p.store, qid);
  const emit = (t: number, who: string, body: Record<string, unknown>) => p.store.appendEvent({ v: 1, id: newId(), at: iso(t), session: who, queue: qid, ...body } as Event);

  let t = local(day, 8, Math.floor(rnd() * 50));
  for (const s of steps) {
    const m = MODELS[s.model];
    const fails = rnd() < 0.04, stops = !fails && rnd() < 0.03, sentBack = !fails && rnd() > m.first;
    const rounds = fails ? 1 : sentBack ? 2 : 1;
    const fallback = s.model === "gpt-6" && rnd() < 0.3;
    if (stops) { emit(t, session, { type: "step.started", step: s.id }); t += 5 * 60_000; emit(t, session, { type: "queue.stop", step: s.id, condition: "c", reason: "r" }); t += 20 * 60_000; }
    for (let r = 1; r <= rounds; r++) {
      const minutes = Math.max(2, m.minutes * (0.45 + rnd() * 1.2) * (r > 1 ? 0.5 : 1));
      const end = t + minutes * 60_000;
      if (end > now) break;
      read(t);
      const before = snapshot(m.runtime);
      const grow = minutes * m.rate * (0.8 + rnd() * 0.4);
      if (m.runtime === "claude") { win.five.u = Math.min(1, win.five.u + grow); win.seven.u = Math.min(1, win.seven.u + grow * 0.09); }
      else win.codex.u = Math.min(1, win.codex.u + grow * 2);
      appendTurn({
        v: 1, at: iso(end), started_at: iso(t), duration_ms: Math.round(minutes * 60_000), project: p.id, session, role: "worker",
        runtime: m.runtime, model: s.model, ...(s.model === "haiku" ? {} : { effort: s.effort }), queue: qid, step: s.id, outcome: "ok",
        tokens: { input: Math.round(minutes * 4000), output: Math.round(minutes * 900), cache_read: Math.round(minutes * 30_000), cache_creation: 0 },
        ...(fallback ? { fallback: { from: "claude" as const, reason: "the 5-hour window is full" } } : {}),
        windows_start: before, windows_end: snapshot(m.runtime),
      });
      emit(t, session, { type: "step.started", step: s.id });
      if (fails) { emit(end, session, { type: "step.failed", step: s.id, reason: "cannot be done as written" }); t = end + 10 * 60_000; break; }
      emit(end, session, { type: "step.done", step: s.id, summary: "Done." });
      const review = end + 12 * 60_000;
      if (review > now) break;
      emit(review, "user", { type: r < rounds ? "review.sent_back" : "review.accepted", step: s.id, ...(r < rounds ? { text: "Fix the spacing." } : {}) });
      t = review + 8 * 60_000;
    }
    t += Math.floor(rnd() * 40) * 60_000;
  }
}
console.log(`seeded ${demo.root} and ${garden.root}`);
