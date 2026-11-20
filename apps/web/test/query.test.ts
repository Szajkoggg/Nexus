import { test } from "node:test";
import assert from "node:assert/strict";
import { Action, type ActionState } from "../src/action.ts";
import { Query, Reloads, Requests, bump, logsVersion, noVersions, projectVersion, type Versions } from "../src/query.ts";

/** A fetcher whose answers the test hands out by hand, in any order. */
function manual() {
  const calls: { url: string; resolve: (d: unknown) => void; reject: (e: Error) => void }[] = [];
  const fetcher = (url: string) => new Promise<unknown>((resolve, reject) => { calls.push({ url, resolve, reject }); });
  return { calls, fetcher };
}

const settled = () => new Promise<void>((r) => setImmediate(r));

/** A promise the test settles by hand. */
function later<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

function setup() {
  const m = manual();
  const requests = new Requests(m.fetcher);
  let changes = 0;
  const q = new Query<string>(requests, () => { changes++; });
  return { ...m, requests, q, changes: () => changes };
}

test("a new URL shows nothing of the old one's answer, even before its own lands", async () => {
  const { calls, q } = setup();
  q.ask("/a", 1);
  calls[0]!.resolve("commits of A");
  await settled();
  assert.equal(q.view("/a").data, "commits of A");
  // The render that switches to /b reads the view before its effect asks anything.
  assert.equal(q.view("/b").data, undefined);
  q.stop(); q.ask("/b", 1);
  assert.equal(q.view("/b").data, undefined);
  assert.equal(q.view("/a").data, undefined, "the old answer is let go");
});

test("a late answer for the previous URL is dropped", async () => {
  const { calls, q } = setup();
  q.ask("/a", 1);
  q.stop(); q.ask("/b", 1);
  calls[1]!.resolve("B");
  await settled();
  calls[0]!.resolve("A, late");
  await settled();
  assert.equal(q.view("/b").data, "B");
  assert.equal(q.view("/a").data, undefined);
});

test("a late answer for the previous URL is dropped also while the new one is on its way", async () => {
  const { calls, q, changes } = setup();
  q.ask("/a", 1);
  q.stop(); q.ask("/b", 1);
  calls[0]!.resolve("A, late");
  await settled();
  assert.equal(q.view("/b").data, undefined);
  assert.equal(changes(), 0, "nothing to show, no render");
});

test("an older answer for the same URL does not overwrite a newer one", async () => {
  const { calls, q } = setup();
  q.ask("/a", 1);
  q.stop(); q.ask("/a", 2);
  calls[1]!.resolve("new");
  await settled();
  calls[0]!.resolve("old");
  await settled();
  assert.equal(q.view("/a").data, "new");
});

test("an answer for the same URL at an older version still lands when nothing newer has", async () => {
  const { calls, q } = setup();
  q.ask("/a", 1);
  q.stop(); q.ask("/a", 2);
  calls[0]!.resolve("v1");
  await settled();
  assert.equal(q.view("/a").data, "v1");
});

test("a failure is the view's error, not swallowed; the data of the same URL stays until an answer clears it", async () => {
  const { calls, q } = setup();
  q.ask("/a", 1);
  calls[0]!.reject(new Error("500 disk full"));
  await settled();
  assert.deepEqual(q.view("/a"), { data: undefined, error: "500 disk full" });
  q.stop(); q.ask("/a", 2);
  calls[1]!.resolve("A");
  await settled();
  assert.deepEqual(q.view("/a"), { data: "A", error: undefined });
  q.stop(); q.ask("/a", 3);
  calls[2]!.reject(new Error("502 gone"));
  await settled();
  assert.deepEqual(q.view("/a"), { data: "A", error: "502 gone" });
  assert.equal(q.view("/b").error, undefined, "another URL shows no error of this one");
});

test("the same URL and version asks nothing again; no URL asks nothing", () => {
  const { calls, q } = setup();
  q.ask("/a", 1);
  q.ask("/a", 1);
  q.ask(undefined, 1);
  assert.equal(calls.length, 1);
});

test("queries asking the same URL at the same version share one request", async () => {
  const { calls, requests } = setup();
  const a = new Query<string>(requests, () => {});
  const b = new Query<string>(requests, () => {});
  a.ask("/state", "0.1");
  b.ask("/state", "0.1");
  assert.equal(calls.length, 1);
  calls[0]!.resolve("S");
  await settled();
  assert.equal(a.view("/state").data, "S");
  assert.equal(b.view("/state").data, "S");
  // Once answered, a later ask is a new request (nothing is cached).
  a.stop(); a.ask("/state", "0.1");
  assert.equal(calls.length, 2);
});

test("a stopped and re-asked query (React's double effect) joins the request in flight", async () => {
  const { calls, q } = setup();
  q.ask("/a", 1); q.stop(); q.ask("/a", 1);
  assert.equal(calls.length, 1);
  calls[0]!.resolve("A");
  await settled();
  assert.equal(q.view("/a").data, "A");
});

test("a stopped query takes no answer", async () => {
  const { calls, q, changes } = setup();
  q.ask("/a", 1); q.stop();
  calls[0]!.resolve("A");
  await settled();
  assert.equal(changes(), 0);
});

test("a change in another project leaves this project's version alone, so its reads ask nothing", () => {
  const { calls, q } = setup();
  let v: Versions = bump(noVersions, { type: "changed", project: "A" });
  q.ask("/api/projects/A/orchestrator", projectVersion(v, "A"));
  v = bump(v, { type: "changed", project: "B" });
  v = bump(v, { type: "server" });
  v = bump(v, { type: "projects" });
  q.ask("/api/projects/A/orchestrator", projectVersion(v, "A"));
  assert.equal(calls.length, 1);
  v = bump(v, { type: "changed", project: "A" });
  q.ask("/api/projects/A/orchestrator", projectVersion(v, "A"));
  assert.equal(calls.length, 2);
});

test("what each message bumps", () => {
  const v0 = noVersions;
  const changed = bump(v0, { type: "changed", project: "A" });
  assert.deepEqual(changed, { all: 1, list: 1, epoch: 0, project: { A: 1 }, logs: {} });
  assert.deepEqual(bump(changed, { type: "projects" }), { all: 2, list: 2, epoch: 0, project: { A: 1 }, logs: {} });
  assert.deepEqual(bump(changed, { type: "server" }), { all: 2, list: 1, epoch: 0, project: { A: 1 }, logs: {} });
  const again = bump(changed, { type: "reconnected" });
  assert.deepEqual(again, { all: 2, list: 2, epoch: 1, project: { A: 1 }, logs: {} });
  // A reconnect may have missed any project's change: every project's version moves.
  assert.notEqual(projectVersion(again, "B"), projectVersion(changed, "B"));
  assert.notEqual(projectVersion(again, "A"), projectVersion(changed, "A"));
  assert.equal(projectVersion(changed, "B"), projectVersion(v0, "B"));
});

// ---------------------------------------------------------------- a write's outcome (Reloads)

test("settled waits for every request in flight, after the queries have taken their answers", async () => {
  const { calls, requests, q } = setup();
  q.ask("/a", 1);
  let done = false;
  void requests.settled().then(() => { done = true; assert.equal(q.view("/a").data, "a"); });
  await settled();
  assert.equal(done, false);
  calls[0]!.resolve("a");
  await settled();
  assert.equal(done, true);
});

/**
 * A control on a page: a query of the state it shows and an action that writes and then waits for the reads asked
 * after the write (what App and page.ts do with `reloaded`). Each step records what the control shows: busy and value.
 */
function page() {
  const m = manual();
  const requests = new Requests(m.fetcher);
  const reloads = new Reloads(requests, 60_000);
  let version = 1;
  const shown: string[] = [];
  let state: ActionState = { busy: false, error: undefined };
  const q: Query<string> = new Query<string>(requests, () => record());
  const record = () => shown.push(`${state.busy ? "busy" : "idle"} ${q.view("/state").data ?? "-"}`);
  const action = new Action((s) => { state = s; record(); });
  // The page's reload: the version moves, the page asks again at it, then tells Reloads it has asked.
  const reloaded = () => {
    const landed = reloads.next();
    version++;
    q.ask("/state", version);
    reloads.asked();
    return landed;
  };
  q.ask("/state", version);
  return { ...m, q, action, reloaded, shown, ask: (v: number) => { version = v; q.ask("/state", v); } };
}

test("a control is in progress until the state after its write has landed, never idle on the old state", async () => {
  const p = page();
  p.calls[0]!.resolve("level 2");
  await settled();
  const write = later<void>();
  const run = p.action.run(async () => { await write.promise; await p.reloaded(); });
  await settled();
  write.resolve();
  await settled();
  // The write is done, the read after it is on its way: still in progress, showing what was there.
  assert.equal(p.calls.length, 2);
  assert.deepEqual(p.shown.at(-1), "busy level 2");
  p.calls[1]!.resolve("level 3");
  assert.equal(await run, true);
  assert.deepEqual(p.shown, ["idle level 2", "busy level 2", "busy level 3", "idle level 3"]);
});

test("an answer asked before the write that lands after the one asked after it does not bring the old state back", async () => {
  const p = page();
  p.calls[0]!.resolve("level 2");
  await settled();
  // A live message moved the version just before the write: its read is on its way when the write is done.
  p.ask(2);
  const run = p.action.run(() => p.reloaded());
  p.calls[2]!.resolve("level 3");
  await settled();
  p.calls[1]!.resolve("level 2");
  assert.equal(await run, true);
  await settled();
  assert.equal(p.q.view("/state").data, "level 3");
  assert.ok(!p.shown.slice(p.shown.indexOf("busy level 3")).some((s) => s.endsWith("level 2")), p.shown.join(", "));
});

test("a failed read ends the wait too: the control is not held, and the read's error is the query's", async () => {
  const p = page();
  p.calls[0]!.resolve("level 2");
  await settled();
  const run = p.action.run(() => p.reloaded());
  p.calls[1]!.reject(new Error("503 Nexus is starting"));
  assert.equal(await run, true);
  assert.equal(p.q.view("/state").error, "503 Nexus is starting");
});

test("a read that hangs holds a control no longer than the limit; so does a page that never says it has asked", async () => {
  const m = manual();
  const requests = new Requests(m.fetcher);
  const reloads = new Reloads(requests, 20);
  const q = new Query<string>(requests, () => {});
  const hanging = reloads.next();
  q.ask("/state", 1);
  reloads.asked();
  const unasked = reloads.next();
  const t = Date.now();
  await Promise.all([hanging, unasked]);
  assert.ok(Date.now() - t < 1000);
});

test("a wait taken after the page has asked waits for the next asking, not for what was in flight before", async () => {
  const m = manual();
  const requests = new Requests(m.fetcher);
  const reloads = new Reloads(requests, 60_000);
  const q = new Query<string>(requests, () => {});
  q.ask("/state", 1);
  reloads.asked();
  let landed = false;
  void reloads.next().then(() => { landed = true; });
  m.calls[0]!.resolve("before");
  await settled();
  assert.equal(landed, false);
  q.ask("/state", 2);
  reloads.asked();
  m.calls[1]!.resolve("after");
  await settled();
  assert.equal(landed, true);
});

test("a control waits only for the reads it shows, not for a slow read of something else", async () => {
  const m = manual();
  const requests = new Requests(m.fetcher);
  const reloads = new Reloads(requests, 60_000);
  const state = new Query<string>(requests, () => {});
  const server = new Query<string>(requests, () => {});
  let landed = false;
  void reloads.next(["/state"]).then(() => { landed = true; });
  state.ask("/state", 2);
  server.ask("/server", 2);
  reloads.asked();
  m.calls[0]!.resolve("level 3");
  await settled();
  assert.equal(landed, true);
  assert.equal(state.view("/state").data, "level 3");
});

test("a log line moves only its project's logs: the state and what spans projects are not asked again", () => {
  const changed = bump(noVersions, { type: "changed", project: "A" });
  const logged = bump(changed, { type: "log", project: "A", session: "s1" });
  assert.deepEqual(logged, { all: 1, list: 1, epoch: 0, project: { A: 1 }, logs: { A: 1 } });
  assert.equal(projectVersion(logged, "A"), projectVersion(changed, "A"));
  assert.notEqual(logsVersion(logged, "A"), logsVersion(changed, "A"));
  assert.equal(logsVersion(logged, "B"), logsVersion(changed, "B"));
  // A change of the project moves its logs' version too (a chat's view shows the state's parts as well).
  assert.notEqual(logsVersion(bump(logged, { type: "changed", project: "A" }), "A"), logsVersion(logged, "A"));
});
