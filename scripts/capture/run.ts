// The capture tool's moving parts: the views run through a Browser (scripts/capture/edge.ts, or a fake in the tests),
// and a development instance started with a cleared environment on a free port (never 4317).
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { join } from "node:path";
import { instanceEnv, shotFile, type Action, type Shot, type View } from "./views.ts";

/** What the capture needs of a browser. Each returns false (or throws) when it could not do it. */
export interface Browser {
  /** Opens the URL in a window of that size (a narrower one than the browser allows: in a frame of that size). */
  open(url: string, width: number, height: number): Promise<void>;
  click(target: string | { selector: string }): Promise<boolean>;
  type(text: string, into?: string): Promise<boolean>;
  press(key: string): Promise<boolean>;
  /** Saves a picture of the window (only the window: a fixed-viewport capture). */
  shot(file: string): Promise<void>;
}

const describe = (a: Action): string => {
  if ("click" in a) return typeof a.click === "string" ? `click "${a.click}"` : `click ${a.click.selector}`;
  if ("type" in a) return `type into ${a.type.into ?? "the focused element"}`;
  if ("press" in a) return `press ${a.press}`;
  return `wait ${a.wait} ms`;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Takes each view's picture into `out` (<key>.png, the before <key>.before.png). A view that fails (an action that
 * finds nothing, a page that does not open) is reported with why, and the others go on: the tool never blocks.
 */
export async function captureViews(views: View[], browser: Browser, o: { base: string; out: string; side: "before" | "after"; log?: (s: string) => void }): Promise<Shot[]> {
  const shots: Shot[] = [];
  for (const v of views) {
    try {
      await browser.open(o.base + "/" + v.route, v.width, v.height!);
      await sleep(v.settle ?? 1500);
      for (const [i, a] of v.actions.entries()) {
        let done = true;
        if ("click" in a) done = await browser.click(a.click);
        else if ("type" in a) done = await browser.type(a.type.text, a.type.into);
        else if ("press" in a) done = await browser.press(a.press);
        else await sleep(a.wait);
        if (!done) throw new Error(`action ${i + 1} (${describe(a)}) found nothing to act on`);
        await sleep(400);
      }
      const file = join(o.out, shotFile(v.key, o.side)).replaceAll("\\", "/");
      await browser.shot(file);
      shots.push({ key: v.key, side: o.side, file });
      o.log?.(`taken: ${v.key} ${o.side}`);
    } catch (e) {
      shots.push({ key: v.key, side: o.side, error: (e as Error).message });
      o.log?.(`not taken: ${v.key} ${o.side}: ${(e as Error).message}`);
    }
  }
  return shots;
}

/** A free port on 127.0.0.1 from `from` up, never 4317. */
export async function freePort(from = 4318): Promise<number> {
  for (let p = Math.max(from, 4318); p < from + 200; p++) {
    const free = await new Promise<boolean>((res) => {
      const s = createServer().once("error", () => res(false)).once("listening", () => s.close(() => res(true)));
      s.listen(p, "127.0.0.1");
    });
    if (free) return p;
  }
  throw new Error(`no free port from ${from}`);
}

export interface Instance { url: string; port: number; pid: number; stop(): Promise<void>; output(): string }

/**
 * Starts the server of the checkout at `root` (its apps/server/src/main.ts) as a development instance: its own
 * NEXUS_HOME and port, the checkout's fake runtimes, and none of NEXUS_DIR, NEXUS_HANDOVER, NEXUS_SESSION. Resolves
 * once it answers, or rejects with its output.
 */
export async function startInstance(o: { root: string; home: string; port: number; parentEnv?: NodeJS.ProcessEnv }): Promise<Instance> {
  const fakes = { claude: join(o.root, "apps/server/test/fake-claude.ts"), codex: join(o.root, "apps/server/test/fake-codex.ts") };
  const env = instanceEnv(o.parentEnv ?? process.env, { home: o.home, port: o.port, fakes });
  const child: ChildProcess = spawn(process.execPath, [join(o.root, "apps/server/src/main.ts")], { cwd: o.root, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let out = "";
  child.stdout!.on("data", (d) => { out += d; });
  child.stderr!.on("data", (d) => { out += d; });
  let exited = false;
  child.on("exit", () => { exited = true; });
  const url = `http://127.0.0.1:${o.port}`;
  const stop = async () => {
    if (exited) return;
    const gone = new Promise((r) => child.once("exit", r));
    child.kill();
    await Promise.race([gone, sleep(5000)]);
  };
  const t = Date.now();
  while (Date.now() - t < 30_000) {
    if (exited) throw new Error(`the development instance exited: ${out.trim().slice(-800)}`);
    try { if ((await fetch(`${url}/api/projects`)).ok) return { url, port: o.port, pid: child.pid!, stop, output: () => out }; } catch { /* not yet */ }
    await sleep(250);
  }
  await stop();
  throw new Error(`the development instance did not answer within 30 s: ${out.trim().slice(-800)}`);
}
