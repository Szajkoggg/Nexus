// Who may use the dashboard from where, and which news is pushed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage } from "node:http";
import type { AttentionItem } from "@nexus/protocol";

process.env.NEXUS_HOME = mkdtempSync(join(tmpdir(), "nexus-remote-"));
const remote = await import("../src/remote.ts");

const req = (address: string, headers: Record<string, string> = {}) =>
  ({ socket: { remoteAddress: address }, headers } as unknown as IncomingMessage);

test("this machine needs nothing; anything relayed or from elsewhere needs the token", () => {
  assert.equal(remote.allowed(req("127.0.0.1")), true);
  assert.equal(remote.allowed(req("::1")), true);
  assert.equal(remote.allowed(req("127.0.0.1", { "x-forwarded-for": "100.64.0.7" })), false, "relayed by a proxy");
  assert.equal(remote.allowed(req("127.0.0.1", { "tailscale-user-login": "someone" })), false, "relayed by Tailscale Serve");
  assert.equal(remote.allowed(req("192.168.1.20")), false);
  const token = remote.auth().token;
  assert.equal(remote.allowed(req("192.168.1.20", { cookie: `a=b; nexus_auth=${encodeURIComponent(token)}` })), true);
  assert.equal(remote.allowed(req("192.168.1.20", { cookie: "nexus_auth=wrong" })), false);
});

test("replacing the token signs every device out", () => {
  const old = remote.auth().token;
  remote.rotateToken();
  assert.notEqual(remote.auth().token, old);
  assert.equal(remote.tokenMatches(old), false);
  assert.equal(remote.allowed(req("10.0.0.2", { cookie: `nexus_auth=${old}` })), false);
});

test("the first look at a project is the baseline; only what is new afterwards is pushed", async () => {
  const sent: { title: string; body: string; url: string }[] = [];
  const watch = new remote.AttentionWatch(async (p) => { sent.push(p); return 1; });
  const item = (qid: string): AttentionItem => ({ kind: "question", queue: "W", step: "W3", qid, text: `Question ${qid}` });
  watch.check({ id: "p", name: "Project" }, [item("a")]);            // baseline: old news
  assert.equal(sent.length, 0);
  watch.check({ id: "p", name: "Project" }, [item("a"), item("b")]); // b is new
  assert.deepEqual(sent.map((x) => [x.title, x.body, x.url]), [["Project: Question", "W/W3 Question b", "/#/p/W/W3"]]);
  watch.check({ id: "p", name: "Project" }, [item("b")]);            // a was answered: nothing to say
  assert.equal(sent.length, 1);
  assert.equal(await remote.push({ title: "t", body: "b", url: "/" }), 0, "no subscribed device: nothing is sent");
});

test("a push subscription needs an endpoint and keys", () => {
  assert.throws(() => remote.subscribe({ endpoint: "https://push.example/x" }), /not a push subscription/);
  remote.subscribe({ endpoint: "https://push.example/x", keys: { p256dh: "k", auth: "a" } }, "Phone");
  remote.subscribe({ endpoint: "https://push.example/x", keys: { p256dh: "k2", auth: "a2" } }, "Phone");
  assert.equal(remote.pushDevices().length, 1, "subscribing again replaces, not duplicates");
  remote.unsubscribe("https://push.example/x");
  assert.equal(remote.pushDevices().length, 0);
});

test("the sign-in cookie survives opening the app from the home screen (SameSite=Lax) and lasts a year", () => {
  const c = remote.authCookie(true);
  assert.match(c, /SameSite=Lax/);
  assert.match(c, /Max-Age=31536000/);
  assert.match(c, /HttpOnly/);
  assert.match(c, /Secure/);
});
