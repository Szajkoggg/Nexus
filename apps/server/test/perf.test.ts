// The server's measurements of itself (src/perf.ts): a deliberately blocking operation shows up in the block log with
// its name (and its parents'), a block in unmeasured code is logged as such, and requests are counted by their route
// with the synchronous part of a blocking handler named by its route.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { Hono } from "hono";
import { Perf, gitLabel } from "../src/perf.ts";

const busy = (ms: number) => { const end = Date.now() + ms; while (Date.now() < end) { /* blocking on purpose */ } };

function started() {
  const lines: string[] = [];
  const perf = new Perf({ log: (l) => lines.push(l) });
  perf.start();
  return { perf, lines };
}

test("a deliberately blocking operation appears in the block log with what ran", async (t) => {
  const { perf, lines } = started();
  t.after(() => perf.stop());
  perf.measure("outer", () => { perf.measure("tiny", () => busy(2)); perf.measure("deliberate block", () => busy(300)); });
  await sleep(150); // the ticker fires late once the loop is free again
  const block = perf.view().blocks.find((b) => b.during.some((s) => s.what === "outer > deliberate block"));
  assert.ok(block, `no block names the operation: ${JSON.stringify(perf.view().blocks)}`);
  assert.ok(block.ms >= 200, `blocked ${block.ms} ms`);
  // The longest first: the outer span (which holds it) and the block itself before the tiny one.
  assert.deepEqual(block.during.slice(0, 2).map((s) => s.what), ["outer", "outer > deliberate block"]);
  assert.ok(lines.some((l) => /^perf: event loop blocked \d+ ms \(outer \d+ ms; outer > deliberate block \d+ ms/.test(l)), lines.join("\n"));
  const span = perf.view().spans.find((s) => s.what === "outer > deliberate block");
  assert.equal(span?.count, 1);
  assert.ok(span.max_ms >= 290);
});

test("a block in code nothing measures is logged as such", async (t) => {
  const { perf, lines } = started();
  t.after(() => perf.stop());
  busy(300);
  await sleep(150);
  assert.ok(lines.some((l) => /^perf: event loop blocked \d+ ms \(nothing measured\)$/.test(l)), lines.join("\n"));
});

test("requests are timed by route; a blocking handler is named by its route", async (t) => {
  const { perf, lines } = started();
  t.after(() => perf.stop());
  const app = new Hono();
  app.use("*", perf.middleware);
  app.get("/api/things/:id", (c) => { if (c.req.param("id") === "slow") busy(250); return c.json({ id: c.req.param("id") }); });
  app.get("/api/missing", (c) => c.json({ error: "no" }, 404));
  for (const id of ["a", "b", "slow"]) assert.equal((await app.request(`/api/things/${id}`)).status, 200);
  assert.equal((await app.request("/api/missing")).status, 404);
  await sleep(150);
  const view = perf.view();
  const things = view.routes.find((r) => r.route === "GET /api/things/:id");
  assert.equal(things?.count, 3);
  assert.equal(things.slow, 1);
  assert.deepEqual(things.statuses, { 200: 3 });
  assert.ok(things.sync_max_ms >= 240, `synchronous part ${things.sync_max_ms} ms`);
  assert.deepEqual(view.routes.find((r) => r.route === "GET /api/missing")?.statuses, { 404: 1 });
  assert.ok(view.blocks.some((b) => b.during.some((s) => s.what === "GET /api/things/:id")), JSON.stringify(view.blocks));
  assert.ok(lines.some((l) => /^perf: slow request GET \/api\/things\/:id 200 \d+ ms \(synchronous \d+ ms\)$/.test(l)), lines.join("\n"));
  // The summary names the request time and starts a new window.
  assert.match(perf.summary(), /most request time: GET \/api\/things\/:id 3x/);
});

test("a git call is labelled by its subcommand", () => {
  assert.equal(gitLabel(["--no-optional-locks", "status", "--porcelain=v1"]), "git status");
  assert.equal(gitLabel(["rev-list", "--count", "a..b"]), "git rev-list");
});
