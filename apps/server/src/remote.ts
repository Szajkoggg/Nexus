// Remote access: who may use the dashboard from another device, and push notifications to those devices.
//
// The server listens on this machine only. Remote devices reach it through a proxy on this machine (Tailscale
// Serve: https://<pc>.<tailnet>.ts.net, tailnet members only). A request is local when it comes from a loopback
// address and carries no proxy headers; anything else must present the access token (once, at /login), which sets a
// long-lived cookie. The token lives in <NEXUS_HOME>/auth.json; rotating it signs every device out.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { IncomingMessage } from "node:http";
import webpush from "web-push";
import QRCode from "qrcode";
import { nexusHome, now, type AttentionItem } from "@nexus/protocol";

const COOKIE = "nexus_auth";
const authFile = () => join(nexusHome(), "auth.json");
const pushFile = () => join(nexusHome(), "push.json");

// ---------------------------------------------------------------- the token

interface Auth { token: string; created_at: string }

export function auth(): Auth {
  if (existsSync(authFile())) {
    try { return JSON.parse(readFileSync(authFile(), "utf8")) as Auth; } catch { /* rewrite below */ }
  }
  return rotateToken();
}

export function rotateToken(): Auth {
  mkdirSync(nexusHome(), { recursive: true });
  const a = { token: randomBytes(24).toString("base64url"), created_at: now() };
  writeFileSync(authFile(), JSON.stringify(a, null, 2), "utf8");
  return a;
}

const digest = (s: string) => createHash("sha256").update(s).digest();
export function tokenMatches(given: string | undefined): boolean {
  if (!given) return false;
  return timingSafeEqual(digest(given), digest(auth().token));
}

/** A request straight from this machine, not relayed by a proxy. */
export function isLocal(req: IncomingMessage): boolean {
  const addr = req.socket.remoteAddress ?? "";
  const loopback = addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
  const h = req.headers;
  const proxied = !!(h["x-forwarded-for"] || h["x-forwarded-host"] || h["forwarded"] || h["tailscale-user-login"]);
  return loopback && !proxied;
}

export function cookieOf(req: IncomingMessage): string | undefined {
  const raw = req.headers.cookie ?? "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === COOKIE) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

export function allowed(req: IncomingMessage): boolean {
  return isLocal(req) || tokenMatches(cookieOf(req));
}

/**
 * Lax, not Strict: an installed app opened from the home screen, or a link opened from another app, is a navigation
 * from outside, and a Strict cookie would not be sent with it (the user would have to sign in at every launch).
 * Writes stay protected: the API takes JSON only and refuses a foreign Origin.
 */
export function authCookie(secure: boolean): string {
  return `${COOKIE}=${encodeURIComponent(auth().token)}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

export function loginPage(error?: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Nexus · sign in</title><meta name="color-scheme" content="dark">
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#09090b;color:#e4e4e7;font:15px system-ui,"Segoe UI",sans-serif}
  form{width:min(360px,calc(100vw - 32px));display:grid;gap:12px}
  h1{font-size:20px;margin:0 0 4px}
  p{margin:0;color:#a1a1aa;font-size:13px;line-height:1.5}
  input{padding:10px 12px;border-radius:8px;border:1px solid #3f3f46;background:#18181b;color:#fafafa;font:inherit}
  button{padding:10px;border:0;border-radius:8px;background:#0284c7;color:#fff;font:inherit;font-weight:600}
  .err{color:#f87171}
</style></head><body><form method="post" action="/login">
<h1>Nexus</h1>
<p>Enter the access token. On the PC, the dashboard's "Remote access" panel shows it, with a QR code that signs you in directly.</p>
${error ? `<p class="err">${error}</p>` : ""}
<input name="token" type="password" autocomplete="current-password" placeholder="Access token" autofocus required>
<button type="submit">Sign in</button>
</form></body></html>`;
}

// ---------------------------------------------------------------- Tailscale

export interface RemoteInfo { tailscale: boolean; url?: string; detail?: string }

/** The address remote devices use, if Tailscale is installed and up on this machine. */
export function tailscaleInfo(): Promise<RemoteInfo> {
  return new Promise((resolve) => {
    const bins = ["tailscale", "C:\\Program Files\\Tailscale\\tailscale.exe"];
    const tryBin = (i: number) => {
      if (i >= bins.length) return resolve({ tailscale: false, detail: "Tailscale is not installed on this PC" });
      execFile(bins[i]!, ["status", "--json"], { timeout: 5000, windowsHide: true }, (err, stdout) => {
        if (err) return tryBin(i + 1);
        try {
          const s = JSON.parse(stdout) as { BackendState?: string; Self?: { DNSName?: string } };
          const dns = s.Self?.DNSName?.replace(/\.$/, "");
          if (s.BackendState !== "Running" || !dns) return resolve({ tailscale: true, detail: `Tailscale is ${s.BackendState ?? "not running"}` });
          resolve({ tailscale: true, url: `https://${dns}` });
        } catch { resolve({ tailscale: true, detail: "could not read the Tailscale status" }); }
      });
    };
    tryBin(0);
  });
}

export async function qrSvg(text: string): Promise<string> {
  return QRCode.toString(text, { type: "svg", margin: 1, color: { dark: "#e4e4e7", light: "#00000000" } });
}

// ---------------------------------------------------------------- push notifications

interface Subscription { endpoint: string; keys: { p256dh: string; auth: string }; label?: string; added_at: string }
interface PushFile { vapid: { publicKey: string; privateKey: string }; subscriptions: Subscription[] }

function pushStore(): PushFile {
  if (existsSync(pushFile())) {
    try { return JSON.parse(readFileSync(pushFile(), "utf8")) as PushFile; } catch { /* rewrite below */ }
  }
  const p: PushFile = { vapid: webpush.generateVAPIDKeys(), subscriptions: [] };
  savePush(p);
  return p;
}
function savePush(p: PushFile): void {
  mkdirSync(nexusHome(), { recursive: true });
  writeFileSync(pushFile(), JSON.stringify(p, null, 2), "utf8");
}

export const pushKey = () => pushStore().vapid.publicKey;
export const pushDevices = () => pushStore().subscriptions.map((s) => ({ endpoint: s.endpoint, label: s.label, added_at: s.added_at }));

export function subscribe(sub: unknown, label?: unknown): void {
  const s = sub as Partial<Subscription>;
  if (!s?.endpoint || !s.keys?.p256dh || !s.keys?.auth) throw new Error("not a push subscription");
  const p = pushStore();
  p.subscriptions = p.subscriptions.filter((x) => x.endpoint !== s.endpoint);
  p.subscriptions.push({ endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth }, label: typeof label === "string" ? label.slice(0, 80) : undefined, added_at: now() });
  savePush(p);
}

export function unsubscribe(endpoint: unknown): void {
  const p = pushStore();
  p.subscriptions = p.subscriptions.filter((x) => x.endpoint !== endpoint);
  savePush(p);
}

/** Sends to every subscribed device (or only to `endpoint`); drops subscriptions the push service says are gone. */
export async function push(payload: { title: string; body: string; url: string; tag?: string }, endpoint?: string): Promise<number> {
  const p = pushStore();
  const targets = endpoint ? p.subscriptions.filter((s) => s.endpoint === endpoint) : p.subscriptions;
  if (!targets.length) return 0;
  webpush.setVapidDetails(process.env.NEXUS_VAPID_SUBJECT ?? "mailto:nexus@example.com", p.vapid.publicKey, p.vapid.privateKey);
  const gone: string[] = [];
  let sent = 0;
  await Promise.all(targets.map(async (s) => {
    try { await webpush.sendNotification(s, JSON.stringify(payload), { TTL: 3600, urgency: "high" }); sent++; }
    catch (err) {
      const code = (err as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) gone.push(s.endpoint);
      else console.error(`push to ${new URL(s.endpoint).host}: ${(err as Error).message}`);
    }
  }));
  if (gone.length) { const q = pushStore(); q.subscriptions = q.subscriptions.filter((x) => !gone.includes(x.endpoint)); savePush(q); }
  return sent;
}

const LABEL: Record<AttentionItem["kind"], string> = {
  question: "Question", stopped: "Stopped", approval: "Needs approval", review: "Review", failed: "Failed", start: "Did not start",
  provisional: "To confirm",
};
// A stopped queue is one item whatever happens to its step (a skip by the orchestrator is no news for the user).
const key = (a: AttentionItem) => [a.kind, a.queue, a.lift ? undefined : a.step, a.qid].join("/");

/**
 * Pushes what newly appears in a project's "waiting for you" list. The first look at a project is the baseline,
 * so a restart does not repeat old news.
 */
export class AttentionWatch {
  private seen = new Map<string, Set<string>>();
  private readonly send: typeof push;
  constructor(send: typeof push = push) { this.send = send; }
  check(project: { id: string; name: string }, items: AttentionItem[]): void {
    const keys = new Set(items.map(key));
    const before = this.seen.get(project.id);
    this.seen.set(project.id, keys);
    if (!before) return;
    for (const a of items) {
      if (before.has(key(a))) continue;
      const where = [a.queue, a.step].filter(Boolean).join("/");
      void this.send({
        title: `${project.name}: ${LABEL[a.kind]}`,
        body: `${where ? where + " " : ""}${a.text.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\*\*|`/g, "")}`.slice(0, 180),
        // A stopped queue's notification opens the queue, whose stop box has Continue.
        url: `/#/${[project.id, a.queue, a.lift ? undefined : a.step].filter(Boolean).map((x) => encodeURIComponent(x!)).join("/")}`,
        tag: `${project.id}:${key(a)}`,
      });
    }
  }
}
