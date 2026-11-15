import { test } from "node:test";
import assert from "node:assert/strict";
import { Query, Requests, bump, noVersions, projectVersion, type Versions } from "../src/query.ts";

/** A fetcher whose answers the test hands out by hand, in any order. */
function manual() {
  const calls: { url: string; resolve: (d: unknown) => void; reject: (e: Error) => void }[] = [];
  const fetcher = (url: string) => new Promise<unknown>((resolve, reject) => { calls.push({ url, resolve, reject }); });
  return { calls, fetcher };
}

const settled = () => new Promise<void>((r) => setImmediate(r));

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
  assert.deepEqual(changed, { all: 1, list: 1, epoch: 0, project: { A: 1 } });
  assert.deepEqual(bump(changed, { type: "projects" }), { all: 2, list: 2, epoch: 0, project: { A: 1 } });
  assert.deepEqual(bump(changed, { type: "server" }), { all: 2, list: 1, epoch: 0, project: { A: 1 } });
  const again = bump(changed, { type: "reconnected" });
  assert.deepEqual(again, { all: 2, list: 2, epoch: 1, project: { A: 1 } });
  // A reconnect may have missed any project's change: every project's version moves.
  assert.notEqual(projectVersion(again, "B"), projectVersion(changed, "B"));
  assert.notEqual(projectVersion(again, "A"), projectVersion(changed, "A"));
  assert.equal(projectVersion(changed, "B"), projectVersion(v0, "B"));
});
