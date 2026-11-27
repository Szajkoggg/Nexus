// The worktree setup command's whole process tree ends with it (queue LKF): a drain that cannot wait, a shutdown and
// the setup's time limit end not only the shell but what the command started, so the worktree's folder is free after.
// On Windows the command runs in a job of its own (src/capacity.ts, spawnTree), elsewhere in a process group. A real
// setup command whose node child records its own pid and waits; the test checks that pid, and that the folder can be
// removed (on Windows a process whose working directory it is keeps it).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateSettings, type ProjectStore } from "@nexus/protocol";
import { runSetup } from "../src/worktree.ts";
import { LONGER, until } from "./wait.ts";
import { setup } from "./engine-setup.ts";

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** A setup command (`node parent.cjs`) whose child records its pid in `child.pid` and waits until it is ended. */
function treeScript() {
  const dir = mkdtempSync(join(tmpdir(), "nexus-setup-tree-"));
  writeFileSync(join(dir, "child.cjs"), `require("fs").writeFileSync(require("path").join(__dirname, "child.pid"), String(process.pid));
setInterval(() => {}, 1000);
`);
  writeFileSync(join(dir, "parent.cjs"), `const c = require("child_process").spawn(process.execPath, [require("path").join(__dirname, "child.cjs")], { stdio: "ignore" });
c.on("exit", (code) => process.exit(code ?? 1));
`);
  const childPid = () => (existsSync(join(dir, "child.pid")) ? Number(readFileSync(join(dir, "child.pid"), "utf8")) : undefined);
  return { dir, command: `node "${join(dir, "parent.cjs")}"`, childPid };
}

/** Removes the folder: on Windows it fails while a process works in it. Renaming first shows it at once, without retries. */
function removable(folder: string): boolean {
  const moved = `${folder}-gone`;
  try { renameSync(folder, moved); } catch { return false; }
  rmSync(moved, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  return true;
}

function withTreeSetup(store: ProjectStore) {
  const root = store.readProject().root;
  const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...a], { cwd: root, stdio: "ignore" });
  git("init", "-q", "-b", "main"); writeFileSync(join(root, "a.txt"), "a\n"); git("add", "a.txt"); git("commit", "-qm", "init");
  const t = treeScript();
  updateSettings(store, { defaults: { worktree_setup: t.command } });
  return t;
}

for (const how of ["drain-now", "shutdown"] as const) {
  test(`${how} while the worktree setup runs ends the command's child too, and frees the worktree's folder`, async () => {
    const x = setup(["done"]);
    const t = withTreeSetup(x.store);
    x.store.writeQueue({ ...x.store.readQueue("Q"), worktree: "auto" });
    let pid: number | undefined;
    try {
      x.engine.start("Q", { runtime: "claude" });
      await x.until("the setup's child runs", () => (pid = t.childPid()) !== undefined, LONGER.run);
      if (how === "drain-now") x.engine.drainForUpdate(true); else x.engine.shutdown();
      await x.until(`the setup's child (pid ${pid}) ended`, () => !alive(pid!), LONGER.run);
      if (how === "drain-now") await x.until("the engine let go of the setup", () => x.engine.idle(), LONGER.run);
      const wt = x.store.readQueue("Q").worktree!;
      await x.until(`the worktree's folder ${wt} can be removed`, () => removable(wt), LONGER.run);
    } finally {
      x.engine.shutdown();
      if (pid !== undefined && alive(pid)) process.kill(pid);
      rmSync(t.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
}

test("a setup that runs into its time limit is ended with its child, and its folder is free", { timeout: 60_000 }, async () => {
  const t = treeScript();
  const cwd = join(t.dir, "work");
  mkdirSync(cwd);
  let pid: number | undefined;
  try {
    const result = await runSetup(t.command, cwd, { limitMs: 10_000 });
    assert.match(result ?? "", /ran longer than .* and was ended/);
    pid = t.childPid();
    assert.ok(pid !== undefined, "the child started before the limit");
    await until(`the setup's child (pid ${pid}) ended`, () => !alive(pid!), LONGER.run);
    await until("the setup's folder can be removed", () => removable(cwd), LONGER.run);
  } finally {
    if (pid !== undefined && alive(pid)) process.kill(pid);
    rmSync(t.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

// Survey LC4 finding 7 (queue LCG): a setup command that exits but leaves a detached process behind (a daemon it
// started). Its result is the command's own exit code; what it left is ended at its end, and the folder is free. So a
// setup cannot keep a daemon running (README.md, the worktree setup). Windows only: there the command's job holds every
// descendant, detached or not, and its monitor ends them at the root's exit; elsewhere a detached child leaves the
// command's process group, which is what is ended.
test("a setup whose parent starts a detached child and exits 0: the setup succeeds, the child is ended with its end, the folder is free", { timeout: 60_000, skip: process.platform !== "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "nexus-setup-daemon-"));
  writeFileSync(join(dir, "child.cjs"), `require("fs").writeFileSync(require("path").join(__dirname, "child.pid"), String(process.pid));
setInterval(() => {}, 1000);
`);
  // The parent waits for the child's pid file (so the child surely started), then lets it go and exits 0.
  writeFileSync(join(dir, "parent.cjs"), `const { spawn } = require("child_process"); const { existsSync } = require("fs"); const { join } = require("path");
const c = spawn(process.execPath, [join(__dirname, "child.cjs")], { detached: true, stdio: "ignore", cwd: join(__dirname, "work") });
c.unref();
const t = setInterval(() => { if (existsSync(join(__dirname, "child.pid"))) { clearInterval(t); process.exit(0); } }, 20);
`);
  const cwd = join(dir, "work");
  mkdirSync(cwd);
  const childPid = () => (existsSync(join(dir, "child.pid")) ? Number(readFileSync(join(dir, "child.pid"), "utf8")) : undefined);
  let pid: number | undefined;
  try {
    const result = await runSetup(`node "${join(dir, "parent.cjs")}"`, cwd, { limitMs: 30_000 });
    assert.equal(result, undefined, "the setup succeeded: its command exited 0");
    pid = childPid();
    assert.ok(pid !== undefined, "the detached child had started");
    await until(`the detached child (pid ${pid}) ended with the setup`, () => !alive(pid!), LONGER.run);
    await until("the setup's folder can be removed", () => removable(cwd), LONGER.run);
  } finally {
    if (pid !== undefined && alive(pid)) process.kill(pid);
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
