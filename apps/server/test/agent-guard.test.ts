// The agents' own processes cannot do the user's actions over HTTP (queue HG, docs/design/security.md): any program on
// this machine can send a browser's headers, so the server also asks the agents' Windows jobs whether one of their
// processes owns the connection. A real server process with the fake runtimes; the agents run a script inside their
// job (FAKE-SCRIPT) that sends what HG1 found works without the check.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectStore, readGlobalSettings, writeRegistry } from "@nexus/protocol";
import { spawnServer } from "./helpers.ts";
import { serverUp, until, LONGER } from "./wait.ts";
import { agentOwning, spawnRuntimeChild } from "../src/worker-process.ts";

const here = dirname(fileURLToPath(import.meta.url));
const windows = process.platform === "win32";
const freePort = () => new Promise<number>((resolve) => {
  const s = createServer();
  s.listen(0, "127.0.0.1", () => { const p = (s.address() as AddressInfo).port; s.close(() => resolve(p)); });
});

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

  // What an agent's script sends: everything a browser would, the access token too (read from NEXUS_HOME), and a
  // proxy's header to pass as a remote device; and what `nexus server cancel` sends.
  const agentScript = (name: string) => {
    const file = join(base, `${name}.mjs`);
    const results = join(base, `${name}.json`);
    writeFileSync(file, `import {readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
const url = ${JSON.stringify(url)};
const browser = {'content-type': 'application/json', origin: url, 'sec-fetch-site': 'same-origin'};
const token = JSON.parse(readFileSync(join(process.env.NEXUS_HOME, 'auth.json'), 'utf8')).token;
const status = async (method, path, headers, body) => (await fetch(url + path, {method, headers, body: body === undefined ? undefined : JSON.stringify(body)})).status;
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
  };

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
