// Windows process exit is asynchronous even when another termination made TerminateProcess return error 5.
// The native wait test replays that observed return value with a real held process handle. The server test uses
// real job membership and an actual process DACL denial, never a mocked cleanup rejection or a model.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectStore, approveQueue, loadProjectState, updateSettings, writeRegistry } from "@nexus/protocol";
import { acceptReviews } from "./fake-reviewer.ts";
import { spawnServer } from "./helpers.ts";
import { LONGER, serverUp, sleep, until } from "./wait.ts";

const here = dirname(fileURLToPath(import.meta.url));
const helper = join(here, "worker-helper.ps1");
const locked = (dir: string) => assert.throws(() => rmdirSync(dir), (e: NodeJS.ErrnoException) => e.code === "EBUSY" || e.code === "EPERM");

for (const exits of [true, false]) {
  test(`Windows termination refusal ${exits ? "waits for the same process to exit" : "still fails when the process stays alive"}`, { skip: process.platform !== "win32" }, async () => {
    const base = mkdtempSync(join(tmpdir(), "nexus-worker-exit-"));
    const dir = join(base, "worktree"); mkdirSync(dir);
    const ready = join(base, "ready"), release = join(base, "release");
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-File", helper, "-Ready", ready, "-Release", release], { cwd: dir, stdio: "ignore", windowsHide: true });
    const childClosed = once(child, "close");
    const script = join(base, "wait.ps1");
    // The false/5 return pair is the real Codex 0.167.2 trace. Holding the process identity and waiting for its
    // eventual signal is the contract under test; do not try to manufacture the kernel's scheduling race.
    writeFileSync(script, `param([int]$Target, [string]$Source)
$ErrorActionPreference = 'Stop'
Add-Type -Path $Source
$p = [Diagnostics.Process]::GetProcessById($Target)
try {
  $handle = $p.Handle
  [Console]::WriteLine('waiting')
  try {
    $null = [NexusWorkerJob].GetMethod('AwaitExit', [Reflection.BindingFlags]'NonPublic,Static').Invoke($null, @($handle, [int]5))
    [Console]::WriteLine('exited')
  } catch { [Console]::WriteLine('refused: ' + $_.Exception.ToString()) }
} finally { $p.Dispose() }
`);
    let waiter: ReturnType<typeof spawn> | undefined;
    let waiterClosed: Promise<unknown> | undefined;
    try {
      await until("directory holder ready", () => existsSync(ready), LONGER.step);
      locked(dir);
      waiter = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-File", script, "-Target", String(child.pid), "-Source", join(here, "../src/worker-job.cs")], { stdio: "pipe", windowsHide: true });
      waiterClosed = once(waiter, "close");
      let output = "", errors = "";
      waiter.stdout!.on("data", (b: Buffer) => { output += b.toString(); });
      waiter.stderr!.on("data", (b: Buffer) => { errors += b.toString(); });
      await until("wait holds the process handle", () => output.includes("waiting"), LONGER.step, () => errors);
      if (exits) {
        // A deliberate unsignaled interval models the observed zero-time timeout, then permits actual exit.
        await sleep(100);
        assert.doesNotMatch(output, /refused|exited/);
        locked(dir);
        writeFileSync(release, "");
      }
      await waiterClosed;
      assert.equal(errors, "");
      if (exits) { assert.match(output, /exited/); await childClosed; rmdirSync(dir); }
      else { assert.match(output, /refused:.*TerminateProcess did not complete/s); locked(dir); }
    } finally {
      writeFileSync(release, "");
      child.kill(); await childClosed;
      waiter?.kill(); await waiterClosed;
    }
  });
}

test("Windows server: owned helper cleanup, real denial and resume, and another worker's isolation", { skip: process.platform !== "win32" }, async () => {
  const base = mkdtempSync(join(tmpdir(), "nexus-worker-api-"));
  const root = join(base, "project"), home = join(base, "home"); mkdirSync(root);
  process.env.NEXUS_HOME = home;
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: root, stdio: "ignore", windowsHide: true });
  git("init", "-q", "-b", "main"); writeFileSync(join(root, ".gitignore"), ".nexus/\n"); git("add", ".gitignore"); git("commit", "-qm", "initial");
  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  updateSettings(store, { orchestrator: { notify: false }, defaults: { merge_back: false, max_running: 3 } });
  for (const [id, first, second] of [["B", "ownedhold", "done"], ["N", "ownedhold", "slow"], ["D", "owneddeny", "done"]]) {
    store.writeQueue({ protocol: 1, id: id!, title: id!, revision: 1, status: "proposed", coding: false, worktree: "auto", stop_conditions: [], checks: [],
      steps: [{ id: `${id}1`, title: "Helper", goal: `FAKE: ${first}`, acceptance: [] }, { id: `${id}2`, title: "Next", goal: `FAKE: ${second}`, acceptance: [] }] });
    approveQueue(store, id!);
  }
  writeRegistry({ protocol: 1, projects: [{ id: "p", root }] });
  const socket = createServer().listen(0, "127.0.0.1"); await once(socket, "listening");
  const port = (socket.address() as { port: number }).port; await new Promise<void>((r) => socket.close(() => r())); assert.ok(port >= 4318);
  const release = join(base, "release"), log = join(base, "fake.log");
  const child = spawnServer({ NEXUS_HOME: home, NEXUS_PORT: String(port), NEXUS_LOG: "", NEXUS_CLAUDE: join(here, "fake-claude.ts"), NEXUS_CODEX: join(here, "fake-codex.ts"), FAKE_LOG: log, FAKE_RELEASE: release });
  const closed = once(child, "close"); const url = `http://127.0.0.1:${port}`;
  const post = async (id: string, action: string, route = "run") => {
    const response = await fetch(`${url}/api/projects/p/queues/${id}/${route}`, { method: "POST", headers: { "content-type": "application/json", origin: url }, body: JSON.stringify({ action, runtime: "codex" }) });
    assert.equal(response.status, 200, await response.text());
  };
  const view = (id: string) => loadProjectState(store).queues.find((q) => q.id === id)!;
  const tree = (id: string) => store.readQueue(id).worktree!;
  const held = (id: string) => join(tree(id), `.owned-${id}1`);
  const ready = (id: string) => until(`${id}'s helper ready`, () => existsSync(`${log}.helper-${id}1`), LONGER.step);
  const reviews = setInterval(() => acceptReviews(store), 100);
  const exited = (id: string) => until(`${id}'s process exited`, () => store.readRuntime(store.readRun(id)!.session)?.state === "exited", LONGER.processes);
  try {
    await serverUp(`${url}/api/projects`);
    await post("B", "start"); await ready("B"); locked(held("B"));
    await post("N", "start"); await ready("N"); locked(held("N"));
    writeFileSync(`${release}-N1`, "");
    await until("normal cleanup before next step", () => view("N").steps[1]!.status === "running", LONGER.step);
    rmdirSync(held("N")); locked(held("B"));
    await post("N", "stop_at_once");
    assert.equal(store.readRuntime(store.readRun("N")!.session)?.state, "exited");
    await post("N", "resume"); writeFileSync(`${release}-N2`, "");
    await until("normal queue finishes", () => view("N").run?.state === "finished", LONGER.run);
    await exited("N"); // the run is finished before its process exits: the cleanup would answer 409 (survey LC3 F3 c)
    await post("N", "", "cleanup"); assert.equal(existsSync(tree("N")), false);
    await post("D", "start"); await ready("D"); locked(held("D"));
    writeFileSync(`${release}-D1`, "");
    await until("actual access refusal halts queue", () => view("D").run?.state === "halted", LONGER.step);
    assert.match(view("D").run!.reason!, /OpenProcess for worker job member/);
    assert.equal(view("D").steps[1]!.status, "pending");
    await until("failed worker's job closes", () => store.readRuntime(store.readRun("D")!.session)?.state === "exited", LONGER.processes);
    rmdirSync(held("D")); locked(held("B"));
    await post("D", "resume");
    await until("resume finishes from next step", () => view("D").run?.state === "finished", LONGER.run);
    await exited("D"); // the run is finished before its process exits: the cleanup would answer 409 (survey LC3 F3 c)
    await post("D", "", "cleanup"); assert.equal(existsSync(tree("D")), false);
    await post("B", "stop_at_once"); rmdirSync(held("B"));
    assert.ok((await fetch(`${url}/api/projects`)).ok, "the development server remains alive");
  } finally {
    clearInterval(reviews);
    for (const id of ["B", "N", "D"]) {
      const run = store.readRun(id);
      if (run && run.state !== "finished" && store.readRuntime(run.session)?.state !== "exited") {
        await post(id, "stop_at_once").catch(() => {});
      }
    }
    child.kill(); await closed;
  }
});
