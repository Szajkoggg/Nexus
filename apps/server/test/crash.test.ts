// An uncaught exception that ends the server (queue KM, src/crash.ts). The rule is unchanged: the stack goes to the log
// and the server exits with 1. It is also recorded in <NEXUS_HOME>/crash.json: the next server shows it on the
// dashboard (GET /api/server's `crash`) until the user closes it, and every project's orchestrator is told once.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ProjectStore, loadProjectState, newId, now, type SessionFile } from "@nexus/protocol";
import { Engine } from "../src/engine.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import { crashFile, readCrash, recordCrash } from "../src/crash.ts";
import { MAIN, serverEnv, spawnServer } from "./helpers.ts";
import { QUICK_ENGINE, LONGER, serverUp, until } from "./wait.ts";

const here = dirname(fileURLToPath(import.meta.url));
process.env.NEXUS_CLAUDE = join(here, "fake-claude.ts");

const freePort = () => new Promise<number>((resolve) => {
  const s = createServer();
  s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); });
});
const exited = (child: ChildProcess) => new Promise<number | null>((r) => { if (child.exitCode !== null) r(child.exitCode); else child.once("exit", (code) => r(code)); });

test("an uncaught exception is logged and recorded; the next server shows it until it is closed, once", async () => {
  const base = mkdtempSync(join(tmpdir(), "nexus-crash-"));
  const home = join(base, "home");
  process.env.NEXUS_HOME = home; // where this test reads the record
  const log = join(base, "server.log");
  // Loaded before the server: throws from a timer, outside any handler of the server's, once the trigger file exists.
  const trigger = join(base, "crash-now");
  const preload = join(base, "crash-preload.mjs");
  writeFileSync(preload, `import { existsSync } from "node:fs";
const t = setInterval(() => { if (existsSync(${JSON.stringify(trigger)})) { clearInterval(t); throw new Error("forced for the test"); } }, 50);
t.unref();
`);
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const env = { NEXUS_HOME: home, NEXUS_PORT: String(port) };
  const first = spawn(process.execPath, ["--import", pathToFileURL(preload).href, MAIN], { env: serverEnv({ ...env, NEXUS_LOG: log }), stdio: "ignore", windowsHide: true });
  let child: ChildProcess = first;
  try {
    await serverUp(url + "/api/server");
    assert.equal((await (await fetch(url + "/api/server")).json() as { crash: unknown }).crash, null, "no crash before one");
    writeFileSync(trigger, "");
    assert.equal(await exited(first), 1, "the server still ends with 1");
    assert.match(readFileSync(log, "utf8"), /uncaught: Error: forced for the test\n\s+at /, "the stack in the log, as before");
    const record = readCrash()!;
    assert.equal(record.error, "Error: forced for the test");
    assert.match(record.stack ?? "", /forced for the test/);
    assert.equal(record.pid, first.pid);

    // The next server shows it until it is closed.
    child = spawnServer({ ...env, NEXUS_LOG: "" });
    await serverUp(url + "/api/server");
    const shown = await (await fetch(url + "/api/server")).json() as { crash: { at: string; error: string } | null };
    assert.deepEqual(shown.crash, { at: record.at, error: "Error: forced for the test" });
    const page = { "content-type": "application/json", origin: url, "sec-fetch-site": "same-origin" };
    const wrong = await fetch(url + "/api/server/crash/dismiss", { method: "POST", headers: page, body: JSON.stringify({ at: "2000-01-01T00:00:00.000Z" }) });
    assert.equal(wrong.status, 409, "another crash's time closes nothing");
    const closed = await fetch(url + "/api/server/crash/dismiss", { method: "POST", headers: page, body: JSON.stringify({ at: record.at }) });
    assert.deepEqual([closed.status, await closed.json()], [200, { crash: null }]);
    assert.equal((await (await fetch(url + "/api/server")).json() as { crash: unknown }).crash, null);
    child.kill();
    await exited(child);

    // Closed for good: the server after that shows nothing.
    child = spawnServer({ ...env, NEXUS_LOG: "" });
    await serverUp(url + "/api/server");
    assert.equal((await (await fetch(url + "/api/server")).json() as { crash: unknown }).crash, null);
    assert.ok(readCrash()!.dismissed_at, "the record stays, closed");
  } finally {
    first.kill();
    child.kill();
  }
});

test("every project's orchestrator that ran before the crash is told once, across a restart", async () => {
  const base = mkdtempSync(join(tmpdir(), "nexus-crash-orch-"));
  process.env.NEXUS_HOME = join(base, "home");
  const fake = join(base, "fake.log");
  process.env.FAKE_LOG = fake;
  const root = join(base, "p");
  mkdirSync(root);
  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  const p = store.readProject();
  const session: SessionFile = {
    protocol: 1, id: newId(), project: p.id, role: "orchestrator", runtime: "claude", native_id: randomUUID(),
    title: "Orchestrator", cwd: p.root, launched_by: "nexus", created_at: now(),
  };
  store.writeSession(session);
  store.writeProject({ ...p, orchestrator: { runtime: "claude", notify: true, session: session.id } });
  recordCrash(new Error("boom in a handler"));
  assert.ok(existsSync(crashFile()));
  const engine = new Engine(store, () => {}, QUICK_ENGINE);
  const make = () => new Orchestrator(store, engine, () => {}, { crash: readCrash });
  let orchestrator = make();
  const told = () => (existsSync(fake) ? readFileSync(fake, "utf8").trim().split("\n").filter(Boolean) : [])
    .map((l) => JSON.parse(l) as { text: string }).filter((m) => m.text.includes("The Nexus server stopped"));
  try {
    orchestrator.onChange(loadProjectState(store));
    await until("the crash told", () => told().length === 1, LONGER.step);
    assert.match(told()[0]!.text, /on an uncaught exception: Error: boom in a handler/);
    assert.ok(store.readChat(session.id).entries.some((c) => c.from === "nexus" && c.text.includes("Error: boom in a handler")), "the fact shows in its chat");
    await until("the orchestrator idle", () => orchestrator.idle() && orchestrator.view().state !== "working", LONGER.step);
    orchestrator.onChange(loadProjectState(store));
    // A restart of the server: a new Orchestrator over the same files tells it no more.
    orchestrator.shutdown();
    await until("the old process ended", () => !orchestrator.alive());
    orchestrator = make();
    orchestrator.onChange(loadProjectState(store));
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(told().length, 1, "told once");
    assert.equal(store.readApplied(session.id).entries.filter((a) => a.event.startsWith("notify:crash:")).length, 1);
  } finally {
    orchestrator.shutdown(); engine.shutdown();
    delete process.env.FAKE_LOG;
  }
});
