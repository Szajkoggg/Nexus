// The job host's End through its native seam (worker-job.cs, EndCalls; queue WHR, WHR1). A scripted seam records the
// calls of the production End and gives it the results the test chooses; with no seam set, End makes the real kernel32
// calls. Both run in a PowerShell of their own that compiles the repository's worker-job.cs with the test harness.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

const driver = fileURLToPath(new URL("./worker-end.ps1", import.meta.url));
const windows = { skip: process.platform !== "win32" };
const DEFAULT_SEAM = "NexusWorkerJob+Kernel32EndCalls";

/** Sends the requests (EndHarness.Run in worker-end-calls.cs) to one driver; each answer as its lines. */
async function endHarness(requests: string[]): Promise<string[][]> {
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", driver], { stdio: "pipe", windowsHide: true });
  let out = "", errors = "";
  child.stdout.on("data", (b: Buffer) => { out += b.toString(); });
  child.stderr.on("data", (b: Buffer) => { errors += b.toString(); });
  const closed = once(child, "close");
  child.stdin.end(requests.join("\n---\n"));
  const [code] = await closed as [number | null];
  assert.equal(code, 0, errors);
  assert.equal(errors, "");
  return out.replace(/\r/g, "").trim().split("\n---\n").map((block) => block.split("\n"));
}

const HANDLE = 4660, JOB = 9001, PID = 42;
const OPEN = `OpenProcess 0x101001 False ${PID}`; // synchronize, query limited information, terminate

test("End records the open, the membership check, terminate, wait and close on one handle, and takes scripted results", windows, async () => {
  const answers = await endHarness([
    // A live member: the zero-time wait times out (258), terminate succeeds, the 2000 ms wait sees the exit.
    `scripted ${PID} ${JOB}\nopen ${HANDLE} 0\nmember 1 1 0\nwait 258 0\nterminate 1 0\nwait 0 0\nclose 1`,
    // A controlled syscall result: OpenProcess refused with ERROR_ACCESS_DENIED (5).
    `scripted ${PID} ${JOB}\nopen 0 5`,
  ]);
  const [success, refused] = [answers[0]!, answers[1]!];
  assert.deepEqual(success, [
    OPEN,
    `IsProcessInJob ${HANDLE} ${JOB}`,
    `WaitForSingleObject ${HANDLE} 0`,
    `TerminateProcess ${HANDLE} 1`,
    `WaitForSingleObject ${HANDLE} 2000`,
    `CloseHandle ${HANDLE}`,
    "outcome returned",
    `restored ${DEFAULT_SEAM}`,
  ]);
  assert.equal(refused.length, 4, refused.join("\n"));
  assert.deepEqual(refused.slice(0, 2), [OPEN, "LastError 5"], "no handle, so nothing else runs and nothing is closed");
  assert.match(refused[2]!, new RegExp(`^outcome threw System\\.ComponentModel\\.Win32Exception 5 OpenProcess for worker job member ${PID}: `));
  assert.equal(refused[3], `restored ${DEFAULT_SEAM}`);
});

test("with no seam set, End makes the real calls: it ends a member of its job and leaves another process alone", windows, async () => {
  const start = () => spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
  const member = start(), stranger = start();
  const memberExit = once(member, "exit"), strangerExit = once(stranger, "exit");
  try {
    const [seam, ...ends] = (await endHarness([`real ${member.pid} ${stranger.pid}`]))[0]!;
    assert.equal(seam, `seam ${DEFAULT_SEAM}`);
    assert.deepEqual(ends, ["stranger returned", "none returned", "member returned"]);
    // TerminateProcess(handle, 1) ended it: End returns only after the wait saw the exit.
    const [code] = await memberExit as [number | null];
    assert.equal(code, 1);
    assert.equal(stranger.exitCode, null);
    assert.doesNotThrow(() => process.kill(stranger.pid!, 0), "the process outside the job is alive");
  } finally {
    member.kill(); stranger.kill();
    await Promise.all([memberExit, strangerExit]);
  }
});
