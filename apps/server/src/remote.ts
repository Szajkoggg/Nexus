// Remote access: who may use the dashboard from another device, and push notifications to those devices.
//
// The server listens on this machine only. Remote devices reach it through a proxy on this machine (Tailscale
// Serve: https://<pc>.<tailnet>.ts.net, tailnet members only). A request is local when it comes from a loopback
// address and carries no proxy headers; anything else must present the access token (once, at /login), which sets a
// long-lived cookie. The token lives in <NEXUS_HOME>/auth.json; rotating it signs every device out.
import { errorText } from "@nexus/protocol/errors";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { IncomingMessage } from "node:http";
import webpush from "web-push";
import QRCode from "qrcode";
import { attentionKey, knownTimeZone, nexusHome, normPath, notifySettingsOf, now, parseNotifySettings, renameRetrying, shouldNotify, writeJson, type AttentionItem, type NotificationKind, type NotifyKind, type NotifySettings } from "@nexus/protocol";

const COOKIE = "nexus_auth";
const authFile = () => join(nexusHome(), "auth.json");
const pushFile = () => join(nexusHome(), "push.json");

// ---------------------------------------------------------------- the token

interface Auth { token: string; created_at: string }

/**
 * The access token, made the first time. An auth.json that is there but cannot be read is not replaced silently: it is
 * set aside as auth.json.corrupt, with a warning, and a new token is made (every device signs in again).
 */
export function auth(): Auth {
  const f = authFile();
  if (existsSync(f)) {
    try {
      const a = JSON.parse(readFileSync(f, "utf8")) as Partial<Auth> | null;
      if (typeof a?.token === "string" && a.token) return a as Auth;
      throw new Error("it holds no token");
    } catch (e) {
      renameRetrying(f, `${f}.corrupt`);
      console.warn(`nexus: ${normPath(f)} cannot be read (${errorText(e)}); set aside as auth.json.corrupt, and a new access token made: every device signs in again`);
    }
  }
  return rotateToken();
}

export function rotateToken(): Auth {
  const a = { token: randomBytes(24).toString("base64url"), created_at: now() };
  writeJson(authFile(), a);
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

function cookieOf(req: IncomingMessage): string | undefined {
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

interface Subscription {
  endpoint: string; keys: { p256dh: string; auth: string }; label?: string; added_at: string;
  /** Which notifications this device gets (@nexus/protocol notify.ts); absent (a subscription from before them): all, at any time. */
  notify?: NotifySettings;
}
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
  writeJson(pushFile(), p);
}

export const pushKey = () => pushStore().vapid.publicKey;
export const pushDevices = () => pushStore().subscriptions.map((s) => ({ endpoint: s.endpoint, label: s.label, added_at: s.added_at }));

/**
 * Subscribes a device. The same endpoint again (the browser renewed it, or it was turned on again) keeps its
 * notification settings. `timezone`: the device's IANA zone, for its quiet hours; one not known here is left out.
 */
export function subscribe(sub: unknown, label?: unknown, timezone?: unknown): void {
  const s = sub as Partial<Subscription>;
  if (!s?.endpoint || !s.keys?.p256dh || !s.keys?.auth) throw new Error("not a push subscription");
  const p = pushStore();
  const before = p.subscriptions.find((x) => x.endpoint === s.endpoint);
  p.subscriptions = p.subscriptions.filter((x) => x.endpoint !== s.endpoint);
  const zone = typeof timezone === "string" && knownTimeZone(timezone) ? timezone : undefined;
  const notify = zone ? { ...notifySettingsOf(before?.notify), timezone: zone } : before?.notify;
  p.subscriptions.push({
    endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth }, label: typeof label === "string" ? label.slice(0, 80) : undefined, added_at: now(),
    ...(notify ? { notify } : {}),
  });
  savePush(p);
}

/** A device's notification settings (the defaults for one that has none), or undefined for an endpoint not subscribed. */
export function deviceNotify(endpoint: unknown): NotifySettings | undefined {
  const s = pushStore().subscriptions.find((x) => x.endpoint === endpoint);
  return s && notifySettingsOf(s.notify);
}

/** Sets a device's notification settings; throws with what is wrong, or when the endpoint is not subscribed. */
export function setDeviceNotify(endpoint: unknown, settings: unknown): NotifySettings {
  const parsed = parseNotifySettings(settings);
  if ("error" in parsed) throw new Error(parsed.error);
  const p = pushStore();
  const s = p.subscriptions.find((x) => x.endpoint === endpoint);
  if (!s) throw new NotSubscribed();
  s.notify = parsed.settings;
  savePush(p);
  return parsed.settings;
}

export class NotSubscribed extends Error { constructor() { super("this device is not subscribed to push notifications"); } }

export function unsubscribe(endpoint: unknown): void {
  const p = pushStore();
  p.subscriptions = p.subscriptions.filter((x) => x.endpoint !== endpoint);
  savePush(p);
}

/** What a push carries to the device's service worker (public/sw.js). */
export interface PushPayload { title: string; body: string; url: string; tag?: string }
/** Hands one notification to the push service (web-push; a fake in the tests). */
type Sender = (s: Subscription, body: string) => Promise<unknown>;
const webPushSender: Sender = (s, body) => webpush.sendNotification(s, body, { TTL: 3600, urgency: "high" });

/**
 * Sends a notification of a kind to every subscribed device whose settings let it through now (or only to
 * `endpoint`); drops subscriptions the push service says are gone. Resolves with how many devices it reached.
 */
export async function push(payload: PushPayload, o: { kind: NotificationKind; endpoint?: string; at?: Date; send?: Sender }): Promise<number> {
  const p = pushStore();
  const at = o.at ?? new Date();
  const targets = p.subscriptions
    .filter((s) => !o.endpoint || s.endpoint === o.endpoint)
    .filter((s) => shouldNotify(o.kind, at, notifySettingsOf(s.notify)));
  if (!targets.length) return 0;
  const send = o.send ?? webPushSender;
  if (!o.send) webpush.setVapidDetails(process.env.NEXUS_VAPID_SUBJECT ?? "mailto:nexus@example.com", p.vapid.publicKey, p.vapid.privateKey);
  const gone: string[] = [];
  let sent = 0;
  await Promise.all(targets.map(async (s) => {
    try { await send(s, JSON.stringify(payload)); sent++; }
    catch (err) {
      const code = (err as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) gone.push(s.endpoint);
      else console.error(`push to ${new URL(s.endpoint).host}: ${errorText(err)}`);
    }
  }));
  if (gone.length) { const q = pushStore(); q.subscriptions = q.subscriptions.filter((x) => !gone.includes(x.endpoint)); savePush(q); }
  return sent;
}

/** Sends a notification of a waiting item's kind (`push`; a fake in the tests). */
type Notifier = (payload: PushPayload, o: { kind: NotifyKind }) => Promise<number>;

const LABEL: Record<AttentionItem["kind"], string> = {
  question: "Question", stopped: "Stopped", approval: "Needs approval", review: "Review", failed: "Failed", start: "Did not start",
  provisional: "To confirm", plan: "The plan", merge: "Merging back", tags: "Tags", recurring: "Recurring", cleanup: "Cleanup",
};

/**
 * Pushes what newly appears in a project's "waiting for you" list. The first look at a project is the baseline,
 * so a restart does not repeat old news.
 */
export class AttentionWatch {
  private seen = new Map<string, Set<string>>();
  private readonly send: Notifier;
  constructor(send: Notifier = push) { this.send = send; }
  /** A project removed from Nexus: added again, its first look is a baseline again (nothing old is pushed). */
  forget(id: string): void { this.seen.delete(id); }
  check(project: { id: string; name: string }, items: AttentionItem[]): void {
    const keyed = items.map((a) => [attentionKey(a), a] as const);
    const before = this.seen.get(project.id);
    this.seen.set(project.id, new Set(keyed.map(([key]) => key)));
    if (!before) return;
    for (const [key, a] of keyed) {
      if (before.has(key)) continue;
      const where = [a.queue, a.step].filter(Boolean).join("/");
      void this.send({
        title: `${project.name}: ${LABEL[a.kind]}`,
        body: `${where ? where + " " : ""}${a.text.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\*\*|`/g, "")}`.slice(0, 180),
        // A stopped queue's notification opens the queue, whose stop box has Continue.
        url: `/#/${[project.id, a.queue, a.lift ? undefined : a.step, !a.lift && a.queue && a.step ? a.qid : undefined].filter(Boolean).map((x) => encodeURIComponent(x!)).join("/")}`,
        tag: `${project.id}:${key}`,
      }, { kind: a.kind satisfies NotifyKind });
    }
  }
}
