// Pictures for chat messages: the upload endpoint (a real server process on a free port) and the type check and naming
// behind it. The body's size is refused before anything is parsed; the type is judged from the bytes; the endpoint is
// a write like every other, so only the dashboard's own page on this machine, or a device with the token, may use it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectStore, writeRegistry } from "@nexus/protocol";
import { spawnServer } from "./helpers.ts";
import { MAX_UPLOAD_BODY, MAX_UPLOAD_BYTES, imageType, uploadName } from "../src/uploads.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise<number>((resolve) => {
  const s = createServer();
  s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); });
});

/** A 1×1 PNG. */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

test("the type comes from the bytes: PNG, JPEG, WebP and GIF only", () => {
  assert.equal(imageType(PNG), "png");
  assert.equal(imageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10])), "jpeg");
  assert.equal(imageType(Buffer.from("RIFF\x10\x00\x00\x00WEBPVP8 ", "latin1")), "webp");
  assert.equal(imageType(Buffer.from("GIF89a\x01\x00", "latin1")), "gif");
  assert.equal(imageType(Buffer.from("GIF87a\x01\x00", "latin1")), "gif");
  assert.equal(imageType(Buffer.from("\x00\x00\x00\x18ftypheic", "latin1")), undefined, "an iPhone HEIC photo");
  assert.equal(imageType(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>")), undefined, "SVG is not taken");
  assert.equal(imageType(Buffer.from("RIFF\x10\x00\x00\x00WAVEfmt ", "latin1")), undefined, "a RIFF that is not WebP");
  assert.equal(imageType(Buffer.from([0x89, 0x50])), undefined, "too short");
});

test("the name is the time (UTC) and a short hash, with the detected type's extension", () => {
  const at = new Date("2026-11-14T15:30:12.345Z");
  assert.match(uploadName(PNG, "png", at), /^20261114-153012-[0-9a-f]{10}\.png$/);
  assert.match(uploadName(PNG, "jpeg", at), /\.jpg$/);
  assert.equal(uploadName(PNG, "png", at), uploadName(PNG, "png", at), "the same bytes, the same name");
  assert.notEqual(uploadName(PNG, "png", at), uploadName(Buffer.concat([PNG, Buffer.from([0])]), "png", at));
  assert.ok(MAX_UPLOAD_BODY > Math.ceil(MAX_UPLOAD_BYTES / 3) * 4 + 100, "the body limit leaves room for 10 MB of base64");
});

test("the upload endpoint saves a picture under .nexus/uploads/ and refuses what it must, before parsing when too big", async () => {
  const base = mkdtempSync(join(tmpdir(), "nexus-uploads-"));
  process.env.NEXUS_HOME = join(base, "home");
  const root = join(base, "project");
  mkdirSync(root, { recursive: true });
  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  writeRegistry({ protocol: 1, projects: [{ id: "p", root }] });
  const port = await freePort();
  const child = spawnServer({ NEXUS_PORT: String(port), NEXUS_LOG: "" });
  const url = `http://127.0.0.1:${port}`;
  const page = { origin: url, "sec-fetch-site": "same-origin", "content-type": "application/json" };
  const upload = (body: BodyInit, headers: Record<string, string> = page, project = "p") =>
    fetch(`${url}/api/projects/${project}/uploads`, { method: "POST", headers, body, duplex: "half" } as RequestInit);
  const uploads = join(store.dir, "uploads");
  const saved = () => (existsSync(uploads) ? readdirSync(uploads) : []);
  try {
    for (let i = 0; i < 100; i++) { try { if ((await fetch(url + "/api/projects")).ok) break; } catch { /* not up yet */ } await sleep(100); }

    // A valid picture, as a data: URL whose declared type the server ignores.
    let res = await upload(JSON.stringify({ data: `data:image/gif;base64,${PNG.toString("base64")}`, name: "..\\..\\evil.exe" }));
    assert.equal(res.status, 200, await res.clone().text());
    const { result } = (await res.json()) as { result: { path: string; type: string; bytes: number } };
    assert.equal(result.type, "png");
    assert.equal(result.bytes, PNG.length);
    assert.equal(result.path, join(uploads, result.path.split("/").pop()!).replaceAll("\\", "/"), "an absolute path under .nexus/uploads/");
    assert.match(result.path, /\/uploads\/\d{8}-\d{6}-[0-9a-f]{10}\.png$/, "named by the server, not by the client");
    assert.deepEqual(readFileSync(result.path), PNG);
    // Plain base64 is taken too; the file endpoint serves the saved picture back to the dashboard.
    res = await upload(JSON.stringify({ data: PNG.toString("base64") }));
    assert.equal(res.status, 200);
    const back = await fetch(`${url}/api/projects/p/file?path=${encodeURIComponent(result.path)}`);
    assert.equal(back.headers.get("content-type"), "image/png");
    assert.deepEqual(Buffer.from(await back.arrayBuffer()), PNG);
    const before = saved().length;

    // Too big a body: refused from its Content-Length, before parsing (a body that is not even JSON gets 413, not 400).
    const huge = "x".repeat(MAX_UPLOAD_BODY + 1);
    res = await upload(huge);
    assert.equal(res.status, 413, "an oversized body with a Content-Length");
    assert.match(((await res.json()) as { error: string }).error, /up to 10 MB/);
    // And without a Content-Length (streamed in chunks), cut off once the limit is passed: the server answers while the
    // client is still sending (node:http, which reads the answer before the body is all written, unlike fetch).
    const streamed = await new Promise<number>((resolve, reject) => {
      const req = request(`${url}/api/projects/p/uploads`, { method: "POST", headers: page });
      const chunk = Buffer.alloc(1024 * 1024, 0x78);
      let sent = 0;
      let answered = false;
      req.on("response", (r) => { answered = true; r.resume(); resolve(r.statusCode ?? 0); });
      req.on("error", (err) => { if (!answered) reject(err); }); // writing on after the answer may fail: expected
      const more = () => {
        while (!answered && sent <= MAX_UPLOAD_BODY + chunk.length) { sent += chunk.length; if (!req.write(chunk)) return void req.once("drain", more); }
        req.end();
      };
      more();
    });
    assert.equal(streamed, 413, "an oversized streamed body");
    // A picture over 10 MB in a body under the limit: refused once decoded.
    const big = Buffer.concat([PNG, Buffer.alloc(MAX_UPLOAD_BYTES)]);
    assert.ok(big.toString("base64").length < MAX_UPLOAD_BODY - 100);
    res = await upload(JSON.stringify({ data: big.toString("base64") }));
    assert.equal(res.status, 413, "a picture over 10 MB");

    // The wrong type, judged from the bytes whatever the client declares.
    res = await upload(JSON.stringify({ data: `data:image/png;base64,${Buffer.from("\x00\x00\x00\x18ftypheic....", "latin1").toString("base64")}` }));
    assert.equal(res.status, 415, "HEIC");
    assert.match(((await res.json()) as { error: string }).error, /only PNG, JPEG, WebP or GIF up to 10 MB/);
    res = await upload(JSON.stringify({ data: Buffer.from("<svg/>").toString("base64") }));
    assert.equal(res.status, 415, "SVG");
    res = await upload(JSON.stringify({ data: "not base64!" }));
    assert.equal(res.status, 400);
    res = await upload(JSON.stringify({}));
    assert.equal(res.status, 400, "no data");
    res = await upload(JSON.stringify({ data: PNG.toString("base64") }), page, "nope");
    assert.equal(res.status, 404, "unknown project");

    // A write like every other: not from elsewhere without the token, not without the page's Origin, JSON only.
    const json = JSON.stringify({ data: PNG.toString("base64") });
    res = await upload(json, { ...page, "x-forwarded-for": "100.64.0.7" });
    assert.equal(res.status, 401, "a remote write without the token");
    res = await upload(json, { "content-type": "application/json" });
    assert.equal(res.status, 403, "no Origin (an agent's script, a curl)");
    res = await upload(json, { ...page, origin: "http://evil.example" });
    assert.equal(res.status, 403, "a foreign Origin");
    res = await upload(json, { ...page, "sec-fetch-site": "cross-site" });
    assert.equal(res.status, 403, "not from the page itself");
    res = await upload(json, { ...page, "content-type": "text/plain" });
    assert.equal(res.status, 415, "not JSON");
    const form = new FormData();
    form.append("file", new Blob([PNG], { type: "image/png" }), "a.png");
    res = await fetch(`${url}/api/projects/p/uploads`, { method: "POST", headers: { origin: url, "sec-fetch-site": "same-origin" }, body: form });
    assert.equal(res.status, 415, "a multipart form");

    assert.equal(saved().length, before, "nothing refused was saved");
    assert.ok(!saved().some((f) => f.endsWith(".tmp")), "no half-written file left");
  } finally {
    child.kill();
  }
});
