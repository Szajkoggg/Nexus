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

// H3 and H5 of the LWH survey (queue WHR, WHR2): the whole End, every branch, on scripted native results. Each case
// gives the replies in the order End consumes them and the exact calls it must make. The results here are injected:
// the real-handle wait and the DACL denial stay in worker-exit.test.ts, the real calls in the test above.
const WAIT_TIMEOUT = 258, WAIT_FAILED = 0xffffffff;
const MEMBER = `IsProcessInJob ${HANDLE} ${JOB}`, POLL = `WaitForSingleObject ${HANDLE} 0`;
const TERMINATE = `TerminateProcess ${HANDLE} 1`, WAIT = `WaitForSingleObject ${HANDLE} 2000`, CLOSE = `CloseHandle ${HANDLE}`;
const win32 = (code: number, text: string) => new RegExp(`^outcome threw System\.ComponentModel\.Win32Exception ${code} ${text}: `);
const TIMED_OUT = "outcome threw System.TimeoutException - worker child did not exit";

const CASES: { name: string; replies: string[]; calls: string[]; outcome: string | RegExp }[] = [
  { name: "OpenProcess fails with 87 (the process is gone): it returns, and there is nothing to close",
    replies: ["open 0 87"], calls: [OPEN, "LastError 87"], outcome: "outcome returned" },
  { name: "OpenProcess fails with 5: a Win32Exception with code 5 naming OpenProcess, nothing to close",
    replies: ["open 0 5"], calls: [OPEN, "LastError 5"], outcome: win32(5, `OpenProcess for worker job member ${PID}`) },
  { name: "OpenProcess fails with another error (6): that code, naming OpenProcess",
    replies: ["open 0 6"], calls: [OPEN, "LastError 6"], outcome: win32(6, `OpenProcess for worker job member ${PID}`) },
  { name: "a process outside the job (a reused PID): the handle is closed, never waited on or terminated",
    replies: [`open ${HANDLE} 0`, "member 1 0 0", "close 1"], calls: [OPEN, MEMBER, CLOSE], outcome: "outcome returned" },
  { name: "a member that has already exited: the handle is closed, nothing terminated",
    replies: [`open ${HANDLE} 0`, "member 1 1 0", "wait 0 0", "close 1"], calls: [OPEN, MEMBER, POLL, CLOSE], outcome: "outcome returned" },
  { name: "IsProcessInJob fails with 5: its code naming IsProcessInJob, the handle closed, nothing terminated",
    replies: [`open ${HANDLE} 0`, "member 0 0 5", "close 1"], calls: [OPEN, MEMBER, "LastError 5", CLOSE],
    outcome: win32(5, `IsProcessInJob for worker job member ${PID}`) },
  { name: "TerminateProcess false/5, then the process exits within the 2000 ms wait: success",
    replies: [`open ${HANDLE} 0`, "member 1 1 0", `wait ${WAIT_TIMEOUT} 0`, "terminate 0 5", "wait 0 0", "close 1"],
    calls: [OPEN, MEMBER, POLL, TERMINATE, "LastError 5", WAIT, CLOSE], outcome: "outcome returned" },
  { name: "TerminateProcess false/5 and the process stays alive through the wait: code 5, TerminateProcess did not complete",
    replies: [`open ${HANDLE} 0`, "member 1 1 0", `wait ${WAIT_TIMEOUT} 0`, "terminate 0 5", `wait ${WAIT_TIMEOUT} 0`, "close 1"],
    calls: [OPEN, MEMBER, POLL, TERMINATE, "LastError 5", WAIT, CLOSE], outcome: win32(5, "TerminateProcess did not complete") },
  { name: "TerminateProcess succeeds but the exit does not come within 2000 ms: a TimeoutException, no error read",
    replies: [`open ${HANDLE} 0`, "member 1 1 0", `wait ${WAIT_TIMEOUT} 0`, "terminate 1 0", `wait ${WAIT_TIMEOUT} 0`, "close 1"],
    calls: [OPEN, MEMBER, POLL, TERMINATE, WAIT, CLOSE], outcome: TIMED_OUT },
  { name: "WAIT_FAILED after a successful TerminateProcess: today's TimeoutException",
    replies: [`open ${HANDLE} 0`, "member 1 1 0", `wait ${WAIT_TIMEOUT} 0`, "terminate 1 0", `wait ${WAIT_FAILED} 6`, "close 1"],
    calls: [OPEN, MEMBER, POLL, TERMINATE, WAIT, CLOSE], outcome: TIMED_OUT },
  { name: "WAIT_FAILED after TerminateProcess false/5: the original code 5, not the wait's",
    replies: [`open ${HANDLE} 0`, "member 1 1 0", `wait ${WAIT_TIMEOUT} 0`, "terminate 0 5", `wait ${WAIT_FAILED} 6`, "close 1"],
    calls: [OPEN, MEMBER, POLL, TERMINATE, "LastError 5", WAIT, CLOSE], outcome: win32(5, "TerminateProcess did not complete") },
  { name: "last errors left by earlier calls and set by the later wait do not replace TerminateProcess's 5",
    replies: [`open ${HANDLE} 1400`, "member 1 1 183", `wait ${WAIT_TIMEOUT} 1400`, "terminate 0 5", `wait ${WAIT_TIMEOUT} 1400`, "close 1"],
    calls: [OPEN, MEMBER, POLL, TERMINATE, "LastError 5", WAIT, CLOSE], outcome: win32(5, "TerminateProcess did not complete") },
];

// One driver for all cases: a PowerShell and its compile per case would cost seconds each.
let matrix: Promise<string[][]> | undefined;
const answers = () => matrix ??= endHarness(CASES.map((c) => [`scripted ${PID} ${JOB}`, ...c.replies].join("\n")));

CASES.forEach((c, i) => {
  test(`End, ${c.name}`, windows, async () => {
    const lines = (await answers())[i]!;
    const calls = lines.slice(0, -2), [outcome, restored] = lines.slice(-2);
    assert.deepEqual(calls, c.calls, lines.join("\n"));
    if (typeof c.outcome === "string") assert.equal(outcome, c.outcome);
    else assert.match(outcome!, c.outcome);
    assert.equal(restored, `restored ${DEFAULT_SEAM}`);
    // The identity rules on every branch: one open, never a second; every call on a handle uses the opened one;
    // an opened handle is closed exactly once, as the last call; terminate at most once, and only after a membership check.
    assert.equal(calls.filter((l) => l.startsWith("OpenProcess")).length, 1);
    const handles = calls.filter((l) => /^(IsProcessInJob|WaitForSingleObject|TerminateProcess|CloseHandle) /.exec(l));
    for (const l of handles) assert.equal(l.split(" ")[1], String(HANDLE), l);
    const closes = calls.filter((l) => l.startsWith("CloseHandle")).length;
    assert.equal(closes, handles.length > 0 ? 1 : 0);
    if (closes) assert.equal(calls.at(-1), CLOSE);
    const terminates = calls.filter((l) => l.startsWith("TerminateProcess")).length;
    assert.ok(terminates <= 1);
    if (terminates) assert.ok(calls.indexOf(MEMBER) >= 0 && calls.indexOf(MEMBER) < calls.indexOf(TERMINATE));
  });
});

// H8 of the LWH survey (queue WHR, WHR6): Clean, the loop over the job's membership, on the scripted seam: the lists
// Members gives and the clock Clean reads are the test's (`list`, `elapsed`), and so are the native results of each
// End. The real membership (a child started by a member is one, a member gone before its open) is shown with the real
// job host in worker-cleanup-membership.test.ts; here the deadline branches are deterministic.
const SETTLE = /^outcome threw System\.TimeoutException - worker job did not settle$/;

/** One member's End, live: the replies it takes and the calls it makes (terminate succeeds, the exit comes in the wait). */
function live(pid: number | "runtime", h: number) {
  return {
    replies: [`open ${h} 0`, "member 1 1 0", "wait 258 0", "terminate 1 0", "wait 0 0", "close 1"],
    calls: [`OpenProcess 0x101001 False ${pid}`, `IsProcessInJob ${h} ${JOB}`, `WaitForSingleObject ${h} 0`, `TerminateProcess ${h} 1`, `WaitForSingleObject ${h} 2000`, `CloseHandle ${h}`],
  };
}
/** Gone between the list and its open: OpenProcess fails with 87, End returns. */
const gone = (pid: number) => ({ replies: ["open 0 87"], calls: [`OpenProcess 0x101001 False ${pid}`, "LastError 87"] });
/** Exited, but still openable: the zero-time wait sees the exit, nothing is terminated. */
const exited = (pid: number, h: number) => ({
  replies: [`open ${h} 0`, "member 1 1 0", "wait 0 0", "close 1"],
  calls: [`OpenProcess 0x101001 False ${pid}`, `IsProcessInJob ${h} ${JOB}`, `WaitForSingleObject ${h} 0`, `CloseHandle ${h}`],
});

/**
 * Runs Clean(keep) once: `rounds` are the lists in order, each with its members' Ends and the clock read after it (none
 * for a list Clean finds empty). Returns the harness's answer: the PIDs line, then every call, the outcome and the
 * restored seam; and the calls Clean must have made, built from the same rounds.
 */
async function clean(keep: boolean, rounds: { list: string; ends: ReturnType<typeof live>[]; elapsed?: number }[]) {
  const replies = rounds.flatMap((r) => [`list ${r.list}`, ...r.ends.flatMap((e) => e.replies), ...(r.elapsed === undefined ? [] : [`elapsed ${r.elapsed}`])]);
  const answer = (await endHarness([[`clean ${keep ? 1 : 0} ${JOB}`, ...replies].join("\n")]))[0]!;
  const [self, runtime] = answer[0]!.split(" ").slice(1).map(Number);
  assert.ok(self! > 0 && runtime! > 0 && self !== runtime, answer[0]);
  const named = (list: string) => list.split(" ").filter(Boolean).map((x) => (x === "self" ? self : x === "runtime" ? runtime : Number(x))).join(" ");
  const expected = ["StartTimer", ...rounds.flatMap((r) => [`Members ${named(r.list)}`, ...r.ends.flatMap((e) => e.calls).map((c) => c.replace(/ runtime$/, ` ${runtime}`)), ...(r.elapsed === undefined ? [] : [`Elapsed ${r.elapsed}`])])];
  return { answer: answer.slice(1), expected, runtime: runtime! };
}

test("Clean: children that join after a list are ended on the next ones; it returns only on a list with nothing but the host and its runtime, and reads the clock after each list it ended, never after the empty one", windows, async () => {
  const { answer, expected } = await clean(true, [
    { list: "self runtime 101", ends: [live(101, 11)], elapsed: 1000 },
    { list: "self runtime 102", ends: [live(102, 12)], elapsed: 3000 },
    { list: "runtime 103 self 104", ends: [live(103, 13), live(104, 14)], elapsed: 7000 },
    { list: "self runtime 105", ends: [live(105, 15)], elapsed: 9000 },
    { list: "runtime self", ends: [] },
  ]);
  assert.deepEqual(answer, [...expected, "outcome returned", `restored ${DEFAULT_SEAM}`]);
});

test("Clean: a member gone between the list and its open (87) is skipped, one that exited but can still be opened is not terminated, the live one is ended", windows, async () => {
  const { answer, expected } = await clean(true, [
    { list: "self runtime 101 102 103", ends: [gone(101), exited(102, 12), live(103, 13)], elapsed: 500 },
    { list: "self runtime", ends: [] },
  ]);
  assert.deepEqual(answer, [...expected, "outcome returned", `restored ${DEFAULT_SEAM}`]);
  assert.equal(answer.filter((l) => l.startsWith("TerminateProcess")).length, 1, "only the live member is terminated");
});

test("Clean for the job's end (keep false, K and the input's end): the runtime is a member to end like any other; the host is never one", windows, async () => {
  const { answer, expected, runtime } = await clean(false, [{ list: "self runtime", ends: [live("runtime", 21)], elapsed: 200 }, { list: "self", ends: [] }]);
  assert.deepEqual(answer, [...expected, "outcome returned", `restored ${DEFAULT_SEAM}`]);
  assert.equal(answer.find((l) => l.startsWith("OpenProcess")), `OpenProcess 0x101001 False ${runtime}`);
});

test("Clean's 10 s is a checkpoint after a whole list, not a wall-clock limit: 10 000 ms goes on, 10 001 ms fails with the settle error only after every member of that list was ended", windows, async () => {
  const { answer, expected } = await clean(true, [
    { list: "self runtime 101 102", ends: [live(101, 11), live(102, 12)], elapsed: 10_000 },
    { list: "self runtime 103 104", ends: [live(103, 13), live(104, 14)], elapsed: 10_001 },
  ]);
  assert.deepEqual(answer.slice(0, -2), expected);
  assert.match(answer.at(-2)!, SETTLE);
  assert.equal(answer.at(-1), `restored ${DEFAULT_SEAM}`);
});

test("Clean past 10 s on a list whose members are now all ended: still the settle error, no list is read after the check", windows, async () => {
  const { answer, expected } = await clean(true, [{ list: "self runtime 101", ends: [live(101, 11)], elapsed: 10_001 }]);
  assert.deepEqual(answer.slice(0, -2), expected);
  assert.equal(answer.filter((l) => l.startsWith("Members")).length, 1);
  assert.match(answer.at(-2)!, SETTLE);
});

test("Clean with six members each waiting out its own 2000 ms: every one gets its one wait, then the clock (12 000 ms) fails the cleanup with the settle error", windows, async () => {
  const pids = [101, 102, 103, 104, 105, 106];
  const { answer, expected } = await clean(true, [{ list: `self runtime ${pids.join(" ")}`, ends: pids.map((p, i) => live(p, 11 + i)), elapsed: 12_000 }]);
  assert.deepEqual(answer.slice(0, -2), expected);
  assert.equal(answer.filter((l) => / 2000$/.test(l)).length, 6, "one 2000 ms wait per member");
  assert.match(answer.at(-2)!, SETTLE);
});
