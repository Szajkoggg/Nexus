// The dashboard's git reads do not hold the server (queue SV2): while one of them waits for a slow git (here `git
// status` of a stopped step's checkout, slowed by an fsmonitor hook that sleeps), the server answers another request
// at once, and the slow one still answers what it should.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectStore, newId, writeRegistry } from "@nexus/protocol";
import { spawnServer } from "./helpers.ts";
import { serverUp } from "./wait.ts";

const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
const freePort = () => new Promise<number>((resolve) => {
  const s = createServer();
  s.listen(0, "127.0.0.1", () => { const a = s.address(); s.close(() => resolve(typeof a === "object" && a ? a.port : 0)); });
});
const SLOW_S = 3;

test("a slow git in one request does not keep the server from answering another", async () => {
  const base = mkdtempSync(join(tmpdir(), "nexus-slow-git-"));
  process.env.NEXUS_HOME = join(base, "home");
  const root = join(base, "project");
  mkdirSync(root);
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.email", "test@example.invalid"]);
  git(root, ["config", "user.name", "test"]);
  writeFileSync(join(root, ".gitignore"), ".nexus/\nslow.sh\n");
  git(root, ["add", "-A"]); git(root, ["commit", "-q", "-m", "start"]);
  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  store.writeQueue({ protocol: 1, id: "Q", title: "Queue", revision: 1, status: "approved", stop_conditions: [], checks: [], approvals: [], history: [],
    steps: [{ id: "Q1", title: "Step 1", goal: "", acceptance: [] }] });
  const w = "S1";
  const at = (ms: number) => new Date(Date.now() + ms).toISOString();
  store.writeSession({ protocol: 1, id: w, project: "p", role: "worker", runtime: "external", cwd: root, launched_by: "external", created_at: at(-60_000) });
  store.appendEvent({ v: 1, id: newId(), at: at(-30_000), session: w, type: "step.started", queue: "Q", step: "Q1" });
  store.appendEvent({ v: 1, id: newId(), at: at(-20_000), session: w, type: "queue.stop", queue: "Q", step: "Q1", condition: "c", reason: "r" });
  writeFileSync(join(root, "left.txt"), "left by the step\n");
  writeRegistry({ protocol: 1, projects: [{ id: "p", root }] });
  // Every `git status` there now first runs this hook, which sleeps (and then fails, so git looks at the files itself).
  writeFileSync(join(root, "slow.sh"), `#!/bin/sh\nsleep ${SLOW_S}\nexit 1\n`);
  git(root, ["config", "core.fsmonitor", join(root, "slow.sh").replaceAll("\\", "/")]);

  const port = await freePort();
  const child = spawnServer({ NEXUS_PORT: String(port), NEXUS_LOG: "" });
  const url = `http://127.0.0.1:${port}`;
  try {
    await serverUp(`${url}/api/projects`);
    await fetch(`${url}/api/projects/p/state`); // the state is built before the timing starts
    const t0 = Date.now();
    const slow = fetch(`${url}/api/projects/p/queues/Q/left`).then(async (r) => ({ body: await r.json() as { step?: string; uncommitted?: { path: string }[] }, ms: Date.now() - t0 }));
    await new Promise((r) => setTimeout(r, 300)); // the slow request is waiting for its git by now
    const t1 = Date.now();
    const quick = await fetch(`${url}/api/projects`);
    const quickMs = Date.now() - t1;
    assert.equal(quick.status, 200);
    const s = await slow;
    assert.ok(s.ms >= SLOW_S * 1000, `the slow request was slow (${s.ms} ms): its git ran the hook`);
    assert.ok(quickMs < SLOW_S * 1000 - 500, `another request was answered in ${quickMs} ms while git ran ${s.ms} ms`);
    assert.equal(s.body.step, "Q1");
    assert.deepEqual(s.body.uncommitted?.map((u) => u.path), ["left.txt"]);
  } finally { child.kill(); }
});
