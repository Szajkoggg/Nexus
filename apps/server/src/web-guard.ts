// The guard of a thinking partner's WebFetch (a Claude Code PreToolUse hook, run as `node web-guard.ts`): a page is
// fetched only when its host resolves to public addresses. The deny rules (webFetchDenyRules) name the local and
// internal hosts Nexus knows of; a name that merely resolves to one (`127.0.0.1.nip.io`, a LAN or tailnet name) is
// caught here, by its addresses. Probed with Claude Code 2.1.323: without it, WebFetch of such a name connected to the
// local port. Only Node's own modules: it starts for every fetch.
import { BlockList, isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { hostname, networkInterfaces } from "node:os";
import { fileURLToPath } from "node:url";

const BLOCKED = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) BLOCKED.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]] as const) BLOCKED.addSubnet(net, bits, "ipv6");

/** A loopback, private, link-local, carrier-grade NAT (Tailscale's 100.64/10), multicast or unspecified address. */
export function internalAddress(ip: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)?.[1];
  if (mapped) return internalAddress(mapped);
  const family = isIP(ip);
  if (!family) return true; // not an address: not fetched
  return BLOCKED.check(ip, family === 4 ? "ipv4" : "ipv6");
}

type Resolve = (host: string) => Promise<string[]>;
const resolveAll: Resolve = async (host) => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

/** This machine's own addresses (a public IPv6 one too), read at each check: they change. */
const ownAddresses = (): string[] => Object.values(networkInterfaces()).flat().map((i) => i?.address.replace(/%.*$/, "").toLowerCase()).filter((a): a is string => !!a);

/**
 * Why the fetch of `url` is refused, or undefined when it may go: its host must be a name or address that resolves
 * only to public addresses that are not this machine's (a name that does not resolve is refused too: nothing to fetch).
 */
export async function refusal(url: unknown, resolve: Resolve = resolveAll, own: string[] = ownAddresses()): Promise<string | undefined> {
  let host: string;
  try { host = new URL(String(url)).hostname.replace(/^\[|\]$/g, ""); } catch { return "not a URL"; }
  if (!host) return "no host";
  let addresses: string[];
  try { addresses = isIP(host) ? [host] : await resolve(host); } catch { return `${host} does not resolve`; }
  if (!addresses.length) return `${host} does not resolve`;
  const inner = addresses.find((a) => internalAddress(a) || own.includes(a.toLowerCase()));
  return inner ? `${host} is a local or internal address (${inner}): Nexus fetches public pages only` : undefined;
}

/** The hook's answer for one PreToolUse input (Claude Code's hook JSON): a deny with the reason, or nothing. */
export async function hookAnswer(input: unknown, resolve?: Resolve): Promise<string> {
  const i = (input && typeof input === "object" ? input : {}) as { tool_name?: string; tool_input?: { url?: unknown } };
  if (i.tool_name !== "WebFetch") return "";
  const why = await refusal(i.tool_input?.url, resolve);
  return why ? JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: why } }) : "";
}

if (import.meta.main) {
  let raw = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d) => { raw += d; });
  process.stdin.on("end", () => {
    let input: unknown;
    try { input = JSON.parse(raw); } catch { input = { tool_name: "WebFetch", tool_input: {} }; } // unreadable: refused
    // A resolution that hangs is refused after a while rather than holding the turn.
    const timeout = new Promise<string>((done) => setTimeout(() => done(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "the host did not resolve in time" } })), 8000).unref());
    void Promise.race([hookAnswer(input), timeout]).then((out) => { if (out) process.stdout.write(out); process.exit(0); });
  });
}

// ---------------------------------------------------------------- the partner's launch (the server's side)

/**
 * The deny rules for a partner's WebFetch: the local and internal hosts by name (Claude Code matches the URL's host;
 * `*.` covers subdomains, probed with Claude Code 2.1.323) and this machine's name. Its addresses are not named: they
 * change (a rotating IPv6 one), and a changed rule would restart the partner's process; the guard hook (guardSettings)
 * refuses them, and any other name that resolves to a local or internal address, at each fetch.
 */
export function webFetchDenyRules(machine: string = hostname()): string[] {
  const host = machine.toLowerCase();
  const hosts = [
    "localhost", "*.localhost", "127.0.0.1", "0.0.0.0", "[::1]", "*.ts.net", "*.local", "*.internal", "*.lan", "*.home.arpa",
    ...(host ? [host, `${host}.local`] : []),
  ];
  return [...new Set(hosts)].map((h) => `WebFetch(domain:${h})`);
}

/** The settings (`--settings`, as JSON) that run this file as the PreToolUse hook of every WebFetch. */
export function guardSettings(): string {
  const slash = (p: string) => p.replaceAll("\\", "/");
  const command = `"${slash(process.execPath)}" "${slash(fileURLToPath(import.meta.url))}"`;
  return JSON.stringify({ hooks: { PreToolUse: [{ matcher: "WebFetch", hooks: [{ type: "command", command, timeout: 15 }] }] } });
}
