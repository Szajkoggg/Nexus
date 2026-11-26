// A queue paused for long (queue IWS, attention-snoozes.ts): its waiting item comes after the deadline, not before;
// it goes when the run is resumed; Remind me puts it off by the deadline; 0 turns it off; only the pauses that wait for
// the user count. The time is moved by hand (the derivation takes it as an argument).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DAY_MS, ProjectStore, approveQueue, orchestratorOverview, loadProjectState, newId, nextPauseWarning, pauseCause, pausedAttention, pausedText,
  snoozeAttention, updateSettings, type RunFile,
} from "../src/index.ts";

const T0 = Date.parse("2026-11-20T10:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

function setup(run: Partial<RunFile> = {}) {
  const root = mkdtempSync(join(tmpdir(), "nexus-paused-"));
  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  store.writeQueue({
    protocol: 1, id: "AD", title: "Agent digest", revision: 1, status: "proposed", stop_conditions: [], checks: [],
    steps: [{ id: "AD1", title: "Collect", goal: "", acceptance: [] }, { id: "AD2", title: "Summarize", goal: "", acceptance: [] }],
    approvals: [], history: [],
  });
  approveQueue(store, "AD");
  const write = (r: Partial<RunFile>) => store.writeRun("AD", {
    protocol: 1, session: newId(), state: "paused", reason: "paused by the user", step: "AD1", started_at: iso(T0 - DAY_MS),
    updated_at: iso(T0), ended_at: iso(T0), revision: 1, ...r,
  });
  write(run);
  const queues = () => loadProjectState(store).queues;
  return { store, queues, write };
}

test("a paused queue comes up after the deadline, not before, and goes when it is resumed", () => {
  const x = setup();
  const at = (ms: number) => pausedAttention(x.queues(), 3, [], ms);
  assert.deepEqual(at(T0 + 3 * DAY_MS - 1), [], "before the deadline: nothing");
  const [item] = at(T0 + 3 * DAY_MS);
  assert.equal(item?.kind, "paused");
  assert.equal(item.queue, "AD");
  assert.equal(item.at, iso(T0 + 3 * DAY_MS), "its time is the moment it came due");
  assert.deepEqual(item.paused, { cause: "pause", since: iso(T0), key: `paused:AD:${iso(T0)}`, days: 3, title: "Agent digest", step: "AD1", step_title: "Collect", before: true });
  assert.equal(pausedText(item.paused!, T0 + 4 * DAY_MS), "paused by the user 4 days ago before step AD1; nothing runs until it is resumed");
  assert.equal(nextPauseWarning(x.queues(), 3, [], T0), T0 + 3 * DAY_MS, "the server's timer is set for the deadline");
  // Resumed: the run goes on, and the warning is gone.
  x.write({ state: "running", reason: undefined, ended_at: undefined, updated_at: iso(T0 + 4 * DAY_MS) });
  assert.deepEqual(at(T0 + 5 * DAY_MS), []);
  assert.equal(nextPauseWarning(x.queues(), 3, [], T0 + 5 * DAY_MS), undefined, "no timer");
});

test("the deadline is the project's setting, 3 days by default; 0 turns the warning off", () => {
  const x = setup({ ended_at: iso(Date.now() - 4 * DAY_MS), updated_at: iso(Date.now() - 4 * DAY_MS) });
  assert.equal(loadProjectState(x.store).project.defaults.paused_warning_days, 3);
  assert.deepEqual(loadProjectState(x.store).attention.filter((a) => a.kind === "paused").map((a) => a.queue), ["AD"], "the state derives it with the clock");
  assert.match(orchestratorOverview(loadProjectState(x.store)), /^Waiting for the user\n- paused AD: paused by the user 4 days ago before step AD1; nothing runs until it is resumed$/m, "nexus status lists it");
  updateSettings(x.store, { defaults: { paused_warning_days: 5 }, own: ["defaults.paused_warning_days"] });
  assert.equal(loadProjectState(x.store).attention.filter((a) => a.kind === "paused").length, 0, "5 days: not yet");
  updateSettings(x.store, { defaults: { paused_warning_days: 0 }, own: ["defaults.paused_warning_days"] });
  assert.equal(loadProjectState(x.store).attention.filter((a) => a.kind === "paused").length, 0, "0: never");
  assert.deepEqual(pausedAttention(x.queues(), 0, [], Date.now() + 100 * DAY_MS), []);
});

test("Remind me puts the warning off by the deadline; a new pause of the queue starts afresh", () => {
  const x = setup({ ended_at: iso(Date.now() - 4 * DAY_MS), updated_at: iso(Date.now() - 4 * DAY_MS) });
  const state = loadProjectState(x.store);
  const key = state.attention.find((a) => a.kind === "paused")!.paused!.key;
  const now = Date.now();
  const until = snoozeAttention(x.store, state, key, now);
  assert.equal(until, iso(now + 3 * DAY_MS));
  const snoozes = x.store.readAttentionSnoozes().items;
  assert.deepEqual(snoozes.map((s) => [s.key, s.until]), [[key, until]]);
  assert.equal(loadProjectState(x.store).attention.filter((a) => a.kind === "paused").length, 0, "put off");
  assert.deepEqual(pausedAttention(x.queues(), 3, snoozes, now + 3 * DAY_MS - 1), [], "still put off");
  assert.equal(pausedAttention(x.queues(), 3, snoozes, now + 3 * DAY_MS)[0]?.at, until, "back when the put-off ends, at the top");
  assert.equal(nextPauseWarning(x.queues(), 3, snoozes, now), now + 3 * DAY_MS);
  // A new pause has its own key: the old put-off does not hold it.
  x.write({ ended_at: iso(now - 10 * DAY_MS), updated_at: iso(now - 10 * DAY_MS) });
  assert.equal(pausedAttention(x.queues(), 3, snoozes, now).length, 1);
  assert.throws(() => snoozeAttention(x.store, loadProjectState(x.store), "paused:AD:gone", now), /nothing waits/);
});

test("only the pauses that wait for the user count", () => {
  const counts = (r: Partial<RunFile>) => pauseCause({ state: "paused", ...r });
  assert.equal(counts({ reason: "paused by the user" }), "pause");
  assert.equal(counts({ reason: "paused by the user; the last turn failed (overloaded)" }), "pause");
  assert.equal(counts({ reason: "stopped by the user" }), "stop");
  assert.equal(counts({ reason: "stopped at once by the user; uncommitted changes kept" }), "stop_now");
  assert.equal(counts({ reason: "the Nexus server restarted; resume to continue" }), "restart");
  assert.equal(counts({ reason: "step AD1 was rejected by the user", rejected: "AD1" }), undefined, "a rejection has its review item");
  assert.equal(counts({ reason: "resuming after the Nexus update", resume_after_restart: true }), undefined, "goes on by itself");
  assert.equal(counts({ reason: "held at the end of step AD1: it waits for its turn to integrate", resume_after_restart: true }), undefined, "the merge train");
  assert.equal(pauseCause({ state: "usage_wait", reason: "paused by the user" }), undefined, "only a paused run");
  const x = setup({ reason: "stopped by the user", step: "AD1" });
  x.write({ reason: "stopped by the user" });
  const [item] = pausedAttention(x.queues(), 3, [], T0 + 3 * DAY_MS);
  assert.equal(item?.paused?.cause, "stop");
});
