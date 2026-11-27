// Unreadable files met by the server's actions and its own files (survey LC3, F12 and F13; queue LCK), by the rule of
// docs/design/state.md, "Missing and unreadable files", and the user's decisions of queue LCK:
// - F12: an action on a queue or session whose file cannot be read is a refusal (409) naming the file, not an
//   "unknown queue" (404) and not the server's own failure (500).
// - F13: an unreadable deploy-plan.json is not a silent "no plan": the planner's recovery warns with its path and sets
//   it aside as deploy-plan.json.corrupt. A hand-over file unreadable at one read stays "next poll" (its writer renames
//   it in whole), but unreadable at the next read too, the log names it.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { errorText } from "@nexus/protocol/errors";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ActionError, faultRenames, now } from "@nexus/protocol";
import { DeployPlanner, readPlanFile } from "../src/deploy-plan.ts";
import { Standby } from "../src/handover.ts";
import type { UpdateStatus } from "../src/lifecycle.ts";
import { setup } from "./engine-setup.ts";
import { tempDir } from "./temp-dirs.ts";

/** console.warn's lines while `fn` runs. */
function warned<T>(fn: () => T): { value: T; lines: string[] } {
  const lines: string[] = [];
  const m = mock.method(console, "warn", (...a: unknown[]) => { lines.push(a.map(String).join(" ")); });
  try { return { value: fn(), lines }; } finally { m.mock.restore(); }
}

/** The ActionError an action threw: its status and message. */
function refusal(fn: () => unknown): { status: number; message: string } {
  try { fn(); } catch (e) {
    assert.ok(e instanceof ActionError, `an ActionError, not: ${errorText(e)}`);
    return { status: e.status, message: e.message };
  }
  assert.fail("not refused");
}

// ---------------------------------------------------------------- F12

test("F12: the engine's actions on a queue whose queue.yaml cannot be read are refused (409) with the file's name", () => {
  const x = setup(["done"]);
  try {
    const file = join(x.store.queueDir("Q"), "queue.yaml");
    writeFileSync(file, "steps: [unclosed\n");
    for (const [what, fn] of [
      ["start", () => x.engine.start("Q", { runtime: "claude" })],
      ["continueQueue", () => x.engine.continueQueue("Q")],
    ] as const) {
      const r = refusal(fn);
      assert.equal(r.status, 409, `${what}: ${r.message}`);
      assert.match(r.message, /queues\/Q\/queue\.yaml cannot be read/, what);
    }
    assert.equal(readFileSync(file, "utf8"), "steps: [unclosed\n", "the file is untouched");
    assert.equal(refusal(() => x.engine.start("X", { runtime: "claude" })).status, 404, "a queue that is not there is still unknown");
  } finally { x.engine.shutdown(); }
});

test("F12: a start that continues a session whose session.yaml cannot be read is refused (409) with the file's name", () => {
  const x = setup(["done"]);
  try {
    x.store.writeSession({ protocol: 1, id: "s-old", project: "p", role: "worker", runtime: "claude", native_id: "00000000-0000-4000-8000-000000000000", cwd: x.store.dir, launched_by: "nexus", created_at: now() });
    writeFileSync(join(x.store.sessionDir("s-old"), "session.yaml"), "role: [unclosed\n");
    const r = refusal(() => x.engine.start("Q", { runtime: "claude", session: "s-old" }));
    assert.equal(r.status, 409, r.message);
    assert.match(r.message, /sessions\/s-old\/session\.yaml cannot be read/);
    assert.equal(x.queue().run, undefined, "nothing started");
  } finally { x.engine.shutdown(); }
});

// ---------------------------------------------------------------- F13

const quiet: UpdateStatus = { phase: "idle", held: [], waiting: [], log: [] };
const idle = { busy: false, status: quiet, start: () => quiet, cancel: () => {}, hurry: () => {} };
const planner = (file: string) => new DeployPlanner({ lifecycle: idle, state: () => undefined, file });

for (const v of [
  { as: "unparsable", text: "{ \"plan\": " },
  { as: "not a plan", text: "{ \"protocol\": 1, \"plan\": { \"id\": 7 } }\n" },
]) {
  test(`F13: an unreadable deploy-plan.json (${v.as}) warns with its path at the planner's recovery and is set aside as .corrupt`, () => {
    const file = join(tempDir("nexus-plan-"), "deploy-plan.json");
    writeFileSync(file, v.text);
    const p = planner(file);
    assert.ok(existsSync(file), "the constructor only reads: the server may not own the files yet");
    const { lines } = warned(() => p.recover());
    assert.ok(lines.some((l) => l.includes("deploy-plan.json cannot be read") && l.includes("deploy-plan.json.corrupt")), `told: ${lines.join(" | ")}`);
    assert.equal(readFileSync(`${file}.corrupt`, "utf8"), v.text, "set aside as it was");
    assert.ok(!existsSync(file), "nothing written in its place yet");
    assert.equal(p.view(), null, "no plan");
    // A second damage later: beside the first, never over it (F14).
    writeFileSync(file, "nonsense");
    const again = warned(() => planner(file).recover());
    assert.ok(again.lines.some((l) => l.includes("deploy-plan.json.corrupt.2")), again.lines.join(" | "));
    assert.equal(readFileSync(`${file}.corrupt`, "utf8"), v.text, "the first copy is kept");
  });
}

// Survey LC4 finding 9 (queue LCG): the setting aside itself fails. The log still names the file and says the next
// plan written replaces it; the recovery goes on with no plan.
test("F13: an unreadable deploy-plan.json that cannot be set aside: the warning says so and that the next plan replaces it; no plan, the file left in place", () => {
  const file = join(tempDir("nexus-plan-"), "deploy-plan.json");
  writeFileSync(file, "{ \"plan\": ");
  const p = planner(file);
  const renames = faultRenames({ file: "deploy-plan.json.corrupt", code: "EIO" }); // not passing: thrown at once
  let lines: string[];
  try { lines = warned(() => p.recover()).lines; } finally { renames.clear(); }
  assert.equal(renames.failed(), 1, "the rename aside was refused");
  assert.ok(lines.some((l) => l.includes("deploy-plan.json cannot be read") && l.includes("it could not be set aside") && l.includes("the next plan written replaces it")), `told: ${lines.join(" | ")}`);
  assert.equal(readFileSync(file, "utf8"), "{ \"plan\": ", "left in place as it was");
  assert.ok(!existsSync(`${file}.corrupt`));
  assert.equal(p.view(), null, "no plan");
  p.shutdown();
});

test("F13: a missing or readable deploy-plan.json is recovered without a warning and stays in place", () => {
  const dir = tempDir("nexus-plan-");
  const file = join(dir, "deploy-plan.json");
  assert.deepEqual(warned(() => planner(file).recover()).lines, [], "missing: no plan, no word");
  const plan = { protocol: 1, plan: { id: "p1", at: new Date(Date.now() + 3_600_000).toISOString(), created_at: now() } };
  writeFileSync(file, JSON.stringify(plan));
  const p = planner(file);
  assert.deepEqual(warned(() => p.recover()).lines, []);
  assert.equal(p.plan?.id, "p1");
  assert.equal(readPlanFile(file).plan?.id, "p1");
  assert.ok(!existsSync(`${file}.corrupt`));
  p.shutdown();
});

test("F13: a hand-over file unreadable at one read is read again silently; unreadable at the next read too, the log names it once", () => {
  const dir = join(tempDir("nexus-handover-"), "h");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "predecessor.json");
  writeFileSync(file, "{ \"pid\": ");
  const standby = new Standby(dir);
  const first = warned(() => standby.predecessor());
  assert.equal(first.value, undefined);
  assert.deepEqual(first.lines, [], "one read: perhaps a moment's state, read again at the next poll");
  const second = warned(() => standby.predecessor());
  assert.equal(second.value, undefined, "still as if not there");
  assert.equal(second.lines.length, 1, second.lines.join(" | "));
  assert.match(second.lines[0]!, /\/h\/predecessor\.json cannot be read .*two reads in a row/);
  assert.deepEqual(warned(() => standby.predecessor()).lines, [], "told once");
  writeFileSync(file, JSON.stringify({ pid: 1, commit: "abc", subject: "s", at: now() }));
  assert.equal(standby.predecessor()?.commit, "abc", "repaired, it reads");
  writeFileSync(file, "{ again");
  standby.predecessor();
  assert.equal(warned(() => standby.predecessor()).lines.length, 1, "a new lasting damage after a good read is told again");
});
