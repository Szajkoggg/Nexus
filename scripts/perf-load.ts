// The server under a load like the live instance's (queue SV1): a development instance with a generated project the
// size of Nexus's own .nexus (136 queues, about 245 sessions, 6,000 events, 39,000 activity lines, 6,000 chat lines;
// never a copy of a real one), a few queues running on the fake runtimes in worktrees of their own, dashboards that
// read what the real one reads on every change notification, and agents' activity appended as the agent host would.
// At the end it prints what the server measured of itself (GET /api/server/perf, src/perf.ts) and what the dashboards
// waited per endpoint, and writes both as JSON.
//
//   node scripts/perf-load.ts [--minutes 3] [--port 4319] [--dashboards 2] [--running 2] [--activity-ms 400]
//                             [--label <name>] [--out <dir>] [--keep] [--page]
//
// --page opens the real dashboard (the instance serves apps/web/dist: build it first) in headless Edge at 1440 px on a
// running queue's step, and counts the requests the page sends and the bytes they bring back, per minute of the run
// (queue SD's measurement). Use it with --dashboards 0 so that only the page reads.
//
// Everything lives in a new folder in the system's temporary folder (NEXUS_HOME, the project, the server's log);
// it is removed at the end unless --keep. Run it beside `npm test` to measure under the full suite.
import { errorText } from "@nexus/protocol/errors";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { requireTempHome } from "./temp-home.ts";

const { values: o } = parseArgs({ options: {
  minutes: { type: "string", default: "3" }, port: { type: "string", default: "4319" }, dashboards: { type: "string", default: "2" },
  running: { type: "string", default: "2" }, "activity-ms": { type: "string", default: "400" }, label: { type: "string", default: "load" },
  out: { type: "string" }, keep: { type: "boolean", default: false }, page: { type: "boolean", default: false },
} });
const ROOT = resolve(fileURLToPath(import.meta.url), "../..");
const PORT = Number(o.port);
if (PORT === 4317 || PORT < 4318) throw new Error("port 4317 is the live instance's: use 4318 or above");

const home = mkdtempSync(join(tmpdir(), "nexus-perf-"));
// Set before the protocol is loaded: the registry and the global settings are written into this home only.
process.env.NEXUS_HOME = home;
requireTempHome();
delete process.env.NEXUS_DIR;
delete process.env.NEXUS_SESSION;
const { ProjectStore, approveQueue, newId, updateSettings, writeRegistry } = await import("@nexus/protocol");
type Event = import("@nexus/protocol").Event;
const { startInstance } = await import("./capture/run.ts");

let seed = 20261120;
const rnd = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const words = "the server reads every file of the project and rebuilds its state then the engine decides what to start next while the dashboard asks again for the queue the steps the sessions and their activity".split(" ");
const text = (n: number) => Array.from({ length: n }, () => words[Math.floor(rnd() * words.length)]).join(" ");
const iso = (t: number) => new Date(t).toISOString();
const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" }).trim();

// ---------------------------------------------------------------- the world

const QUEUES = 136, STEPS = 4, RUNNING = Number(o.running);
const root = join(home, "big");
function generate(): { running: string[]; sims: string[] } {
  const t0 = Date.now();
  mkdirSync(root, { recursive: true });
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.email", "perf@example.invalid"]);
  git(root, ["config", "user.name", "perf"]);
  // A history to look at: 80 commits over 60 files.
  for (let i = 0; i < 80; i++) {
    const f = join(root, `src/f${i % 60}.ts`);
    mkdirSync(join(root, "src"), { recursive: true });
    appendFileSync(f, `// ${text(12)}\n`);
    git(root, ["add", "src"]);
    git(root, ["commit", "-q", "-m", `change ${i}: ${text(6)}`]);
  }
  const st = ProjectStore.init(root, { id: "big", name: "Big project", root });
  updateSettings(st, { orchestrator: { notify: false } });
  writeRegistry({ protocol: 1, projects: [{ id: "big", root }] });
  const span = 30 * 86_400_000, end = Date.now() - 86_400_000;
  st.writeSession({ protocol: 1, id: "user", project: "big", role: "user", runtime: "claude", title: "You", cwd: root, launched_by: "nexus", created_at: iso(end - span) });
  for (let q = 0; q < QUEUES; q++) {
    const id = `Q${q}`;
    st.writeQueue({ protocol: 1, id, title: `Queue ${id}: ${text(5)}`, description: text(60), revision: 1, status: "proposed", stop_conditions: [text(20), text(20)], checks: [],
      steps: Array.from({ length: STEPS }, (_, s) => ({ id: `${id}.${s + 1}`, title: text(5), goal: text(120), acceptance: [text(15), text(15), text(15)] })) });
    approveQueue(st, id);
    const w = `w-${id}`;
    const start = end - span + (q / QUEUES) * span;
    st.writeSession({ protocol: 1, id: w, project: "big", role: "worker", runtime: "claude", title: `${id} worker`, cwd: root, launched_by: "nexus", created_at: iso(start), queue: id });
    let t = start;
    const emit = (step: string, body: Record<string, unknown>) => { t += 60_000 + rnd() * 600_000; st.appendEvent({ v: 1, id: newId(), at: iso(t), session: w, queue: id, step, ...body } as Event); };
    for (let s = 1; s <= STEPS; s++) {
      const step = `${id}.${s}`;
      emit(step, { type: "step.started" });
      for (let p = 0; p < 3; p++) emit(step, { type: "step.progress", text: text(12) });
      emit(step, { type: "check.result", name: "npm run lint", ok: true, duration: 30 });
      emit(step, { type: "check.result", name: "npm test", ok: true, duration: 400 });
      emit(step, { type: "step.done", summary: text(220) });
      emit(step, { type: "review.accepted" });
      for (let a = 0; a < 40; a++) st.appendActivity(w, { at: iso(t + a * 10_000), kind: a % 3 ? "tool" : "text", text: text(35), queue: id, step });
    }
    writeFileSync(join(st.queueDir(id), "report.md"), `# ${id}\n\n${text(800)}\n`);
    writeFileSync(join(st.queueDir(id), `${id}-full-test.log`), `${text(15)}\n`.repeat(1500));
    // Re-runs and helpers: sessions with activity only, so the project has about as many sessions as Nexus's.
    if (q < 88) {
      const r = `r-${id}`;
      st.writeSession({ protocol: 1, id: r, project: "big", role: "helper", runtime: "claude", title: `${id} review helper`, cwd: root, launched_by: "nexus", created_at: iso(start) });
      for (let a = 0; a < 70; a++) st.appendActivity(r, { at: iso(start + a * 10_000), kind: "tool", text: text(35) });
    }
  }
  // Conversations with long chats (the orchestrator's alone ~1 MB).
  for (let c = 0; c < 21; c++) {
    const id = c === 0 ? "orch" : `c-${c}`;
    st.writeSession({ protocol: 1, id, project: "big", role: c === 0 ? "orchestrator" : "conversation", runtime: "claude", title: `Chat ${c}`, cwd: root, launched_by: "nexus", created_at: iso(end - span), archived: c > 3 });
    const lines = c === 0 ? 2400 : 200;
    for (let l = 0; l < lines; l++) st.appendChat(id, { at: iso(end - span + l * 60_000), from: l % 2 ? "orchestrator" : "user", text: text(c === 0 ? 70 : 40) });
  }
  // The running queues: slow fake steps in worktrees of their own, reviewed by the user (this script accepts them).
  const running: string[] = [];
  for (let r = 1; r <= RUNNING; r++) {
    const id = `R${r}`;
    st.writeQueue({ protocol: 1, id, title: `Running ${id}`, revision: 1, status: "proposed", stop_conditions: [], checks: [], worktree: "auto", review_level: 1,
      steps: Array.from({ length: 8 }, (_, s) => ({ id: `${id}.${s + 1}`, title: `Slow step ${s + 1}`, goal: "FAKE: slow", acceptance: [] })) });
    approveQueue(st, id);
    running.push(id);
  }
  // The agents' streams: sessions whose activity grows while the load runs (the agent host's writes, from outside).
  const sims = Array.from({ length: RUNNING }, (_, i) => `sim-${i + 1}`);
  for (const s of sims) st.writeSession({ protocol: 1, id: s, project: "big", role: "helper", runtime: "claude", title: `Streaming ${s}`, cwd: root, launched_by: "nexus", created_at: iso(end) });
  const size = (dir: string): number => readdirSync(dir, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? size(join(dir, e.name)) : readFileSync(join(dir, e.name)).length), 0);
  console.log(`world: ${QUEUES + RUNNING} queues, ${readdirSync(join(root, ".nexus/sessions")).length} sessions, ${(size(join(root, ".nexus")) / 1e6).toFixed(1)} MB in .nexus, generated in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  return { running, sims };
}

// ---------------------------------------------------------------- the load

interface Latency { count: number; total: number; max: number; all: number[]; errors: number }
const latency = new Map<string, Latency>();
const record = (key: string, ms: number, ok: boolean) => {
  const l = latency.get(key) ?? { count: 0, total: 0, max: 0, all: [], errors: 0 };
  l.count++; l.total += ms; l.max = Math.max(l.max, ms); l.all.push(ms); if (!ok) l.errors++;
  latency.set(key, l);
};
const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]! : 0; };

async function main(): Promise<void> {
  // Another server on the port would be measured instead of this one.
  if (await fetch(`http://127.0.0.1:${PORT}/api/server`).then(() => true, () => false)) throw new Error(`port ${PORT} is taken: pick another with --port`);
  const { running, sims } = generate();
  const log = join(home, "server.log");
  // A large project takes long to start (the engine recovers each queue): it waits up to 5 minutes.
  let inst: Awaited<ReturnType<typeof startInstance>> | undefined;
  const t0 = Date.now();
  try { inst = await startInstance({ root: ROOT, home, port: PORT, waitMs: 300_000, parentEnv: { ...process.env, NEXUS_LOG: log, FAKE_SLOW_MS: "20000", FAKE_LOG: join(home, "fake.log") } }); }
  catch (err) { if (!o.keep) rmSync(home, { recursive: true, force: true }); throw err; }
  const startup = Date.now() - t0;
  console.log(`the instance answered after ${(startup / 1000).toFixed(1)} s`);
  const url = inst.url;
  const headers = { "content-type": "application/json", origin: url, "sec-fetch-site": "same-origin" };
  const post = (path: string, body: unknown) => fetch(`${url}${path}`, { method: "POST", headers, body: JSON.stringify(body) }).then((r) => r.json().catch(() => ({})));
  const get = async (key: string, path: string): Promise<unknown> => {
    const t = performance.now();
    try { const r = await fetch(`${url}${path}`); const body = await r.json().catch(() => undefined); record(key, performance.now() - t, r.ok); return body; }
    catch { record(key, performance.now() - t, false); return undefined; }
  };
  let stopping = false;
  try {
    for (const q of running) console.log(`start ${q}: ${JSON.stringify(await post(`/api/projects/big/queues/${q}/run`, { action: "start" }))}`);
    const until = Date.now() + Number(o.minutes) * 60_000;
    let notifications = 0;
    type State = { queues: { id: string; status: string; steps: { id: string; status: string; session?: string | null }[] }[] };
    let latest: State | undefined;

    // A dashboard: on every notification it reads what an open project page with a running queue's detail reads;
    // notifications that come while it reads make one more round after it (as the dashboard's keyed queries do).
    const dashboard = (n: number) => new Promise<void>((done) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
      let busy = false, again = false;
      const round = async () => {
        if (busy) { again = true; return; }
        busy = true;
        do {
          again = false;
          const p = "/api/projects/big";
          const reads: [string, string][] = [["state", `${p}/state`], ["conversations", `${p}/conversations`], ["orchestrator", `${p}/orchestrator`], ["estimates", `${p}/estimates`],
            ["projects", "/api/projects"], ["server", "/api/server"], ["digest", "/api/digest"], ["usage", "/api/usage"], ["capacity", "/api/capacity"]];
          const q = latest?.queues.find((x) => x.id === running[n % running.length]);
          const step = q?.steps.find((s) => s.status !== "pending") ?? q?.steps[0];
          if (q && step) {
            reads.push(["queue git", `${p}/queues/${q.id}/git`], ["step commits", `${p}/queues/${q.id}/steps/${step.id}/commits`]);
            reads.push(["activity", `${p}/sessions/${sims[n % sims.length]}/activity?queue=${q.id}&step=${step.id}`]);
          }
          const results = await Promise.all(reads.map(([k, path]) => get(k, path)));
          if (n === 0 && results[0]) latest = results[0] as State;
        } while (again && !stopping);
        busy = false;
      };
      ws.onopen = () => void round();
      ws.onmessage = () => { notifications++; void round(); };
      ws.onclose = () => done();
      const t = setInterval(() => { if (stopping) { clearInterval(t); ws.close(); } }, 500);
    });
    const dashboards = Array.from({ length: Number(o.dashboards) }, (_, i) => dashboard(i));

    // The real dashboard (--page): every fetch counted in the page, by path, with the bytes of its answer.
    const browser = o.page ? await (await import("./capture/edge.ts")).EdgeBrowser.launch(join(home, "browser")) : undefined;
    if (browser) {
      const counter = `(() => { const c = window.__reqs = { n: 0, bytes: 0, ws: 0, by: {} }; const f = window.fetch.bind(window);
        window.fetch = async (input, init) => { const u = new URL(typeof input === "string" ? input : input.url, location.href);
          const k = u.pathname.replace(/\\/(R\\d+|Q\\d+)(\\.\\d+)?/g, "/:id").replace(/\\/sessions\\/[^/]+/, "/sessions/:s").replace(/\\/conversations\\/[^/]+/, "/conversations/:c");
          c.n++; c.by[k] = (c.by[k] ?? 0) + 1; const r = await f(input, init); r.clone().arrayBuffer().then((b) => { c.bytes += b.byteLength; }, () => {}); return r; };
        const e0 = console.error.bind(console); c.errors = []; console.error = (...a) => { if (c.errors.length < 5) c.errors.push(a.map(String).join(" ").slice(0, 400)); e0(...a); }; window.addEventListener("error", (e) => { if (c.errors.length < 5) c.errors.push(String(e.message)); });
        const W = window.WebSocket; window.WebSocket = class extends W { constructor(...a) { super(...a); this.addEventListener("message", (e) => { c.ws++; try { const m = JSON.parse(e.data); const k = "ws " + m.type + (m.log ? " " + m.log : "") + (m.reload ? " reload" : ""); c.by[k] = (c.by[k] ?? 0) + 1; } catch {} }); } }; })();`;
      await browser.open(`${url}/#/big/${running[0]}/${running[0]}.1`, 1440, 900, counter);
      await sleep(5000);
      await browser.evaluate(`(() => { const c = window.__reqs; c.n = 0; c.bytes = 0; c.ws = 0; c.by = {}; return true; })()`);
    }
    const pageStart = Date.now();

    // The agents' activity, and the user accepting each step in review so the running queues go on.
    let appended = 0;
    const st = ProjectStore.forRoot(root);
    const activity = setInterval(() => {
      const s = sims[appended % sims.length]!;
      st.appendActivity(s, { at: new Date().toISOString(), kind: "tool", text: text(30) });
      appended++;
    }, Number(o["activity-ms"]));
    let accepted = 0;
    while (Date.now() < until) {
      await sleep(2000);
      if (!Number(o.dashboards)) latest = await get("state (script)", "/api/projects/big/state") as State | undefined;
      for (const q of latest?.queues.filter((x) => running.includes(x.id)) ?? []) {
        for (const s of q.steps.filter((x) => x.status === "review")) { await post(`/api/projects/big/queues/${q.id}/steps/${s.id}/accept`, {}); accepted++; }
      }
    }
    clearInterval(activity);
    const page = browser ? await browser.evaluate<{ n: number; bytes: number; ws: number; by: Record<string, number> }>("window.__reqs") : undefined;
    const pageMinutes = (Date.now() - pageStart) / 60_000;
    await browser?.close();
    const perf = await (await fetch(`${url}/api/server/perf`)).json();
    stopping = true;
    for (const q of running) await post(`/api/projects/big/queues/${q}/run`, { action: "stop_at_once" });
    await Promise.race([Promise.all(dashboards), sleep(5000)]);

    const client = [...latency].map(([k, l]) => ({ endpoint: k, count: l.count, errors: l.errors, mean_ms: Math.round(l.total / l.count), p50_ms: Math.round(pct(l.all, 50)), p95_ms: Math.round(pct(l.all, 95)), max_ms: Math.round(l.max) }))
      .sort((a, b) => b.mean_ms * b.count - a.mean_ms * a.count);
    const done = latest?.queues.filter((x) => running.includes(x.id)).flatMap((q) => q.steps.filter((s) => s.status === "done").map((s) => s.id)) ?? [];
    const result = { label: o.label, startup_ms: startup, minutes: Number(o.minutes), dashboards: Number(o.dashboards), running: RUNNING, notifications, activity_lines: appended, accepted, steps_done: done.length, server: perf, client,
      page: page && { minutes: pageMinutes, requests: page.n, requests_per_minute: Math.round(page.n / pageMinutes), mb_per_minute: +(page.bytes / 1e6 / pageMinutes).toFixed(1), messages_per_minute: Math.round(page.ws / pageMinutes), by: page.by } };
    const outDir = o.out ?? home;
    mkdirSync(outDir, { recursive: true });
    const file = join(outDir, `perf-${o.label}.json`);
    writeFileSync(file, JSON.stringify(result, null, 2));
    const perfLines = existsSync(log) ? readFileSync(log, "utf8").split(/\r?\n/).filter((l) => l.startsWith("perf:")) : [];
    writeFileSync(join(outDir, `perf-${o.label}.log`), perfLines.join("\n") + "\n");
    console.log(`\n${o.label}: ${o.minutes} min, ${o.dashboards} dashboard(s), ${RUNNING} running queue(s); ${notifications} notifications, ${appended} activity lines, ${accepted} steps accepted`);
    console.log(`event loop delay: p50 ${perf.loop.p50_ms} ms, p99 ${perf.loop.p99_ms} ms, max ${perf.loop.max_ms} ms; blocks over ${perf.block_ms} ms: ${perf.blocks.length}`);
    if (result.page) {
      console.log(`the page: ${result.page.requests_per_minute} requests a minute, ${result.page.mb_per_minute} MB a minute, ${result.page.messages_per_minute} socket messages a minute`);
      for (const [k, n] of Object.entries(result.page.by).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(48)} ${String(Math.round(n / result.page.minutes)).padStart(5)} a minute`);
    }
    console.log("what the dashboards waited (endpoint, count, mean, p50, p95, max):");
    for (const c of client) console.log(`  ${c.endpoint.padEnd(14)} ${String(c.count).padStart(5)}  ${c.mean_ms} / ${c.p50_ms} / ${c.p95_ms} / ${c.max_ms} ms${c.errors ? `  (${c.errors} failed)` : ""}`);
    console.log("server: measured operations by total time (count, mean, max):");
    for (const s of perf.spans.slice(0, 14)) console.log(`  ${s.what}  ${s.count}x  ${s.mean_ms} / ${s.max_ms} ms`);
    // The step boundary (queue GB): its sections, and the synchronous git processes run within them.
    type Section = { what: string; count: number; total_ms: number; mean_ms: number; max_ms: number; git_calls: number; git_ms: number; git: { what: string; count: number; total_ms: number }[] };
    console.log("server: measured sections (count, mean / max, total; synchronous git calls within them):");
    for (const s of (perf.sections ?? []) as Section[]) console.log(`  ${s.what}  ${s.count}x  ${s.mean_ms} / ${s.max_ms} ms, ${s.total_ms} ms; git ${s.git_calls}x ${s.git_ms} ms${s.git.length ? ` (${s.git.map((g) => `${g.what} ${g.count}`).join(", ")})` : ""}`);
    const gitSpans = (perf.spans as { what: string; count: number; total_ms: number }[]).filter((s) => s.what.split(" > ").at(-1)!.startsWith("git "));
    console.log(`server: synchronous git among the 40 longest spans: ${gitSpans.reduce((n, s) => n + s.count, 0)} calls, ${gitSpans.reduce((n, s) => n + s.total_ms, 0)} ms`);
    console.log("server: the longest blocks:");
    for (const b of [...perf.blocks].sort((a: { ms: number }, b: { ms: number }) => b.ms - a.ms).slice(0, 8)) console.log(`  ${b.ms} ms: ${b.during.map((s: { what: string; ms: number }) => `${s.what} ${Math.round(s.ms)}`).join("; ") || "nothing measured"}`);
    if (page && (page as { errors?: string[] }).errors?.length) console.log(`the page's errors: ${(page as { errors?: string[] }).errors!.join(" | ")}`);
    console.log(`written: ${file}`);
  } finally {
    stopping = true;
    await sleep(3000);
    await inst?.stop();
    // The fake agents this instance started, by the pids it recorded: none may outlive it.
    const sessions = join(root, ".nexus/sessions");
    for (const s of existsSync(sessions) ? readdirSync(sessions) : []) {
      const f = join(sessions, s, "runtime.json");
      if (!existsSync(f)) continue;
      const pid = (JSON.parse(readFileSync(f, "utf8")) as { pid?: number }).pid;
      if (pid) { try { process.kill(pid); console.log(`stopped a fake agent left running (pid ${pid})`); } catch { /* gone */ } }
    }
    if (!o.keep) { await sleep(1000); try { rmSync(home, { recursive: true, force: true }); } catch (err) { console.log(`not removed: ${home} (${errorText(err)})`); } }
    else console.log(`kept: ${home}`);
  }
}

await main();
