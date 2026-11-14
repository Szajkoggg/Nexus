// A Browser (run.ts) on headless Edge (or Chrome) over the DevTools protocol. Edge's narrowest window is 492 px: a
// view narrower than that is shown in a frame of its size on a small page this module serves over http (a file://
// parent page loses the dashboard's /api calls), and the picture is clipped to the frame.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { dirname, join } from "node:path";
import type { Browser } from "./run.ts";
import { freePort } from "./run.ts";

const CANDIDATES = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
];
const NARROWEST = 492;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The browser to drive: NEXUS_CAPTURE_BROWSER, else Edge or Chrome where they are usually installed. */
export function browserPath(): string | undefined {
  const own = process.env.NEXUS_CAPTURE_BROWSER;
  if (own) return existsSync(own) ? own : undefined;
  return CANDIDATES.find((p) => existsSync(p));
}

export class EdgeBrowser implements Browser {
  private proc!: ChildProcess;
  private ws!: WebSocket;
  private parent!: Server;
  private parentPort = 0;
  private n = 0;
  private readonly pending = new Map<number, (m: { result?: unknown; error?: { message: string } }) => void>();
  private framed = false;
  private frame = { width: 0, height: 0 };
  readonly pids: number[] = [];

  static async launch(profile: string): Promise<EdgeBrowser> {
    const exe = browserPath();
    if (!exe) throw new Error("no Edge or Chrome found (set NEXUS_CAPTURE_BROWSER to its path)");
    const b = new EdgeBrowser();
    const port = await freePort(9400);
    b.proc = spawn(exe, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--hide-scrollbars", "--mute-audio", "about:blank"], { stdio: "ignore", windowsHide: true });
    b.pids.push(b.proc.pid!);
    let targets: { type: string; webSocketDebuggerUrl: string }[] = [];
    for (let i = 0; i < 100 && !targets.some((t) => t.type === "page"); i++) {
      try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json() as typeof targets; } catch { /* starting */ }
      if (!targets.some((t) => t.type === "page")) await sleep(150);
    }
    const page = targets.find((t) => t.type === "page");
    if (!page) { b.proc.kill(); throw new Error("the browser did not start"); }
    b.ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((r, j) => { b.ws.addEventListener("open", r); b.ws.addEventListener("error", j); });
    b.ws.addEventListener("message", (e) => {
      const m = JSON.parse(String(e.data)) as { id?: number; result?: unknown; error?: { message: string } };
      if (m.id && b.pending.has(m.id)) { b.pending.get(m.id)!(m); b.pending.delete(m.id); }
    });
    await b.cdp("Page.enable");
    b.parentPort = await freePort(4380);
    b.parent = createServer((req, res) => {
      const u = new URL(req.url ?? "/", "http://x");
      const src = u.searchParams.get("src") ?? "", w = Number(u.searchParams.get("w")), h = Number(u.searchParams.get("h"));
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html><html><body style="margin:0;background:#000"><iframe src="${src.replaceAll('"', "&quot;")}" style="width:${w}px;height:${h}px;border:0;display:block"></iframe></body></html>`);
    });
    await new Promise<void>((r) => b.parent.listen(b.parentPort, "127.0.0.1", r));
    return b;
  }

  private cdp<T = unknown>(method: string, params: Record<string, unknown> = {}, ms = 15_000): Promise<T> {
    return new Promise((res, rej) => {
      const id = ++this.n;
      const timer = setTimeout(() => { this.pending.delete(id); rej(new Error(`${method}: no answer within ${ms / 1000} s`)); }, ms);
      this.pending.set(id, (m) => { clearTimeout(timer); if (m.error) rej(new Error(`${method}: ${m.error.message}`)); else res(m.result as T); });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Evaluates in the dashboard: the page, or the frame's document when the view is framed. */
  private async js<T>(expr: string): Promise<T> {
    let contextId: number | undefined;
    if (this.framed) {
      const tree = await this.cdp<{ frameTree: { childFrames?: { frame: { id: string } }[] } }>("Page.getFrameTree");
      const frame = tree.frameTree.childFrames?.[0]?.frame;
      if (!frame) throw new Error("the dashboard's frame is not there");
      contextId = (await this.cdp<{ executionContextId: number }>("Page.createIsolatedWorld", { frameId: frame.id, worldName: "capture" })).executionContextId;
    }
    const r = await this.cdp<{ result: { value: T }; exceptionDetails?: { exception?: { description?: string } } }>("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true, ...(contextId ? { contextId } : {}) });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "a script in the page failed");
    return r.result.value;
  }

  async open(url: string, width: number, height: number): Promise<void> {
    this.framed = width < NARROWEST;
    this.frame = { width, height };
    await this.cdp("Emulation.setDeviceMetricsOverride", { width: Math.max(width, NARROWEST), height, deviceScaleFactor: 1, mobile: false });
    const target = this.framed ? `http://127.0.0.1:${this.parentPort}/?w=${width}&h=${height}&src=${encodeURIComponent(url)}` : url;
    // A new document each time, also when only the hash differs from the last view's.
    await this.cdp("Page.navigate", { url: "about:blank" });
    const r = await this.cdp<{ errorText?: string }>("Page.navigate", { url: target });
    if (r.errorText) throw new Error(`the page did not open: ${r.errorText}`);
    for (let i = 0; i < 50; i++) {
      try { if (await this.js<boolean>(`document.readyState === "complete" && !!document.body && document.body.innerText.length > 0`)) return; } catch { /* the frame is not there yet */ }
      await sleep(100);
    }
    throw new Error("the page did not load within 5 s");
  }

  click(target: string | { selector: string }): Promise<boolean> {
    const find = typeof target === "string"
      ? `[...document.querySelectorAll("button, a, [role=button], [role=tab], summary")].find((b) => b.innerText.trim() === ${JSON.stringify(target)}) ?? [...document.querySelectorAll("button, a, [role=button], [role=tab], summary")].find((b) => b.innerText.trim().startsWith(${JSON.stringify(target)}))`
      : `document.querySelector(${JSON.stringify(target.selector)})`;
    return this.js<boolean>(`(() => { const el = ${find}; if (!el) return false; el.scrollIntoView({ block: "nearest" }); el.click(); return true; })()`);
  }

  type(text: string, into?: string): Promise<boolean> {
    return this.js<boolean>(`(() => {
      const el = ${into ? `document.querySelector(${JSON.stringify(into)})` : "document.activeElement"};
      if (!el || !("value" in el)) return false;
      el.focus();
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")?.set;
      setter ? setter.call(el, ${JSON.stringify(text)}) : (el.value = ${JSON.stringify(text)});
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`);
  }

  press(key: string): Promise<boolean> {
    return this.js<boolean>(`(() => {
      const el = document.activeElement ?? document.body;
      for (const type of ["keydown", "keyup"]) el.dispatchEvent(new KeyboardEvent(type, { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true }));
      return true;
    })()`);
  }

  async shot(file: string): Promise<void> {
    const r = await this.cdp<{ data: string }>("Page.captureScreenshot", { format: "png", ...(this.framed ? { clip: { x: 0, y: 0, width: this.frame.width, height: this.frame.height, scale: 1 } } : {}) });
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, Buffer.from(r.data, "base64"));
  }

  async close(): Promise<void> {
    // Closed through the protocol first, so the browser takes its helper processes with it.
    try { await this.cdp("Browser.close", {}, 3000); } catch { /* gone already */ }
    try { this.ws?.close(); } catch { /* closed */ }
    this.parent?.close();
    if (this.proc && this.proc.exitCode === null) {
      const gone = new Promise((r) => this.proc.once("exit", r));
      this.proc.kill();
      await Promise.race([gone, sleep(5000)]);
    }
  }
}

export const profileDir = (tmp: string, side: string) => join(tmp, `browser-${side}`);
