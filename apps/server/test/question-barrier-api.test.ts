// HTTP clients cannot bypass the step's durable question barrier, even across a server restart.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { ProjectStore, approveQueue, loadProjectState, updateSettings, writeRegistry } from "@nexus/protocol";
import { spawnServer } from "./helpers.ts";
import { LONGER, serverUp, until } from "./wait.ts";

for (const runtime of ["claude", "codex"] as const) test(`${runtime}: HTTP parallel answers survive restart, release once and preserve review`, async () => {
  const root = mkdtempSync(join(tmpdir(), "nexus-questions-api-")), home = join(root, "home"), log = join(root, "fake.log");
  process.env.NEXUS_HOME = home;
  const store = ProjectStore.init(root, { id: "p", name: "Questions", root });
  updateSettings(store, { orchestrator: { notify: false } });
  store.writeQueue({ protocol: 1, id: "Q", title: "Questions", revision: 1, status: "proposed", review_level: 1, stop_conditions: [], checks: [], steps: [
    { id: "Q1", title: "Choose", goal: "FAKE: askthree", acceptance: [] },
    { id: "Q2", title: "Next", goal: "FAKE: done", acceptance: [] },
  ] });
  approveQueue(store, "Q"); writeRegistry({ protocol: 1, projects: [{ id: "p", root }] });
  const port = await new Promise<number>(resolve => {
    const socket = createServer().listen(0, "127.0.0.1", () => { const p = (socket.address() as { port: number }).port; socket.close(() => resolve(p)); });
  });
  assert.ok(port >= 4318);
  const here = dirname(fileURLToPath(import.meta.url)), url = `http://127.0.0.1:${port}`;
  const start = () => spawnServer({ NEXUS_HOME: home, NEXUS_DIR: store.dir, NEXUS_PORT: String(port), NEXUS_LOG: "", FAKE_LOG: log,
    NEXUS_CLAUDE: join(here, "fake-claude.ts"), NEXUS_CODEX: join(here, "fake-codex.ts") });
  let child = start();
  const stop = async () => { if (child.exitCode === null) { const gone = new Promise<void>(r => child.once("exit", () => r())); child.kill(); await gone; } };
  const state = () => loadProjectState(store), queue = () => state().queues[0]!;
  const received = () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map(l => JSON.parse(l) as { text: string; busy: boolean }) : [];
  const post = (path: string, body: object) => fetch(`${url}/api/projects/p/${path}`, { method: "POST", headers: { "content-type": "application/json", origin: url }, body: JSON.stringify(body) });
  const run = (action: string) => post("queues/Q/run", { action, runtime });
  const answer = (qid: string, text: string) => post(`questions/${qid}/answer`, { text, continue: true });
  try {
    await serverUp(`${url}/api/projects`);
    assert.equal((await run("start")).status, 200);
    await until("three idle questions", () => state().questions.length === 3 && store.readRuntime(queue().run!.session)?.state === "idle", LONGER.step);
    const [a, b, c] = state().questions, worker = queue().run!.session, before = received().length;
    const responses = await Promise.all([answer(c!.qid, "C"), answer(a!.qid, "A"), answer(a!.qid, "A")]);
    assert.ok(responses.every(r => r.status === 200));
    assert.equal((await answer(b!.qid, " ")).status, 400);
    assert.equal((await run("resume")).status, 200, "legacy resume does not bypass open questions");
    await new Promise(r => setTimeout(r, 600));
    assert.equal(received().length, before);
    assert.equal(state().questions.find(q => q.qid === a!.qid)!.answers.length, 1);
    assert.equal(store.readDelivered(worker).entries.filter(d => d.kind === "inbox").length, 0);
    await stop(); child = start(); await serverUp(`${url}/api/projects`);
    assert.equal(queue().run!.state, "paused", "unplanned restart keeps the normal pause");
    assert.equal((await run("stop")).status, 200);
    assert.equal((await answer(b!.qid, "B")).status, 200);
    await new Promise(r => setTimeout(r, 600)); assert.equal(received().length, before, "last answer does not cancel restart pause");
    assert.equal(queue().run!.reason, "stopped by the user", "all answers preserve the explicit Stop too");
    assert.equal((await run("resume")).status, 200);
    await until("one answer turn reaches review", () => queue().steps[0]!.status === "review" && store.readRuntime(worker)?.state === "idle", LONGER.step);
    const turns = received().filter(m => m.text.startsWith("[Nexus] Answer"));
    assert.equal(turns.length, 1);
    for (const q of [a!, b!, c!]) assert.ok(turns[0]!.text.includes(`qid ${q.qid}`));
    assert.equal(store.readDelivered(worker).entries.filter(d => d.kind === "inbox").length, 3);
    assert.equal((await answer(b!.qid, "B")).status, 200);
    await post(`sessions/${worker}/messages`, { text: "Do not skip review", queue: "Q", step: "Q1" });
    await run("resume"); await new Promise(r => setTimeout(r, 600));
    assert.equal(received().filter(m => m.text.startsWith("[Nexus] Answer")).length, 1);
    assert.equal(queue().steps[1]!.status, "pending", "all answers and a message cannot accept the review");
    assert.equal(store.readRuntime(worker)?.state, "idle");
  } finally { await stop(); }
});
