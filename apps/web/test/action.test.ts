import { test } from "node:test";
import assert from "node:assert/strict";
import { Action, type ActionState } from "../src/action.ts";

/** A promise the test settles by hand. */
function later<T>() {
  let resolve!: (v: T) => void, reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function setup() {
  const seen: ActionState[] = [];
  return { a: new Action((s) => seen.push(s)), seen };
}

test("busy while the work runs; a success clears busy, keeps no error and hands its result to done", async () => {
  const { a, seen } = setup();
  const w = later<{ message: string }>();
  let got: string | undefined;
  const run = a.run(() => w.promise, (r) => { got = r.message; });
  assert.deepEqual(a.current, { busy: true, error: undefined });
  w.resolve({ message: "merged" });
  assert.equal(await run, true);
  assert.deepEqual(a.current, { busy: false, error: undefined });
  assert.equal(got, "merged");
  assert.deepEqual(seen, [{ busy: true, error: undefined }, { busy: false, error: undefined }]);
});

test("a failure is the error, busy ends, done is not called, and run resolves false instead of rejecting", async () => {
  const { a } = setup();
  let called = false;
  const ok = await a.run(() => Promise.reject(new Error("the queue is not stopped")), () => { called = true; });
  assert.equal(ok, false);
  assert.deepEqual(a.current, { busy: false, error: "the queue is not stopped" });
  assert.equal(called, false);
});

test("a thrown non-Error is shown as text", async () => {
  const { a } = setup();
  await a.run(() => { throw "offline"; });
  assert.equal(a.current.error, "offline");
});

test("the next run clears the last error when it starts", async () => {
  const { a } = setup();
  await a.run(() => Promise.reject(new Error("first")));
  const w = later<void>();
  const run = a.run(() => w.promise);
  assert.deepEqual(a.current, { busy: true, error: undefined });
  w.resolve();
  await run;
  assert.deepEqual(a.current, { busy: false, error: undefined });
});

test("two runs at once: busy until both have settled", async () => {
  const { a } = setup();
  const one = later<void>(), two = later<void>();
  const r1 = a.run(() => one.promise);
  const r2 = a.run(() => two.promise);
  one.resolve(); await r1;
  assert.equal(a.current.busy, true);
  two.reject(new Error("second failed")); await r2;
  assert.deepEqual(a.current, { busy: false, error: "second failed" });
});

test("fail shows a failure found before any request, and clears it", () => {
  const { a, seen } = setup();
  a.fail("type a name first");
  assert.deepEqual(a.current, { busy: false, error: "type a name first" });
  a.fail(undefined);
  assert.deepEqual(a.current, { busy: false, error: undefined });
  a.fail(undefined);
  assert.equal(seen.length, 2, "no change, no render");
});
