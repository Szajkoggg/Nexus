// H8 of the LWH survey (queue WHR, WHR6): the job's membership changing while a worker's cleanup runs, in a real job
// host (worker-gate-fixture.ts). The step's helper can start a child of its own on the test's signal (fake behaviour
// ownedholdsharedlate, worker-helper.ps1 -Late); the gate holds End at the helper's 2000 ms wait, so Clean's first
// membership list is taken and the child is born after it, a member by inheritance. The gate's trace (every list Clean
// read and every native call End made, for any member) shows what Clean saw and did. The deadline branches (the 10 s
// checkpoint, several members each waiting, the server's 15 s) are deterministic on the scripted seam
// (worker-end.test.ts, worker-process-frames.test.ts): here only real processes, nothing injected but the helper's
// first TerminateProcess (false/5, as the WH2 trace).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { LONGER, holds, until } from "./wait.ts";
import { alive, atGate, isLocked, locked, windows, workerA, workerB, type A } from "./worker-gate-fixture.ts";

// The fake runtimes as processes of their own (scripts/real-process-tests.ts).
process.env.NEXUS_CLAUDE = fileURLToPath(new URL("./fake-claude.ts", import.meta.url));
process.env.NEXUS_CODEX = fileURLToPath(new URL("./fake-codex.ts", import.meta.url));

/** The helper's late child: started on the signal, its PID read from its own ready file, its directory. */
async function lateChild(a: A) {
  const file = `${a.log}.helper-Q1.late`;
  writeFileSync(`${file}.go`, "");
  await until("the late child is up", () => existsSync(file), LONGER.step);
  const pid = Number(readFileSync(file, "utf8"));
  const dir = `${a.dir}-late`;
  await until("the late child holds its directory", () => isLocked(dir), LONGER.step);
  return { pid, dir, release: () => writeFileSync(`${file}.release`, "") };
}

/** The trace of the first cleanup: up to and with the first list that holds nothing but the host and its runtime. */
function firstClean(a: A, host: number, runtime: number): string[] {
  const trace = a.gate.trace();
  const only = `Members ${[host, runtime].sort((x, y) => x - y).join(" ")}`;
  const end = trace.findIndex((l) => l.startsWith("Members ") && `Members ${l.slice(8).split(" ").map(Number).sort((x, y) => x - y).join(" ")}` === only);
  assert.ok(end > 0, `the first cleanup ends on an empty list: ${trace.join(" | ")}`);
  return trace.slice(0, end + 1);
}
const members = (line: string) => line.slice(8).split(" ").map(Number);

test("claude: a child the helper starts after Clean's first list inherits the job: the next list has it, End checks it on its handle and ends it, and C comes only on a list with nothing but the host and its runtime; then Q2 once", windows, async () => {
  const b = await workerB("claude");
  const a = await workerA("claude", ["ownedholdsharedlate", "done"]).catch(async (e: unknown) => { await b.end(); throw e; });
  let late: Awaited<ReturnType<typeof lateChild>> | undefined;
  try {
    a.finishTurn();
    await atGate(a);
    const host = a.gate.hosts[0]!.pid!, runtime = a.store.readRuntime(a.session())!.pid!;
    late = await lateChild(a);
    assert.ok(alive(late.pid));
    await holds("nothing goes on while the wait is held", () => a.cleanups.calls[0]!.outcome === undefined && a.openings("Q2") === 0, 300);
    a.releaseHelper();
    a.gate.open();
    await a.until("the queue finishes", () => a.queue().run?.state === "finished", LONGER.run);
    const trace = firstClean(a, host, runtime);
    const lists = trace.filter((l) => l.startsWith("Members "));
    assert.deepEqual(members(lists[0]!).sort(), [host, runtime, a.helper].sort(), "the first list: the host, its runtime and the helper");
    assert.ok(!members(lists[0]!).includes(late.pid), "the child was born after it");
    const withLate = lists.findIndex((l) => members(l).includes(late!.pid));
    assert.ok(withLate >= 1, "a later list has the child");
    const at = trace.findIndex((l) => l.startsWith(`OpenProcess ${late!.pid} `));
    const h = Number(trace[at]!.split(" ")[2]);
    assert.ok(h > 0, trace[at]);
    // Handle values are reused once closed: only the calls after this open count.
    const its = trace.filter((l, i) => i > at && new RegExp(`^\\w+ ${h}( |$)`).test(l));
    assert.deepEqual(its.slice(0, 5), [`IsProcessInJob ${h} True True`, `WaitForSingleObject ${h} 0 258`, `TerminateProcess ${h} True`, `WaitForSingleObject ${h} 2000 0`, `CloseHandle ${h}`],
      "inherited membership, checked on the opened handle, then ended (real calls)");
    assert.equal(a.cleanups.calls[0]!.outcome, "done", "C after the empty list");
    assert.equal(alive(late.pid), false, "the late child is gone");
    await until("both directories are free", () => !isLocked(a.dir) && !isLocked(late!.dir), LONGER.processes);
    assert.equal(a.openings("Q1"), 1);
    assert.equal(a.openings("Q2"), 1, "Q2 once, after the cleanup");
    a.contentKept();
    locked(b.dir);
    assert.ok(alive(b.pid));
  } finally { late?.release(); await a.end(); await b.end(); }
});

test("codex: a member that exits between Clean's list and its OpenProcess: the open finds it gone or exited, nothing is terminated, C follows the next empty list; then Q2 once", windows, async () => {
  const b = await workerB("codex");
  const a = await workerA("codex", ["ownedholdsharedlate", "done"]).catch(async (e: unknown) => { await b.end(); throw e; });
  let late: Awaited<ReturnType<typeof lateChild>> | undefined;
  try {
    // The helper's open is End's first; the late child's, on the next list, its second: held before it is made.
    a.gate.holdOpen(2);
    a.finishTurn();
    await atGate(a);
    const host = a.gate.hosts[0]!.pid!, runtime = a.store.readRuntime(a.session())!.pid!;
    late = await lateChild(a);
    a.releaseHelper();
    a.gate.open();
    await until("End holds before the late child's open", () => !!a.gate.arrivedAt(2), LONGER.step);
    assert.equal(a.gate.arrivedAt(2)!.pid, late.pid, "listed, not yet opened");
    assert.equal(a.cleanups.calls[0]!.outcome, undefined);
    late.release();
    await until("the late child has exited and freed its directory", () => !alive(late!.pid) && !isLocked(late!.dir), LONGER.processes);
    a.gate.openAt(2);
    await a.until("the queue finishes", () => a.queue().run?.state === "finished", LONGER.run);
    const trace = firstClean(a, host, runtime);
    const heldAt = trace.indexOf(`held open ${late.pid}`);
    assert.ok(heldAt > 0 && members(trace.slice(0, heldAt).filter((l) => l.startsWith("Members ")).at(-1)!).includes(late.pid), "the list before the hold has it");
    const opened = trace.find((l, i) => i > heldAt && l.startsWith(`OpenProcess ${late!.pid} `))!;
    const h = Number(opened.split(" ")[2]);
    // Three real outcomes, by how far the child's exit has come when End opens it: gone (87); exited (the zero-time
    // wait is signalled); or exiting: Node already sees its exit code, the process object is not yet signalled, and
    // TerminateProcess is refused while the exit completes; the 2000 ms wait on the same handle then sees it (WH2's
    // trace, here with real calls, nothing injected for this process).
    const its = h === 0 ? [] : trace.filter((l, i) => i > heldAt && new RegExp(`^\\w+ ${h}( |$)`).test(l)).filter((l) => !l.startsWith("IsProcessInJob"));
    if (h === 0) assert.equal(opened, `OpenProcess ${late.pid} 0 error 87`, "gone: End returns");
    else if (its[0] === `WaitForSingleObject ${h} 0 0`) assert.deepEqual(its, [`WaitForSingleObject ${h} 0 0`, `CloseHandle ${h}`], "exited: nothing terminated");
    else {
      assert.equal(its.length, 4, its.join(" | "));
      assert.equal(its[0], `WaitForSingleObject ${h} 0 258`);
      assert.match(its[1]!, new RegExp(`^TerminateProcess ${h} False error \\d+$`), "exiting: the terminate refused");
      assert.deepEqual(its.slice(2), [`WaitForSingleObject ${h} 2000 0`, `CloseHandle ${h}`], "the wait on the same handle sees the exit");
    }
    assert.ok(!trace.slice(heldAt).some((l) => l.startsWith("TerminateProcess") && / True$/.test(l)), "nothing ended by the cleanup after the hold");
    assert.equal(a.cleanups.calls[0]!.outcome, "done");
    await until("the helper's directory is free", () => !isLocked(a.dir), LONGER.processes);
    assert.equal(a.openings("Q1"), 1);
    assert.equal(a.openings("Q2"), 1);
    a.contentKept();
    locked(b.dir);
    assert.ok(alive(b.pid));
  } finally { late?.release(); await a.end(); await b.end(); }
});
