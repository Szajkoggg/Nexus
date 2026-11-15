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
  assert.equal(await remote.push({ title: "t", body: "b", url: "/" }, { kind: "question" }), 0, "no subscribed device: nothing is sent");
});

test("each device gets what its own settings let through: two devices, the same news, one notification", async () => {
  const phone = "https://push.example/phone", desk = "https://push.example/desk";
  remote.subscribe({ endpoint: phone, keys: { p256dh: "k", auth: "a" } }, "Phone", "Europe/Budapest");
  remote.subscribe({ endpoint: desk, keys: { p256dh: "k", auth: "a" } }, "Desktop");
  assert.deepEqual(remote.deviceNotify(desk), { off: [], quiet: { on: false, from: "22:00", to: "07:00" }, urgent: false }, "a device without settings: all of them");
  assert.equal(remote.deviceNotify(phone)!.timezone, "Europe/Budapest", "the zone it subscribed with");
  // The phone keeps quiet at night in its own zone, and wants no reviews at all.
  remote.setDeviceNotify(phone, { off: ["review"], quiet: { on: true, from: "22:00", to: "07:00" }, urgent: true, timezone: "Europe/Budapest" });
  assert.throws(() => remote.setDeviceNotify(phone, { quiet: { from: "late" } }), /quiet\.from/);
  assert.throws(() => remote.setDeviceNotify("https://push.example/none", {}), remote.NotSubscribed);
  remote.subscribe({ endpoint: phone, keys: { p256dh: "k3", auth: "a3" } }, "Phone");
  assert.deepEqual(remote.deviceNotify(phone)!.off, ["review"], "subscribing again keeps the settings");

  const reached: string[] = [];
  const send = async (s: { endpoint: string }) => { reached.push(s.endpoint); };
  const night = new Date("2026-11-15T22:30:00Z"); // 23:30 in Budapest
  const day = new Date("2026-11-15T10:00:00Z");
  const through = (kind: Parameters<typeof remote.push>[1]["kind"], at: Date) => { reached.length = 0; return remote.push({ title: "t", body: "b", url: "/" }, { kind, at, send }).then((n) => [n, [...reached].sort()]); };
  // The same new question, seen through the watch: only the desktop at night.
  const watch = new remote.AttentionWatch((p, o) => remote.push(p, { ...o, at: night, send }));
  const q = (qid: string): AttentionItem => ({ kind: "question", queue: "W", step: "W3", qid, text: "Which?" });
  watch.check({ id: "p", name: "Project" }, []);
  watch.check({ id: "p", name: "Project" }, [q("x")]);
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(reached, [desk]);
  assert.deepEqual(await through("question", day), [2, [desk, phone].sort()], "by day both");
  assert.deepEqual(await through("review", day), [1, [desk]], "reviews are off on the phone");
  assert.deepEqual(await through("stopped", night), [2, [desk, phone].sort()], "urgent breaks through the quiet hours");
  assert.deepEqual(await through("test", night), [2, [desk, phone].sort()], "the test always goes");
  remote.unsubscribe(phone);
  remote.unsubscribe(desk);
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
