// The live stream of a real server process (queue SD; docs/protocol/live.md): a dashboard client that reads the state
// and a session's activity once and then only applies the messages holds, at every sequence number, what a full read
// at that number gives, while a queue runs on the fake runtimes, an agent's activity grows and the user accepts steps.
// Every message about the project is the next in its sequence (no gap on one socket), a write's answer names where it
// left the stream and the views show its outcome once they stand there, and a new socket's hello names where the
// stream stands.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectStore, approveQueue, updateSettings, writeRegistry, type ProjectState } from "@nexus/protocol";
import { applyState, SEQ_HEADER, type LiveMessage } from "@nexus/protocol/live";
import { spawnServer } from "./helpers.ts";
import { LONGER, serverUp, until, untilAsync } from "./wait.ts";

const here = dirname(fileURLToPath(import.meta.url));
const freePort = () => new Promise<number>((resolve) => {
  const s = createServer();
  s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); });
});
type Activity = { at: string; kind: string; text: string; queue?: string; step?: string };
type ProjectMessage = Extract<LiveMessage, { project: string }>;

test("a client applying the messages holds what a full read at the same sequence number holds", async () => {
  const root = mkdtempSync(join(tmpdir(), "nexus-live-api-")), home = join(root, "home");
  process.env.NEXUS_HOME = home;
  const store = ProjectStore.init(root, { id: "p", name: "Live", root });
  updateSettings(store, { orchestrator: { notify: false } });
  store.writeQueue({ protocol: 1, id: "Q", title: "Live", revision: 1, status: "proposed", review_level: 1, stop_conditions: [], checks: [], steps: [
    { id: "Q1", title: "One", goal: "FAKE: done", acceptance: [] },
    { id: "Q2", title: "Two", goal: "FAKE: done", acceptance: [] },
  ] });
  approveQueue(store, "Q");
  store.writeSession({ protocol: 1, id: "sim", project: "p", role: "helper", runtime: "external", title: "Streaming", cwd: root, launched_by: "external", created_at: "2026-11-21T10:00:00.000Z" });
  store.appendActivity("sim", { at: "2026-11-21T10:00:00.000Z", kind: "text", text: "before the client" });
  writeRegistry({ protocol: 1, projects: [{ id: "p", root }] });
  const port = await freePort(), url = `http://127.0.0.1:${port}`;
  const child = spawnServer({ NEXUS_HOME: home, NEXUS_DIR: store.dir, NEXUS_PORT: String(port), NEXUS_LOG: "",
    NEXUS_CLAUDE: join(here, "fake-claude.ts"), NEXUS_CODEX: join(here, "fake-codex.ts") });
  const sockets: WebSocket[] = [];
  try {
    await serverUp(`${url}/api/projects`);
    const read = async <T>(path: string, init?: RequestInit): Promise<{ body: T; seq: number; epoch: string }> => {
      const r = await fetch(`${url}/api/projects/p${path}`, init);
      assert.equal(r.status, 200, `${path}: ${r.status}`);
      const [epoch, seq] = (r.headers.get(SEQ_HEADER) ?? "").split(" ");
      return { body: await r.json() as T, seq: Number(seq), epoch: epoch! };
    };
    const post = (path: string, body: object) => read<unknown>(path, { method: "POST", headers: { "content-type": "application/json", origin: url }, body: JSON.stringify(body) });

    // The client: the socket first, then the full reads, then every message after where each read stood.
    const messages: LiveMessage[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    sockets.push(ws);
    ws.addEventListener("message", (e) => messages.push(JSON.parse(String(e.data)) as LiveMessage));
    await until("the socket's hello", () => messages[0]?.type === "hello");
    const hello = messages[0] as Extract<LiveMessage, { type: "hello" }>;
    const first = await read<ProjectState>("/state");
    assert.equal(first.epoch, hello.epoch);
    assert.ok(first.seq >= hello.projects.p!, "a read after the hello stands at or after it");
    const activityRead = await read<Activity[]>("/sessions/sim/activity");
    assert.deepEqual(activityRead.body.map((a) => a.text), ["before the client"]);

    // What the client holds after each sequence number, by applying the messages in order.
    let state = first.body, activity = activityRead.body;
    const states = new Map<number, string>([[first.seq, JSON.stringify(state)]]);
    const activities = new Map<number, string>([[activityRead.seq, JSON.stringify(activity)]]);
    let at = hello.projects.p!, applied = 1;
    const apply = () => {
      for (; applied < messages.length; applied++) {
        const m = messages[applied]!;
        assert.notEqual(m.type, "changed" as string, "no changed message any more");
        if (!("project" in m)) continue;
        const pm = m as ProjectMessage;
        assert.equal(pm.seq, at + 1, `message ${pm.seq} follows ${at}: no gap on one socket`);
        at = pm.seq;
        if (pm.type === "state" && pm.seq > first.seq) {
          assert.ok(!pm.reload, "a small change is a delta, not a reload");
          const next = applyState(state, pm);
          assert.ok(next, `state message ${pm.seq} applies`);
          state = next;
        }
        if (pm.type === "log" && pm.session === "sim" && pm.log === "activity" && pm.seq > activityRead.seq) {
          assert.ok(pm.entries, "the lines themselves");
          activity = [...activity, ...pm.entries as Activity[]].slice(-300);
        }
        states.set(at, JSON.stringify(state));
        activities.set(at, JSON.stringify(activity));
      }
    };
    const standsAt = async (seq: number) => { await until(`the client at ${seq}`, () => { apply(); return at >= seq; }); };
    /** A full read now, and what the client held at the same sequence number: the same. */
    const same = async (why: string) => {
      const full = await read<ProjectState>("/state");
      await standsAt(full.seq);
      assert.deepEqual(JSON.parse(states.get(full.seq)!), full.body, `${why}: the state at ${full.seq}`);
      const log = await read<Activity[]>("/sessions/sim/activity");
      await standsAt(log.seq);
      assert.deepEqual(JSON.parse(activities.get(log.seq)!), log.body, `${why}: the activity at ${log.seq}`);
    };

    await same("before anything");
    // The run starts (a write: its answer names where it left the stream; the client shows the run once there).
    const started = await post("/queues/Q/run", { action: "start", runtime: "claude" });
    await standsAt(started.seq);
    assert.ok(state.queues[0]!.run, "the started run shows once the client stands where the write left the stream");
    // An agent's activity from another process (the watcher's report), while the step runs.
    for (let i = 0; i < 5; i++) store.appendActivity("sim", { at: `2026-11-21T10:01:0${i}.000Z`, kind: "tool", text: `line ${i}`, queue: "Q", step: "Q1" });
    await untilAsync("the lines in the client", async () => { apply(); return activity.length === 6; }, LONGER.step);
    await same("while the first step runs");

    // Each step to review, accepted by the user; the acceptance shows where its answer stands.
    for (const step of ["Q1", "Q2"]) {
      await untilAsync(`${step} in review in the client`, async () => { apply(); return state.queues[0]!.steps.find((s) => s.id === step)!.status === "review"; }, LONGER.run,
        () => `: the client holds ${state.queues[0]!.steps.map((s) => `${s.id} ${s.status}`).join(", ")} at ${at}; messages ${messages.slice(-5).map((m) => JSON.stringify(m).slice(0, 300)).join(" | ")}`);
      const accepted = await post(`/queues/Q/steps/${step}/accept`, {});
      await standsAt(accepted.seq);
      assert.notEqual(state.queues[0]!.steps.find((s) => s.id === step)!.status, "review", `${step}'s acceptance shows once the client stands where it left the stream`);
      await same(`after ${step} was accepted`);
    }
    await untilAsync("the queue done in the client", async () => { apply(); return state.queues[0]!.status === "done"; }, LONGER.run);
    await same("at the end");

    // A new socket's hello names where the stream stands now.
    const fresh: LiveMessage[] = [];
    const ws2 = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    sockets.push(ws2);
    ws2.addEventListener("message", (e) => fresh.push(JSON.parse(String(e.data)) as LiveMessage));
    await until("the second hello", () => fresh.length > 0);
    apply();
    const second = fresh[0] as Extract<LiveMessage, { type: "hello" }>;
    assert.equal(second.type, "hello");
    assert.equal(second.epoch, hello.epoch);
    assert.ok(second.projects.p! >= at - 1 && second.projects.p! <= at + 1, `the hello's ${second.projects.p} is where the stream stands (${at})`);
  } finally {
    for (const s of sockets) s.close();
    if (child.exitCode === null) { const gone = new Promise<void>((r) => child.once("exit", () => r())); child.kill(); await gone; }
  }
});
