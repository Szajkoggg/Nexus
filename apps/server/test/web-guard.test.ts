// The guard of a thinking partner's WebFetch (queue WB): which addresses it refuses, its answer as a Claude Code
// PreToolUse hook, and the deny rules by name. No test resolves a name over the network: names go to a stand-in.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hookAnswer, internalAddress, refusal, webFetchDenyRules } from "../src/web-guard.ts";

const here = dirname(fileURLToPath(import.meta.url));

test("local, private, link-local, Tailscale and unspecified addresses are internal; public ones are not", () => {
  for (const ip of ["127.0.0.1", "127.8.9.10", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.5", "169.254.10.1", "100.64.0.1", "100.101.102.103",
    "0.0.0.0", "::1", "::", "fe80::1", "fd7a:115c:a1e0::1", "::ffff:127.0.0.1", "not an address"]) {
    assert.equal(internalAddress(ip), true, ip);
  }
  for (const ip of ["93.184.215.14", "8.8.8.8", "172.32.0.1", "100.128.0.1", "2606:4700::1111", "::ffff:8.8.8.8"]) assert.equal(internalAddress(ip), false, ip);
});

test("a URL is refused when its host resolves to an internal address, by name or literally; public hosts may be fetched", async () => {
  const dns: Record<string, string[]> = { "127.0.0.1.nip.io": ["127.0.0.1"], "example.com": ["93.184.215.14", "2606:2800:21f:cb07:6820:80da:af6b:8b2c"], "mixed.test": ["93.184.215.14", "192.168.0.2"], "gabipc": ["fe80::668:765a:b877:4974"] };
  const resolve = async (h: string) => { if (!dns[h]) throw new Error("ENOTFOUND"); return dns[h]!; };
  assert.match((await refusal("http://127.0.0.1.nip.io:4317/api/state", resolve))!, /127\.0\.0\.1\.nip\.io is a local or internal address \(127\.0\.0\.1\)/);
  assert.match((await refusal("http://[::1]:4317/", resolve))!, /::1/);
  assert.match((await refusal("http://127.0.0.1:4317/", resolve))!, /internal/);
  assert.match((await refusal("https://mixed.test/", resolve))!, /192\.168\.0\.2/, "one internal address is enough");
  assert.match((await refusal("http://gabipc:4317/", resolve))!, /internal/, "a LAN name");
  assert.match((await refusal("https://nowhere.test/", resolve))!, /does not resolve/);
  assert.equal(await refusal("not a url", resolve), "not a URL");
  assert.equal(await refusal("https://example.com/page", resolve), undefined);
});

test("the hook answers a WebFetch to an internal host with a deny, and anything else with nothing", async () => {
  const resolve = async () => ["93.184.215.14"];
  const deny = JSON.parse(await hookAnswer({ tool_name: "WebFetch", tool_input: { url: "http://10.0.0.7/" } }, resolve));
  assert.equal(deny.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(deny.hookSpecificOutput.permissionDecision, "deny");
  assert.match(deny.hookSpecificOutput.permissionDecisionReason, /10\.0\.0\.7/);
  assert.equal(await hookAnswer({ tool_name: "WebFetch", tool_input: { url: "https://example.com/" } }, resolve), "");
  assert.equal(await hookAnswer({ tool_name: "Read", tool_input: { file_path: "x" } }, resolve), "", "other tools are not its business");
});

test("run as a hook (node web-guard.ts, the input on stdin), it writes the deny for an internal address or unreadable input, and nothing for a public address", () => {
  const run = (input: string) => execFileSync(process.execPath, [join(here, "..", "src", "web-guard.ts")], { input, encoding: "utf8" });
  const out = JSON.parse(run(JSON.stringify({ tool_name: "WebFetch", tool_input: { url: "http://127.0.0.1:4317/api/projects" } })));
  assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
  assert.equal(JSON.parse(run("{not json")).hookSpecificOutput.permissionDecision, "deny", "unreadable input is refused");
  assert.equal(run(JSON.stringify({ tool_name: "WebFetch", tool_input: { url: "http://93.184.215.14/" } })), "", "a public address literal goes");
});

test("the deny rules name the local and internal hosts and this machine's name, not its changing addresses", () => {
  const rules = webFetchDenyRules("GabiPC");
  for (const h of ["localhost", "*.localhost", "127.0.0.1", "0.0.0.0", "[::1]", "*.ts.net", "*.local", "*.internal", "*.lan", "*.home.arpa", "gabipc", "gabipc.local"]) {
    assert.ok(rules.includes(`WebFetch(domain:${h})`), h);
  }
  assert.equal(new Set(rules).size, rules.length, "each once");
  assert.deepEqual(webFetchDenyRules("GabiPC"), rules, "the same rules at every launch: no restart for a changed address");
});

test("this machine's own public address is refused too, as the hook reads it at each fetch", async () => {
  const own = ["2a02:ab88::19db", "192.168.0.142"];
  assert.match((await refusal("http://[2a02:ab88::19db]:4317/", async () => [], own))!, /2a02:ab88::19db/);
  assert.match((await refusal("http://mine.example/", async () => ["2A02:AB88::19DB"], own))!, /internal/);
  assert.equal(await refusal("http://[2a02:ab88::1]/", async () => [], own), undefined, "another public address goes");
});
