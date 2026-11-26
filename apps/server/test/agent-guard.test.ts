// The agents' own processes cannot do the user's actions over HTTP (queue HG, docs/design/security.md): any program on
// this machine can send a browser's headers, so the server also asks the agents' Windows jobs whether one of their
// processes owns the connection. A real server process with the fake runtimes; the agents run a script inside their
// job (FAKE-SCRIPT) that sends what HG1 found works without the check.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer, type AddressInfo, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectStore, approveQueue, readGlobalSettings, writeRegistry } from "@nexus/protocol";
import { spawnServer } from "./helpers.ts";
import { serverUp, until, LONGER } from "./wait.ts";
import { ENDED_CLIENT, agentOwning, spawnRuntimeChild } from "../src/worker-process.ts";

const here = dirname(fileURLToPath(import.meta.url));
const windows = process.platform === "win32";
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const freePort = () => new Promise<number>((resolve) => {
  const s = createServer();
  s.listen(0, "127.0.0.1", () => { const p = (s.address() as AddressInfo).port; s.close(() => resolve(p)); });
});

// What an agent's script sends: everything a browser would, the access token too (read from NEXUS_HOME), and a
// proxy's header to pass as a remote device; and what `nexus server cancel` sends. Before its results it also sends a
// whole settings write on a raw socket and resets the connection at once (LCF6: an ended client, refused too).
function writeAgentScript(base: string, url: string, name: string) {
  const file = join(base, `${name}.mjs`);
  const results = join(base, `${name}.json`);
  writeFileSync(file, `import {readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {connect} from 'node:net';
const url = ${JSON.stringify(url)};
const browser = {'content-type': 'application/json', origin: url, 'sec-fetch-site': 'same-origin'};
const token = JSON.parse(readFileSync(join(process.env.NEXUS_HOME, 'auth.json'), 'utf8')).token;
const status = async (method, path, headers, body) => (await fetch(url + path, {method, headers, body: body === undefined ? undefined : JSON.stringify(body)})).status;
const crlf = String.fromCharCode(13, 10);
const body = JSON.stringify({defaults: {max_running: 9}});
const head = ['PATCH /api/settings HTTP/1.1', 'Host: ' + new URL(url).host, 'Origin: ' + url, 'Sec-Fetch-Site: same-origin', 'Content-Type: application/json', 'Content-Length: ' + body.length];
await new Promise((resolve) => {
  const s = connect(Number(new URL(url).port), '127.0.0.1', () => s.write(head.join(crlf) + crlf + crlf + body, () => { s.resetAndDestroy(); resolve(); }));
  s.on('error', resolve);
});
const r = {
  settings: await status('PATCH', '/api/settings', browser, {defaults: {max_running: 9}}),
  sandbox: await status('PATCH', '/api/settings', browser, {runtimes: {codex: {sandbox: 'danger-full-access'}}}),
  asPhone: await status('PATCH', '/api/settings', {...browser, cookie: 'nexus_auth=' + token, 'x-forwarded-for': '100.64.0.9'}, {defaults: {max_running: 9}}),
  token: await status('GET', '/api/remote', {}),
  rotate: await status('POST', '/api/remote/rotate', browser, {}),
  away: await status('POST', '/api/server/away', {'content-type': 'application/json'}, {on: true}),
  cancel: await status('POST', '/api/server/cancel', {'content-type': 'application/json'}, {}),
  read: await status('GET', '/api/projects', {}),
};
writeFileSync(${JSON.stringify(results)}, JSON.stringify(r));
console.log('sent');
`);
  return { file, results };
}
/** What an agent's script got: every write and the token refused, a read answered; `cancel` only the orchestrator's. */
const REFUSED = { settings: 403, sandbox: 403, asPhone: 403, token: 403, rotate: 403, away: 403, cancel: 403, read: 200 };
function refused(results: string, role: string): void {
  const r = JSON.parse(readFileSync(results, "utf8")) as Record<string, number>;
  if (role === "orchestrator") assert.deepEqual({ ...r, cancel: r.cancel === 403 ? 403 : "not refused" }, { ...REFUSED, cancel: "not refused" }, results);
  else assert.deepEqual(r, REFUSED, results);
}

test("a job host names the agent role that owns a connection, and no one for the user's", { skip: !windows }, async () => {
  const seen: { role: string | undefined; agent: boolean }[] = [];
  const server = createHttpServer((req, res) => {
    void agentOwning(req.socket.remotePort!, req.socket.localPort!).then((role) => {
      seen.push({ role, agent: req.headers["x-from"] === "agent" });
      res.end(role ?? "none");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  const root = mkdtempSync(join(tmpdir(), "nexus-agent-job-"));
  const script = join(root, "agent.mjs");
  // A grandchild, as an agent's shell command is: job membership is inherited.
  writeFileSync(script, `import {execFileSync} from 'node:child_process';
const out = execFileSync(process.execPath, ['-e', "fetch('http://127.0.0.1:${port}/', {headers: {'x-from': 'agent'}}).then(r => r.text()).then(t => console.log(t))"], {encoding: 'utf8'});
console.log('answer ' + out.trim());
setInterval(() => {}, 1000);
`);
  const child = spawnRuntimeChild(process.execPath, [script], { cwd: root, env: process.env, agent: "conversation" });
  let out = "";
  child.stdout.on("data", (d: Buffer) => { out += d.toString(); });
  child.stderr.on("data", (d: Buffer) => { out += d.toString(); });
  const closed = new Promise<void>((r) => child.once("close", () => r()));
  try {
    await until("the agent's request answered", () => out.includes("answer "), LONGER.step, () => out);
    assert.match(out, /answer conversation/);
    // The test process itself (the user's browser, for this purpose) is in no agent's job.
    assert.equal(await (await fetch(`http://127.0.0.1:${port}/`)).text(), "none");
    assert.deepEqual(seen.map((s) => [s.agent, s.role]), [[true, "conversation"], [false, undefined]]);
  } finally {
    child.kill();
    await closed;
    server.close();
  }
  // Its job gone, nothing is asked any more.
  assert.equal(await agentOwning(1, 2), undefined);
});

// LCF6: an agent's process that sends its request and is gone before the hosts are asked (it exited, or reset the
// connection) leaves no running owner in the TCP table. Before LCF6 the hosts answered "nobody's" and the request
// passed; now they name it an ended client, which the guard refuses on loopback. The server here asks only once the
// connection has closed, so the order is certain; the user's own request (this process) is still nobody's. A reset may
// also drop the request before the server reads it (Windows discards unread data on a reset; seen under load): then no
// request arrives at all, which writes nothing either.
test("a connection whose process exited or reset it before the hosts were asked is an ended client, not nobody's", { skip: !windows }, async () => {
  const seen: string[] = [];
  let arrived = 0, closedConnections = 0;
  const server = createHttpServer((req, res) => {
    arrived++;
    const ports = [req.socket.remotePort!, req.socket.localPort!] as const;
    const mode = String(req.headers["x-mode"]);
    const closed = new Promise<void>((r) => req.socket.once("close", () => r()));
    let body = "";
    req.on("data", (d: Buffer) => { body += d.toString(); });
    req.on("error", () => {});
    void (mode === "user" ? Promise.resolve() : closed).then(() => agentOwning(ports[0], ports[1])).then((role) => {
      seen.push(`${mode} ${role ?? "none"} ${body}`);
      if (!res.destroyed) res.end(role ?? "none");
    });
  });
  server.on("connection", (socket: Socket) => socket.once("close", () => { closedConnections++; }));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  const root = mkdtempSync(join(tmpdir(), "nexus-agent-ended-"));
  const fire = join(root, "fire.cjs");
  // Writes a whole request on a raw socket, then exits at once or resets the connection and lives on a while.
  writeFileSync(fire, `const net = require('node:net');
const mode = process.argv[2];
const s = net.connect(${port}, '127.0.0.1', () => {
  const body = '{"defaults":{"max_running":9}}';
  const head = ['PATCH /api/settings HTTP/1.1', 'Host: x', 'x-mode: ' + mode, 'Content-Type: application/json', 'Content-Length: ' + body.length];
  const crlf = String.fromCharCode(13, 10);
  s.write(head.join(crlf) + crlf + crlf + body, () => {
    if (mode === 'exit') process.exit(0);
    s.resetAndDestroy(); setTimeout(() => process.exit(0), 2000);
  });
});
`);
  const script = join(root, "agent.cjs");
  writeFileSync(script, `const {execFileSync} = require('node:child_process');
for (const mode of ['exit', 'reset']) execFileSync(process.execPath, [${JSON.stringify(fire)}, mode]);
console.log('sent');
setInterval(() => {}, 1000);
`);
  const child = spawnRuntimeChild(process.execPath, [script], { cwd: root, env: process.env, agent: "worker" });
  let out = "";
  child.stdout.on("data", (d: Buffer) => { out += d.toString(); });
  child.stderr.on("data", (d: Buffer) => { out += d.toString(); });
  const closed = new Promise<void>((r) => child.once("close", () => r()));
  try {
    await until("both connections closed, every request that arrived answered", () => closedConnections >= 2 && seen.length === arrived,
      LONGER.step, () => `${out}\n${seen.join("\n")}`);
    const body = '{"defaults":{"max_running":9}}';
    const expected = [`exit ${ENDED_CLIENT} ${body}`, `reset ${ENDED_CLIENT} ${body}`];
    assert.ok(seen.includes(expected[0]!), `the exited one's whole request arrived, its owner ended: ${seen.join(" | ")}`);
    assert.deepEqual(seen.filter((x) => !expected.includes(x)), [], "every request that arrived is an ended client's");
    assert.equal(await (await fetch(`http://127.0.0.1:${port}/`, { headers: { "x-mode": "user" } })).text(), "none");
  } finally {
    child.kill();
    await closed;
    server.close();
  }
});

test("an agent's forged browser requests are refused; the user, the phone and the orchestrator's nexus server calls are not", { skip: !windows }, async () => {
  const base = mkdtempSync(join(tmpdir(), "nexus-agent-guard-"));
  const home = join(base, "home");
  const root = join(base, "project");
  mkdirSync(root, { recursive: true });
  process.env.NEXUS_HOME = home;
  ProjectStore.init(root, { id: "p", name: "P", root });
  writeRegistry({ protocol: 1, projects: [{ id: "p", root }] });
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const child = spawnServer({ NEXUS_PORT: String(port), NEXUS_LOG: "", NEXUS_CLAUDE: join(here, "fake-claude.ts"), NEXUS_CODEX: join(here, "fake-codex.ts") });
  const page = { "content-type": "application/json", origin: url, "sec-fetch-site": "same-origin" };
  const send = (method: string, path: string, body: unknown, headers: Record<string, string> = page) =>
    fetch(url + path, { method, headers, body: JSON.stringify(body) });

  const agentScript = (name: string) => writeAgentScript(base, url, name);

  try {
    await serverUp(url + "/api/projects");
    const tokenBefore = (JSON.parse(readFileSync(join(home, "auth.json"), "utf8")) as { token: string }).token;

    // The orchestrator (the project's, on the fake Claude), started by the user's message.
    const orch = agentScript("orchestrator");
    let res = await send("POST", "/api/projects/p/orchestrator/messages", { text: `FAKE-SCRIPT: ${orch.file}` });
    assert.equal(res.status, 200, await res.text());
    await until("the orchestrator's script ran", () => existsSync(orch.results), LONGER.step);
    const o = JSON.parse(readFileSync(orch.results, "utf8")) as Record<string, number>;
    assert.deepEqual({ ...o, cancel: o.cancel === 403 ? 403 : "not refused" },
      { settings: 403, sandbox: 403, asPhone: 403, token: 403, rotate: 403, away: 403, cancel: "not refused", read: 200 });

    // A thinking partner: the same, and `nexus server cancel` is the orchestrator's alone.
    res = await send("POST", "/api/projects/p/conversations", { title: "Talk" });
    const created = await res.text();
    assert.equal(res.status, 200, created);
    const cid = (JSON.parse(created) as { result: { id: string } }).result.id;
    const talk = agentScript("conversation");
    res = await send("POST", `/api/projects/p/conversations/${cid}/messages`, { text: `FAKE-SCRIPT: ${talk.file}` });
    assert.equal(res.status, 200, await res.text());
    await until("the thinking partner's script ran", () => existsSync(talk.results), LONGER.step);
    assert.deepEqual(JSON.parse(readFileSync(talk.results, "utf8")),
      { settings: 403, sandbox: 403, asPhone: 403, token: 403, rotate: 403, away: 403, cancel: 403, read: 200 });

    const settings = readGlobalSettings();
    assert.notEqual(settings.defaults?.max_running, 9, "no agent changed a setting");
    assert.notEqual(settings.runtimes?.codex?.sandbox, "danger-full-access", "nor loosened the sandbox");
    assert.equal((JSON.parse(readFileSync(join(home, "auth.json"), "utf8")) as { token: string }).token, tokenBefore, "nor rotated the token");

    // The user's own: the dashboard on this machine, the phone through the proxy with its cookie; a remote request
    // without the cookie is still asked to sign in.
    res = await send("PATCH", "/api/settings", { defaults: { max_running: 5 } });
    assert.equal(res.status, 200, await res.text());
    res = await send("PATCH", "/api/settings", { defaults: { max_running: 6 } }, { ...page, cookie: `nexus_auth=${tokenBefore}`, "x-forwarded-for": "100.64.0.9" });
    assert.equal(res.status, 200, await res.text());
    assert.equal(readGlobalSettings().defaults?.max_running, 6);
    res = await send("PATCH", "/api/settings", { defaults: { max_running: 4 } }, { ...page, "x-forwarded-for": "100.64.0.9" });
    assert.equal(res.status, 401);
    // The user's nexus CLI, outside every agent's job: `nexus server cancel` reaches the server (nothing to cancel).
    const cli = spawn(process.execPath, [join(here, "../../../packages/cli/bin/nexus.js"), "server", "cancel"], {
      env: { ...process.env, NEXUS_SESSION: "", NEXUS_DIR: "", NEXUS_PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    let cliOut = "";
    cli.stdout.on("data", (d: Buffer) => { cliOut += d.toString(); });
    cli.stderr.on("data", (d: Buffer) => { cliOut += d.toString(); });
    await new Promise<void>((r) => cli.once("close", () => r()));
    assert.doesNotMatch(cliOut, /agent's process/, cliOut);
  } finally {
    child.kill();
  }
});

// LCF6, the guard's continuation and restart paths: every new process of an agent is in a job the server asks about,
// whichever runtime and however it began (a worker's step on Claude, a thinking partner on Codex, the orchestrator's
// fresh session after a reset, and its session resumed by the next server); and an agent of a server that ended does
// not outlive it (its job ends with its host), so the next server, which never knew its job, never meets it.
test("every new agent process is guarded (a worker, a Codex thinking partner, a reset orchestrator, the next server's resumed one); the old server's agents end with it", { skip: !windows }, async () => {
  const base = mkdtempSync(join(tmpdir(), "nexus-agent-guard-paths-"));
  const home = join(base, "home");
  const root = join(base, "project");
  mkdirSync(root, { recursive: true });
  process.env.NEXUS_HOME = home;
  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  writeRegistry({ protocol: 1, projects: [{ id: "p", root }] });
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const env = { NEXUS_PORT: String(port), NEXUS_LOG: "", NEXUS_CLAUDE: join(here, "fake-claude.ts"), NEXUS_CODEX: join(here, "fake-codex.ts") };
  const page = { "content-type": "application/json", origin: url, "sec-fetch-site": "same-origin" };
  const send = async (method: string, path: string, body: unknown) => {
    const res = await fetch(url + path, { method, headers: page, body: JSON.stringify(body) });
    const text = await res.text();
    assert.equal(res.status, 200, `${path}: ${text}`);
    return text;
  };
  const say = async (role: string, path: string, name: string) => {
    const s = writeAgentScript(base, url, name);
    await send("POST", path, { text: `FAKE-SCRIPT: ${s.file}` });
    await until(`${name}'s script ran`, () => existsSync(s.results), LONGER.step);
    refused(s.results, role);
  };

  const worker = writeAgentScript(base, url, "worker");
  store.writeQueue({ protocol: 1, id: "Q", title: "Queue", revision: 1, status: "proposed", stop_conditions: [], checks: [],
    steps: [{ id: "Q1", title: "Step Q1", goal: `FAKE: script\nFAKE-SCRIPT: ${worker.file}`, acceptance: [] }], approvals: [], history: [] });
  approveQueue(store, "Q");
  // A process the orchestrator's script leaves running in its job, to see it end with the server.
  const lingering = join(base, "lingering.pid");
  const linger = join(base, "linger.mjs");
  writeFileSync(linger, `import {spawn} from 'node:child_process';
import {writeFileSync} from 'node:fs';
// Detached: else Node's own job for its children would end it with this script.
const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio: 'ignore', windowsHide: true, detached: true});
c.unref();
writeFileSync(${JSON.stringify(lingering)}, String(c.pid));
console.log('lingering ' + c.pid);
`);

  let server = spawnServer(env);
  try {
    await serverUp(url + "/api/projects");
    // A worker, on Claude.
    await send("POST", "/api/projects/p/queues/Q/run", { action: "start", runtime: "claude" });
    await until("the worker's script ran", () => existsSync(worker.results), LONGER.step);
    refused(worker.results, "worker");
    // A thinking partner on Codex.
    const cid = (JSON.parse(await send("POST", "/api/projects/p/conversations", { title: "Talk", runtime: "codex" })) as { result: { id: string } }).result.id;
    await say("conversation", `/api/projects/p/conversations/${cid}/messages`, "codex-partner");
    // The orchestrator, its first process leaving one of its own running; then a fresh session after a reset.
    await send("POST", "/api/projects/p/orchestrator/messages", { text: `FAKE-SCRIPT: ${linger}` });
    await until("the lingering process started", () => existsSync(lingering), LONGER.step);
    const pid = Number(readFileSync(lingering, "utf8"));
    assert.ok(alive(pid));
    await say("orchestrator", "/api/projects/p/orchestrator/messages", "orchestrator-first");
    await send("POST", "/api/projects/p/orchestrator/reset", {});
    await say("orchestrator", "/api/projects/p/orchestrator/messages", "orchestrator-fresh");

    // The server ends (as a crash would, by its handle): its agents' hosts lose their pipe, and their jobs end.
    const exited = new Promise<void>((r) => server.once("exit", () => r()));
    server.kill();
    await exited;
    await until("the old orchestrator's process ended with its server", () => !alive(pid), LONGER.step);

    // The next server: the orchestrator's session goes on in a process this server started, in a job it asks.
    server = spawnServer(env);
    await serverUp(url + "/api/projects");
    await say("orchestrator", "/api/projects/p/orchestrator/messages", "orchestrator-next-server");

    const settings = readGlobalSettings();
    assert.notEqual(settings.defaults?.max_running, 9, "no agent changed a setting, the reset raw write neither");
  } finally {
    server.kill();
  }
});
