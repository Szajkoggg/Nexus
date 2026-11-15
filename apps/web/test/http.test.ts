import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { HttpError, open, request } from "../src/http.ts";

const real = globalThis.fetch;
afterEach(() => { globalThis.fetch = real; });

/** Answers every request with `reply` and records what was asked. */
function serve(reply: () => Response) {
  const asked: { url: string; init: RequestInit | undefined }[] = [];
  globalThis.fetch = (url: string | URL | Request, init?: RequestInit) => { asked.push({ url: String(url), init }); return Promise.resolve(reply()); };
  return asked;
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, statusText: status === 200 ? "OK" : "Conflict", headers: { "content-type": "application/json" } });

test("a GET resolves with the reply's JSON and sends no body", async () => {
  const asked = serve(() => json({ lines: [3, 7] }));
  assert.deepEqual(await request<{ lines: number[] }>("/api/x"), { lines: [3, 7] });
  assert.equal(asked[0]!.init?.method, "GET");
  assert.equal(asked[0]!.init?.body, undefined);
});

test("a refusal rejects with the server's reason and status, never as an answer", async () => {
  serve(() => json({ error: "the queue is not stopped" }, 409));
  await assert.rejects(request("/api/x"), (e) => e instanceof HttpError && e.status === 409 && e.message === "the queue is not stopped");
});

test("a refusal without a JSON body rejects with the status text", async () => {
  serve(() => new Response("<html>", { status: 502, statusText: "Bad Gateway" }));
  await assert.rejects(request("/api/x"), (e) => e instanceof HttpError && e.status === 502 && e.message === "Bad Gateway");
});

test("a write sends JSON, {} when no body is given", async () => {
  const asked = serve(() => json({ result: { id: "c1" } }));
  await request("/api/x", { method: "POST" });
  await request("/api/x", { method: "PATCH", body: { a: 1 } });
  assert.equal(asked[0]!.init?.body, "{}");
  assert.equal(asked[1]!.init?.body, '{"a":1}');
  assert.deepEqual(asked[1]!.init?.headers, { "content-type": "application/json" });
});

test("a success without a body resolves undefined", async () => {
  serve(() => new Response(null, { status: 200 }));
  assert.equal(await request("/api/x", { method: "POST" }), undefined);
});

test("open hands back the response of a success and rejects a refusal", async () => {
  serve(() => new Response("text", { status: 200, headers: { "x-nexus-kind": "text" } }));
  assert.equal((await open("/api/file")).headers.get("x-nexus-kind"), "text");
  serve(() => json({ error: "no such file" }, 404));
  await assert.rejects(open("/api/file"), (e) => e instanceof HttpError && e.status === 404 && e.message === "no such file");
});

test("reason is the server's own only", async () => {
  serve(() => json({ error: "push is off" }, 409));
  await assert.rejects(request("/api/x"), (e) => e instanceof HttpError && e.reason === "push is off");
  serve(() => new Response("", { status: 500, statusText: "Internal Server Error" }));
  await assert.rejects(request("/api/x"), (e) => e instanceof HttpError && e.reason === undefined && e.message === "Internal Server Error");
});
