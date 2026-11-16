// Exercise the real Node adapter with isolated data and fake runtimes. Build the dashboard to include static checks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { spawnServer } from "./helpers.ts";
import { serverUp, WAIT_MS } from "./wait.ts";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "../../web/dist");
const proxy = { "x-forwarded-for": "192.0.2.10" };

test("the Node adapter preserves HTTP, static access control and WebSocket upgrades", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "nexus-http-adapter-"));
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => listener.close((err) => err ? reject(err) : resolve()));
  assert.ok(port >= 4318, "never use the live server's port");
  const child = spawnServer({ NEXUS_HOME: home, NEXUS_PORT: String(port), NEXUS_HOST: "127.0.0.1", NEXUS_LOG: "",
    NEXUS_CLAUDE: join(here, "fake-claude.ts"), NEXUS_CODEX: join(here, "fake-codex.ts") });
  const exited = once(child, "exit");
  const url = `http://127.0.0.1:${port}`;
  // node:http preserves malformed escapes and encoded dot segments instead of normalizing them in a URL client.
  const get = (path: string, headers: Record<string, string> = {}) => new Promise<{
    status: number; location?: string; type?: string; body: Buffer;
  }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("error", reject);
      res.on("end", () => resolve({ status: res.statusCode!, location: res.headers.location,
        type: res.headers["content-type"], body: Buffer.concat(chunks) }));
    });
    req.setTimeout(WAIT_MS, () => req.destroy(new Error(`HTTP timed out: ${path}`)));
    req.on("error", reject);
    req.end();
  });
  const connects = (path: string, headers: Record<string, string>) => new Promise<boolean>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers, handshakeTimeout: WAIT_MS });
    let opened = false;
    ws.on("open", () => { opened = true; ws.close(); });
    ws.on("error", () => { /* Rejected upgrades close the socket without an HTTP response. */ });
    ws.on("close", () => resolve(opened));
  });
  try {
    await serverUp(url + "/api/projects");
    assert.deepEqual(JSON.parse((await get("/api/projects")).body.toString()), []);
    const token = (JSON.parse(readFileSync(join(home, "auth.json"), "utf8")) as { token: string }).token;
    const signedIn = { ...proxy, cookie: `nexus_auth=${token}` };
    assert.equal((await get("/api/projects", proxy)).status, 401);
    assert.equal((await get("/api/projects", { ...proxy, cookie: "nexus_auth=wrong" })).status, 401);
    assert.equal((await get("/api/projects", signedIn)).status, 200);
    for (const path of ["/", "/index.html", "/%69ndex.html", "/%2569ndex.html", "/%%36%39ndex.html",
      "/assets/private.js", "/%61ssets/private.js", "/%2561ssets/private.js", "/%%36%31ssets/private.js",
      "/%61pi/projects", "/%2561pi/projects", "/%%36%31pi/projects", "/api/%70rojects",
      "/icons/%2e%2e/index.html"]) {
      const res = await get(path, proxy);
      assert.ok(res.status === 302 || res.status === 401, `unauthenticated ${path}: ${res.status}`);
      if (res.status === 302) assert.equal(res.location, "/login", path);
    }
    const login = await get("/login", proxy);
    assert.equal(login.status, 200);
    assert.match(login.body.toString(), /sign in/i);
    const loginResponse = await fetch(url + "/login", { method: "POST", headers: { ...proxy,
      "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token }), redirect: "manual" });
    assert.equal(loginResponse.status, 302);
    assert.equal(loginResponse.headers.get("location"), "/");
    assert.match(loginResponse.headers.get("set-cookie")!, /nexus_auth=.*HttpOnly; SameSite=Lax/);
    const write = (headers: Record<string, string>) => fetch(url + "/api/settings", {
      method: "PATCH", headers: { ...signedIn, ...headers }, body: "{}" });
    assert.equal((await write({ origin: url, "content-type": "text/plain" })).status, 415);
    assert.equal((await write({ origin: "https://example.invalid", "content-type": "application/json" })).status, 403);
    assert.equal((await write({ "content-type": "application/json" })).status, 403);
    assert.equal(await connects("/ws", {}), true);
    assert.equal(await connects("/ws", proxy), false);
    assert.equal(await connects("/ws", signedIn), true);
    assert.equal(await connects("/%77s", signedIn), false);

    await t.test("built dashboard assets, SPA fallback and public installation files", { skip: !existsSync(join(dist, "index.html")) }, async () => {
      const index = readFileSync(join(dist, "index.html"));
      for (const path of ["/", "/index.html", "/dashboard/deep-link"]) {
        const res = await get(path, signedIn);
        assert.equal(res.status, 200, path);
        assert.match(res.type!, /text\/html/);
        assert.deepEqual(res.body, index, path);
      }
      const asset = /src="(\/assets\/[^"]+\.js)"/.exec(index.toString())![1]!;
      const js = await get(asset, signedIn);
      assert.equal(js.status, 200);
      assert.match(js.type!, /javascript/);
      assert.deepEqual(js.body, readFileSync(join(dist, asset)));
      for (const path of [asset, asset.replace("/assets/", "/%61ssets/"), asset.replace("/assets/", "/%2561ssets/"),
        asset.replace("/assets/", "/%%36%31ssets/")]) {
        assert.equal((await get(path, proxy)).status, 302, path);
      }
      for (const path of ["/manifest.webmanifest", "/sw.js", "/icons/icon.svg", "/icons/icon-192.png", "/icons/icon-512.png", "/icons/apple-touch-icon.png"]) {
        const res = await get(path, proxy);
        assert.equal(res.status, 200, path);
        assert.deepEqual(res.body, readFileSync(join(dist, path)), path);
      }
      // Existing policy gap, reproduced with 1.19.19 too: an allowed /icons/ request that serves no file
      // falls through to the public SPA shell. Changing that policy needs the user's approval (DESIGN.md, DU1).
      for (const path of ["/icons/missing.png", "/icons/%252e%252e/index.html", "/icons/%%32%65%%32%65/index.html",
        `/icons/%252e%252e${asset}`]) {
        const res = await get(path, proxy);
        assert.equal(res.status, 200, path);
        assert.deepEqual(res.body, index, `only the existing SPA fallback, never the requested asset: ${path}`);
      }
    });
  } finally {
    child.kill();
    await exited;
  }
});
