// Refused actions over the API: the list per project and per step, and an allow rule only from the dashboard's page,
// written only to the project's Nexus settings. A real server process on a free port.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectStore, writeRegistry, type Refusal } from "@nexus/protocol";
import { spawnServer } from "./helpers.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise<number>((resolve) => {
  const s = createServer();
  s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); });
});

test("the API lists refusals per project and step, and takes an allow rule only from the dashboard's page", async () => {
  const base = mkdtempSync(join(tmpdir(), "nexus-refusals-"));
  process.env.NEXUS_HOME = join(base, "home");
  const root = join(base, "project");
  mkdirSync(join(root, ".claude"), { recursive: true });
  writeFileSync(join(root, ".claude", "settings.json"), "{}\n");
  writeFileSync(join(root, "AGENTS.md"), "# Rules\n");
  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  const at = (m: number) => new Date(Date.UTC(2026, 10, 13, 10, m)).toISOString();
  for (const [s, runtime] of [["s1", "claude"], ["s2", "codex"]] as const) {
    store.writeSession({ protocol: 1, id: s, project: "p", role: "worker", runtime, cwd: root, launched_by: "nexus", created_at: at(0) });
  }
  store.appendRefusal({ at: at(2), session: "s1", runtime: "claude", by: "permissions", tool: "Bash", input: "git push origin main", queue: "Q", step: "Q1" });
  store.appendRefusal({ at: at(1), session: "s2", runtime: "codex", by: "nexus", tool: "command", input: "curl x", queue: "R", step: "R1" });
  writeRegistry({ protocol: 1, projects: [{ id: "p", root }] });

  const port = await freePort();
  const child = spawnServer({ NEXUS_PORT: String(port), NEXUS_LOG: "" });
  const url = `http://127.0.0.1:${port}`;
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(url + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  try {
    for (let i = 0; i < 100; i++) { try { if ((await fetch(url + "/api/projects")).ok) break; } catch { /* not up yet */ } await sleep(100); }
    const all = (await (await fetch(url + "/api/projects/p/refusals")).json()) as Refusal[];
    assert.deepEqual(all.map((r) => r.session), ["s2", "s1"], "every session's, oldest first");
    const step = (await (await fetch(url + "/api/projects/p/refusals?queue=Q&step=Q1")).json()) as Refusal[];
    assert.deepEqual(step.map((r) => r.input), ["git push origin main"]);

    const rule = "/api/projects/p/settings/allow-rule";
    // An agent's script or a curl: no Origin. An agent must not widen its own permissions.
    let r = await post(rule, { rule: "Bash(git push:*)" });
    assert.equal(r.status, 403);
    r = await post(rule, { rule: "Bash(git push:*)" }, { origin: "http://evil.example" });
    assert.equal(r.status, 403);
    assert.deepEqual(store.readProject().runtimes.claude.allowed_tools, [], "nothing was added");

    r = await post(rule, { rule: "Bash(git push:*)" }, { origin: url, "sec-fetch-site": "same-origin" });
    assert.equal(r.status, 200, await r.text());
    assert.deepEqual(store.readProject().runtimes.claude.allowed_tools, ["Bash(git push:*)"]);
    assert.equal(readFileSync(join(root, ".claude", "settings.json"), "utf8"), "{}\n", "the project's own settings are not touched");
    assert.equal(readFileSync(join(root, "AGENTS.md"), "utf8"), "# Rules\n");

    r = await post(rule, { rule: "not a rule; rm -rf /" }, { origin: url });
    assert.equal(r.status, 400);
  } finally {
    child.kill();
  }
});
